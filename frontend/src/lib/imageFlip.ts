import type { Cell, DieAnnotations, Geometry, Guide, ImageFlip } from "shared";
import { cellWorldRect } from "./cellFootprint";
import { mapLayerPoints, mirrorAbout } from "./cellLayers";
import type { Point, Rect } from "./geometry";
import { orientOf, orientOnDie } from "./mergeCells";

/**
 * Display-only mirror of the die image (`DieAnnotations.imageFlip`).
 *
 * The image tiles stay in raw image space; what's shown is that image
 * mirrored about its centre. Annotations live in the shown (mirrored)
 * space, so flipping the image means mirroring every annotation once, which
 * keeps them on the features they mark. Text is drawn by the annotations
 * themselves, upright, at their new positions; it is never mirrored.
 */

export type FlipAxis = "h" | "v";

export interface ImageSize {
  width: number;
  height: number;
}

export function isFlipped(flip: ImageFlip | undefined): boolean {
  return !!flip && (flip.h === true || flip.v === true);
}

/** `rect` mirrored by `flip` about the centre of a `size` image. Its own inverse. */
export function flipRect(rect: Rect, flip: ImageFlip | undefined, size: ImageSize): Rect {
  return {
    x: flip?.h ? size.width - rect.x - rect.width : rect.x,
    y: flip?.v ? size.height - rect.y - rect.height : rect.y,
    width: rect.width,
    height: rect.height
  };
}

/** `p` mirrored by `flip` about the centre of a `size` image. Its own inverse. */
export function flipPoint(p: Point, flip: ImageFlip | undefined, size: ImageSize): Point {
  return {
    x: flip?.h ? size.width - p.x : p.x,
    y: flip?.v ? size.height - p.y : p.y
  };
}

/** Type box sizes (`cropRect` width × height) by cell type id, for the
 *  types this die's cells use, foreign library types included. */
export type CellTypeSizes = Record<string, { w: number; h: number }>;

export function cellTypeSizes(ann: DieAnnotations): CellTypeSizes {
  const out: CellTypeSizes = {};
  for (const ct of ann.cellTypes) out[ct.id] = { w: ct.cropRect.width, h: ct.cropRect.height };
  return out;
}

/**
 * Every annotation mirrored on `axis` about the centre of a `size` image,
 * and `imageFlip` toggled on that axis. Applying it twice gives back the
 * input, so the same call is its own undo.
 *
 * Cell types are untouched: their shapes are in the type frame, and their
 * `cropRect` points at the template in the raw image the server crops from.
 * Each cell instead gets the mirrored orientation (`orientOnDie`) and moves
 * so its footprint lands mirrored.
 */
export function flipAnnotations(
  ann: DieAnnotations,
  axis: FlipAxis,
  size: ImageSize,
  typeSizes: CellTypeSizes
): DieAnnotations {
  const m = mirrorAbout({ x: size.width / 2, y: size.height / 2 }, axis);
  const rect = <T extends Rect>(r: T): T => ({ ...r, ...flipRect(r, { [axis]: true }, size) });
  const pts = (ps: Point[]) => ps.map((p) => m(p));

  const flipCell = (cell: Cell): Cell => {
    const t = typeSizes[cell.cellTypeId] ?? { w: 0, h: 0 };
    const before = cellWorldRect(cell, t.w, t.h);
    const o = orientOnDie(orientOf(cell), axis === "h" ? "flipH" : "flipV");
    const next: Cell = { ...cell, flippedH: o.flippedH, flippedV: o.flippedV, rotation: o.rotation };
    // Footprint offset from the origin under the new orientation.
    const at = cellWorldRect({ ...next, x: 0, y: 0 }, t.w, t.h);
    const target = flipRect(before, { [axis]: true }, size);
    next.x = target.x - at.x;
    next.y = target.y - at.y;
    if (!next.flippedH) delete next.flippedH;
    if (!next.flippedV) delete next.flippedV;
    if (!next.rotation) delete next.rotation;
    return next;
  };

  const flipGeometry = (g: Geometry): Geometry => {
    switch (g.kind) {
      case "point":
        return { ...g, ...m(g) };
      case "rectangle":
        return rect(g);
      case "polyline":
      case "polygon":
        return { ...g, points: pts(g.points) };
    }
  };

  const flipGuide = (g: Guide): Guide => {
    if (g.kind === "line") {
      if (g.axis === "x" && axis === "h") return { ...g, pos: size.width - g.pos };
      if (g.axis === "y" && axis === "v") return { ...g, pos: size.height - g.pos };
      return g;
    }
    const a = m({ x: g.x1, y: g.y1 });
    const b = m({ x: g.x2, y: g.y2 });
    return { ...g, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  };

  const flip: ImageFlip = { ...ann.imageFlip, [axis]: !ann.imageFlip?.[axis] };
  const out: DieAnnotations = {
    ...ann,
    nets: ann.nets.map((n) => ({ ...n, nodes: n.nodes.map((node) => ({ ...node, ...m(node) })) })),
    cells: ann.cells.map(flipCell),
    grids:
      axis === "h"
        ? ann.grids.map((g) => ({
            ...g,
            columns: g.columns.map((c) => ({ ...c, x: size.width - c.x - c.width }))
          }))
        : ann.grids
  };
  if (ann.pins) out.pins = ann.pins.map((p) => ({ ...p, ...m(p) }));
  if (ann.annotations) out.annotations = ann.annotations.map((a) => ({ ...a, geometry: flipGeometry(a.geometry) }));
  if (ann.rois) out.rois = ann.rois.map(rect);
  if (ann.ignores) out.ignores = ann.ignores.map(rect);
  if (ann.guides) out.guides = ann.guides.map(flipGuide);
  if (ann.analogLayers) out.analogLayers = mapLayerPoints(ann.analogLayers, m);
  if (ann.rulers) {
    out.rulers = ann.rulers.map((r) => {
      const a = m({ x: r.x1, y: r.y1 });
      const b = m({ x: r.x2, y: r.y2 });
      return { ...r, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    });
  }
  if (ann.comments) out.comments = ann.comments.map((c) => ({ ...c, ...m(c) }));
  if (ann.floorplanRegions) {
    out.floorplanRegions = ann.floorplanRegions.map((r) => ({ ...r, geometry: pts(r.geometry) }));
  }
  if (flip.h || flip.v) out.imageFlip = { ...(flip.h ? { h: true } : {}), ...(flip.v ? { v: true } : {}) };
  else delete out.imageFlip;
  return out;
}
