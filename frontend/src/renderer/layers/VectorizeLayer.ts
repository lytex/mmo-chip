import type { DieMetadata, MLTracePolyline, VectorizeParams } from "shared";
import { rectsIntersect, type Point, type Rect } from "../../lib/geometry";
import { polylineEntersRect, traceRegionBox, type TraceRegionLike } from "../../components/dieViewer/userNetFilter";
import { fetchVectorBlocks, fetchVectorLayerBlocks, vectorizeRegion } from "../../api/ml";
import type { Layer, RenderFrame, TileBounds } from "../types";

/**
 * Classical (no-model) metal vectorization overlay. Unlike `MLViasLayer`
 * (tile-block fetches of server-cached predictions), vectorize runs live on
 * the *viewport*: `beginFrame` sees the full visible world rect and schedules
 * ONE debounced region request per (viewport, params) change — scheduling in
 * `draw` doesn't work, because draw only sees per-tile rects (and canvas
 * tiles outside the die produce degenerate bboxes). The backend keeps its
 * own small LRU, and this layer keeps recently decoded regions so panning
 * back is instant.
 *
 * Drawing: amber mask outlines (what the threshold captured — the tuning
 * feedback) + solid centreline traces whose endpoints snap to device
 * contacts / terminals / pins exactly like ML traces. Materialization feeds
 * `collectTraces()` into the same traces→nets path the ML overlay uses.
 */

// Amber — reads as "classical CV, not the model" next to the ML cyan.
const VECT_TRACE_STROKE = "rgba(253, 224, 71, 0.95)";
const VECT_TRACE_SNAP_STROKE = "rgba(253, 224, 71, 0.7)";

const FETCH_DEBOUNCE_MS = 300;
/** Below the backend's 6 Mpx cap (it rejects bigger). Beyond this the view
 *  is so zoomed out that live decoding would pin the sidecar anyway. */
const MAX_AREA_PX = 5_000_000;
/** Recently decoded regions kept for instant redraw on pan-back. */
const MAX_REGIONS = 32;

export interface VectorizeDisplay {
  /** True → don't paint and don't fetch. */
  getHidden?: () => boolean;
  /** Live vectorize params (preferences). Absent ⇒ layer idle. */
  getParams?: () => VectorizeParams;
  /** Visible overlay image to vectorize instead of the base image. */
  getOverlaySource?: () => string | undefined;
  /** Trace-endpoint snap targets (same closure the ML layer gets). */
  findSnapTarget?: (world: Point, tolWorld: number) => { x: number; y: number; label: string } | null;
  /** Endpoint snap tolerance (world px). Absent ⇒ 12. */
  getSnapTol?: () => number;
  /** Minimum score (0..1) for a trace to draw — the vectorize score is a
   *  brightness margin, so this filters weak-threshold noise. */
  getTraceConfidenceThreshold?: () => number;
  /** Opacity (0..1) of the vectorize metal OUTLINES — the amber "what did
   *  the threshold capture" contours. Traces keep their fixed style. 1 =
   *  fully opaque. Absent ⇒ 0.3. */
  getOutlineAlpha?: () => number;
  /** Pipette samples to mark on the canvas (world coords + sampled rgb). */
  getSamples?: () => VectorPipetteSample[];
  /** P2-2 trace regions: when non-empty, traces/outlines are RENDERED only
   *  where they touch at least one region (materialization applies the same
   *  filter in the Inspector). Empty ⇒ whole die. */
  getTraceRegions?: () => TraceRegionLike[];
  /** Trace blockages: no traces/outlines render inside them even when they
   *  sit inside a region (blockages win). Applied independently of regions. */
  getTraceBlockages?: () => { x: number; y: number; width: number; height: number }[];
  /** Status for the inspector: loading flag, last error, region trace count,
   *  and the last decode's width-filter drop stats. */
  onStatusChange?: (status: {
    loading: boolean;
    error: string | null;
    traces: number;
    droppedWidth?: number;
    /** Octilinear decoder: chains kept raw with irregular=true. */
    irregular?: number;
    /** P2-3 preview lifecycle for the panel status line. */
    preview?: { state: "off" | "fetching" | "ok" | "fail"; failures: number; error: string | null };
  }) => void;
}

/** One pipette measurement: the sampled 7×7 mean colour + where it was
 *  taken (markers stay on the canvas while tuning). */
export interface VectorPipetteSample {
  rgb: [number, number, number];
  x: number;
  y: number;
}

interface CachedRegion {
  bbox: [number, number, number, number];
  paramsKey: string;
  traces: MLTracePolyline[];
  outlines: [number, number][][];
  /** Per-trace bbox, precomputed once — draw() runs per renderer tile and
   *  a whole-die payload holds thousands of polylines: without culling
   *  every tile would walk (and stroke-path) all of them. */
  traceBoxes: { box: Rect; index: number }[];
  outlineBoxes: { box: Rect; index: number }[];
  /** Lazily built Path2D per shape. Rebuilding moveTo/lineTo chains for
   *  thousands of polylines PER TILE PER FRAME was the saved-layer jank;
   *  a cached Path2D is stroke()d directly. */
  tracePaths: (Path2D | null)[];
  outlinePaths: (Path2D | null)[];
  /** Width-filter drop stats of the decode that filled this region. */
  stats?: { kept: number; droppedWidth: number; droppedShort?: number; merged?: number; irregular?: number };
  /** Group-namespace base for collectTraces: each decode region numbered its
   *  groups from 0 independently — WITHOUT a per-region offset every pair of
   *  viewport decodes collided on group ids and materialized into ONE net. */
  groupBase: number;
}

/** Default saved-layer colour (hex): the amber "classical CV" tone the
 *  saved strokes always had. Per-layer colours override it. */
const VECT_LAYER_DEFAULT_COLOR = "#fdc842";

/** hex → 8-bit rgb triple (invalid / non-hex → null). */
function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** One SAVED whole-die payload pinned into the layers list (fetched BY
 *  hash, drawn while its eye toggle is on). */
interface PinnedLayer {
  traces: MLTracePolyline[];
  outlines: [number, number][][];
  traceBoxes: { box: Rect; index: number }[];
  outlineBoxes: { box: Rect; index: number }[];
  tracePaths: (Path2D | null)[];
  outlinePaths: (Path2D | null)[];
  groupBase: number;
  /** Per-layer colour (hex). Changing it drops the baked bitmaps — they
   *  are rebuilt on the next draw in the new colour. */
  color: string;
  /** Pre-rasterized die-sized renders (lazy, per layer) — saved payloads
   *  never change, so painting them is one drawImage blit per tile instead
   *  of a per-shape vector loop on every tile re-render. Outlines are
   *  baked at FULL strength and blitted through `globalAlpha` (the user's
   *  opacity slider); traces keep their fixed dim style. */
  outlineBitmap?: { canvas: HTMLCanvasElement } | null;
  traceBitmap?: { canvas: HTMLCanvasElement } | null;
}

/** Path2D of a polyline; `close` for metal contours. */
function buildPath(pts: [number, number][], close: boolean): Path2D {
  const p = new Path2D();
  p.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) p.lineTo(pts[i][0], pts[i][1]);
  if (close) p.closePath();
  return p;
}

/** Below this zoom the outline fill (the biggest rasterization cost —
 *  hundreds of large polygons per tile) stays on; at deeper zoom it is
 *  dropped and only the cheap edge stroke remains. */
const OUTLINE_FILL_MAX_ZOOM = 4;

/** Saved layers render from PRE-RASTERIZED die-sized bitmaps below this
 *  zoom; above it the vector path (crisp, sparse shapes per tile) is used.
 *  TiledCanvas re-renders every visible tile on every zoom change — the
 *  per-shape vector loop ran on each of those re-renders (hundreds of
 *  fill/stroke per tile = the "Vector Layers lag the canvas" report). */
const SAVED_BITMAP_MAX_ZOOM = 6;
/** Longest bitmap side (px): outlines and traces bake into SEPARATE
 *  canvases (the outline one is blitted through `globalAlpha` = the user's
 *  opacity slider, so it must be baked at full strength). ~8192² RGBA ≈
 *  268 MB worst case, ~195 MB for a 5 Mpx die — per VISIBLE saved layer,
 *  dropped again when the layer's eye goes off. The user asked for crisper
 *  rasters; the caps bound the worst case. */
const SAVED_BITMAP_MAX_DIM = 8192;

function pointsBox(points: [number, number][]): Rect {
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (const [x, y] of points) {
    if (x < minx) minx = x;
    if (y < miny) miny = y;
    if (x > maxx) maxx = x;
    if (y > maxy) maxy = y;
  }
  // Half-px inflation: horizontal/vertical runs produce zero-height/width
  // boxes that strict-intersect would drop when aligned with a tile edge.
  return { x: minx - 0.5, y: miny - 0.5, width: maxx - minx + 1, height: maxy - miny + 1 };
}

export class VectorizeLayer implements Layer {
  readonly id = "vectorize";
  private readonly dieId: string;
  private readonly metadata: DieMetadata;
  private readonly display: VectorizeDisplay;
  private readonly cache = new Map<string, CachedRegion>();
  /** Memoized endpoint snap lookups (`"x:y"` → target or null) — the lookup
   *  is an O(targets) scan per endpoint per frame otherwise. */
  private readonly snapCache = new Map<string, { x: number; y: number } | null>();
  private invalidateCb: ((rect?: Rect) => void) | null = null;
  private destroyed = false;
  /** Keys the debounce timer currently targets (bbox|params) → timer id. */
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingKey: string | null = null;
  private inflightKey: string | null = null;
  private abort: AbortController | null = null;
  /** Set while a request is in flight and the target changed since — the
   *  completion handler immediately refetches the newer target (coalescing:
   *  slider drags never pile up requests). */
  private queuedFetch: { bbox: [number, number, number, number]; params: VectorizeParams; key: string } | null = null;
  /** Viewport hint state, so the "zoom in" notice fires on change only. */
  private lastSkipHint: boolean = false;
  /** Whole-die sweep block coverage: keys where the disk cache answered
   *  incompletely → those fall back to live viewport decode until the sweep
   *  finishes (cleared on clearCache, e.g. when a sweep completes). */
  private readonly blockMiss = new Set<string>();
  /** Keys with a blocks lookup in flight (don't re-ask every frame). */
  private readonly blocksInflight = new Set<string>();
  /** Monotonic group-namespace base (in 1e6 strides) handed to regions and
   *  pinned layers so their `group` ids never collide across decodes. */
  private nextGroupBase = 0;
  /** SAVED layers (pin by hash → fetched whole-die payload). */
  private readonly pinned = new Map<string, PinnedLayer>();
  private readonly pinnedInflight = new Set<string>();
  private savedVisible: string[] = [];
  private savedHiddenSet: ReadonlySet<string> = new Set();
  /** P2-3 preview state: the preprocessed viewport crop (server downscales
   *  to ≤ 1200 px/side) blitted under the overlay. OWNERSHIP lives with the
   *  page-side orchestrator (usePreprocessPreview) — the layer only holds
   *  what to blit and what its lifecycle is; fetching from beginFrame used
   *  to depend on rAF-driven frames, which SUSPEND in background tabs (the
   *  "works once after F12, then silent" report). */
  private previewData: { bitmap: ImageBitmap; bbox: [number, number, number, number] } | null = null;
  /** Consecutive preview failures — drives the retry backoff (a restart
   *  window must not freeze the preview until some canvas movement). */
  private previewFailures = 0;
  /** collectTraces/collectOutlines memo — recomputed ONLY when a decode
   *  region, pin, or hidden-set changes. Their callers run per status tick
   *  (every preview retry fires one) and used to re-stringify EVERY point
   *  of EVERY cached trace each time — a whole-die decode paid tens to
   *  hundreds of ms on the main thread every retry beat (the "floating
   *  performance" report: perfectly fast when idle, laggy right after a
   *  page refresh while the preview retry loop spins). */
  private tracesDirty = true;
  private tracesMemo: MLTracePolyline[] | null = null;
  private outlinesMemo: [number, number][][] | null = null;
  /** Preview lifecycle, mirrored into the panel status (the "silent dead
   *  preview" class of bugs must be visible in the UI, not only console). */
  private previewState: "off" | "fetching" | "ok" | "fail" = "off";
  private previewLastError: string | null = null;
  private lastLoading = false;

  constructor(dieId: string, metadata: DieMetadata, display: VectorizeDisplay = {}) {
    this.dieId = dieId;
    this.metadata = metadata;
    this.display = display;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    this.abort?.abort();
    this.abort = null;
    this.cache.clear();
    this.bumpTraces();
    this.snapCache.clear();
    this.pinned.clear();
    this.pinnedInflight.clear();
    this.inflightKey = null;
    this.queuedFetch = null;
    this.previewData = null;
  }

  subscribe(invalidate: (worldRect?: Rect) => void): () => void {
    this.destroyed = false;
    this.invalidateCb = invalidate;
    return () => {
      this.invalidateCb = null;
    };
  }

  /** Drop everything (params semantics changed / die switched). */
  clearCache(): void {
    this.cache.clear();
    this.bumpTraces();
    this.snapCache.clear();
    this.blockMiss.clear();
    this.invalidateCb?.();
  }

  /** P2-3 preview: the page-side orchestrator pushes the decoded crop (and
   *  clears it when the toggle goes off / a new crop replaces it). Layer
   *  owns NO fetch logic — the ORCHestrator owns retries/status too, the
   *  layer stays a dumb drawable. The bitmap is OWNED by the caller. */
  setPreviewData(
    data: { bitmap: ImageBitmap; bbox: [number, number, number, number] } | null
  ): void {
    this.previewData = data;
  }

  /** P2-3 preview lifecycle, reported by the page orchestrator (loading
   *  flag reuses the last decode's). */
  setPreviewStatus(state: "off" | "fetching" | "ok" | "fail", failures: number, error: string | null): void {
    this.previewFailures = failures;
    if (this.previewState !== state || (error ?? null) !== this.previewLastError) {
      console.info(`[VectorizeLayer] preprocess preview: ${state}${error ? ` — ${error}` : ""}${state === "fail" ? ` (×${failures})` : ""}`);
    }
    this.previewState = state;
    this.previewLastError = error ?? null;
    this.notifyStatus();
  }

  /** Redraw request from outside (e.g. the P2-2 trace region list changed —
   *  culling happens at draw time, but tiles are cached rasters that don't
   *  re-render without an invalidate). */
  refresh(): void {
    this.invalidateCb?.();
  }

  /** Bounding boxes of the active trace regions (P2-2); empty = off. */
  private traceRegionRects(): Rect[] {
    const regions = this.display.getTraceRegions?.() ?? [];
    return regions.map((r) => traceRegionBox(r));
  }

  private traceBlockageRects(): Rect[] {
    return this.display.getTraceBlockages?.() ?? [];
  }

  private static inAnyRegion(box: Rect, regions: Rect[]): boolean {
    if (regions.length === 0) return true;
    for (const r of regions) {
      if (
        box.x + box.width >= r.x &&
        r.x + r.width >= box.x &&
        box.y + box.height >= r.y &&
        r.y + r.height >= box.y
      ) {
        return true;
      }
    }
    return false;
  }

  /** Blockage cull: the shape's ACTUAL centreline entering a blockage must
   *  not render — blockages take priority over trace regions (and apply
   *  even when there are no regions at all). Bbox tests would wrongly eat
   *  neighbouring traces whose bbox merely spans the blockage (a diagonal
   *  trace passing beside it never enters), so this is a geometric test
   *  guarded by a per-blockage bbox reject. */
  private static inNoBlockage(points: [number, number][], blockages: Rect[]): boolean {
    for (const b of blockages) {
      if (polylineEntersRect(points, b)) return false;
    }
    return true;
  }

  /** Saved layers list from the outline tree (Vector layers): pinned, eye
   *  toggles persisted in preferences. Payloads are fetched BY hash and
   *  stay rendered regardless of the live params. `colors` maps hash → hex
   *  (absent = the default amber); a changed colour drops the layer's baked
   *  bitmaps so the next draw re-bakes in the new colour. */
  /** Signature of the last setSavedLayers inputs — repeated identical syncs
   *  (prefs-store churn, effect re-runs) return instead of full-invalidating
   *  every canvas tile each time ("after-reload crawl" class of bugs). */
  private savedSig: string | null = null;

  setSavedLayers(
    visibleHashes: string[],
    hiddenHashes: ReadonlySet<string>,
    colors?: ReadonlyMap<string, string>
  ): void {
    const sig = [
      visibleHashes.join(","),
      [...hiddenHashes].sort().join(","),
      ...(colors
        ? [...colors.entries()].sort().map(([h, c]) => `${h}=${c}`)
        : [])
    ].join("|");
    if (sig === this.savedSig) return;
    this.savedSig = sig;
    this.savedVisible = visibleHashes;
    this.savedHiddenSet = hiddenHashes;
    this.bumpTraces(); // pin set / hidden set feed collectTraces
    // Evict pins no longer wanted at all.
    const wanted = new Set(visibleHashes);
    for (const h of [...this.pinned.keys()]) {
      if (!wanted.has(h)) this.pinned.delete(h);
    }
    for (const h of visibleHashes) {
      if (!this.pinned.has(h) && !this.pinnedInflight.has(h)) {
        this.pinnedInflight.add(h);
        fetchVectorLayerBlocks(this.dieId, h, [
          0,
          0,
          this.metadata.width,
          this.metadata.height
        ])
          .then((resp) => {
            if (this.destroyed) return;
            const traces = resp.blocks.flatMap((b) => b.traces);
            const outlines = resp.blocks.flatMap((b) => b.outlines);
            if (traces.length + outlines.length === 0) {
              this.pinned.delete(h);
              this.bumpTraces();
              return;
            }
            this.pinned.set(h, {
              traces,
              outlines,
              traceBoxes: traces.map((t, i) => ({ box: pointsBox(t.points), index: i })),
              outlineBoxes: outlines.map((o, i) => ({ box: pointsBox(o), index: i })),
              tracePaths: traces.map(() => null),
              outlinePaths: outlines.map(() => null),
              groupBase: (this.nextGroupBase++) * 1_000_000,
              color: colors?.get(h) ?? VECT_LAYER_DEFAULT_COLOR
            });
            this.bumpTraces();
            this.invalidateCb?.();
          })
          .catch(() => undefined)
          .finally(() => this.pinnedInflight.delete(h));
      } else {
        // Colour update on an already-pinned layer: re-bake if changed.
        const pin = this.pinned.get(h);
        const next = colors?.get(h) ?? VECT_LAYER_DEFAULT_COLOR;
        if (pin && pin.color !== next) {
          pin.color = next;
          pin.outlineBitmap = null;
          pin.traceBitmap = null;
        }
      }
    }
    this.invalidateCb?.();
  }

  /** Latest error string (panel display), cleared on a successful fetch. */
  private lastError: string | null = null;
  /** Drop stats of the latest decode (panel diagnostics). */
  private lastStats: {
    kept: number;
    droppedWidth: number;
    droppedShort?: number;
    merged?: number;
    irregular?: number;
  } | null = null;

  private notifyStatus(loading?: boolean): void {
    if (loading !== undefined) this.lastLoading = loading;
    this.display.onStatusChange?.({
      loading: this.lastLoading,
      error: this.lastError,
      traces: this.collectTraces().length,
      ...(this.lastStats ? { droppedWidth: this.lastStats.droppedWidth } : {}),
      ...(this.lastStats?.irregular ? { irregular: this.lastStats.irregular } : {}),
      preview: {
        state: this.previewState,
        failures: this.previewFailures,
        error: this.previewLastError
      }
    });
  }

  /** Mutation hook for the traces memo (see the field comment). */
  private bumpTraces(): void {
    this.tracesDirty = true;
  }

  /** Every decoded trace across cached regions and pinned saved layers,
   *  deduplicated by point sequence — a trace straddling two fetched
   *  regions appears in both. `group` ids are NAMESPACED per region/pin:
   *  each decode numbers its groups from 0, so raw ids collide across
   *  decodes and materialization would merge unrelated wires into one net.
   *  Memoized: deduplication stringifies every point of every trace, so a
   *  whole-die decode costs tens-to-hundreds of ms per call on the main
   *  thread; calls (the status panel asks per status tick) must reuse it. */
  collectTraces(): MLTracePolyline[] {
    if (!this.tracesDirty && this.tracesMemo) return this.tracesMemo;
    const t0 = performance.now();
    const seen = new Set<string>();
    const out: MLTracePolyline[] = [];
    for (const region of this.cache.values()) {
      const base = region.groupBase;
      for (const t of region.traces) {
        const key = t.points.map((p) => `${Math.round(p[0])},${Math.round(p[1])}`).join(";");
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(
          typeof t.group === "number"
            ? { ...t, group: base + t.group }
            : t
        );
      }
    }
    for (const [hash, pin] of this.pinned) {
      if (this.savedHiddenSet.has(hash)) continue;
      const base = pin.groupBase;
      for (const t of pin.traces) {
        const key = t.points.map((p) => `${Math.round(p[0])},${Math.round(p[1])}`).join(";");
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(
          typeof t.group === "number"
            ? { ...t, group: base + t.group }
            : t
        );
      }
    }
    const ms = performance.now() - t0;
    if (ms > 10) {
      console.info(`[VectorizeLayer] collectTraces rebuilt in ${ms.toFixed(0)}ms — ${out.length} traces (only on decode/pin changes)`);
    }
    this.tracesMemo = out;
    this.tracesDirty = false;
    return out;
  }

  /** Metal outline polygons (the "what did the threshold capture" contours)
   *  of everything currently collected — same dedupe rule as collectTraces.
   *  Materialization uses them for the authoritative "is this contact
   *  ON the metal" test (point-in-polygon), which the centreline+width
   *  proxy only approximates. */
  collectOutlines(): [number, number][][] {
    if (!this.tracesDirty && this.outlinesMemo) return this.outlinesMemo;
    const seen = new Set<string>();
    const out: [number, number][][] = [];
    const push = (pts: [number, number][]) => {
      const key = pts.map((p) => `${Math.round(p[0])},${Math.round(p[1])}`).join(";");
      if (seen.has(key)) return;
      seen.add(key);
      out.push(pts);
    };
    for (const region of this.cache.values()) {
      for (const o of region.outlines) push(o);
    }
    for (const [hash, pin] of this.pinned) {
      if (this.savedHiddenSet.has(hash)) continue;
      for (const o of pin.outlines) push(o);
    }
    this.outlinesMemo = out;
    // Shared dirty flag with collectTraces — both fold the same sources and
    // are invalidated together.
    this.tracesDirty = false;
    return out;
  }

  /**
   * One per frame, before any tile draw: schedule a viewport-sized region
   * fetch. `frame.world` is the FULL visible world rect (draw() below only
   * sees per-tile rects — scheduling there produced per-tile requests, and
   * canvas tiles outside the die produced degenerate bboxes the backend
   * rightly rejected). Clamped to the die, guarded against degenerate /
   * oversized viewports.
   */
  beginFrame(frame: RenderFrame): void {
    const params = this.display.getParams?.();
    if (!params || (this.display.getHidden?.() ?? false)) return;

    const w = frame.world;
    const x0 = Math.max(0, Math.floor(w.x));
    const y0 = Math.max(0, Math.floor(w.y));
    const x1 = Math.min(this.metadata.width, Math.ceil(w.x + w.width));
    const y1 = Math.min(this.metadata.height, Math.ceil(w.y + w.height));
    // The viewport (or the part of it over the die) can be empty — never
    // fetch then, and drop any stale "zoom in" hint.
    if (!(x1 > x0 && y1 > y0) || !Number.isFinite(x0 + y0 + x1 + y1)) {
      if (this.lastSkipHint) {
        this.lastSkipHint = false;
        this.notifyStatus(false);
      }
      return;
    }
    const bbox: [number, number, number, number] = [x0, y0, x1, y1];
    const area = (x1 - x0) * (y1 - y0);
    if (area > MAX_AREA_PX) {
      // Too zoomed out for live decoding — hint once, don't hammer.
      if (!this.lastSkipHint) {
        this.lastSkipHint = true;
        this.lastError = "viewport too large — zoom in to vectorize (≤ 5 Mpx)";
        this.notifyStatus(false);
      }
      return;
    }
    if (this.lastSkipHint) {
      this.lastSkipHint = false;
      this.lastError = null;
      this.notifyStatus(false);
    }

    const overlaySource = this.display.getOverlaySource?.() ?? undefined;
    const key = `${bbox.join(",")}|${overlaySource ?? ""}|${JSON.stringify(params)}`;

    // Whole-die sweep cache first: if every block intersecting the viewport
    // is decoded for THESE params, draw from disk — no sidecar round-trip.
    // Any missing block (sweep not run / params changed mid-sweep) → mark
    // the key and fall back to the live viewport decode. An EMPTY payload
    // (0 traces + 0 outlines) is treated as a miss too: an empty cached
    // decode would otherwise stick and silently blank the overlay.
    if (!this.blockMiss.has(key) && !this.blocksInflight.has(key)) {
      this.blocksInflight.add(key);
      fetchVectorBlocks(this.dieId, bbox, params, overlaySource)
        .then((resp) => {
          this.blocksInflight.delete(key);
          if (this.destroyed) return;
          const counts = resp.blocks.reduce(
            (n, b) => n + b.traces.length + b.outlines.length,
            0
          );
          if (resp.blocks.length > 0 && resp.missing === 0 && counts > 0) {
            this.lastError = null;
            const traces = resp.blocks.flatMap((b) => b.traces);
            const outlines = resp.blocks.flatMap((b) => b.outlines);
            this.cache.set(key, {
              bbox,
              paramsKey: "",
              traces,
              outlines,
              traceBoxes: traces.map((t, i) => ({ box: pointsBox(t.points), index: i })),
              outlineBoxes: outlines.map((o, i) => ({ box: pointsBox(o), index: i })),
              tracePaths: traces.map(() => null),
              outlinePaths: outlines.map(() => null),
              groupBase: (this.nextGroupBase++) * 1_000_000
            });
            while (this.cache.size > MAX_REGIONS) {
              const oldest = this.cache.keys().next().value;
              if (oldest === undefined) break;
              this.cache.delete(oldest);
            }
            this.bumpTraces();
            this.notifyStatus(false);
            this.invalidateCb?.({
              x: bbox[0],
              y: bbox[1],
              width: bbox[2] - bbox[0],
              height: bbox[3] - bbox[1]
            });
          } else {
            this.blockMiss.add(key);
            this.scheduleLiveFetch(bbox, params, key, overlaySource);
          }
        })
        .catch(() => {
          this.blocksInflight.delete(key);
          if (this.destroyed) return;
          this.blockMiss.add(key);
          this.scheduleLiveFetch(bbox, params, key, overlaySource);
        });
      return;
    }
    if (this.blockMiss.has(key)) {
      this.scheduleLiveFetch(bbox, params, key, overlaySource);
    }
  }

  /** Paint the preprocessed viewport crop under everything else (P2-3).
   *  The server may have downscaled it; drawImage scales it back to the
   *  exact bbox rect. A thin amber border marks the preview extent. */
  private drawPreview(ctx: CanvasRenderingContext2D, zoom: number, world: Rect): void {
    const preview = this.previewData;
    if (!preview) return;
    const [px0, py0, px1, py1] = preview.bbox;
    if (px1 <= world.x || px0 >= world.x + world.width || py1 <= world.y || py0 >= world.y + world.height) return;
    ctx.drawImage(preview.bitmap, px0, py0, px1 - px0, py1 - py0);
    ctx.strokeStyle = "rgba(253, 224, 71, 0.55)";
    ctx.lineWidth = Math.max(1, 1.5 / zoom);
    ctx.setLineDash([6 / zoom, 4 / zoom]);
    ctx.strokeRect(px0, py0, px1 - px0, py1 - py0);
    ctx.setLineDash([]);
  }

  /** Debounced + coalesced live viewport decode (the tuning path). */
  private scheduleLiveFetch(
    bbox: [number, number, number, number],
    params: VectorizeParams,
    key: string,
    overlaySource: string | undefined
  ): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingKey = key;
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      this.pendingKey = null;
      const target = { bbox, params, key };
      if (this.inflightKey) {
        this.queuedFetch = target; // finish current, then fetch this
      } else {
        void this.fetch(target);
      }
    }, FETCH_DEBOUNCE_MS);
  }

  draw(ctx: CanvasRenderingContext2D, bounds: TileBounds): void {
    const { zoom } = bounds;

    // Pipette markers: one amber cross per accumulated sample, each with a
    // small value label (that sample's shade on the current channel) —
    // drawn even while the overlay itself is hidden, so sampling stays
    // visible and readable without hovering the panel.
    const samples = this.display.getSamples?.() ?? [];
    if (samples.length > 0) {
      const r = Math.max(4 / zoom, 3);
      ctx.strokeStyle = "rgba(253, 224, 71, 0.9)";
      ctx.lineWidth = Math.max(1 / zoom, 1.2 / zoom);
      for (const s of samples) {
        ctx.beginPath();
        ctx.moveTo(s.x - r, s.y);
        ctx.lineTo(s.x + r, s.y);
        ctx.moveTo(s.x, s.y - r);
        ctx.lineTo(s.x, s.y + r);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(s.x, s.y, r * 0.4, 0, Math.PI * 2);
        ctx.stroke();
      }
      // Value pills above each cross, in screen-constant size.
      const fs = Math.max(9 / zoom, 9);
      ctx.font = `${fs}px ui-monospace, monospace`;
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      const padX = 2 / zoom;
      const padY = 1 / zoom;
      for (const s of samples) {
        const [sr, sg, sb] = s.rgb;
        const v = Math.round(0.299 * sr + 0.587 * sg + 0.114 * sb);
        const text = String(v);
        const tw = ctx.measureText(text).width;
        const lx = s.x + r + 2 / zoom;
        const ly = s.y - r - 2 / zoom;
        ctx.fillStyle = "rgba(16, 18, 24, 0.78)";
        ctx.fillRect(lx - padX, ly - fs - padY, tw + padX * 2, fs + padY * 2);
        ctx.fillStyle = "rgba(253, 224, 71, 0.95)";
        ctx.fillText(text, lx, ly);
      }
    }

    const params = this.display.getParams?.();
    const hidden = this.display.getHidden?.() ?? false;
    // P2-3 preview: INDEPENDENT of the overlay — draws the preprocessed
    // viewport crop even while "Show vector overlay" is off (the user tunes
    // the image itself, the overlay is a tuning aid they may not want).
    this.drawPreview(ctx, zoom, bounds.world);
    // SAVED layers render regardless of the live overlay's hidden flag and
    // even without live params: their eye toggles in "Vector Layers" are
    // the source of truth. Gating them behind the global hide switch used
    // to make the eye toggle do nothing while "Show vector overlay" was off
    // (the default!) — the exact "saved layer renders nothing" report.
    if (hidden || !params) {
      this.drawSaved(ctx, bounds);
      return;
    }
    const world = bounds.world;

    // ── Paint every cached region overlapping the view ───────────────
    const strokeW = 1 / zoom;
    const minScore = this.display.getTraceConfidenceThreshold?.() ?? 0;
    const snapTol = this.display.getSnapTol?.() ?? 12;
    // P2-2: trace regions restrict what renders at all; blockages cut holes.
    const regionRects = this.traceRegionRects();
    const blockageRects = this.traceBlockageRects();
    // Outline opacity (user slider): fill takes α, the edge stroke reads
    // slightly stronger so the contour line stays defined even at low α.
    const outlineAlpha = Math.min(1, Math.max(0, this.display.getOutlineAlpha?.() ?? 0.3));
    const outlineFill = `rgba(253, 224, 71, ${outlineAlpha.toFixed(3)})`;
    const outlineEdge = `rgba(253, 224, 71, ${Math.min(1, outlineAlpha * 1.6).toFixed(3)})`;
    for (const region of this.cache.values()) {
      const [rx0, ry0, rx1, ry1] = region.bbox;
      const regionRect: Rect = { x: rx0, y: ry0, width: rx1 - rx0, height: ry1 - ry0 };
      if (!rectsIntersect(regionRect, world)) continue;

      // Outlines first — the light "what did my threshold capture" fill.
      // Per-shape bbox culling: a whole-die payload holds thousands of
      // polylines and draw() runs per renderer tile.
      ctx.lineWidth = strokeW;
      for (const { box, index } of region.outlineBoxes) {
        if (!rectsIntersect(box, world)) continue;
        if (!VectorizeLayer.inAnyRegion(box, regionRects)) continue;
        const pts = region.outlines[index];
        if (!VectorizeLayer.inNoBlockage(pts, blockageRects)) continue;
        if (pts.length < 3) continue;
        const path = (region.outlinePaths[index] ??= buildPath(pts, true));
        // The fill is the rasterization hog (hundreds of large polygons per
        // tile): keep it at overview zoom, drop it when zoomed in — the
        // edge stroke still shows the captured metal.
        if (zoom < OUTLINE_FILL_MAX_ZOOM) {
          ctx.fillStyle = outlineFill;
          ctx.fill(path);
        }
        ctx.strokeStyle = outlineEdge;
        ctx.stroke(path);
      }

      // Centreline traces + endpoint snaps.
      for (const { box, index } of region.traceBoxes) {
        if (!rectsIntersect(box, world)) continue;
        if (!VectorizeLayer.inAnyRegion(box, regionRects)) continue;
        const t = region.traces[index];
        if (!VectorizeLayer.inNoBlockage(t.points, blockageRects)) continue;
        if ((t.score ?? 1) < minScore) continue;
        const pts = t.points;
        if (pts.length < 2) continue;
        const path = (region.tracePaths[index] ??= buildPath(pts, false));
        // Irregular (octilinear decoder kept the raw chain) — dashed, so
        // non-0/45/90° geometry is visible as such instead of "randomly
        // angled traces that look like a decoder bug".
        if (t.irregular === true) {
          ctx.setLineDash([5 / zoom, 4 / zoom]);
        }
        ctx.strokeStyle = VECT_TRACE_STROKE;
        ctx.lineWidth = Math.max(strokeW, 1.5 / zoom);
        ctx.stroke(path);
        ctx.setLineDash([]);

        for (const end of [pts[0], pts[pts.length - 1]]) {
          const skey = `${end[0]}:${end[1]}:${snapTol}`;
          let target = this.snapCache.get(skey);
          if (target === undefined) {
            target = this.display.findSnapTarget?.({ x: end[0], y: end[1] }, snapTol) ?? null;
            this.snapCache.set(skey, target);
          }
          if (!target) continue;
          ctx.beginPath();
          ctx.moveTo(end[0], end[1]);
          ctx.lineTo(target.x, target.y);
          ctx.strokeStyle = VECT_TRACE_SNAP_STROKE;
          ctx.lineWidth = strokeW;
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(target.x, target.y, Math.max(3 / zoom, 2.5), 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }
  }

  /** Pinned SAVED layers (the Vector layers list) — drawn independently of
   *  the live overlay: works while "Show vector overlay" is off. Slightly
   *  dimmer strokes so the live reads stand out against saved results.
   *  At overview/mid zoom the layer paints from its pre-rasterized bitmap
   *  (one drawImage per tile); the per-shape vector loop below is the deep-
   *  zoom fallback where the bitmap would blur. */
  private drawSaved(ctx: CanvasRenderingContext2D, bounds: TileBounds): void {
    const { zoom } = bounds;
    const world = bounds.world;
    const minScore = this.display.getTraceConfidenceThreshold?.() ?? 0;
    const snapTol = this.display.getSnapTol?.() ?? 12;
    const strokeW = 1 / zoom;
    const outlineAlpha = Math.min(1, Math.max(0, this.display.getOutlineAlpha?.() ?? 0.3));
    // P2-2: with trace regions (or blockages) active the pre-baked die-sized
    // bitmaps can't be culled per shape — fall back to the vector path,
    // which can.
    const regionRects = this.traceRegionRects();
    const blockageRects = this.traceBlockageRects();
    for (const [hash, pin] of this.pinned) {
      if (this.savedHiddenSet.has(hash)) {
        // Free the (large) bitmaps of a hidden layer — they are rebuilt from
        // the still-pinned payload the moment the eye turns back on.
        pin.outlineBitmap = null;
        pin.traceBitmap = null;
        continue;
      }
      // Per-layer colour (the tree's picker); amber unless overridden.
      const [r, g, b] = hexToRgb(pin.color) ?? hexToRgb(VECT_LAYER_DEFAULT_COLOR)!;
      const outlineFill = `rgba(${r}, ${g}, ${b}, ${outlineAlpha.toFixed(3)})`;
      const outlineEdge = `rgba(${r}, ${g}, ${b}, ${Math.min(1, outlineAlpha * 1.6).toFixed(3)})`;
      if (zoom < SAVED_BITMAP_MAX_ZOOM && regionRects.length === 0 && blockageRects.length === 0) {
        const ob = this.ensureOutlineBitmap(pin);
        const tb = this.ensureTraceBitmap(pin);
        if (ob && tb) {
          // Sub-rect blit: the bitmap is baked at ~bakeScale px per world
          // unit, so this tile's world rect maps to a SOURCE sub-rect —
          // resample only that. The old full-bitmap drawImage resampled the
          // whole die-sized source into EVERY tile of every frame (the
          // saved-layer jank returned on the big die). The outline siluet
          // reads through globalAlpha — baked at full strength, the user's
          // opacity slider dims it live — traces blit at fixed style.
          const blit = (bm: { canvas: HTMLCanvasElement }, alpha: number) => {
            const bx = bm.canvas.width / this.metadata.width;
            const by = bm.canvas.height / this.metadata.height;
            const sx = Math.max(0, Math.floor(world.x * bx));
            const sy = Math.max(0, Math.floor(world.y * by));
            const sw = Math.min(
              bm.canvas.width - sx,
              Math.ceil((world.x + world.width) * bx) - sx
            );
            const sh = Math.min(
              bm.canvas.height - sy,
              Math.ceil((world.y + world.height) * by) - sy
            );
            if (sw <= 0 || sh <= 0) return;
            if (alpha < 1) ctx.globalAlpha = alpha;
            ctx.drawImage(
              bm.canvas,
              sx, sy, sw, sh,
              sx / bx, sy / by, sw / bx, sh / by
            );
            if (alpha < 1) ctx.globalAlpha = 1;
          };
          blit(ob, outlineAlpha);
          blit(tb, 1);
          continue;
        }
      }
      ctx.lineWidth = strokeW;
      for (const { box, index } of pin.traceBoxes) {
        if (!rectsIntersect(box, world)) continue;
        if (!VectorizeLayer.inAnyRegion(box, regionRects)) continue;
        const t = pin.traces[index];
        if (!VectorizeLayer.inNoBlockage(t.points, blockageRects)) continue;
        if ((t.score ?? 1) < minScore) continue;
        const pts = t.points;
        if (pts.length < 2) continue;
        const path = (pin.tracePaths[index] ??= buildPath(pts, false));
        if (t.irregular === true) ctx.setLineDash([5 / zoom, 4 / zoom]);
        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.75)`;
        ctx.lineWidth = Math.max(strokeW, 1.5 / zoom);
        ctx.stroke(path);
        ctx.setLineDash([]);
      }
      for (const { box, index } of pin.outlineBoxes) {
        if (!rectsIntersect(box, world)) continue;
        if (!VectorizeLayer.inAnyRegion(box, regionRects)) continue;
        const pts = pin.outlines[index];
        if (!VectorizeLayer.inNoBlockage(pts, blockageRects)) continue;
        if (pts.length < 3) continue;
        const path = (pin.outlinePaths[index] ??= buildPath(pts, true));
        if (zoom < OUTLINE_FILL_MAX_ZOOM) {
          ctx.fillStyle = outlineFill;
          ctx.fill(path);
        }
        ctx.strokeStyle = outlineEdge;
        ctx.stroke(path);
      }
    }
  }

  /** Bake the saved layer's metal outlines once into a die-sized offscreen
   *  canvas (world units × bitmap scale) at FULL strength — the blit goes
   *  through `globalAlpha`, so the outline-opacity slider works live
   *  without a re-bake. Solid layer colour fill + edge stroke (the edge
   *  reads as part of the silhouette once alpha is applied uniformly). */
  private ensureOutlineBitmap(pin: PinnedLayer): { canvas: HTMLCanvasElement } | null {
    if (pin.outlineBitmap !== undefined) return pin.outlineBitmap;
    const [r, g, b] = hexToRgb(pin.color) ?? hexToRgb(VECT_LAYER_DEFAULT_COLOR)!;
    pin.outlineBitmap = this.bakePinBitmap(pin, (c) => {
      for (const o of pin.outlines) {
        if (o.length < 3) continue;
        const path = buildPath(o, true);
        c.fillStyle = `rgb(${r}, ${g}, ${b})`;
        c.fill(path);
        c.strokeStyle = `rgb(${r}, ${g}, ${b})`;
        c.lineWidth = 1;
        c.stroke(path);
      }
    });
    return pin.outlineBitmap;
  }

  /** Bake the saved layer's centreline traces once (fixed 75% dim of the
   *  layer colour — the opacity slider deliberately does not touch them). */
  private ensureTraceBitmap(pin: PinnedLayer): { canvas: HTMLCanvasElement } | null {
    if (pin.traceBitmap !== undefined) return pin.traceBitmap;
    const [r, g, b] = hexToRgb(pin.color) ?? hexToRgb(VECT_LAYER_DEFAULT_COLOR)!;
    pin.traceBitmap = this.bakePinBitmap(pin, (c) => {
      for (const t of pin.traces) {
        const pts = t.points;
        if (pts.length < 2) continue;
        const path = buildPath(pts, false);
        if (t.irregular === true) c.setLineDash([5, 4]);
        c.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.75)`;
        c.lineWidth = 1.5;
        c.stroke(path);
        c.setLineDash([]);
      }
    });
    return pin.traceBitmap;
  }

  /** Shared bake: die-sized canvas at SAVED_BITMAP_MAX_DIM, draw callback in
   *  world units. `undefined` (not null) marks "not baked yet". */
  private bakePinBitmap(
    pin: PinnedLayer,
    paint: (c: CanvasRenderingContext2D) => void
  ): { canvas: HTMLCanvasElement } | null {
    const w = this.metadata.width;
    const h = this.metadata.height;
    if (!(w > 0 && h > 0)) return null;
    const scale = Math.min(1, SAVED_BITMAP_MAX_DIM / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const c = canvas.getContext("2d");
    if (!c) return null;
    c.scale(canvas.width / w, canvas.height / h);
    paint(c);
    return { canvas };
  }

  /** One region request. While in flight, newer targets go to `queuedFetch`
   *  and run on completion — slider drags never pile up parallel requests. */
  private async fetch(target: {
    bbox: [number, number, number, number];
    params: VectorizeParams;
    key: string;
  }): Promise<void> {
    this.inflightKey = target.key;
    this.abort = new AbortController();
    this.notifyStatus(true);
    try {
      const resp = await vectorizeRegion(
        this.dieId,
        target.bbox,
        target.params,
        this.display.getOverlaySource?.() ?? undefined,
        this.abort.signal
      );
      if (this.destroyed) return;
      this.lastError = null;
      this.lastStats = resp.stats ?? null;
      this.cache.set(target.key, {
        bbox: target.bbox,
        paramsKey: target.key.slice(target.bbox.join(",").length + 1),
        traces: resp.traces,
        outlines: resp.outlines,
        traceBoxes: resp.traces.map((t, i) => ({ box: pointsBox(t.points), index: i })),
        outlineBoxes: resp.outlines.map((o, i) => ({ box: pointsBox(o), index: i })),
        tracePaths: resp.traces.map(() => null),
        outlinePaths: resp.outlines.map(() => null),
        stats: resp.stats,
        groupBase: (this.nextGroupBase++) * 1_000_000
      });
      // Evict the oldest region beyond the cap (Map = insertion order).
      while (this.cache.size > MAX_REGIONS) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
      this.bumpTraces();
      this.notifyStatus(false);
      this.invalidateCb?.({
        x: target.bbox[0],
        y: target.bbox[1],
        width: target.bbox[2] - target.bbox[0],
        height: target.bbox[3] - target.bbox[1]
      });
    } catch (e) {
      if (this.destroyed) return;
      if ((e as Error)?.name === "AbortError") return;
      this.lastError = e instanceof Error ? e.message : "vectorize failed";
      this.notifyStatus(false);
      // NB: no invalidate here — a persistent error (sidecar down, bad
      // params) would otherwise reschedule itself every frame. The user's
      // next interaction redraws and retries naturally.
    } finally {
      this.inflightKey = null;
      this.abort = null;
      const next = this.queuedFetch;
      this.queuedFetch = null;
      if (next && !this.destroyed) void this.fetch(next);
    }
  }
}
