import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  forwardRef
} from "react";
import type {
  Cell,
  CellType,
  DieAnnotations,
  LayerLine,
  LayerShape,
  LayerType,
  ShapeLabel,
  AnalogDevice,
} from "shared";
import type { AnnotationAction } from "../../api/actions";
import {
  buildRemoveShapesAction,
  buildUpsertShapeAction,
  makePoint,
  makeRect,
  moveShapeVertex,
  shapeHandleAt,
  shapeHandles,
  shapeHit,
  shapeIntersectsRect,
  translateShape
} from "../../lib/cellLayers";
import {
  type Point,
  type Rect,
  normalizeRect,
  pointInPolygon,
  pointInRect,
  polygonBounds,
  rectsIntersect,
  segmentIntersectsRect
} from "../../lib/geometry";
import {
  LAYER_DRAW_ORDER,
  applyShapeStyle,
  drawCellLayers,
  drawShape
} from "../../renderer/annotations/shapes";
import {
  COLOR_LAYER,
  COLOR_VIA,
  COLOR_VIA_FILL,
  NET_COLOR,
  WIRE_LAYER_COLOR
} from "../../renderer/annotations/style";
import type { TileBounds } from "../../renderer/types";
import { orientOf } from "../../lib/mergeCells";
import {
  shapeKey,
  parseShapeKey,
  type ReToolKind
} from "../../state/cellRE";
import type { CellExtraction, InferredCellExtraction } from "../../lib/extraction";
import { uuid } from "../../lib/uuid";
import { useCellREStore } from "../../state/cellRE";
import { useOverlayLayers } from "../../state/overlayLayers";
import { usePreferences } from "../../state/preferences";

export interface CellRECanvasHandle {
  /** Re-fit the cell into the viewport. */
  fit: () => void;
  zoomBy: (factor: number) => void;
  /** Read the current cursor's world (cell-local) point — for the page's
   *  status bar readout. */
  getCursor: () => Point | null;
}

interface Props {
  cellType: CellType;
  /** Instance loaded in the canvas (null ⇒ no member exists yet). */
  cell: Cell | null;
  imageUrl: string | null;
  /** Full die annotations — used to draw the die-viewer overlay (wires +
   *  vias clipped to the cell's die rect). Absent ⇒ no overlay. */
  annotations?: DieAnnotations;
  activeTool: ReToolKind;
  activeLayer: LayerType;
  /** Visibility map. Editable cell-layer keys plus the virtual keys for the
   *  die-viewer overlay rows (`_dvWires`, `_dvVias`) and the placeholder
   *  inferred / dv group rows. Absent keys = visible. */
  layerHidden: Record<string, boolean>;
  /** Per-layer selectability (absent ⇒ selectable). When false, shapes on
   *  that layer can't be picked by the Select tool. */
  layerSelectable: Record<string, boolean>;
  selectedShapeIds: Set<string>;
  /** Transient highlight from right-panel row hover. Same key format as
   *  `selectedShapeIds`. The canvas paints a softer halo for these. */
  hoveredShapeIds?: Set<string>;
  /** When true, fade everything outside `hoveredShapeIds` to background
   *  alpha so the hovered set pops. Default true. The page turns this OFF
   *  when the hover originated from the canvas cursor itself — dimming the
   *  whole image while the user is just mousing over the canvas is too
   *  jarring; the steel-blue halo on the hovered shape is sufficient
   *  feedback in that case. */
  dimNonHovered?: boolean;
  /** Structural extraction for the current cell — drives the diffusion
   *  type overlay (sub-region outlines + P/N labels). `null` while loading
   *  or when extraction failed. */
  extraction?: CellExtraction | null;
  onSelect: (next: Set<string>) => void;
  dispatch: (action: AnnotationAction) => void;
  /** In-progress polygon (points the user has clicked so far). Page-level so
   *  ⌘Z while drafting can pop the last vertex via the global undo override. */
  polyDraft: Point[];
  onPolyAddVertex: (p: Point) => void;
  onPolyCommit: () => void;
  onPolyCancel: () => void;
  /** In-progress polyline (same pattern as polygon, open path). */
  polylineDraft: Point[];
  onPolylineAddVertex: (p: Point) => void;
  onPolylineCommit: () => void;
  onPolylineCancel: () => void;
  polylineWidth: number;
  /** µm per pixel — for converting polyline width from µm to px. */
  umPerPx?: number;
  /** Esc with no draft cancels the active tool back to select. */
  onEscape: () => void;
  /** Right-click on a shape. Canvas has already hit-tested + (re-)selected the
   *  shape so the menu's actions can read `selectedShapeIds`. `null` is sent
   *  when the user right-clicked on empty canvas (so the page can dismiss any
   *  open menu). Coordinates are client-space for portal positioning. */
  onShapeContextMenu?: (
    target: { layer: LayerType; shape: LayerShape } | null,
    clientX: number,
    clientY: number
  ) => void;
  /** Cursor moved over (or off) a shape. Fires only when the resolved
   *  target changes — moving the cursor within the same shape doesn't
   *  trigger. Drives the status bar's hover-info + right-panel row
   *  highlighting. `subRegionId` is set when the cursor is over a specific
   *  diffusion sub-region (requires `extraction` to be loaded). */
  onCanvasHover?: (target: CanvasHoverTarget | null) => void;
}

/** Public shape of the canvas hover callback's payload. */
export interface CanvasHoverTarget {
  layer: LayerType;
  shape: LayerShape;
  /** Synthetic id of the diffusion sub-region under the cursor, if any. */
  subRegionId?: string;
}

interface View {
  ox: number; // world x at canvas left
  oy: number; // world y at canvas top
  zoom: number;
}

/** Wheel zoom step. Matches the merge canvas and the die viewer so trackpad
 *  zoom feels identical across pages. */
const WHEEL_ZOOM_FACTOR = 0.01;
/** CSS-px tolerance for handle / shape picks. Translated to world units via
 *  the current zoom at pick time. */
const PICK_TOL_PX = 6;
const HANDLE_PX = 10;
const HANDLE_HIT_TOL_PX = 8;
/** Selection accent — same amber the die viewer uses on selected shapes. */
const SELECT_COLOR = "#f3b351";

function fitBox(w: number, h: number, pw: number, ph: number): View {
  const bw = Math.max(w, 1);
  const bh = Math.max(h, 1);
  const pad = 32;
  const zoom = Math.max(
    1e-3,
    Math.min((pw - pad * 2) / bw, (ph - pad * 2) / bh)
  );
  return { zoom, ox: bw / 2 - pw / 2 / zoom, oy: bh / 2 - ph / 2 / zoom };
}

type DragKind =
  | "pan"
  | "marquee"
  | "move"
  | "vertex"
  | "rect-draw"
  | null;

/**
 * The reverse-engineering canvas. One single-image cell crop, oriented to the
 * cell-type canonical view via `cell.flippedH/V/rotation`, with cell-type
 * layer shapes drawn on top in cell-local coordinates. All drawing tools live
 * here (rect, polygon, point) with select supporting marquee, drag-move,
 * alt-duplicate, shift-axis-lock, and per-vertex / per-corner edit handles.
 */
export const CellRECanvas = forwardRef<CellRECanvasHandle, Props>(function CellRECanvas(
  {
    cellType,
    cell,
    imageUrl,
    annotations,
    extraction,
    activeTool,
    activeLayer,
    layerHidden,
    layerSelectable = {},
    selectedShapeIds,
    hoveredShapeIds,
    dimNonHovered = true,
    onSelect,
    dispatch,
    polyDraft,
    onPolyAddVertex,
    onPolyCommit,
    onPolyCancel,
    polylineDraft,
    onPolylineAddVertex,
    onPolylineCommit,
    onPolylineCancel,
    polylineWidth,
    umPerPx,
    onEscape,
    onShapeContextMenu,
    onCanvasHover
  },
  ref
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewRef = useRef<View>({ ox: 0, oy: 0, zoom: 1 });
  const sizeRef = useRef({ w: 1, h: 1 });
  const cursorRef = useRef<Point | null>(null);
  /** Last value passed to `onCanvasHover`, encoded as a stable key — drives
   *  change-detection so we only fire the callback when the cursor crosses
   *  into a different shape (or sub-region). `null` means "currently off
   *  any shape". */
  const lastHoverKeyRef = useRef<string | null>(null);
  // Live "preview" state pushed during a drag — held outside React state to
  // avoid re-rendering during the hot path. The draw effect reads these refs.
  const liveRectRef = useRef<Rect | null>(null);
  const liveMarqueeRef = useRef<Rect | null>(null);
  // Per-selected-shape live offset (drag-move) and per-shape live vertex move.
  const liveMoveRef = useRef<{ dx: number; dy: number } | null>(null);
  const liveVertexRef = useRef<{
    key: string;
    shape: LayerShape;
  } | null>(null);
  // Drag bookkeeping.
  const dragRef = useRef<{
    kind: DragKind;
    /** Pointer-down in CSS px (client coords). */
    sx: number;
    sy: number;
    /** Pointer-down in world (cell-local) coords. */
    wx: number;
    wy: number;
    startView: View;
    /** "move" drag: vertex index when the drag started on a single-shape
     *  handle (otherwise null = body-move). */
    vertex: { key: string; vIdx: number } | null;
    /** "move" drag: alt+drag duplicates → fresh ids created up-front. */
    duplicateIds: Map<string, string> | null;
    /** "move" drag: original shapes snapshot keyed by shape-key. */
    movingSnapshot: Map<string, { layer: LayerType; shape: LayerShape }> | null;
    /** Pointer has actually moved (a tiny wiggle still reads as a click). */
    moved: boolean;
  } | null>(null);
  const spaceRef = useRef(false);

  // Mirror dynamic props into a ref so the pointer/keyboard handlers stay
  // referentially stable (no ResizeObserver / wheel re-subscription churn).
  type PropsRef = {
    cellType: Props["cellType"];
    cell: Props["cell"];
    activeTool: Props["activeTool"];
    activeLayer: Props["activeLayer"];
    layerHidden: Props["layerHidden"];
    layerSelectable: Props["layerSelectable"];
    selectedShapeIds: Props["selectedShapeIds"];
    hoveredShapeIds: Set<string> | undefined;
    extraction: Props["extraction"];
    onSelect: Props["onSelect"];
    dispatch: Props["dispatch"];
    polyDraft: Props["polyDraft"];
    onPolyAddVertex: Props["onPolyAddVertex"];
    onPolyCommit: Props["onPolyCommit"];
    onPolyCancel: Props["onPolyCancel"];
    polylineDraft: Props["polylineDraft"];
    onPolylineAddVertex: Props["onPolylineAddVertex"];
    onPolylineCommit: Props["onPolylineCommit"];
    onPolylineCancel: Props["onPolylineCancel"];
    polylineWidth: Props["polylineWidth"];
    umPerPx: Props["umPerPx"];
    onEscape: Props["onEscape"];
    onShapeContextMenu: Props["onShapeContextMenu"];
    onCanvasHover: Props["onCanvasHover"];
  };
  const propsRef = useRef<PropsRef>({
    cellType,
    cell,
    activeTool,
    activeLayer,
    layerHidden,
    layerSelectable: layerSelectable as Props["layerSelectable"],
    selectedShapeIds,
    hoveredShapeIds: hoveredShapeIds as Set<string> | undefined,
    extraction: extraction as Props["extraction"],
    onSelect,
    dispatch,
    polyDraft,
    onPolyAddVertex,
    onPolyCommit,
    onPolyCancel,
    polylineDraft,
    onPolylineAddVertex,
    onPolylineCommit,
    onPolylineCancel,
    polylineWidth,
    umPerPx,
    onEscape,
    onShapeContextMenu: undefined as Props["onShapeContextMenu"],
    onCanvasHover: undefined as Props["onCanvasHover"]
  });
  propsRef.current = {
    cellType,
    cell,
    activeTool,
    activeLayer,
    layerHidden,
    layerSelectable,
    selectedShapeIds,
    hoveredShapeIds,
    extraction,
    onSelect,
    dispatch,
    polyDraft,
    onPolyAddVertex,
    onPolyCommit,
    onPolyCancel,
    polylineDraft,
    onPolylineAddVertex,
    onPolylineCommit,
    onPolylineCancel,
    polylineWidth,
    umPerPx,
    onEscape,
    onShapeContextMenu,
    onCanvasHover
  };

  const [, force] = useState(0);
  const redraw = useCallback(() => force((n) => n + 1), []);

  // ── Subscribe to overlay prefs ────────────────────────────────────
  // The draw effect reads overlay toggles + label scale via `getState()`
  // inside the rAF, but the effect itself doesn't re-run on prefs change
  // — only on `redraw` counter / fit / pan-zoom. Without this subscription
  // toggling the toolbar checkboxes would not visibly update the canvas
  // until the user hovers (which fires a hover-induced redraw).
  //
  // We fold the four overlay-relevant fields into a single tuple so the
  // subscription fires once when ANY of them changes — three separate
  // subscriptions would double-count when multiple fields flip in one
  // zustand `set()` (e.g. `set({ reDeviceLabelsVisible, labelScale })`).
  // The tuple is recreated only on change so the default Object.is
  // equality check works.
  const overlayKey = usePreferences((s) =>
    `${s.reDeviceLabelsVisible ? 1 : 0}|${s.reTerminalLabelsVisible ? 1 : 0}|${s.reAnalogLabelScale}` as const,
  );
  // Trigger a redraw whenever any overlay-related preference flips. Using
  // the `force` counter (not redraw directly) keeps React's render
  // scheduling consistent with the rest of the component's draw loop.
  useEffect(() => {
    force((n) => n + 1);
    // We intentionally want this to run on every change of `overlayKey`.
    // `force` is stable; React's setState bail-out is skipped because we
    // always pass a fresh number.
  }, [overlayKey]);

  // ── Image cache ────────────────────────────────────────────────────
  const imgCacheRef = useRef(new Map<string, HTMLImageElement>());
  const getImage = useCallback(
    (url: string | null): HTMLImageElement | null => {
      if (!url) return null;
      const cache = imgCacheRef.current;
      const hit = cache.get(url);
      if (hit) return hit.complete && hit.naturalWidth > 0 ? hit : null;
      const img = new Image();
      img.decoding = "async";
      img.onload = redraw;
      img.onerror = redraw;
      img.src = url;
      cache.set(url, img);
      return null;
    },
    [redraw]
  );

  // ── Fit ────────────────────────────────────────────────────────────
  const fit = useCallback(() => {
    const { w: cw, h: ch } = sizeRef.current;
    const ct = propsRef.current.cellType;
    viewRef.current = fitBox(ct.cropRect.width, ct.cropRect.height, cw, ch);
    redraw();
  }, [redraw]);

  useImperativeHandle(
    ref,
    () => ({
      fit,
      zoomBy: (factor: number) => {
        const v = viewRef.current;
        const { w, h } = sizeRef.current;
        const cx = v.ox + w / 2 / v.zoom;
        const cy = v.oy + h / 2 / v.zoom;
        const zoom = Math.min(64, Math.max(1e-3, v.zoom * factor));
        viewRef.current = { zoom, ox: cx - w / 2 / zoom, oy: cy - h / 2 / zoom };
        redraw();
      },
      getCursor: () => cursorRef.current
    }),
    [fit, redraw]
  );

  // Re-fit when the cell type identity changes (different cell → different
  // canonical box). Don't re-fit on a same-type edit (would yank zoom).
  const fitKey = cellType.id;
  const fitKeyRef = useRef("");
  useEffect(() => {
    if (fitKey !== fitKeyRef.current) {
      fitKeyRef.current = fitKey;
      fit();
    }
  }, [fitKey, fit]);

  // ── Resize ─────────────────────────────────────────────────────────
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => {
      const r = host.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        const first = sizeRef.current.w === 1 && sizeRef.current.h === 1;
        sizeRef.current = { w: r.width, h: r.height };
        if (first) fit();
        else redraw();
      }
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [fit, redraw]);

  // ── Keyboard (space pan; Esc / Enter / Delete) ─────────────────────
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceRef.current = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceRef.current = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // ── Coordinate helpers ──────────────────────────────────────────────
  // Convert canvas-local CSS px → cell-local (canonical) world coords. The
  // image is drawn with a forward-orientation transform inside the canonical
  // box, so the box itself stays in canonical coords — clicks on layer
  // geometry (which is stored canonical) need only the pan/zoom inverse.
  const toWorld = useCallback((cssX: number, cssY: number): Point => {
    const v = viewRef.current;
    return { x: cssX / v.zoom + v.ox, y: cssY / v.zoom + v.oy };
  }, []);

  /** Cell-local hit-test for shapes — returns the deepest-paint match (later
   *  paint = on top). Respects layer visibility. */
  const hitShape = useCallback(
    (pt: Point): { layer: LayerType; shape: LayerShape } | null => {
      const { cellType, layerHidden, layerSelectable } = propsRef.current;
      const tol = PICK_TOL_PX / viewRef.current.zoom;
      // Iterate in reverse paint order so the top-most shape wins.
      for (let i = LAYER_DRAW_ORDER.length - 1; i >= 0; i--) {
        const layer = LAYER_DRAW_ORDER[i];
        if (layerHidden[layer]) continue;
        if (layerSelectable[layer] === false) continue;
        const shapes = cellType.layers?.[layer];
        if (!shapes) continue;
        for (let j = shapes.length - 1; j >= 0; j--) {
          if (shapeHit(shapes[j], pt, tol)) {
            return { layer, shape: shapes[j] };
          }
        }
      }
      return null;
    },
    []
  );

  /** Resolve a shape-key back to its current layer + shape. */
  const resolveKey = useCallback(
    (key: string): { layer: LayerType; shape: LayerShape } | null => {
      const parsed = parseShapeKey(key);
      if (!parsed) return null;
      const shapes = propsRef.current.cellType.layers?.[parsed.layer];
      const shape = shapes?.find((s) => s.id === parsed.id);
      return shape ? { layer: parsed.layer, shape } : null;
    },
    []
  );

  /** Among the currently-selected shapes, find a corner/vertex handle within
   *  `tol` of `pt`. Returns null if `pt` lands on no handle. Single-shape
   *  selection only (multi-select drags the bodies, not vertices). */
  const hitHandle = useCallback(
    (pt: Point): { key: string; vIdx: number } | null => {
      const sel = propsRef.current.selectedShapeIds;
      if (sel.size !== 1) return null;
      const only = sel.values().next().value as string;
      const r = resolveKey(only);
      if (!r) return null;
      const tol = HANDLE_HIT_TOL_PX / viewRef.current.zoom;
      const v = shapeHandleAt(r.shape, pt, tol);
      return v == null ? null : { key: only, vIdx: v };
    },
    [resolveKey]
  );

  // ── Pointer handling ───────────────────────────────────────────────
  const onPointerDown = (e: React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(e.pointerId);
    canvas.focus();
    const rect = canvas.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    const v = viewRef.current;
    const world = toWorld(cssX, cssY);
    const panKey = spaceRef.current || e.button === 1 || e.button === 2;
    const tool = propsRef.current.activeTool;

    // Pan beats everything else: dedicated pan tool or modifier-pan.
    if (tool === "pan" || panKey) {
      dragRef.current = {
        kind: "pan",
        sx: e.clientX,
        sy: e.clientY,
        wx: world.x,
        wy: world.y,
        startView: v,
        vertex: null,
        duplicateIds: null,
        movingSnapshot: null,
        moved: false
      };
      return;
    }

    if (tool === "select") {
      // Handle pick (single-shape vertex edit) > body pick (move) > marquee.
      const handle = hitHandle(world);
      if (handle) {
        const cur = resolveKey(handle.key);
        if (cur) {
          liveVertexRef.current = { key: handle.key, shape: cur.shape };
        }
        dragRef.current = {
          kind: "vertex",
          sx: e.clientX,
          sy: e.clientY,
          wx: world.x,
          wy: world.y,
          startView: v,
          vertex: handle,
          duplicateIds: null,
          movingSnapshot: null,
          moved: false
        };
        return;
      }
      const hit = hitShape(world);
      if (hit) {
        const key = shapeKey(hit.layer, hit.shape.id);
        //
        let sel: Set<string>;
        if (e.shiftKey) {
          sel = new Set(propsRef.current.selectedShapeIds);
          if (sel.has(key)) sel.delete(key); else sel.add(key);
        } else if (hit.shape.kind === "line") {
          // Line shape: select ALL connected segments in this layer.
          sel = getConnectedLines(propsRef.current.cellType, hit.layer, hit.shape);
          //
        } else {
          sel = new Set([key]);
        }
        // Direct Zustand update for reliable store synchronisation.
        useCellREStore.getState().setSelectedShapeIds(sel);
        propsRef.current.onSelect(sel);
        // Snapshot the (now) selected shapes so a move drag can translate
        // them in lock-step from the original positions.
        const snap = new Map<string, { layer: LayerType; shape: LayerShape }>();
        for (const k of sel) {
          const r = resolveKey(k);
          if (r) snap.set(k, r);
        }
        // Cut lines: never allow drag-move (would break the resistor).
        // Fall through to marquee instead.
        const hasLines = [...sel].some((k) => {
          const p = parseShapeKey(k);
          if (!p) return false;
          const s = propsRef.current.cellType.layers?.[p.layer]?.find(
            (sh) => sh.id === p.id
          );
          return s?.kind === "line";
        });
        if (hasLines) {
          // Don't start a move drag — fall through to empty-space marquee.
        } else {
          // Alt = duplicate the selection into the same layer(s), and move
          // the *copies*.
          const duplicateIds = e.altKey ? new Map<string, string>() : null;
          if (duplicateIds) {
            for (const k of snap.keys()) duplicateIds.set(k, uuid());
          }
          dragRef.current = {
            kind: "move",
            sx: e.clientX,
            sy: e.clientY,
            wx: world.x,
            wy: world.y,
            startView: v,
            vertex: null,
            duplicateIds,
            movingSnapshot: snap,
            moved: false
          };
          liveMoveRef.current = { dx: 0, dy: 0 };
          return;
        }
      }
      // Empty space → marquee.
      if (!e.shiftKey) propsRef.current.onSelect(new Set());
      dragRef.current = {
        kind: "marquee",
        sx: e.clientX,
        sy: e.clientY,
        wx: world.x,
        wy: world.y,
        startView: v,
        vertex: null,
        duplicateIds: null,
        movingSnapshot: null,
        moved: false
      };
      liveMarqueeRef.current = { x: world.x, y: world.y, width: 0, height: 0 };
      redraw();
      return;
    }

    if (tool === "rect") {
      dragRef.current = {
        kind: "rect-draw",
        sx: e.clientX,
        sy: e.clientY,
        wx: world.x,
        wy: world.y,
        startView: v,
        vertex: null,
        duplicateIds: null,
        movingSnapshot: null,
        moved: false
      };
      liveRectRef.current = { x: world.x, y: world.y, width: 0, height: 0 };
      redraw();
      return;
    }

    if (tool === "point") {
      // Single click drops a point on pointer-up; track to suppress click on
      // drag (so a tiny accidental wiggle still places).
      dragRef.current = {
        kind: null,
        sx: e.clientX,
        sy: e.clientY,
        wx: world.x,
        wy: world.y,
        startView: v,
        vertex: null,
        duplicateIds: null,
        movingSnapshot: null,
        moved: false
      };
      return;
    }

    if (tool === "polygon" || tool === "polyline") {
      dragRef.current = {
        kind: null,
        sx: e.clientX,
        sy: e.clientY,
        wx: world.x,
        wy: world.y,
        startView: v,
        vertex: null,
        duplicateIds: null,
        movingSnapshot: null,
        moved: false
      };
      return;
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    cursorRef.current = toWorld(cssX, cssY);

    const d = dragRef.current;
    if (!d) {
      // No drag in flight → this is plain hover. Resolve the shape under
      // the cursor (and, when extraction is loaded, the specific diffusion
      // sub-region) and fire `onCanvasHover` only when the resolved target
      // changes. We avoid the dispatch on every mouse-move so the page can
      // do real work (status bar / row highlight) without throttling.
      const worldHover = cursorRef.current ?? toWorld(cssX, cssY);
      const hit = hitShape(worldHover);
      let subId: string | undefined;
      const ext = propsRef.current.extraction;
      if (hit?.layer === "diffusion" && ext && ext.kind === "inferred") {
        for (const sub of ext.shapes) {
          if (sub.parentDiffId !== hit.shape.id) continue;
          if (pointInPolygon(worldHover, sub.polygon)) {
            subId = sub.id;
            break;
          }
        }
      }
      const key = hit ? `${hit.layer}:${hit.shape.id}#${subId ?? ""}` : null;
      if (key !== lastHoverKeyRef.current) {
        lastHoverKeyRef.current = key;
        propsRef.current.onCanvasHover?.(
          hit ? { layer: hit.layer, shape: hit.shape, subRegionId: subId } : null,
        );
      }
      redraw();
      return;
    }
    if (!d.moved && (Math.abs(e.clientX - d.sx) > 1 || Math.abs(e.clientY - d.sy) > 1)) {
      d.moved = true;
    }
    const v = viewRef.current;
    const world = toWorld(cssX, cssY);

    if (d.kind === "pan") {
      viewRef.current = {
        ...v,
        ox: d.startView.ox - (e.clientX - d.sx) / v.zoom,
        oy: d.startView.oy - (e.clientY - d.sy) / v.zoom
      };
      redraw();
      return;
    }

    if (d.kind === "marquee") {
      liveMarqueeRef.current = {
        x: d.wx,
        y: d.wy,
        width: world.x - d.wx,
        height: world.y - d.wy
      };
      redraw();
      return;
    }

    if (d.kind === "rect-draw") {
      liveRectRef.current = {
        x: d.wx,
        y: d.wy,
        width: world.x - d.wx,
        height: world.y - d.wy
      };
      redraw();
      return;
    }

    if (d.kind === "move") {
      let dx = world.x - d.wx;
      let dy = world.y - d.wy;
      // Shift = constrain to dominant axis (horizontal or vertical only).
      if (e.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      liveMoveRef.current = { dx, dy };
      redraw();
      return;
    }

    if (d.kind === "vertex" && d.vertex) {
      const r = resolveKey(d.vertex.key);
      if (r) {
        const next = moveShapeVertex(r.shape, d.vertex.vIdx, world);
        liveVertexRef.current = { key: d.vertex.key, shape: next };
        redraw();
      }
      return;
    }
  };

  const endDrag = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) {
      cursorRef.current = null;
      redraw();
      return;
    }
    const canvas = canvasRef.current;
    canvas?.releasePointerCapture(e.pointerId);
    const rect = canvas?.getBoundingClientRect();
    const cssX = rect ? e.clientX - rect.left : 0;
    const cssY = rect ? e.clientY - rect.top : 0;
    const world = toWorld(cssX, cssY);
    const tool = propsRef.current.activeTool;
    const { cellType, dispatch } = propsRef.current;

    if (d.kind === "pan") {
      redraw();
      return;
    }

    if (d.kind === "marquee") {
      const m = liveMarqueeRef.current;
      liveMarqueeRef.current = null;
      if (!d.moved || !m || m.width === 0 || m.height === 0) {
        redraw();
        return;
      }
      const r = normalizeRect(m);
      const next = new Set(
        e.shiftKey ? propsRef.current.selectedShapeIds : new Set<string>()
      );
      for (const layer of LAYER_DRAW_ORDER) {
        if (propsRef.current.layerHidden[layer]) continue;
        if (propsRef.current.layerSelectable[layer] === false) continue;
        const shapes = cellType.layers?.[layer];
        if (!shapes) continue;
        for (const s of shapes) {
          if (shapeIntersectsRect(s, r)) next.add(shapeKey(layer, s.id));
        }
      }
      propsRef.current.onSelect(next);
      redraw();
      return;
    }

    if (d.kind === "rect-draw") {
      const r = liveRectRef.current;
      liveRectRef.current = null;
      if (!r || Math.abs(r.width) < 1 || Math.abs(r.height) < 1) {
        redraw();
        return;
      }
      const layer = propsRef.current.activeLayer;
      const shape = makeRect(r);
      dispatch(buildUpsertShapeAction(cellType, layer, shape));
      redraw();
      return;
    }

    if (d.kind === "move") {
      const live = liveMoveRef.current;
      liveMoveRef.current = null;
      const snap = d.movingSnapshot;
      if (!snap || !live || !d.moved || (live.dx === 0 && live.dy === 0)) {
        redraw();
        return;
      }
      // Build one atomic upsert: each moved shape replaced with its translated
      // copy. Alt-drag instead inserts fresh-id duplicates and leaves the
      // originals where they were.
      let action: AnnotationAction | null = null;
      if (d.duplicateIds) {
        // Bulk-insert per layer.
        const byLayer = new Map<LayerType, LayerShape[]>();
        const newKeys = new Set<string>();
        for (const [key, item] of snap) {
          const moved = translateShape(item.shape, live.dx, live.dy);
          const id = d.duplicateIds.get(key)!;
          const dup = { ...moved, id } as LayerShape;
          let arr = byLayer.get(item.layer);
          if (!arr) {
            arr = [];
            byLayer.set(item.layer, arr);
          }
          arr.push(dup);
          newKeys.add(shapeKey(item.layer, id));
        }
        // Walk the layers in stable order so the action sequence is
        // deterministic (helps if anything ever indexes by it).
        const actions: AnnotationAction[] = [];
        let working = cellType;
        for (const layer of LAYER_DRAW_ORDER) {
          const arr = byLayer.get(layer);
          if (!arr) continue;
          for (const s of arr) {
            const a = buildUpsertShapeAction(working, layer, s);
            actions.push(a);
            if (a.kind === "upsertCellType") working = a.cellType;
          }
        }
        action = actions.length === 1 ? actions[0] : { kind: "batch", actions };
        if (action) dispatch(action);
        propsRef.current.onSelect(newKeys);
      } else {
        const actions: AnnotationAction[] = [];
        let working = cellType;
        for (const [, item] of snap) {
          const moved = translateShape(item.shape, live.dx, live.dy);
          const a = buildUpsertShapeAction(working, item.layer, moved);
          actions.push(a);
          if (a.kind === "upsertCellType") working = a.cellType;
        }
        action = actions.length === 1 ? actions[0] : { kind: "batch", actions };
        if (action) dispatch(action);
      }
      redraw();
      return;
    }

    if (d.kind === "vertex" && d.vertex) {
      const live = liveVertexRef.current;
      liveVertexRef.current = null;
      if (!live || !d.moved) {
        redraw();
        return;
      }
      const parsed = parseShapeKey(d.vertex.key);
      if (parsed) {
        dispatch(buildUpsertShapeAction(cellType, parsed.layer, live.shape));
      }
      redraw();
      return;
    }

    // Click (no drag) branches by tool. Reaching here means kind was null —
    // i.e. the pointer-down landed on a click-only tool (point / polygon).
    if (!d.moved) {
      if (tool === "point") {
        const layer = propsRef.current.activeLayer;
        const shape = makePoint(world);
        dispatch(buildUpsertShapeAction(cellType, layer, shape));
      } else if (tool === "polygon") {
        propsRef.current.onPolyAddVertex(world);
      } else if (tool === "polyline") {
        propsRef.current.onPolylineAddVertex(world);
      }
    }
    redraw();
  };

  // ── Wheel zoom (non-passive so trackpad pinch doesn't paginate) ────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const cssX = e.clientX - rect.left;
      const cssY = e.clientY - rect.top;
      const v = viewRef.current;
      if (e.ctrlKey || e.metaKey) {
        // Zoom about the cursor.
        const wx = v.ox + cssX / v.zoom;
        const wy = v.oy + cssY / v.zoom;
        const zoom = Math.min(
          64,
          Math.max(1e-3, v.zoom * Math.exp(-e.deltaY * WHEEL_ZOOM_FACTOR))
        );
        viewRef.current = { zoom, ox: wx - cssX / zoom, oy: wy - cssY / zoom };
      } else {
        viewRef.current = {
          ...v,
          ox: v.ox + e.deltaX / v.zoom,
          oy: v.oy + e.deltaY / v.zoom
        };
      }
      redraw();
    };
    const preventGesture = (e: Event) => e.preventDefault();
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("gesturestart", preventGesture, { passive: false });
    canvas.addEventListener("gesturechange", preventGesture, { passive: false });
    canvas.addEventListener("gestureend", preventGesture, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("gesturestart", preventGesture);
      canvas.removeEventListener("gesturechange", preventGesture);
      canvas.removeEventListener("gestureend", preventGesture);
    };
  }, [redraw]);

  // ── Local keyboard (Esc / Enter / Delete / ⌘C ⌘V) ──────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Bail on inputs / contenteditable.
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
      ) {
        return;
      }
      const { activeTool, polyDraft, polylineDraft } = propsRef.current;
      if (e.key === "Escape") {
        // Cancel order: rect-draft > polygon-draft > clear selection > leave
        // tool to select.
        if (liveRectRef.current) {
          liveRectRef.current = null;
          redraw();
          return;
        }
        if (activeTool === "polygon" && polyDraft.length > 0) {
          propsRef.current.onPolyCancel();
          return;
        }
        if (activeTool === "polyline" && polylineDraft.length > 0) {
          propsRef.current.onPolylineCancel();
          return;
        }
        if (propsRef.current.selectedShapeIds.size > 0) {
          propsRef.current.onSelect(new Set());
          return;
        }
        propsRef.current.onEscape();
        return;
      }
      if (e.key === "Enter" && activeTool === "polygon" && polyDraft.length >= 3) {
        e.preventDefault();
        propsRef.current.onPolyCommit();
        return;
      }
      if (e.key === "Enter" && activeTool === "polyline" && polylineDraft.length >= 2) {
        e.preventDefault();
        propsRef.current.onPolylineCommit();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && !e.metaKey && !e.ctrlKey) {
        const sel = propsRef.current.selectedShapeIds;
        if (sel.size === 0) return;
        e.preventDefault();
        const removals: Array<{ layer: LayerType; id: string }> = [];
        for (const k of sel) {
          const p = parseShapeKey(k);
          if (p) removals.push(p);
        }
        const action = buildRemoveShapesAction(propsRef.current.cellType, removals);
        if (action) propsRef.current.dispatch(action);
        propsRef.current.onSelect(new Set());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [redraw]);

  // ── Drawing ────────────────────────────────────────────────────────
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const { w: cw, h: ch } = sizeRef.current;
    canvas.width = Math.max(1, Math.round(cw * dpr));
    canvas.height = Math.max(1, Math.round(ch * dpr));
    canvas.style.width = `${cw}px`;
    canvas.style.height = `${ch}px`;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#1a1a18";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const v = viewRef.current;
    const box = {
      w: cellType.cropRect.width,
      h: cellType.cropRect.height
    };

    // World → device transform (no per-instance rotation here: layer shapes
    // are stored in the canonical, un-rotated cell-local frame and the image
    // is rotated in-place inside that frame).
    ctx.setTransform(dpr * v.zoom, 0, 0, dpr * v.zoom, -v.ox * v.zoom * dpr, -v.oy * v.zoom * dpr);

    // ── Hover dim setup ───────────────────────────────────────────────
    //
    // When the user is hovering a right-panel row (or a schematic element),
    // dim everything that ISN'T a hover target so the highlighted shapes
    // pop. We compute the hover set once here and skip dimming once a drag
    // has ACTUALLY moved (the sub-region cache and live-edit transforms
    // wouldn't line up at the drag offset). Importantly: a stationary
    // pointer-down without movement also primes liveMove/liveVertex refs,
    // but the cached extraction is still valid in that state — gating on
    // `drag.moved` instead of `liveMove != null` keeps the inferred
    // colours visible across a normal click-select.
    //
    // `dimNonHovered` lets the page disable the dim pass when the hover
    // source is the canvas cursor itself (the steel-blue halo alone is
    // enough feedback — full-image dim while mousing across is jarring).
    // When false: `hovering` is held false, so the dim pass is skipped
    // AND the bright re-draw is skipped (everything renders normally in
    // the first pass), while the halo stroke below still paints because
    // it's gated on `hoveredShapeIds?.size > 0`, not on `hovering`.
    const inflightForDim = dragRef.current?.moved === true;
    const hoveredKeys = hoveredShapeIds ?? new Set<string>();
    const hoveredParentDiffIds = new Set<string>();
    for (const key of hoveredKeys) {
      const p = parseShapeKey(key);
      if (p?.layer === "diffusion") hoveredParentDiffIds.add(p.id);
    }
    const hovering = !inflightForDim && dimNonHovered && hoveredKeys.size > 0;
    const DIM_ALPHA = 0.35;

    // ── Image (canonical orientation — no per-instance rotation) ──────
    // Instance rotation/flip is handled at the die level (merged cells,
    // die viewer). The Cell RE editor always shows the cell type in its
    // original unrotated frame so drawing layers and the background
    // image stay aligned regardless of how instances are placed on die.
    const img = getImage(imageUrl);
    const baseVisible = useOverlayLayers.getState().baseImageVisible;
    if (hovering) ctx.globalAlpha = DIM_ALPHA;
    if (baseVisible && img) {
      ctx.imageSmoothingEnabled = v.zoom < 3;
      ctx.drawImage(img, 0, 0, box.w, box.h);
    } else if (img) {
      // Base image hidden via Space+B — show only overlays below.
    } else {
      ctx.fillStyle = "rgba(255,255,255,0.04)";
      ctx.fillRect(0, 0, box.w, box.h);
    }
    // Die-viewer overlay (wires, vias) — lives in die-world coordinates,
    // so apply instance orientation to match the physical layout.
    if (cell && annotations) {
      const cellDieRect: Rect = {
        x: cell.x,
        y: cell.y,
        width: box.w,
        height: box.h
      };
      ctx.save();
      ctx.translate(box.w / 2, box.h / 2);
      ctx.rotate(((cell.rotation ?? 0) * Math.PI) / 180);
      ctx.scale(cell.flippedH ? -1 : 1, cell.flippedV ? -1 : 1);
      ctx.translate(-box.w / 2, -box.h / 2);
      ctx.translate(-cell.x, -cell.y);
      drawDieOverlay(ctx, annotations, cellDieRect, v.zoom, {
        hideWires: layerHidden["_dvWires"] === true,
        hideVias: layerHidden["_dvVias"] === true
      });
      ctx.restore();
    }

    // ── Overlay images (clipped to cell area) ────────────────────────
    // Draw each non-hidden overlay composited at its world offset,
    // clipped to the cell's die rect so it aligns with the crop image.
    if (cell) {
      const overlayLayerList = useOverlayLayers.getState().layers;
      for (const entry of overlayLayerList) {
        if (!entry.image || entry.hidden || entry.opacity <= 0) continue;
        const img = entry.image;
        // Source rect within the overlay image that corresponds to
        // this cell's position on the die.
        const srcX = cell.x - entry.offsetX;
        const srcY = cell.y - entry.offsetY;
        if (srcX + box.w <= 0 || srcY + box.h <= 0 ||
            srcX >= img.naturalWidth || srcY >= img.naturalHeight) continue;
        ctx.save();
        ctx.globalAlpha = entry.opacity;
        ctx.drawImage(img, srcX, srcY, box.w, box.h, 0, 0, box.w, box.h);
        ctx.restore();
      }
    }

    // Cell-type bounding rect (constant-screen-px stroke).
    ctx.strokeStyle = "rgba(245,214,138,0.5)";
    ctx.lineWidth = 1 / v.zoom;
    ctx.strokeRect(0, 0, box.w, box.h);

    // ── Layer shapes ──────────────────────────────────────────────────
    const tile: TileBounds = {
      size: 0,
      i: 0,
      j: 0,
      world: { x: 0, y: 0, width: 0, height: 0 },
      dpr,
      zoom: v.zoom
    };
    const liveMove = liveMoveRef.current;
    const liveVertex = liveVertexRef.current;
    const drag = dragRef.current;
    const moving = drag?.kind === "move" ? drag.movingSnapshot : null;
    const duplicating = drag?.kind === "move" ? drag.duplicateIds : null;

    // ── Extraction-driven coloring hints ──────────────────────────────
    //
    // Two sources of inferred colour, both routed through the existing
    // `shape.label` → `COLOR_LABEL` path so the cell uses the same red/blue
    // palette the user already sees from "Force P/N":
    //
    //   1. Any shape in a net that resolved to label "vcc"/"gnd"/"io" gets
    //      that label injected for rendering (only when the shape doesn't
    //      already carry one — user-set labels always win).
    //   2. The diffusion sub-regions returned by step 1 of the pipeline
    //      replace the original diffusion shape: same fill colour as the
    //      net-label propagation would produce, but each S/D pad becomes a
    //      separate visual region so the gate cuts are obvious.
    //
    // Both are suppressed once the drag has actually moved — the cached
    // sub-region polygons are stale at the drag offset, so we'd be painting
    // at the old location. A pointer-down without movement (a normal
    // click-to-select) leaves the inferred view intact: `inflightForDim`
    // above gates on the same `drag.moved` flag.
    const inferred =
      !inflightForDim && extraction && extraction.kind === "inferred"
        ? (extraction as InferredCellExtraction)
        : null;
    // Terminal labels: contact-point markers for analog devices.
    // Extracted devices carry _termPoints from the shared pipeline
    // (extractAnalogDevicesFromCellType → resolveDeviceContacts).
    // Draw them on top of everything when zoom is sufficient.
    const analogDevices: (AnalogDevice & { _termPoints?: Array<{x:number;y:number;name:string}> })[] =
      (inferred as any)?.analogDevices ?? [];
    const inferredLabel = new Map<string, ShapeLabel>();
    const hideOriginalDiff = new Set<string>();
    const subRegionDraws: Array<{
      id: string;
      parentDiffId: string;
      polygon: Point[];
      label?: ShapeLabel;
    }> = [];
    // Sub-region role colouring (VCC/GND tint from diffusion P/N type) is
    // intentionally always-on: it's the primary visual signal for the cell's
    // power structure, and the per-device overlay toggles above already
    // give users a way to unclutter the device labels independently.
    if (inferred) {
      // Non-diffusion shape colouring comes from the net's propagated label:
      // a metal/poly/contact/via that ended up in the VCC net should display
      // as VCC. Sub-regions don't go through this branch — even when a
      // middle sub-region's net is an internal stack node, the whole
      // diffusion body sits in a single well biased to VCC or GND, so per-
      // sub-region net labels would only colour the rail-touching ones and
      // leave the middle pads orange. Those use the parent-type rule below.
      const labelByNetId = new Map<number, ShapeLabel>();
      for (const n of inferred.nets) {
        if (n.label) labelByNetId.set(n.id, n.label);
      }
      for (const s of inferred.shapes) {
        if (s.parentDiffId) continue;
        const l = labelByNetId.get(s.netId);
        if (l) inferredLabel.set(s.id, l);
      }
      // Sub-regions: colour is driven by the parent diffusion's inferred
      // P/N type (P → "vcc" red, N → "gnd" blue, unknown → no override).
      // This way EVERY sub-region of one diffusion reads the same colour,
      // regardless of which transistor S/D net each one ended up on.
      const typeByDiff = new Map(
        inferred.diffusions.map((d) => [d.shapeId, d.type]),
      );
      for (const s of inferred.shapes) {
        if (!s.parentDiffId) continue;
        hideOriginalDiff.add(s.parentDiffId);
        const type = typeByDiff.get(s.parentDiffId);
        const label: "vcc" | "gnd" | undefined =
          type === "p" ? "vcc" : type === "n" ? "gnd" : undefined;
        if (label) inferredLabel.set(s.id, label);
        subRegionDraws.push({
          id: s.id,
          parentDiffId: s.parentDiffId,
          polygon: s.polygon,
          label,
        });
      }
    }

    // Main pass — wrapped in a save so the optional hover dim doesn't leak
    // into the halos / handles drawn afterwards. Hovered shapes are skipped
    // here (so they don't render at dim alpha) and re-drawn at full alpha
    // in the bright pass further down.
    ctx.save();
    if (hovering) ctx.globalAlpha = DIM_ALPHA;
    const resistorOpacity = usePreferences.getState().resistorOpacity;
    drawCellLayers(ctx, cellType.layers, tile, {
      isHidden: (layer) => layerHidden[layer] === true,
      layerAlpha: (layer) => {
        if (resistorOpacity < 1 && (
          layer === "resistor_body" || layer === "polysilicon" ||
          layer === "base" || layer === "emitter" ||
          layer === "hsr" || layer === "film"
        )) return resistorOpacity;
        return undefined;
      },
      replaceShape: (_layer, s) => {
        if (_layer === "diffusion" && hideOriginalDiff.has(s.id)) return null;
        if (hovering && hoveredKeys.has(shapeKey(_layer, s.id))) return null;
        const key = shapeKey(_layer, s.id);
        let shape: LayerShape = s;
        if (liveVertex && liveVertex.key === key) shape = liveVertex.shape;
        else if (moving && moving.has(key) && !duplicating && liveMove)
          shape = translateShape(s, liveMove.dx, liveMove.dy);
        if (!shape.label) {
          const l = inferredLabel.get(s.id);
          if (l) shape = { ...shape, label: l } as LayerShape;
        }
        return shape;
      }
    });

    // Diffusion sub-region overlays. Sit at the same z-order as the original
    // diffusion they replace. Sub-regions whose parent is hovered are
    // skipped here and redrawn at full alpha below.
    if (inferred && !layerHidden["diffusion"]) {
      for (const sub of subRegionDraws) {
        if (hovering && hoveredParentDiffIds.has(sub.parentDiffId)) continue;
        const polyShape = {
          id: sub.id,
          kind: "polygon",
          points: sub.polygon,
          label: sub.label,
        } as LayerShape;
        applyShapeStyle(ctx, "diffusion", polyShape);
        drawShape(ctx, polyShape, tile);
      }
    }
    ctx.restore();

    // ── Bright re-draw of hovered shapes ──────────────────────────────
    //
    // Paint every hovered shape (and the sub-regions of any hovered
    // diffusion) at full opacity so they pop above the faded background.
    // Mirrors the dim pass's per-shape transform + label injection so the
    // same shape renders identically in both passes, only at different alpha.
    if (hovering) {
      for (const key of hoveredKeys) {
        const r = resolveKey(key);
        if (!r) continue;
        // Originals hidden in favour of sub-regions — those are repainted
        // in the sub-region block below.
        if (r.layer === "diffusion" && hideOriginalDiff.has(r.shape.id)) continue;
        let shape: LayerShape = r.shape;
        if (liveVertex && liveVertex.key === key) shape = liveVertex.shape;
        else if (moving && moving.has(key) && !duplicating && liveMove)
          shape = translateShape(r.shape, liveMove.dx, liveMove.dy);
        if (!shape.label) {
          const l = inferredLabel.get(r.shape.id);
          if (l) shape = { ...shape, label: l } as LayerShape;
        }
        applyShapeStyle(ctx, r.layer, shape);
        drawShape(ctx, shape, tile);
      }
      if (inferred && !layerHidden["diffusion"]) {
        for (const sub of subRegionDraws) {
          if (!hoveredParentDiffIds.has(sub.parentDiffId)) continue;
          const polyShape = {
            id: sub.id,
            kind: "polygon",
            points: sub.polygon,
            label: sub.label,
          } as LayerShape;
          applyShapeStyle(ctx, "diffusion", polyShape);
          drawShape(ctx, polyShape, tile);
        }
      }
    }
    // Alt-drag duplicates: fresh-id copies painted at the dragged offset, in
    // their source layer's color. Grouped by layer so we don't churn the
    // canvas fill/stroke between shapes.
    if (duplicating && moving && liveMove) {
      const byLayer = new Map<LayerType, LayerShape[]>();
      for (const [key, item] of moving) {
        const dupId = duplicating.get(key);
        if (!dupId) continue;
        const moved = translateShape(item.shape, liveMove.dx, liveMove.dy);
        const list = byLayer.get(item.layer) ?? [];
        list.push({ ...moved, id: dupId } as LayerShape);
        byLayer.set(item.layer, list);
      }
      for (const [layer, shapes] of byLayer) {
        if (layerHidden[layer]) continue;
        for (const s of shapes) {
          applyShapeStyle(ctx, layer, s);
          drawShape(ctx, s, tile);
        }
      }
    }

    // ── Hover halos (right-panel row highlight) ──────────────────────
    //
    // Painted BEFORE the selection halos so selection visually dominates
    // when both fire on the same shape. Steel-blue + thinner stroke so it
    // reads as "look here" without competing with the amber selection.
    if (hoveredShapeIds && hoveredShapeIds.size > 0) {
      ctx.strokeStyle = "#7fb2ff";
      ctx.lineWidth = 1.5 / v.zoom;
      for (const key of hoveredShapeIds) {
        const r = resolveKey(key);
        if (!r) continue;
        strokeShape(ctx, r.shape, v.zoom);
      }
    }

    // ── Selection halos (amber outline) ───────────────────────────────
    ctx.strokeStyle = SELECT_COLOR;
    ctx.lineWidth = 2 / v.zoom;
    for (const key of selectedShapeIds) {
      const r = resolveKey(key);
      if (!r) continue;
      let shape = r.shape;
      if (liveVertex && liveVertex.key === key) shape = liveVertex.shape;
      else if (moving && moving.has(key) && !duplicating && liveMove)
        shape = translateShape(shape, liveMove.dx, liveMove.dy);
      strokeShape(ctx, shape, v.zoom);
    }
    // For alt-drag duplicates: outline the *duplicates* in the active accent
    // (they're the things that will be selected after release).
    if (duplicating && moving && liveMove) {
      for (const [, item] of moving) {
        const moved = translateShape(item.shape, liveMove.dx, liveMove.dy);
        strokeShape(ctx, moved, v.zoom);
      }
    }

    // ── Drag handles for single-shape selection ───────────────────────
    if (selectedShapeIds.size === 1) {
      const only = selectedShapeIds.values().next().value as string;
      const cur = resolveKey(only);
      if (cur) {
        let displayShape = cur.shape;
        if (liveVertex && liveVertex.key === only) displayShape = liveVertex.shape;
        else if (moving && moving.has(only) && !duplicating && liveMove)
          displayShape = translateShape(cur.shape, liveMove.dx, liveMove.dy);
        const handles = shapeHandles(displayShape);
        const r = HANDLE_PX / v.zoom / 2;
        ctx.fillStyle = "#fff";
        ctx.strokeStyle = SELECT_COLOR;
        ctx.lineWidth = 1.5 / v.zoom;
        for (const h of handles) {
          ctx.beginPath();
          ctx.rect(h.x - r, h.y - r, r * 2, r * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
    }

    // ── In-progress rect (rubber-band) ────────────────────────────────
    const liveR = liveRectRef.current;
    if (liveR && (Math.abs(liveR.width) > 0 || Math.abs(liveR.height) > 0)) {
      const n = normalizeRect(liveR);
      ctx.strokeStyle = COLOR_LAYER[activeLayer] ?? "#fff";
      ctx.fillStyle = COLOR_LAYER[activeLayer] ?? "rgba(255,255,255,0.1)";
      ctx.globalAlpha = 0.4;
      ctx.fillRect(n.x, n.y, n.width, n.height);
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1.5 / v.zoom;
      ctx.strokeRect(n.x, n.y, n.width, n.height);
    }

    // ── In-progress polygon ───────────────────────────────────────────
    if (activeTool === "polygon" && polyDraft.length > 0) {
      ctx.strokeStyle = COLOR_LAYER[activeLayer] ?? "#fff";
      ctx.lineWidth = 1.5 / v.zoom;
      ctx.beginPath();
      ctx.moveTo(polyDraft[0].x, polyDraft[0].y);
      for (let i = 1; i < polyDraft.length; i++) {
        ctx.lineTo(polyDraft[i].x, polyDraft[i].y);
      }
      if (polyDraft.length >= 3) {
        ctx.closePath();
        ctx.fillStyle = COLOR_LAYER[activeLayer] ?? "rgba(255,255,255,0.1)";
        ctx.globalAlpha = 0.25;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.stroke();
      // Cursor preview edge.
      const cur = cursorRef.current;
      if (cur) {
        const last = polyDraft[polyDraft.length - 1];
        ctx.setLineDash([6 / v.zoom, 4 / v.zoom]);
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        ctx.lineTo(cur.x, cur.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // Vertex dots.
      ctx.fillStyle = COLOR_LAYER[activeLayer] ?? "#fff";
      const dotR = 3 / v.zoom;
      for (const p of polyDraft) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, dotR, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ── In-progress polyline ──────────────────────────────────────────
    if (activeTool === "polyline" && polylineDraft.length > 0) {
      // Convert µm to px; fallback to store value if no umPerPx
      const umPerPxLocal = propsRef.current.umPerPx ?? 1;
      const lwPx = polylineWidth / umPerPxLocal;
      const finalLineWidth = Math.max(lwPx, 0.5);
      ctx.strokeStyle = COLOR_LAYER[activeLayer] ?? "#fff";
      ctx.lineWidth = finalLineWidth;
      ctx.lineCap = "butt"; ctx.lineJoin = "round";
      // Draw committed segments (solid)
      ctx.beginPath();
      ctx.moveTo(polylineDraft[0].x, polylineDraft[0].y);
      for (let i = 1; i < polylineDraft.length; i++) ctx.lineTo(polylineDraft[i].x, polylineDraft[i].y);
      ctx.stroke();
      // Draw preview segment (dashed line to cursor, snapped to H/V)
      const cur = cursorRef.current;
      if (cur) {
        const last = polylineDraft[polylineDraft.length - 1];
        const dx = cur.x - last.x, dy = cur.y - last.y;
        // Snap to nearest 90° axis — uses Math.abs so all 4 quadrants work
        const prevSnapped = Math.abs(dx) > Math.abs(dy)
          ? { x: cur.x, y: last.y }
          : { x: last.x, y: cur.y };
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        ctx.lineTo(prevSnapped.x, prevSnapped.y);
        ctx.setLineDash([6 / v.zoom, 4 / v.zoom]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.lineCap = "butt"; ctx.lineJoin = "miter";
      ctx.fillStyle = COLOR_LAYER[activeLayer] ?? "#fff";
      const dotR = 3 / v.zoom;
      for (const p of polylineDraft) { ctx.beginPath(); ctx.arc(p.x, p.y, dotR, 0, Math.PI * 2); ctx.fill(); }
    }

    // ── Analog device overlay ───────────────────────────────────────
    // Painted on top of everything — at sufficient zoom only. Composed of
    // up to two passes, each gated by its own preference:
    //   1. Instance labels (M1, Q12, R34…) — `reDeviceLabelsVisible`.
    //      Anchored to a per-finger reference point: gate poly centroid
    //      for MOS, gate terminal for BJT, bbox centre for passives.
    //   2. Terminal labels (G/S/D/B/C/E/+/−) — `reTerminalLabelsVisible`.
    //
    // Both overlay toggles + label scale fold into `overlayKey` upstream
    // so this block re-runs on every flip without a remount.
    const prefs = usePreferences.getState();
    const showDeviceLabels = prefs.reDeviceLabelsVisible;
    const showTerminalLabels = prefs.reTerminalLabelsVisible;
    if (analogDevices.length > 0 && v.zoom >= 0.8 && (showDeviceLabels || showTerminalLabels)) {
      const TERM_FONT_SIZE_BASE = 7;
      const TERM_RADIUS = 2.2;
      const TERM_COLORS: Record<string, string> = {
        D: "#ffcc44", S: "#66ee66", G: "#ffffff", B: "#aaaaaa",
        C: "#ff8844", E: "#44dd88",
        PLUS: "#44ddff", MINUS: "#ff6666",
      };
      const DEVICE_COLORS: Record<string, string> = {
        mos: "#4488ff", bjt_npn: "#22cc66", bjt_pnp: "#ff8844",
        resistor: "#ffaa44", capacitor: "#44ddff", diode: "#ff4444",
      };
      // 0=S (0.2x), 1=M (0.5x), 2=L (1.0x). All three are intentionally
      // smaller than the previous defaults so the overlay stays readable
      // in dense layouts without dominating the cell image.
      const SCALE = prefs.reAnalogLabelScale === 0 ? 0.2
                  : prefs.reAnalogLabelScale === 2 ? 1.0
                  : 0.5;
      const TERM_FONT_SIZE = TERM_FONT_SIZE_BASE * SCALE;
      const INST_FONT_SIZE = 8 * SCALE;
      const TYPE_FONT_SIZE = 6 * SCALE;
      // Physical-type label shared between instance-label pass and the row
      // renderer (kept here so the canvas reads identical strings to the
      // panel — reduces drift between the two surfaces).
      const physicalType = (dev: AnalogDevice): string => {
        const g = dev.geometry as unknown as Record<string, unknown>;
        switch (dev.kind) {
          case "mos": {
            const t = g.mosType as string | undefined;
            return t === "pmos" ? "pmos" : t === "nmos" ? "nmos" : "mos";
          }
          case "bjt_npn": return "npn";
          case "bjt_pnp": return "pnp";
          case "jfet_n": return "n-jfet";
          case "jfet_p": return "p-jfet";
          default: return dev.kind;
        }
      };
      for (const dev of analogDevices) {
        const color = DEVICE_COLORS[dev.kind] ?? "#888888";
        const typeStr = physicalType(dev);
        const points = (dev as any)._termPoints as Array<{x:number;y:number;name:string}> | undefined;

        // ── Pass 1: instance labels (per-finger) ───────────────
        // Pick per-finger anchor points so each finger gets its own
        // label. MOS/BJT use terminal contact positions (G/B), passive
        // devices (resistor/capacitor/diode) fall back to bbox centre.
        //
        // Naming: `extractAnalogDevicesFromCellType` already runs a
        // global dedup pass on `instanceName` (so multi-finger sub-
        // devices end up as `M_1`, `M_1_1`, `M_1_2`, `M_1_3`), and the
        // same dedup logic lives in `netlist2svgFormat.ts`. Both
        // surfaces therefore see identical strings — the canvas just
        // prints `dev.instanceName` verbatim, no further suffixing here.
        if (showDeviceLabels) {
          const name = dev.instanceName ?? dev.id.slice(0, 6);
          // Gate-name set is device-kind-specific on purpose: in MOS the
          // terminal `B` means BULK (well-tap contact) and would be picked
          // up by a generic {"G","B"} set, painting a stray instance label
          // on every well tap. BJT uses `B` for base; JFET uses `G`. The
          // set is per-kind so each device type only matches its own
          // control terminal(s).
          const gateNames: Set<string> = (() => {
            switch (dev.kind) {
              case "mos":       return new Set(["G"]);
              case "bjt_npn":
              case "bjt_pnp":   return new Set(["B"]);
              case "jfet_n":
              case "jfet_p":    return new Set(["G"]);
              default:          return new Set();
            }
          })();
          // Prefer the per-sub-device gate poly centroid when available
          // (set by `detectMOSFromLayers` for multi-finger MOS): each
          // finger has its own gate poly even when several fingers share
          // a poly run and one common well-tap contact, so the centroid
          // gives every label a unique anchor and they don't pile up on
          // the same gate-tap point.
          const gateAnchor = (dev as any)._gateAnchor as { x: number; y: number } | undefined;
          const anchors: Array<{ x: number; y: number }> = [];
          if (gateAnchor) {
            anchors.push(gateAnchor);
          } else if (points && points.length > 0) {
            for (const pt of points) {
              if (gateNames.has(pt.name)) anchors.push({ x: pt.x, y: pt.y });
            }
          }
          if (anchors.length === 0 && dev.bbox) {
            anchors.push({
              x: dev.bbox.x + dev.bbox.width / 2,
              y: dev.bbox.y + dev.bbox.height / 2,
            });
          }
          ctx.textBaseline = "alphabetic";
          for (const a of anchors) {
            const labelTop = a.y - 6 / v.zoom;
            const nameMetrics = ctx.measureText(name);
            const typeMetrics = ctx.measureText(typeStr);
            const padX = 3, gap = 1;
            const w = Math.max(nameMetrics.width, typeMetrics.width) + padX * 2;
            const h = INST_FONT_SIZE + TYPE_FONT_SIZE + gap + 3;
            const bx = a.x + 3 / v.zoom;
            const by = labelTop - h;
            ctx.fillStyle = "rgba(0,0,0,0.75)";
            ctx.fillRect(bx, by, w, h);
            ctx.fillStyle = color;
            ctx.font = `700 ${INST_FONT_SIZE}px monospace`;
            ctx.fillText(name, bx + padX, by + INST_FONT_SIZE);
            ctx.fillStyle = "rgba(255,255,255,0.75)";
            ctx.font = `400 ${TYPE_FONT_SIZE}px monospace`;
            ctx.fillText(typeStr, bx + padX, by + INST_FONT_SIZE + TYPE_FONT_SIZE + gap);
          }
        }

        // ── Pass 2: terminal labels (dots + letters) ────────────
        if (!showTerminalLabels) continue;
        if (!points || points.length === 0) continue;
        ctx.font = `600 ${TERM_FONT_SIZE}px monospace`;
        ctx.textBaseline = "middle";
        for (const pt of points) {
          const sx = pt.x, sy = pt.y;
          const dsResolved = (dev as any)._dsResolved === true;
          const displayName = pt.name === "D" || pt.name === "S"
            ? (dsResolved ? pt.name : "S/D")
            : pt.name;
          const tm = ctx.measureText(displayName);
          const tw = tm.width + 4;
          const th = TERM_FONT_SIZE + 4;
          // Dot
          ctx.beginPath();
          ctx.arc(sx, sy, TERM_RADIUS / v.zoom, 0, Math.PI * 2);
          ctx.fillStyle = TERM_COLORS[pt.name] ?? color;
          ctx.fill();
          ctx.strokeStyle = "rgba(0,0,0,0.6)";
          ctx.lineWidth = 0.5 / v.zoom;
          ctx.stroke();
          // Background rect
          ctx.fillStyle = "rgba(0,0,0,0.7)";
          ctx.fillRect(sx + 3, sy - th / 2, tw, th);
          // Label text
          ctx.fillStyle = color;
          ctx.fillText(displayName, sx + 5, sy);
        }
      }
    }

    // ── Marquee rectangle ─────────────────────────────────────────────
    const liveM = liveMarqueeRef.current;
    if (liveM && (Math.abs(liveM.width) > 0 || Math.abs(liveM.height) > 0)) {
      const n = normalizeRect(liveM);
      ctx.fillStyle = "rgba(58, 169, 255, 0.10)";
      ctx.strokeStyle = "rgba(58, 169, 255, 0.95)";
      ctx.lineWidth = 1 / v.zoom;
      ctx.fillRect(n.x, n.y, n.width, n.height);
      ctx.strokeRect(n.x, n.y, n.width, n.height);
    }
  });

  // ── Cursor styling per tool ────────────────────────────────────────
  const cursor = (() => {
    if (spaceRef.current) return "grab" as const;
    if (activeTool === "pan") return "grab" as const;
    if (activeTool === "rect" || activeTool === "polygon" || activeTool === "point" || activeTool === "polyline") {
      return "crosshair" as const;
    }
    return "default" as const;
  })();

  return (
    <div
      ref={hostRef}
      style={{
        position: "relative",
        flex: "1 1 auto",
        minHeight: 0,
        background: "var(--canvas-bg)",
        overflow: "hidden",
        overscrollBehavior: "none"
      }}
    >
      <canvas
        ref={canvasRef}
        tabIndex={0}
        style={{
          display: "block",
          cursor,
          touchAction: "none",
          overscrollBehavior: "none",
          outline: "none"
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => {
          // Cursor left the canvas — clear status/highlight. Only fire if we
          // had a hover (avoids redundant null callbacks while dragging in
          // and out of empty regions).
          if (lastHoverKeyRef.current !== null) {
            lastHoverKeyRef.current = null;
            propsRef.current.onCanvasHover?.(null);
          }
        }}
        onContextMenu={(e) => {
          // We always preempt the OS menu. Then: if we're in select mode and
          // the click landed on a shape, ensure that shape is part of the
          // selection (replace if not, keep multi-select intact otherwise) and
          // notify the page so it can pop the shape menu. Outside select mode
          // — or on empty canvas — we just dismiss any open menu.
          e.preventDefault();
          const cb = propsRef.current.onShapeContextMenu;
          if (!cb) return;
          const tool = propsRef.current.activeTool;
          // Pan / draw tools don't have a useful per-shape menu; respect the
          // current tool's modality and skip the menu entirely.
          if (tool !== "select") {
            cb(null, e.clientX, e.clientY);
            return;
          }
          const canvas = canvasRef.current;
          if (!canvas) return;
          const r = canvas.getBoundingClientRect();
          const world = toWorld(e.clientX - r.left, e.clientY - r.top);
          const hit = hitShape(world);
          if (!hit) {
            cb(null, e.clientX, e.clientY);
            return;
          }
          // If the right-clicked shape isn't already selected, replace-select
          // it (Photoshop-style). Otherwise leave the existing multi-select
          // alone — the menu's plural-aware labels handle the rest.
          const key = shapeKey(hit.layer, hit.shape.id);
          const sel = propsRef.current.selectedShapeIds;
          if (!sel.has(key)) {
            propsRef.current.onSelect(new Set([key]));
          }
          cb(hit, e.clientX, e.clientY);
        }}
      />
    </div>
  );
});

// Tiny re-export shim: the orientation helper lives with `mergeCells` because
// merge owns the flip/rotate workflow, but the RE canvas wants the same
// `(flippedH, flippedV, rotation)` triple when drawing instances oriented to
// the canonical cell-type frame.

/**
 * Find all line segments connected to `seed` in the given layer.
 * Two segments are "connected" if they share an endpoint.
 * Returns a Set of shape keys (layer:id).
 */
function getConnectedLines(
  cellType: CellType,
  layer: LayerType,
  seed: LayerShape
): Set<string> {
  const allShapes = cellType.layers?.[layer] ?? [];
  const lines = allShapes.filter((s) => s.kind === "line") as LayerLine[];
  if (lines.length === 0) return new Set([shapeKey(layer, seed.id)]);
  // Build adjacency: lineId -> Set<neighborId>
  const adj = new Map<string, Set<string>>();
  for (const l of lines) {
    if (!adj.has(l.id)) adj.set(l.id, new Set());
  }
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i], b = lines[j];
      const share =
        (a.x1 === b.x1 && a.y1 === b.y1) ||
        (a.x1 === b.x2 && a.y1 === b.y2) ||
        (a.x2 === b.x1 && a.y2 === b.y1) ||
        (a.x2 === b.x2 && a.y2 === b.y2);
      if (share) {
        adj.get(a.id)!.add(b.id);
        adj.get(b.id)!.add(a.id);
      }
    }
  }
  // BFS from seed.
  const comp = new Set<string>();
  const queue = [seed.id];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (comp.has(id)) continue;
    comp.add(id);
    for (const n of adj.get(id) ?? []) if (!comp.has(n)) queue.push(n);
  }
  return new Set([...comp].map((id) => shapeKey(layer, id)));
}

/** Stroke (outline) a shape for the selection halo. Caller has already set
 *  strokeStyle / lineWidth. */
function strokeShape(
  ctx: CanvasRenderingContext2D,
  shape: LayerShape,
  zoom: number
): void {
  switch (shape.kind) {
    case "rect":
      ctx.strokeRect(shape.x, shape.y, shape.width, shape.height);
      return;
    case "point": {
      const r = Math.max(shape.size / 2, 3 / zoom);
      ctx.beginPath();
      ctx.arc(shape.x, shape.y, r + 1.5 / zoom, 0, Math.PI * 2);
      ctx.stroke();
      return;
    }
    case "polygon":
      if (shape.points.length === 0) return;
      ctx.beginPath();
      ctx.moveTo(shape.points[0].x, shape.points[0].y);
      for (let i = 1; i < shape.points.length; i++) {
        ctx.lineTo(shape.points[i].x, shape.points[i].y);
      }
      ctx.closePath();
      ctx.stroke();
      return;
    case "circle":
      ctx.beginPath();
      ctx.arc(shape.x, shape.y, shape.radius, 0, Math.PI * 2);
      ctx.stroke();
      return;
    case "line":
      ctx.beginPath();
      ctx.moveTo(shape.x1, shape.y1);
      ctx.lineTo(shape.x2, shape.y2);
      ctx.stroke();
      return;
  }
}

// ── Die-viewer overlay ─────────────────────────────────────────────────

/** Screen-px stroke for overlay wires — kept thin so they don't dominate the
 *  imagery, and constant on-screen via the `/zoom` factor. */
const DV_WIRE_PX = 1.5;
const DV_NODE_PX = 2.5;
const DV_POINT_VIA_PX = 3;

/**
 * Paint die-viewer wires + vias clipped to `cellDieRect` (so we only draw
 * the items actually intersecting this cell). Caller has already placed the
 * transform into die-coord space (i.e. `ctx.translate(-cell.x, -cell.y)`
 * inside the cell's image-orientation frame), so this function just iterates
 * `annotations` and draws raw die coordinates.
 *
 * Visibility is per-feature (wires / vias) rather than a single die-viewer
 * toggle so the user can keep the wire skeleton on while turning off via
 * dots when annotating a noisy cell, and vice versa.
 */
function drawDieOverlay(
  ctx: CanvasRenderingContext2D,
  annotations: DieAnnotations,
  cellDieRect: Rect,
  zoom: number,
  options: { hideWires?: boolean; hideVias?: boolean } = {}
): void {
  // ── Wires ─────────────────────────────────────────────────────────
  if (!options.hideWires) {
    const prevCap = ctx.lineCap;
    ctx.lineCap = "round";
    ctx.lineWidth = DV_WIRE_PX / zoom;
    const nodeRadius = DV_NODE_PX / zoom;
    for (const net of annotations.nets) {
      // Skip nets whose entire bbox sits outside the cell — cheap reject
      // before the per-node lookup.
      let any = false;
      for (const n of net.nodes) {
        if (pointInRect(n, cellDieRect)) {
          any = true;
          break;
        }
      }
      // Also check edge intersection in case a long wire passes through
      // without an endpoint in the cell.
      if (!any) {
        const nodeMap = new Map(net.nodes.map((n) => [n.id, n]));
        for (const e of net.edges) {
          const a = nodeMap.get(e.from);
          const b = nodeMap.get(e.to);
          if (a && b && segmentIntersectsRect(a, b, cellDieRect)) {
            any = true;
            break;
          }
        }
      }
      if (!any) continue;

      const nodeById = new Map(net.nodes.map((n) => [n.id, n]));
      // Edges first so node dots sit on top of the wire ends.
      for (const edge of net.edges) {
        const from = nodeById.get(edge.from);
        const to = nodeById.get(edge.to);
        if (!from || !to) continue;
        if (!segmentIntersectsRect(from, to, cellDieRect)) continue;
        ctx.strokeStyle =
          (edge.layer && WIRE_LAYER_COLOR[edge.layer]) || NET_COLOR;
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
      }
      ctx.fillStyle = NET_COLOR;
      for (const node of net.nodes) {
        if (!pointInRect(node, cellDieRect)) continue;
        ctx.beginPath();
        ctx.arc(node.x, node.y, nodeRadius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.lineCap = prevCap;
  }

  // ── Vias (ML / human annotations) ─────────────────────────────────
  if (!options.hideVias && annotations.annotations) {
    ctx.lineWidth = 1 / zoom;
    for (const a of annotations.annotations) {
      const g = a.geometry;
      if (g.kind === "point") {
        if (!pointInRect(g, cellDieRect)) continue;
        const r = DV_POINT_VIA_PX / zoom;
        ctx.fillStyle = COLOR_VIA;
        ctx.beginPath();
        ctx.arc(g.x, g.y, r, 0, Math.PI * 2);
        ctx.fill();
      } else if (g.kind === "rectangle") {
        if (!rectsIntersect(g, cellDieRect)) continue;
        ctx.fillStyle = COLOR_VIA_FILL;
        ctx.strokeStyle = COLOR_VIA;
        ctx.fillRect(g.x, g.y, g.width, g.height);
        ctx.strokeRect(g.x, g.y, g.width, g.height);
      } else if (g.kind === "polygon") {
        const b = polygonBounds(g.points);
        if (!b || !rectsIntersect(b, cellDieRect)) continue;
        ctx.fillStyle = COLOR_VIA_FILL;
        ctx.strokeStyle = COLOR_VIA;
        ctx.beginPath();
        ctx.moveTo(g.points[0].x, g.points[0].y);
        for (let i = 1; i < g.points.length; i++) {
          ctx.lineTo(g.points[i].x, g.points[i].y);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      // polyline geometry only occurs for `trace`, which isn't persisted.
    }
  }
}

