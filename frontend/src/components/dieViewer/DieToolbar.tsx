import { Fragment, type ReactNode } from "react";
import { Ic } from "../../icons";
import { useLiveValue } from "../../lib/liveValue";
import { DIE_VIEWER_HOTKEYS, hotkeyFor, withShortcut } from "../../lib/hotkeys";
import type { LibraryCellTool } from "./useLibraryCellTool";
import { useDieViewerStore, type ToolKind } from "../../state/dieViewer";
import { useFloorplanStore } from "../../state/floorplan";
import { usePreferences } from "../../state/preferences";
import { useSession, DEFAULT_METAL_STACK } from "../../state/session";
import { ToolDivider } from "../shell/SubBar";
import { AnnotationClassSelect } from "./AnnotationClassSelect";
import { BigToolDivider, Tool } from "./DieViewerUI";
import { ProcessFlipChip } from "./ProcessControls";
import { WireLayerSelect } from "./WireLayerSelect";
import { ANGLE_MODES, type AngleTool } from "../../lib/angleConstraint";
import { useAngleMode } from "../../state/angleMode";

/** One toolbar entry: either a real, selectable tool (`kind`) or a not-yet-
 *  built placeholder (`todo`) rendered disabled. */
type ToolItem =
  | { kind: ToolKind; icon: ReactNode; label: string }
  | { todo: true; icon: ReactNode; label: string };

interface ToolGroup {
  /** Lowercase tag rendered before the group (omit for the unlabeled
   *  navigation cluster). */
  label?: string;
  items: ToolItem[];
}

/** Ordered groups; a thin divider renders between groups. Cells come before
 *  vias so the related "draw a shape" tools cluster early in the bar. */
const TOOL_GROUPS: ToolGroup[] = [
  {
    items: [
      { kind: "select", icon: Ic.cursor, label: "Select / marquee" },
      { kind: "pan", icon: Ic.pan, label: "Pan / zoom — hold Space or middle-drag" }
    ]
  },
  {
    label: "wires",
    items: [
      { kind: "wire", icon: Ic.wire, label: "Draw wire" },
      { kind: "multiWire", icon: Ic.multiWire, label: "Draw multi-wire" }
    ]
  },
  {
    label: "cells",
    items: [
      { kind: "addCell", icon: Ic.cellRect, label: "Draw cell rectangle" },
      { kind: "cellGuideLine", icon: Ic.gridLine, label: "Draw cell-grid guide line" },
      { kind: "cellGuideSeg", icon: Ic.gridSeg, label: "Draw cell-grid guide segment" },
      { kind: "ioPoint", icon: Ic.ioPoint, label: "Place I/O point" },
      {
        kind: "libraryCell",
        icon: Ic.libraryCell,
        label: "Place library cell — fit another die's cell over one here; sets the die's scale"
      },
      {
        kind: "analogCell",
        icon: Ic.analogDevice,
        label: "Place analog device — its parameters live in the Lib tab of the right panel (I)"
      }
    ]
  },
  {
    label: "vias",
    items: [
      { kind: "via", icon: Ic.viaPoint, label: "Place via point" },
      { kind: "viaRect", icon: Ic.viaRect, label: "Draw via rectangle" },
      { kind: "viaPoly", icon: Ic.viaPolygon, label: "Draw via polygon" }
    ]
  },
  {
    label: "ml",
    items: [
      { kind: "roi", icon: Ic.roi, label: "Draw ML ROI rectangle" },
      { kind: "ignore", icon: Ic.mlIgnore, label: "Draw ML ignore rectangle" }
    ]
  },
  {
    label: "trace",
    items: [
      {
        kind: "traceRegionRect",
        icon: Ic.roi,
        label: "Vectorize trace region (rectangle) — traces render + materialize only inside region(s)"
      },
      {
        kind: "traceRegionPoly",
        icon: Ic.viaPolygon,
        label: "Vectorize trace region (polygon) — click vertices, Enter to commit"
      },
      {
        kind: "traceBlockage",
        icon: Ic.mlExclude,
        label: "Draw trace blockage — no traces render or materialize inside (wins over regions)"
      }
    ]
  },
  {
    label: "tools",
    items: [
      { kind: "measure", icon: Ic.ruler, label: "Ruler — drag to measure distance" },
      { kind: "comment", icon: Ic.comment, label: "Comment — click to add a comment pin" },
      { kind: "floorplan", icon: Ic.floorplan, label: "Floorplan — draw functional block outlines" }
    ]
  }
];

/**
 * The die-viewer's left/centre toolbar: grouped tool buttons, then (only when
 * the active tool actually has options) a stronger divider followed by that
 * tool's controls.
 *
 * Space saver: the "trace" group only appears while the right panel's Trace
 * tab is selected — its tools make no sense outside a vectorization context.
 */
export function DieToolbar({
  activeTool,
  setActiveTool,
  multiWireHint,
  libraryCell
}: {
  activeTool: ToolKind;
  setActiveTool: (tool: ToolKind) => void;
  /** Phase-aware help line for the multi-wire tool (kept short to save
   *  toolbar space; changes as the tool moves through its stages). */
  multiWireHint?: string;
  /** The "Place library cell" tool's state and controls. */
  libraryCell?: LibraryCellTool;
}) {
  const inspectorTab = usePreferences((s) => s.inspectorTab);
  const options = toolOptions(activeTool, multiWireHint, libraryCell);
  const groups = inspectorTab === "trace"
    ? TOOL_GROUPS
    : TOOL_GROUPS.filter((g) => g.label !== "trace");
  return (
    <>
      {groups.map((group, gi) => (
        <Fragment key={gi}>
          {gi > 0 && <ToolDivider />}
          {group.label && (
            <span
              className="u"
              style={{ fontSize: 10, color: "var(--ink3)", margin: "0 4px 0 2px" }}
            >
              {group.label}
            </span>
          )}
          {group.items.map((item, ii) =>
            "kind" in item ? (
              <Tool
                key={item.kind}
                icon={item.icon}
                label={item.label}
                // "f" is bound to "pan" in the registry but actually fits the
                // view; the pan label already explains Space / middle-drag.
                shortcut={item.kind === "pan" ? undefined : hotkeyFor(DIE_VIEWER_HOTKEYS, item.kind)}
                on={activeTool === item.kind}
                onClick={() => setActiveTool(item.kind)}
              />
            ) : (
              <Tool
                key={`todo-${gi}-${ii}`}
                icon={item.icon}
                label={item.label}
                todo
              />
            )
          )}
        </Fragment>
      ))}
      {options && (
        <>
          <BigToolDivider />
          {/* Takes the leftover width; overflow scrolls instead of pushing
              the bar wider than the window. The wire tool keeps its layer
              picker fixed and scrolls only the checkboxes after it. */}
          {activeTool === "wire" ? (
            <div className="row" style={{ alignItems: "center", gap: 10, flex: "1 1 auto", minWidth: 0, whiteSpace: "nowrap" }}>
              {options}
            </div>
          ) : (
            <ScrollRow>{options}</ScrollRow>
          )}
        </>
      )}
    </>
  );
}

/** The active tool's inline options, or null when it has none. Each tool's
 *  controls will grow here as later phases land. */
function toolOptions(
  tool: ToolKind,
  multiWireHint?: string,
  libraryCell?: LibraryCellTool
): ReactNode {
  if (tool === "libraryCell" && libraryCell) return <LibraryCellOptions tool={libraryCell} />;
  if (tool === "wire") return <WireOptions />;
  if (tool === "multiWire") return <WireOptions hint={multiWireHint} />;
  if (tool === "addCell") return <CellOptions />;
  if (tool === "via" || tool === "viaRect" || tool === "viaPoly") return <ViaOptions polygon={tool === "viaPoly"} />;
  if (tool === "roi") return <RoiOptions />;
  if (tool === "cellGuideLine") return <GuideLineOptions />;
  if (tool === "measure") return <MeasureOptions />;
  if (tool === "floorplan") return <FloorplanOptions />;
  // others (incl. cellGuideSeg) have no options.
  return null;
}

/** Angle mode chips (free / orthogonal / horizontal / vertical / diagonal)
 *  for one drawing tool; remembered per die. */
function AngleModeChips({ tool, shiftFree }: { tool: AngleTool; shiftFree?: boolean }) {
  const [mode, setMode] = useAngleMode(tool);
  return (
    <>
      <span className="u" style={{ fontSize: 10 }}>
        Angle
      </span>
      <span className="row" style={{ gap: 4 }}>
        {ANGLE_MODES.map(({ mode: m, label }) => (
          <button
            key={m}
            type="button"
            className={"chip" + (mode === m ? " on" : "")}
            style={{ cursor: "pointer" }}
            title={shiftFree && m !== "free" ? `${label} · hold Shift to place freely` : label}
            onClick={() => setMode(m)}
          >
            {label}
          </button>
        ))}
      </span>
    </>
  );
}

function MeasureOptions() {
  const showPx = useDieViewerStore((s) => s.showRulerPx);
  const showUm = useDieViewerStore((s) => s.showRulerUm);
  const showNm = useDieViewerStore((s) => s.showRulerNm);
  const setDisplay = useDieViewerStore((s) => s.setRulerDisplay);
  return (
    <>
      <AngleModeChips tool="measure" />
      <span className="row" style={{ gap: 6, marginLeft: 6 }}>
        <label className="check" title="Show source-pixel length">
          <input type="checkbox" checked={showPx} onChange={(e) => setDisplay({ showRulerPx: e.target.checked })} />
          px
        </label>
        <label className="check" title="Show micrometre length; values below 1 µm are shown in nm">
          <input type="checkbox" checked={showUm} onChange={(e) => setDisplay({ showRulerUm: e.target.checked })} />
          µm
        </label>
        <label className="check" title="Show nanometre length instead of µm">
          <input type="checkbox" checked={showNm} onChange={(e) => setDisplay({ showRulerNm: e.target.checked })} />
          nm
        </label>
      </span>
    </>
  );
}

const OPTION_SELECT_STYLE: React.CSSProperties = {
  maxWidth: 280,
  minWidth: 0,
  background: "var(--panel)",
  color: "var(--ink)",
  border: "1px solid var(--l1)",
  borderRadius: 4,
  padding: "2px 6px",
  fontSize: 11,
  fontFamily: "var(--mono)"
};

/** Pick a library cell (biggest first), turn / flip the template, accept. */
function LibraryCellOptions({ tool }: { tool: LibraryCellTool }) {
  const draft = useLiveValue(tool.draftLive);
  const hint = (text: string) => (
    <span className="m" style={{ fontSize: 10.5, color: "var(--ink3)", fontStyle: "italic" }}>
      {text}
    </span>
  );
  if (!tool.libraryName) {
    return hint("Set a cell library in the die properties first (Inspector, nothing selected)");
  }
  if (tool.types.length === 0) {
    return hint(`No matched cell types on the other dies of ${tool.libraryName} yet`);
  }
  const owners = new Set(tool.types.map((f) => f.ownerDieId));
  return (
    <>
      <span className="u" style={{ fontSize: 10 }}>
        Cell
      </span>
      <select
        value={tool.chosen?.type.id ?? ""}
        onChange={(e) => tool.choose(e.target.value || null)}
        style={OPTION_SELECT_STYLE}
      >
        <option value="">pick a library cell…</option>
        {tool.types.map((f) => (
          <option key={f.type.id} value={f.type.id} title={`from ${f.ownerName}`}>
            {f.type.name} · {Math.round(f.scaled.cropRect.width)}×{Math.round(f.scaled.cropRect.height)}
            {owners.size > 1 ? ` · ${f.ownerName}` : ""}
          </option>
        ))}
      </select>
      <span className="row" style={{ gap: 2 }}>
        <button
          type="button"
          className="btn ghost"
          disabled={!draft}
          title="Rotate 90° counter-clockwise"
          onClick={() => tool.orient("rotateCcw")}
        >
          {Ic.rotateCcw}
        </button>
        <button
          type="button"
          className="btn ghost"
          disabled={!draft}
          title="Rotate 90° clockwise"
          onClick={() => tool.orient("rotateCw")}
        >
          {Ic.rotateCw}
        </button>
        <button
          type="button"
          className="btn ghost"
          disabled={!draft}
          title="Flip horizontally"
          onClick={() => tool.orient("flipH")}
        >
          {Ic.flipH}
        </button>
        <button
          type="button"
          className="btn ghost"
          disabled={!draft}
          title="Flip vertically"
          onClick={() => tool.orient("flipV")}
        >
          {Ic.flipV}
        </button>
      </span>
      <label className="check" title="Show the cell's pixels (from its own die) under its annotations">
        <input
          type="checkbox"
          checked={tool.showImage}
          onChange={(e) => tool.setShowImage(e.target.checked)}
        />
        Image
      </label>
      {draft && (
        <span
          className="m"
          style={{ fontSize: 10.5, color: "var(--ink2)" }}
          title="This die's pixels per pixel of the cell's own die"
        >
          ×{draft.k.toFixed(4)}
        </span>
      )}
      <button
        type="button"
        className="btn accent"
        disabled={!draft || tool.busy}
        title="Place the cell here and set this die's scale from the fit (Enter)"
        onClick={() => void tool.accept()}
      >
        {Ic.check} Accept
      </button>
      {tool.error
        ? <span className="m" style={{ fontSize: 10.5, color: "var(--err)" }}>{tool.error}</span>
        : !draft && tool.chosen && hint("click the die to put the template there")}
    </>
  );
}

function GuideLineOptions() {
  const axis = useDieViewerStore((s) => s.guideAxis);
  const setAxis = useDieViewerStore((s) => s.setGuideAxis);
  return (
    <>
      <span className="u" style={{ fontSize: 10 }}>
        Orientation
      </span>
      <span className="row" style={{ gap: 4 }}>
        {(
          [
            ["x", "vertical"],
            ["y", "horizontal"]
          ] as const
        ).map(([a, label]) => (
          <button
            key={a}
            type="button"
            className={"chip" + (axis === a ? " on" : "")}
            style={{ cursor: "pointer" }}
            onClick={() => setAxis(a)}
          >
            {label}
          </button>
        ))}
      </span>
    </>
  );
}

function FloorplanOptions() {
  const toolMode = useFloorplanStore((s) => s.toolMode);
  const setToolMode = useFloorplanStore((s) => s.setToolMode);
  return (
    <>
      <span className="u" style={{ fontSize: 10 }}>
        Mode
      </span>
      <span className="row" style={{ gap: 4 }}>
        <button
          type="button"
          className={"chip" + (toolMode === "rect" || toolMode === "idle" ? " on" : "")}
          style={{ cursor: "pointer" }}
          onClick={() => setToolMode("rect")}
        >
          Rect
        </button>
        <button
          type="button"
          className={"chip" + (toolMode === "poly" ? " on" : "")}
          style={{ cursor: "pointer" }}
          title="Click to add vertices · Enter / double-click to finish · Esc to cancel"
          onClick={() => setToolMode("poly")}
        >
          Poly
        </button>
      </span>
      {toolMode === "poly" && <AngleModeChips tool="floorplan" shiftFree />}
    </>
  );
}

function RoiOptions() {
  const roiClasses = usePreferences((s) => s.roiClasses);
  const setRoiClasses = usePreferences((s) => s.setRoiClasses);
  return (
    <>
      <span className="u" style={{ fontSize: 10 }}>
        ROI labels
      </span>
      <AnnotationClassSelect value={roiClasses} onChange={setRoiClasses} />
    </>
  );
}

function WireOptions({ hint }: { hint?: string }) {
  const activeMetalId = useDieViewerStore((s) => s.activeMetalId);
  const setActiveMetalId = useDieViewerStore((s) => s.setActiveMetalId);
  const metals = (useSession((s) => s.metalStack) ?? DEFAULT_METAL_STACK).metals;
  const snapToVias = usePreferences((s) => s.snapToVias);
  const setSnapToVias = usePreferences((s) => s.setSnapToVias);
  const autoEndOnVia = usePreferences((s) => s.wireAutoEndOnVia);
  const setAutoEndOnVia = usePreferences((s) => s.setWireAutoEndOnVia);
  const autoEndOnContact = usePreferences((s) => s.autoEndOnContact);
  const setAutoEndOnContact = usePreferences((s) => s.setAutoEndOnContact);
  const autoVia = usePreferences((s) => s.autoViaEnabled);
  const setAutoVia = usePreferences((s) => s.setAutoViaEnabled);
  const viaPlaceMode = usePreferences((s) => s.viaPlaceMode);
  const setViaPlaceMode = usePreferences((s) => s.setViaPlaceMode);
  return (
    <>
      <AngleModeChips tool="wire" shiftFree />
      <span className="u" style={{ fontSize: 10 }}>
        Layer
      </span>
      <WireLayerSelect metals={metals} showHotkeys value={activeMetalId != null ? metals.find(m => m.id === activeMetalId)?.layer ?? null : null} onChange={(layer) => { const m = metals.find(m => m.layer === layer); setActiveMetalId(m?.id ?? null); }} />
      <ProcessFlipChip />
      <ScrollRow>
      <label
        className="check"
        title="Snap click positions to the nearest via (ML or manually placed)"
      >
        <input
          type="checkbox"
          checked={snapToVias}
          onChange={(e) => setSnapToVias(e.target.checked)}
        />
        Snap to vias
      </label>
      <label
        className="check"
        title="Snap the next point onto any via the projected wire passes through. Single wire keeps drafting from the via so you can chain more segments; multi-wire locks each wire on its own via and commits when all are locked."
      >
        <input
          type="checkbox"
          checked={autoEndOnVia}
          onChange={(e) => setAutoEndOnVia(e.target.checked)}
        />
        Auto-end on via
      </label>
      <label
        className="check"
        title="When clicking on a cell terminal (orange snap halo), commit the wire immediately instead of staying in edit mode."
      >
        <input
          type="checkbox"
          checked={autoEndOnContact}
          onChange={(e) => setAutoEndOnContact(e.target.checked)}
        />
        Auto-end on contact
      </label>
      <label
        className="check"
        title="When enabled, clicking a vertex on an adjacent metal auto-places the via and connects"
      >
        <input
          type="checkbox"
          checked={autoVia}
          onChange={(e) => setAutoVia(e.target.checked)}
        />
        AutoVia
      </label>
      <label
        className="check"
        title="E/Q via placement: at cursor position, or at the snapped end of the wire preview"
      >
        <input
          type="checkbox"
          checked={viaPlaceMode === "wire-end"}
          onChange={(e) => setViaPlaceMode(e.target.checked ? "wire-end" : "cursor")}
        />
        Via: {viaPlaceMode === "cursor" ? "cursor" : "wire-end"}
      </label>
      {hint && (
        <span
          className="m"
          style={{ fontSize: 10.5, color: "var(--ink3)", fontStyle: "italic" }}
        >
          {hint}
        </span>
      )}
      </ScrollRow>
    </>
  );
}

/**
 * Horizontally scrolling strip of tool options: shrinks to the space left in
 * the bar and scrolls (thin scrollbar, or the mouse wheel) when its controls
 * don't fit, e.g. the wire options on a 1920 px wide window.
 */
function ScrollRow({ children }: { children: ReactNode }) {
  return (
    <div
      className="row"
      style={{
        alignItems: "center",
        gap: 10,
        flex: "1 1 auto",
        minWidth: 0,
        overflowX: "auto",
        overflowY: "hidden",
        whiteSpace: "nowrap",
        scrollbarWidth: "thin"
      }}
      onWheel={(e) => {
        // The bar never scrolls vertically: let the wheel move it sideways.
        if (e.deltaY !== 0 && e.deltaX === 0) e.currentTarget.scrollLeft += e.deltaY;
      }}
    >
      {children}
    </div>
  );
}

function ViaOptions({ polygon }: { polygon?: boolean }) {
  const activeViaId = useDieViewerStore((s) => s.activeViaId);
  const setActiveViaId = useDieViewerStore((s) => s.setActiveViaId);
  const vias = (useSession((s) => s.metalStack) ?? DEFAULT_METAL_STACK).vias;
  return (
    <>
      <span className="u" style={{ fontSize: 10 }}>
        Via layer
      </span>
      <span className="row" style={{ gap: 4 }}>
        {vias.map((v, i) => (
          <button
            key={v.id}
            type="button"
            className={"chip" + (activeViaId === v.id ? " on" : "")}
            style={{ cursor: "pointer" }}
            title={withShortcut(v.id, i < 9 ? `Alt+${i + 1}` : undefined)}
            onClick={() => setActiveViaId(v.id)}
          >
            {v.id.toLowerCase()}
          </button>
        ))}
      </span>
      {activeViaId && (
        <span style={{ fontSize: 10, color: "var(--ink3)", marginLeft: 4 }}>
          O to cycle
        </span>
      )}
      {polygon && <AngleModeChips tool="viaPoly" shiftFree />}
    </>
  );
}

function CellOptions() {
  const snap = usePreferences((s) => s.cellSnapToGuides);
  const setSnap = usePreferences((s) => s.setCellSnapToGuides);
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={snap}
        onChange={(e) => setSnap(e.target.checked)}
      />
      Snap to guides
    </label>
  );
}

export function IssuesChip({
  errors = 0,
  warnings = 0,
  onClick,
}: {
  errors?: number;
  warnings?: number;
  onClick?: () => void;
}) {
  const tone = errors > 0 ? "err" : warnings > 0 ? "warn" : "";
  return onClick ? (
    <button
      className={"chip" + (tone ? ` ${tone}` : "")}
      title={`${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${
        warnings === 1 ? "" : "s"
      }`}
      onClick={onClick}
      style={{
        cursor: "pointer", border: 0, fontSize: "inherit", fontFamily: "inherit",
        background: tone === "err" ? "var(--err-bg, #3a1111)" : tone === "warn" ? "var(--warn-bg, #3a2a00)" : "var(--l1)",
        color: "inherit", padding: "0 6px", borderRadius: 3, height: 22,
      }}
    >
      {Ic.mlExclude}
      {errors} / {warnings}
    </button>
  ) : (
    <span
      className={"chip" + (tone ? ` ${tone}` : "")}
      title={`${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${
        warnings === 1 ? "" : "s"
      }`}
    >
      {Ic.mlExclude}
      {errors} / {warnings}
    </span>
  );
}
