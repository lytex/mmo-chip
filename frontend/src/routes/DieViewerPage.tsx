import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { AnalogDevice, AnnotationNet, AssistantFinding, Cell, CellType, DieAnnotations } from "shared";
import { annotationKeys, useAnnotations } from "../api/annotations";
import { useAnnotationsWebSocket } from "../api/annotationsWebSocket";
import { netChangesToAction, useActionDispatcher } from "../api/actions";
import { useDie } from "../api/dies";
import { useCellLibrary } from "../api/cellLibrary";
import { routeLibraryAction, withLibraryTypes } from "../lib/cellLibrary";
import { useWireMapInfo, wireTileUrl } from "../api/cellImaging";
import { useCellDetections } from "../api/cellDetection";
import { proposalsFor, type Proposal } from "../lib/cellDetection";
import { populateCellDetectionLayer } from "../renderer/annotations/cellDetections";
import { AppShell } from "../components/shell/AppShell";
import { StatusBar } from "../components/shell/StatusBar";
import { SubBar } from "../components/shell/SubBar";
import { PanelToggle, usePanelCollapsed } from "../components/shell/PanelToggle";
import { Ic } from "../icons";
import {
  TiledCanvas,
  fitRectViewport,
  fitViewport,
  type DragHandler,
  type Interaction,
  type PointerEventData,
  type TiledCanvasHandle
} from "../renderer/TiledCanvas";
import { DieImageLayer } from "../renderer/layers/DieImageLayer";
import { AnnotationLayer } from "../renderer/layers/AnnotationLayer";
import {
  MLViasLayer,
  isMlViaId,
  parseMlViaId
} from "../renderer/layers/MLViasLayer";
import { OverlayImageLayer, type OverlayViewportStats } from "../renderer/layers/OverlayImageLayer";
import { DIE_VIEWER_HOTKEYS, DIE_VIEWER_MOD_HOTKEYS, GLOBAL_HOTKEYS, METAL_HOTKEYS, VIA_HOTKEYS } from "../lib/hotkeys";
import { useToast } from "../components/Toast";
import { useDialog } from "../components/Dialog";

import { RulerOverlay, type RulerDraft } from "../components/dieViewer/RulerOverlay";
import {
  buildCellAnnotation,
  buildNetAnnotation,
  buildPin,
  populateAnnotationLayer
} from "../renderer/annotations/dieAnnotations";
import { OutlineTree } from "../components/dieViewer/OutlineTree";
import { ShortcutsPanel } from "../components/dieViewer/ShortcutsPanel";
import { SettingsPanel } from "../components/dieViewer/SettingsPanel";
import {
  CenteredStatus,
  CursorReadout,
  HoverReadout,
  MarqueeOverlay,
  ZoomChip,
  ZoomReadout,
  annotationsSummary,
  panelStyle,
  sameHoverInfo,
  NetHoldRing,
  type HoverInfo
} from "../components/dieViewer/DieViewerUI";
import { DieToolbar, IssuesChip } from "../components/dieViewer/DieToolbar";
import {
  DieContextMenu,
  type DieContextMenuState
} from "../components/dieViewer/DieContextMenu";
import { InspectorPanel } from "../components/dieViewer/InspectorPanel";

import { ProblemNavigatorPanel, collectProblems } from "../components/dieViewer/ProblemNavigatorPanel";
import { AnalogDeviceHighlights } from "../components/dieViewer/AnalogDeviceHighlights";
import { SubcircuitHighlightsOverlay } from "../components/dieViewer/SubcircuitHighlightsOverlay";
import { DeviceInspector } from "../components/dieViewer/DeviceInspector";
import { DeviceInstancePanel } from "../components/dieViewer/DeviceInstancePanel";
import { CellTypePopover } from "../components/dieViewer/CellTypePopover";
import { retypeCell } from "../lib/cellFootprint";
import {
  cellSideAt,
  cellWorldRect,
  cellTypeResizeAction,
  resizeCellType,
  resolveSelectedCell,
  sideCursor,
  type CellSide
} from "../components/dieViewer/cellResize";
import { useDieExtraction } from "../hooks/useDieExtraction";
import { setActiveProject, flushProjectDeviceNames } from "../state/analogDeviceNames";
import { useExtractionProgress } from "../state/extractionProgress";
import { loadClipper } from "../lib/extraction";
import { useMLJob, useMLStatus } from "../api/ml";
import { WireDraftOverlay } from "../components/dieViewer/WireDraftOverlay";
import { RectDraftOverlay } from "../components/dieViewer/RectDraftOverlay";
import { PolyDraftOverlay } from "../components/dieViewer/PolyDraftOverlay";
import { SelectionHandlesOverlay } from "../components/dieViewer/SelectionHandlesOverlay";
import { usePersistedViewport } from "../components/dieViewer/usePersistedViewport";
import { useCanvasSelection } from "../components/dieViewer/useCanvasSelection";
import {
  HIT_TOLERANCE_PX,
  type TerminalSnapTarget,
  TERMINAL_SNAP_TOLERANCE_PX,
  useWireTool,
  type WireSnap,
  type WireTool
} from "../components/dieViewer/useWireTool";
import { buildInstanceTerminalMap } from "../lib/extraction/terminalDetect";
import { useCellTool } from "../components/dieViewer/useCellTool";
import { useLibraryCellTool } from "../components/dieViewer/useLibraryCellTool";
import { LibraryCellOverlay } from "../components/dieViewer/LibraryCellOverlay";
import { useAnalogCellTool } from "../components/dieViewer/useAnalogCellTool";
import { AnalogCellOverlay } from "../components/dieViewer/AnalogCellOverlay";
import { useViaPolyTool } from "../components/dieViewer/useViaPolyTool";
import {
  previewEnds,
  tipOf,
  useMultiWireTool
} from "../components/dieViewer/useMultiWireTool";
import { MultiWireOverlay } from "../components/dieViewer/MultiWireOverlay";
import { CommentOverlay } from "../components/dieViewer/CommentOverlay";
import { NetRenamePopover } from "../components/dieViewer/NetRenamePopover";
import { ViaColorPopover } from "../components/dieViewer/ViaColorPopover";
import { viaBaseColor, viaColorAction, viaColorTargets, viaFromSelectionId } from "../lib/viaColor";
import { floorplanNameInline } from "../lib/floorplanName";
import { drawFloorplansForSnapshot, isFloorplanVisible } from "../lib/floorplanSnapshot";
import { regionInMarquee } from "../lib/floorplanEdit";
import { constrainPoint } from "../lib/angleConstraint";
import { currentAngleMode } from "../state/angleMode";
import { useWindowAnchorMaintenance } from "../components/dieViewer/useElementWindow";
import { FloorplanOverlay } from "../components/dieViewer/FloorplanOverlay";
import { useFloorplanStore, type FloorplanDraft } from "../state/floorplan";
import { apiPut } from "../api/client";
import { useAuth } from "../state/auth";
import { useGuideTool } from "../components/dieViewer/useGuideTool";

import {
  GuidesOverlay,
  type GuideDragPreview
} from "../components/dieViewer/GuidesOverlay";
import {
  guideHitTest,
  guidesInRect,
  pointInGuidesRegion,
  snapRectToGuides,
  translateGuide
} from "../lib/guides";
import {
  resolveEditable,
  shapeDragHandler,
  type EditPreview
} from "../components/dieViewer/shapeEdit";
import { useSelectionDelete } from "../components/dieViewer/useSelectionDelete";
import { useUndoRedoHotkeys } from "../components/dieViewer/useUndoRedoHotkeys";
import { useOverlayHotkeys } from "../lib/useOverlayHotkeys";
import type { ActionDispatcher, AnnotationAction } from "../api/actions";
import { parseNetPartId, splitNetAtNode, weldNetAtEdge, weldNetAtNode, type DrawAnchor } from "../lib/netGraph";
import { pasteWireClipboard, snapshotWireClipboard, wireSelectionBounds } from "../lib/wireClipboard";
import {
  closestPointOnSegment,
  normalizeRect,
  distancePointToSegment,
  pointInPolygon,
  pointInRect,
  rectCornerAt,
  rectCorners,
  rectFromPoints,
  snapTo45,
  squareFromPoints,
  type Point,
  type Rect
} from "../lib/geometry";
import { netNodeWorldRadius, viaSnapTolerance } from "../renderer/annotations/style";
import type { Layer, Viewport } from "../renderer/types";
import { formatPercent } from "../lib/format";
import { isTypingTarget } from "../lib/keyboard";
import {
  maxScreenshotScale,
  nativeScreenshotScale,
  resolveScreenshotScale,
  screenshotSize
} from "../lib/screenshot";
import { ScreenshotPanel } from "../components/dieViewer/ScreenshotPanel";
import { padCountByPin, pastePinActions, pinClips, renamePinActions, selectedPins } from "../lib/pinClipboard";
import { floorplanBounds, floorplanClips, pasteFloorplanActions, selectedFloorplans } from "../lib/floorplanClipboard";
import { buildMakeUniqueAction, buildOrientAction, orientOf, orientOnDie } from "../lib/mergeCells";
import { createLiveValue } from "../lib/liveValue";
import type { WirePreview } from "../components/dieViewer/WireDraftOverlay";
import { ANNOTATION_KIND_VALUES } from "../state/annotationKinds";
import { DEFAULT_ML_CONFIG, useDieViewerStore } from "../state/dieViewer";
import { useOverlayLayers, saveOverlaySettingsToPrefs, applyOverlaySettingsFromPrefs } from "../state/overlayLayers";
import { usePreferences, selectNetWidth, selectPinSize } from "../state/preferences";
import { useSession, DEFAULT_METAL_STACK, fetchMetalStack } from "../state/session";
import { useUserStatus } from "../lib/useUserStatus";
import { uuid } from "../lib/uuid";

/** Stable empty points array so the overlay effect doesn't churn when idle. */
const NO_DRAFT_POINTS: Point[] = [];

/** Quantisation (px) of the analog-device terminal grid used to flag net
 *  vertices that are real device-electrode connections. Kept tight so a node
 *  merely *near* a terminal is not mistaken for a connection. */
const DEVICE_CONN_GRID_PX = 1;
/** Screen-px grab zone either side of a selected cell's outline for resize. */
const CELL_EDGE_GRAB_PX = 6;
/** Bus turns shorter than this (screen px) are ignored — e.g. the 2nd click
 *  of the double-click that finishes the bus. */
const MULTI_WIRE_MIN_TURN_PX = 4;
/** Press & hold on a net: same timing as the outline eye's long press. */
const NET_HOLD_MS = 2000;
const NET_HOLD_RING_DELAY_MS = 500;

/** Broad-phase pick radius (world units) covering the rendered net-vertex
 *  dots. A vertex dot is drawn wider than the net's node bbox (screen-clamped),
 *  so a click anywhere on a visible dot must widen the spatial search or the
 *  annotation is culled before its precise `hitTest` runs — leaving only the
 *  dot's centre grabbable. */
function netNodePickWorldRadius(zoom: number): number {
  const prefs = usePreferences.getState();
  return netNodeWorldRadius(
    zoom,
    prefs.netWidth,
    prefs.netNodeVisible ? prefs.netNodeSize : 0,
    prefs.inspectorTab === "ml"
  );
}

type DragSnap =
  | { kind: "vertex"; netId: string; nodeId: string; x: number; y: number }
  | { kind: "edge"; netId: string; edgeId: string; at: Point };

/** Snap a dragged net endpoint onto ANOTHER net — nearest vertex first, then
 *  nearest edge body. Mirrors the wire tool's drawing snap so a moved end joins
 *  a foreign net the same way a freshly drawn one does. The dragged net itself
 *  is excluded so it never snaps to its own graph. */
function resolveDragSnap(
  nets: AnnotationNet[],
  excludeNetId: string,
  world: Point,
  vertexTol: number,
  edgeTol: number
): DragSnap | null {
  let bestV: { netId: string; nodeId: string; x: number; y: number } | null = null;
  let bestVD = vertexTol;
  for (const net of nets) {
    if (net.id === excludeNetId) continue;
    for (const nd of net.nodes) {
      const d = Math.hypot(nd.x - world.x, nd.y - world.y);
      if (d <= bestVD) {
        bestVD = d;
        bestV = { netId: net.id, nodeId: nd.id, x: nd.x, y: nd.y };
      }
    }
  }
  if (bestV) return { kind: "vertex", ...bestV };

  let bestE: { netId: string; edgeId: string; at: Point } | null = null;
  let bestED = edgeTol;
  for (const net of nets) {
    if (net.id === excludeNetId) continue;
    for (const edge of net.edges) {
      const a = net.nodes.find((n) => n.id === edge.from);
      const b = net.nodes.find((n) => n.id === edge.to);
      if (!a || !b) continue;
      const c = closestPointOnSegment(world, a, b);
      const d = Math.hypot(c.x - world.x, c.y - world.y);
      if (d <= bestED) {
        bestED = d;
        bestE = {
          netId: net.id,
          edgeId: edge.id,
          at: { x: Math.round(c.x), y: Math.round(c.y) }
        };
      }
    }
  }
  return bestE ? { kind: "edge", ...bestE } : null;
}

export function DieViewerPage() {
  const { dieId } = useParams<{ dieId: string }>();

  if (!dieId) {
    return (
      <AppShell>
        <div
          className="m"
          style={{
            flex: "1 1 auto",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--ink3)",
            fontSize: 12
          }}
        >
          <span>no die selected — </span>
          <Link to="/" style={{ color: "var(--accent)", marginLeft: 4 }}>
            choose one from the library
          </Link>
        </div>
      </AppShell>
    );
  }

  return <DieViewer key={dieId} dieId={dieId} />;
}

function DieViewer({ dieId }: { dieId: string }) {
  const { data: die, isLoading, error } = useDie(dieId);
  const { data: ownAnnotations } = useAnnotations(dieId);
  // The die's process adds its silicon layers to the session's layer stack.
  const dieProcess = ownAnnotations?.process ?? null;
  useEffect(() => {
    useSession.getState().setProcess(dieProcess);
  }, [dieProcess]);
  const toast = useToast();
  const dialog = useDialog();
  useAnnotationsWebSocket(dieId);
  // The cell library: other dies' types this die uses or is offered, merged
  // into the annotations at this die's scale (the page draws, hit-tests and
  // edits them like its own); edits to them are routed to their die.
  const library = useCellLibrary(dieId, ownAnnotations);
  const libraryRef = useRef(library);
  libraryRef.current = library;
  const annotations = useMemo(
    () => (ownAnnotations ? withLibraryTypes(ownAnnotations, library) : undefined),
    [ownAnnotations, library]
  );
  const foreignTypeOwners = useMemo(
    () => new Map([...library.foreign].map(([id, f]) => [id, f.ownerName])),
    [library]
  );

  // Scope the per-project analog device name store to this die.
  useEffect(() => {
    setActiveProject(dieId);
    return () => {
      flushProjectDeviceNames();
    };
  }, [dieId]);
  // Always-fresh annotations for the (stable) pointer router's shape editing.
  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  const queryClient = useQueryClient();
  const canvasHandle = useRef<TiledCanvasHandle>(null);
  const [liveRenderStatus, setLiveRenderStatus] = useState<{
    total: number;
    loaded: number;
    pending: number;
    queued: number;
    loading: number;
    tilesPerSecond: number;
    preview: boolean;
    lastRenderMs: number;
  } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const outlineSearchRef = useRef<(() => void) | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [leftCollapsed, toggleLeft] = usePanelCollapsed("die.left");
  const [rightCollapsed, toggleRight] = usePanelCollapsed("die.right");
  // The "I" hotkey opens the right panel for the analog library — the
  // keydown handler is registered once, so it reads the state from a ref.
  const rightCollapsedRef = useRef(rightCollapsed);
  rightCollapsedRef.current = rightCollapsed;
  const toggleRightRef = useRef(toggleRight);
  toggleRightRef.current = toggleRight;
  useEffect(() => {
    const handler = () => setShortcutsOpen((v) => !v);
    window.addEventListener("toggle-shortcuts", handler);
    return () => window.removeEventListener("toggle-shortcuts", handler);
  }, []);
  useEffect(() => {
    const handler = () => setSettingsOpen((v) => !v);
    window.addEventListener("toggle-settings", handler);
    return () => window.removeEventListener("toggle-settings", handler);
  }, []);

  const activeTool = useDieViewerStore((s) => s.activeTool);
  const setActiveTool = useDieViewerStore((s) => s.setActiveTool);

  // Broadcast status to other users
  useUserStatus(dieId, activeTool);
  const navigate = useNavigate();
  const dispatcher = useActionDispatcher(dieId, {
    route: (action) => routeLibraryAction(action, libraryRef.current)
  });

  // Hot-path live values. These never trigger DieViewer re-renders — only the
  // tiny readout subcomponents subscribe via `useLiveValue`. The renderer
  // also reads them directly via the canvas handle.
  const viewportLive = useMemo(() => createLiveValue<Viewport | null>(null), []);
  const cursorLive = useMemo(
    () => createLiveValue<{ x: number; y: number } | null>(null),
    []
  );
  const hoverInfoLive = useMemo(
    () => createLiveValue<HoverInfo | null>(null),
    []
  );
  const marqueeLive = useMemo(() => createLiveValue<Rect | null>(null), []);
  const cellRectLive = useMemo(() => createLiveValue<Rect | null>(null), []);
  const shapeRectLive = useMemo(() => createLiveValue<Rect | null>(null), []);
  const wirePreviewLive = useMemo(
    () => createLiveValue<WirePreview | null>(null),
    []
  );
  const viaPolyPreviewLive = useMemo(
    () => createLiveValue<Point | null>(null),
    []
  );
  /** Rubber-band tip of the floorplan polygon draft (angle-constrained cursor). */
  const floorplanTipLive = useMemo(
    () => createLiveValue<Point | null>(null),
    []
  );
  const editPreviewLive = useMemo(
    () => createLiveValue<EditPreview | null>(null),
    []
  );
  const guideDragLive = useMemo(
    () => createLiveValue<GuideDragPreview | null>(null),
    []
  );
  const multiWireSnapLive = useMemo(
    () => createLiveValue<Point | null>(null),
    []
  );
  // Phase-2 endpoint snaps: each sweeping wire that would lock onto a via at
  // this cursor — one entry from the snap-to-vias-near-cursor path, or many
  // from auto-end-on-via (one per wire whose projection crosses a via). The
  // overlay redraws each such wire ending on its via so the preview matches
  // the commit. Empty / null = no snaps right now.
  const multiWireEndSnapLive = useMemo(
    () =>
      createLiveValue<
        Array<{ lockIndex: number; x: number; y: number }> | null
      >(null),
    []
  );
  const wireSnapLive = useMemo(
    () => createLiveValue<WireSnap | null>(null),
    []
  );
  const shiftLive = useMemo(() => createLiveValue<boolean>(false), []);
  const rulerDraftLive = useMemo(() => createLiveValue<RulerDraft | null>(null), []);
  const rulerPendingLive = useMemo(() => createLiveValue<RulerDraft | null>(null), []);
  const [selectedRulerIds, setSelectedRulerIds] = useState<ReadonlySet<string>>(new Set());
  const showRulerPx = useDieViewerStore((s) => s.showRulerPx);
  const showRulerUm = useDieViewerStore((s) => s.showRulerUm);
  const showRulerNm = useDieViewerStore((s) => s.showRulerNm);
  const rulersHidden = usePreferences((s) => s.rulersHidden);
  const rulerVisibilityOverrides = usePreferences((s) => s.rulerVisibilityOverrides);
  const isRulerVisible = useCallback(
    (rulerId: string) => rulerVisibilityOverrides[rulerId] ?? !rulersHidden,
    [rulerVisibilityOverrides, rulersHidden]
  );
  const visibleRulers = useMemo(
    () => (annotations?.rulers ?? []).filter((r) => isRulerVisible(r.id)),
    [annotations?.rulers, isRulerVisible]
  );
  useEffect(() => {
    const existing = new Set((annotations?.rulers ?? []).map((r) => r.id));
    setSelectedRulerIds((current) => {
      const next = new Set([...current].filter((id) => existing.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [annotations?.rulers]);

  // Shift state captured from pointer-move, read by the click handler (which
  // has no event of its own).
  const shiftRef = useRef(false);

  // Right-click context menu. Null = closed. Position is viewport-relative
  // (clientX/clientY) so the menu renders fixed at the cursor regardless of
  // canvas pan/zoom.
  // Resize cursor while hovering a side of the single selected cell.
  const [cellResizeCursor, setCellResizeCursor] = useState<string | null>(null);
  // Cell whose type is being changed via the double-click picker.
  // Double-clicked cell → non-modal CellTypePopover anchored at the click.
  const [cellTypePicker, setCellTypePicker] = useState<{ cellId: string; at: { x: number; y: number } } | null>(null);
  const [contextMenu, setContextMenu] = useState<DieContextMenuState | null>(
    null
  );
  // When the comment tool is active and the user clicks the canvas,
  // this coordinate triggers CommentOverlay to create a new comment.
  const [pendingNewComment, setPendingNewComment] = useState<{
    x: number;
    y: number;
  } | null>(null);

  // Sync floorplan regions from annotations
  const setFloorplanRegions = useFloorplanStore((s) => s.setRegions);
  const floorplanRegions = useFloorplanStore((s) => s.regions);
  useEffect(() => {
    if (annotations?.floorplanRegions) {
      setFloorplanRegions(annotations.floorplanRegions);
    } else {
      setFloorplanRegions([]);
    }
  }, [annotations?.floorplanRegions, setFloorplanRegions]);

  // While a floorplan polygon is being drawn (vertices placed, not yet
  // finished): Enter finishes it like a double-click (needs >= 3 vertices),
  // Esc abandons it (nothing is saved).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== "Escape" && e.key !== "Enter") || isTypingTarget(e.target)) return;
      if (useDieViewerStore.getState().activeTool !== "floorplan") return;
      const fp = useFloorplanStore.getState();
      if (fp.draft?.kind !== "poly" || !fp.draft.active) return;
      e.preventDefault();
      if (e.key === "Escape") fp.setDraft(null);
      else finishFloorplanPolyRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Hold-Space momentary pan. The ref is read by the (stable) pointer-down
  // router without re-binding; the state only drives the cursor.
  const [spacePan, setSpacePan] = useState(false);
  const spacePanRef = useRef(false);
  useEffect(() => {
    const setPan = (on: boolean) => {
      spacePanRef.current = on;
      setSpacePan(on);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || isTypingTarget(e.target)) return;
      e.preventDefault();
      setPan(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      setPan(false);
    };
    const onBlur = () => setPan(false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // Die-viewer hotkeys from central registry. Uses refs for the zoom/fit
  // callbacks so the effect doesn't need to re-bind when they're created.
  const zoomInRef = useRef<() => void>(() => {});
  const zoomOutRef = useRef<() => void>(() => {});
  const fitToScreenRef = useRef<() => void>(() => {});
  const wireRef = useRef<WireTool>(null!);
  const dispatcherRef = useRef(dispatcher);
  /** Save the floorplan polygon being drawn (>= 3 vertices) as a new region
   *  and select it; no-op otherwise. Double-click and Enter both call it. */
  const finishFloorplanPolyRef = useRef(() => {});
  finishFloorplanPolyRef.current = () => {
    const fs = useFloorplanStore.getState();
    if (fs.toolMode !== "poly" || !fs.draft || !fs.draft.active || fs.draft.points.length < 3) return;
    const au = useAuth.getState();
    const region: import("shared").FloorplanRegion = {
      id: uuid(),
      name: "",
      kind: "polygon",
      geometry: fs.draft.points,
      color: "#4dabf7",
      createdBy: au.userId ?? null,
      createdByName: au.username ?? null,
      createdAt: new Date().toISOString(),
      reservedBy: null,
      reservedByName: null,
      reservedAt: null,
    };
    // Undoable; the store mirrors annotations, upsert now for instant feedback.
    fs.upsertRegion(region);
    fs.setDraft(null);
    fs.openRegion(region.id); // new region: open its window to name it
    void dispatcherRef.current
      .dispatch({ kind: "upsertFloorplan", region, prevRegion: null })
      .then((ok) => { if (!ok) toast.error("Failed to save floorplan"); });
  };
  dispatcherRef.current = dispatcher;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || isTypingTarget(e.target)) return;

      // Ctrl+F → open outline tree search
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "f") {
        e.preventDefault();
        outlineSearchRef.current?.();
        return;
      }

      // Ctrl+/ or ? → keyboard shortcuts help
      if (((e.metaKey || e.ctrlKey) && e.key === "/") || (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey)) {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
        return;
      }

      // Ctrl+, → project settings
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen((v) => !v);
        return;
      }

      // ── Modifier-action hotkeys (lookup in central registry) ────
      const modDef = DIE_VIEWER_MOD_HOTKEYS[e.key];
      if (modDef && modDef.ctrl === (e.metaKey || e.ctrlKey) && modDef.shift === e.shiftKey) {
        switch (modDef.action) {
          case "copyCell": {
            const ann = annotationsRef.current;
            if (!ann) return;
            if (copySelectionToClipboard(ann, useDieViewerStore.getState().selectedIds)) e.preventDefault();
            return;
          }
          case "pasteCell": {
            const ann = annotationsRef.current;
            if (!ann) return;
            const store = useDieViewerStore.getState();
            if (!clipboardHasContent(store)) return;
            e.preventDefault();
            const cursor = cursorLive.get();
            const actions = pasteClipboardActions(ann, { x: Math.round(cursor?.x ?? 0), y: Math.round(cursor?.y ?? 0) });
            if (actions.length > 0) void dispatcherRef.current.dispatch({ kind: "batch", actions });
            return;
          }
          case "makeUnique": {
            const ann = annotationsRef.current;
            if (!ann) return;
            const sel = useDieViewerStore.getState().selectedIds;
            const cellId = [...sel].find((id) => id.startsWith("cell:"));
            if (!cellId) return;
            const cell = ann.cells?.find((c) => c.id === cellId.slice(5));
            if (!cell) return;
            e.preventDefault();
            void dispatcherRef.current.dispatch(buildMakeUniqueAction(ann, cell));
            return;
          }
          case "deleteAllRulers": {
            const rulers = annotationsRef.current?.rulers ?? [];
            if (rulers.length === 0) return;
            e.preventDefault();
            const actions: AnnotationAction[] = rulers.map((ruler) => ({ kind: "removeRuler", ruler }));
            void dispatcherRef.current.dispatch(actions.length === 1 ? actions[0] : { kind: "batch", actions });
            setSelectedRulerIds(new Set());
            rulerDraftLive.set(null);
            rulerPendingLive.set(null);
            return;
          }
          case "viaUp":
          case "viaDown": {
            const cur = useDieViewerStore.getState();
            if (cur.activeTool !== "wire") return;
            const w = wireRef.current;
            if (!w.draft) return;
            let pos: { x: number; y: number } | null = null;
            if (usePreferences.getState().viaPlaceMode === "wire-end") {
              const preview = wirePreviewLive.get();
              if (preview && !preview.onNode && !preview.onVia && !preview.onTerminal) {
                pos = { x: Math.round(preview.x), y: Math.round(preview.y) };
              }
            }
            if (!pos) {
              const cursorWorld = cursorLive.get();
              if (!cursorWorld) return;
              pos = { x: Math.round(cursorWorld.x), y: Math.round(cursorWorld.y) };
            }
            const metalStack = useSession.getState().metalStack ?? DEFAULT_METAL_STACK;
            // Metals come first in the stack (vias[i] joins metals i and i+1);
            // the die's silicon layers follow, each reaching metal 1 through
            // its contact (CT_*) — so from silicon only "up" is defined.
            const metalCount = metalStack.metals.filter(m => m.z >= 1).length;
            const curIdx = metalStack.metals.findIndex(m => m.id === cur.activeMetalId);
            if (curIdx < 0) return;
            let via: { id: string } | undefined;
            let nextMetalId: string | undefined;
            if (curIdx >= metalCount) {
              if (modDef.action !== "viaUp") return;
              const metal1 = metalStack.metals[0];
              via = metalStack.vias.find(v => v.from === metalStack.metals[curIdx].id && v.to === metal1?.id);
              nextMetalId = metal1?.id;
            } else {
              const nextIdx = modDef.action === "viaUp" ? curIdx + 1 : curIdx - 1;
              if (nextIdx < 0 || nextIdx >= metalCount) return;
              via = metalStack.vias[nextIdx < curIdx ? nextIdx : curIdx];
              nextMetalId = metalStack.metals[nextIdx].id;
            }
            if (!via || !nextMetalId) return;
            e.preventDefault();
            const viaPoint = w.insertDraftPoint(pos);
            if (!viaPoint) return;
            void dispatcherRef.current.dispatch({
              kind: "upsertAnnotation",
              annotation: {
                id: uuid(), class: "point_via",
                geometry: { kind: "point", x: viaPoint.x, y: viaPoint.y },
                source: "human",
                layer: via.id,
              },
              prevAnnotation: null
            });
            cur.setActiveMetalId(nextMetalId);
            return;
          }
        }
      }

      // Ctrl+Shift+S → screenshot (PNG at the chosen resolution, with overlays)
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void takeScreenshot();
        return;
      }

      if (e.metaKey || e.ctrlKey) return; // other ctrl combos → handled by undo/redo

      // Space+digit belongs to the shared overlay shortcuts, not the metal
      // selector. The Space-pan ref is also the authoritative held-key state.
      if (spacePanRef.current) return;

      const metalStack = useSession.getState().metalStack ?? DEFAULT_METAL_STACK;

      // Metal layer hotkeys: bare digits 1..N (metals only — the silicon
      // layers that follow them in the stack are picked from the toolbar / W).
      const metalIdx = !e.shiftKey && !e.altKey ? METAL_HOTKEYS[e.key] : undefined;
      if (metalIdx != null && metalIdx < metalStack.metals.filter(m => m.z >= 1).length) {
        e.preventDefault();
        useDieViewerStore.getState().setActiveMetalId(metalStack.metals[metalIdx].id);
        if (useDieViewerStore.getState().activeTool !== "wire") setActiveTool("wire");
        return;
      }

      // Via hotkeys: Alt+1..N
      if (e.altKey && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        const viaIdx = VIA_HOTKEYS[e.key];
        if (viaIdx != null && viaIdx < metalStack.vias.length) {
          e.preventDefault();
          useDieViewerStore.getState().setActiveViaId(metalStack.vias[viaIdx].id);
          return;
        }
      }

      // "I" — the analog library in the right panel.
      if (!e.shiftKey && !e.altKey && e.key.toLowerCase() === "i") {
        e.preventDefault();
        const prefs = usePreferences.getState();
        prefs.setInspectorTab(prefs.inspectorTab === "lib" ? "inspector" : "lib");
        if (rightCollapsedRef.current) toggleRightRef.current();
        return;
      }

      // Tool switch hotkeys.
      const toolId = DIE_VIEWER_HOTKEYS[e.key];
      if (toolId && toolId !== "pan") {
        e.preventDefault();
        if (toolId === "wire") {
          const cur = useDieViewerStore.getState();
          if (cur.activeTool === "wire") {
            const curIdx = metalStack.metals.findIndex(m => m.id === cur.activeMetalId);
            const nextIdx = (curIdx + 1) % metalStack.metals.length;
            cur.setActiveMetalId(metalStack.metals[nextIdx].id);
          } else {
            setActiveTool("wire");
            cur.setActiveMetalId(metalStack.metals[0].id);
          }
        } else if (toolId === "via") {
          const cur = useDieViewerStore.getState();
          if (cur.activeTool === "via") {
            const curIdx = metalStack.vias.findIndex(v => v.id === cur.activeViaId);
            const nextIdx = (curIdx + 1) % metalStack.vias.length;
            cur.setActiveViaId(metalStack.vias[nextIdx].id);
          } else {
            setActiveTool("via");
            cur.setActiveViaId(metalStack.vias[0]?.id ?? null);
          }
        } else {
          setActiveTool(toolId);
        }
        return;
      }

      // Global actions (zoom, fit).
      const globalAction = GLOBAL_HOTKEYS[e.key];
      if (globalAction === "zoomIn") { e.preventDefault(); zoomInRef.current(); return; }
      if (globalAction === "zoomOut") { e.preventDefault(); zoomOutRef.current(); return; }
      if (globalAction === "fitToScreen") { e.preventDefault(); fitToScreenRef.current(); return; }
      if (toolId === "pan") { e.preventDefault(); fitToScreenRef.current(); return; }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setActiveTool]);

  const getNetW = useCallback(
    () => selectNetWidth(useSession.getState().dieId)(usePreferences.getState()),
    []
  );
  /** Per-net color: return a (netId: string) => string function that checks
   *  per-net override first, then falls back to global netColor. */
  const getNetC = useCallback(() => {
    const prefs = usePreferences.getState();
    const overrides = prefs.netColors;
    const global = prefs.netColor;
    return (netId: string) => overrides[netId] ?? global;
  }, []);
  const getCellC = useCallback(() => usePreferences.getState().cellColor, []);
  const getCellShapes = useCallback(
    () => usePreferences.getState().cellShowShapes,
    []
  );
  const getPinNamesVisible = useCallback(
    () => usePreferences.getState().pinNamesVisible,
    []
  );
  const getPinSize = useCallback(
    () => selectPinSize(useSession.getState().dieId)(usePreferences.getState()),
    []
  );
  // Pin size feeds the pins' pick bbox (fixed at build time), so a change
  // repopulates the layer instead of only invalidating the canvas.
  const pinSize = usePreferences(selectPinSize(dieId));

  const resetDieViewer = useDieViewerStore((s) => s.reset);
  // Reset transient selection/expand state whenever the active die changes.
  useEffect(() => {
    resetDieViewer();
  }, [dieId, resetDieViewer]);

  // Remember the active die so the phase tabs can return to it after the user
  // visits Library or another phase. Also load the per-die metal stack.
  useEffect(() => {
    useSession.getState().setDieId(dieId);
    fetchMetalStack(dieId).then(stack => {
      useSession.getState().setMetalStack(stack);
      // Reset activeMetalId / activeViaId if they're no longer in the stack
      const dv = useDieViewerStore.getState();
      if (!stack.metals.some(m => m.id === dv.activeMetalId)) {
        dv.setActiveMetalId(stack.metals[0]?.id ?? null);
      }
      if (!stack.vias.some(v => v.id === dv.activeViaId)) {
        dv.setActiveViaId(stack.vias[0]?.id ?? null);
      }
    });
  }, [dieId]);

  const layers = useMemo<Layer[]>(() => {
    if (!die) return [];
    // Display controls read live from prefs (keyed by the base-image id =
    // die id today) so toggling visibility/opacity doesn't rebuild the layer.
    return [
      new DieImageLayer(die, {
        getHidden: () =>
          !useOverlayLayers.getState().baseImageVisible ||
          usePreferences.getState().baseImageHidden[die.id] === true,
        getOpacity: () =>
          usePreferences.getState().baseImageOpacity[die.id] ?? 1
      })
    ];
  }, [die]);

  // Wire-likelihood overlay (pixels under recognised cells that aren't part
  // of the cell — mostly wires routed over them). Same tile geometry as the
  // die image, so it reuses the image layer with its own RGBA tile source.
  // Rebuilt when the map is regenerated (the version busts tile caches).
  const wireMapInfo = useWireMapInfo(die?.id ?? null).data ?? null;
  const wireMapVersion = wireMapInfo?.createdAt ?? null;
  const wireMapMinLevel = wireMapInfo?.minZoomLevel ?? 0;
  const wireMapLayer = useMemo(
    () =>
      die && wireMapVersion
        ? new DieImageLayer(
            die,
            {
              getHidden: () => usePreferences.getState().wireMapHidden,
              getOpacity: () => usePreferences.getState().wireMapOpacity
            },
            {
              id: "wire-map",
              tileUrl: (z, x, y) => wireTileUrl(die.id, wireMapVersion, z, x, y),
              pyramid: false,
              minLevel: wireMapMinLevel
            }
          )
        : null,
    [die, wireMapVersion, wireMapMinLevel]
  );
  useEffect(() => {
    useDieViewerStore.getState().setWireMapAvailable(wireMapLayer !== null);
    return () => useDieViewerStore.getState().setWireMapAvailable(false);
  }, [wireMapLayer]);

  // ML via predictions, fetched per backend tile (server-side cached). Lives
  // above the die image but below the annotation layer so user-drawn
  // geometry still wins for picks / selection. Recreated per die so each
  // layer instance owns its own tile cache.
  const mlViasLayer = useMemo(
    () =>
      die
        ? new MLViasLayer(die.id, die, {
            getHidden: () => usePreferences.getState().mlResultsHidden,
            getViaColor: () => usePreferences.getState().viaColor,
            getViaWorldRadius: () => usePreferences.getState().viaSize,
            getConfidenceThreshold: () =>
              usePreferences.getState().viaConfidenceThreshold,
            getViaLayerColor: (viaLayer: string) => {
              const stack = useSession.getState().metalStack ?? DEFAULT_METAL_STACK;
              return stack.vias.find((v) => v.id === viaLayer)?.color;
            },
            showMlLabel: true,
            onCountChange: (n) => useDieViewerStore.getState().setMlViasCount(n)
          })
        : null,
    [die]
  );
  useEffect(() => {
    // Cleanup on die change: drop the cache + zero the count out so the
    // outline doesn't show stale numbers from the previous die.
    return () => {
      mlViasLayer?.destroy();
      useDieViewerStore.getState().setMlViasCount(0);
    };
  }, [mlViasLayer]);

  // Confidence-threshold pref change → re-filter the cached ML vias (recount
  // for the items list + redraw the overlay). No re-fetch: tile data already
  // carries every detection's score.
  useEffect(() => {
    if (!mlViasLayer) return;
    return usePreferences.subscribe(
      (s) => s.viaConfidenceThreshold,
      () => mlViasLayer.recountAndRedraw()
    );
  }, [mlViasLayer]);

  // Live inference-job state (also updated by WS broadcasts from other users).
  const mlJob = useMLJob(die?.id ?? null);
  const mlJobCompleted = mlJob.data?.completedTiles ?? 0;
  useEffect(() => {
    // As a sweep advances, retry any tiles that errored earlier (e.g. the
    // sidecar was briefly down) so the overlay catches up.
    if (mlJobCompleted > 0) mlViasLayer?.retryFailed();
  }, [mlJobCompleted, mlViasLayer]);

  // The sidecar's checkpoint changing (model switch / retrain) invalidates
  // every cached prediction — drop the layer's tile cache so it re-fetches.
  const mlCheckpointHash = useMLStatus().data?.checkpointHash ?? null;
  useEffect(() => {
    mlViasLayer?.clearCache();
  }, [mlCheckpointHash, mlViasLayer]);

  // ML cell proposals (cell-detection results). Their own rbush layer so
  // picks / marquee / visibility behave like real annotations without mixing
  // into the persisted-annotation layer. Rebuilt whenever the results, the
  // placed cells (approvals hide the proposal underneath) or the confidence
  // threshold change.
  const proposalLayer = useMemo(
    () => (die ? new AnnotationLayer("cell-detections") : null),
    [die]
  );
  const cellDetectionsQ = useCellDetections(die?.id ?? null);
  const cellDetectionThreshold = usePreferences((s) => s.cellDetectionThreshold);
  const proposals = useMemo<Proposal[]>(
    () =>
      annotations && cellDetectionsQ.data
        ? proposalsFor(cellDetectionsQ.data, annotations, {
            threshold: cellDetectionThreshold
          })
        : [],
    [annotations, cellDetectionsQ.data, cellDetectionThreshold]
  );
  useEffect(() => {
    if (!proposalLayer) return;
    populateCellDetectionLayer(proposalLayer, proposals);
    useDieViewerStore.getState().setCellDetectionsCount(proposals.length);
  }, [proposalLayer, proposals]);
  const cellDetectionsHidden = usePreferences((s) => s.cellDetectionsHidden);
  useEffect(() => {
    proposalLayer?.setVisibleKinds(cellDetectionsHidden ? new Set() : null);
  }, [proposalLayer, cellDetectionsHidden]);

  // Analog-device terminal points that are genuinely connected to a net,
  // grouped per net (annotation net UUID) and quantised into a grid. The net
  // renderer reads this live so a mid-net vertex that sits on a device
  // electrode of THAT net is still drawn in "only connection points" mode —
  // while a node merely near some unrelated/disconnected terminal is not.
  const deviceConnPointsByNetRef = useRef<Map<string, Set<string>>>(new Map());
  const isDeviceConnectionPoint = useCallback((netId: string, x: number, y: number) => {
    const grid = deviceConnPointsByNetRef.current.get(netId);
    if (!grid || grid.size === 0) return false;
    const gx = Math.floor(x / DEVICE_CONN_GRID_PX);
    const gy = Math.floor(y / DEVICE_CONN_GRID_PX);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        if (grid.has(`${gx + dx},${gy + dy}`)) return true;
      }
    }
    return false;
  }, []);

  const annotationLayer = useMemo(
    () => (die ? new AnnotationLayer("die-annotations") : null),
    [die]
  );

  useEffect(() => {
    if (!annotationLayer || !annotations) return;
    populateAnnotationLayer(annotationLayer, annotations, {
      // ML tab active → render traces/vias at the ML export footprint
      // (source-px sizes) instead of the display preferences.
      netWidth: () =>
        usePreferences.getState().inspectorTab === "ml"
          ? useDieViewerStore.getState().mlConfig.traceWidth
          : selectNetWidth(useSession.getState().dieId)(usePreferences.getState()),
      netColor: (netId: string) => {
        const prefs = usePreferences.getState();
        return prefs.netColors[netId] ?? prefs.netColor;
      },
      netOverrideColor: (netId: string) => {
        const prefs = usePreferences.getState();
        if (!prefs.customNetColorsEnabled) return null;
        return prefs.netColors[netId] ?? null;
      },
      cellColor: () => usePreferences.getState().cellColor,
      cellShowShapes: () => usePreferences.getState().cellShowShapes,
      // The die's library scale — the default a cell is drawn at. A cell
      // with its own `scale` deviates from it.
      dieScale: library.scale,
      pointViaWorldRadius: () => {
        // ML tab forces the export footprint (mockup ml-config). Otherwise
        // use the global `viaSize` pref so manual vias render the same
        // physical size as ML vias and as the snap target. `buildAnnotation`
        // applies the screen-px clamp internally.
        if (usePreferences.getState().inspectorTab === "ml")
          return useDieViewerStore.getState().mlConfig.pointViaSize;
        return usePreferences.getState().viaSize;
      },
      pointViaColor: () => usePreferences.getState().viaColor,
      viaLayerColor: (layer: string) => {
        const prefs = usePreferences.getState();
        const stack = useSession.getState().metalStack ?? DEFAULT_METAL_STACK;
        return prefs.viaLayerColors[layer] ?? stack.vias.find(v => v.id === layer)?.color;
      },
      viaLabelVisible: () => usePreferences.getState().viaLabelsVisible,
      pinNamesVisible: () => usePreferences.getState().pinNamesVisible,
      pinSize: getPinSize,
      netNodeMatchesWidth: () =>
        usePreferences.getState().inspectorTab === "ml",
      wireLayerColor: (layer: string) =>
        usePreferences.getState().wireLayerColors[layer],
      netNodeRadiusMult: () =>
        usePreferences.getState().netNodeVisible
          ? usePreferences.getState().netNodeSize
          : 0,
      netNodeJunctionsOnly: () =>
        usePreferences.getState().netNodeJunctionsOnly,
      netNodeConnectionPoint: isDeviceConnectionPoint,
      netNodeJunctionCross: () =>
        usePreferences.getState().netNodeJunctionCross,
      // Selecting a cell type (outline tree) highlights all its instances.
      isTypeSelected: (cellId: string) => {
        if (!annotations) return false;
        const sel = useDieViewerStore.getState().selectedIds;
        if (sel.size === 0) return false;
        const c = annotations.cells.find((c) => c.id === cellId);
        return c != null && sel.has(`cellType:${c.cellTypeId}`);
      }
    });
  }, [annotationLayer, annotations, getPinSize, pinSize]);

  // Net width/color + cell color/detail + via size/color + wire layer color
  // + net node size/visibility pref changes → invalidate the canvas.
  useEffect(() => {
    const unsubs = (
      ["netWidth", "netWidthByDie", "netColor", "netColors", "customNetColorsEnabled", "cellColor", "cellShowShapes", "viaSize",
       "viaColor", "wireLayerColors", "viaLayerColors", "netNodeSize", "netNodeVisible", "netNodeJunctionsOnly", "netNodeJunctionCross", "pinNamesVisible"] as const
    ).map((key) =>
      usePreferences.subscribe(
        (s) => s[key],
        () => canvasHandle.current?.invalidate()
      )
    );
    return () => unsubs.forEach((u) => u());
  }, []);

  // Base-image visibility / opacity + ML-results visibility pref changes →
  // repaint the canvas. Layer `draw` methods read the pref live so we only
  // need the redraw to kick.
  useEffect(() => {
    const unsubs = (
      ["baseImageHidden", "baseImageOpacity", "mlResultsHidden", "wireMapHidden", "wireMapOpacity"] as const
    ).map((key) =>
      usePreferences.subscribe(
        (s) => s[key],
        () => canvasHandle.current?.invalidate()
      )
    );
    return () => unsubs.forEach((u) => u());
  }, []);

  // Overlay layers visibility/opacity changes → repaint.
  useEffect(() => {
    return useOverlayLayers.subscribe(() => {
      canvasHandle.current?.invalidate();
    });
  }, []);

  // Auto-load overlay images from server on first mount (survives F5).
  // Auto-load overlay images for this die from server.
  const autoLoadRef = useRef(false);
  useEffect(() => {
    if (!dieId || autoLoadRef.current) return;
    autoLoadRef.current = true;
    // Clear any stale overlay layers from a previous project.
    useOverlayLayers.getState().clearLayers();
    const addLayer = useOverlayLayers.getState().addLayer;
    const addTiledLayer = useOverlayLayers.getState().addTiledLayer;
    void import("../api/overlayImages").then(async (mod) => {
      const list = await mod.fetchOverlayImageList(dieId);
      for (const source of list.images) {
        if (source.legacy) {
          try {
            const legacy = await mod.loadOverlayImageFromServer(dieId, source.originalFilename);
            addLayer(legacy.name, legacy.image, true, legacy.serverFilename);
          } catch (error) {
            console.warn("Failed to load legacy overlay", source.name, error);
          }
        } else {
          addTiledLayer(source, true); // Preserve the prior auto-load hidden default.
        }
      }
      // Restore persisted visibility/opacity/offset settings.
      applyOverlaySettingsFromPrefs(dieId);
    });
  }, [dieId]);

  // Persist overlay layer settings (visibility, opacity, offset) on change.
  useEffect(() => {
    if (!dieId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = useOverlayLayers.subscribe(() => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => saveOverlaySettingsToPrefs(dieId), 500);
    });
    return () => { unsub(); if (timer !== null) clearTimeout(timer); };
  }, [dieId]);

  // Seed the (mockup, client-side) ML config from the die's annotations once
  // per die — `resetDieViewer` already restored defaults on the die change.
  const mlSeededRef = useRef<string | null>(null);
  useEffect(() => {
    if (!annotations || mlSeededRef.current === dieId) return;
    mlSeededRef.current = dieId;
    useDieViewerStore
      .getState()
      .setMlConfig(annotations.mlConfig ?? DEFAULT_ML_CONFIG);
  }, [dieId, annotations]);

  // ML tab / ML-config changes → repaint so traces/vias resize live.
  // The tab now lives in (persisted) preferences; mlConfig stays transient.
  useEffect(() => {
    const invalidate = () => canvasHandle.current?.invalidate();
    const unsubTab = usePreferences.subscribe(
      (s) => s.inspectorTab,
      (tab, prevTab) => {
        invalidate();
        if (prevTab === "ai" && tab !== "ai") {
          setAssistantFinding(null);
        }
      }
    );
    let prevMl = useDieViewerStore.getState().mlConfig;
    const unsubMl = useDieViewerStore.subscribe((s) => {
      if (s.mlConfig !== prevMl) {
        prevMl = s.mlConfig;
        invalidate();
      }
    });
    return () => {
      unsubTab();
      unsubMl();
    };
  }, []);

  const hiddenKinds = usePreferences((s) => s.hiddenKinds);
  useEffect(() => {
    if (!annotationLayer) return;
    const visible = ANNOTATION_KIND_VALUES.filter((k) => !hiddenKinds.includes(k));
    annotationLayer.setVisibleKinds(new Set(visible));
  }, [annotationLayer, hiddenKinds]);

  // Individually-hidden nets and cell types — layered on top of the "net"/
  // "cell" kinds' all-or-nothing toggles above. Cell types aren't their own
  // annotation (only individual cells are), so a hidden cell type expands to
  // every cell id sharing that cellTypeId.
  const hiddenNetIds = usePreferences((s) => s.hiddenNetIds);
  const hiddenCellTypeIds = usePreferences((s) => s.hiddenCellTypeIds);
  const cellIdsByType = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const c of annotations?.cells ?? []) {
      const list = m.get(c.cellTypeId);
      if (list) list.push(`cell:${c.id}`);
      else m.set(c.cellTypeId, [`cell:${c.id}`]);
    }
    return m;
  }, [annotations]);
  useEffect(() => {
    if (!annotationLayer) return;
    const overrides = new Map<string, boolean>();
    for (const [id, hidden] of Object.entries(hiddenNetIds)) {
      overrides.set(id, !hidden);
    }
    for (const [cellTypeId, hidden] of Object.entries(hiddenCellTypeIds)) {
      const cellIds = cellIdsByType.get(cellTypeId);
      if (!cellIds) continue;
      for (const cellId of cellIds) overrides.set(cellId, !hidden);
    }
    annotationLayer.setIdOverrides(overrides.size ? overrides : null);
  }, [annotationLayer, hiddenNetIds, hiddenCellTypeIds, cellIdsByType]);

  // Push selection changes into the annotation layer so its draw highlights.
  // ML vias get the same set — the layer filters out non-`ml-via:` ids itself.
  const selectedIds = useDieViewerStore((s) => s.selectedIds);
  useEffect(() => {
    annotationLayer?.setSelectedIds(selectedIds);
    mlViasLayer?.setSelectedIds(selectedIds);
    proposalLayer?.setSelectedIds(selectedIds);
  }, [annotationLayer, mlViasLayer, proposalLayer, selectedIds]);

  // Overlay image layers — one Layer instance per user-loaded image.
  // Instances live in a ref so they persist across renders; the map is
  // rebuilt when layers are added/removed (new id => new instance).
  // Each instance reads display state live from the store via callbacks.
  const overlayLayerInstancesRef = useRef<Map<string, OverlayImageLayer>>(
    new Map()
  );
  const overlayEntries = useOverlayLayers((s) => s.layers);
  const overlayLayerInstances = useMemo(() => {
    const map = overlayLayerInstancesRef.current;
    // Create instances for new layers.
    const instances: OverlayImageLayer[] = [];
    for (const entry of overlayEntries) {
      let layer = map.get(entry.id);
      if (!layer || layer.id !== `overlay:${entry.id}`) {
        layer = new OverlayImageLayer(`overlay:${entry.id}`, dieId ?? "", {
          getImage: () => {
            const live = useOverlayLayers
              .getState()
              .layers.find((l) => l.id === entry.id);
            return live?.image ?? null;
          },
          getSource: () => {
            const live = useOverlayLayers
              .getState()
              .layers.find((l) => l.id === entry.id);
            return live?.source ?? null;
          },
          getHidden: () => {
            const live = useOverlayLayers
              .getState()
              .layers.find((l) => l.id === entry.id);
            return live?.hidden ?? true;
          },
          getOpacity: () => {
            const live = useOverlayLayers
              .getState()
              .layers.find((l) => l.id === entry.id);
            return live?.opacity ?? 1;
          },
          getOffsetX: () => {
            const live = useOverlayLayers
              .getState()
              .layers.find((l) => l.id === entry.id);
            return live?.offsetX ?? 0;
          },
          getOffsetY: () => {
            const live = useOverlayLayers
              .getState()
              .layers.find((l) => l.id === entry.id);
            return live?.offsetY ?? 0;
          }
        });
        map.set(entry.id, layer);
      }
      instances.push(layer);
    }
    // Remove stale instances.
    for (const [id, layer] of map) {
      if (!overlayEntries.find((l) => l.id === id)) {
        layer.dispose();
        map.delete(id);
      }
    }
    return instances;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlayEntries.length, overlayEntries.map((e) => e.id).join(",")]);

  // Render-status snapshots are intentionally sampled rather than pushed on
  // every tile event. Four updates per second make progress visible without
  // turning network decoding into a React render loop.
  useEffect(() => {
    const collect = () => {
      const world = canvasHandle.current?.getWorldRect();
      if (!world) {
        setLiveRenderStatus((previous) => (previous == null ? previous : null));
        return;
      }
      const stats: OverlayViewportStats[] = [];
      for (const layer of overlayLayerInstancesRef.current.values()) {
        const snapshot = layer.getViewportStats(world, canvasHandle.current?.getViewport().zoom ?? 1);
        if (snapshot) stats.push(snapshot);
      }
      if (stats.length === 0) {
        setLiveRenderStatus((previous) => (previous == null ? previous : null));
        return;
      }
      const next = {
        total: stats.reduce((sum, stat) => sum + stat.total, 0),
        loaded: stats.reduce((sum, stat) => sum + stat.loaded, 0),
        pending: stats.reduce((sum, stat) => sum + stat.pending, 0),
        queued: stats.reduce((sum, stat) => sum + stat.queued, 0),
        loading: stats.reduce((sum, stat) => sum + stat.loading, 0),
        tilesPerSecond: stats.reduce((sum, stat) => sum + stat.tilesPerSecond, 0),
        preview: stats.some((stat) => stat.preview),
        lastRenderMs: Math.max(...stats.map((stat) => stat.lastRenderMs ?? 0))
      };
      setLiveRenderStatus((previous) =>
        previous &&
        previous.total === next.total &&
        previous.loaded === next.loaded &&
        previous.pending === next.pending &&
        previous.queued === next.queued &&
        previous.loading === next.loading &&
        Math.round(previous.tilesPerSecond * 10) === Math.round(next.tilesPerSecond * 10) &&
        previous.preview === next.preview &&
        Math.round(previous.lastRenderMs) === Math.round(next.lastRenderMs)
          ? previous
          : next
      );
    };
    collect();
    const interval = window.setInterval(collect, 250);
    return () => window.clearInterval(interval);
  }, [overlayLayerInstances]);

  const liveRenderStatusText = useMemo(() => {
    if (!liveRenderStatus) return null;
    const duration = `${Math.round(liveRenderStatus.lastRenderMs)} ms`;
    const speed = `${liveRenderStatus.tilesPerSecond.toFixed(1)} tile/s`;
    if (liveRenderStatus.preview && liveRenderStatus.pending > 0) {
      return `render preview / ${liveRenderStatus.loaded}/${liveRenderStatus.total} / ${liveRenderStatus.queued} queued / ${liveRenderStatus.loading} sharp / ${speed}`;
    }
    if (liveRenderStatus.pending > 0) {
      return `render ${liveRenderStatus.loaded}/${liveRenderStatus.total} / ${liveRenderStatus.queued} queued / ${liveRenderStatus.loading} sharp / ${speed} / ${duration}`;
    }
    return `render ${liveRenderStatus.total} tiles / ${speed} / ${duration}`;
  }, [liveRenderStatus]);
  const allLayers = useMemo<Layer[]>(() => {
    // Paint order: die image → overlay layers → ML via overlay → user annotations.
    const out: Layer[] = [...layers];
    for (const ol of overlayLayerInstances) out.push(ol);
    if (wireMapLayer) out.push(wireMapLayer);
    if (mlViasLayer) out.push(mlViasLayer);
    if (proposalLayer) out.push(proposalLayer);
    if (annotationLayer) out.push(annotationLayer);
    return out;
  }, [
    layers,
    wireMapLayer,
    overlayLayerInstances,
    mlViasLayer,
    proposalLayer,
    annotationLayer
  ]);

  // ── Behaviors (extracted hooks) ─────────────────────────────────

  const { initialViewport, onViewportChange } = usePersistedViewport({
    dieId,
    die,
    viewportLive,
    containerRef
  });

  // Double-click on a net (select tool) → non-modal rename window anchored
  // at the cursor (NetRenamePopover). The rename itself is undoable.
  const [netRename, setNetRename] = useState<{ netId: string; at: { x: number; y: number } } | null>(null);
  const renameNet = useCallback(
    (netId: string) => {
      if (!annotationsRef.current?.nets.some((n) => n.id === netId)) return;
      const at = cursorLive.get() ?? { x: 0, y: 0 };
      setNetRename({ netId, at: { x: at.x, y: at.y } });
    },
    [cursorLive]
  );
  const commitNetRename = useCallback(
    async (netId: string, name: string, color: string | null | undefined) => {
      // Re-read: the net may have changed while the window was open.
      const current = annotationsRef.current?.nets.find((n) => n.id === netId);
      if (!current) return false;
      if (name !== current.name) {
        const ok = await dispatcherRef.current.dispatch({
          kind: "upsertNet",
          net: { ...current, name },
          prevNet: current
        });
        if (!ok) {
          toast.error("Failed to rename net");
          return false;
        }
      }
      // Per-user color override (preferences, same as the outline swatch).
      if (color !== undefined) usePreferences.getState().setNetColorsForIds([`net:${netId}`], color);
      return true;
    },
    [toast]
  );
  const closeNetRename = useCallback(() => setNetRename(null), []);

  // Double-click on a placed via (select tool) → color window for it, or for
  // every placed via in the selection when it is part of it. Undoable.
  const [viaColorEdit, setViaColorEdit] = useState<{ viaId: string; targetIds: string[]; at: { x: number; y: number } } | null>(null);
  const openViaColor = useCallback((selectionId: string, at: { x: number; y: number }) => {
    const anns = annotationsRef.current;
    if (!anns) return;
    const targetIds = viaColorTargets(anns, useDieViewerStore.getState().selectedIds, selectionId);
    if (targetIds.length === 0) return;
    setViaColorEdit({ viaId: selectionId.slice(5), targetIds, at });
  }, []);
  const commitViaColor = useCallback(
    async (targetIds: string[], color: string | null) => {
      // Re-read: the vias may have changed while the window was open.
      const anns = annotationsRef.current;
      if (!anns) return false;
      const vias = targetIds.map((id) => viaFromSelectionId(anns, id)).filter((a) => a !== null);
      const action = viaColorAction(vias, color);
      if (!action) return true;
      const ok = await dispatcherRef.current.dispatch(action);
      if (!ok) toast.error("Failed to change via color");
      return ok;
    },
    [toast]
  );
  const closeViaColor = useCallback(() => setViaColorEdit(null), []);
  const viaLayerColorPrefs = usePreferences((s) => s.viaLayerColors);
  const globalViaColor = usePreferences((s) => s.viaColor);
  const sessionMetalStack = useSession((s) => s.metalStack);
  const closeCellTypePicker = useCallback(() => setCellTypePicker(null), []);
  // Dragged element windows re-anchor when their anchor point is deleted.
  useWindowAnchorMaintenance(dieId, annotations);
  const netColorOverrides = usePreferences((s) => s.netColors);
  const globalNetColor = usePreferences((s) => s.netColor);
  const customNetColorsEnabled = usePreferences((s) => s.customNetColorsEnabled);

  const { selectFromHit, clearSelectionFromEmpty, selectFromMarquee } =
    useCanvasSelection({ onNetDoubleClick: renameNet });

  // Snap-to-vias plumbing (wire + multi-wire). Combines the user's manually-
  // placed vias (`annotations.annotations` of class point/irregular via, with
  // irregular vias snapping to their centroid) with the live ML predictions
  // held by `mlViasLayer`. The latter's `findNearestPointVia` is itself
  // centroid-aware. Reads `annotations` fresh from the existing
  // `annotationsRef` mirror so the snap closure stays referentially stable.
  /** Find a manual via annotation and return its layer id + centre.
   *  Used by the wire tool for cross-layer snap detection. */
  const findViaAnnotation = useCallback(
    (world: Point, tolWorld: number): { viaId: string; x: number; y: number } | null => {
      const anns = annotationsRef.current?.annotations;
      if (!anns) return null;
      let best: { viaId: string; x: number; y: number } | null = null;
      let bestD = tolWorld;
      for (const a of anns) {
        if (!a.layer) continue;
        const g = a.geometry;
        let cx: number, cy: number;
        if (g.kind === "point") { cx = g.x; cy = g.y; }
        else if (g.kind === "rectangle") { cx = g.x + g.width / 2; cy = g.y + g.height / 2; }
        else if (g.kind === "polygon" && g.points.length > 0) {
          let sx = 0, sy = 0;
          for (const p of g.points) { sx += p.x; sy += p.y; }
          cx = sx / g.points.length; cy = sy / g.points.length;
        } else continue;
        const d = Math.hypot(cx - world.x, cy - world.y);
        if (d <= bestD) { bestD = d; best = { viaId: a.layer, x: cx, y: cy }; }
      }
      return best;
    },
    []
  );

  const autoViaEnabled = useCallback(
    () => usePreferences.getState().autoViaEnabled,
    []
  );

  const findNearestVia = useCallback(
    (world: Point, tolWorld: number): Point | null => {
      let best: Point | null = null;
      let bestD = tolWorld;
      const anns = annotationsRef.current?.annotations;
      if (anns) {
        for (const a of anns) {
          const g = a.geometry;
          let cx: number, cy: number;
          if (a.class === "point_via" && g.kind === "point") {
            cx = g.x;
            cy = g.y;
          } else if (a.class === "irregular_via" && g.kind === "rectangle") {
            cx = g.x + g.width / 2;
            cy = g.y + g.height / 2;
          } else if (
            a.class === "irregular_via" &&
            g.kind === "polygon" &&
            g.points.length > 0
          ) {
            let sx = 0;
            let sy = 0;
            for (const p of g.points) {
              sx += p.x;
              sy += p.y;
            }
            cx = sx / g.points.length;
            cy = sy / g.points.length;
          } else {
            continue;
          }
          const d = Math.hypot(cx - world.x, cy - world.y);
          if (d <= bestD) {
            bestD = d;
            best = { x: cx, y: cy };
          }
        }
      }
      // ML vias from the layer's tile cache (covers everything currently
      // visible plus anything ever loaded earlier — see the layer's
      // cross-level draw pass).
      const ml = mlViasLayer?.findNearestPointVia(world, bestD);
      if (ml) {
        const d = Math.hypot(ml.x - world.x, ml.y - world.y);
        if (d <= bestD) {
          bestD = d;
          best = ml;
        }
      }
      return best;
    },
    [mlViasLayer]
  );
  const snapToViasEnabled = useCallback(
    () => usePreferences.getState().snapToVias,
    []
  );
  const getViaSizeWorld = useCallback(
    () => usePreferences.getState().viaSize,
    []
  );

  /** First via lying on the open segment `a`–`b` within `perpTol` of the line,
   *  preferring the one closest to `a`. Mirrors `findNearestVia`'s source set
   *  (manual annotations of point / irregular via, plus cached ML vias) so the
   *  auto-end-on-via path sees exactly what's on screen. Used by the wire and
   *  multi-wire tools when the "auto-end on via" pref is enabled. */
  const findViaOnSegment = useCallback(
    (a: Point, b: Point, perpTol: number): Point | null => {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lenSq = dx * dx + dy * dy;
      if (lenSq === 0) return null;
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
      const anns = annotationsRef.current?.annotations;
      if (anns) {
        for (const ann of anns) {
          const g = ann.geometry;
          if (ann.class === "point_via" && g.kind === "point") {
            consider(g.x, g.y);
          } else if (
            ann.class === "irregular_via" &&
            g.kind === "rectangle"
          ) {
            consider(g.x + g.width / 2, g.y + g.height / 2);
          } else if (
            ann.class === "irregular_via" &&
            g.kind === "polygon" &&
            g.points.length > 0
          ) {
            let sx = 0;
            let sy = 0;
            for (const p of g.points) {
              sx += p.x;
              sy += p.y;
            }
            consider(sx / g.points.length, sy / g.points.length);
          }
        }
      }
      const ml = mlViasLayer?.findPointViaOnSegment(a, b, perpTol);
      if (ml) consider(ml.x, ml.y);
      return best;
    },
    [mlViasLayer]
  );
  const autoEndOnViaEnabled = useCallback(
    () => usePreferences.getState().wireAutoEndOnVia,
    []
  );
  const autoEndOnContactEnabled = useCallback(
    () => usePreferences.getState().autoEndOnContact,
    []
  );

  // ── Cell-terminal snapping ────────────────────────────────────
  // Build terminal positions from all cell instances (metal1 n contact
  // on each cell type). Memoized on annotations so it recomputes when
  // layers or cell placements change.
  const cellTerminals = useMemo(
    () =>
      buildInstanceTerminalMap(
        annotations?.cellTypes ?? [],
        annotations?.cells ?? []
      ),
    [annotations?.cellTypes, annotations?.cells]
  );
  // Device-electrode terminals (from the extraction pipeline's `_termPoints`,
  // already orientation-correct). These cover cell types whose metal1/contact
  // geometry doesn't yield a `buildInstanceTerminalMap` target (notably MOS),
  // so wire snapping lands on the same points the labels are drawn at.
  const deviceTerminalsRef = useRef<TerminalSnapTarget[]>([]);
  const findNearestTerminal = useCallback(
    (world: Point, tolWorld: number): TerminalSnapTarget | null => {
      let best: TerminalSnapTarget | null = null;
      let bestD = tolWorld;
      // Check cell-instance terminals.
      for (const t of cellTerminals) {
        const d = Math.hypot(t.worldX - world.x, t.worldY - world.y);
        if (d <= bestD) {
          bestD = d;
          best = { x: t.worldX, y: t.worldY, terminalId: t.id };
        }
      }
      // Check extracted device electrodes.
      for (const t of deviceTerminalsRef.current) {
        const d = Math.hypot(t.x - world.x, t.y - world.y);
        if (d <= bestD) {
          bestD = d;
          best = t;
        }
      }
      // Also check IO pins from annotations.
      const pins = annotationsRef.current?.pins ?? [];
      for (const pin of pins) {
        const d = Math.hypot(pin.x - world.x, pin.y - world.y);
        if (d <= bestD) {
          bestD = d;
          best = { x: pin.x, y: pin.y, terminalId: `pin:${pin.id}` };
        }
      }
      return best;
    },
    [cellTerminals]
  );

  // ── Overlay toggles (persisted in preferences) ──────────────
  const deviceOverlayOn = usePreferences((s) => s.deviceOverlayOn);
  const setDeviceOverlayOn = usePreferences((s) => s.setDeviceOverlayOn);
  const showTermNetIds = usePreferences((s) => s.showTermNetIds);
  const setShowTermNetIds = usePreferences((s) => s.setShowTermNetIds);
  const floorplanOverlayOn = usePreferences((s) => s.floorplanOverlayOn);
  const setFloorplanOverlayOn = usePreferences((s) => s.setFloorplanOverlayOn);
  const showFloorplanIO = usePreferences((s) => s.showFloorplanIO);
  const setShowFloorplanIO = usePreferences((s) => s.setShowFloorplanIO);
  const cellsLocked = usePreferences((s) => s.cellsLocked);
  const setCellsLocked = usePreferences((s) => s.setCellsLocked);
  const viaLabelsVisible = usePreferences((s) => s.viaLabelsVisible);
  const setViaLabelsVisible = usePreferences((s) => s.setViaLabelsVisible);
  const llmProvider = usePreferences((s) => s.llmProvider);
  const setLlmProvider = usePreferences((s) => s.setLlmProvider);
  const assistantDataFlags = usePreferences((s) => s.assistantDataFlags);
  const setAssistantDataFlags = usePreferences((s) => s.setAssistantDataFlags);
  const assistantMaxHypotheses = usePreferences((s) => s.assistantMaxHypotheses);
  const setAssistantMaxHypotheses = usePreferences((s) => s.setAssistantMaxHypotheses);
  const ngspiceMode = usePreferences((s) => s.ngspiceMode);
  const setNgspiceMode = usePreferences((s) => s.setNgspiceMode);
  const ngspicePath = usePreferences((s) => s.ngspicePath);
  const setNgspicePath = usePreferences((s) => s.setNgspicePath);
  const showCellRelations = usePreferences((s) => s.showCellRelations);
  const setShowCellRelations = usePreferences((s) => s.setShowCellRelations);
  const [selectedDevice, setSelectedDevice] = useState<AnalogDevice | null>(null);
  /** Preview-only finding currently focused from the AI Analysis tab. */
  const [assistantFinding, setAssistantFinding] = useState<AssistantFinding | null>(null);
  /** Increments even when the same card is re-selected, forcing a canvas redraw. */
  const [assistantFindingNonce, setAssistantFindingNonce] = useState(0);
  const [showProblems, setShowProblems] = useState(false);

  useEffect(() => {
    loadClipper();
  }, []);

  // Re-compute devices when registry or annotations change (cached + async).
  const {
    devices: analogDevices,
    netNames,
    unconnectedCount,
    warnings: analogWarnings,
    netIdMap,
  } = useDieExtraction(annotations as any);
  const { progress: extractionProgress, isRunning: extractionRunning, lastTimeMs, lastCached } = useExtractionProgress();

  // Feed the extracted device electrodes into the wire-snap candidates.
  useEffect(() => {
    const out: TerminalSnapTarget[] = [];
    for (const d of analogDevices) {
      const pts = (d as { _termPoints?: Array<{ x: number; y: number; name: string }> })._termPoints;
      if (!pts || pts.length === 0) continue;
      const cellId = (d as { _cellId?: string })._cellId ?? "";
      for (const p of pts) {
        out.push({ x: p.x, y: p.y, terminalId: `dev:${cellId}:${p.name}` });
      }
    }
    deviceTerminalsRef.current = out;
  }, [analogDevices]);

  // Rebuild the per-net device-electrode connection grid from the extracted
  // devices. Only terminals whose resolved netId maps to a real annotation net
  // count — an unconnected terminal (netId >= 2000) never marks a node, so
  // removing a connection stops its dot from appearing.
  useEffect(() => {
    const byNet = new Map<string, Set<string>>();
    const uuidByNumeric = new Map<number, string>();
    for (const [uuid, num] of netIdMap) uuidByNumeric.set(num, uuid);
    for (const d of analogDevices) {
      const pts = (d as { _termPoints?: Array<{ x: number; y: number; name: string }> })._termPoints;
      if (!pts || pts.length === 0) continue;
      const terms = (d as { terminals?: Array<{ name: string; netId: number }> }).terminals ?? [];
      for (const p of pts) {
        const term = terms.find((t) => t.name === p.name);
        if (!term) continue;
        const uuid = uuidByNumeric.get(term.netId);
        if (!uuid) continue; // unconnected or synthetic net
        let grid = byNet.get(uuid);
        if (!grid) {
          grid = new Set();
          byNet.set(uuid, grid);
        }
        grid.add(
          `${Math.floor(p.x / DEVICE_CONN_GRID_PX)},${Math.floor(p.y / DEVICE_CONN_GRID_PX)}`
        );
      }
    }
    deviceConnPointsByNetRef.current = byNet;
    canvasHandle.current?.invalidate();
  }, [analogDevices, netIdMap]);

  // Reverse map: numeric netId → annotation net UUID (for zoom)
  const netIdToUuid = useMemo(() => {
    const m = new Map<number, string>();
    for (const [uuid, id] of netIdMap) m.set(id, uuid);
    return m;
  }, [netIdMap]);

  // cellTypeId → instance count, cellId → cellTypeId (for cell relationship display)
  const cellTypeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (annotations) for (const c of annotations.cells ?? []) counts.set(c.cellTypeId, (counts.get(c.cellTypeId) ?? 0) + 1);
    return counts;
  }, [annotations]);
  const cellTypeByCellId = useMemo(() => {
    const m = new Map<string, string>();
    if (annotations) for (const c of annotations.cells ?? []) m.set(c.id, c.cellTypeId);
    return m;
  }, [annotations]);

  const totalProblems = useMemo(() => {
    if (!annotations || !analogDevices.length && !analogWarnings.length) return 0;
    try {
      const p = collectProblems(annotations as any, analogDevices, netNames, useSession.getState().metalStack ?? undefined);
      return p.connErrors.length + p.unconnNets.length + p.unconnWires.length
        + p.danglingVias.length + p.pinMismatches.length + p.overlappingWires.length + analogWarnings.length;
    } catch { return 0; }
  }, [annotations, analogDevices, netNames, analogWarnings]);

  // Mirror analogDevices in a ref so callbacks passed to TiledCanvas
  // (onCanvasClick, onCanvasDoubleClick) don't get new references on
  // every annotation tick, preventing unnecessary tile cache flushes.
  const analogDevicesRef = useRef(analogDevices);
  analogDevicesRef.current = analogDevices;

  // Build device labels per cell instance. Multi-finger MOS is split into
  // separate devices sharing one cellId — concatenate instance names.
  const deviceLabels = useMemo(() => {
    const m = new Map<string,string>();
    for(const d of analogDevices){
      const cid = (d as any)._cellId;
      if(!cid) continue;
      const name = d.instanceName??d.id;
      const existing = m.get(cid);
      const newLabel = existing ? `${existing} ${name}` : name;
      m.set(cid, newLabel);

    }

    return m;
  }, [analogDevices]);

  const wire = useWireTool({
    dispatcher,
    annotationLayer,
    annotations,
    viewportLive,
    wirePreviewLive,
    activeTool,
    setActiveTool,
    findNearestVia,
    findViaOnSegment,
    snapToViasEnabled,
    autoEndOnViaEnabled,
    getViaSizeWorld,
    findNearestTerminal,
    autoEndOnContactEnabled,
    findViaAnnotation,
    autoViaEnabled,
  });
  wireRef.current = wire;

  const cell = useCellTool({
    dispatcher,
    annotations,
    cellRectLive,
    activeTool,
    setActiveTool
  });

  const libraryCell = useLibraryCellTool({
    dieId,
    library,
    dispatcher,
    viewportLive,
    containerRef,
    activeTool
  });

  // The analog library: parametric devices (pmos / nmos / npn / pnp / lpnp)
  // laid out from their parameters and placed over the die image.
  const analogCell = useAnalogCellTool({
    dieId,
    dispatcher,
    viewportLive,
    activeTool,
    setActiveTool,
    dieScale: library.scale,
    umPerPx: ownAnnotations?.umPerPx ?? null
  });

  const viaPoly = useViaPolyTool({ dispatcher, activeTool, setActiveTool });
  const viaPolyPointsRef = useRef(viaPoly.points);
  viaPolyPointsRef.current = viaPoly.points;
  /** Next vertex of the floorplan / via polygon being drawn: `world`
   *  constrained to that tool's angle mode from the previous vertex (free
   *  for the first vertex or while Shift is held). */
  const constrainPolyPoint = useCallback(
    (tool: "floorplan" | "viaPoly", world: Point, shift: boolean): Point => {
      let last: Point | undefined;
      if (tool === "viaPoly") {
        last = viaPolyPointsRef.current[viaPolyPointsRef.current.length - 1];
      } else {
        const d = useFloorplanStore.getState().draft;
        if (d?.kind === "poly" && d.active) last = d.points[d.points.length - 1];
      }
      return last && !shift ? constrainPoint(last, world, currentAngleMode(tool)) : world;
    },
    []
  );
  const guide = useGuideTool({ dispatcher, activeTool, setActiveTool });
  const multiWire = useMultiWireTool({
    dispatcher,
    annotations,
    activeTool,
    setActiveTool
  });

  // Phase-aware multi-wire help (kept short so the toolbar stays compact).
  const multiWireHint = useMemo(() => {
    if (multiWire.phase === 1) {
      const n = multiWire.points.length;
      return n === 0
        ? "click bus start points, then Enter"
        : `${n} start${n > 1 ? "s" : ""} · Enter to continue · Esc to cancel`;
    }
    const d = multiWire.draft;
    const running = d.points.filter((_, i) => !d.locked[i]).length;
    const placed = d.pending.filter(Boolean).length;
    const ended = d.locked.filter(Boolean).length;
    const round = placed > 0
      ? `corner ${placed + 1} of ${running}`
      : `click near each wire to place its corner (${running})`;
    const lead = multiWire.continued
      ? `continuing from ${multiWire.points.length} ends · `
      : "";
    return `${lead}${round} · Enter / double-click to finish${ended ? ` · ${ended} ended on vias` : ""} · Esc to cancel`;
  }, [multiWire.phase, multiWire.points, multiWire.draft, multiWire.continued]);

  /**
   * Multi-wire phase-2 helper: find the via the cursor is pointing at and
   * decide which wire to land on it. The via search is at the **raw
   * cursor** — symmetric with the phase-1 start snap — so "point at a via
   * and the wire ends there" works no matter where the via sits relative
   * to the bus's 45° axis. The locked wire then runs straight from its
   * start to that via (it leaves the parallel front; via routing wants
   * each wire on its own via).
   *
   * Which wire gets locked: the still-sweeping one whose current projected
   * endpoint is closest to the via — i.e. the wire already ending nearest
   * where you're pointing.
   *
   * Returns null when via-snap is off, Shift bypasses, or no via lies
   * within tolerance of the cursor. Shared by the click commit and the
   * live snap-halo so the halo previews exactly where the click lands.
   */
  const findMultiWireEndpointViaSnap = useCallback(
    (
      world: Point,
      shift: boolean
    ): { endpoint: Point; via: Point; lockIndex: number } | null => {
      const vp = viewportLive.get();
      if (
        !vp ||
        shift ||
        !usePreferences.getState().snapToVias ||
        multiWire.phase !== 2
      ) {
        return null;
      }
      const tol = viaSnapTolerance(vp.zoom, usePreferences.getState().viaSize);
      const via = findNearestVia(world, tol);
      if (!via) return null;
      const V: Point = { x: Math.round(via.x), y: Math.round(via.y) };
      // Pick which wire to end: the one still waiting for its corner whose
      // live end (exactly what the overlay draws) is closest to the via.
      const ends = previewEnds(multiWire.draft, world, false);
      let best = -1;
      let bestDist = Infinity;
      ends.forEach((wireEnd, i) => {
        if (!wireEnd) return; // ended, or corner already placed this round
        const d = Math.hypot(wireEnd.x - V.x, wireEnd.y - V.y);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      });
      if (best < 0) return null;
      return { endpoint: V, via: V, lockIndex: best };
    },
    [findNearestVia, multiWire, viewportLive]
  );

  /**
   * Auto-end-on-via path for the bus: when the pref is on, return one snap
   * per still-sweeping wire whose own projected segment (start → its endpoint
   * on the perpendicular front through the cursor) crosses a via. Each wire
   * lands on its own via — they don't have to share one. A single click then
   * locks them all in one batch via `multiWire.endWires`. Empty array when
   * the pref is off, Shift bypasses, no wires are unlocked, or no projections
   * cross a via.
   */
  const findMultiWireAutoEndSnaps = useCallback(
    (
      world: Point,
      shift: boolean
    ): Array<{ endpoint: Point; lockIndex: number }> => {
      const vp = viewportLive.get();
      if (
        !vp ||
        shift ||
        !usePreferences.getState().wireAutoEndOnVia ||
        multiWire.phase !== 2
      ) {
        return [];
      }
      const tol = viaSnapTolerance(vp.zoom, usePreferences.getState().viaSize);
      const out: Array<{ endpoint: Point; lockIndex: number }> = [];
      previewEnds(multiWire.draft, world, false).forEach((end, i) => {
        if (!end) return;
        const p = tipOf(multiWire.draft, i);
        if (end.x === p.x && end.y === p.y) return;
        const via = findViaOnSegment(p, end, tol);
        if (via) {
          out.push({
            endpoint: { x: Math.round(via.x), y: Math.round(via.y) },
            lockIndex: i
          });
        }
      });
      return out;
    },
    [findViaOnSegment, multiWire, viewportLive]
  );

  /**
   * Walk `selectedIds` and pull out every entry that names a single point in
   * world space (a manual via centroid, an ML via, or a net vertex). Used by
   * the right-click "Start multi-wire from selection" entry and by the
   * "multi point count" the menu shows. Whole-net / cell / ROI selections are
   * skipped — they don't name one specific point. Net vertices come back with
   * a `DrawAnchor` so the new wire extends that existing net.
   */
  const extractAnchorPointsFromSelection = useCallback(
    (
      ids: ReadonlySet<string>
    ): Array<{ point: Point; anchor: DrawAnchor | null }> => {
      const out: Array<{ point: Point; anchor: DrawAnchor | null }> = [];
      const ann = annotationsRef.current;
      for (const id of ids) {
        // ML via — synthetic position id, no persistent record.
        if (isMlViaId(id)) {
          const p = parseMlViaId(id);
          if (p) out.push({ point: p, anchor: null });
          continue;
        }
        // Net vertex sub-selection — anchor onto its existing net so the new
        // wire merges into it rather than starting parallel.
        const np = parseNetPartId(id);
        if (np && np.part === "node" && np.partId) {
          const net = ann?.nets.find((n) => n.id === np.netId);
          const node = net?.nodes.find((nd) => nd.id === np.partId);
          if (net && node) {
            out.push({
              point: { x: node.x, y: node.y },
              anchor: { netId: net.id, nodeId: node.id }
            });
          }
          continue;
        }
        // Manual via annotation — point geometry, rectangle bbox, or polygon
        // centroid (matches `findNearestVia`'s source set).
        if (id.startsWith("anno:")) {
          const a = ann?.annotations?.find((x) => x.id === id.slice(5));
          if (!a) continue;
          const g = a.geometry;
          if (a.class === "point_via" && g.kind === "point") {
            out.push({ point: { x: g.x, y: g.y }, anchor: null });
          } else if (a.class === "irregular_via" && g.kind === "rectangle") {
            out.push({
              point: { x: g.x + g.width / 2, y: g.y + g.height / 2 },
              anchor: null
            });
          } else if (
            a.class === "irregular_via" &&
            g.kind === "polygon" &&
            g.points.length > 0
          ) {
            let sx = 0;
            let sy = 0;
            for (const p of g.points) {
              sx += p.x;
              sy += p.y;
            }
            out.push({
              point: {
                x: sx / g.points.length,
                y: sy / g.points.length
              },
              anchor: null
            });
          }
        }
      }
      return out;
    },
    []
  );

  /** Switch to the wire tool and open a draft anchored at `point`. The wire
   *  tool's own snap / preview takes over from there. `beginDraftAt` discards
   *  any in-flight partial draft, so this is safe regardless of prior state. */
  const startWireAt = useCallback(
    (point: Point, anchor: DrawAnchor | null) => {
      setActiveTool("wire");
      wire.beginDraftAt(point, anchor);
    },
    [setActiveTool, wire]
  );

  /** Switch to multi-wire and open the bus directly in phase 2 with each
   *  selected via / vertex as a start point. */
  const startMultiWireFrom = useCallback(
    (picks: Array<{ point: Point; anchor: DrawAnchor | null }>) => {
      if (picks.length < 2) return;
      setActiveTool("multiWire");
      multiWire.beginPhase2(picks);
    },
    [setActiveTool, multiWire]
  );

  // Commit a rubber-band rectangle from the via-rect / ROI / ignore tools
  // (rounded, normalized, min-size-guarded). One undoable upsert each.
  const commitDrawnRect = useCallback(
    (toolKind: "viaRect" | "roi" | "ignore", r: Rect) => {
      const x = Math.round(Math.min(r.x, r.x + r.width));
      const y = Math.round(Math.min(r.y, r.y + r.height));
      const width = Math.round(Math.abs(r.width));
      const height = Math.round(Math.abs(r.height));
      if (width < 1 || height < 1) return;
      const id = uuid();
      let action: AnnotationAction;
      if (toolKind === "viaRect") {
        action = {
          kind: "upsertAnnotation",
          annotation: {
            id,
            class: "irregular_via",
            geometry: { kind: "rectangle", x, y, width, height },
            source: "human"
          },
          prevAnnotation: null
        };
      } else if (toolKind === "roi") {
        action = {
          kind: "upsertRoi",
          roi: {
            id,
            x,
            y,
            width,
            height,
            classes: [...usePreferences.getState().roiClasses]
          },
          prevRoi: null
        };
      } else {
        action = {
          kind: "upsertIgnore",
          ignore: { id, x, y, width, height },
          prevIgnore: null
        };
      }
      void dispatcher.dispatch(action);
    },
    [dispatcher]
  );

  const deleteSelectedRulers = useCallback(() => {
    const selected = selectedRulerIds;
    const rulers = annotationsRef.current?.rulers ?? [];
    const actions: AnnotationAction[] = rulers
      .filter((ruler) => selected.has(ruler.id))
      .map((ruler) => ({ kind: "removeRuler", ruler }));
    if (actions.length === 0) return;
    void dispatcher.dispatch(actions.length === 1 ? actions[0] : { kind: "batch", actions });
    setSelectedRulerIds(new Set());
    rulerDraftLive.set(null);
    rulerPendingLive.set(null);
  }, [dispatcher, selectedRulerIds, rulerDraftLive, rulerPendingLive]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== "Delete" && e.key !== "Backspace") || isTypingTarget(e.target)) return;
      if (selectedRulerIds.size === 0) return;
      e.preventDefault();
      deleteSelectedRulers();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteSelectedRulers, selectedRulerIds.size]);

  // Kind-agnostic Delete/Backspace handling for the current selection.
  useSelectionDelete({ dispatcher, annotations });
  // Global ⌘Z/⌘⇧Z — routes to a tool's undo override (e.g. wire draft) when
  // one is registered, else the action dispatcher.
  useUndoRedoHotkeys(dispatcher);
  // Overlay layer hotkeys (Space+B, ], [, Space+1..8).
  const toggleBaseImageForDie = useCallback(() => {
    const prefs = usePreferences.getState();
    const overlays = useOverlayLayers.getState();
    const hiddenForDie = prefs.baseImageHidden[dieId] === true;
    const visible = !hiddenForDie && overlays.baseImageVisible;
    if (visible) {
      overlays.toggleBaseImage();
    } else {
      if (hiddenForDie) prefs.setBaseImageHidden(dieId, false);
      if (!overlays.baseImageVisible) overlays.toggleBaseImage();
    }
  }, [dieId]);
  const toggleKindForDie = useCallback((kind: "cell" | "net" | "floorplan" | "comment") => {
    const prefs = usePreferences.getState();
    if (kind !== "floorplan") {
      prefs.toggleKindVisibility(kind);
      return;
    }
    // Same as the outline's Floorplans eye: all-or-nothing, clearing per-name
    // overrides. If the whole overlay is off (Settings), Space+H shows it.
    prefs.resetHiddenFloorplanTypes();
    if (!prefs.floorplanOverlayOn) {
      prefs.setFloorplanOverlayOn(true);
      if (prefs.hiddenKinds.includes("floorplan")) prefs.toggleKindVisibility("floorplan");
      return;
    }
    prefs.toggleKindVisibility("floorplan");
  }, []);
  useOverlayHotkeys(toggleBaseImageForDie, toggleKindForDie);

  // ── Cell edge resize (GIMP-style side handles) ──────────────────

  /** Side of the single selected (unlocked) cell under `world`, if any. */
  const selectedCellSideAt = useCallback(
    (world: Point, zoom: number) => {
      if (usePreferences.getState().cellsLocked) return null;
      const sel = resolveSelectedCell(
        useDieViewerStore.getState().selectedIds,
        annotationsRef.current
      );
      if (!sel) return null;
      const { width, height } = sel.cellType.cropRect;
      const side = cellSideAt(
        cellWorldRect(sel.cell, width, height),
        world,
        CELL_EDGE_GRAB_PX / zoom
      );
      return side ? { ...sel, side } : null;
    },
    []
  );

  // ── Pointer move / leave ────────────────────────────────────────

  /** Status-bar hover readout: the net under the cursor (via the annotation
   *  hit-test, so hidden nets are skipped) and the type names of the visible
   *  floorplan regions containing it. Region bodies are pointer-transparent,
   *  so they're tested geometrically rather than via DOM events. */
  const resolveHoverInfo = useCallback(
    (world: Point, zoom: number): HoverInfo | null => {
      let net: string | null = null;
      if (annotationLayer) {
        const tol = HIT_TOLERANCE_PX / zoom;
        const hit = annotationLayer.hitTest(world, tol, Math.max(tol, netNodePickWorldRadius(zoom)));
        const parsed = hit ? parseNetPartId(hit.partId) : null;
        if (parsed) {
          const n = annotationsRef.current?.nets.find((x) => x.id === parsed.netId);
          net = n ? n.name || n.id : parsed.netId;
        }
      }
      const prefs = usePreferences.getState();
      // Cell type(s) of the visible cells whose footprint contains the cursor
      // (same oriented footprint the canvas draws; overlapping cells → all).
      const cells: string[] = [];
      const anns = annotationsRef.current;
      if (anns) {
        const cellsHidden = prefs.hiddenKinds.includes("cell");
        const typeById = new Map(anns.cellTypes.map((t) => [t.id, t]));
        for (const c of anns.cells) {
          const override = prefs.hiddenCellTypeIds[c.cellTypeId];
          if (override === undefined ? cellsHidden : override) continue;
          const t = typeById.get(c.cellTypeId);
          if (!t) continue;
          if (!pointInRect(world, cellWorldRect(c, t.cropRect.width, t.cropRect.height))) continue;
          const name = t.name || "(unnamed)";
          if (!cells.includes(name)) cells.push(name);
        }
      }
      const floorplans: string[] = [];
      if (prefs.floorplanOverlayOn) {
        const globallyHidden = prefs.hiddenKinds.includes("floorplan");
        for (const r of useFloorplanStore.getState().regions) {
          const typeName = r.name || "(unnamed)";
          const override = prefs.hiddenFloorplanTypeNames[typeName];
          if (override === undefined ? globallyHidden : override) continue;
          const pts = r.geometry;
          if (pts.length < 2) continue;
          const inside =
            r.kind === "rect" || pts.length === 2
              ? pointInRect(world, rectFromPoints(pts[0], pts[pts.length - 1]))
              : pointInPolygon(world, pts);
          if (!inside) continue;
          const shown = floorplanNameInline(typeName) || typeName;
          if (!floorplans.includes(shown)) floorplans.push(shown);
        }
      }
      return net == null && cells.length === 0 && floorplans.length === 0
        ? null
        : { net, cells, floorplans };
    },
    [annotationLayer]
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const c = containerRef.current?.querySelector("canvas") as
        | HTMLCanvasElement
        | null;
      if (!c) return;
      const rect = c.getBoundingClientRect();
      const cssX = event.clientX - rect.left;
      const cssY = event.clientY - rect.top;
      const vp = canvasHandle.current?.getViewport();
      if (!vp) return;
      const world = {
        x: vp.originX + cssX / vp.zoom,
        y: vp.originY + cssY / vp.zoom
      };
      cursorLive.set(world);
      const edge =
        useDieViewerStore.getState().activeTool === "select" && !spacePanRef.current
          ? selectedCellSideAt(world, vp.zoom)
          : null;
      setCellResizeCursor(edge ? sideCursor(edge.side) : null);
      const hoverInfo = resolveHoverInfo(world, vp.zoom);
      if (!sameHoverInfo(hoverInfo, hoverInfoLive.get())) hoverInfoLive.set(hoverInfo);
      shiftRef.current = event.shiftKey;
      shiftLive.set(event.shiftKey);
      wire.computeWirePreview(world, event.shiftKey, vp.zoom);
      const tool = useDieViewerStore.getState().activeTool;
      viaPolyPreviewLive.set(tool === "viaPoly" ? constrainPolyPoint("viaPoly", world, event.shiftKey) : null);
      floorplanTipLive.set(tool === "floorplan" ? constrainPolyPoint("floorplan", world, event.shiftKey) : world);
      // Multi-wire preview snap. Phase 1: the halo previews the vertex /
      // via a start would snap to. Phase 2: `multiWireEndSnapLive` carries
      // which wire would lock onto a via and where — the overlay redraws
      // that wire ending on the via so the user sees the snap and knows
      // where to click. (Phase-2 has no entry in `multiWireSnapLive`.)
      let snap: { x: number; y: number } | null = null;
      let endSnaps: Array<{ lockIndex: number; x: number; y: number }> | null =
        null;
      if (tool === "multiWire" && annotationLayer) {
        if (multiWire.phase === 1) {
          // Vertex beats via — same precedence as the single-wire tool.
          const via = usePreferences.getState().snapToVias
            ? findNearestVia(
                world,
                viaSnapTolerance(vp.zoom, usePreferences.getState().viaSize)
              )
            : null;
          const node = wire.snapVertex(world, vp.zoom, via);
          if (node) {
            snap = { x: node.x, y: node.y };
          } else if (via) {
            snap = { x: Math.round(via.x), y: Math.round(via.y) };
          }
        } else {
          // Auto-end first (independent per-wire snaps); fall back to the
          // single nearest-cursor snap if auto-end has nothing to show.
          const autos = findMultiWireAutoEndSnaps(world, event.shiftKey);
          if (autos.length > 0) {
            endSnaps = autos.map((a) => ({
              lockIndex: a.lockIndex,
              x: a.endpoint.x,
              y: a.endpoint.y
            }));
          } else {
            const result = findMultiWireEndpointViaSnap(world, event.shiftKey);
            if (result) {
              endSnaps = [
                {
                  lockIndex: result.lockIndex,
                  x: result.via.x,
                  y: result.via.y
                }
              ];
            }
          }
        }
      }
      multiWireSnapLive.set(snap);
      multiWireEndSnapLive.set(endSnaps);
      // Single-wire pre-start hover: existing vertex or a virtual vertex on a
      // wire body (only before the first point is placed).
      wireSnapLive.set(
        tool === "wire" && !wire.draft ? wire.resolveWireSnap(world) : null
      );
      // The analog device template sticks to the pointer until it is dropped.
      if (tool === "analogCell") analogCell.follow(world);
    },
    [
      cursorLive,
      hoverInfoLive,
      resolveHoverInfo,
      shiftLive,
      wireSnapLive,
      wire,
      viaPolyPreviewLive,
      multiWireSnapLive,
      multiWireEndSnapLive,
      multiWire,
      annotationLayer,
      findNearestVia,
      findMultiWireEndpointViaSnap,
      findMultiWireAutoEndSnaps,
      selectedCellSideAt,
      analogCell
    ]
  );

  const onPointerLeave = useCallback(() => {
    cursorLive.set(null);
    hoverInfoLive.set(null);
    viaPolyPreviewLive.set(null);
    multiWireSnapLive.set(null);
    multiWireEndSnapLive.set(null);
    wireSnapLive.set(null);
  }, [
    cursorLive,
    hoverInfoLive,
    viaPolyPreviewLive,
    multiWireSnapLive,
    multiWireEndSnapLive,
    wireSnapLive
  ]);

  // ── Cell type reassignment (double-click picker) ─────────────────

  // Moving the last instance off an unmatched, never-RE'd placeholder type
  // would leave it orphaned — drop it in the same undo step.
  const orphanCleanup = useCallback((cell: Cell): AnnotationAction[] => {
    const ann = annotationsRef.current;
    const old = ann?.cellTypes.find((t) => t.id === cell.cellTypeId);
    if (!ann || !old || old.matched || old.layers) return [];
    const others = ann.cells.some((c) => c.cellTypeId === old.id && c.id !== cell.id);
    return others ? [] : [{ kind: "removeCellType", cellType: old }];
  }, []);

  const reassignCellType = useCallback(
    (cellId: string, cellType: CellType) => {
      setCellTypePicker(null);
      const cell = annotationsRef.current?.cells.find((c) => c.id === cellId);
      if (!cell || cell.cellTypeId === cellType.id) return;
      void dispatcher.dispatch({
        kind: "batch",
        actions: [
          // Adopts the target type's size, like its other instances.
          { kind: "upsertCell", cell: retypeCell(cell, cellType.id), prevCell: cell },
          ...orphanCleanup(cell)
        ]
      });
    },
    [dispatcher, orphanCleanup]
  );

  // Split: clone the current type (crop + RE'd layers carry over) under a
  // new id, and move just this instance onto it.
  const splitCellType = useCallback(
    (cellId: string, name: string) => {
      setCellTypePicker(null);
      const ann = annotationsRef.current;
      const cell = ann?.cells.find((c) => c.id === cellId);
      const old = cell && ann?.cellTypes.find((t) => t.id === cell.cellTypeId);
      if (!cell || !old) return;
      const cellType: CellType = { ...structuredClone(old), id: uuid(), name, matched: false };
      void dispatcher.dispatch({
        kind: "batch",
        actions: [
          { kind: "upsertCellType", cellType, prevCellType: null },
          { kind: "upsertCell", cell: { ...cell, cellTypeId: cellType.id }, prevCell: cell }
        ]
      });
    },
    [dispatcher]
  );

  // ── Canvas pointer-down router ──────────────────────────────────

  // Last plain (non-drag) click on an I/O pin, for double-click → rename.
  const lastPinClickRef = useRef<{ pinId: string; time: number } | null>(null);

  const routeCanvasPointerDown = useCallback(
    (e: PointerEventData): Interaction => {
      // Holding Space (or middle-drag, handled in the canvas) momentarily
      // forces pan regardless of the active tool.
      if (spacePanRef.current) return "pan";
      const tool = useDieViewerStore.getState().activeTool;

      // Place library cell: drag the template's body to move it, a corner to
      // scale it; anywhere else pans (and a click moves the template there).
      if (tool === "libraryCell") return libraryCell.pointerDown(e);

      // Place analog device: same gesture — drag the body to move the
      // template, a corner to stretch it over the device in the image.
      if (tool === "analogCell") return analogCell.pointerDown(e);

      if (tool === "measure" || tool === "select") {
        const vp = viewportLive.get();
        const tolerance = vp ? 10 / vp.zoom : 10;
        const rulerPrefs = usePreferences.getState();
        const hit = (annotationsRef.current?.rulers ?? []).find((ruler) =>
          (rulerPrefs.rulerVisibilityOverrides[ruler.id] ?? !rulerPrefs.rulersHidden) &&
          distancePointToSegment(e.worldPoint, { x: ruler.x1, y: ruler.y1 }, { x: ruler.x2, y: ruler.y2 }) <= tolerance
        );
        if (hit) {
          const next = e.modifiers.shift ? new Set(selectedRulerIds) : new Set<string>();
          if (next.has(hit.id)) next.delete(hit.id);
          else next.add(hit.id);
          setSelectedRulerIds(next);
          rulerDraftLive.set({ x1: hit.x1, y1: hit.y1, x2: hit.x2, y2: hit.y2 });
          rulerPendingLive.set(null);
          return "pan";
        }
        setSelectedRulerIds(new Set());
        rulerDraftLive.set(null);
        rulerPendingLive.set(null);
      }
      // Add-cell: rubber-band a rectangle. The rect lives in `cellRectLive`
      // (no page re-render while dragging) and stays as an *editable draft*
      // until the user presses Enter to commit (or Escape to discard) — see
      // useCellTool. While a draft exists, dragging a corner resizes it and
      // dragging the body moves it; a drag started outside the draft starts
      // a fresh rect (replacing the previous draft).
      if (tool === "addCell") {
        const vp = viewportLive.get();
        const tolWorld = vp ? 32 / vp.zoom : 32;
        const snap = (r: Rect): Rect => {
          const guides = annotationsRef.current?.guides;
          if (
            usePreferences.getState().cellSnapToGuides &&
            guides &&
            guides.length > 0
          ) {
            return snapRectToGuides(r, guides, tolWorld);
          }
          return r;
        };

        const pending = cellRectLive.get();
        if (pending) {
          const draft = normalizeRect(pending);
          // Corner-resize: nearest corner moves with the cursor, opposite
          // corner stays fixed as the anchor.
          const corner = rectCornerAt(draft, e.worldPoint, tolWorld);
          if (corner != null) {
            const fixed = rectCorners(draft)[(corner + 2) % 4];
            const setFromCorner = (wp: Point) =>
              cellRectLive.set(snap(rectFromPoints(fixed, wp)));
            return {
              onDragStart: ({ worldPoint }) => setFromCorner(worldPoint),
              onDragMove: ({ worldPoint }) => setFromCorner(worldPoint),
              onPointerUp: ({ worldPoint }) => setFromCorner(worldPoint),
              onCancel: () => cellRectLive.set(draft)
            };
          }
          // Body-move: translate the rect by the pointer delta.
          if (pointInRect(e.worldPoint, draft)) {
            const start = e.worldPoint;
            const moveTo = (wp: Point) =>
              cellRectLive.set({
                x: draft.x + (wp.x - start.x),
                y: draft.y + (wp.y - start.y),
                width: draft.width,
                height: draft.height
              });
            return {
              onDragStart: ({ worldPoint }) => moveTo(worldPoint),
              onDragMove: ({ worldPoint }) => moveTo(worldPoint),
              onPointerUp: ({ worldPoint }) => moveTo(worldPoint),
              onCancel: () => cellRectLive.set(draft)
            };
          }
        }

        // Otherwise: start a fresh rubber-band rect. On release we DO NOT
        // commit — the rect stays as a draft for Enter / further editing.
        const origin = { x: e.worldPoint.x, y: e.worldPoint.y };
        const setRect = (worldPoint: { x: number; y: number }) =>
          cellRectLive.set(snap(rectFromPoints(origin, worldPoint)));
        const drawRect: DragHandler = {
          onDragStart: ({ worldPoint }) => setRect(worldPoint),
          onDragMove: ({ worldPoint }) => setRect(worldPoint),
          onPointerUp: ({ dragged, worldPoint }) => {
            if (!dragged) return; // a plain click makes no cell
            setRect(worldPoint);
          },
          onCancel: () => cellRectLive.set(null)
        };
        return drawRect;
      }

      // Floorplan rect: rubber-band a rectangle, commit on release
      if (tool === "floorplan") {
        const fs = useFloorplanStore.getState();
        if (fs.toolMode === "rect" || fs.toolMode === "idle") {
          // Drag-based rect drawing
          const originPt = { x: Math.round(e.worldPoint.x), y: Math.round(e.worldPoint.y) };
          const floorplanDrag: DragHandler = {
            onDragStart: ({ worldPoint }) => {
              const p = { x: Math.round(worldPoint.x), y: Math.round(worldPoint.y) };
              useFloorplanStore.getState().setDraft({
                kind: "rect",
                points: [originPt, p],
                active: true,
              });
            },
            onDragMove: ({ worldPoint }) => {
              const draft = useFloorplanStore.getState().draft;
              if (draft && draft.points.length >= 1) {
                const p = { x: Math.round(worldPoint.x), y: Math.round(worldPoint.y) };
                useFloorplanStore.getState().setDraft({
                  ...draft,
                  points: [draft.points[0], p],
                });
              }
            },
            onPointerUp: ({ worldPoint, dragged }) => {
              useFloorplanStore.getState().setDraft(null);
              if (!dragged) return;
              const p = { x: Math.round(worldPoint.x), y: Math.round(worldPoint.y) };
              const minX = Math.min(originPt.x, p.x);
              const minY = Math.min(originPt.y, p.y);
              const maxX = Math.max(originPt.x, p.x);
              const maxY = Math.max(originPt.y, p.y);
              const au = useAuth.getState();
              const region: import("shared").FloorplanRegion = {
                id: uuid(),
                name: "",
                kind: "rect",
                geometry: [
                  { x: minX, y: minY },
                  { x: maxX, y: maxY },
                ],
                color: "#4dabf7",
                createdBy: au.userId ?? null,
                createdByName: au.username ?? null,
                createdAt: new Date().toISOString(),
                reservedBy: null,
                reservedByName: null,
                reservedAt: null,
              };
              // Undoable; the store mirrors annotations, upsert now for instant feedback.
              useFloorplanStore.getState().upsertRegion(region);
              useFloorplanStore.getState().openRegion(region.id);
              void dispatcherRef.current
                .dispatch({ kind: "upsertFloorplan", region, prevRegion: null })
                .then((ok) => { if (!ok) toast.error("Failed to save floorplan"); });
            },
            onCancel: () => {
              useFloorplanStore.getState().setDraft(null);
            },
          };
          return floorplanDrag;
        }
        // Poly mode — no drag, defer to onCanvasClick
        return "pan";
      }

      // Via-rect / ROI / ignore: rubber-band a rectangle, commit on release
      // (no Enter). Shares `shapeRectLive` + a generic overlay.
      if (tool === "viaRect" || tool === "roi" || tool === "ignore") {
        const origin = { x: e.worldPoint.x, y: e.worldPoint.y };
        // ROIs are always square (ML crops are square); the others are free.
        const rectFor = (wp: Point) =>
          tool === "roi"
            ? squareFromPoints(origin, wp)
            : rectFromPoints(origin, wp);
        const drawRect: DragHandler = {
          onDragStart: ({ worldPoint }) =>
            shapeRectLive.set(rectFor(worldPoint)),
          onDragMove: ({ worldPoint }) =>
            shapeRectLive.set(rectFor(worldPoint)),
          onPointerUp: ({ dragged, worldPoint }) => {
            shapeRectLive.set(null);
            if (dragged) commitDrawnRect(tool, rectFor(worldPoint));
          },
          onCancel: () => shapeRectLive.set(null)
        };
        return drawRect;
      }

      // Ruler tool: measure distance. Draw on drag, commit on release.
      if (tool === "measure") {
        const origin = { x: e.worldPoint.x, y: e.worldPoint.y };
        const snapOrtho = (wp: { x: number; y: number }) =>
          constrainPoint(origin, wp, currentAngleMode("measure"));
        const setLive = (wp: { x: number; y: number }) => {
          const s = snapOrtho(wp);
          rulerPendingLive.set({ x1: origin.x, y1: origin.y, x2: s.x, y2: s.y });
        };
        const drawRuler: DragHandler = {
          onDragStart: ({ worldPoint }) => {
            rulerDraftLive.set({ x1: origin.x, y1: origin.y, x2: worldPoint.x, y2: worldPoint.y });
            setLive(worldPoint);
          },
          onDragMove: ({ worldPoint }) => setLive(worldPoint),
          onPointerUp: ({ worldPoint, dragged }) => {
            if (dragged) {
              const snapped = snapOrtho(worldPoint);
              const dx = snapped.x - origin.x;
              const dy = snapped.y - origin.y;
              const lenPx = Math.sqrt(dx * dx + dy * dy);
              // Keep the committed ruler visible in the draft store.
              const committed: RulerDraft = {
                x1: origin.x, y1: origin.y,
                x2: snapped.x, y2: snapped.y
              };
              rulerDraftLive.set(committed);
              rulerPendingLive.set(null);
              // Persist every ruler, even before scale is configured. The
              // overlay derives physical units from the current global scale.
              if (lenPx > 5) {
                const ruler = {
                  id: uuid(),
                  x1: origin.x,
                  y1: origin.y,
                  x2: snapped.x,
                  y2: snapped.y,
                  lengthPx: lenPx,
                  lengthUm: lenPx * (annotations?.umPerPx ?? 0)
                };
                void dispatcher.dispatch({ kind: "upsertRuler", ruler, prevRuler: null });
                setSelectedRulerIds(new Set([ruler.id]));
              }
            } else {
              // Click without drag: keep previous draft.
              rulerPendingLive.set(null);
            }
          },
          onCancel: () => {
            // Cancel: keep the last committed, just clear the pending preview.
            rulerPendingLive.set(null);
          }
        };
        return drawRuler;
      }

      // Click-to-place / draw tools defer to onCanvasClick; pan tool pans.
      if (
        tool === "pan" ||
        tool === "wire" ||
        tool === "multiWire" ||
        tool === "via" ||
        tool === "viaPoly" ||
        tool === "cellGuideLine" ||
        tool === "cellGuideSeg" ||
        tool === "ioPoint" ||
        tool === "comment" ||
        tool === "analogRect" ||
        tool === "analogPoly"
      ) {
        return "pan";
      }

      // Select tool — broad+narrow hit-test, then dispatch click vs marquee.
      const vp = viewportLive.get();
      if (!vp || !annotationLayer) return "pan";

      // Dragging a side of the selected cell resizes its whole cell type:
      // every linked instance changes the same way (see cellResize.ts). Checked before the
      // hit-test since the grab zone straddles the cell outline.
      const edgeGrab = selectedCellSideAt(e.worldPoint, vp.zoom);
      if (edgeGrab) {
        const { cell: rCell, cellType: rType, side } = edgeGrab;
        const ann0 = annotationsRef.current!;
        const horizontal = side === "left" || side === "right";
        const snapTol = 32 / vp.zoom;
        const compute = (wp: Point) => {
          let pos = horizontal ? wp.x : wp.y;
          const guides = ann0.guides;
          if (usePreferences.getState().cellSnapToGuides && guides && guides.length > 0) {
            // Snap only the dragged edge; the others stay where they are.
            const r = cellWorldRect(rCell, rType.cropRect.width, rType.cropRect.height);
            const moved: Rect =
              side === "left"
                ? { ...r, x: pos, width: r.x + r.width - pos }
                : side === "right"
                  ? { ...r, width: pos - r.x }
                  : side === "top"
                    ? { ...r, y: pos, height: r.y + r.height - pos }
                    : { ...r, height: pos - r.y };
            const sn = snapRectToGuides(moved, guides, snapTol);
            pos =
              side === "left" ? sn.x
              : side === "right" ? sn.x + sn.width
              : side === "top" ? sn.y
              : sn.y + sn.height;
          }
          return resizeCellType(ann0, rCell, rType, side as CellSide, pos);
        };
        const instances = ann0.cells.filter((c) => c.cellTypeId === rType.id);
        const restore = () => {
          for (const c of instances) {
            annotationLayer.update(buildCellAnnotation(c, rType, getCellC, getCellShapes, undefined, library.scale));
          }
          editPreviewLive.set(null);
        };
        const handler: DragHandler = {
          onDragMove: ({ worldPoint }) => {
            const res = compute(worldPoint);
            if (!res) {
              restore();
              return;
            }
            for (const { cell: c } of res.cells) {
              annotationLayer.update(buildCellAnnotation(c, res.cellType, getCellC, getCellShapes, undefined, library.scale));
            }
            const dragged = res.cells.find((x) => x.cell.id === rCell.id)!.cell;
            const { width, height } = res.cellType.cropRect;
            editPreviewLive.set({ kind: "cellRect", rect: cellWorldRect(dragged, width, height) });
          },
          onPointerUp: ({ dragged, worldPoint }) => {
            if (!dragged) {
              editPreviewLive.set(null);
              return; // plain click on the edge keeps the selection
            }
            const res = compute(worldPoint);
            if (!res) {
              restore();
              return;
            }
            // Preview stays on the final rect until the optimistic update
            // lands, so the handles don't flash back (see cell move).
            void dispatcher
              .dispatch(cellTypeResizeAction(res))
              .finally(() => editPreviewLive.set(null));
          },
          onCancel: restore
        };
        return handler;
      }

      const tolerance = HIT_TOLERANCE_PX / vp.zoom;
      const hit = annotationLayer.hitTest(
        e.worldPoint,
        tolerance,
        Math.max(tolerance, netNodePickWorldRadius(vp.zoom))
      );

      if (hit) {
        // A mixed cell + wire selection must move as one bundle, regardless
        // of whether the pointer starts on a cell or on a wire segment.
        const selectedNow = useDieViewerStore.getState().selectedIds;
        const mixedCells = (annotationsRef.current?.cells ?? [])
          .filter((candidate) => selectedNow.has(`cell:${candidate.id}`))
          .map((candidate) => ({
            cell: candidate,
            cellType: annotationsRef.current?.cellTypes.find(
              (candidateType) => candidateType.id === candidate.cellTypeId
            )
          }))
          .filter((entry): entry is { cell: Cell; cellType: CellType } => entry.cellType != null);
        const mixedEdges = new Map<string, Set<string>>();
        for (const id of selectedNow) {
          const part = parseNetPartId(id);
          if (!part || part.part === "node") continue;
          const edges = mixedEdges.get(part.netId) ?? new Set<string>();
          if (part.part === "net") edges.add("*");
          else if (part.partId) edges.add(part.partId);
          mixedEdges.set(part.netId, edges);
        }
        const hitNetPart = parseNetPartId(hit.partId);
        const hitSelectedCell = hit.annotation.kind === "cell" &&
          selectedNow.has(hit.partId);
        const hitSelectedWire = hitNetPart != null &&
          mixedEdges.has(hitNetPart.netId) &&
          (hitNetPart.part === "net" ||
            (hitNetPart.partId != null &&
              (mixedEdges.get(hitNetPart.netId)?.has("*") ||
                mixedEdges.get(hitNetPart.netId)?.has(hitNetPart.partId))));
        if (mixedCells.length > 0 && mixedEdges.size > 0 &&
            (hitSelectedCell || hitSelectedWire)) {
          const originalNets = new Map(
            [...mixedEdges.keys()]
              .map((netId) => wire.netsRef.current.find((net) => net.id === netId))
              .filter((net): net is AnnotationNet => net != null)
              .map((net) => [net.id, net] as const)
          );
          const movingNodes = new Map<string, Set<string>>();
          for (const [netId, edgeIds] of mixedEdges) {
            const net = originalNets.get(netId);
            if (!net) continue;
            const nodeIds = new Set<string>();
            for (const edge of net.edges) {
              if (!edgeIds.has("*") && !edgeIds.has(edge.id)) continue;
              nodeIds.add(edge.from);
              nodeIds.add(edge.to);
            }
            movingNodes.set(netId, nodeIds);
          }
          const moveBundle = (
            worldPoint: { x: number; y: number },
            startWorld: { x: number; y: number },
            shift: boolean,
            round: boolean
          ) => {
            let dx = worldPoint.x - startWorld.x;
            let dy = worldPoint.y - startWorld.y;
            if (shift) {
              if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
              else dx = 0;
            }
            const nets = [...originalNets.values()].map((net) => ({
              ...net,
              nodes: net.nodes.map((node) => {
                if (!movingNodes.get(net.id)?.has(node.id)) return node;
                return {
                  ...node,
                  x: round ? Math.round(node.x + dx) : node.x + dx,
                  y: round ? Math.round(node.y + dy) : node.y + dy,
                };
              })
            }));
            const cells = mixedCells.map(({ cell, cellType }) => ({
              cell: {
                ...cell,
                x: round ? Math.round(cell.x + dx) : cell.x + dx,
                y: round ? Math.round(cell.y + dy) : cell.y + dy,
              },
              cellType,
            }));
            return { nets, cells };
          };
          const handler: DragHandler = {
            onDragMove: ({ worldPoint, startWorld, modifiers }) => {
              const moved = moveBundle(worldPoint, startWorld, modifiers.shift, false);
              for (const net of moved.nets) {
                annotationLayer.update(buildNetAnnotation(net, getNetW, getNetC()));
              }
              for (const entry of moved.cells) {
                annotationLayer.update(buildCellAnnotation(entry.cell, entry.cellType, getCellC, getCellShapes, undefined, library.scale));
              }
            },
            onPointerUp: ({ dragged, worldPoint, startWorld, modifiers }) => {
              if (!dragged) {
                selectFromHit(hit, modifiers.shift);
                return;
              }
              const moved = moveBundle(worldPoint, startWorld, modifiers.shift, true);
              const actions: AnnotationAction[] = [];
              for (const net of moved.nets) {
                const prev = originalNets.get(net.id);
                if (prev) actions.push({ kind: "upsertNet", net, prevNet: prev });
              }
              for (const entry of moved.cells) {
                const prev = mixedCells.find(({ cell }) => cell.id === entry.cell.id)?.cell;
                if (prev) actions.push({ kind: "upsertCell", cell: entry.cell, prevCell: prev });
              }
              if (actions.length > 0) {
                void dispatcher.dispatch({ kind: "batch", actions });
              }
            },
            onCancel: () => {
              for (const net of originalNets.values()) {
                annotationLayer.update(buildNetAnnotation(net, getNetW, getNetC()));
              }
              for (const entry of mixedCells) {
                annotationLayer.update(buildCellAnnotation(entry.cell, entry.cellType, getCellC, getCellShapes, undefined, library.scale));
              }
            }
          };
          return handler;
        }

        // Dragging an existing net vertex moves it. The move is shown live by
        // updating just that one net in the index (no full repopulate); the
        // undoable `upsertNet` is dispatched only on pointer-up.
        //
        // Dragging the END of a net (degree-1 vertex) also snaps onto another
        // net: a vertex welds the two nets into one, an edge body splits it and
        // welds — matching the wire tool's drawing snap.
        const node = wire.nodeFromHit(hit);
        if (node && annotationLayer) {
          const original =
            wire.netsRef.current.find((n) => n.id === node.netId) ?? null;
          const isEndpoint = original
            ? original.edges.filter(
                (e) => e.from === node.nodeId || e.to === node.nodeId
              ).length === 1
            : false;
          const resolveSnap = (
            worldPoint: { x: number; y: number }
          ): DragSnap | null => {
            if (!isEndpoint) return null;
            const zoom = viewportLive.get()?.zoom ?? 1;
            const prefs = usePreferences.getState();
            const vertexTol = Math.max(
              HIT_TOLERANCE_PX / zoom,
              netNodePickWorldRadius(zoom)
            );
            const edgeTol = Math.max(HIT_TOLERANCE_PX / zoom, prefs.netWidth / 2);
            return resolveDragSnap(
              wire.netsRef.current,
              node.netId,
              worldPoint,
              vertexTol,
              edgeTol
            );
          };
          const moveNode = (worldPoint: { x: number; y: number }): AnnotationNet | null =>
            original
              ? {
                  ...original,
                  nodes: original.nodes.map((nd) =>
                    nd.id === node.nodeId
                      ? { ...nd, x: worldPoint.x, y: worldPoint.y }
                      : nd
                  )
                }
              : null;
          const handler: DragHandler = {
            onDragStart: () => {
              useDieViewerStore.getState().select([hit.partId], "replace");
            },
            onDragMove: ({ worldPoint }) => {
              const snap = resolveSnap(worldPoint);
              const target = snap
                ? snap.kind === "vertex"
                  ? { x: snap.x, y: snap.y }
                  : snap.at
                : worldPoint;
              const moved = moveNode(target);
              if (moved) {
                annotationLayer.update(buildNetAnnotation(moved, getNetW, getNetC()));
              }
            },
            onPointerUp: ({ dragged, worldPoint, modifiers }) => {
              if (!dragged || !original) {
                selectFromHit(hit, modifiers.shift);
                return;
              }
              const snap = resolveSnap(worldPoint);
              if (snap) {
                const changes =
                  snap.kind === "vertex"
                    ? weldNetAtNode(
                        wire.netsRef.current,
                        node.netId,
                        node.nodeId,
                        snap.netId,
                        snap.nodeId
                      )
                    : weldNetAtEdge(
                        wire.netsRef.current,
                        node.netId,
                        node.nodeId,
                        snap.netId,
                        snap.edgeId,
                        snap.at
                      );
                const action = netChangesToAction(changes);
                if (action) void dispatcher.dispatch(action);
                return;
              }
              const moved = moveNode(worldPoint);
              const action = netChangesToAction([{ prev: original, next: moved }]);
              if (action) void dispatcher.dispatch(action);
            },
            onCancel: () => {
              if (original) {
                annotationLayer.update(
                  buildNetAnnotation(original, getNetW, getNetC())
                );
              }
            }
          };
          return handler;
        }

        // Dragging a selected wire fragment moves all nodes touched by the
        // selected edges. Shared nodes move once, so adjacent unselected
        // edges stretch to the new position instead of disconnecting.
        const edgePart = parseNetPartId(hit.partId);
        if (edgePart?.part === "edge" && edgePart.partId && annotationLayer) {
          const selected = useDieViewerStore.getState().selectedIds;
          const selectedEdgesByNet = new Map<string, Set<string>>();
          for (const id of selected) {
            const part = parseNetPartId(id);
            if (!part) continue;
            const edges = selectedEdgesByNet.get(part.netId) ?? new Set<string>();
            if (part.part === "net") edges.add("*");
            else if (part.part === "edge" && part.partId) edges.add(part.partId);
            else continue;
            selectedEdgesByNet.set(part.netId, edges);
          }
          const movingEdges = selectedEdgesByNet.has(edgePart.netId)
            ? selectedEdgesByNet
            : new Map([[edgePart.netId, new Set([edgePart.partId])]]);
          const originals = new Map(
            [...movingEdges.keys()]
              .map((netId) => wire.netsRef.current.find((net) => net.id === netId))
              .filter((net): net is AnnotationNet => net != null)
              .map((net) => [net.id, net] as const)
          );
          const movingNodesByNet = new Map<string, Set<string>>();
          for (const [netId, edgeIds] of movingEdges) {
            const net = originals.get(netId);
            if (!net) continue;
            const nodeIds = new Set<string>();
            for (const edge of net.edges) {
              if (!edgeIds.has("*") && !edgeIds.has(edge.id)) continue;
              nodeIds.add(edge.from);
              nodeIds.add(edge.to);
            }
            movingNodesByNet.set(netId, nodeIds);
          }
          const moveFragment = (
            worldPoint: { x: number; y: number },
            startWorld: { x: number; y: number },
            shift: boolean,
            round: boolean
          ): AnnotationNet[] => {
            let dx = worldPoint.x - startWorld.x;
            let dy = worldPoint.y - startWorld.y;
            if (shift) {
              if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
              else dx = 0;
            }
            return [...originals.values()].map((net) => ({
              ...net,
              nodes: net.nodes.map((node) => {
                if (!movingNodesByNet.get(net.id)?.has(node.id)) return node;
                return {
                  ...node,
                  x: round ? Math.round(node.x + dx) : node.x + dx,
                  y: round ? Math.round(node.y + dy) : node.y + dy,
                };
              }),
            }));
          };
          const handler: DragHandler = {
            onDragStart: () => {
              if (!selectedEdgesByNet.has(edgePart.netId)) {
                useDieViewerStore.getState().select([hit.partId], "replace");
              }
            },
            onDragMove: ({ worldPoint, startWorld, modifiers }) => {
              for (const moved of moveFragment(worldPoint, startWorld, modifiers.shift, false)) {
                annotationLayer.update(buildNetAnnotation(moved, getNetW, getNetC()));
              }
            },
            onPointerUp: ({ dragged, worldPoint, startWorld, modifiers }) => {
              if (!dragged) {
                selectFromHit(hit, modifiers.shift);
                return;
              }
              const moved = moveFragment(worldPoint, startWorld, modifiers.shift, true);
              const actions: AnnotationAction[] = [];
              for (const next of moved) {
                const prev = originals.get(next.id);
                if (prev) actions.push({ kind: "upsertNet", net: next, prevNet: prev });
              }
              if (actions.length > 0) {
                void dispatcher.dispatch(actions.length === 1 ? actions[0] : { kind: "batch", actions });
              }
            },
            onCancel: () => {
              for (const originalNet of originals.values()) {
                annotationLayer.update(buildNetAnnotation(originalNet, getNetW, getNetC()));
              }
            },
          };
          return handler;
        }

        // Dragging a placed cell repositions it; Alt-dragging drops a copy
        // there instead and leaves the original in place (Alt is read live,
        // as in the guide drag). Grabbing a cell that's part of a multi-cell
        // selection carries every selected cell. Same live-update / commit-
        // on-up scheme as the net-vertex drag above; one undo step.
        const cellHit = cell.cellFromHit(hit);
        if (cellHit) {
          if (usePreferences.getState().cellsLocked) {
            const handler: DragHandler = {
              onPointerUp: ({ modifiers }) => {
                selectFromHit(hit, modifiers.shift);
              }
            };
            return handler;
          }
          const { cell: original, cellType } = cellHit;
          const selectedIdsNow = useDieViewerStore.getState().selectedIds;
          const movingCells = selectedIdsNow.has(hit.partId)
            ? (annotationsRef.current?.cells ?? [])
                .filter((candidate) => selectedIdsNow.has(`cell:${candidate.id}`))
                .map((candidate) => ({
                  cell: candidate,
                  cellType: annotationsRef.current?.cellTypes.find(
                    (candidateType) => candidateType.id === candidate.cellTypeId
                  )
                }))
                .filter((entry): entry is { cell: typeof original; cellType: typeof cellType } =>
                  entry.cellType != null
                )
            : [{ cell: original, cellType }];
          // Copies get their ids up front so the live preview and the commit
          // agree (the layer is rebuilt from the annotations after either).
          const copyIds = movingCells.map(() => uuid());
          // Shift locks the move to the dominant axis (re-evaluated live, so
          // tapping Shift mid-drag snaps it straight without restarting). The
          // committed offset is rounded — not the position — so an origin on a
          // half pixel (a type turned a quarter turn) keeps its footprint on
          // whole pixels.
          const offset = (
            worldPoint: { x: number; y: number },
            startWorld: { x: number; y: number },
            shift: boolean,
            round: boolean
          ) => {
            let dx = worldPoint.x - startWorld.x;
            let dy = worldPoint.y - startWorld.y;
            if (shift) {
              if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
              else dx = 0;
            }
            return round ? { dx: Math.round(dx), dy: Math.round(dy) } : { dx, dy };
          };
          const draw = (c: typeof original, ct: typeof cellType) =>
            buildCellAnnotation(c, ct, getCellC, getCellShapes, undefined, library.scale);
          // A lone moving cell carries its resize handles along (multi-cell
          // moves show none); they follow the copy when Alt is held.
          const previewHandles = (c: typeof original) => {
            if (movingCells.length !== 1) return;
            const { width, height } = movingCells[0].cellType.cropRect;
            editPreviewLive.set({ kind: "cellRect", rect: cellWorldRect(c, width, height) });
          };
          /** Put the layer back: originals where they were, no copies. */
          const restore = () => {
            movingCells.forEach(({ cell: c, cellType: ct }, i) => {
              annotationLayer.update(draw(c, ct));
              annotationLayer.remove(`cell:${copyIds[i]}`);
            });
            editPreviewLive.set(null);
          };
          const handler: DragHandler = {
            onDragStart: () => {
              if (movingCells.length === 1) {
                useDieViewerStore.getState().select([hit.partId], "replace");
              }
            },
            onDragMove: ({ worldPoint, startWorld, modifiers }) => {
              const { dx, dy } = offset(worldPoint, startWorld, modifiers.shift, false);
              movingCells.forEach(({ cell: c, cellType: ct }, i) => {
                const moved = { ...c, x: c.x + dx, y: c.y + dy };
                if (modifiers.alt) {
                  annotationLayer.update(draw(c, ct));
                  annotationLayer.add(draw({ ...moved, id: copyIds[i] }, ct));
                  previewHandles({ ...moved, id: copyIds[i] });
                } else {
                  annotationLayer.remove(`cell:${copyIds[i]}`);
                  annotationLayer.update(draw(moved, ct));
                  previewHandles(moved);
                }
              });
            },
            onPointerUp: ({ dragged, worldPoint, startWorld, modifiers }) => {
              if (!dragged) {
                selectFromHit(hit, modifiers.shift);
                return;
              }
              const { dx, dy } = offset(worldPoint, startWorld, modifiers.shift, true);
              if (dx === 0 && dy === 0) {
                // Nothing moved (or a copy would sit exactly on its original).
                restore();
                return;
              }
              const actions: AnnotationAction[] = movingCells.map(({ cell: c }, i) =>
                modifiers.alt
                  ? {
                      kind: "upsertCell",
                      cell: { ...c, id: copyIds[i], x: c.x + dx, y: c.y + dy },
                      prevCell: null
                    }
                  : {
                      kind: "upsertCell",
                      cell: { ...c, x: c.x + dx, y: c.y + dy },
                      prevCell: c
                    }
              );
              if (modifiers.alt) {
                useDieViewerStore
                  .getState()
                  .select(
                    copyIds.map((id) => `cell:${id}`),
                    "replace"
                  );
              }
              // Keep the handles on the final spot until the optimistic
              // update lands (dispatch applies it a tick later), else they'd
              // flash back to the old position.
              const last = movingCells[movingCells.length - 1].cell;
              previewHandles(
                modifiers.alt
                  ? { ...last, id: copyIds[copyIds.length - 1], x: last.x + dx, y: last.y + dy }
                  : { ...last, x: last.x + dx, y: last.y + dy }
              );
              void dispatcher
                .dispatch(actions.length === 1 ? actions[0] : { kind: "batch", actions })
                .finally(() => editPreviewLive.set(null));
            },
            onCancel: restore
          };
          return handler;
        }

        // Dragging an I/O pin repositions it — same live-update / commit-on-
        // up scheme as the cell drag above.
        if (hit.partId.startsWith("pin:")) {
          const pinId = hit.partId.slice(4);
          const original = annotationsRef.current?.pins?.find((p) => p.id === pinId) ?? null;
          if (original) {
            // Shift locks the move to the dominant axis (re-evaluated live, so
            // tapping Shift mid-drag snaps it straight without restarting).
            const movePin = (
              worldPoint: { x: number; y: number },
              startWorld: { x: number; y: number },
              shift: boolean,
              round: boolean
            ) => {
              let dx = worldPoint.x - startWorld.x;
              let dy = worldPoint.y - startWorld.y;
              if (shift) {
                if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
                else dx = 0;
              }
              const x = round ? Math.round(original.x + dx) : original.x + dx;
              const y = round ? Math.round(original.y + dy) : original.y + dy;
              return { ...original, x, y };
            };
            const handler: DragHandler = {
              onDragStart: () => {
                useDieViewerStore.getState().select([hit.partId], "replace");
              },
              onDragMove: ({ worldPoint, startWorld, modifiers }) => {
                annotationLayer.update(
                  buildPin(
                    movePin(worldPoint, startWorld, modifiers.shift, false),
                    getPinNamesVisible,
                    getPinSize
                  )
                );
              },
              onPointerUp: ({ dragged, worldPoint, startWorld, modifiers }) => {
                if (!dragged) {
                  selectFromHit(hit, modifiers.shift);
                  // Second click on the same pin within 300ms → rename prompt.
                  const last = lastPinClickRef.current;
                  const now = Date.now();
                  if (last && last.pinId === pinId && now - last.time < 300) {
                    lastPinClickRef.current = null;
                    void (async () => {
                      const input = await dialog.prompt(
                        `Rename pin ${original.pin}${(() => {
                          const n = padCountByPin(annotationsRef.current?.pins).get(original.pin) ?? 1;
                          return n > 1 ? ` (all ${n} pads)` : "";
                        })()}:`,
                        original.name,
                        "I/O pin"
                      );
                      if (input === null) return;
                      const name = input.trim();
                      const current =
                        annotationsRef.current?.pins?.find((p) => p.id === pinId) ?? original;
                      if (!name || name === current.name) return;
                      // Every pad of this pin number (pasted copies) follows.
                      const actions = renamePinActions(annotationsRef.current?.pins, current.pin, name);
                      if (actions.length > 0) void dispatcher.dispatch({ kind: "batch", actions });
                    })();
                  } else {
                    lastPinClickRef.current = { pinId, time: now };
                  }
                  return;
                }
                lastPinClickRef.current = null;
                void dispatcher.dispatch({
                  kind: "upsertPin",
                  pin: movePin(worldPoint, startWorld, modifiers.shift, true),
                  prevPin: original
                });
              },
              onCancel: () => {
                annotationLayer.update(buildPin(original, getPinNamesVisible, getPinSize));
              }
            };
            return handler;
          }
        }

        // Editable ML shapes (via rectangle / polygon, ROI, ignore): grab a
        // corner/vertex to reshape or the body to move; live-preview, commit
        // one undoable upsert on release.
        const ann = annotationsRef.current;
        const ed = ann ? resolveEditable(hit.partId, ann) : null;
        if (ed) {
          return shapeDragHandler({
            ed,
            worldDown: e.worldPoint,
            tolWorld: HIT_TOLERANCE_PX / vp.zoom,
            layer: annotationLayer,
            dispatch: (a) => void dispatcher.dispatch(a),
            selectPart: () =>
              useDieViewerStore.getState().select([hit.partId], "replace"),
            selectOnClick: (shift) => selectFromHit(hit, shift),
            onPreview: (p) => editPreviewLive.set(p)
          });
        }

        // Click on a non-vertex hit → select on up (a drag is a no-op for now).
        return {
          onPointerUp: ({ dragged, modifiers }) => {
            if (!dragged) selectFromHit(hit, modifiers.shift);
          }
        };
      }

      // No annotation hit → maybe an ML cell proposal (dashed pink box).
      // Click selects it; the inspector then offers approve / dismiss.
      if (proposalLayer) {
        const pHit = proposalLayer.hitTest(e.worldPoint, tolerance);
        if (pHit) {
          return {
            onPointerUp: ({ dragged, modifiers }) => {
              if (dragged) return;
              useDieViewerStore
                .getState()
                .select([pHit.partId], modifiers.shift ? "toggle" : "replace");
            }
          };
        }
      }

      // No annotation hit → maybe an ML via. The hit-area matches the visible
      // via dot (same tolerance as the snap-to-vias path) so clicking on a
      // via reliably selects it.
      if (mlViasLayer) {
        const viaTol = viaSnapTolerance(
          vp.zoom,
          usePreferences.getState().viaSize
        );
        const mlHit = mlViasLayer.hitTestVia(e.worldPoint, viaTol);
        if (mlHit) {
          return {
            onPointerUp: ({ dragged, modifiers }) => {
              if (dragged) return;
              useDieViewerStore
                .getState()
                .select([mlHit.id], modifiers.shift ? "toggle" : "replace");
            }
          };
        }
      }

      // No rbush hit: maybe cell-grid guides (unless locked). Grab a guide
      // directly, OR start the drag *between* already-selected guides to grab
      // the whole group. Drag moves; Alt-drag duplicates (one batched undo).
      if (!usePreferences.getState().guidesLocked) {
        const guides = annotationsRef.current?.guides ?? [];
        const sel = useDieViewerStore.getState().selectedIds;
        const selectedGuides = guides.filter((x) =>
          sel.has(`guide:${x.id}`)
        );
        const hitG = guideHitTest(guides, e.worldPoint, tolerance);

        let targets: typeof guides | null = null;
        let clickSelectId: string | null = null;
        if (hitG) {
          if (sel.has(`guide:${hitG.id}`) && selectedGuides.length > 0) {
            targets = selectedGuides; // grab the existing group
          } else {
            targets = [hitG];
            clickSelectId = `guide:${hitG.id}`;
          }
        } else if (
          selectedGuides.length > 0 &&
          pointInGuidesRegion(selectedGuides, e.worldPoint, tolerance)
        ) {
          targets = selectedGuides; // grabbed between the selected guides
        }

        if (targets) {
          const set = targets;
          const start = { x: e.worldPoint.x, y: e.worldPoint.y };
          // Shift constrains the move to the dominant axis (re-evaluated live).
          const delta = (wp: { x: number; y: number }, shift: boolean) => {
            let dx = wp.x - start.x;
            let dy = wp.y - start.y;
            if (shift) {
              if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
              else dx = 0;
            }
            return { dx, dy };
          };
          const handler: DragHandler = {
            onDragStart: () => {
              if (clickSelectId && !sel.has(clickSelectId)) {
                useDieViewerStore.getState().select([clickSelectId], "replace");
              }
            },
            onDragMove: ({ worldPoint, modifiers }) => {
              const { dx, dy } = delta(worldPoint, modifiers.shift);
              guideDragLive.set({
                previews: set.map((t) => translateGuide(t, dx, dy)),
                hideIds: modifiers.alt ? [] : set.map((t) => t.id)
              });
            },
            onPointerUp: ({ dragged, worldPoint, modifiers }) => {
              guideDragLive.set(null);
              if (!dragged) {
                // Plain click: select the grabbed guide; a click between
                // guides keeps the current selection.
                if (clickSelectId) {
                  useDieViewerStore
                    .getState()
                    .select(
                      [clickSelectId],
                      modifiers.shift ? "toggle" : "replace"
                    );
                }
                return;
              }
              const { dx, dy } = delta(worldPoint, modifiers.shift);
              if (modifiers.alt) {
                const copies = set.map((t) => ({
                  ...translateGuide(t, dx, dy),
                  id: uuid()
                }));
                const actions: AnnotationAction[] = copies.map((guide) => ({
                  kind: "upsertGuide",
                  guide,
                  prevGuide: null
                }));
                void dispatcher.dispatch(
                  actions.length === 1 ? actions[0] : { kind: "batch", actions }
                );
                useDieViewerStore
                  .getState()
                  .select(
                    copies.map((c) => `guide:${c.id}`),
                    "replace"
                  );
              } else {
                const actions: AnnotationAction[] = set.map((t) => ({
                  kind: "upsertGuide",
                  guide: translateGuide(t, dx, dy),
                  prevGuide: t
                }));
                void dispatcher.dispatch(
                  actions.length === 1 ? actions[0] : { kind: "batch", actions }
                );
              }
            },
            onCancel: () => guideDragLive.set(null)
          };
          return handler;
        }
      }

      // Click on empty → marquee. The start corner is anchored in WORLD
      // space and re-projected each move, so scrolling / zooming / edge
      // auto-pan mid-drag stretches the rectangle instead of sliding it.
      const startWorld = { x: e.worldPoint.x, y: e.worldPoint.y };
      const startOnScreen = () => {
        const vp = viewportLive.get();
        return vp
          ? { x: (startWorld.x - vp.originX) * vp.zoom, y: (startWorld.y - vp.originY) * vp.zoom }
          : e.screenPoint;
      };
      const handler: DragHandler = {
        autoPan: true,
        onDragStart: ({ screenPoint }) => {
          marqueeLive.set(rectFromPoints(startOnScreen(), screenPoint));
        },
        onDragMove: ({ screenPoint }) => {
          marqueeLive.set(rectFromPoints(startOnScreen(), screenPoint));
        },
        onPointerUp: ({ dragged, worldPoint, modifiers }) => {
          marqueeLive.set(null);
          if (!dragged) {
            clearSelectionFromEmpty(modifiers.shift);
            return;
          }
          const world = rectFromPoints(startWorld, worldPoint);
          const fullyContained = worldPoint.x >= startWorld.x;
          const ids = annotationLayer.queryRectParts(world, fullyContained);
          if (!usePreferences.getState().guidesLocked) {
            for (const g of guidesInRect(
              annotationsRef.current?.guides ?? [],
              world,
              fullyContained
            )) {
              ids.push(`guide:${g.id}`);
            }
          }
          // Visible floorplan regions (outline-based, see regionInMarquee).
          const fpPrefs = usePreferences.getState();
          if (fpPrefs.floorplanOverlayOn) {
            const fpHidden = fpPrefs.hiddenKinds.includes("floorplan");
            for (const r of useFloorplanStore.getState().regions) {
              if (!isFloorplanVisible(r, fpHidden, fpPrefs.hiddenFloorplanTypeNames)) continue;
              if (regionInMarquee(r, world, fullyContained)) ids.push(`floorplan:${r.id}`);
            }
          }
          // ML vias swept by the marquee — only those currently rendered
          // (i.e. above the confidence threshold). Synthetic position IDs.
          if (mlViasLayer) {
            for (const v of mlViasLayer.queryViasInRect(world)) {
              ids.push(v.id);
            }
          }
          if (proposalLayer) {
            for (const a of proposalLayer.queryRect(world)) ids.push(a.id);
          }
          selectFromMarquee(ids, modifiers.shift);
        },
        onCancel: () => marqueeLive.set(null)
      };
      return handler;
    },
    [
      annotationLayer,
      mlViasLayer,
      proposalLayer,
      marqueeLive,
      selectFromHit,
      selectedCellSideAt,
      dialog,
      selectFromMarquee,
      clearSelectionFromEmpty,
      viewportLive,
      wire,
      cell,
      cellRectLive,
      shapeRectLive,
      editPreviewLive,
      guideDragLive,
      commitDrawnRect,
      dispatcher,
      getNetW,
      getNetC,
      getCellC,
      getCellShapes,
      getPinNamesVisible,
      libraryCell.pointerDown,
      analogCell.pointerDown
    ]
  );

  // Canvas click (pan mode, no drag) → resolve the active tool into an action.
  const onCanvasClick = useCallback(
    ({ x, y }: { x: number; y: number }) => {
      const tool = useDieViewerStore.getState().activeTool;
      if (tool === "libraryCell") {
        libraryCell.moveTo({ x, y });
        return;
      }
      if (tool === "analogCell") {
        analogCell.moveTo({ x, y });
        return;
      }
      if (tool === "wire") {
        wire.addWirePoint({ x, y }, shiftRef.current);
        return;
      }
      if (tool === "via") {
        // A placed via point is a `point_via` HumanAnnotation (schema v2).
        const viaId = useDieViewerStore.getState().activeViaId;
        void dispatcher.dispatch({
          kind: "upsertAnnotation",
          annotation: {
            id: uuid(),
            class: "point_via",
            geometry: { kind: "point", x: Math.round(x), y: Math.round(y) },
            source: "human",
            ...(viaId ? { layer: viaId } : {}),
          },
          prevAnnotation: null
        });
        return;
      }
      if (tool === "comment") {
        setPendingNewComment({ x: Math.round(x), y: Math.round(y) });
        return;
      }
      if (tool === "floorplan") {
        // Poly mode: click to add vertex (rect mode uses drag, handled in onCanvasPointerDown)
        const fs = useFloorplanStore.getState();
        if (fs.toolMode === "poly") {
          const draft = fs.draft;
          if (draft && draft.active) {
            const p = constrainPolyPoint("floorplan", { x, y }, shiftRef.current);
            draft.points.push({ x: Math.round(p.x), y: Math.round(p.y) });
            useFloorplanStore.getState().setDraft({ ...draft });
          } else {
            useFloorplanStore.getState().setDraft({
              kind: "poly",
              points: [{ x: Math.round(x), y: Math.round(y) }],
              active: true,
            });
          }
        }
        // Rect mode is drag-based — nothing to do on click
        return;
      }
      if (tool === "viaPoly") {
        viaPoly.addPoint(constrainPolyPoint("viaPoly", { x, y }, shiftRef.current));
        return;
      }
      if (tool === "multiWire") {
        if (multiWire.phase === 1) {
          // Snap start points to existing net vertices first (so the bus line
          // *merges into* that net via the anchor), then fall back to a nearby
          // via. Vertex wins over via — even one drawn on top of the vertex —
          // to keep the connect-to-existing-net behaviour intact.
          const vp = viewportLive.get();
          let p = { x, y };
          let anchor: { netId: string; nodeId: string } | null = null;
          if (vp) {
            const via = usePreferences.getState().snapToVias
              ? findNearestVia(
                  { x, y },
                  viaSnapTolerance(vp.zoom, usePreferences.getState().viaSize)
                )
              : null;
            const node = wire.snapVertex({ x, y }, vp.zoom, via);
            if (node) {
              p = { x: node.x, y: node.y };
              anchor = { netId: node.netId, nodeId: node.nodeId };
            } else if (via) {
              p = { x: Math.round(via.x), y: Math.round(via.y) };
            }
          }
          multiWire.addPoint(p, anchor);
        } else {
          // Phase 2: auto-end-on-via wins when any wire's projection crosses
          // a via — all such wires lock in one click (they may target
          // different vias). Then the snap-to-vias-near-cursor path (ends
          // that one wire); otherwise the click places one wire's corner.
          const autos = findMultiWireAutoEndSnaps({ x, y }, shiftRef.current);
          if (autos.length > 0) {
            multiWire.endWires(autos);
          } else {
            const snap = findMultiWireEndpointViaSnap(
              { x, y },
              shiftRef.current
            );
            if (snap) {
              multiWire.endWire(snap.endpoint, snap.lockIndex);
            } else {
              // Plain click: staggered turn — places the corner of the wire
              // nearest the click; after one click per wire the bus keeps
              // routing from the corners. Clicks within a few screen px of
              // the previous one (a double-click's 2nd click) are ignored.
              const zoom = viewportLive.get()?.zoom ?? 1;
              multiWire.placeCorner({ x, y }, shiftRef.current, MULTI_WIRE_MIN_TURN_PX / zoom);
            }
          }
        }
        return;
      }
      if (tool === "cellGuideLine") {
        guide.placeLine({ x, y });
        return;
      }
      if (tool === "cellGuideSeg") {
        guide.addSegPoint({ x, y });
        return;
      }
      if (tool === "ioPoint") {
        const pins = annotations?.pins ?? [];
        const nextNum = pins.reduce((m, p) => Math.max(m, p.pin), 0) + 1;
        void dispatcher.dispatch({
          kind: "addPin",
          pin: {
            id: uuid(),
            x: Math.round(x),
            y: Math.round(y),
            pin: nextNum,
            name: `pin_${nextNum}`
          }
        });
        return;
      }
    },
    [
      dispatcher,
      wire,
      viaPoly,
      multiWire,
      guide,
      annotations,
      annotationLayer,
      viewportLive,
      findNearestVia,
      findMultiWireEndpointViaSnap,
      findMultiWireAutoEndSnaps,
      libraryCell.moveTo
    ]
  );

  /**
   * Right-click on the canvas opens the context menu. Resolves the click to
   * the best-matching "thing here" — net vertex > manual via > ML via > empty
   * space — so the "Start wire from here" entry anchors at that thing's
   * centre (and extends the net when it's a vertex). The selection-driven
   * "Start multi-wire" item is independent: it walks the current selection
   * for via/vertex points, regardless of what was clicked.
   */
  const onCanvasContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      const c = containerRef.current?.querySelector("canvas") as
        | HTMLCanvasElement
        | null;
      const vp = canvasHandle.current?.getViewport();
      if (!c || !vp) return;
      const rect = c.getBoundingClientRect();
      const world: Point = {
        x: vp.originX + (event.clientX - rect.left) / vp.zoom,
        y: vp.originY + (event.clientY - rect.top) / vp.zoom
      };

      // Resolve what's under the cursor for the "from here" entry. Annotation
      // hits win over ML vias (the manual layer paints on top), and net
      // vertices win over via annotations (most specific anchor).
      let hitPoint: Point = world;
      let hitAnchor: DrawAnchor | null = null;
      let hitLabel = "from this point";
      let hitCellId: string | undefined;
      let hitPartId: string | undefined;
      let canSplitNetAtNode = false;
      let hitRulerId: string | undefined;
      const rulerHitPrefs = usePreferences.getState();
      const rulerHit = (annotationsRef.current?.rulers ?? []).find((ruler) =>
        (rulerHitPrefs.rulerVisibilityOverrides[ruler.id] ?? !rulerHitPrefs.rulersHidden) &&
        distancePointToSegment(world, { x: ruler.x1, y: ruler.y1 }, { x: ruler.x2, y: ruler.y2 }) <= HIT_TOLERANCE_PX / vp.zoom
      );
      if (rulerHit) {
        hitRulerId = rulerHit.id;
        setSelectedRulerIds(new Set([rulerHit.id]));
      }
      const tol = HIT_TOLERANCE_PX / vp.zoom;
      const hit = annotationLayer?.hitTest(world, tol, Math.max(tol, netNodePickWorldRadius(vp.zoom))) ?? null;
      if (hit) {
        hitPartId = hit.partId;
        if (hit.annotation.kind === "cell" && hit.annotation.id.startsWith("cell:")) {
          hitCellId = hit.annotation.id.slice(5);
        }
        const node = wire.nodeFromHit(hit);
        if (node) {
          hitPoint = { x: node.x, y: node.y };
          hitAnchor = { netId: node.netId, nodeId: node.nodeId };
          hitLabel = "from net vertex";
          const hitNet = annotationsRef.current?.nets.find((net) => net.id === node.netId);
          canSplitNetAtNode = hitNet?.edges.filter((edge) => edge.from === node.nodeId || edge.to === node.nodeId).length === 2;
        } else if (
          hit.annotation.kind === "via" &&
          hit.annotation.id.startsWith("anno:")
        ) {
          // Manual via — strip the "anno:" prefix added by the annotation
          // factory, then look up the geometry to get the centroid.
          const annoId = hit.annotation.id.slice(5);
          const a = annotationsRef.current?.annotations?.find(
            (x) => x.id === annoId
          );
          const g = a?.geometry;
          if (g) {
            if (g.kind === "point") hitPoint = { x: g.x, y: g.y };
            else if (g.kind === "rectangle") {
              hitPoint = {
                x: g.x + g.width / 2,
                y: g.y + g.height / 2
              };
            } else if (g.kind === "polygon" && g.points.length > 0) {
              let sx = 0;
              let sy = 0;
              for (const p of g.points) {
                sx += p.x;
                sy += p.y;
              }
              hitPoint = {
                x: sx / g.points.length,
                y: sy / g.points.length
              };
            }
            hitLabel = "from via";
          }
        }
      } else if (mlViasLayer) {
        const viaTol = viaSnapTolerance(
          vp.zoom,
          usePreferences.getState().viaSize
        );
        const mlHit = mlViasLayer.hitTestVia(world, viaTol);
        if (mlHit) {
          hitPoint = { x: mlHit.x, y: mlHit.y };
          hitLabel = "from ML via";
        }
      }

      const picks = extractAnchorPointsFromSelection(
        useDieViewerStore.getState().selectedIds
      );
      setContextMenu({
        screenX: event.clientX,
        screenY: event.clientY,
        hitPoint,
        hitAnchor,
        hitLabel,
        multiPointCount: picks.length,
        hitCellId,
        hitPartId,
        canSplitNetAtNode,
        hitRulerId
      });
    },
    [annotationLayer, mlViasLayer, wire, extractAnchorPointsFromSelection]
  );

  /**
   * Double-click on the canvas. In the wire tool this commits the in-flight
   * draft (dropping the spurious dbl-click second point). In the select tool
   * it's a shortcut for "start wiring from this via" — only fires when the
   * dbl-click lands on a via (manual or ML), so net dbl-clicks keep their
   * own meaning (rename the net — see `renameNet` / useCanvasSelection).
   */
  const onCanvasDoubleClick = useCallback(
    async (event: React.MouseEvent<HTMLDivElement>) => {
      const tool = useDieViewerStore.getState().activeTool;
      if (tool === "wire") {
        wire.commitWire({ dropLast: true });
        return;
      }
      // Bus: double-click finishes it (its 1st click placed the last turn).
      if (tool === "multiWire" && multiWire.phase === 2) {
        multiWire.finish();
        return;
      }
      // Floorplan poly: double-click (or Enter) finishes the polygon.
      if (tool === "floorplan") {
        finishFloorplanPolyRef.current();
        return;
      }
      // Measure tool double-click → prompt for known size to set scale.
      if (tool === "measure") {
        // Read the committed ruler from the LiveValue (the visible yellow line).
        const draft = rulerDraftLive.get();
        if (draft) {
          const dx = draft.x2 - draft.x1;
          const dy = draft.y2 - draft.y1;
          const lenPx = Math.sqrt(dx * dx + dy * dy);
          const cachedUm =
            annotationsRef.current?.rulers?.find(
              (r) =>
                Math.abs(r.x1 - draft.x1) < 0.5 &&
                Math.abs(r.y1 - draft.y1) < 0.5
            )?.lengthUm ?? 0;
          const input = await dialog.prompt(
            `Ruler: ${Math.round(lenPx).toLocaleString()} px\nEnter known size in µm:`,
            cachedUm > 0 ? cachedUm.toFixed(2) : ""
          );
          if (input !== null) {
            const um = parseFloat(input);
            if (!isNaN(um) && um > 0) {
              const umPerPx = um / lenPx;
              void dispatcher.dispatch({
                kind: "setUmPerPx",
                umPerPx,
                prevUmPerPx: annotationsRef.current?.umPerPx ?? null
              });
            }
          }
        } else {
          await dialog.confirm("Draw a ruler first (drag to draw a yellow line), then double-click to set scale.");
        }
        return;
      }

      if (tool !== "select") return;
      const c = containerRef.current?.querySelector("canvas") as
        | HTMLCanvasElement
        | null;
      const vp = canvasHandle.current?.getViewport();
      if (!c || !vp) return;
      const rect = c.getBoundingClientRect();
      const world: Point = {
        x: vp.originX + (event.clientX - rect.left) / vp.zoom,
        y: vp.originY + (event.clientY - rect.top) / vp.zoom
      };
      // Manual via first (annotation layer paints on top + has the tighter
      // pickable region), then ML via as the fallback.
      const tol = HIT_TOLERANCE_PX / vp.zoom;
      const hit = annotationLayer?.hitTest(world, tol, Math.max(tol, netNodePickWorldRadius(vp.zoom))) ?? null;
      // Plain double-click on a placed via → its color window;
      // Ctrl/Cmd+double-click → start a wire from it.
      if (hit && hit.annotation.kind === "via" && !(event.ctrlKey || event.metaKey)) {
        openViaColor(hit.annotation.id, world);
        return;
      }
      if (hit && hit.annotation.kind === "via") {
        const annoId = hit.annotation.id.startsWith("anno:")
          ? hit.annotation.id.slice(5)
          : hit.annotation.id;
        const a = annotationsRef.current?.annotations?.find(
          (x) => x.id === annoId
        );
        const g = a?.geometry;
        let p: Point | null = null;
        if (g?.kind === "point") p = { x: g.x, y: g.y };
        else if (g?.kind === "rectangle") {
          p = { x: g.x + g.width / 2, y: g.y + g.height / 2 };
        } else if (g?.kind === "polygon" && g.points.length > 0) {
          let sx = 0;
          let sy = 0;
          for (const q of g.points) {
            sx += q.x;
            sy += q.y;
          }
          p = { x: sx / g.points.length, y: sy / g.points.length };
        }
        if (p) startWireAt(p, null);
        return;
      }
      if (mlViasLayer) {
        const viaTol = viaSnapTolerance(
          vp.zoom,
          usePreferences.getState().viaSize
        );
        const mlHit = mlViasLayer.hitTestVia(world, viaTol);
        if (mlHit) startWireAt({ x: mlHit.x, y: mlHit.y }, null);
      }

      // Double-click on ANY cell annotation → change its cell type;
      // Ctrl/Cmd+double-click → open in RE Cell.
      // Checks: analog device first, then annotation layer for cells.
      let cellId: string | null = null;
      let cellTypeId: string | null = null;
      const devDbl = hitTestAnalogDevice(world, analogDevicesRef.current);
      const anns = annotationsRef.current;
      if (devDbl && anns) {
        const cid = (devDbl as any)._cellId;
        if (cid) {
          const cell = (anns as any).cells?.find((c: any) => c.id === cid);
          if (cell) {
            cellId = cid;
            cellTypeId = cell.cellTypeId;
          }
        }
      }
      if (!cellId && anns) {
        // Check annotation layer for cell hits (covers manually drawn cells)
        const cellHit = annotationLayer?.hitTest(world, tol, Math.max(tol, netNodePickWorldRadius(vp.zoom))) ?? null;
        if (cellHit && cellHit.annotation.id.startsWith("cell:")) {
          const cid = cellHit.annotation.id.slice(5);
          const cell = (anns as any).cells?.find((c: any) => c.id === cid);
          if (cell) {
            cellId = cid;
            cellTypeId = cell.cellTypeId;
          }
        }
      }
      if (cellId && cellTypeId && !(event.ctrlKey || event.metaKey)) {
        setCellTypePicker({ cellId, at: { x: world.x, y: world.y } });
      } else if (cellId && cellTypeId) {
        navigate(`/re?die=${encodeURIComponent(dieId)}&type=${encodeURIComponent(cellTypeId)}&cell=${encodeURIComponent(cellId)}`);
      }
    },
    [annotationLayer, mlViasLayer, wire, multiWire, startWireAt, navigate, dieId, dialog, openViaColor]
  );

  // Zoom button handlers read the latest viewport from the live store at
  // click time, so they never need to re-bind during interaction.
  const setZoomCentered = useCallback(
    (newZoom: number) => {
      if (!die || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const vp = viewportLive.get();
      if (!vp) return;
      const worldCx = vp.originX + rect.width / 2 / vp.zoom;
      const worldCy = vp.originY + rect.height / 2 / vp.zoom;
      canvasHandle.current?.setViewport({
        originX: worldCx - rect.width / 2 / newZoom,
        originY: worldCy - rect.height / 2 / newZoom,
        zoom: newZoom
      });
    },
    [die, viewportLive]
  );

  const zoomIn = useCallback(() => {
    const vp = viewportLive.get();
    if (vp) setZoomCentered(vp.zoom * 1.5);
  }, [viewportLive, setZoomCentered]);

  const zoomOut = useCallback(() => {
    const vp = viewportLive.get();
    if (vp) setZoomCentered(vp.zoom / 1.5);
  }, [viewportLive, setZoomCentered]);

  const fitToScreen = useCallback(() => {
    if (!die || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const v = fitViewport(die.width, die.height, rect.width, rect.height, 24);
    canvasHandle.current?.setViewport(v);
  }, [die]);

  // Wire hotkey refs after the callbacks are defined.
  zoomInRef.current = zoomIn;
  zoomOutRef.current = zoomOut;
  fitToScreenRef.current = fitToScreen;

  const oneToOne = useCallback(() => setZoomCentered(1), [setZoomCentered]);

  // Double-clicking an Items-panel row frames that entity (or the union of a
  // group/category's entities) in the viewport, with a margin.
  const focusOnIds = useCallback(
    (ids: string[], opts?: { tight?: boolean }) => {
      if (!annotationLayer || !containerRef.current) return;
      const list = [...ids];
      let box = annotationLayer.unionBBox(list);
      // Rulers aren't indexed in the annotation layer (they render via their
      // own overlay), so frame them from their endpoints here.
      const rulerIds = list.filter((id) => id.startsWith("ruler:"));
      if (rulerIds.length) {
        const rulers = annotationsRef.current?.rulers ?? [];
        for (const rid of rulerIds) {
          const r = rulers.find((x) => x.id === rid.slice("ruler:".length));
          if (!r) continue;
          const rx = Math.min(r.x1, r.x2);
          const ry = Math.min(r.y1, r.y2);
          const rw = Math.abs(r.x2 - r.x1);
          const rh = Math.abs(r.y2 - r.y1);
          box = box
            ? {
                x: Math.min(box.x, rx),
                y: Math.min(box.y, ry),
                width: Math.max(box.x + box.width, rx + rw) - Math.min(box.x, rx),
                height: Math.max(box.y + box.height, ry + rh) - Math.min(box.y, ry)
              }
            : { x: rx, y: ry, width: rw, height: rh };
        }
      }
      if (!box) return;
      const rect = containerRef.current.getBoundingClientRect();
      // `tight`: bbox fills the viewport edge-to-edge (uniform zoom, so the
      // limiting axis touches and the other is centered).
      const newVp = fitRectViewport(box, rect.width, rect.height, opts?.tight ? 0 : 56, 32);
      if (canvasHandle.current) {
        canvasHandle.current.setViewport(newVp);
      } else {
        // Canvas not mounted yet — retry after a short delay
        setTimeout(() => {
          if (canvasHandle.current) {
            canvasHandle.current.setViewport(newVp);
          }
        }, 200);
      }
    },
    [annotationLayer]
  );

  // ── Press & hold on a net (select tool) ─────────────────────────
  // Same gesture as long-pressing a net's eye in the outline: holding still
  // for NET_HOLD_MS selects the whole net and zoom-fits it edge-to-edge. A
  // progress ring at the cursor shows from NET_HOLD_RING_DELAY_MS. Moving
  // first (a drag) or releasing early keeps the normal click / drag.
  const netHoldLive = useMemo(
    () => createLiveValue<{ x: number; y: number; key: number } | null>(null),
    []
  );
  const onCanvasPointerDown = useCallback(
    (e: PointerEventData): Interaction => {
      const result = routeCanvasPointerDown(e);
      if (typeof result !== "object" || e.button !== 0 || !annotationLayer) return result;
      if (useDieViewerStore.getState().activeTool !== "select") return result;
      const vp = viewportLive.get();
      if (!vp) return result;
      const tol = HIT_TOLERANCE_PX / vp.zoom;
      const hit = annotationLayer.hitTest(e.worldPoint, tol, Math.max(tol, netNodePickWorldRadius(vp.zoom)));
      if (!hit || hit.annotation.kind !== "net") return result;

      const netAnnotationId = hit.annotation.id;
      let fired = false;
      const ringTimer = window.setTimeout(
        () => netHoldLive.set({ ...e.screenPoint, key: performance.now() }),
        NET_HOLD_RING_DELAY_MS
      );
      const holdTimer = window.setTimeout(() => {
        fired = true;
        netHoldLive.set(null);
        useDieViewerStore.getState().select([netAnnotationId], "replace");
        focusOnIds([netAnnotationId], { tight: true });
      }, NET_HOLD_MS);
      const stop = () => {
        window.clearTimeout(ringTimer);
        window.clearTimeout(holdTimer);
        netHoldLive.set(null);
      };
      // Once the hold fired, the rest of the gesture is swallowed (the view
      // just changed under the pointer, so a late drag would be garbage).
      return {
        onDragStart: (d) => {
          if (fired) return;
          stop();
          result.onDragStart?.(d);
        },
        onDragMove: (d) => {
          if (!fired) result.onDragMove?.(d);
        },
        onPointerUp: (d) => {
          stop();
          if (!fired) result.onPointerUp(d);
        },
        onCancel: () => {
          stop();
          if (!fired) result.onCancel?.();
        }
      };
    },
    [routeCanvasPointerDown, annotationLayer, viewportLive, netHoldLive, focusOnIds]
  );

  // ── Cross-tab focus: analog netlist → frame cell on die ──
  // Uses URL query params (?focusCell=&focusDevice=) which survive
  // any SPA navigation and page refreshes. Cleaned up after consumption.
  const [focusSearchParams] = useSearchParams();
  const focusConsumedRef = useRef(false);
  useEffect(() => {
    const cellId = focusSearchParams.get("focusCell");
    const deviceName = focusSearchParams.get("focusDevice");
    if (!cellId || !deviceName || focusConsumedRef.current) return;
    focusConsumedRef.current = true;
    if (!annotationLayer || !annotations) {
      focusConsumedRef.current = false;
      return;
    }
    // Clean URL params (after successful consumption to survive retries)
    const url = new URL(window.location.href);
    url.searchParams.delete("focusCell");
    url.searchParams.delete("focusDevice");
    window.history.replaceState({}, "", url.pathname + url.search);
    // Frame the cell
    focusOnIds([`cell:${cellId}`]);
    // Highlight the analog device in the side panel
    const dev = analogDevicesRef.current.find(
      (d: any) => d._cellId === cellId || d.instanceName === deviceName
    );
    if (dev) setSelectedDevice(dev as any);
  }, [focusSearchParams, annotationLayer, annotations, focusOnIds]);

  const activateAssistantFinding = useCallback((finding: AssistantFinding | null) => {
    setAssistantFinding(finding);
    setAssistantFindingNonce((current) => current + 1);
  }, []);

  const openAssistantNetlist = useCallback(
    (finding: AssistantFinding, view: "code" | "graph" | "schematic") => {
      const params = new URLSearchParams({
        die: dieId,
        assistantView: view,
        assistantInstances: finding.instanceNames.join(","),
      });
      navigate(`/analog-netlist?${params.toString()}`);
    },
    [dieId, navigate],
  );

  const minZoom = die ? (1 / Math.max(die.width, die.height)) * 50 : 0.01;

  // Screenshot: the view re-rendered offscreen at `screenshotScale` × the
  // screen's device pixels (image layers load the finer pyramid tiles it
  // needs), with the DOM overlay canvases (analog highlights, comments…)
  // stretched on top. Right-click the button for the resolution slider.
  const screenshotScale = usePreferences((s) => s.screenshotScale);
  const [screenshotBusy, setScreenshotBusy] = useState<string | null>(null);
  const [screenshotPanel, setScreenshotPanel] = useState<DOMRect | null>(null);
  const screenshotBusyRef = useRef(false);
  const screenshotAbortRef = useRef<AbortController | null>(null);
  const screenCanvasSize = useCallback(() => {
    const c = containerRef.current?.querySelector("canvas");
    return { width: c?.width ?? 0, height: c?.height ?? 0 };
  }, []);
  /** Source px per pixel of the die's finest pyramid level (native detail). */
  const finestLevelScale = useMemo(
    () => (die?.levels?.length ? Math.min(...die.levels.map((l) => l.scale)) : 1),
    [die]
  );
  const takeScreenshot = useCallback(async () => {
    const section = containerRef.current;
    const handle = canvasHandle.current;
    if (!section || !handle || screenshotBusyRef.current) return;
    const canvases = [...section.querySelectorAll("canvas")];
    if (canvases.length === 0) return;
    // First canvas = main tiled canvas; subsequent canvases are overlays.
    const { width: srcW, height: srcH } = canvases[0];
    if (srcW === 0 || srcH === 0) return;
    const native = nativeScreenshotScale(handle.getViewport().zoom, handle.getDpr(), finestLevelScale);
    const scale = resolveScreenshotScale(
      usePreferences.getState().screenshotScale,
      native,
      maxScreenshotScale(srcW, srcH, native)
    );
    const abort = new AbortController();
    screenshotAbortRef.current = abort;
    screenshotBusyRef.current = true;
    setScreenshotBusy("Rendering…");
    try {
      // Floorplans are SVG on screen: draw them as vectors into the snapshot.
      const prefs = usePreferences.getState();
      const floorplans = prefs.floorplanOverlayOn
        ? useFloorplanStore.getState().regions.filter((r) =>
            isFloorplanVisible(r, prefs.hiddenKinds.includes("floorplan"), prefs.hiddenFloorplanTypeNames)
          )
        : [];
      const zoom = handle.getViewport().zoom;
      const blob = await handle.snapshotPng(scale, {
        overlays: canvases.slice(1),
        drawWorld:
          floorplans.length > 0
            ? (ctx, { pxPerWorld, pxPerCss }) => drawFloorplansForSnapshot(ctx, floorplans, { zoom, pxPerWorld, pxPerCss })
            : undefined,
        signal: abort.signal,
        onProgress: ({ band, bands, pendingTiles }) =>
          setScreenshotBusy(
            `${Math.floor((band / bands) * 100)}%` +
              (pendingTiles > 0 ? ` · loading ${pendingTiles} tile${pendingTiles === 1 ? "" : "s"}` : "")
          )
      });
      if (!blob) return;
      const { width, height } = screenshotSize(srcW, srcH, scale);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${die?.name ?? "die"}_screenshot_${width}x${height}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Large files are still being read by the download when click() returns.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      console.error("[screenshot] failed", error);
      void dialog.confirm(error instanceof Error ? error.message : String(error), "Screenshot failed");
    } finally {
      screenshotAbortRef.current = null;
      screenshotBusyRef.current = false;
      setScreenshotBusy(null);
    }
  }, [die?.name, finestLevelScale, dialog]);

  return (
    <AppShell
      breadcrumb={die?.name ?? `die · ${dieId}`}
      meta={die ? `${die.width.toLocaleString()}×${die.height.toLocaleString()}` : undefined}
      onUndo={() => void dispatcher.undo()}
      onRedo={() => void dispatcher.redo()}
      canUndo={dispatcher.canUndo}
      canRedo={dispatcher.canRedo}
    >
      <SubBar
        right={
          <div className="row" style={{ gap: 6 }}>
            {mlJob.data?.status === "running" && (
              <span
                className="chip"
                title={`ML inference: ${mlJob.data.completedTiles}/${mlJob.data.totalTiles} tiles`}
              >
                Inference {mlJob.data.percentage}%
              </span>
            )}
            <IssuesChip errors={totalProblems} warnings={analogWarnings.filter(w => w.startsWith("[WARN]")).length} onClick={() => setShowProblems(v => !v)} />
            <div
              style={{ width: 1, height: 18, background: "var(--l2)", margin: "0 2px" }}
            />

            <button className="btn ghost" title="Zoom out (−)" onClick={zoomOut}>
              {Ic.zoomOut}
            </button>
            <button className="btn ghost" title="Zoom in (+)" onClick={zoomIn}>
              {Ic.zoomIn}
            </button>
            <ZoomChip store={viewportLive} />
            <button className="btn ghost" title="Fit to screen (F)" onClick={fitToScreen}>
              {Ic.fit}
            </button>
            <button className="btn ghost" title="100%" onClick={oneToOne}>
              1:1
            </button>
            <button
              className="btn ghost"
              title={
                screenshotBusy ??
                `Screenshot ${
                  screenshotScale === "native" ? "native" : `${+screenshotScale.toFixed(2)}×`
                } (Ctrl+Shift+S) · right-click for resolution`
              }
              disabled={!!screenshotBusy}
              style={screenshotBusy ? { opacity: 0.6, cursor: "progress" } : undefined}
              onClick={() => void takeScreenshot()}
              onContextMenu={(e) => {
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                setScreenshotPanel((open) => (open ? null : r));
              }}
            >
              {Ic.download}
            </button>
            <div style={{ width: 1, height: 18, background: "var(--l2)", margin: "0 2px" }} />
            <PanelToggle side="right" collapsed={rightCollapsed} onClick={toggleRight} />
          </div>
        }
      >
        <PanelToggle side="left" collapsed={leftCollapsed} onClick={toggleLeft} />
        <div style={{ width: 1, height: 18, background: "var(--l2)", margin: "0 2px" }} />
        <DieToolbar
          activeTool={activeTool}
          setActiveTool={setActiveTool}
          multiWireHint={multiWireHint}
          libraryCell={libraryCell}
        />
      </SubBar>
      <main
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          display: "grid",
          gridTemplateColumns: `${leftCollapsed ? "0px" : "248px"} 1fr ${rightCollapsed ? "0px" : "320px"}`
        }}
      >
        {!leftCollapsed && (
          <aside style={{ ...panelStyle, gridColumn: 1 }}>
            <div className="ph" style={{ paddingRight: 8 }}>
              <span className="u">Items</span>
              <button
                className="btn ghost"
                title="Search (Ctrl+F)"
                onClick={() => outlineSearchRef.current?.()}
                style={{ padding: "2px 0", marginLeft: "auto" }}
              >
                {Ic.search}
              </button>
            </div>
            <OutlineTree
              annotations={annotations}
              onFocus={focusOnIds}
              baseImages={die ? [{ id: die.id, name: die.name }] : []}
              deviceLabels={deviceLabels}
              onDeviceSelect={(id) => { const d = analogDevices.find((x:any) => x._cellId === id || (x as any)._cellId === id); if(d) setSelectedDevice(d) }}
              onOpenInRE={dieId ? (cellId, cellTypeId) => navigate(`/re?die=${encodeURIComponent(dieId)}&type=${encodeURIComponent(cellTypeId)}&cell=${encodeURIComponent(cellId)}`) : undefined}
              searchOpenRef={outlineSearchRef}
              onSetCellTypeColor={(cellTypeId, color) => {
                const ct = annotations?.cellTypes.find((t) => t.id === cellTypeId);
                if (ct) void dispatcher.dispatch({ kind: "upsertCellType", cellType: { ...ct, color }, prevCellType: ct });
              }}
              foreignTypeOwners={foreignTypeOwners}
            />
          </aside>
        )}
        <section
          ref={containerRef}
          onPointerMove={onPointerMove}
          onPointerLeave={onPointerLeave}
          onContextMenu={onCanvasContextMenu}
          onDoubleClick={onCanvasDoubleClick}
          style={{ background: "var(--canvas-bg)", minWidth: 0, position: "relative", overflow: "hidden", gridColumn: 2 }}
        >
          {error && (
            <CenteredStatus>failed to load die · {error.message}</CenteredStatus>
          )}
          {!error && (isLoading || !die) && <CenteredStatus>loading die…</CenteredStatus>}
          {!error && die && initialViewport && (
            <TiledCanvas
              layers={allLayers}
              initialViewport={initialViewport}
              background="#0c0c08"
              minZoom={minZoom}
              maxZoom={32}
              cursor={
                spacePan || activeTool === "pan"
                  ? "grab"
                  : activeTool === "select"
                    ? (cellResizeCursor ?? "default")
                    : "crosshair"
              }
              handleRef={canvasHandle}
              onViewportChange={onViewportChange}
              onPointerDown={onCanvasPointerDown}
              onCanvasClick={onCanvasClick}
            />
          )}
          <NetHoldRing store={netHoldLive} delayMs={NET_HOLD_RING_DELAY_MS} />
          <RulerOverlay
            rulers={visibleRulers}
            draftStore={rulerDraftLive}
            pendingStore={rulerPendingLive}
            viewportStore={viewportLive}
            selectedIds={selectedRulerIds}
            umPerPx={annotations?.umPerPx ?? 0}
            showPx={showRulerPx}
            showUm={showRulerUm}
            showNm={showRulerNm}
          />
          <MarqueeOverlay store={marqueeLive} />
          <WireDraftOverlay
            points={wire.draft?.points ?? NO_DRAFT_POINTS}
            anchored={
              wire.draft != null &&
              (wire.draft.anchor != null || wire.draft.startSplit != null)
            }
            previewStore={wirePreviewLive}
            startSnapStore={wireSnapLive}
            viewportStore={viewportLive}
          />
          <MultiWireOverlay
            points={multiWire.points}
            phase={multiWire.phase}
            draft={multiWire.draft}
            cursorStore={cursorLive}
            snapStore={multiWireSnapLive}
            endSnapStore={multiWireEndSnapLive}
            shiftStore={shiftLive}
            viewportStore={viewportLive}
          />
          <RectDraftOverlay
            rectStore={cellRectLive}
            viewportStore={viewportLive}
            color="#6dd679"
            handles
          />
          <RectDraftOverlay
            rectStore={shapeRectLive}
            viewportStore={viewportLive}
            color={
              activeTool === "roi"
                ? "#f5d68a"
                : activeTool === "ignore"
                  ? "#e36854"
                  : "#82d6a6"
            }
          />
          <PolyDraftOverlay
            points={viaPoly.points}
            previewStore={viaPolyPreviewLive}
            viewportStore={viewportLive}
          />
          <SelectionHandlesOverlay
            annotations={annotations}
            viewportStore={viewportLive}
            previewStore={editPreviewLive}
          />
          <GuidesOverlay
            annotations={annotations}
            viewportStore={viewportLive}
            cursorStore={cursorLive}
            dragStore={guideDragLive}
            segStart={guide.segStart}
          />
          {/* Analog device highlights —  own canvas, LiveValue-driven, no render loop */}
          {deviceOverlayOn && (
            <AnalogDeviceHighlights
              devices={analogDevices}
              viewportStore={viewportLive}
              showNetIds={showTermNetIds}
              netNames={showTermNetIds ? netNames : undefined}
              showCellRelations={showCellRelations}
              cellTypeCounts={showCellRelations ? cellTypeCounts : undefined}
              cellTypeByCellId={showCellRelations ? cellTypeByCellId : undefined}
              onDeviceClick={(dev) => setSelectedDevice(dev)}
              onDeviceDoubleClick={(dev) => {
                if (!annotations) return;
                const cid = (dev as any)._cellId;
                if (!cid) return;
                const cell = (annotations as any).cells?.find((c: any) => c.id === cid);
                if (!cell) return;
                navigate(`/re?die=${encodeURIComponent(dieId)}&type=${encodeURIComponent(cell.cellTypeId)}&cell=${encodeURIComponent(cid)}`);
              }}
            />
          )}
          {assistantFinding && (
            <SubcircuitHighlightsOverlay
              key={`${assistantFinding.id}:${assistantFindingNonce}`}
              devices={analogDevices}
              findings={[assistantFinding]}
              activeFindingId={assistantFinding.id}
              viewportStore={viewportLive}
            />
          )}
          {cellTypePicker && annotations && (() => {
            const pickerCell = annotations.cells.find((c) => c.id === cellTypePicker.cellId);
            return pickerCell ? (
              <CellTypePopover
                dieId={dieId}
                cell={pickerCell}
                annotations={annotations}
                anchor={cellTypePicker.at}
                viewportStore={viewportLive}
                onPick={(ct) => reassignCellType(pickerCell.id, ct)}
                onSplit={(name) => splitCellType(pickerCell.id, name)}
                onSetColor={(ct, color) =>
                  void dispatcher.dispatch({ kind: "upsertCellType", cellType: { ...ct, color }, prevCellType: ct })
                }
                onClose={closeCellTypePicker}
              />
            ) : null;
          })()}
          {netRename && (() => {
            const net = annotations?.nets.find((n) => n.id === netRename.netId);
            const override = netColorOverrides[`net:${netRename.netId}`];
            return net ? (
              <NetRenamePopover
                dieId={dieId}
                net={net}
                anchor={netRename.at}
                viewportStore={viewportLive}
                nameTaken={(name) => !!annotations?.nets.some((n) => n.id !== net.id && n.name === name)}
                color={override ?? globalNetColor}
                hasOverride={override !== undefined}
                defaultColor={globalNetColor}
                customColorsEnabled={customNetColorsEnabled}
                onSave={(name, color) => commitNetRename(net.id, name, color)}
                onClose={closeNetRename}
              />
            ) : null;
          })()}
          {viaColorEdit && annotations && (() => {
            const via = viaFromSelectionId(annotations, `anno:${viaColorEdit.viaId}`);
            const targets = viaColorEdit.targetIds
              .map((id) => viaFromSelectionId(annotations, id))
              .filter((a) => a !== null);
            const stackVias = (sessionMetalStack ?? DEFAULT_METAL_STACK).vias;
            return via && targets.length > 0 ? (
              <ViaColorPopover
                dieId={dieId}
                via={via}
                targets={targets}
                anchor={viaColorEdit.at}
                viewportStore={viewportLive}
                baseColorOf={(a) => viaBaseColor(a, viaLayerColorPrefs, stackVias, globalViaColor)}
                onSave={(color) => commitViaColor(viaColorEdit.targetIds, color)}
                onClose={closeViaColor}
              />
            ) : null;
          })()}
          <CommentOverlay
            annotations={annotations}
            viewportStore={viewportLive}
            dieId={dieId}
            dispatcher={dispatcher}
            pendingNewComment={pendingNewComment}
            onConsumePendingComment={() => setPendingNewComment(null)}
            onAnnotationChange={() => canvasHandle.current?.invalidate()}
          />
          {floorplanOverlayOn && (
            <FloorplanOverlay
              annotations={annotations}
              viewportStore={viewportLive}
              cursorStore={floorplanTipLive}
              dieId={dieId}
              showIO={showFloorplanIO}
              dispatcher={dispatcher}
              onAnnotationChange={() => canvasHandle.current?.invalidate()}
            />
          )}
          {activeTool === "libraryCell" && (
            <LibraryCellOverlay tool={libraryCell} library={library} viewportStore={viewportLive} />
          )}
          {activeTool === "analogCell" && (
            <AnalogCellOverlay tool={analogCell} viewportStore={viewportLive} />
          )}
        </section>
        {!rightCollapsed && (
        <aside style={{ ...panelStyle, gridColumn: 3 }}>
          <div style={{ flex: "1 1 0", minHeight: 0, overflow: "auto" }}>
          <InspectorPanel
            annotations={annotations}
            dispatcher={dispatcher}
            dieId={dieId}
            die={die}
            library={library}
            mlViasLayer={mlViasLayer}
            proposals={proposals}
            cellTypeCounts={cellTypeCounts}
            devices={analogDevices}
            netNames={netNames}
            warnings={analogWarnings}
            floorplanRegions={floorplanRegions}
            onActivateAssistantFinding={activateAssistantFinding}
            onOpenAssistantNetlist={openAssistantNetlist}
            onEditAnalogCell={analogCell.beginEdit}
            analogCell={analogCell}
          />
          </div>
          <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", borderTop: "1px solid var(--l2)" }}>
            <div style={{ maxHeight: "33vh", overflow: "auto" }}>
              <DeviceInstancePanel
                devices={analogDevices}
                selectedDevice={selectedDevice}
                onSelectDevice={(dev) => {
                  setSelectedDevice(dev);
                  const cid = (dev as any)._cellId;
                  if (cid) focusOnIds([`cell:${cid}`]);
                }}
                onDoubleClickDevice={(dev) => {
                  const cid = (dev as any)._cellId;
                  if (!cid) return;
                  const cell = annotations?.cells?.find((c: any) => c.id === cid);
                  if (!cell) return;
                  navigate(`/re?die=${encodeURIComponent(dieId)}&type=${encodeURIComponent(cell.cellTypeId)}&cell=${encodeURIComponent(cid)}`);
                }}
              />
            </div>
            {showProblems ? (
              <div style={{ maxHeight: 360, overflow: "auto", borderTop: "1px solid var(--l2)" }}>
              <ProblemNavigatorPanel
                annotations={annotations ?? (undefined as any)}
                devices={analogDevices}
                netNames={netNames}
                warnings={analogWarnings}
                netIdToUuid={netIdToUuid}
                onFocusCell={(cid) => {
                  focusOnIds([`cell:${cid}`]);
                }}
                onFocusPoint={(x, y) => {
                  canvasHandle.current?.centerOn(x, y, 8);
                }}
                onFocusNet={(uuid) => {
                  focusOnIds([`net:${uuid}`]);
                  useDieViewerStore.getState().select(new Set([`net:${uuid}`]), "replace");
                }}
              />
              </div>
            ) : null}
          </div>
        </aside>
        )}
      </main>
      {selectedDevice && (
        <div
          className="dark"
          style={{
            position: "fixed", right: 330, bottom: 40,
            width: 300, maxHeight: "50vh", zIndex: 100, overflow: "auto",
            background: "var(--card)", border: "1px solid var(--l2)",
            borderRadius: 6, boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
          }}
        >
          <DeviceInspector
            device={selectedDevice}
            onClose={() => setSelectedDevice(null)}
            cellTypeCounts={cellTypeCounts}
            cellTypeByCellId={cellTypeByCellId}
          />
        </div>
      )}
      <StatusBar
        items={[
          die?.name,
          <span key="cursor">
            <CursorReadout store={cursorLive} />
            <HoverReadout store={hoverInfoLive} />
          </span>,
          <ZoomReadout key="zoom" store={viewportLive} />,
          liveRenderStatusText,
          annotations ? annotationsSummary(annotations) : null,
          annotations?.umPerPx != null
            ? `scale: ${annotations.umPerPx.toFixed(3)} µm/px`
            : null,
          unconnectedCount > 0 && analogDevices.length > 0
            ? `${unconnectedCount} unconn`
            : null,
          activeTool === "measure"
            ? "📏 drag to measure — double-click a ruler to set scale"
            : null,
          die?.tileProgress && die.tileProgress.percentage < 100
            ? `tiling ${formatPercent(die.tileProgress.percentage)}`
            : null,
          mlJob.data?.status === "running"
            ? `inference ${mlJob.data.percentage}%`
            : null,
          activeTool === "addCell"
            ? "add cell — drag to draw · corners resize · Enter to add · Esc to cancel"
            : null,
          activeTool === "libraryCell"
            ? libraryCell.hasDraft
              ? "place library cell — drag to move · corners scale · click to move here · Enter to accept · Esc to cancel"
              : (libraryCell.notice ?? "place library cell — pick a cell in the toolbar")
            : null,
          activeTool === "analogCell"
            ? analogCell.following
              ? "place analog device — it follows the mouse · click to drop it · corners set the size · Enter to accept · Esc to cancel"
              : analogCell.hasDraft
                ? "place analog device — drag to move · corners stretch it over the device · Enter to accept · Esc to cancel"
                : "place analog device — move the mouse over the die · it sticks to the cursor · click to drop it"
            : null,
          extractionRunning
            ? `extracting ${extractionProgress?.done ?? 0}/${extractionProgress?.total ?? 1}…`
            : lastTimeMs != null
            ? `analog ${lastTimeMs}ms${lastCached ? " ✓" : ""}`
            : null
        ].filter(Boolean)}
      />
      {contextMenu && (
        <DieContextMenu
          menu={contextMenu}
          onClose={() => setContextMenu(null)}
          onStartWire={() =>
            startWireAt(contextMenu.hitPoint, contextMenu.hitAnchor)
          }
          onStartMultiWire={() =>
            startMultiWireFrom(
              extractAnchorPointsFromSelection(
                useDieViewerStore.getState().selectedIds
              )
            )
          }
          onCopyCell={() => {
            const ann = annotationsRef.current;
            if (!ann || !contextMenu.hitCellId) return;
            // The whole selection when the clicked cell is part of it.
            const selected = useDieViewerStore.getState().selectedIds;
            const id = `cell:${contextMenu.hitCellId}`;
            copySelectionToClipboard(ann, selected.has(id) ? selected : new Set([id]));
          }}
          onCopyNet={() => {
            const ann = annotationsRef.current;
            if (!ann) return;
            const selected = useDieViewerStore.getState().selectedIds;
            const includeSelection = [...selected].some((id) => id.startsWith("net:"));
            const wireSelection = includeSelection
              ? selected
              : contextMenu.hitPartId
                ? new Set([contextMenu.hitPartId])
                : selected;
            if (contextMenu.hitPartId && snapshotWireClipboard(ann.nets, wireSelection)) {
              copySelectionToClipboard(ann, wireSelection);
            }
          }}
          onSplitNetAtNode={() => {
            const ann = annotationsRef.current;
            const anchor = contextMenu.hitAnchor;
            if (!ann || !anchor || !contextMenu.canSplitNetAtNode) return;
            const changes = splitNetAtNode(ann.nets, anchor.netId, anchor.nodeId);
            const action = changes ? netChangesToAction(changes) : null;
            if (action) void dispatcher.dispatch(action);
          }}
          onMakeUnique={() => {
            const ann = annotationsRef.current;
            if (!ann || !contextMenu.hitCellId) return;
            const cell = ann.cells?.find((c) => c.id === contextMenu.hitCellId);
            if (!cell) return;
            void dispatcher.dispatch(buildMakeUniqueAction(ann, cell));
          }}
          cellsLocked={cellsLocked}
          onOrientCell={(op) => {
            const ann = annotationsRef.current;
            if (!ann || !contextMenu.hitCellId || usePreferences.getState().cellsLocked) return;
            // Like copy: the whole selection when the clicked cell is in it.
            const selected = useDieViewerStore.getState().selectedIds;
            const targets = selected.has(`cell:${contextMenu.hitCellId}`)
              ? ann.cells.filter((c) => selected.has(`cell:${c.id}`))
              : ann.cells.filter((c) => c.id === contextMenu.hitCellId);
            // Each cell turns / mirrors about its own footprint centre.
            const actions = targets.map((c) => buildOrientAction(c, orientOnDie(orientOf(c), op)));
            if (actions.length === 1) void dispatcher.dispatch(actions[0]);
            else if (actions.length > 1) void dispatcher.dispatch({ kind: "batch", actions });
          }}
          onDeleteRuler={() => {
            const ruler = annotationsRef.current?.rulers?.find((r) => r.id === contextMenu.hitRulerId);
            if (!ruler) return;
            void dispatcher.dispatch({ kind: "removeRuler", ruler });
            setSelectedRulerIds(new Set());
            rulerDraftLive.set(null);
            rulerPendingLive.set(null);
          }}
          onSetScaleFromRuler={async () => {
            const ruler = annotationsRef.current?.rulers?.find((r) => r.id === contextMenu.hitRulerId);
            if (!ruler || ruler.lengthPx <= 0) return;
            const input = await dialog.prompt(
              `Ruler: ${Math.round(ruler.lengthPx).toLocaleString()} px\nEnter known size in µm:`,
              annotationsRef.current?.umPerPx ? (ruler.lengthPx * annotationsRef.current.umPerPx).toFixed(2) : ""
            );
            if (input === null) return;
            const um = parseFloat(input);
            if (!Number.isFinite(um) || um <= 0) return;
            void dispatcher.dispatch({ kind: "setUmPerPx", umPerPx: um / ruler.lengthPx, prevUmPerPx: annotationsRef.current?.umPerPx ?? null });
          }}
          onPasteCell={() => dispatchPaste(dispatcher, annotationsRef.current, contextMenu.hitPoint)}
          onPasteNet={() => dispatchPaste(dispatcher, annotationsRef.current, contextMenu.hitPoint)}
          hasWireClipboard={useDieViewerStore.getState().clipboardWires !== null}
          hasCellClipboard={useDieViewerStore.getState().clipboardCells.length > 0}
          hasPinClipboard={useDieViewerStore.getState().clipboardPins.length > 0}
          hasFloorplanClipboard={useDieViewerStore.getState().clipboardFloorplans.length > 0}
          onCopyPin={() => {
            const ann = annotationsRef.current;
            const partId = contextMenu.hitPartId;
            if (!ann || !partId?.startsWith("pin:")) return;
            // Like cells: the whole selection when the pad is part of it.
            const selected = useDieViewerStore.getState().selectedIds;
            copySelectionToClipboard(ann, selected.has(partId) ? selected : new Set([partId]));
          }}
        />
      )}
      {screenshotPanel && (() => {
        const base = screenCanvasSize();
        return (
          <ScreenshotPanel
            anchor={screenshotPanel}
            scale={screenshotScale}
            viewport={viewportLive}
            dpr={canvasHandle.current?.getDpr() ?? window.devicePixelRatio ?? 1}
            finestLevelScale={finestLevelScale}
            baseWidth={base.width}
            baseHeight={base.height}
            busy={screenshotBusy}
            onScale={(v) => usePreferences.getState().setScreenshotScale(v)}
            onTake={() => void takeScreenshot()}
            onCancel={() => screenshotAbortRef.current?.abort()}
            onClose={() => setScreenshotPanel(null)}
          />
        );
      })()}
      <ShortcutsPanel open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        deviceOverlayOn={deviceOverlayOn}
        setDeviceOverlayOn={setDeviceOverlayOn}
        cellsLocked={cellsLocked}
        setCellsLocked={setCellsLocked}
        showTermNetIds={showTermNetIds}
        setShowTermNetIds={setShowTermNetIds}
        showCellRelations={showCellRelations}
        setShowCellRelations={setShowCellRelations}
        viaLabelsVisible={viaLabelsVisible}
        setViaLabelsVisible={setViaLabelsVisible}
        floorplanOverlayOn={floorplanOverlayOn}
        setFloorplanOverlayOn={setFloorplanOverlayOn}
        showFloorplanIO={showFloorplanIO}
        setShowFloorplanIO={setShowFloorplanIO}
        llmProvider={llmProvider}
        setLlmProvider={setLlmProvider}
        assistantDataFlags={assistantDataFlags}
        setAssistantDataFlags={setAssistantDataFlags}
        assistantMaxHypotheses={assistantMaxHypotheses}
        setAssistantMaxHypotheses={setAssistantMaxHypotheses}
        ngspiceMode={ngspiceMode}
        setNgspiceMode={setNgspiceMode}
        ngspicePath={ngspicePath}
        setNgspicePath={setNgspicePath}
      />
    </AppShell>
  );
}

// ── Helpers ───────────────────────────────────────────────────────

/** Hit-test analog devices at a world coordinate. Returns the smallest
 *  (tightest bbox) device under the point, or null. */
function hitTestAnalogDevice(
  world: { x: number; y: number },
  devices: readonly import("shared").AnalogDevice[],
): import("shared").AnalogDevice | null {
  let best: import("shared").AnalogDevice | null = null;
  let bestArea = Infinity;
  for (const dev of devices) {
    const b = dev.bbox;
    if (!b) continue;
    if (world.x >= b.x && world.x <= b.x + b.width &&
        world.y >= b.y && world.y <= b.y + b.height) {
      const area = b.width * b.height;
      if (area < bestArea) {
        bestArea = area;
        best = dev;
      }
    }
  }
  return best;
}

/**
 * Copy the cells, I/O pads, wires and floorplan regions in `sel` to the
 * clipboard, positioned relative to their common top-left. Kinds with nothing
 * selected are cleared, so a paste brings back exactly this selection. False
 * when there is nothing to copy (clipboard untouched).
 */
function copySelectionToClipboard(ann: DieAnnotations, sel: ReadonlySet<string>): boolean {
  const cells = ann.cells?.filter((c) => sel.has(`cell:${c.id}`)) ?? [];
  const wireBounds = wireSelectionBounds(ann.nets, sel);
  const pins = selectedPins(ann.pins, sel);
  const regions = selectedFloorplans(ann.floorplanRegions, sel);
  const fpBounds = floorplanBounds(regions);
  if (cells.length === 0 && !wireBounds && pins.length === 0 && !fpBounds) return false;
  const minX = Math.min(...cells.map((c) => c.x), ...pins.map((p) => p.x), wireBounds?.minX ?? Infinity, fpBounds?.minX ?? Infinity);
  const minY = Math.min(...cells.map((c) => c.y), ...pins.map((p) => p.y), wireBounds?.minY ?? Infinity, fpBounds?.minY ?? Infinity);
  const viewerStore = useDieViewerStore.getState();
  viewerStore.setPinClipboard(pinClips(pins, minX, minY));
  viewerStore.setFloorplanClipboard(floorplanClips(regions, minX, minY));
  if (cells.length > 0) {
    viewerStore.copyCells(
      cells.map((c) => ({
        cellTypeId: c.cellTypeId,
        offsetX: c.x - minX,
        offsetY: c.y - minY,
        flippedV: c.flippedV,
        flippedH: c.flippedH,
        rotation: c.rotation,
        bounds: c.bounds,
      }))
    );
  } else {
    viewerStore.clearCellClipboard();
  }
  if (wireBounds) {
    viewerStore.setWireClipboard(snapshotWireClipboard(ann.nets, sel, { x: minX, y: minY })!);
  } else {
    viewerStore.clearWireClipboard();
  }
  return true;
}

/** Anything to paste (cells, wires, pads or floorplans). */
function clipboardHasContent(store: ReturnType<typeof useDieViewerStore.getState>): boolean {
  return (
    store.clipboardCells.length > 0 ||
    store.clipboardWires !== null ||
    store.clipboardPins.length > 0 ||
    store.clipboardFloorplans.length > 0
  );
}

/** Actions pasting the whole clipboard with its top-left at `base`. */
function pasteClipboardActions(ann: DieAnnotations, base: { x: number; y: number }): AnnotationAction[] {
  const store = useDieViewerStore.getState();
  const actions: AnnotationAction[] = store.clipboardCells.map((clip) => ({
    kind: "upsertCell" as const,
    cell: {
      id: uuid(),
      cellTypeId: clip.cellTypeId,
      x: base.x + clip.offsetX,
      y: base.y + clip.offsetY,
      flippedV: clip.flippedV,
      flippedH: clip.flippedH,
      rotation: clip.rotation,
      ...(clip.bounds ? { bounds: clip.bounds } : {}),
    },
    prevCell: null,
  }));
  actions.push(...pastePinActions(store.clipboardPins, base));
  if (store.clipboardWires) {
    const wireAction = netChangesToAction(pasteWireClipboard(ann.nets, store.clipboardWires, base));
    if (wireAction?.kind === "batch") actions.push(...wireAction.actions);
    else if (wireAction) actions.push(wireAction);
  }
  const au = useAuth.getState();
  actions.push(
    ...pasteFloorplanActions(store.clipboardFloorplans, base, { userId: au.userId ?? null, username: au.username ?? null })
  );
  return actions;
}

/** Paste the clipboard at `at` (rounded) as one undoable batch. */
function dispatchPaste(dispatcher: ActionDispatcher, ann: DieAnnotations | undefined, at: { x: number; y: number }): void {
  if (!ann || !clipboardHasContent(useDieViewerStore.getState())) return;
  const actions = pasteClipboardActions(ann, { x: Math.round(at.x), y: Math.round(at.y) });
  if (actions.length > 0) void dispatcher.dispatch({ kind: "batch", actions });
}
