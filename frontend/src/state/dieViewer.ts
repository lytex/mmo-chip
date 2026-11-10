import { create } from "zustand";
import type { AnnotationRect, DieMLConfig, TraceRegion } from "shared";
import type { AnnotationAction } from "../api/actions";
import type { WireClipboard } from "../lib/wireClipboard";
import type { PinClip } from "../lib/pinClipboard";
import type { FloorplanClip } from "../lib/floorplanClipboard";

/** Which right-panel tab is showing. The ML tab also drives a render mode:
 *  traces/vias size from `mlConfig` instead of display preferences. The
 *  tab bar renders in TWO rows (Inspector/ML/Cells/CV/AI/Lib, then
 *  Trace/MCP) — one row overflowed and produced a stray width scrollbar. */
export type InspectorTab = "inspector" | "ml" | "cells" | "cv" | "ai" | "lib" | "mcp" | "trace";

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
  | "libraryCell"
  | "analogCell"
  | "roi"
  | "ignore"
  | "measure"
  | "comment"
  | "floorplan"
  | "analogRect"
  | "analogPoly"
  | "traceRegionRect"
  | "traceRegionPoly"
  | "traceBlockage";

/**
 * P2-2: a committed vectorize trace region (now persisted per die in
 * `annotations.traceRegions`, see shared/types `TraceRegion`). Kept as an
 * alias so existing call sites keep working.
 */
export type VectorTraceRegion = TraceRegion;

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
  /** Die the undo / redo stacks belong to. The history is shared by the die
   *  viewer, Merge cells and RE cell pages of that die (switching between them
   *  keeps it); opening another die starts a fresh one. */
  historyDieId: string | null;
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
  /** Live status of the classical vectorize overlay (VectorSection): loading
   *  flag, last error, decoded-trace count across cached regions, and the
   *  last decode's width-filter drop stats. Written by the VectorizeLayer. */
  vectorStatus: {
    loading: boolean;
    error: string | null;
    traces: number;
    droppedWidth?: number;
    /** Octilinear decoder: chains kept raw with irregular=true. */
    irregular?: number;
    /** P2-3 preview state (see VectorizeLayer). */
    preview?: { state: "off" | "fetching" | "ok" | "fail"; failures: number; error: string | null };
  };
  /** Vector pipette (VectorSection): armed → canvas clicks sample the metal
   *  colour instead of the active tool. Samples accumulate for averaging;
   *  each keeps where it was taken (the layer draws markers). */
  vectorPipetteArmed: boolean;
  vectorSamples: { rgb: [number, number, number]; x: number; y: number }[];
  /** True while a whole-die vectorize sweep runs: the live viewport decode
   *  pauses (it would fight the sweep for the sidecar's CV gate), the
   *  overlay comes back from the block cache when the sweep ends. */
  vectorSweepRunning: boolean;
  /** SAVED whole-die vecto payloads for this die (Vector layers list in the
   *  outline tree). Refreshed from `GET .../vectorize/layers`; the bump
   *  version invalidates the react-query after a sweep completes. */
  savedVectorLayers: { hash: string; name?: string | null; traces: number; outlines: number; modified: string }[];
  savedVectorVersion: number;
  /** Cell type picked in the Cells (detection) tab — from the dropdown or by
   *  selecting a placed cell on the canvas while the tab is open. */
  cellDetectionTypeId: string | null;
  /** Proposals currently shown on the canvas (after threshold / overlap
   *  filtering). Drives the outline-tree count. */
  cellDetectionsCount: number;
  /** A wire-likelihood map exists for this die (drives the outline row). */
  wireMapAvailable: boolean;
  /** Copied cell data for paste (cellTypeId + orientation, no position). */
  clipboardCells: { cellTypeId: string; offsetX: number; offsetY: number; flippedV?: boolean; flippedH?: boolean; rotation?: 0 | 90 | 180 | 270; bounds?: AnnotationRect }[];
  clipboardWires: WireClipboard | null;
  /** Copied I/O pads: pasted with the same pin number + name, new place. */
  clipboardPins: PinClip[];
  /** Floorplan regions in the copy / paste clipboard (see lib/floorplanClipboard). */
  clipboardFloorplans: FloorplanClip[];
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
  /** Make `dieId` the owner of the undo history, clearing it if it belonged
   *  to another die (its actions must never be replayed on this one). */
  ensureHistoryFor: (dieId: string) => void;
  /** Register / clear the global-undo override (see `UndoOverride`). */
  setUndoOverride: (override: UndoOverride | null) => void;
  setActiveMetalId: (id: string | null) => void;
  setActiveViaId: (id: string | null) => void;
  setGuideAxis: (axis: "x" | "y") => void;
  setRulerDisplay: (patch: Partial<Pick<DieViewerState, "showRulerPx" | "showRulerUm" | "showRulerNm">>) => void;
  /** Patch the draft ML config (one or more fields). */
  setMlConfig: (patch: Partial<DieMLConfig>) => void;
  /** Set the live ML-via cardinality — called by the layer when tiles load. */
  setMlViasCount: (count: number) => void;
setVectorStatus: (status: {
  loading: boolean;
  error: string | null;
  traces: number;
  droppedWidth?: number;
  irregular?: number;
  /** P2-3 preview state, reported by the layer on every transition. */
  preview?: { state: "off" | "fetching" | "ok" | "fail"; failures: number; error: string | null };
}) => void;
setVectorPipetteArmed: (armed: boolean) => void;
addVectorSample: (sample: { rgb: [number, number, number]; x: number; y: number }) => void;
clearVectorSamples: () => void;
setVectorSweepRunning: (running: boolean) => void;
setSavedVectorLayers: (layers: { hash: string; name?: string | null; traces: number; outlines: number; modified: string }[]) => void;
bumpSavedVectorLayers: () => void;
  setCellDetectionTypeId: (id: string | null) => void;
  setCellDetectionsCount: (count: number) => void;
  setWireMapAvailable: (available: boolean) => void;
  /** Copy selected cell instance(s) to clipboard. */
  copyCells: (cells: { cellTypeId: string; offsetX: number; offsetY: number; flippedV?: boolean; flippedH?: boolean; rotation?: 0 | 90 | 180 | 270 }[]) => void;
  setWireClipboard: (clipboard: WireClipboard) => void;
  clearWireClipboard: () => void;
  /** Clear cell clipboard. */
  clearCellClipboard: () => void;
  /** Replace the pad clipboard (empty clears it). */
  setPinClipboard: (pins: PinClip[]) => void;
  setFloorplanClipboard: (regions: FloorplanClip[]) => void;
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
  historyDieId: null,
  undoOverride: null,
  activeMetalId: null,
  activeViaId: null,
  guideAxis: "x",
  showRulerPx: false,
  showRulerUm: true,
  showRulerNm: false,
  mlConfig: { ...DEFAULT_ML_CONFIG },
  mlViasCount: 0,
  vectorStatus: { loading: false, error: null, traces: 0 },
  vectorPipetteArmed: false,
  vectorSamples: [],
  vectorSweepRunning: false,
  savedVectorLayers: [],
  savedVectorVersion: 0,
  cellDetectionTypeId: null,
  cellDetectionsCount: 0,
  wireMapAvailable: false,
  clipboardCells: [],
  clipboardPins: [],
  clipboardFloorplans: [],
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
  ensureHistoryFor: (dieId) => {
    if (get().historyDieId === dieId) return;
    set({ historyDieId: dieId, undoStack: [], redoStack: [] });
  },
  setUndoOverride: (override) => set({ undoOverride: override }),
  setActiveAnalogLayer: (layer) => set({ activeAnalogLayer: layer }),
  setActiveMetalId: (id) => set({ activeMetalId: id }),
  setActiveViaId: (id) => set({ activeViaId: id }),
  setGuideAxis: (axis) => set({ guideAxis: axis }),
  setRulerDisplay: (patch) => set(patch),
  setMlConfig: (patch) =>
    set((state) => ({ mlConfig: { ...state.mlConfig, ...patch } })),
  setMlViasCount: (count) => {
    if (get().mlViasCount === count) return;
    set({ mlViasCount: count });
  },
  setVectorStatus: (status) => {
    const cur = get().vectorStatus;
    if (
      cur.loading === status.loading &&
      cur.error === status.error &&
      cur.traces === status.traces &&
      cur.droppedWidth === status.droppedWidth &&
      cur.irregular === status.irregular &&
      // The preview lifecycle MUST also pass through — backgrounding it
      // made the panel's status line stale while decode counters stood
      // still (the 'preview status shows nothing' report).
      cur.preview?.state === status.preview?.state &&
      cur.preview?.failures === status.preview?.failures &&
      cur.preview?.error === status.preview?.error
    )
      return;
    set({ vectorStatus: status });
  },
  setVectorPipetteArmed: (armed) => set({ vectorPipetteArmed: armed }),
  addVectorSample: (sample) =>
    set((state) => ({ vectorSamples: [...state.vectorSamples, sample] })),
  clearVectorSamples: () => set({ vectorSamples: [] }),
  setVectorSweepRunning: (running) => {
    if (get().vectorSweepRunning === running) return;
    set({ vectorSweepRunning: running });
  },
  setSavedVectorLayers: (layers) => {
    // Idempotent: writing an identical list is a no-op. This setter runs after
    // every die list fetch, and it used to bump `savedVectorVersion` on each
    // write — the fetch effect depends on that version → fetch → set → bump →
    // fetch… an infinite loop that (a) hammered the backend and (b) full-
    // invalidated ALL canvas tiles every iteration via the vector layer sync,
    // i.e. the "after a page reload the whole viewer crawls" report. It also
    // went undetected for a long time because a transient fetch ERROR breaks
    // the loop (the .catch swallows, no set → no bump) — the "two states:
    // sometimes it flies, sometimes it crawls" mystery. Explicit re-fetches
    // (sweep done / manual refresh) go through bumpSavedVectorLayers.
    const cur = get().savedVectorLayers;
    if (cur.length === layers.length && cur.every((l, i) => {
      const n = layers[i];
      return (
        l.hash === n.hash &&
        (l.name ?? null) === (n.name ?? null) &&
        l.traces === n.traces &&
        l.outlines === n.outlines &&
        l.modified === n.modified
      );
    })) {
      return;
    }
    set({ savedVectorLayers: layers });
  },
  bumpSavedVectorLayers: () =>
    set((state) => ({ savedVectorVersion: state.savedVectorVersion + 1 })),
  setCellDetectionTypeId: (id) => set({ cellDetectionTypeId: id }),
  setCellDetectionsCount: (count) => {
    if (get().cellDetectionsCount === count) return;
    set({ cellDetectionsCount: count });
  },
  setWireMapAvailable: (available) => {
    if (get().wireMapAvailable === available) return;
    set({ wireMapAvailable: available });
  },

  copyCells: (cells) => set({ clipboardCells: cells }),
  setWireClipboard: (clipboard) => set({ clipboardWires: clipboard }),
  clearWireClipboard: () => set({ clipboardWires: null }),
  clearCellClipboard: () => set({ clipboardCells: [] }),
  setPinClipboard: (pins) => set({ clipboardPins: pins }),
  setFloorplanClipboard: (regions) => set({ clipboardFloorplans: regions }),

  // The undo history is left alone: it is per die (see ensureHistoryFor),
  // and the die viewer resets on every mount — coming back from Merge /
  // RE cell must not lose what was done there. Trace regions/blockages are
  // persisted annotation collections now, so they need no special case.
  reset: () =>
    set((state) => ({
      ...INITIAL_STATE,
      undoStack: state.undoStack,
      redoStack: state.redoStack,
      historyDieId: state.historyDieId
    }))
}));

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}
