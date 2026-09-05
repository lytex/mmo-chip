import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { AnalogDevice, AnnotationNet, AssistantFinding } from "shared";
import { annotationKeys, useAnnotations } from "../api/annotations";
import { useAnnotationsWebSocket } from "../api/annotationsWebSocket";
import { netChangesToAction, useActionDispatcher } from "../api/actions";
import { useDie } from "../api/dies";
import { AppShell } from "../components/shell/AppShell";
import { StatusBar } from "../components/shell/StatusBar";
import { SubBar } from "../components/shell/SubBar";
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
  populateAnnotationLayer
} from "../renderer/annotations/dieAnnotations";
import { OutlineTree } from "../components/dieViewer/OutlineTree";
import { ShortcutsPanel } from "../components/dieViewer/ShortcutsPanel";
import { SettingsPanel } from "../components/dieViewer/SettingsPanel";
import {
  CenteredStatus,
  CursorReadout,
  MarqueeOverlay,
  ZoomChip,
  ZoomReadout,
  annotationsSummary,
  panelStyle
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
import { useDieExtraction } from "../hooks/useDieExtraction";
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
import { useViaPolyTool } from "../components/dieViewer/useViaPolyTool";
import {
  multiParallelEnd,
  multiWireEndpoint,
  useMultiWireTool
} from "../components/dieViewer/useMultiWireTool";
import { MultiWireOverlay } from "../components/dieViewer/MultiWireOverlay";
import { CommentOverlay } from "../components/dieViewer/CommentOverlay";
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
import type { AnnotationAction } from "../api/actions";
import { parseNetPartId, type DrawAnchor } from "../lib/netGraph";
import {
  normalizeRect,
  distancePointToSegment,
  pointInRect,
  rectCornerAt,
  rectCorners,
  rectFromPoints,
  snapTo45,
  squareFromPoints,
  type Point,
  type Rect
} from "../lib/geometry";
import { viaSnapTolerance } from "../renderer/annotations/style";
import type { Layer, Viewport } from "../renderer/types";
import { formatPercent } from "../lib/format";
import { isTypingTarget } from "../lib/keyboard";
import { buildMakeUniqueAction } from "../lib/mergeCells";
import { createLiveValue } from "../lib/liveValue";
import type { WirePreview } from "../components/dieViewer/WireDraftOverlay";
import { ANNOTATION_KIND_VALUES } from "../state/annotationKinds";
import { DEFAULT_ML_CONFIG, useDieViewerStore } from "../state/dieViewer";
import { useOverlayLayers, saveOverlaySettingsToPrefs, applyOverlaySettingsFromPrefs } from "../state/overlayLayers";
import { usePreferences } from "../state/preferences";
import { useSession, DEFAULT_METAL_STACK, fetchMetalStack } from "../state/session";
import { useUserStatus } from "../lib/useUserStatus";
import { uuid } from "../lib/uuid";

/** Stable empty points array so the overlay effect doesn't churn when idle. */
const NO_DRAFT_POINTS: Point[] = [];

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
  const { data: annotations } = useAnnotations(dieId);
  const toast = useToast();
  const dialog = useDialog();
  useAnnotationsWebSocket(dieId);
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
  const dispatcher = useActionDispatcher(dieId);

  // Hot-path live values. These never trigger DieViewer re-renders — only the
  // tiny readout subcomponents subscribe via `useLiveValue`. The renderer
  // also reads them directly via the canvas handle.
  const viewportLive = useMemo(() => createLiveValue<Viewport | null>(null), []);
  const cursorLive = useMemo(
    () => createLiveValue<{ x: number; y: number } | null>(null),
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
            const sel = useDieViewerStore.getState().selectedIds;
            const cells = ann?.cells?.filter((c) => sel.has(`cell:${c.id}`)) ?? [];
            if (cells.length === 0) return;
            e.preventDefault();
            useDieViewerStore.getState().copyCells(
              cells.map((c) => ({ cellTypeId: c.cellTypeId, flippedV: c.flippedV, flippedH: c.flippedH, rotation: c.rotation }))
            );
            return;
          }
          case "pasteCell": {
            const ann = annotationsRef.current;
            if (!ann) return;
            const store = useDieViewerStore.getState();
            const clips = store.clipboardCells;
            if (clips.length === 0) return;
            e.preventDefault();
            const cursor = cursorLive.get();
            const baseX = cursor ? cursor.x : 0;
            const baseY = cursor ? cursor.y : 0;
            for (let i = 0; i < clips.length; i++) {
              const clip = clips[i];
              void dispatcherRef.current.dispatch({
                kind: "upsertCell",
                cell: {
                  id: uuid(), cellTypeId: clip.cellTypeId,
                  x: Math.round(baseX + i * 50), y: Math.round(baseY + i * 50),
                  flippedV: clip.flippedV, flippedH: clip.flippedH,
                  rotation: clip.rotation,
                },
                prevCell: null,
              });
            }
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
            const curIdx = metalStack.metals.findIndex(m => m.id === cur.activeMetalId);
            if (curIdx < 0) return;
            const nextIdx = modDef.action === "viaUp" ? curIdx + 1 : curIdx - 1;
            if (nextIdx < 0 || nextIdx >= metalStack.metals.length) return;
            const via = metalStack.vias[nextIdx < curIdx ? nextIdx : curIdx];
            if (!via) return;
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
            cur.setActiveMetalId(metalStack.metals[nextIdx].id);
            return;
          }
        }
      }

      // Ctrl+Shift+S → screenshot (PNG download, 4K with overlays)
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        takeScreenshot();
        return;
      }

      if (e.metaKey || e.ctrlKey) return; // other ctrl combos → handled by undo/redo

      const metalStack = useSession.getState().metalStack ?? DEFAULT_METAL_STACK;

      // Metal layer hotkeys: bare digits 1..N
      const metalIdx = !e.shiftKey && !e.altKey ? METAL_HOTKEYS[e.key] : undefined;
      if (metalIdx != null && metalIdx < metalStack.metals.length) {
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

  const getNetW = useCallback(() => usePreferences.getState().netWidth, []);
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
          : usePreferences.getState().netWidth,
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
      netNodeMatchesWidth: () =>
        usePreferences.getState().inspectorTab === "ml",
      wireLayerColor: (layer: string) =>
        usePreferences.getState().wireLayerColors[layer],
      netNodeRadiusMult: () =>
        usePreferences.getState().netNodeVisible
          ? usePreferences.getState().netNodeSize
          : 0,
      isSibling: (cellId: string) => {
        if (!annotations) return false;
        const sel = useDieViewerStore.getState().selectedIds;
        if (sel.size === 0) return false;
        let ctId: string | undefined;
        for (const s of sel) {
          if (s.startsWith("cellType:")) { ctId = s.slice(9); break; }
          if (s.startsWith("cell:")) {
            const c = annotations.cells.find((c) => c.id === s.slice(5));
            if (c) { ctId = c.cellTypeId; break; }
          }
        }
        if (!ctId) return false;
        const c = annotations.cells.find((c) => c.id === cellId);
        return c?.cellTypeId === ctId;
      },
      siblingActive: () => {
        const sel = useDieViewerStore.getState().selectedIds;
        if (sel.size === 0) return false;
        for (const s of sel) {
          if (s.startsWith("cell:") || s.startsWith("cellType:")) return true;
        }
        return false;
      }
    });
  }, [annotationLayer, annotations]);

  // Net width/color + cell color/detail + via size/color + wire layer color
  // + net node size/visibility pref changes → invalidate the canvas.
  useEffect(() => {
    const unsubs = (
      ["netWidth", "netColor", "netColors", "customNetColorsEnabled", "cellColor", "cellShowShapes", "viaSize",
       "viaColor", "wireLayerColors", "viaLayerColors", "netNodeSize", "netNodeVisible"] as const
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
      ["baseImageHidden", "baseImageOpacity", "mlResultsHidden"] as const
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

  // Push selection changes into the annotation layer so its draw highlights.
  // ML vias get the same set — the layer filters out non-`ml-via:` ids itself.
  const selectedIds = useDieViewerStore((s) => s.selectedIds);
  useEffect(() => {
    annotationLayer?.setSelectedIds(selectedIds);
    mlViasLayer?.setSelectedIds(selectedIds);
  }, [annotationLayer, mlViasLayer, selectedIds]);

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
    if (mlViasLayer) out.push(mlViasLayer);
    if (annotationLayer) out.push(annotationLayer);
    return out;
  }, [layers, overlayLayerInstances, mlViasLayer, annotationLayer]);

  // ── Behaviors (extracted hooks) ─────────────────────────────────

  const { initialViewport, onViewportChange } = usePersistedViewport({
    dieId,
    die,
    viewportLive,
    containerRef
  });

  const { selectFromHit, clearSelectionFromEmpty, selectFromMarquee } =
    useCanvasSelection();

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

  // Cell sibling set: when a cell or cellType is selected, all cells sharing
  // that cellTypeId get a glow highlight on the die view.
  const siblingIds = useMemo(() => {
    if (!annotations || selectedIds.size === 0) return new Set<string>();
    let ctId: string | undefined;
    for (const s of selectedIds) {
      if (s.startsWith("cellType:")) { ctId = s.slice(9); break; }
      if (s.startsWith("cell:")) {
        const c = annotations.cells.find((c) => c.id === s.slice(5));
        if (c) { ctId = c.cellTypeId; break; }
      }
    }
    if (!ctId) return new Set<string>();
    return new Set(annotations.cells.filter((c) => c.cellTypeId === ctId).map((c) => c.id));
  }, [annotations, selectedIds]);

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

  const viaPoly = useViaPolyTool({ dispatcher, activeTool, setActiveTool });
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
    const left = multiWire.ends.reduce((a, e) => a + (e ? 0 : 1), 0);
    return `click each wire to end · ${left} left`;
  }, [multiWire.phase, multiWire.points, multiWire.ends]);

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
        multiWire.phase !== 2 ||
        multiWire.points.length === 0
      ) {
        return null;
      }
      const tol = viaSnapTolerance(vp.zoom, usePreferences.getState().viaSize);
      const via = findNearestVia(world, tol);
      if (!via) return null;
      const V: Point = { x: Math.round(via.x), y: Math.round(via.y) };
      // Pick which wire to lock: the still-sweeping one whose projected
      // endpoint (under the current bus geometry) is closest to the via.
      const ref = multiWire.points[0];
      const projected = snapTo45(ref, world);
      let best = -1;
      let bestDist = Infinity;
      multiWire.points.forEach((p, i) => {
        if (multiWire.ends[i]) return; // already locked
        const wireEnd = multiWireEndpoint(p, ref, projected);
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
        multiWire.phase !== 2 ||
        multiWire.points.length === 0
      ) {
        return [];
      }
      const tol = viaSnapTolerance(vp.zoom, usePreferences.getState().viaSize);
      const ref = multiWire.points[0];
      const projected = multiParallelEnd(ref, world, false);
      if (projected.x === ref.x && projected.y === ref.y) return [];
      const out: Array<{ endpoint: Point; lockIndex: number }> = [];
      multiWire.points.forEach((p, i) => {
        if (multiWire.ends[i]) return;
        const end = multiWireEndpoint(p, ref, projected);
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
  // Overlay layer hotkeys (Ctrl+Shift+B, ], [, Ctrl+Shift+1..8).
  useOverlayHotkeys();

  // ── Pointer move / leave ────────────────────────────────────────

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
      shiftRef.current = event.shiftKey;
      shiftLive.set(event.shiftKey);
      wire.computeWirePreview(world, event.shiftKey, vp.zoom);
      const tool = useDieViewerStore.getState().activeTool;
      viaPolyPreviewLive.set(tool === "viaPoly" ? world : null);
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
    },
    [
      cursorLive,
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
      findMultiWireAutoEndSnaps
    ]
  );

  const onPointerLeave = useCallback(() => {
    cursorLive.set(null);
    viaPolyPreviewLive.set(null);
    multiWireSnapLive.set(null);
    multiWireEndSnapLive.set(null);
    wireSnapLive.set(null);
  }, [
    cursorLive,
    viaPolyPreviewLive,
    multiWireSnapLive,
    multiWireEndSnapLive,
    wireSnapLive
  ]);

  // ── Canvas pointer-down router ──────────────────────────────────

  const onCanvasPointerDown = useCallback(
    (e: PointerEventData): Interaction => {
      // Holding Space (or middle-drag, handled in the canvas) momentarily
      // forces pan regardless of the active tool.
      if (spacePanRef.current) return "pan";
      const tool = useDieViewerStore.getState().activeTool;

      if (tool === "measure" || tool === "select") {
        const vp = viewportLive.get();
        const tolerance = vp ? 10 / vp.zoom : 10;
        const hit = (annotationsRef.current?.rulers ?? []).find((ruler) =>
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
              apiPut(`/api/dies/${dieId}/floorplan/${region.id}`, region).catch((e) => toast.error("Failed to save floorplan", e instanceof Error ? e.message : String(e)));
              useFloorplanStore.getState().upsertRegion(region);
              useFloorplanStore.getState().selectRegion(region.id);
              queryClient.invalidateQueries({ queryKey: annotationKeys.forDie(dieId) });
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
        const snapOrtho = (wp: { x: number; y: number }) => {
          const mode = useDieViewerStore.getState().measureMode;
          const dx = wp.x - origin.x;
          const dy = wp.y - origin.y;
          if (mode === "h") return { x: wp.x, y: origin.y };
          if (mode === "v") return { x: origin.x, y: wp.y };
          if (mode === "ortho") {
            // Snap to the dominant axis.
            if (Math.abs(dx) >= Math.abs(dy)) {
              return { x: wp.x, y: origin.y };
            } else {
              return { x: origin.x, y: wp.y };
            }
          }
          if (mode === "diag") {
            // Snap to nearest 45-degree angle.
            const len = Math.sqrt(dx * dx + dy * dy);
            if (len < 1) return wp;
            const angle = Math.atan2(dy, dx);
            // Round to nearest multiple of PI/4 (45°).
            const rounded = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
            return {
              x: origin.x + Math.cos(rounded) * len,
              y: origin.y + Math.sin(rounded) * len
            };
          }
          return wp;
        };
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
      const tolerance = HIT_TOLERANCE_PX / vp.zoom;
      const hit = annotationLayer.hitTest(e.worldPoint, tolerance);

      if (hit) {
        // Dragging an existing net vertex moves it. The move is shown live by
        // updating just that one net in the index (no full repopulate); the
        // undoable `upsertNet` is dispatched only on pointer-up.
        const node = wire.nodeFromHit(hit);
        if (node && annotationLayer) {
          const original =
            wire.netsRef.current.find((n) => n.id === node.netId) ?? null;
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
              const moved = moveNode(worldPoint);
              if (moved) {
                annotationLayer.update(buildNetAnnotation(moved, getNetW, getNetC()));
              }
            },
            onPointerUp: ({ dragged, worldPoint, modifiers }) => {
              const moved = dragged ? moveNode(worldPoint) : null;
              if (!moved || !original) {
                selectFromHit(hit, modifiers.shift);
                return;
              }
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

        // Dragging a placed cell repositions it — same live-update / commit-on-
        // up scheme as the net-vertex drag above.
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
          // Shift locks the move to the dominant axis (re-evaluated live, so
          // tapping Shift mid-drag snaps it straight without restarting).
          const moveCell = (
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
                buildCellAnnotation(
                  moveCell(worldPoint, startWorld, modifiers.shift, false),
                  cellType,
                  getCellC,
                  getCellShapes
                )
              );
            },
            onPointerUp: ({ dragged, worldPoint, startWorld, modifiers }) => {
              if (!dragged) {
                selectFromHit(hit, modifiers.shift);
                return;
              }
              void dispatcher.dispatch({
                kind: "upsertCell",
                cell: moveCell(worldPoint, startWorld, modifiers.shift, true),
                prevCell: original
              });
            },
            onCancel: () => {
              annotationLayer.update(
                buildCellAnnotation(original, cellType, getCellC, getCellShapes)
              );
            }
          };
          return handler;
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

      // Click on empty → marquee.
      const startScreen = { x: e.screenPoint.x, y: e.screenPoint.y };
      const startWorld = { x: e.worldPoint.x, y: e.worldPoint.y };
      const handler: DragHandler = {
        onDragStart: ({ screenPoint }) => {
          marqueeLive.set(rectFromPoints(startScreen, screenPoint));
        },
        onDragMove: ({ screenPoint }) => {
          marqueeLive.set(rectFromPoints(startScreen, screenPoint));
        },
        onPointerUp: ({ dragged, worldPoint, modifiers }) => {
          marqueeLive.set(null);
          if (!dragged) {
            clearSelectionFromEmpty(modifiers.shift);
            return;
          }
          const world = rectFromPoints(startWorld, worldPoint);
          const ids = annotationLayer.queryRect(world).map((a) => a.id);
          if (!usePreferences.getState().guidesLocked) {
            for (const g of guidesInRect(
              annotationsRef.current?.guides ?? [],
              world
            )) {
              ids.push(`guide:${g.id}`);
            }
          }
          // ML vias swept by the marquee — only those currently rendered
          // (i.e. above the confidence threshold). Synthetic position IDs.
          if (mlViasLayer) {
            for (const v of mlViasLayer.queryViasInRect(world)) {
              ids.push(v.id);
            }
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
      marqueeLive,
      selectFromHit,
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
      getCellShapes
    ]
  );

  // Canvas click (pan mode, no drag) → resolve the active tool into an action.
  const onCanvasClick = useCallback(
    ({ x, y }: { x: number; y: number }) => {
      const tool = useDieViewerStore.getState().activeTool;
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
            draft.points.push({ x: Math.round(x), y: Math.round(y) });
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
        viaPoly.addPoint({ x, y });
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
          // different vias). Then the snap-to-vias-near-cursor path; finally
          // the normal nearest-preview lock on the parallel front.
          const autos = findMultiWireAutoEndSnaps({ x, y }, shiftRef.current);
          if (autos.length > 0) {
            multiWire.endWires(autos);
          } else {
            const snap = findMultiWireEndpointViaSnap(
              { x, y },
              shiftRef.current
            );
            if (snap) {
              multiWire.endWire({ x, y }, false, {
                endpoint: snap.endpoint,
                lockIndex: snap.lockIndex
              });
            } else {
              multiWire.endWire({ x, y }, shiftRef.current);
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
      findMultiWireAutoEndSnaps
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
      let hitRulerId: string | undefined;
      const rulerHit = (annotationsRef.current?.rulers ?? []).find((ruler) =>
        distancePointToSegment(world, { x: ruler.x1, y: ruler.y1 }, { x: ruler.x2, y: ruler.y2 }) <= HIT_TOLERANCE_PX / vp.zoom
      );
      if (rulerHit) {
        hitRulerId = rulerHit.id;
        setSelectedRulerIds(new Set([rulerHit.id]));
      }
      const tol = HIT_TOLERANCE_PX / vp.zoom;
      const hit = annotationLayer?.hitTest(world, tol) ?? null;
      if (hit) {
        if (hit.annotation.kind === "cell" && hit.annotation.id.startsWith("cell:")) {
          hitCellId = hit.annotation.id.slice(5);
        }
        const node = wire.nodeFromHit(hit);
        if (node) {
          hitPoint = { x: node.x, y: node.y };
          hitAnchor = { netId: node.netId, nodeId: node.nodeId };
          hitLabel = "from net vertex";
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
        hitRulerId
      });
    },
    [annotationLayer, mlViasLayer, wire, extractAnchorPointsFromSelection]
  );

  /**
   * Double-click on the canvas. In the wire tool this commits the in-flight
   * draft (dropping the spurious dbl-click second point). In the select tool
   * it's a shortcut for "start wiring from this via" — only fires when the
   * dbl-click lands on a via (manual or ML), so net-vertex dbl-clicks keep
   * their existing "promote sub-selection to whole net" meaning.
   */
  const onCanvasDoubleClick = useCallback(
    async (event: React.MouseEvent<HTMLDivElement>) => {
      const tool = useDieViewerStore.getState().activeTool;
      if (tool === "wire") {
        wire.commitWire({ dropLast: true });
        return;
      }
      // Floorplan poly: double-click to finish polygon
      if (tool === "floorplan") {
        const fs = useFloorplanStore.getState();
        if (fs.toolMode === "poly" && fs.draft && fs.draft.active && fs.draft.points.length >= 3) {
          const pts = fs.draft.points;
          const au = useAuth.getState();
          const region: import("shared").FloorplanRegion = {
            id: uuid(),
            name: "",
            kind: "polygon",
            geometry: pts,
            color: "#4dabf7",
            createdBy: au.userId ?? null,
            createdByName: au.username ?? null,
            createdAt: new Date().toISOString(),
            reservedBy: null,
            reservedByName: null,
            reservedAt: null,
          };
          apiPut(`/api/dies/${dieId}/floorplan/${region.id}`, region).catch((e) => toast.error("Failed to save floorplan", e instanceof Error ? e.message : String(e)));
          useFloorplanStore.getState().upsertRegion(region);
          useFloorplanStore.getState().setDraft(null);
          useFloorplanStore.getState().selectRegion(region.id);
          queryClient.invalidateQueries({ queryKey: annotationKeys.forDie(dieId) });
        }
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
      const hit = annotationLayer?.hitTest(world, tol) ?? null;
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

      // Double-click on ANY cell annotation → open in RE Cell
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
        const cellHit = annotationLayer?.hitTest(world, tol) ?? null;
        if (cellHit && cellHit.annotation.id.startsWith("cell:")) {
          const cid = cellHit.annotation.id.slice(5);
          const cell = (anns as any).cells?.find((c: any) => c.id === cid);
          if (cell) {
            cellId = cid;
            cellTypeId = cell.cellTypeId;
          }
        }
      }
      if (cellId && cellTypeId) {
        navigate(`/re?die=${encodeURIComponent(dieId)}&type=${encodeURIComponent(cellTypeId)}&cell=${encodeURIComponent(cellId)}`);
      }
    },
    [annotationLayer, mlViasLayer, wire, startWireAt, navigate, dieId, dialog]
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
    (ids: string[]) => {
      if (!annotationLayer || !containerRef.current) return;
      const box = annotationLayer.unionBBox(ids);
      if (!box) return;
      const rect = containerRef.current.getBoundingClientRect();
      const newVp = fitRectViewport(box, rect.width, rect.height, 56, 32);
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

  // Screenshot: composite main canvas + analog overlay at 4K resolution.
  const takeScreenshot = useCallback(() => {
    const section = containerRef.current;
    if (!section) return;
    const canvases = section.querySelectorAll("canvas");
    if (canvases.length === 0) return;
    // First canvas = main tiled canvas; subsequent canvases are overlays
    // (analog highlights, comment overlay, etc.)
    const mainCanvas = canvases[0] as HTMLCanvasElement;
    const srcW = mainCanvas.width;
    const srcH = mainCanvas.height;
    if (srcW === 0 || srcH === 0) return;

    // Target: 4K (3840px on longest side, keep aspect ratio).
    const TARGET_LONGEST = 3840;
    const scale = Math.min(TARGET_LONGEST / srcW, TARGET_LONGEST / srcH, 1);
    const outW = Math.round(srcW * scale);
    const outH = Math.round(srcH * scale);

    const out = document.createElement("canvas");
    out.width = outW;
    out.height = outH;
    const ctx = out.getContext("2d")!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    // Draw each canvas layer in order.
    for (const c of canvases) {
      ctx.drawImage(c as HTMLCanvasElement, 0, 0, outW, outH);
    }

    out.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${die?.name ?? "die"}_screenshot.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, "image/png");
  }, [die?.name]);

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

            <button className="btn ghost" title="Zoom out" onClick={zoomOut}>
              {Ic.zoomOut}
            </button>
            <button className="btn ghost" title="Zoom in" onClick={zoomIn}>
              {Ic.zoomIn}
            </button>
            <ZoomChip store={viewportLive} />
            <button className="btn ghost" title="Fit to screen" onClick={fitToScreen}>
              {Ic.fit}
            </button>
            <button className="btn ghost" title="100%" onClick={oneToOne}>
              1:1
            </button>
            <button
              className="btn ghost"
              title="Screenshot (Ctrl+Shift+S)"
              onClick={takeScreenshot}
            >
              {Ic.download}
            </button>
          </div>
        }
      >
        <DieToolbar
          activeTool={activeTool}
          setActiveTool={setActiveTool}
          multiWireHint={multiWireHint}
        />
      </SubBar>
      <main
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          display: "grid",
          gridTemplateColumns: "248px 1fr 320px"
        }}
      >
        <aside style={panelStyle}>
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
          />
        </aside>
        <section
          ref={containerRef}
          onPointerMove={onPointerMove}
          onPointerLeave={onPointerLeave}
          onContextMenu={onCanvasContextMenu}
          onDoubleClick={onCanvasDoubleClick}
          style={{ background: "var(--canvas-bg)", minWidth: 0, position: "relative", overflow: "hidden" }}
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
                    ? "default"
                    : "crosshair"
              }
              handleRef={canvasHandle}
              onViewportChange={onViewportChange}
              onPointerDown={onCanvasPointerDown}
              onCanvasClick={onCanvasClick}
            />
          )}
          <RulerOverlay
            rulers={annotations?.rulers ?? []}
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
            ends={multiWire.ends}
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
          <CommentOverlay
            annotations={annotations}
            viewportStore={viewportLive}
            dieId={dieId}
            pendingNewComment={pendingNewComment}
            onConsumePendingComment={() => setPendingNewComment(null)}
            onAnnotationChange={() => canvasHandle.current?.invalidate()}
          />
          {floorplanOverlayOn && (
            <FloorplanOverlay
              annotations={annotations}
              viewportStore={viewportLive}
              dieId={dieId}
              showIO={showFloorplanIO}
              onAnnotationChange={() => canvasHandle.current?.invalidate()}
            />
          )}
        </section>
        <aside style={panelStyle}>
          <div style={{ flex: "1 1 0", minHeight: 0, overflow: "auto" }}>
          <InspectorPanel
            annotations={annotations}
            dispatcher={dispatcher}
            dieId={dieId}
            mlViasLayer={mlViasLayer}
            cellTypeCounts={cellTypeCounts}
            devices={analogDevices}
            netNames={netNames}
            warnings={analogWarnings}
            floorplanRegions={floorplanRegions}
            onActivateAssistantFinding={activateAssistantFinding}
            onOpenAssistantNetlist={openAssistantNetlist}
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
          <CursorReadout key="cursor" store={cursorLive} />,
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
            const cell = ann.cells?.find((c) => c.id === contextMenu.hitCellId);
            if (!cell) return;
            useDieViewerStore.getState().copyCells([{ cellTypeId: cell.cellTypeId, flippedV: cell.flippedV, flippedH: cell.flippedH, rotation: cell.rotation }]);
          }}
          onMakeUnique={() => {
            const ann = annotationsRef.current;
            if (!ann || !contextMenu.hitCellId) return;
            const cell = ann.cells?.find((c) => c.id === contextMenu.hitCellId);
            if (!cell) return;
            void dispatcher.dispatch(buildMakeUniqueAction(ann, cell));
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
          onPasteCell={() => {
            const ann = annotationsRef.current;
            if (!ann) return;
            const clips = useDieViewerStore.getState().clipboardCells;
            if (clips.length === 0) return;
            const baseX = Math.round(contextMenu.hitPoint.x);
            const baseY = Math.round(contextMenu.hitPoint.y);
            for (let i = 0; i < clips.length; i++) {
              const clip = clips[i];
              void dispatcher.dispatch({
                kind: "upsertCell",
                cell: {
                  id: uuid(),
                  cellTypeId: clip.cellTypeId,
                  x: baseX + i * 50,
                  y: baseY + i * 50,
                  flippedV: clip.flippedV,
                  flippedH: clip.flippedH,
                  rotation: clip.rotation,
                },
                prevCell: null,
              });
            }
          }}
        />
      )}
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
