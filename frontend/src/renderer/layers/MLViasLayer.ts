import type { DieMetadata, ImageFlip, MLTracePolyline, MLPrediction, MLViasTilesResponse } from "shared";
import {
  pointInRect,
  rectsIntersect,
  type Point,
  type Rect
} from "../../lib/geometry";
import { flipPoint, flipRect, isFlipped, type ImageSize } from "../../lib/imageFlip";
import {
  COLOR_VIA,
  COLOR_VIA_FILL,
  SELECT_COLOR,
  SELECT_FILL,
  SELECT_NODE_MULT,
  SELECT_OUTLINE_PX,
  SELECT_RING,
  VIA_DEFAULT_COLOR,
  VIA_DEFAULT_SIZE,
  viaColorWithAlpha,
  viaScreenRadius
} from "../annotations/style";
import type { Layer, TileBounds } from "../types";

/**
 * Synthetic, position-based ID for an ML via. Source-pixel coordinates are
 * already integer-valued (the backend emits whole-pixel centres), so rounding
 * gives the same key across tile evictions / refetches. Lets the selection
 * set point at "this ML via" without the model ever assigning real IDs.
 */
export function mlViaId(x: number, y: number): string {
  return `ml-via:${Math.round(x)}:${Math.round(y)}`;
}

/** True iff `id` looks like an ML via id minted by `mlViaId`. */
export function isMlViaId(id: string): boolean {
  return id.startsWith("ml-via:");
}

/** Parse a `mlViaId`-formatted string back to its coords, or null. */
export function parseMlViaId(id: string): Point | null {
  if (!isMlViaId(id)) return null;
  const parts = id.slice("ml-via:".length).split(":");
  if (parts.length !== 2) return null;
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

/** A snapshot of one ML via — what the layer hands back to selection / inspector. */
export interface MLViaHit {
  id: string;
  x: number;
  y: number;
  score: number;
  /** `point` = `pointVias` entry; `irregular` = `irregularVias` entry. The
   *  inspector uses this to label the kind ("Via point" vs "Via region"). */
  kind: "point" | "irregular";
  /** Via layer id (VIA12, VIA23, …) when the checkpoint names one. */
  viaLayer?: string;
}

/**
 * Renders ML via predictions across the whole die. Predictions exist only at
 * the native (full-resolution) tile level; they're fetched in *blocks* of
 * BLOCK×BLOCK native tiles via the batched `GET /api/dies/:dieId/vias/tiles`
 * endpoint — one request per block instead of one per tile, so loading a
 * zoomed-out view costs a handful of requests, not thousands.
 *
 * The overlay is display-only: it fetches cached predictions and never
 * triggers inference (that's the explicit inference job's role). A tile the
 * job hasn't computed yet simply isn't drawn until a later `retryFailed`.
 *
 * Loaded tile payloads stick around for the lifetime of the layer — a tile
 * prediction is a few KB of JSON, so even a die's worth of blocks fits
 * comfortably. (Eviction was tried and removed: any per-tile cap clashed
 * with the block-granular fetch, since partially-visible blocks always had
 * off-view tiles to evict, which then dropped the whole block from the
 * "requested" set and triggered a refetch storm. The remaining safety net
 * — `MAX_VIEWPORT_FETCH` per renderer-tile — already skips fetching at
 * extreme zoom-out where vias are sub-pixel anyway.) Visibility + a
 * "currently-loaded vias" count are read via the live accessors on
 * `MLViasDisplay` so the host can toggle the overlay from a preference
 * without rebuilding the layer.
 */

const EMPTY_SET: ReadonlySet<string> = new Set();

function idSetsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

// Native tiles per side of a fetch block. 16×16 = 256 tiles per request.
const BLOCK = 16;
// Most native tiles a single draw will fetch. Above this the viewport is so
// zoomed out that vias aren't meaningfully visible — skip the fetch flood.
const MAX_VIEWPORT_FETCH = 4096;
// In-flight `fetchBlock` calls. At a low zoom many renderer-tiles each ask
// for multiple blocks; without a cap Chrome hits ERR_INSUFFICIENT_RESOURCES
// (per-origin socket pool / pending-request limits) well before the work is
// actually heavy. Pending fetches queue and dispatch as slots free.
const MAX_INFLIGHT_FETCHES = 4;
const IRREGULAR_STROKE_PX = 1;
// ML trace overlay (v2 skeleton decode of the model's trace channel): cyan,
// to read as "model's metal" — distinct from the green vias and user nets.
const ML_TRACE_STROKE = "rgba(103, 232, 249, 0.9)";
const ML_TRACE_SNAP_STROKE = "rgba(103, 232, 249, 0.65)";

/** Block key (`${bx}/${by}`) a native tile belongs to. */
function blockKey(tx: number, ty: number): string {
  return `${Math.floor(tx / BLOCK)}/${Math.floor(ty / BLOCK)}`;
}

interface CachedViasTile {
  z: number;
  x: number;
  y: number;
  /** Null while in-flight. Populated on successful load. */
  data: MLPrediction | null;
  loaded: boolean;
  failed: boolean;
}

export interface MLViasDisplay {
  /** True → don't paint anything at all. */
  getHidden?: () => boolean;
  /** True → don't paint the trace overlay (the vias stay visible). Absent
   *  ⇒ traces are drawn whenever the layer itself is visible. */
  getTracesHidden?: () => boolean;
  /** Minimum mean probability inside the contour (0..1) for a trace
   *  polyline to be drawn. Traces without a score (old caches) always pass.
   *  Absent ⇒ 0 (show everything). */
  getTraceConfidenceThreshold?: () => number;
  /** Device contacts / cell terminals / IO pins as trace-endpoint snap
   *  targets (the same candidates the wire tool offers). Return the snapped
   *  point when one is within `tolWorld`, else null. Absent ⇒ no snap. */
  findSnapTarget?: (world: Point, tolWorld: number) => { x: number; y: number; label: string } | null;
  /** Point-via render radius (world / source-pixel units). Same value is
   *  used by the snap-to-via tolerance via `findNearestPointVia(world,
   *  radius)`. Absent ⇒ default. */
  getViaWorldRadius?: () => number;
  /** Minimum model confidence (0..1) for a via to be drawn / counted /
   *  snapped. Cached predictions keep every detection + score; this filters
   *  them client-side. Absent ⇒ 0 (show everything). */
  getConfidenceThreshold?: () => number;
  /** Point-via colour (rgba string). Default: VIA_DEFAULT_COLOR.
   *  Used when getViaLayerColor is absent or the via has no layer. */
  getViaColor?: () => string;
  /** Per-via-layer colour override. Takes priority over getViaColor. */
  getViaLayerColor?: (viaLayer: string) => string | undefined;
  /** True to draw an "ML" label above each via. */
  showMlLabel?: boolean;
  /** Fired whenever a tile loads (or the cache is cleared on model switch),
   *  with the sum of point + irregular vias currently held across every
   *  cached tile. Cardinal but partial — only counts what's been fetched so
   *  far in this session. */
  onCountChange?: (count: number) => void;
  /** Die image mirror (`DieAnnotations.imageFlip`). Predictions are in raw
   *  image space; they're mirrored as they load, so every query and id is in
   *  the shown space. The host calls `clearCache` when it changes. */
  getFlip?: () => ImageFlip | undefined;
}

/** A prediction mirrored from raw image space into the shown space. */
function flipPrediction(p: MLPrediction, flip: ImageFlip | undefined, size: ImageSize): MLPrediction {
  if (!isFlipped(flip)) return p;
  const pt = (x: number, y: number) => flipPoint({ x, y }, flip, size);
  const [x0, y0, x1, y1] = p.bbox;
  const box = flipRect({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, flip, size);
  return {
    ...p,
    pointVias: p.pointVias.map((v) => ({ ...v, ...pt(v.x, v.y) })),
    irregularVias: p.irregularVias.map((r) => {
      const b = flipRect({ x: r.bbox[0], y: r.bbox[1], width: r.bbox[2], height: r.bbox[3] }, flip, size);
      const c = pt(r.centroid[0], r.centroid[1]);
      return { ...r, bbox: [b.x, b.y, b.width, b.height], centroid: [c.x, c.y] };
    }),
    traces: p.traces.map((t) => ({
      points: t.points.map(([x, y]) => {
        const q = pt(x, y);
        return [q.x, q.y] as [number, number];
      })
    })),
    bbox: [box.x, box.y, box.x + box.width, box.y + box.height]
  };
}

export class MLViasLayer implements Layer {
  readonly id = "ml-vias";
  private readonly dieId: string;
  private readonly metadata: DieMetadata;
  private readonly cache = new Map<string, CachedViasTile>();
  /** Memoized trace-endpoint snap lookups (`"x:y"` → target or null). The
   *  lookup scans every cached via; without the memo it ran per endpoint
   *  per frame and lagged the canvas with thousands of cached detections.
   *  Cleared whenever tile data changes (loads, retry, clear). */
  private readonly snapCache = new Map<string, { x: number; y: number } | null>();
  /** Block keys (`${bx}/${by}`) already fetched — prevents re-requesting a
   *  block every frame. Cleared on `retryFailed()` (job-progress drives a
   *  refetch of unloaded tiles) and on `clearCache()` (model switch). */
  private readonly requestedBlocks = new Set<string>();
  /** In-flight fetch count + queue of pending block fetches. Caps how many
   *  `fetch()`es run concurrently so a zoomed-out view can't blow Chrome's
   *  per-origin socket pool. */
  private inflight = 0;
  private readonly fetchQueue: Array<() => void> = [];
  private invalidateCb: ((rect?: Rect) => void) | null = null;
  private readonly display: MLViasDisplay;
  private destroyed = false;
  /** Subset of `selectedIds` that target ML vias (`ml-via:x:y`). Kept here so
   *  draw() can paint the selection halo without walking the global set every
   *  via. Updated via `setSelectedIds`. */
  private selectedViaIds: ReadonlySet<string> = EMPTY_SET;

  constructor(dieId: string, metadata: DieMetadata, display: MLViasDisplay = {}) {
    this.dieId = dieId;
    this.metadata = metadata;
    this.display = display;
  }

  /** Drop in-flight requests' effects — once `destroyed`, late `.then` callbacks
   *  bail before mutating state. The host calls this when swapping layers.
   *  A subsequent `subscribe()` revives the layer (see there). */
  destroy(): void {
    this.destroyed = true;
    this.cache.clear();
    this.requestedBlocks.clear();
    this.fetchQueue.length = 0;
    this.notifyCountChange();
  }

  /** Update the selected-via set; invalidates so the new halos paint. Pass
   *  the *whole* selection — the layer filters down to its `ml-via:` entries
   *  on its own, so callers don't have to. */
  setSelectedIds(ids: ReadonlySet<string>): void {
    const next = new Set<string>();
    for (const id of ids) if (isMlViaId(id)) next.add(id);
    if (idSetsEqual(this.selectedViaIds, next)) return;
    this.selectedViaIds = next;
    this.invalidateCb?.();
  }

  /** Nearest ML via (point or irregular centroid) within `radius` of `world`,
   *  filtered by the confidence threshold. Returns `null` if nothing qualifies.
   *  Used by canvas hit-testing (select / double-click / right-click) so the
   *  user can target a via the same way they target a manual annotation. */
  hitTestVia(world: Point, radius: number): MLViaHit | null {
    const minScore = this.display.getConfidenceThreshold?.() ?? 0;
    let best: MLViaHit | null = null;
    let bestDistSq = radius * radius;
    for (const tile of this.cache.values()) {
      if (!tile.loaded || !tile.data) continue;
      for (const v of tile.data.pointVias) {
        if (v.score < minScore) continue;
        const dx = v.x - world.x;
        const dy = v.y - world.y;
        const d2 = dx * dx + dy * dy;
        if (d2 <= bestDistSq) {
          bestDistSq = d2;
          best = {
            id: mlViaId(v.x, v.y),
            x: v.x,
            y: v.y,
            score: v.score,
            kind: "point",
            viaLayer: v.viaLayer
          };
        }
      }
      for (const r of tile.data.irregularVias) {
        if (r.score < minScore) continue;
        const cx = r.centroid[0];
        const cy = r.centroid[1];
        const dx = cx - world.x;
        const dy = cy - world.y;
        const d2 = dx * dx + dy * dy;
        if (d2 <= bestDistSq) {
          bestDistSq = d2;
          best = {
            id: mlViaId(cx, cy),
            x: cx,
            y: cy,
            score: r.score,
            kind: "irregular",
            viaLayer: undefined
          };
        }
      }
    }
    return best;
  }

  /** Every ML via whose centre lies inside `worldRect`, filtered by the
   *  confidence threshold. Used by the marquee selection path. */
  queryViasInRect(worldRect: Rect): MLViaHit[] {
    const minScore = this.display.getConfidenceThreshold?.() ?? 0;
    const out: MLViaHit[] = [];
    for (const tile of this.cache.values()) {
      if (!tile.loaded || !tile.data) continue;
      for (const v of tile.data.pointVias) {
        if (v.score < minScore) continue;
        if (!pointInRect({ x: v.x, y: v.y }, worldRect)) continue;
        out.push({
          id: mlViaId(v.x, v.y),
          x: v.x,
          y: v.y,
          score: v.score,
          kind: "point"
        });
      }
      for (const r of tile.data.irregularVias) {
        if (r.score < minScore) continue;
        const cx = r.centroid[0];
        const cy = r.centroid[1];
        if (!pointInRect({ x: cx, y: cy }, worldRect)) continue;
        out.push({
          id: mlViaId(cx, cy),
          x: cx,
          y: cy,
          score: r.score,
          kind: "irregular"
        });
      }
    }
    return out;
  }

  /** Look up an ML via by its synthetic id (the one minted by `mlViaId`). The
   *  inspector calls this to resolve a selection into score + class without
   *  having to re-scan the layer itself. Returns `null` if no cached via lives
   *  at the encoded coords (e.g. the tile was evicted, or the model changed). */
  findViaById(id: string): MLViaHit | null {
    const coords = parseMlViaId(id);
    if (!coords) return null;
    const minScore = this.display.getConfidenceThreshold?.() ?? 0;
    for (const tile of this.cache.values()) {
      if (!tile.loaded || !tile.data) continue;
      for (const v of tile.data.pointVias) {
        if (v.score < minScore) continue;
        if (Math.round(v.x) !== coords.x || Math.round(v.y) !== coords.y) {
          continue;
        }
        return {
          id,
          x: v.x,
          y: v.y,
          score: v.score,
          kind: "point"
        };
      }
      for (const r of tile.data.irregularVias) {
        if (r.score < minScore) continue;
        const cx = r.centroid[0];
        const cy = r.centroid[1];
        if (Math.round(cx) !== coords.x || Math.round(cy) !== coords.y) {
          continue;
        }
        return {
          id,
          x: cx,
          y: cy,
          score: r.score,
          kind: "irregular"
        };
      }
    }
    return null;
  }

  /**
   * Find the cached point-via closest to `world` within `radius`, or null if
   * none qualifies. Used by the wire / multi-wire snap-to-vias path. Walks
   * every cached tile (across all levels) — point counts per die are small
   * enough that this is well below a millisecond at typical sizes; spatial
   * indexing can come later if profiles say so. Considers irregular-via
   * centroids too so the snap target set matches what the user sees.
   */
  findNearestPointVia(world: Point, radius: number): Point | null {
    const minScore = this.display.getConfidenceThreshold?.() ?? 0;
    let best: Point | null = null;
    let bestDistSq = radius * radius;
    for (const tile of this.cache.values()) {
      if (!tile.loaded || !tile.data) continue;
      for (const v of tile.data.pointVias) {
        if (v.score < minScore) continue;
        const dx = v.x - world.x;
        const dy = v.y - world.y;
        const d2 = dx * dx + dy * dy;
        if (d2 <= bestDistSq) {
          bestDistSq = d2;
          best = { x: v.x, y: v.y };
        }
      }
      for (const r of tile.data.irregularVias) {
        if (r.score < minScore) continue;
        const cx = r.centroid[0];
        const cy = r.centroid[1];
        const dx = cx - world.x;
        const dy = cy - world.y;
        const d2 = dx * dx + dy * dy;
        if (d2 <= bestDistSq) {
          bestDistSq = d2;
          best = { x: cx, y: cy };
        }
      }
    }
    return best;
  }

  /**
   * Find the first cached ML via lying on the open segment `a`–`b` whose
   * perpendicular distance from that segment is ≤ `perpTol`. "First" = the via
   * whose foot of perpendicular is closest to `a`, so the wire stops at the
   * earliest via along its projected path. Considers both point and irregular
   * (centroid) vias, filtered by the same confidence threshold as
   * `findNearestPointVia`. Returns null when nothing qualifies.
   */
  findPointViaOnSegment(a: Point, b: Point, perpTol: number): Point | null {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return null;
    const minScore = this.display.getConfidenceThreshold?.() ?? 0;
    const perpSq = perpTol * perpTol;
    let best: Point | null = null;
    let bestT = Infinity;
    const consider = (cx: number, cy: number) => {
      const t = ((cx - a.x) * dx + (cy - a.y) * dy) / lenSq;
      if (t <= 0 || t >= 1) return;
      const fx = a.x + t * dx;
      const fy = a.y + t * dy;
      const px = cx - fx;
      const py = cy - fy;
      if (px * px + py * py > perpSq) return;
      if (t < bestT) {
        bestT = t;
        best = { x: cx, y: cy };
      }
    };
    for (const tile of this.cache.values()) {
      if (!tile.loaded || !tile.data) continue;
      for (const v of tile.data.pointVias) {
        if (v.score < minScore) continue;
        consider(v.x, v.y);
      }
      for (const r of tile.data.irregularVias) {
        if (r.score < minScore) continue;
        consider(r.centroid[0], r.centroid[1]);
      }
    }
    return best;
  }

  /**
   * Re-run the via count and force a redraw. The host calls this when the
   * confidence threshold preference changes — the cached tile data is still
   * valid, only the score filter moved.
   */
  recountAndRedraw(): void {
    this.notifyCountChange();
    this.invalidateCb?.();
  }

  /**
   * Drop every cached tile (without destroying the layer). Used when the
   * sidecar's checkpoint changes — a model switch or retrain — so the stale
   * predictions are re-fetched against the new model.
   */
  clearCache(): void {
    this.cache.clear();
    this.requestedBlocks.clear();
    this.snapCache.clear();
    this.fetchQueue.length = 0;
    this.notifyCountChange();
    this.invalidateCb?.();
  }

  /**
   * Every decoded trace polyline held in the cache, deduplicated. A trace
   * crossing tile borders overlaps several keep-boxes, so the backend
   * repeats the full polyline in each — dedupe by the rounded point
   * sequence (decodes emit integer coordinates, identical across repeats).
   * Used by the traces→nets materialization.
   */
  collectTraces(): MLTracePolyline[] {
    const seen = new Set<string>();
    const out: MLTracePolyline[] = [];
    for (const tile of this.cache.values()) {
      if (!tile.loaded || !tile.data) continue;
      for (const t of tile.data.traces) {
        const key = t.points.map((p) => `${Math.round(p[0])},${Math.round(p[1])}`).join(";");
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(t);
      }
    }
    return out;
  }

  /**
   * Drop tiles that didn't yield a result so their block is re-fetched on the
   * next draw. "Failed" here covers both genuine errors and the common case
   * of a tile the inference job hasn't computed yet. The host calls this as
   * the job advances, so the overlay fills in progressively as tiles land.
   */
  retryFailed(): void {
    let dropped = false;
    for (const [key, tile] of this.cache) {
      if (tile.failed) {
        this.cache.delete(key);
        this.requestedBlocks.delete(blockKey(tile.x, tile.y));
        dropped = true;
      }
    }
    if (dropped) this.invalidateCb?.();
  }

  subscribe(invalidate: (worldRect?: Rect) => void): () => void {
    // A renderer adopting this layer "revives" it. React StrictMode mounts
    // effects setup→cleanup→setup, so the host's `[layer]` cleanup can fire
    // `destroy()` once before the layer is ever used; without this the layer
    // would stay permanently destroyed and never paint (manifests as "vias
    // load on refresh but not on SPA navigation", since on refresh the layer
    // doesn't exist yet at mount and dodges the spurious destroy).
    this.destroyed = false;
    this.invalidateCb = invalidate;
    return () => {
      this.invalidateCb = null;
    };
  }

  draw(ctx: CanvasRenderingContext2D, bounds: TileBounds): void {
    // Vias and traces hide independently: bail out only when BOTH overlays
    // are off (fetches below run for whichever is still visible).
    const viasHidden = this.display.getHidden?.() ?? false;
    const tracesHidden = this.display.getTracesHidden?.() ?? false;
    if (viasHidden && tracesHidden) return;
    const { world, zoom } = bounds;
    const flip = this.display.getFlip?.();
    // Tiles are addressed in raw image space.
    const rawWorld = flipRect(world, flip, this.metadata);

    // ── Kick off any missing tile fetches ─────────────────────────────
    // Predictions only exist at the native (full-resolution) level — the
    // backend returns empty payloads for every coarser level. So we always
    // fetch *native* tiles for the viewport, regardless of the current
    // zoom. That way a die whose tiles were pre-computed by the inference
    // job shows its vias immediately, even when zoomed out — the user no
    // longer has to zoom in to the native level to trigger the fetch.
    // (Drawing is cross-level below; vias are in source-px coords.)
    const nativeZ = this.metadata.maxZoomLevel;
    const levelMeta = this.metadata.levels[nativeZ];
    if (levelMeta) {
      const tileWorldSize = this.metadata.tileSize * levelMeta.scale;
      const minTx = Math.max(0, Math.floor(rawWorld.x / tileWorldSize));
      const minTy = Math.max(0, Math.floor(rawWorld.y / tileWorldSize));
      const maxTx = Math.min(
        levelMeta.columns - 1,
        Math.floor((rawWorld.x + rawWorld.width - 1e-6) / tileWorldSize)
      );
      const maxTy = Math.min(
        levelMeta.rows - 1,
        Math.floor((rawWorld.y + rawWorld.height - 1e-6) / tileWorldSize)
      );
      // Guard against a flood when zoomed so far out the viewport covers a
      // huge slab of native tiles — at that scale the vias are sub-pixel
      // specks anyway, so skipping the fetch loses nothing visible.
      const span = (maxTx - minTx + 1) * (maxTy - minTy + 1);
      if (span > 0 && span <= MAX_VIEWPORT_FETCH) {
        // Fetch by BLOCK×BLOCK block — one batched request per block, not
        // one per tile. Already-requested blocks are skipped.
        const minBx = Math.floor(minTx / BLOCK);
        const maxBx = Math.floor(maxTx / BLOCK);
        const minBy = Math.floor(minTy / BLOCK);
        const maxBy = Math.floor(maxTy / BLOCK);
        for (let bx = minBx; bx <= maxBx; bx++) {
          for (let by = minBy; by <= maxBy; by++) {
            const bkey = `${bx}/${by}`;
            if (this.requestedBlocks.has(bkey)) continue;
            this.requestedBlocks.add(bkey);
            this.fetchBlock(nativeZ, bx, by, levelMeta.columns, levelMeta.rows);
          }
        }
      }
    }

    // ── Draw vias from every cached tile that overlaps the view ────────
    // — irrespective of which level it came from. Vias are stored in
    // source-px coords so a finer-level tile loaded at high zoom stays
    // valid (and visible) when the user zooms back out, even though the
    // backend returns empty payloads for non-native coarse-level
    // requests at low zoom.
    const minScore = this.display.getConfidenceThreshold?.() ?? 0;
    const worldR = this.display.getViaWorldRadius?.() ?? VIA_DEFAULT_SIZE;
    // Clamp to a sensible CSS-px range so vias remain visible without
    // dominating at extreme zooms (mirrors `netScreenWidth`). Divide back to
    // world units for ctx.arc — the canvas is in world coords.
    const pointR = viaScreenRadius(zoom, worldR) / zoom;
    const stroke = IRREGULAR_STROKE_PX / zoom;
    for (const tile of this.cache.values()) {
      const lvl = this.metadata.levels[tile.z];
      if (!lvl) continue;
      const tws = this.metadata.tileSize * lvl.scale;
      const tileRect: Rect = {
        x: tile.x * tws,
        y: tile.y * tws,
        width: tws,
        height: tws
      };
      if (!rectsIntersect(tileRect, rawWorld)) continue;
      if (!tile.loaded || !tile.data) continue;
      const { pointVias, irregularVias, traces } = tile.data;
      const sel = this.selectedViaIds;
      const hasSel = sel.size > 0;
      const selectR = pointR * SELECT_NODE_MULT;
      const selectStroke = SELECT_OUTLINE_PX / zoom;
      const viaColor = this.display.getViaColor?.() ?? VIA_DEFAULT_COLOR;
      const showLabel = this.display.showMlLabel;
      // Point vias: small filled circles. Colour follows the user pref
      // (same as the human via annotation style). Selected ones use the
      // shared SELECT_COLOR + white ring for parity with the manual via
      // annotation drawing path (see dieAnnotations.ts).
      for (const v of viasHidden ? [] : pointVias) {
        if (v.score < minScore) continue;
        const selected = hasSel && sel.has(mlViaId(v.x, v.y));
        // Determine colour: via layer override > default via color
        const layerColor = v.viaLayer && this.display.getViaLayerColor?.(v.viaLayer);
        ctx.fillStyle = selected ? SELECT_COLOR : (layerColor ?? viaColor);
        const r = selected ? selectR : pointR;
        ctx.beginPath();
        ctx.arc(v.x, v.y, r, 0, Math.PI * 2);
        ctx.fill();
        if (selected) {
          ctx.strokeStyle = SELECT_RING;
          ctx.lineWidth = selectStroke;
          ctx.beginPath();
          ctx.arc(v.x, v.y, r, 0, Math.PI * 2);
          ctx.stroke();
        }
        // ML label
        if (showLabel && !selected) {
          ctx.fillStyle = "rgba(255,255,255,0.6)";
          ctx.font = `${Math.max(8, Math.round(8 / zoom))}px sans-serif`;
          ctx.textAlign = "center";
          ctx.fillText("ML", v.x, v.y - r - 2 / zoom);
        }
      }
      // Irregular vias: bbox outline + translucent fill (selected: orange).
      for (const reg of viasHidden ? [] : irregularVias) {
        if (reg.score < minScore) continue;
        const [x, y, w, h] = reg.bbox;
        const cx = reg.centroid[0];
        const cy = reg.centroid[1];
        const selected = hasSel && sel.has(mlViaId(cx, cy));
        const viaFill = viaColorWithAlpha(viaColor, 0.25);
        ctx.fillStyle = selected ? SELECT_FILL : viaFill;
        ctx.strokeStyle = selected ? SELECT_COLOR : viaColor;
        ctx.lineWidth = selected ? selectStroke : stroke;
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x, y, w, h);
      }
      // ML traces (v2 decode): skeleton centreline polylines of the model's
      // trace channel — thin lines whose ENDS are meaningful coordinates.
      // Each end snaps to the nearest ML via (layer's own cache) or device
      // contact / cell terminal / IO pin (via `findSnapTarget`); the snap
      // draws a short connector + ring so the user sees the proposed
      // connection without mutating any data. Toggleable independently of
      // the vias via `getTracesHidden`.
      if (!this.display.getTracesHidden?.()) {
        const minTraceScore = this.display.getTraceConfidenceThreshold?.() ?? 0;
        const snapTol = Math.max(8, worldR * 2);
        ctx.lineWidth = stroke;
        for (const t of traces) {
          if ((t.score ?? 1) < minTraceScore) continue;
          const pts = t.points;
          if (pts.length < 2) continue;
          ctx.beginPath();
          ctx.moveTo(pts[0][0], pts[0][1]);
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
          ctx.strokeStyle = ML_TRACE_STROKE;
          ctx.stroke();
      // Endpoint snapping: ML via first (this layer's cache), then the
      // wire tool's contact/terminal/pin candidates. Results are memoized
      // per endpoint coordinate — the lookup scans every cached via, and
      // doing that per frame was the trace-overlay lag.
      for (const end of [pts[0], pts[pts.length - 1]]) {
        const key = `${end[0]}:${end[1]}`;
        let target = this.snapCache.get(key);
        if (target === undefined) {
          const viaHit = this.findNearestPointVia({ x: end[0], y: end[1] }, snapTol);
          target = viaHit ?? this.display.findSnapTarget?.({ x: end[0], y: end[1] }, snapTol) ?? null;
          this.snapCache.set(key, target);
        }
        if (!target) continue;
        ctx.beginPath();
        ctx.moveTo(end[0], end[1]);
        ctx.lineTo(target.x, target.y);
        ctx.strokeStyle = ML_TRACE_SNAP_STROKE;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(target.x, target.y, Math.max(pointR, 3 / zoom), 0, Math.PI * 2);
        ctx.strokeStyle = ML_TRACE_SNAP_STROKE;
        ctx.stroke();
      }
        }
      }
    }
  }

  /**
   * Fetch one BLOCK×BLOCK block of native tiles in a single batched request.
   * Placeholder cache entries are created up-front so the draw pass treats
   * the block as in-flight; the response fills them in. Tiles the server
   * has no cached prediction for are marked `failed` (the overlay is
   * display-only — it never triggers inference).
   */
  private fetchBlock(
    z: number,
    bx: number,
    by: number,
    columns: number,
    rows: number
  ): void {
    const tx0 = bx * BLOCK;
    const ty0 = by * BLOCK;
    const tx1 = Math.min(tx0 + BLOCK - 1, columns - 1);
    const ty1 = Math.min(ty0 + BLOCK - 1, rows - 1);
    if (tx0 > tx1 || ty0 > ty1) return;

    const levelMeta = this.metadata.levels[z];
    const tws = this.metadata.tileSize * levelMeta.scale;

    // Placeholder entries for the whole block — so the draw pass sees them
    // as in-flight and a second fetch isn't kicked off mid-flight.
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) {
        const key = `${z}/${tx}/${ty}`;
        if (!this.cache.has(key)) {
          this.cache.set(key, {
            z,
            x: tx,
            y: ty,
            data: null,
            loaded: false,
            failed: false
          });
        }
      }
    }

    const url =
      `/api/dies/${this.dieId}/vias/tiles` +
      `?z=${z}&x0=${tx0}&y0=${ty0}&x1=${tx1}&y1=${ty1}`;

    const markPendingFailed = () => {
      for (let tx = tx0; tx <= tx1; tx++) {
        for (let ty = ty0; ty <= ty1; ty++) {
          const entry = this.cache.get(`${z}/${tx}/${ty}`);
          if (entry && !entry.loaded) entry.failed = true;
        }
      }
    };

    const run = () => {
      this.inflight += 1;
      fetch(url)
        .then(async (r) => {
          if (this.destroyed) return;
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const body = (await r.json()) as MLViasTilesResponse;
          if (this.destroyed) return;
          const returned = new Set<string>();
          for (const t of body.tiles) {
            const key = `${z}/${t.x}/${t.y}`;
            const entry = this.cache.get(key);
            if (!entry) continue; // evicted while in flight
            entry.data = flipPrediction(t.prediction, this.display.getFlip?.(), this.metadata);
            entry.loaded = true;
            entry.failed = false;
            returned.add(key);
          }
          this.snapCache.clear(); // new geometry → re-resolve trace snaps
          // Block tiles with no cached prediction → failed, so a later
          // `retryFailed` (fired as the inference job advances) re-fetches.
          for (let tx = tx0; tx <= tx1; tx++) {
            for (let ty = ty0; ty <= ty1; ty++) {
              const key = `${z}/${tx}/${ty}`;
              if (returned.has(key)) continue;
              const entry = this.cache.get(key);
              if (entry && !entry.loaded) entry.failed = true;
            }
          }
          this.invalidateCb?.({
            x: tx0 * tws,
            y: ty0 * tws,
            width: (tx1 - tx0 + 1) * tws,
            height: (ty1 - ty0 + 1) * tws
          });
          this.notifyCountChange();
        })
        .catch(() => {
          if (this.destroyed) return;
          markPendingFailed();
          // Network / 5xx blip → drop the block so the next draw retries it.
          // (Successful "tile not cached" responses leave it in place; only
          // `retryFailed`, driven by inference-job progress, refetches those.)
          this.requestedBlocks.delete(`${bx}/${by}`);
        })
        .finally(() => {
          this.inflight -= 1;
          const next = this.fetchQueue.shift();
          if (next) next();
        });
    };

    if (this.inflight < MAX_INFLIGHT_FETCHES) run();
    else this.fetchQueue.push(run);
  }

  private notifyCountChange() {
    if (!this.display.onCountChange) return;
    const minScore = this.display.getConfidenceThreshold?.() ?? 0;
    let count = 0;
    for (const tile of this.cache.values()) {
      if (!tile.loaded || !tile.data) continue;
      for (const v of tile.data.pointVias) {
        if (v.score >= minScore) count += 1;
      }
      for (const r of tile.data.irregularVias) {
        if (r.score >= minScore) count += 1;
      }
    }
    this.display.onCountChange(count);
  }
}
