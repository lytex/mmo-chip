import type {
  Cell,
  CellType,
  DieAnnotations,
  HumanAnnotation,
  IgnoreRect,
  IOPin,
  ROIRectangle
} from "shared";
import { withAlpha } from "../../lib/color";
import {
  applyOrientation,
  pointInPolygon,
  pointInRect,
  polygonBounds,
  type Rect
} from "../../lib/geometry";
import type { AnnotationLayer, Annotation } from "../layers/AnnotationLayer";
import { buildNetAnnotation } from "./nets";
import { drawCellLayers } from "./shapes";
import {
  CELL_COLOR,
  CELL_DETAIL_ZOOM,
  CELL_FILL_ALPHA,
  CELL_OUTLINE_ALPHA,
  CELL_OUTLINE_PX,
  COLOR_IGNORE,
  COLOR_IGNORE_FILL,
  COLOR_PIN,
  COLOR_PIN_FILL,
  COLOR_ROI,
  COLOR_VIA,
  COLOR_VIA_FILL,
  NET_COLOR,
  NET_DEFAULT_WIDTH,
  OUTLINE_WIDTH_PX,
  PICK,
  SELECT_COLOR,
  SELECT_FILL,
  SELECT_NODE_MULT,
  SELECT_OUTLINE_PX,
  SELECT_RING,
  VIA_DEFAULT_COLOR,
  viaColorOpaque,
  viaColorWithAlpha,
  VIA_RADIUS_PX,
  viaScreenRadius
} from "./style";

// Public surface: this module is the annotations "barrel". Tokens, the net
// builder, and sizing helpers live in sibling files but are re-exported here
// so existing import sites keep working.
export {
  CELL_COLOR,
  CELL_COLOR_OPTIONS,
  NET_COLOR,
  NET_COLOR_OPTIONS,
  NET_DEFAULT_WIDTH,
  NET_MAX_WIDTH,
  NET_MIN_WIDTH,
  netNodeScreenRadius
} from "./style";
export { buildNetAnnotation } from "./nets";

// ── Entry point ──────────────────────────────────────────────────────

export interface PopulateOptions {
  /** Live getter for the net wire base width (world units). Called at draw
   *  time so width-slider changes don't require repopulating. */
  netWidth?: () => number;
  /** Live getter for the net color (per-net, called with the full annotation
   *  id like "net:abc"). Called at draw time so color changes don't require
   *  repopulating. Default: always returns NET_COLOR. */
  netColor?: (netId: string) => string;
  /** Live getter for per-net colour overrides. When non-null for a netId,
   *  ALL edges of that net render in that colour, ignoring per-layer wire
   *  colours (WIRE_LAYER_COLOR). Null/undefined → use layer-based colours.
   *  Default: always returns null. */
  netOverrideColor?: (netId: string) => string | null;
  /** Live getter for the cell outline/fill color. Called at draw time so
   *  color changes don't require repopulating. */
  cellColor?: () => string;
  /** Live getter: when false, cells always render as a solid block (never the
   *  detailed inner layer shapes), even when zoomed in. Default true. */
  cellShowShapes?: () => boolean;
  /** Live getter for the point-via radius in **world units** (source px).
   *  When it returns a number the via is drawn at that physical size (the ML
   *  export footprint); `null` ⇒ the default fixed screen-size dot. */
  pointViaWorldRadius?: () => number | null;
  /** Live getter for point-via colour (rgba string). Used for both fill and
   *  stroke; fill gets an additional alpha reduction.
   *  Default: VIA_DEFAULT_COLOR. */
  pointViaColor?: () => string;
  /** Live getter for per-via-layer colour override. Called with the via
   *  annotation's layer id (VIA12, VIA23, …). Returns the colour or falls
   *  back to pointViaColor. */
  viaLayerColor?: (layer: string) => string | undefined;
  /** Live getter: when true, draw the via type label (VIA12, VIA23, …)
   *  above each via annotation at sufficient zoom. Default false. */
  viaLabelVisible?: () => boolean;
  /** Live getter: ML mode → render net vertices flush with the wire (radius =
   *  half the stroke) instead of the larger edit handles. Default false. */
  netNodeMatchesWidth?: () => boolean;
  /** Live getter: per-conductor-layer wire colour override. Returns the
   *  colour for a layer like "metal1", or undefined to fall back to
   *  WIRE_LAYER_COLOR. */
  wireLayerColor?: (layer: string) => string | undefined;
  /** Live getter: net node radius multiplier (0 = hide nodes).
   *  Default: use NET_NODE_RADIUS_MULT from style. */
  netNodeRadiusMult?: () => number;
  /** Called at draw time for each cell: true → draw a glow outline
   *  (sibling cells sharing a cellTypeId with the selection). */
  isSibling?: (cellId: string) => boolean;
  /** Called at draw time: when sibling highlighting is active, non-sibling
   *  cells are dimmed so the group stands out. */
  siblingActive?: () => boolean;
  /** Live getter: show the name+number label next to each I/O pin marker.
   *  Default true (names always shown). Independent of the pin kind's
   *  own all-or-nothing visibility (which hides the whole marker). */
  pinNamesVisible?: () => boolean;
}

/**
 * Clear and repopulate the layer's spatial index from a fetched annotations
 * blob. Cheap for a few thousand items; for hot edit paths, prefer the
 * layer's `update`/`remove` methods directly.
 */
export function populateAnnotationLayer(
  layer: AnnotationLayer,
  annotations: DieAnnotations,
  options: PopulateOptions = {}
): void {
  layer.clear();
  const getNetWidth = options.netWidth ?? (() => NET_DEFAULT_WIDTH);
  const getNetColor = options.netColor ?? ((_: string) => NET_COLOR);
  const getCellColor = options.cellColor ?? (() => CELL_COLOR);
  const getCellShowShapes = options.cellShowShapes ?? (() => true);
  const getPointViaWorldRadius = options.pointViaWorldRadius ?? (() => null);
  const getPointViaColor = options.pointViaColor ?? (() => VIA_DEFAULT_COLOR);
  const getViaLayerColor = options.viaLayerColor;
  const getViaLabelVisible = options.viaLabelVisible ?? (() => false);
  const getNetNodeMatchesWidth =
    options.netNodeMatchesWidth ?? (() => false);
  const getLayerColor = options.wireLayerColor;
  const getNodeRadiusMult = options.netNodeRadiusMult;

  const cellTypeMap = new Map(annotations.cellTypes.map((ct) => [ct.id, ct]));

  const getIsSibling = options.isSibling;
  const getSiblingActive = options.siblingActive;

  for (const cell of annotations.cells) {
    const ct = cellTypeMap.get(cell.cellTypeId);
    if (!ct) continue;
    layer.add(buildCellAnnotation(cell, ct, getCellColor, getCellShowShapes, getIsSibling, getSiblingActive));
  }

  const getNetOverrideColor = options.netOverrideColor ?? ((_: string) => null);

  // Sort nets by highest metal layer so lower metals (metal1) draw
  // underneath higher metals (metal2+). This mirrors the physical chip
  // stack-up — when two different nets cross, the upper metal wins.
  const NET_LAYER_PRIORITY: Record<string, number> = {
    poly: 0,
    metal1: 1,
    metal2: 2,
    metal3: 3,
    metal4: 4,
    metal5: 5,
    metal6: 6
  };
  const maxLayerPriority = (edges: typeof annotations.nets[number]["edges"]) => {
    let maxP = -1;
    for (const e of edges) {
      if (e.layer) {
        const p = NET_LAYER_PRIORITY[e.layer];
        if (p !== undefined && p > maxP) maxP = p;
      }
    }
    return maxP;
  };
  const sortedNets = [...annotations.nets].sort(
    (a, b) => maxLayerPriority(a.edges) - maxLayerPriority(b.edges)
  );

  for (const net of sortedNets) {
    if (net.nodes.length === 0 && net.edges.length === 0) continue;
    layer.add(
      buildNetAnnotation(
        net, getNetWidth, getNetColor, getNetNodeMatchesWidth,
        getNetOverrideColor, getLayerColor, getNodeRadiusMult
      )
    );
  }

  for (const a of annotations.annotations ?? []) {
    const built = buildAnnotation(a, getPointViaWorldRadius, getPointViaColor, getViaLayerColor, getViaLabelVisible);
    if (built) layer.add(built);
  }
  for (const r of annotations.rois ?? []) layer.add(buildRoiRect(r));
  for (const r of annotations.ignores ?? []) layer.add(buildIgnore(r));
  const getPinNamesVisible = options.pinNamesVisible ?? (() => true);
  for (const p of annotations.pins ?? []) layer.add(buildPin(p, getPinNamesVisible));
}

// ── Cells ────────────────────────────────────────────────────────────

export function buildCellAnnotation(
  cell: Cell,
  cellType: CellType,
  getColor: () => string,
  getShowShapes: () => boolean,
  isSibling?: (cellId: string) => boolean,
  siblingActive?: () => boolean
): Annotation {
  const w = cellType.cropRect.width;
  const h = cellType.cropRect.height;
  // Footprint AABB: the canonical w×h box, oriented (mirror + rotation) about
  // its centre, then placed at (cell.x, cell.y). A 90°/270° rotation swaps the
  // extent, so the bbox is derived from the oriented corners.
  const orientedCorners = [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h }
  ].map((p) => applyOrientation(p, cell, w, h));
  const ob = polygonBounds(orientedCorners) ?? {
    x: 0,
    y: 0,
    width: w,
    height: h
  };
  const bbox: Rect = {
    x: cell.x + ob.x,
    y: cell.y + ob.y,
    width: ob.width,
    height: ob.height
  };
  const layers = cellType.layers ?? {};
  // A cell with no inner layer shapes has nothing to draw at high zoom — keep
  // the solid block fill at every zoom so it stays visible.
  const hasShapes = Object.values(layers).some((s) => s != null && s.length > 0);

  return {
    id: `cell:${cell.id}`,
    kind: "cell",
    pickPriority: PICK.cell,
    bbox,
    draw(ctx, bounds, state) {
      // Draw inner shapes only when the user wants them AND zoomed in enough
      // AND there are shapes; otherwise the cell renders as a solid block.
      const showShapes =
        getShowShapes() && bounds.zoom >= CELL_DETAIL_ZOOM && hasShapes;
      const color = getColor();

      ctx.save();
      // Canonical cell-local → world: place at the cell centre, then apply the
      // instance orientation (rotation + mirror) about that centre, matching
      // the cell-RE / merge canvas transform so layer shapes land on the die
      // exactly where the cell image shows them.
      ctx.translate(cell.x + w / 2, cell.y + h / 2);
      ctx.rotate(((cell.rotation ?? 0) * Math.PI) / 180);
      ctx.scale(cell.flippedH ? -1 : 1, cell.flippedV ? -1 : 1);
      ctx.translate(-w / 2, -h / 2);

      // Dim non-sibling cells when a sibling group is active so the
      // highlighted cluster stands out on the die.
      const dimmed = !state.selected && !isSibling?.(cell.id) && siblingActive?.();
      if (dimmed) ctx.globalAlpha = 0.1;

      const isMl = cell.mlDetected === true;

      if (showShapes) {
        // No outlines on the die view — at die-wide zooms the per-shape
        // strokes add noise without disambiguating anything (the cell box
        // itself carries the outline).
        drawCellLayers(ctx, layers, bounds, { outline: false });
      } else {
        // Solid block so placement structure stays legible (when zoomed out,
        // or for cells that carry no inner shapes at all).
        if (isMl && !state.selected) {
          ctx.fillStyle = "rgba(100, 180, 255, 0.18)";
        } else {
          ctx.fillStyle = state.selected ? SELECT_FILL : withAlpha(color, CELL_FILL_ALPHA);
        }
        ctx.fillRect(0, 0, w, h);
      }

      // Sibling glow: cells sharing a cellTypeId with the selection get a
      // cyan halo before the regular outline so the group is visible at a glance.
      if (!state.selected && isSibling?.(cell.id)) {
        ctx.strokeStyle = "rgba(0, 200, 255, 0.45)";
        ctx.lineWidth = (CELL_OUTLINE_PX + 10) / bounds.zoom;
        ctx.strokeRect(0, 0, w, h);
        ctx.strokeStyle = "rgba(0, 230, 255, 0.7)";
        ctx.lineWidth = (CELL_OUTLINE_PX + 3) / bounds.zoom;
        ctx.strokeRect(0, 0, w, h);
      }

      // Strong outline, always — this is what makes cell boundaries readable.
      if (state.selected) {
        ctx.strokeStyle = SELECT_COLOR;
        ctx.lineWidth = (CELL_OUTLINE_PX + 1) / bounds.zoom;
      } else if (isMl) {
        ctx.strokeStyle = "rgba(100, 180, 255, 0.8)";
        ctx.lineWidth = CELL_OUTLINE_PX / bounds.zoom;
      } else {
        ctx.strokeStyle = withAlpha(color, CELL_OUTLINE_ALPHA);
        ctx.lineWidth = CELL_OUTLINE_PX / bounds.zoom;
      }
      ctx.strokeRect(0, 0, w, h);

      // CV label overlay — shown only when zoomed in enough to read text
      if (isMl && bounds.zoom >= 0.3 && cell.mlConfidence != null) {
        const fontSize = 10 / bounds.zoom;
        const label = `CV ${cell.mlConfidence.toFixed(2)}`;
        ctx.font = `${fontSize}px var(--mono, monospace)`;
        ctx.textBaseline = "bottom";
        ctx.textAlign = "right";
        ctx.fillStyle = "#90caf9";
        ctx.fillText(label, w - 2 / bounds.zoom, h - 2 / bounds.zoom);
      }

      ctx.restore();
    }
    // hitTest / intersectsRect: default bbox is exact for cells.
  };
}

// ── ML annotations (schema v2) ───────────────────────────────────────
//
// Persisted `HumanAnnotation`s are point_via / irregular_via only (`trace`
// is derived from `nets` by the exporter and never stored — nets already
// render as wires here). One builder switches on geometry kind. Selection
// id is `anno:<id>` for every class; `kind:"via"` drives layer visibility.

export function buildAnnotation(
  a: HumanAnnotation,
  getPointViaWorldRadius: () => number | null = () => null,
  getPointViaColor: () => string = () => VIA_DEFAULT_COLOR,
  getViaLayerColor?: (layer: string) => string | undefined,
  getViaLabelVisible?: () => boolean,
): Annotation | null {
  const g = a.geometry;
  const id = `anno:${a.id}`;
  if (g.kind === "point") {
    return {
      id,
      kind: "via",
      pickPriority: PICK.via,
      bbox: { x: g.x - 1, y: g.y - 1, width: 2, height: 2 },
      draw(ctx, bounds, state) {
        // Label pass — draw only the type label on top of everything
        if (state.pass === "label") {
          if (a.layer && getViaLabelVisible?.() && bounds.zoom >= 8) {
            const fontPx = 16 / bounds.zoom;
            ctx.font = `bold ${fontPx}px ui-sans-serif, system-ui, sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            const tw = ctx.measureText(a.layer).width;
            const pad = 2 / bounds.zoom;
            ctx.fillStyle = "rgba(0,0,0,0.65)";
            ctx.fillRect(g.x - tw / 2 - pad, g.y - fontPx / 2 - pad, tw + pad * 2, fontPx + pad * 2);
            ctx.fillStyle = "#ffffff";
            ctx.fillText(a.layer, g.x, g.y);
          }
          return;
        }
        // World radius from the active pref (or `mlConfig` when the ML tab
        // is forcing the export-footprint view), clamped to a CSS-px range
        // so vias stay visible at low zoom and don't take over at high
        // zoom. Legacy CSS-px fallback for callers that don't provide a
        // world radius — every call site we control does today.
        const worldR = getPointViaWorldRadius();
        const baseR =
          worldR != null
            ? viaScreenRadius(bounds.zoom, worldR) / bounds.zoom
            : VIA_RADIUS_PX / bounds.zoom;
        const r = state.selected ? baseR * SELECT_NODE_MULT : baseR;
        const viaColor = (a.layer && getViaLayerColor?.(a.layer)) ?? getPointViaColor();
        ctx.fillStyle = state.selected ? SELECT_COLOR : viaColor;
        ctx.beginPath();
        ctx.arc(g.x, g.y, r, 0, Math.PI * 2);
        ctx.fill();
        if (state.selected) {
          ctx.strokeStyle = SELECT_RING;
          ctx.lineWidth = SELECT_OUTLINE_PX / bounds.zoom;
          ctx.beginPath();
          ctx.arc(g.x, g.y, r, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    };
  }
  if (g.kind === "rectangle") {
    return {
      id,
      kind: "via",
      pickPriority: PICK.via,
      bbox: { x: g.x, y: g.y, width: g.width, height: g.height },
      draw(ctx, bounds, state) {
        // Label pass — draw only the type label on top of everything
        if (state.pass === "label") {
          if (a.layer && getViaLabelVisible?.() && bounds.zoom >= 8) {
            const cx = g.x + g.width / 2;
            const cy = g.y + g.height / 2;
            const fontPx = 16 / bounds.zoom;
            ctx.font = `bold ${fontPx}px ui-sans-serif, system-ui, sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            const tw = ctx.measureText(a.layer).width;
            const pad = 2 / bounds.zoom;
            ctx.fillStyle = "rgba(0,0,0,0.65)";
            ctx.fillRect(cx - tw / 2 - pad, cy - fontPx / 2 - pad, tw + pad * 2, fontPx + pad * 2);
            ctx.fillStyle = "#ffffff";
            ctx.fillText(a.layer, cx, cy);
          }
          return;
        }
        const viaColor = (a.layer && getViaLayerColor?.(a.layer)) ?? getPointViaColor();
        const viaFill = viaColorWithAlpha(viaColor, 0.25);
        ctx.fillStyle = state.selected ? SELECT_FILL : viaFill;
        ctx.strokeStyle = state.selected ? SELECT_COLOR : viaColor;
        ctx.lineWidth =
          (state.selected ? SELECT_OUTLINE_PX : OUTLINE_WIDTH_PX) / bounds.zoom;
        ctx.fillRect(g.x, g.y, g.width, g.height);
        ctx.strokeRect(g.x, g.y, g.width, g.height);
      }
    };
  }
  if (g.kind === "polygon") {
    const pts = g.points;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    if (!isFinite(minX)) minX = minY = maxX = maxY = 0;
    return {
      id,
      kind: "via",
      pickPriority: PICK.via,
      bbox: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
      draw(ctx, bounds, state) {
        // Label pass — draw only the type label on top of everything
        if (state.pass === "label") {
          if (a.layer && getViaLabelVisible?.() && bounds.zoom >= 8) {
            const cx = (minX + maxX) / 2;
            const cy = (minY + maxY) / 2;
            const fontPx = 16 / bounds.zoom;
            ctx.font = `bold ${fontPx}px ui-sans-serif, system-ui, sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            const tw = ctx.measureText(a.layer).width;
            const pad = 2 / bounds.zoom;
            ctx.fillStyle = "rgba(0,0,0,0.65)";
            ctx.fillRect(cx - tw / 2 - pad, cy - fontPx / 2 - pad, tw + pad * 2, fontPx + pad * 2);
            ctx.fillStyle = "#ffffff";
            ctx.fillText(a.layer, cx, cy);
          }
          return;
        }
        if (pts.length < 2) return;
        const viaColor = (a.layer && getViaLayerColor?.(a.layer)) ?? getPointViaColor();
        const viaFill = viaColorWithAlpha(viaColor, 0.25);
        ctx.fillStyle = state.selected ? SELECT_FILL : viaFill;
        ctx.strokeStyle = state.selected ? SELECT_COLOR : viaColor;
        ctx.lineWidth =
          (state.selected ? SELECT_OUTLINE_PX : OUTLINE_WIDTH_PX) / bounds.zoom;
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      },
      hitTest(p) {
        return pts.length >= 3 && pointInPolygon(p, pts) ? id : null;
      },
      intersectsRect(r) {
        for (const pt of pts) if (pointInRect(pt, r)) return true;
        return false;
      }
    };
  }
  // polyline geometry only occurs for `trace`, which is never persisted here.
  return null;
}

export function buildIgnore(r: IgnoreRect): Annotation {
  return {
    id: `ignore:${r.id}`,
    kind: "ignore",
    pickPriority: PICK.ignore,
    bbox: { x: r.x, y: r.y, width: r.width, height: r.height },
    draw(ctx, bounds, state) {
      ctx.fillStyle = state.selected ? SELECT_FILL : COLOR_IGNORE_FILL;
      ctx.strokeStyle = state.selected ? SELECT_COLOR : COLOR_IGNORE;
      ctx.lineWidth = (state.selected ? SELECT_OUTLINE_PX : OUTLINE_WIDTH_PX) / bounds.zoom;
      const dash = 4 / bounds.zoom;
      ctx.setLineDash([dash, dash]);
      ctx.fillRect(r.x, r.y, r.width, r.height);
      ctx.strokeRect(r.x, r.y, r.width, r.height);
      ctx.setLineDash([]);
    }
  };
}

export function buildRoiRect(roi: ROIRectangle): Annotation {
  return {
    id: `roi:${roi.id}`,
    kind: "roi",
    pickPriority: PICK.roi,
    bbox: { x: roi.x, y: roi.y, width: roi.width, height: roi.height },
    draw(ctx, bounds, state) {
      ctx.strokeStyle = state.selected ? SELECT_COLOR : COLOR_ROI;
      ctx.lineWidth =
        (state.selected ? SELECT_OUTLINE_PX + 0.5 : OUTLINE_WIDTH_PX + 0.5) / bounds.zoom;
      const dash = 6 / bounds.zoom;
      ctx.setLineDash([dash, dash * 0.6]);
      ctx.strokeRect(roi.x, roi.y, roi.width, roi.height);
      ctx.setLineDash([]);
    }
  };
}

function buildPin(pin: IOPin, getNamesVisible: () => boolean): Annotation {
  const half = 6; // half-size in source pixels for the bbox
  return {
    id: `pin:${pin.id}`,
    kind: "pin",
    pickPriority: PICK.pin,
    bbox: { x: pin.x - half, y: pin.y - half, width: half * 2, height: half * 2 },
    draw(ctx, bounds, state) {
      const r = 6 / bounds.zoom;
      ctx.fillStyle = state.selected ? SELECT_FILL : COLOR_PIN_FILL;
      ctx.strokeStyle = state.selected ? SELECT_COLOR : COLOR_PIN;
      ctx.lineWidth = (state.selected ? SELECT_OUTLINE_PX : OUTLINE_WIDTH_PX) / bounds.zoom;
      ctx.beginPath();
      ctx.rect(pin.x - r, pin.y - r, r * 2, r * 2);
      ctx.fill();
      ctx.stroke();

      // Label: pin name + number. Always shown (regardless of zoom/selection)
      // unless the names toggle has hidden them.
      if (!getNamesVisible()) return;
      const fontPx = 11 / bounds.zoom; // ~constant on-screen size
      ctx.font = `${fontPx}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const label = `${pin.name}  #${pin.pin}`;
      const tx = pin.x + r + 4 / bounds.zoom;
      // Dark halo so the text stays legible over busy die imagery.
      ctx.lineWidth = 3 / bounds.zoom;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
      ctx.strokeText(label, tx, pin.y);
      ctx.fillStyle = state.selected ? SELECT_COLOR : COLOR_PIN;
      ctx.fillText(label, tx, pin.y);
    }
  };
}
