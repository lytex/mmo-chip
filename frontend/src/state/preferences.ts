import { create } from "zustand";
import { persist, subscribeWithSelector } from "zustand/middleware";
import type { AnnotationClass, AssistantClarificationMode, AssistantDataFlags, AssistantLlmConfig, LayerType } from "shared";
import {
  CELL_COLOR,
  NET_COLOR,
  NET_DEFAULT_WIDTH
} from "../renderer/annotations/dieAnnotations";
import {
  VIA_DEFAULT_COLOR,
  VIA_DEFAULT_SIZE,
  WIRE_LAYER_COLOR,
  NET_NODE_RADIUS_MULT
} from "../renderer/annotations/style";
import type { Viewport } from "../renderer/types";
import type { InspectorTab } from "./dieViewer";
import {
  ANNOTATION_KIND_VALUES,
  type AnnotationKind
} from "./annotationKinds";

/** Persisted display settings for a single overlay layer. */
export interface OverlayLayerPersistedSettings {
  hidden: boolean;
  opacity: number;
  offsetX: number;
  offsetY: number;
  /** Personal presentation name; source identity remains serverFilename. */
  name?: string;
  /** Personal visual-stack position; lower values paint below higher values. */
  order?: number;
}

interface PreferencesState {
  /** Base width (world units) for net wires. The renderer's screen clamp
   *  applies on top of this. */
  netWidth: number;
  /** Base color for unselected wires + vertices (one of NET_COLOR_OPTIONS). */
  netColor: string;
  /** Cell outline + block-fill color (one of CELL_COLOR_OPTIONS). */
  cellColor: string;
  /** When false, cells always render as a solid block even when zoomed in
   *  (the detailed inner layer shapes are never drawn). */
  cellShowShapes: boolean;
  /** When true, the cell-rectangle tool snaps the drawn rect's edges to
   *  nearby grid guides (guide behaviour itself lands in a later phase). */
  cellSnapToGuides: boolean;
  /** Per-net color overrides, keyed by `net:<netId>`. Absent = use `netColor`. */
  netColors: Record<string, string>;
  /** When true, per-net color overrides (`netColors`) render on the canvas.
   *  When false, they're kept (nothing is lost) but every net falls back to
   *  its per-conductor-layer color, so the die reads by metal/silicon type
   *  instead of by net. Toggle lets the user flip between the two views
   *  without re-picking colors. Default true (custom colors visible). */
  customNetColorsEnabled: boolean;
  /** Cell-grid guides hidden on the canvas. */
  guidesHidden: boolean;
  /** Guides locked — not selectable / movable (still visible). */
  guidesLocked: boolean;
  /** Cells locked — can't be dragged/repositioned. */
  cellsLocked: boolean;
  /** Classes a newly-drawn ML ROI fully labels (schema §1 — load-bearing).
   *  Editable in the ROI tool options; each new ROI is stamped with this. */
  roiClasses: AnnotationClass[];
  /** Per-base-image hidden flag, keyed by base-image id (absent = visible).
   *  Today there's one base image per die (keyed by die id); the map shape is
   *  ready for multiple base images landing in the annotations later. */
  baseImageHidden: Record<string, boolean>;
  /** Per-base-image opacity 0..1, keyed by base-image id (absent = 1). */
  baseImageOpacity: Record<string, number>;
  /** Annotation kinds that are hidden on the canvas. Inverse of "visible" so
   *  default empty array means "everything visible". */
  hiddenKinds: AnnotationKind[];
  /** Outline tree sections that should render expanded. */
  expandedSections: AnnotationKind[];
  /** Merge-cells canvas mode. */
  mergeMode: "overlay" | "sxs" | "diff" | "specimen" | "candidate";
  /** Candidate opacity 0..1 in merge-cells overlay mode. */
  mergeOpacity: number;
  /** Show cell-type layer annotations over the merge-cells crops. */
  mergeShowAnno: boolean;
  /** Overlay ML via predictions on each merge-cells crop (helps eyeball
   *  align by comparing detected via positions specimen-vs-candidate). */
  mergeShowMlVias: boolean;
  /** Last viewport per die (pan/zoom). Written throttled from the page so
   *  reload restores the user's framing. */
  savedViewports: Record<string, Viewport>;
  /** Die-viewer: hide the "ML Results" overlay (live ML via predictions
   *  fetched per tile). One global toggle — the user usually wants to flip
   *  it the same way across dies. */
  mlResultsHidden: boolean;
  /** Wire / multi-wire: snap the click position to the nearest via (ML or
   *  manually placed) when within tolerance. Helps stitch nets onto via
   *  centres without eyeballing. */
  snapToVias: boolean;
  /** Wire / multi-wire: when any via lies on the projected segment from the
   *  last placed point toward the cursor, force the wire endpoint onto that
   *  via and finish the wire there (each wire in a multi-wire bus snaps
   *  independently on its own projected line). Off by default. */
  wireAutoEndOnVia: boolean;
  /** Wire: when clicking on a cell terminal snap (orange halo), auto-commit
   *  the wire immediately instead of staying in edit mode. */
  autoEndOnContact: boolean;
  /** Render colour for point vias (stroke + fill alpha derived). Shared by
   *  the manual via annotation render path and the ML-via overlay. */
  viaColor: string;
  /** Render radius for point vias (world / source-pixel units). Shared by
   *  the manual via annotation render path and the ML-via overlay, and used
   *  as the snap-to-via tolerance. One setting because the user thinks of
   *  "via size" as a single physical property, not a per-source style. */
  viaSize: number;
  /** Minimum model confidence (0..1) for an ML via to be shown / counted.
   *  Inference caches every detection with its score; this slider filters
   *  the cached results client-side — no re-inference on change. */
  viaConfidenceThreshold: number;
  /** Die-viewer right-panel tab (Inspector / ML). Persisted so the panel
   *  re-opens where the user left it. The ML tab also drives a canvas
   *  render mode (traces/vias sized from mlConfig). */
  inspectorTab: InspectorTab;
  /** Hidden cell-layer keys on the Cells-RE page (absent ⇒ visible). The two
   *  non-editable "groups" (inferred, die-viewer overlay) use the special
   *  keys `_inferred` / `_dieViewer`. */
  reLayerHidden: Record<string, boolean>;
  /** Cell-layer selectability on the Cells-RE page (absent ⇒ selectable).
   *  When false, shapes on that layer can't be picked by the Select tool
   *  (no click-select, no marquee-select, no context-menu selection). */
  reLayerSelectable: Record<string, boolean>;
  /** Per-resistor-type sheet resistance overrides (persisted). Keyed by
   *  ResistorType: poly, hsr, pb, npl, film. */
  sheetR: Record<string, number>;
  /** @deprecated Per-cell-type analog device parameter overrides.
   *  Key: cellTypeId → deviceFingerprint → paramName → value.
   *  Migrated into deviceRegistry on first pipeline run; this field is
   *  kept only so existing localStorage payloads continue to load. New
   *  overrides go through the registry (keyed by device UUID). */
  analogOverrides: Record<string, Record<string, Record<string, number>>>;
  /** Per-conductor-layer wire colour override (metal1, metal2, etc.).
   *  Absent = use WIRE_LAYER_COLOR defaults from style.ts. */
  wireLayerColors: Record<string, string>;
  /** When enabled, clicking a vertex on an adjacent metal auto-places the
   *  via and connects, instead of requiring manual via placement. */
  autoViaEnabled: boolean;
  /** Where to place the via when pressing E/Q during wire drawing:
   *  "cursor" = at the raw cursor position (current),
   *  "wire-end" = at the snapped wire preview endpoint (only if not on existing node/via/terminal). */
  viaPlaceMode: "cursor" | "wire-end";
  /** Per-via-layer colour override (VIA12, VIA23, …). Absent = use
   *  via.color from the metal stack. */
  viaLayerColors: Record<string, string>;
  /** Show via type label (VIA12, VIA23, …) above each via annotation on the
   *  die viewer canvas. */
  viaLabelsVisible: boolean;
  /** Die viewer: show the analog devices overlay (extracted instances + highlights). */
  deviceOverlayOn: boolean;
  /** Die viewer: render net IDs next to terminals/wires instead of just net colors. */
  showTermNetIds: boolean;
  /** Die viewer: render the floorplan regions overlay. */
  floorplanOverlayOn: boolean;
  /** Die viewer: render floorplan region I/O markers. */
  showFloorplanIO: boolean;
  /** Die viewer: render the cell relations overlay (shared-net links between cells). */
  showCellRelations: boolean;
  /** Wire node (junction dot) radius multiplier relative to net width.
   *  0 = hide nodes entirely. Default = NET_NODE_RADIUS_MULT. */
  netNodeSize: number;
  /** Wire node (junction dot) visibility toggle. When false, no dots drawn
   *  at wire junctions regardless of netNodeSize. */
  netNodeVisible: boolean;
  /** Resistor body layers opacity (0..1) in the RE canvas. Default 1.
   *  Helps superimpose the drawn polyline onto the image to verify width. */
  resistorOpacity: number;
  /** RE Cell: render the analog device instance labels (M_1, Q12, R34…).
   *  Default true. */
  reDeviceLabelsVisible: boolean;
  /** RE Cell: render the terminal dots + letters (G/S/D/B/C/E/+/−).
   *  Independent from `reDeviceLabelsVisible` so dense layouts can hide
   *  one but keep the other readable. Default true. */
  reTerminalLabelsVisible: boolean;
  /** RE Cell: label size preset for analog overlay text (instance name,
   *  terminal letters). 0=small, 1=medium, 2=large. Default 1. */
  reAnalogLabelScale: 0 | 1 | 2;
  /** Per-die overlay layer display settings (visibility, opacity, offset).
   *  Keyed by dieId → serverFilename. */
  overlayLayerSettings: Record<string, Record<string, OverlayLayerPersistedSettings>>;
  /** LLM provider configuration for the AI assistant.
   *  Stored in localStorage; sent to the backend on each analysis request. */
  llmProvider: AssistantLlmConfig;
  /** Which circuit representations the assistant LLM should receive.
   *  projectJson = rich device+nets JSON (large, reliable on OpenRouter);
   *  textNetlist = compact Spectre-like text (works on opencode-go). */
  assistantDataFlags: AssistantDataFlags;
  /** Max number of hypothesis cards the full-graph model may return. */
  assistantMaxHypotheses: number;
  /** May the assistant LLM ask the user clarifying questions before hypotheses?
   *  off | auto | always — global default for all dies. */
  assistantClarificationMode: AssistantClarificationMode;
  /** Netlist schematic render settings (Static + Interactive). Persisted as
   *  user settings so the renderer opens the way the user left it. */
  netlistLayoutStrategy: import("../lib/schematic/netlist2svgSkin").LayoutStrategy;
  netlistLayoutDirection: import("../lib/schematic/netlist2svgSkin").LayoutDirection;
  netlistCompaction: import("../lib/schematic/netlist2svgSkin").CompactionLevel;
  /** Fine ELK tuning (interactive engine); undefined = ELK default. */
  netlistNodeNode: number | undefined;
  netlistBetweenLayers: number | undefined;
  netlistEdgeEdge: number | undefined;
  netlistEdgeNode: number | undefined;
  netlistMergeEdges: boolean;
  netlistFavorStraightEdges: boolean;
  /** Show die-level I/O pin symbols (inputExt) in the interactive schematic. */
  netlistShowIoPins: boolean;
  /** Collapse floorplan regions into subcircuit blocks in the interactive schematic. */
  netlistShowHierarchy: boolean;
  /** Show the legacy static netlist2svg renderer (toggle, download, functional).
   *  Off by default — the interactive canvas is the primary engine. */
  netlistShowLegacyStatic: boolean;
}

interface PreferencesActions {
  setNetWidth: (width: number) => void;
  setNetColor: (color: string) => void;
  /** Override color for a specific net (id like "net:abc"). null = clear. */
  setNetColorOverride: (netId: string, color: string | null) => void;
  /** Override color for several nets at once (multi-select bulk assign).
   *  null = clear all of them back to the global/layer default. */
  setNetColorsForIds: (netIds: string[], color: string | null) => void;
  /** Toggle whether per-net color overrides render on the canvas (see
   *  `customNetColorsEnabled`). */
  setCustomNetColorsEnabled: (enabled: boolean) => void;
  /** Set colour for a specific conductor layer (metal1, metal2, poly, etc.). */
  setWireLayerColor: (layer: string, color: string) => void;
  /** Toggle auto-via placement on cross-layer snap. */
  setAutoViaEnabled: (enabled: boolean) => void;
  /** Switch via placement mode for E/Q: "cursor" or "wire-end". */
  setViaPlaceMode: (mode: "cursor" | "wire-end") => void;
  /** Toggle via type labels on the die viewer canvas. */
  setViaLabelsVisible: (visible: boolean) => void;
  /** Toggle analog devices overlay on the die viewer canvas. */
  setDeviceOverlayOn: (visible: boolean) => void;
  /** Toggle net ID overlay on the die viewer canvas. */
  setShowTermNetIds: (visible: boolean) => void;
  /** Toggle floorplan overlay on the die viewer canvas. */
  setFloorplanOverlayOn: (visible: boolean) => void;
  /** Toggle floorplan I/O markers on the die viewer canvas. */
  setShowFloorplanIO: (visible: boolean) => void;
  /** Toggle cell relations overlay on the die viewer canvas. */
  setShowCellRelations: (visible: boolean) => void;
  /** Override colour for a specific via layer (VIA12, VIA23, …). */
  setViaLayerColor: (viaId: string, color: string) => void;
  /** Set wire node radius multiplier (0 = hide nodes). */
  setNetNodeSize: (size: number) => void;
  /** Toggle wire node visibility. */
  setNetNodeVisible: (visible: boolean) => void;
  setViaColor: (color: string) => void;
  setCellColor: (color: string) => void;
  setCellShowShapes: (show: boolean) => void;
  setCellSnapToGuides: (snap: boolean) => void;
  setGuidesHidden: (hidden: boolean) => void;
  setGuidesLocked: (locked: boolean) => void;
  setCellsLocked: (locked: boolean) => void;
  setBaseImageHidden: (id: string, hidden: boolean) => void;
  setBaseImageOpacity: (id: string, opacity: number) => void;
  setMergeMode: (
    mode: "overlay" | "sxs" | "diff" | "specimen" | "candidate"
  ) => void;
  setMergeOpacity: (opacity: number) => void;
  setMergeShowAnno: (show: boolean) => void;
  setMergeShowMlVias: (show: boolean) => void;
  setRoiClasses: (classes: AnnotationClass[]) => void;
  setReLayerHidden: (key: string, hidden: boolean) => void;
  /** Bulk-set visibility for a set of layer keys. */
  setAllReLayerHidden: (keys: readonly string[], hidden: boolean) => void;
  setReLayerSelectable: (key: string, selectable: boolean) => void;
  /** Bulk-set selectability for a set of layer keys. */
  setAllReLayerSelectable: (keys: readonly string[], selectable: boolean) => void;
  /**
   * "Solo" toggle for the Cells-RE layer visibility list. `key` is the layer
   * being soloed; `allKeys` is the full set of toggleable keys the panel
   * knows about (real `LayerType`s + virtual overlay keys).
   *
   * Behaviour: if `key` is currently the only visible layer in `allKeys`,
   * restores everything to visible. Otherwise hides every other key and
   * makes `key` visible. The whole thing is one `set()` call so the canvas
   * only paints once per double-click.
   */
  soloReLayer: (key: string, allKeys: ReadonlyArray<string>) => void;
  /**
   * "Solo" toggle for layer selectability. Same semantics as `soloReLayer`
   * but operates on `reLayerSelectable`. Triple-click on a layer row calls
   * this: makes only `key` selectable (or restore all on second triple-click).
   */
  soloReLayerSelectable: (key: string, allKeys: ReadonlyArray<string>) => void;
  setMlResultsHidden: (hidden: boolean) => void;
  setSnapToVias: (snap: boolean) => void;
  setWireAutoEndOnVia: (enabled: boolean) => void;
  setAutoEndOnContact: (enabled: boolean) => void;
  setViaSize: (size: number) => void;
  setViaConfidenceThreshold: (threshold: number) => void;
  setInspectorTab: (tab: InspectorTab) => void;
  toggleKindVisibility: (kind: AnnotationKind) => void;
  toggleSectionExpanded: (kind: AnnotationKind) => void;
  saveViewport: (dieId: string, viewport: Viewport) => void;
  clearSavedViewport: (dieId: string) => void;
  setResistorOpacity: (opacity: number) => void;
  setReDeviceLabelsVisible: (visible: boolean) => void;
  setReTerminalLabelsVisible: (visible: boolean) => void;
  setReAnalogLabelScale: (scale: 0 | 1 | 2) => void;
  saveOverlayLayerSettings: (dieId: string, settings: Record<string, OverlayLayerPersistedSettings>) => void;
  setLlmProvider: (config: AssistantLlmConfig) => void;
  setAssistantDataFlags: (flags: AssistantDataFlags) => void;
  setAssistantMaxHypotheses: (count: number) => void;
  setAssistantClarificationMode: (mode: AssistantClarificationMode) => void;
  setNetlistLayoutStrategy: (v: import("../lib/schematic/netlist2svgSkin").LayoutStrategy) => void;
  setNetlistLayoutDirection: (v: import("../lib/schematic/netlist2svgSkin").LayoutDirection) => void;
  setNetlistCompaction: (v: import("../lib/schematic/netlist2svgSkin").CompactionLevel) => void;
  setNetlistNodeNode: (v: number | undefined) => void;
  setNetlistBetweenLayers: (v: number | undefined) => void;
  setNetlistEdgeEdge: (v: number | undefined) => void;
  setNetlistEdgeNode: (v: number | undefined) => void;
  setNetlistMergeEdges: (v: boolean) => void;
  setNetlistFavorStraightEdges: (v: boolean) => void;
  setNetlistShowIoPins: (v: boolean) => void;
  setNetlistShowHierarchy: (v: boolean) => void;
  setNetlistShowLegacyStatic: (v: boolean) => void;
}

const DEFAULT_EXPANDED_SECTIONS: AnnotationKind[] = ["net", "via", "roi"];

export const usePreferences = create<PreferencesState & PreferencesActions>()(
  subscribeWithSelector(
    persist(
      (set) => ({
        netWidth: NET_DEFAULT_WIDTH,
        netColor: NET_COLOR,
        netColors: {},
        customNetColorsEnabled: true,
        cellColor: CELL_COLOR,
        cellShowShapes: true,
        cellSnapToGuides: false,
        guidesHidden: false,
        guidesLocked: false,
        cellsLocked: false,
        baseImageHidden: {},
        baseImageOpacity: {},
        roiClasses: ["point_via", "irregular_via"],
        hiddenKinds: [],
        expandedSections: DEFAULT_EXPANDED_SECTIONS,
        mergeMode: "overlay",
        mergeOpacity: 0.5,
        mergeShowAnno: true,
        mergeShowMlVias: false,
        savedViewports: {},
        reLayerHidden: {},
        reLayerSelectable: {
          npn_id: false, pnp_id: false, lpnp_id: false, vpnp: false,
          res_id: false, cap_id: false, diode_id: false,
          collector: false, bulk: false,
        },
        mlResultsHidden: true,
        snapToVias: false,
        wireAutoEndOnVia: false,
        autoEndOnContact: true,
        viaColor: VIA_DEFAULT_COLOR,
        viaSize: VIA_DEFAULT_SIZE,
        viaConfidenceThreshold: 0.5,
        inspectorTab: "inspector",
        sheetR: {},
        analogOverrides: {},
        wireLayerColors: {
          metal1: WIRE_LAYER_COLOR.metal1,
          metal2: WIRE_LAYER_COLOR.metal2
        },
        autoViaEnabled: false,
        viaPlaceMode: "wire-end",
        viaLayerColors: {},
        viaLabelsVisible: true,
        deviceOverlayOn: true,
        showTermNetIds: false,
        floorplanOverlayOn: true,
        showFloorplanIO: false,
        showCellRelations: false,
        netNodeSize: NET_NODE_RADIUS_MULT,
        netNodeVisible: true,
        resistorOpacity: 1,
        reDeviceLabelsVisible: true,
        reTerminalLabelsVisible: true,
        reAnalogLabelScale: 1,
        overlayLayerSettings: {},
        llmProvider: {},
        assistantDataFlags: { projectJson: true, textNetlist: false },
        assistantMaxHypotheses: 5,
        assistantClarificationMode: "auto",
        netlistLayoutStrategy: "BRANDES_KOEPF",
        netlistLayoutDirection: "DOWN",
        netlistCompaction: 2,
        netlistNodeNode: undefined,
        netlistBetweenLayers: undefined,
        netlistEdgeEdge: undefined,
        netlistEdgeNode: undefined,
        netlistMergeEdges: false,
        netlistFavorStraightEdges: false,
        netlistShowIoPins: true,
        netlistShowHierarchy: true,
        netlistShowLegacyStatic: false,

        setNetWidth: (width) => set({ netWidth: width }),
        setNetColor: (color) => set({ netColor: color }),
        setWireLayerColor: (layer, color) =>
          set((state) => ({
            wireLayerColors: { ...state.wireLayerColors, [layer]: color }
          })),
        setAutoViaEnabled: (enabled) => set({ autoViaEnabled: enabled }),
        setViaPlaceMode: (mode) => set({ viaPlaceMode: mode }),
        setViaLabelsVisible: (visible) => set({ viaLabelsVisible: visible }),
        setDeviceOverlayOn: (visible) => set({ deviceOverlayOn: visible }),
        setShowTermNetIds: (visible) => set({ showTermNetIds: visible }),
        setFloorplanOverlayOn: (visible) => set({ floorplanOverlayOn: visible }),
        setShowFloorplanIO: (visible) => set({ showFloorplanIO: visible }),
        setShowCellRelations: (visible) => set({ showCellRelations: visible }),
        setViaLayerColor: (viaId, color) =>
          set((state) => ({
            viaLayerColors: { ...state.viaLayerColors, [viaId]: color }
          })),
        setNetNodeSize: (size) =>
          set({ netNodeSize: Math.max(0, Math.min(5, size)) }),
        setNetNodeVisible: (visible) => set({ netNodeVisible: visible }),
        setViaColor: (color) => set({ viaColor: color }),
        setNetColorOverride: (netId, color) =>
          set((state) => {
            if (color === null || color === state.netColor) {
              if (!(netId in state.netColors)) return state;
              const { [netId]: _, ...rest } = state.netColors;
              return { netColors: rest };
            }
            return { netColors: { ...state.netColors, [netId]: color } };
          }),
        setNetColorsForIds: (netIds, color) =>
          set((state) => {
            const next = { ...state.netColors };
            let changed = false;
            for (const netId of netIds) {
              if (color === null || color === state.netColor) {
                if (netId in next) {
                  delete next[netId];
                  changed = true;
                }
              } else if (next[netId] !== color) {
                next[netId] = color;
                changed = true;
              }
            }
            return changed ? { netColors: next } : state;
          }),
        setCustomNetColorsEnabled: (enabled) =>
          set({ customNetColorsEnabled: enabled }),
        setCellColor: (color) => set({ cellColor: color }),
        setCellShowShapes: (show) => set({ cellShowShapes: show }),
        setCellSnapToGuides: (snap) => set({ cellSnapToGuides: snap }),
        setGuidesHidden: (hidden) => set({ guidesHidden: hidden }),
        setGuidesLocked: (locked) => set({ guidesLocked: locked }),
        setCellsLocked: (locked) => set({ cellsLocked: locked }),
        setBaseImageHidden: (id, hidden) =>
          set((state) => ({
            baseImageHidden: { ...state.baseImageHidden, [id]: hidden }
          })),
        setBaseImageOpacity: (id, opacity) =>
          set((state) => ({
            baseImageOpacity: {
              ...state.baseImageOpacity,
              [id]: Math.min(1, Math.max(0, opacity))
            }
          })),
        setMergeMode: (mode) => set({ mergeMode: mode }),
        setMergeOpacity: (opacity) =>
          set({ mergeOpacity: Math.min(1, Math.max(0, opacity)) }),
        setMergeShowAnno: (show) => set({ mergeShowAnno: show }),
        setMergeShowMlVias: (show) => set({ mergeShowMlVias: show }),
        setRoiClasses: (classes) => set({ roiClasses: classes }),
        setReLayerHidden: (key, hidden) =>
          set((state) => {
            if (!hidden) {
              if (!(key in state.reLayerHidden)) return state;
              const { [key]: _, ...rest } = state.reLayerHidden;
              return { reLayerHidden: rest };
            }
            return { reLayerHidden: { ...state.reLayerHidden, [key]: true } };
          }),
        setAllReLayerHidden: (keys, hidden) =>
          set((state) => {
            if (hidden) {
              const next = { ...state.reLayerHidden };
              for (const k of keys) next[k] = true;
              return { reLayerHidden: next };
            }
            const next = { ...state.reLayerHidden };
            for (const k of keys) delete next[k];
            return { reLayerHidden: next };
          }),
        setReLayerSelectable: (key, selectable) =>
          set((state) => {
            // Strip entry when selectable (default), keep only when locked.
            if (selectable) {
              if (!(key in state.reLayerSelectable)) return state;
              const { [key]: _, ...rest } = state.reLayerSelectable;
              return { reLayerSelectable: rest };
            }
            return { reLayerSelectable: { ...state.reLayerSelectable, [key]: false } };
          }),
        setAllReLayerSelectable: (keys, selectable) =>
          set((state) => {
            if (!selectable) {
              const next = { ...state.reLayerSelectable };
              for (const k of keys) next[k] = false;
              return { reLayerSelectable: next };
            }
            const next = { ...state.reLayerSelectable };
            for (const k of keys) delete next[k];
            return { reLayerSelectable: next };
          }),
        soloReLayer: (key, allKeys) =>
          set((state) => {
            const isOtherHidden = (k: string) => state.reLayerHidden[k] === true;
            const others = allKeys.filter((k) => k !== key);
            // Already soloed when this key is visible AND every other known key
            // is hidden. Toggling in that state restores the world to visible.
            const alreadySoloed =
              !isOtherHidden(key) && others.length > 0 && others.every(isOtherHidden);
            if (alreadySoloed) {
              // Drop just our known keys; leave any unrelated entries alone.
              const next = { ...state.reLayerHidden };
              for (const k of allKeys) delete next[k];
              return { reLayerHidden: next };
            }
            const next = { ...state.reLayerHidden };
            for (const k of allKeys) {
              if (k === key) delete next[k];
              else next[k] = true;
            }
            return { reLayerHidden: next };
          }),
        soloReLayerSelectable: (key, allKeys) =>
          set((state) => {
            const isOtherSelectable = (k: string) => state.reLayerSelectable[k] !== false;
            const others = allKeys.filter((k) => k !== key);
            const alreadySoloed =
              isOtherSelectable(key) && others.length > 0 && others.every((k) => !isOtherSelectable(k));
            if (alreadySoloed) {
              const next = { ...state.reLayerSelectable };
              for (const k of allKeys) delete next[k];
              return { reLayerSelectable: next };
            }
            const next = { ...state.reLayerSelectable };
            for (const k of allKeys) {
              if (k === key) delete next[k];
              else next[k] = false;
            }
            return { reLayerSelectable: next };
          }),
        setMlResultsHidden: (hidden) => set({ mlResultsHidden: hidden }),
        setSnapToVias: (snap) => set({ snapToVias: snap }),
        setWireAutoEndOnVia: (enabled) => set({ wireAutoEndOnVia: enabled }),
        setAutoEndOnContact: (enabled) => set({ autoEndOnContact: enabled }),
        setViaSize: (size) => set({ viaSize: size }),
        setViaConfidenceThreshold: (threshold) =>
          set({
            viaConfidenceThreshold: Math.min(1, Math.max(0, threshold))
          }),
        setInspectorTab: (tab) => set({ inspectorTab: tab }),
        toggleKindVisibility: (kind) =>
          set((state) => ({
            hiddenKinds: state.hiddenKinds.includes(kind)
              ? state.hiddenKinds.filter((k) => k !== kind)
              : [...state.hiddenKinds, kind]
          })),
        toggleSectionExpanded: (kind) =>
          set((state) => ({
            expandedSections: state.expandedSections.includes(kind)
              ? state.expandedSections.filter((k) => k !== kind)
              : [...state.expandedSections, kind]
          })),
        saveViewport: (dieId, viewport) =>
          set((state) => ({
            savedViewports: { ...state.savedViewports, [dieId]: viewport }
          })),
        clearSavedViewport: (dieId) =>
          set((state) => {
            if (!(dieId in state.savedViewports)) return state;
            const { [dieId]: _, ...rest } = state.savedViewports;
            return { savedViewports: rest };
          }),
        setResistorOpacity: (opacity) =>
          set({ resistorOpacity: Math.min(1, Math.max(0, opacity)) }),
        setReDeviceLabelsVisible: (visible) => set({ reDeviceLabelsVisible: visible }),
        setReTerminalLabelsVisible: (visible) => set({ reTerminalLabelsVisible: visible }),
        setReAnalogLabelScale: (scale) => set({ reAnalogLabelScale: scale }),
        saveOverlayLayerSettings: (dieId, settings) =>
          set((state) => ({
            overlayLayerSettings: { ...state.overlayLayerSettings, [dieId]: settings }
          })),
        setLlmProvider: (config) => set({ llmProvider: config }),
        setAssistantDataFlags: (flags) => set({ assistantDataFlags: flags }),
        setAssistantMaxHypotheses: (count) => set({ assistantMaxHypotheses: count }),
        setAssistantClarificationMode: (mode) => set({ assistantClarificationMode: mode }),
        setNetlistLayoutStrategy: (v) => set({ netlistLayoutStrategy: v }),
        setNetlistLayoutDirection: (v) => set({ netlistLayoutDirection: v }),
        setNetlistCompaction: (v) => set({ netlistCompaction: v }),
        setNetlistNodeNode: (v) => set({ netlistNodeNode: v }),
        setNetlistBetweenLayers: (v) => set({ netlistBetweenLayers: v }),
        setNetlistEdgeEdge: (v) => set({ netlistEdgeEdge: v }),
        setNetlistEdgeNode: (v) => set({ netlistEdgeNode: v }),
        setNetlistMergeEdges: (v) => set({ netlistMergeEdges: v }),
        setNetlistFavorStraightEdges: (v) => set({ netlistFavorStraightEdges: v }),
        setNetlistShowIoPins: (v) => set({ netlistShowIoPins: v }),
        setNetlistShowHierarchy: (v) => set({ netlistShowHierarchy: v }),
        setNetlistShowLegacyStatic: (v) => set({ netlistShowLegacyStatic: v }),
      }),
      {
        name: "mmo-chip-preferences",
        version: 1,
        // Strip out any unknown kinds that may have been persisted before a
        // schema change, so the UI never references a removed kind.
        partialize: (state) => ({
          netWidth: state.netWidth,
          netColor: state.netColor,
          cellColor: state.cellColor,
          cellShowShapes: state.cellShowShapes,
          cellSnapToGuides: state.cellSnapToGuides,
          guidesHidden: state.guidesHidden,
          guidesLocked: state.guidesLocked,
          cellsLocked: state.cellsLocked,
          baseImageHidden: state.baseImageHidden,
          baseImageOpacity: state.baseImageOpacity,
          roiClasses: state.roiClasses,
          hiddenKinds: state.hiddenKinds.filter((k) =>
            ANNOTATION_KIND_VALUES.includes(k)
          ),
          expandedSections: state.expandedSections.filter((k) =>
            ANNOTATION_KIND_VALUES.includes(k)
          ),
          mergeMode: state.mergeMode,
          mergeOpacity: state.mergeOpacity,
          mergeShowAnno: state.mergeShowAnno,
          mergeShowMlVias: state.mergeShowMlVias,
          savedViewports: state.savedViewports,
          reLayerHidden: state.reLayerHidden,
          reLayerSelectable: state.reLayerSelectable,
          netColors: state.netColors,
          customNetColorsEnabled: state.customNetColorsEnabled,
          mlResultsHidden: state.mlResultsHidden,
          snapToVias: state.snapToVias,
          wireAutoEndOnVia: state.wireAutoEndOnVia,
          autoEndOnContact: state.autoEndOnContact,
          viaColor: state.viaColor,
          viaSize: state.viaSize,
          viaConfidenceThreshold: state.viaConfidenceThreshold,
          inspectorTab: state.inspectorTab,
          sheetR: state.sheetR,
          analogOverrides: state.analogOverrides,
          wireLayerColors: state.wireLayerColors,
          autoViaEnabled: state.autoViaEnabled,
          viaPlaceMode: state.viaPlaceMode,
          viaLabelsVisible: state.viaLabelsVisible,
          deviceOverlayOn: state.deviceOverlayOn,
          showTermNetIds: state.showTermNetIds,
          floorplanOverlayOn: state.floorplanOverlayOn,
          showFloorplanIO: state.showFloorplanIO,
          showCellRelations: state.showCellRelations,
          viaLayerColors: state.viaLayerColors,
          netNodeSize: state.netNodeSize,
          netNodeVisible: state.netNodeVisible,
          resistorOpacity: state.resistorOpacity,
          reDeviceLabelsVisible: state.reDeviceLabelsVisible,
          reTerminalLabelsVisible: state.reTerminalLabelsVisible,
          reAnalogLabelScale: state.reAnalogLabelScale,
          overlayLayerSettings: state.overlayLayerSettings,
          llmProvider: state.llmProvider,
          assistantDataFlags: state.assistantDataFlags,
          assistantMaxHypotheses: state.assistantMaxHypotheses,
          assistantClarificationMode: state.assistantClarificationMode,
          netlistLayoutStrategy: state.netlistLayoutStrategy,
          netlistLayoutDirection: state.netlistLayoutDirection,
          netlistCompaction: state.netlistCompaction,
          netlistNodeNode: state.netlistNodeNode,
          netlistBetweenLayers: state.netlistBetweenLayers,
          netlistEdgeEdge: state.netlistEdgeEdge,
          netlistEdgeNode: state.netlistEdgeNode,
          netlistMergeEdges: state.netlistMergeEdges,
          netlistFavorStraightEdges: state.netlistFavorStraightEdges,
          netlistShowIoPins: state.netlistShowIoPins,
          netlistShowHierarchy: state.netlistShowHierarchy,
          netlistShowLegacyStatic: state.netlistShowLegacyStatic
        })
      }
    )
  )
);

/** Select the effective color for a net: override if set, else global netColor. */
export function selectNetColor(netId: string) {
  return (state: PreferencesState) => state.netColors[netId] ?? state.netColor;
}

/** Helper selector: is this annotation kind currently visible on the canvas? */
export function selectIsKindVisible(kind: AnnotationKind) {
  return (state: PreferencesState) => !state.hiddenKinds.includes(kind);
}

/** Helper selector: is this outline section expanded? */
export function selectIsSectionExpanded(kind: AnnotationKind) {
  return (state: PreferencesState) => state.expandedSections.includes(kind);
}

/** Base-image visibility (defaults to visible when never toggled). */
export function selectBaseImageVisible(id: string) {
  return (state: PreferencesState) => state.baseImageHidden[id] !== true;
}

/** Base-image opacity 0..1 (defaults to 1 when never set). */
export function selectBaseImageOpacity(id: string) {
  return (state: PreferencesState) => state.baseImageOpacity[id] ?? 1;
}

/** Cells-RE layer visibility (defaults to visible when never toggled). The
 *  same selector covers real `LayerType` keys plus the two virtual groups
 *  (`_inferred`, `_dieViewer`) shown in the visibility list. */
export function selectReLayerVisible(key: LayerType | "_inferred" | "_dieViewer") {
  return (state: PreferencesState) => state.reLayerHidden[key] !== true;
}

/** Cells-RE layer selectability (defaults to selectable when never toggled). */
export function selectReLayerSelectable(key: LayerType) {
  return (state: PreferencesState) => state.reLayerSelectable[key] !== false;
}
