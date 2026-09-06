import RBush from "rbush";
import { pointInRectTolerant, type Rect } from "../../lib/geometry";
import type { Layer, TileBounds } from "../types";

/** Sentinel `layerFilter` value selecting net edges with no `layer` set. */
export const UNTAGGED_LAYER = "__untagged__";

/** Per-annotation render state passed into `draw`. */
export interface AnnotationDrawState {
  /** True if this annotation's own id is in the selection set. When true the
   *  whole annotation should render selected (overrides sub-part state). */
  selected: boolean;
  /** Membership test against the full selection set. Annotations with
   *  selectable sub-parts (e.g. net vertices/segments) use this to highlight
   *  individual parts by their sub-id. */
  isSelected: (id: string) => boolean;
  /** When set, only draw edges belonging to this conductor layer
   *  (e.g. "metal1", "metal2"). Used by the AnnotationLayer for z-ordered
   *  multi-pass rendering: it draws all metal1 edges from all net
   *  annotations in one pass, then all metal2 edges on top.
   *  `UNTAGGED_LAYER` selects edges with no `layer` at all — legacy wires
   *  (e.g. imported from a tool version that predates per-edge layer
   *  stamping) that would otherwise never match any pass and stay
   *  invisible forever. */
  layerFilter?: string;
  /** Render pass for vias: "body" = shape only (drawn before nets),
   *  "label" = text only (drawn after nets). */
  pass?: "body" | "label";
}

/** Result of a successful point-pick. */
export interface AnnotationHit {
  annotation: Annotation;
  /** Selection id for the specific thing hit. Equals `annotation.id` for
   *  whole-element kinds; a sub-id (e.g. `net:x/edge:y`) for composite ones. */
  partId: string;
}

/**
 * Spatially-indexed annotation. Implementations supply a world-space bbox
 * (for tile-invalidation and culling), a `kind` for visibility filtering, and
 * a draw routine.
 *
 * Hit-test methods are optional — if omitted, the layer falls back to bbox
 * containment / intersection. Implement them when the bbox is a loose fit
 * (polygons, polyline nets, circles) for accurate picking.
 */
export interface Annotation {
  id: string;
  /** High-level grouping for visibility toggles (e.g. "net", "cell", "via"). */
  kind: string;
  bbox: Rect;
  /**
   * Point-pick precedence. Higher wins regardless of bbox size, so foreground
   * geometry (wires, vertices) beats large container-like annotations (cells)
   * even when the container's bbox is smaller. Ties break by smallest bbox.
   * Defaults to 0 when omitted.
   */
  pickPriority?: number;
  /**
   * Visual z-order within the same tile. Higher values are drawn later (on
   * top). Defaults to 0 when omitted. Nets encode a composite
   * (min_layer, max_layer) key packed as `min*100 + max` so that:
   *   - metal1-only (2,2) → 202 draws before metal2-only (3,3) → 303
   *   - metal1+metal2 (2,3) → 203 draws AFTER metal1-only (202) but BEFORE
   *     metal2-only (303) — its metal2 edges correctly hide below pure m2.
   */
  drawOrder?: number;
  draw(ctx: CanvasRenderingContext2D, bounds: TileBounds, state: AnnotationDrawState): void;
  /**
   * Narrow-phase point-pick. `worldTolerance` is the click slop in world
   * units. Returns the selection id of the hit part (the annotation's own id,
   * or a sub-id for composite annotations), or `null` for a miss.
   */
  hitTest?(worldPoint: { x: number; y: number }, worldTolerance: number): string | null;
  /** Narrow-phase rect-pick (marquee). */
  intersectsRect?(worldRect: Rect): boolean;
}

interface IndexEntry {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  annotation: Annotation;
}

class AnnotationIndex extends RBush<IndexEntry> {
  toBBox(item: IndexEntry) {
    return item;
  }
  compareMinX(a: IndexEntry, b: IndexEntry) {
    return a.minX - b.minX;
  }
  compareMinY(a: IndexEntry, b: IndexEntry) {
    return a.minY - b.minY;
  }
}

/**
 * Generic annotation layer backed by an rbush spatial index. Add/remove/update
 * annotations through the layer's mutation methods; the renderer is notified
 * with the affected world rect so only the impacted screen tiles redraw.
 */
export class AnnotationLayer implements Layer {
  readonly id: string;
  private readonly index = new AnnotationIndex();
  private readonly entries = new Map<string, IndexEntry>();
  private invalidateCb: ((rect?: Rect) => void) | null = null;
  /** When non-null, only annotations whose `kind` is in this set are drawn. */
  private visibleKinds: Set<string> | null = null;
  /** Set of currently-selected annotation ids. Passed into `draw` per item. */
  private selectedIds: ReadonlySet<string> = EMPTY_SET;
  /** Last zoom a tile drew at — used to convert the screen-px bleed pad to a
   *  world margin for invalidation (a redraw always follows at this zoom). */
  private lastZoom = 1;

  constructor(id = "annotations") {
    this.id = id;
  }

  /** Pass `null` to show all kinds. Otherwise only matching kinds render. */
  setVisibleKinds(kinds: Set<string> | null): void {
    this.visibleKinds = kinds;
    this.invalidateCb?.();
  }

  /** Update the selected set; invalidates so highlight changes redraw. */
  setSelectedIds(ids: ReadonlySet<string>): void {
    if (idSetsEqual(this.selectedIds, ids)) return;
    this.selectedIds = ids;
    this.invalidateCb?.();
  }

  subscribe(invalidate: (worldRect?: Rect) => void): () => void {
    this.invalidateCb = invalidate;
    return () => {
      this.invalidateCb = null;
    };
  }

  add(annotation: Annotation): void {
    if (this.entries.has(annotation.id)) {
      this.update(annotation);
      return;
    }
    const entry = toIndexEntry(annotation);
    this.entries.set(annotation.id, entry);
    this.index.insert(entry);
    this.invalidateCb?.(this.bleed(annotation.bbox));
  }

  remove(annotationId: string): void {
    const entry = this.entries.get(annotationId);
    if (!entry) return;
    this.entries.delete(annotationId);
    this.index.remove(entry, (a, b) => a.annotation.id === b.annotation.id);
    this.invalidateCb?.(this.bleed(entry.annotation.bbox));
  }

  update(annotation: Annotation): void {
    const prev = this.entries.get(annotation.id);
    if (prev) {
      this.index.remove(prev, (a, b) => a.annotation.id === b.annotation.id);
      this.invalidateCb?.(this.bleed(prev.annotation.bbox));
    }
    const entry = toIndexEntry(annotation);
    this.entries.set(annotation.id, entry);
    this.index.insert(entry);
    this.invalidateCb?.(this.bleed(annotation.bbox));
  }

  /** Grow a world rect by the draw-bleed margin (so edits near a tile seam
   *  also redraw the neighbour the bleed paints into). */
  private bleed(r: Rect): Rect {
    const m = ANNOTATION_BLEED_PX / this.lastZoom;
    return {
      x: r.x - m,
      y: r.y - m,
      width: r.width + 2 * m,
      height: r.height + 2 * m
    };
  }

  clear(): void {
    this.index.clear();
    this.entries.clear();
    this.invalidateCb?.();
  }

  /** Union of the bounding boxes of the given annotation ids (world coords).
   *  Ids that aren't present are skipped; returns null if none matched. Used
   *  to frame a selection / outline row in the viewport. */
  unionBBox(ids: Iterable<string>): Rect | null {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const id of ids) {
      const e = this.entries.get(id);
      if (!e) continue;
      if (e.minX < minX) minX = e.minX;
      if (e.minY < minY) minY = e.minY;
      if (e.maxX > maxX) maxX = e.maxX;
      if (e.maxY > maxY) maxY = e.maxY;
    }
    if (!isFinite(minX)) return null;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  /** Returns annotations whose bbox overlaps `worldRect`. Broad phase only. */
  search(worldRect: Rect): Annotation[] {
    const hits = this.index.search({
      minX: worldRect.x,
      minY: worldRect.y,
      maxX: worldRect.x + worldRect.width,
      maxY: worldRect.y + worldRect.height
    });
    return hits.map((h) => h.annotation);
  }

  /**
   * Point pick. Broad-phase via rbush with `worldTolerance` slop, narrow-phase
   * via each annotation's `hitTest` (falls back to bbox containment). Visibility
   * filter is respected. Returns the smallest-bbox candidate so small things on
   * top of large things (e.g. a via on a cell) win.
   */
  hitTest(worldPoint: { x: number; y: number }, worldTolerance: number): AnnotationHit | null {
    const candidates = this.index.search({
      minX: worldPoint.x - worldTolerance,
      minY: worldPoint.y - worldTolerance,
      maxX: worldPoint.x + worldTolerance,
      maxY: worldPoint.y + worldTolerance
    });
    const visible = this.visibleKinds;
    let best: AnnotationHit | null = null;
    let bestPriority = -Infinity;
    let bestArea = Infinity;
    for (const c of candidates) {
      const a = c.annotation;
      if (visible && !visible.has(a.kind)) continue;
      const partId = a.hitTest
        ? a.hitTest(worldPoint, worldTolerance)
        : pointInRectTolerant(worldPoint, a.bbox, worldTolerance)
          ? a.id
          : null;
      if (partId === null) continue;
      const priority = a.pickPriority ?? 0;
      const area = Math.max(a.bbox.width, 1) * Math.max(a.bbox.height, 1);
      // Higher priority always wins; within a priority, smaller bbox wins.
      if (
        priority > bestPriority ||
        (priority === bestPriority && area < bestArea)
      ) {
        best = { annotation: a, partId };
        bestPriority = priority;
        bestArea = area;
      }
    }
    return best;
  }

  /**
   * Rect pick (marquee). Broad phase via rbush, narrow phase via each
   * annotation's `intersectsRect` (falls back to bbox overlap). Visibility
   * filter is respected.
   */
  queryRect(worldRect: Rect): Annotation[] {
    const candidates = this.index.search({
      minX: worldRect.x,
      minY: worldRect.y,
      maxX: worldRect.x + worldRect.width,
      maxY: worldRect.y + worldRect.height
    });
    const visible = this.visibleKinds;
    const out: Annotation[] = [];
    for (const c of candidates) {
      const a = c.annotation;
      if (visible && !visible.has(a.kind)) continue;
      const hit = a.intersectsRect ? a.intersectsRect(worldRect) : true; // bbox already overlapped
      if (hit) out.push(a);
    }
    return out;
  }

  draw(ctx: CanvasRenderingContext2D, bounds: TileBounds): void {
    this.lastZoom = bounds.zoom;
    // Pad the cull rect by the max screen-px an annotation can paint beyond
    // its geometric bbox (converted to world via this tile's zoom), so items
    // straddling a tile seam still draw into the neighbouring tile. Drawing
    // is naturally clipped to each tile's own canvas, so over-selection here
    // is free of artifacts.
    const m = ANNOTATION_BLEED_PX / bounds.zoom;
    const hits = this.index.search({
      minX: bounds.world.x - m,
      minY: bounds.world.y - m,
      maxX: bounds.world.x + bounds.world.width + m,
      maxY: bounds.world.y + bounds.world.height + m
    });
    const visible = this.visibleKinds;
    const selected = this.selectedIds;
    const isSelected = (id: string) => selected.has(id);
    const state: AnnotationDrawState = { selected: false, isSelected };

    // Separate hits: non-nets (cells, pins, rois, ignores), vias, and nets.
    const nonNets: typeof hits = [];
    const nets: typeof hits = [];
    const vias: typeof hits = [];
    for (const h of hits) {
      if (h.annotation.kind === "net") nets.push(h);
      else if (h.annotation.kind === "via") vias.push(h);
      else nonNets.push(h);
    }

    // Non-nets (cells, pins, etc.) — draw in drawOrder.
    nonNets.sort((a, b) => (a.annotation.drawOrder ?? 0) - (b.annotation.drawOrder ?? 0));
    for (const h of nonNets) {
      if (visible && !visible.has(h.annotation.kind)) continue;
      state.selected = selected.has(h.annotation.id);
      h.annotation.draw(ctx, bounds, state);
    }

    // Vias — body only (fill/stroke, no labels)
    const viaBodyState: AnnotationDrawState = { ...state, pass: "body" };
    for (const h of vias) {
      if (visible && !visible.has(h.annotation.kind)) continue;
      viaBodyState.selected = selected.has(h.annotation.id);
      h.annotation.draw(ctx, bounds, viaBodyState);
    }

    // Nets — multi-pass by conductor layer: untagged → metal1 → metal2 →
    // metal3+. This guarantees ALL metal1 edges from ALL nets draw underneath
    // ALL metal2 edges, regardless of per-net drawOrder. The untagged pass
    // goes first (drawn like an underlay) so legacy edges with no `layer`
    // still render instead of silently vanishing.
    const LAYER_PASSES = [UNTAGGED_LAYER, "metal1", "metal2", "poly", "metal3", "metal4", "metal5", "metal6"];
    for (const layer of LAYER_PASSES) {
      const layerState: AnnotationDrawState = { ...state, layerFilter: layer };
      for (const h of nets) {
        if (visible && !visible.has(h.annotation.kind)) continue;
        layerState.selected = selected.has(h.annotation.id);
        h.annotation.draw(ctx, bounds, layerState);
      }
    }

    // Via labels — on top of everything (nets + via bodies).
    const viaLabelState: AnnotationDrawState = { ...state, pass: "label" };
    for (const h of vias) {
      if (visible && !visible.has(h.annotation.kind)) continue;
      viaLabelState.selected = selected.has(h.annotation.id);
      h.annotation.draw(ctx, bounds, viaLabelState);
    }
  }
}

/**
 * An annotation's `bbox` is its *geometric* extent (node/rect coords). What it
 * actually paints can spill well past that: stroke half-width, and especially a
 * selected net vertex disc — `netNodeScreenRadius` ≈ `NET_MAX_SCREEN_PX(32) ·
 * 1.6 · 1.4` ≈ 72 screen px — plus selection outlines. Because `netScreenWidth`
 * is clamped to a screen-px ceiling, this spill is bounded in *screen* px
 * regardless of zoom, so a fixed screen-px pad (converted to world via the
 * tile's zoom) exactly covers it. Generous on purpose: over-inclusion only
 * costs drawing a few extra (canvas-clipped) items per tile / dirtying an
 * extra ring of tiles on edit — never a visual artifact. Without it, anything
 * sitting on a tile seam renders on only one side of the seam.
 */
const ANNOTATION_BLEED_PX = 80;

const EMPTY_SET: ReadonlySet<string> = new Set();

function idSetsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

function toIndexEntry(annotation: Annotation): IndexEntry {
  return {
    minX: annotation.bbox.x,
    minY: annotation.bbox.y,
    maxX: annotation.bbox.x + annotation.bbox.width,
    maxY: annotation.bbox.y + annotation.bbox.height,
    annotation
  };
}
