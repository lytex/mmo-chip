import { create } from "zustand";
import type { DieMLConfig } from "shared";
import type { AnnotationAction } from "../api/actions";
import type { WireClipboard } from "../lib/wireClipboard";

/** Which right-panel tab is showing. The ML tab also drives a render mode:
 *  traces/vias size from `mlConfig` instead of display preferences. */
export type InspectorTab = "inspector" | "ml" | "cv" | "ai";

/** Mockup defaults for the ML config until a real per-die value is seeded
 *  from the annotations blob. Source-pixel units. */
export const DEFAULT_ML_CONFIG: DieMLConfig = {
  pointViaSize: 6,
  traceWidth: 8
};

/** Analog layer ids selectable from the die-viewer layer palette. */
export type AnalogLayerId =
  | "nwell" | "pwell" | "deep_nwell" | "buried_layer"
  | "base" | "emitter" | "collector_sinker"
  | "jfet_gate" | "jfet_channel"
  | "resistor_body"
  | "capacitor_bottom" | "capacitor_top"
  | "npn_id" | "pnp_id" | "lpnp_id" | "vpnp" | "res_id" | "cap_id" | "diode_id"
  | "collector" | "bulk"
  | "metal3" | "metal4" | "metal5" | "metal6";

export type ToolKind =
  | "select"
  | "pan"
  | "wire"
  | "multiWire"
  | "via"
  | "viaRect"
  | "viaPoly"
  | "addCell"
  | "cellGuideLine"
  | "cellGuideSeg"
  | "ioPoint"
  | "roi"
  | "ignore"
  | "measure"
  | "comment"
  | "floorplan"
  | "analogRect"
  | "analogPoly";

/**
 * Modes for `select`:
 *  - "replace": clear and select only these ids
 *  - "add":     add these ids to the current set
 *  - "toggle":  flip membership for each id
 */
export type SelectMode = "replace" | "add" | "toggle";

/**
 * A transient capture of the global undo/redo keystroke. While a tool is in a
 * sub-state with its own stepwise history (e.g. an in-progress wire draft),
 * it registers an override here; the global ⌘Z handler routes to it instead
 * of the action dispatcher. Cleared when the sub-state ends.
 */
export interface UndoOverride {
  undo: () => void;
  redo: () => void;
}

interface DieViewerState {
  /** Currently selected annotation ids. */
  selectedIds: ReadonlySet<string>;
  /** Outline-tree sub-groups (e.g. cell types) currently expanded. Scoped to
   *  the current die session — not persisted because group ids are die-specific. */
  expandedGroups: string[];
  /** Tool currently selected in the sub-toolbar. */
  activeTool: ToolKind;
  /** Active analog layer for analogRect/analogPoly tools. */
  activeAnalogLayer: AnalogLayerId;
  /** Actions the user has applied, newest at the end. */
  undoStack: AnnotationAction[];
  /** Actions that were undone and can be redone, newest at the end. */
  redoStack: AnnotationAction[];
  /** When set, the global ⌘Z/⌘⇧Z handler defers to this instead of the
   *  action dispatcher (e.g. per-point undo while drawing a wire). */
  undoOverride: UndoOverride | null;
  /** Active metal id (ME1, ME2, …) for the wire / multi-wire tools.
   *  `null` = the "unknown" layer (edges store no `layer`). */
  activeMetalId: string | null;
  /** Active via id (VIA12, VIA23, …) for via placement. */
  activeViaId: string | null;
  /** Orientation for the cell-grid guide-line tool: "x" = vertical line
   *  (fixed x), "y" = horizontal line (fixed y). */
  guideAxis: "x" | "y";
  /** Ruler tool measurement mode. "free" = draw at any angle;
   *  "h" = horizontal only; "v" = vertical only. */
  measureMode: "free" | "h" | "v" | "ortho" | "diag";
  /** Ruler label display preferences. */
  showRulerPx: boolean;
  showRulerUm: boolean;
  showRulerNm: boolean;
  /** Draft ML config edited from the ML tab (mockup: client-side, seeded from
   *  the die's `annotations.mlConfig`). Source-pixel units. */
  mlConfig: DieMLConfig;
/** Total ML vias currently held in the `MLViasLayer` cache — bumped by the
 *  layer as tiles load (and reset when the cache is cleared on a model
 *  switch). Lets the outline panel surface a live cardinality without
 *  having to walk the cache itself. Partial: it's the count for tiles
 *  fetched so far this session, not a die-wide ground truth. */
  mlViasCount: number;
  /** Copied cell data for paste (cellTypeId + orientation, no position). */
  clipboardCells: { cellTypeId: string; offsetX: number; offsetY: number; flippedV?: boolean; flippedH?: boolean; rotation?: 0 | 90 | 180 | 270 }[];
  clipboardWires: WireClipboard | null;
}

interface DieViewerActions {
  select: (ids: Iterable<string>, mode?: SelectMode) => void;
  clearSelection: () => void;
  toggleGroup: (id: string) => void;
  setActiveTool: (tool: ToolKind) => void;
  setActiveAnalogLayer: (layer: AnalogLayerId) => void;
  pushUndo: (action: AnnotationAction) => void;
  popUndo: () => AnnotationAction | undefined;
  pushRedo: (action: AnnotationAction) => void;
  popRedo: () => AnnotationAction | undefined;
  clearRedo: () => void;
  /** Register / clear the global-undo override (see `UndoOverride`). */
  setUndoOverride: (override: UndoOverride | null) => void;
  setActiveMetalId: (id: string | null) => void;
  setActiveViaId: (id: string | null) => void;
  setGuideAxis: (axis: "x" | "y") => void;
  setMeasureMode: (mode: "free" | "h" | "v" | "ortho" | "diag") => void;
  setRulerDisplay: (patch: Partial<Pick<DieViewerState, "showRulerPx" | "showRulerUm" | "showRulerNm">>) => void;
  /** Patch the draft ML config (one or more fields). */
  setMlConfig: (patch: Partial<DieMLConfig>) => void;
  /** Set the live ML-via cardinality — called by the layer when tiles load. */
  setMlViasCount: (count: number) => void;
  /** Copy selected cell instance(s) to clipboard. */
  copyCells: (cells: { cellTypeId: string; offsetX: number; offsetY: number; flippedV?: boolean; flippedH?: boolean; rotation?: 0 | 90 | 180 | 270 }[]) => void;
  setWireClipboard: (clipboard: WireClipboard) => void;
  clearWireClipboard: () => void;
  /** Clear cell clipboard. */
  clearCellClipboard: () => void;
  /** Wipe transient state — called when navigating to a different die. */
  reset: () => void;
}

const EMPTY_SELECTION: ReadonlySet<string> = new Set();

const INITIAL_STATE: DieViewerState = {
  selectedIds: EMPTY_SELECTION,
  expandedGroups: [],
  activeTool: "select",
  activeAnalogLayer: "nwell",
  undoStack: [],
  redoStack: [],
  undoOverride: null,
  activeMetalId: null,
  activeViaId: null,
  guideAxis: "x",
  measureMode: "ortho",
  showRulerPx: false,
  showRulerUm: true,
  showRulerNm: false,
  mlConfig: { ...DEFAULT_ML_CONFIG },
  mlViasCount: 0,
  clipboardCells: [],
  clipboardWires: null
};

/**
 * Per-session UI state for the Die viewer. Hot-path values (pan/zoom,
 * cursor position) intentionally do NOT live here — they're handled via
 * `LiveValue` stores in the page, which rAF-coalesce and don't re-render
 * react components on every event.
 */
export const useDieViewerStore = create<DieViewerState & DieViewerActions>()((set, get) => ({
  ...INITIAL_STATE,

  select: (ids, mode = "replace") => {
    const incoming = Array.from(ids);
    const current = get().selectedIds;
    let next: Set<string>;
    if (mode === "replace") {
      next = new Set(incoming);
    } else if (mode === "add") {
      next = new Set(current);
      for (const id of incoming) next.add(id);
    } else {
      next = new Set(current);
      for (const id of incoming) {
        if (next.has(id)) next.delete(id);
        else next.add(id);
      }
    }
    if (setsEqual(current, next)) return;
    set({ selectedIds: next });
  },
  clearSelection: () => {
    if (get().selectedIds.size === 0) return;
    set({ selectedIds: EMPTY_SELECTION });
  },
  toggleGroup: (id) =>
    set((state) => ({
      expandedGroups: state.expandedGroups.includes(id)
        ? state.expandedGroups.filter((g) => g !== id)
        : [...state.expandedGroups, id]
    })),
  // Switching to any non-select tool drops the current selection, so the
  // user never has to Escape before starting to draw.
  setActiveTool: (tool) =>
    set((state) => ({
      activeTool: tool,
      selectedIds:
        tool === "select" || state.selectedIds.size === 0
          ? state.selectedIds
          : EMPTY_SELECTION
    })),

  pushUndo: (action) =>
    set((state) => ({ undoStack: [...state.undoStack, action] })),
  popUndo: () => {
    const stack = get().undoStack;
    if (stack.length === 0) return undefined;
    const top = stack[stack.length - 1];
    set({ undoStack: stack.slice(0, -1) });
    return top;
  },
  pushRedo: (action) =>
    set((state) => ({ redoStack: [...state.redoStack, action] })),
  popRedo: () => {
    const stack = get().redoStack;
    if (stack.length === 0) return undefined;
    const top = stack[stack.length - 1];
    set({ redoStack: stack.slice(0, -1) });
    return top;
  },
  clearRedo: () => set({ redoStack: [] }),
  setUndoOverride: (override) => set({ undoOverride: override }),
  setActiveAnalogLayer: (layer) => set({ activeAnalogLayer: layer }),
  setActiveMetalId: (id) => set({ activeMetalId: id }),
  setActiveViaId: (id) => set({ activeViaId: id }),
  setGuideAxis: (axis) => set({ guideAxis: axis }),
  setMeasureMode: (mode) => set({ measureMode: mode }),
  setRulerDisplay: (patch) => set(patch),
  setMlConfig: (patch) =>
    set((state) => ({ mlConfig: { ...state.mlConfig, ...patch } })),
  setMlViasCount: (count) => {
    if (get().mlViasCount === count) return;
    set({ mlViasCount: count });
  },

  copyCells: (cells) => set({ clipboardCells: cells }),
  setWireClipboard: (clipboard) => set({ clipboardWires: clipboard }),
  clearWireClipboard: () => set({ clipboardWires: null }),
  clearCellClipboard: () => set({ clipboardCells: [] }),

  reset: () => set(INITIAL_STATE)
}));

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}
