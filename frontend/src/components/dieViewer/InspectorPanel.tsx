import { useState, useRef, useEffect, useMemo, type ReactNode } from "react";
import { cellInstanceScale, cellWorldRect } from "../../lib/cellFootprint";
import { padCountByPin, renamePinActions } from "../../lib/pinClipboard";
import { useDialog } from "../Dialog";
import { useToast } from "../Toast";
import { useQueryClient } from "@tanstack/react-query";
import type { AnalogDevice, AnnotationNet, AnnotationNetEdge, AssistantFinding, Cell, CellType, DieAnnotations, DieMetadata, FloorplanRegion, HumanAnnotation, MLInferenceJob, MLTracePolyline, VectorBlocksResponse, VectorizeParams, VectorizePreprocess, VectorSweepStatus, WireLayer } from "shared";
import { NEUTRAL_VECTOR_PREPROCESS } from "shared";
import type { ActionDispatcher } from "../../api/actions";
import type { CellLibraryView } from "../../lib/cellLibrary";
import { uuid } from "../../lib/uuid";
import {
  exportMlData,
  fetchVectorBlocks,
  fetchVectorLayerBlocks,
  getVectorSweep,
  mlJobKey,
  selectMLModel,
  startMLJob,
  startVectorSweep,
  stopMLJob,
  stopVectorSweep,
  useMLJob,
  useMLModels,
  useMLStatus
} from "../../api/ml";
import { parseNetPartId } from "../../lib/netGraph";
import { selectedVias, viaBaseColor, viaColorAction } from "../../lib/viaColor";
import { floorplanDisplayName, floorplanNameInline, normalizeFloorplanName } from "../../lib/floorplanName";
import { cellTypeColor, edgeColor, netColors, toHex, type NetColorPrefs } from "../../lib/colorHex";
import { WIRE_LAYER_COLOR } from "../../renderer/annotations/style";
import { Ic } from "../../icons";
import {
  isMlViaId,
  type MLViasLayer
} from "../../renderer/layers/MLViasLayer";
import type { VectorizeLayer } from "../../renderer/layers/VectorizeLayer";
import { buildNetsFromTraces, type TraceSnapTarget } from "./mlTracesToNets";
import { filterTracesByUserNets, filterTracesByRegions, collectUserNetPolylines, type UserNetPolyline, type TraceRegionLike } from "./userNetFilter";
import { useDieViewerStore } from "../../state/dieViewer";
import { usePreferences, selectNetWidth } from "../../state/preferences";
import { useSession, DEFAULT_METAL_STACK } from "../../state/session";
import { useOverlayLayers } from "../../state/overlayLayers";
import { WireLayerSelect } from "./WireLayerSelect";
import { AnnotationClassSelect } from "./AnnotationClassSelect";
import { CVPanel } from "./CVPanel";
import { AssistantPanel } from "./AssistantPanel";
import { McpPanel } from "./McpPanel";
import { CellDetectionPanel, ProposalInspector } from "./CellDetectionPanel";
import { DieProperties } from "./DieProperties";
import { AnalogLibPanel } from "./AnalogLibPanel";
import type { AnalogCellTool } from "./useAnalogCellTool";
import { isMlCellId, type Proposal } from "../../lib/cellDetection";

/** A single labelled property row (`.prop` matches the hifi spec). */
function Prop({
  label,
  children
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="prop">
      <span className="lbl">{label}</span>
      <span className="val" style={{ minWidth: 0 }}>
        {children}
      </span>
    </div>
  );
}

/** Sub-section header inside the inspector (e.g. the selected segment). */
function SubHeader({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "6px 12px",
        borderTop: "1px solid var(--l1)",
        borderBottom: "1px solid var(--l1)",
        background: "var(--panel)"
      }}
    >
      <span className="u">{children}</span>
    </div>
  );
}

/** Editable name field. Uncontrolled + keyed by uid so it resets when the
 *  selection changes; commits on blur / Enter, reverts on Escape.
 *  `multiline`: a textarea where Enter adds a line and Ctrl/Cmd+Enter commits. */
function NameField({
  uid,
  value,
  onCommit,
  multiline
}: {
  uid: string;
  value: string;
  onCommit: (next: string) => void;
  multiline?: boolean;
}) {
  const commit = (el: HTMLInputElement | HTMLTextAreaElement) => {
    const next = el.value.trim();
    if (!next || next === value) {
      el.value = value;
      return;
    }
    onCommit(next);
  };
  if (multiline) {
    return (
      <textarea
        // Re-keyed by value too, so a rename from the floorplan window shows here.
        key={`${uid}:${value}`}
        className="input"
        defaultValue={value}
        spellCheck={false}
        rows={Math.min(6, Math.max(2, value.split("\n").length))}
        title="Enter adds a line · Ctrl+Enter saves"
        style={{ flex: 1, width: "100%", boxSizing: "border-box", resize: "vertical", fontFamily: "inherit", lineHeight: 1.35 }}
        onBlur={(e) => commit(e.currentTarget)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            e.currentTarget.value = value;
            e.currentTarget.blur();
          }
        }}
      />
    );
  }
  return (
    <label className="input" style={{ flex: 1 }}>
      <input
        key={uid}
        defaultValue={value}
        spellCheck={false}
        onBlur={(e) => commit(e.currentTarget)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            e.currentTarget.value = value;
            e.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

const short = (id: string) => (id.length > 10 ? id.slice(0, 8) + "…" : id);

interface Resolved {
  typeLabel: string;
  displayName: string;
  uid: string;
  /** Present only when the entity carries an editable name. */
  name?: { value: string; onCommit: (next: string) => void; multiline?: boolean };
  /** Extra property rows shown after `uid` (text or interactive controls,
   *  e.g. the ROI class selector). */
  rows?: [string, ReactNode][];
  /** Net sub-part (segment / vertex) detail panel. Row values may be plain
   *  text or an interactive control (e.g. the segment layer selector). */
  sub?: { kind: string; id: string; rows: [string, ReactNode][] };
}

function resolve(
  id: string,
  ann: DieAnnotations,
  dispatcher: ActionDispatcher,
  mlViasLayer: MLViasLayer | null,
  library: CellLibraryView,
  cellTypeCounts?: Map<string, number>,
  onEditAnalogCell?: (cell: Cell, cellType: CellType) => void
): Resolved | null {
  // A type shared from another die of the cell library says whose it is.
  const ownerRow = (typeId: string): [string, ReactNode][] => {
    const f = library.foreign.get(typeId);
    return f ? [["from", `${f.ownerName} · ×${f.ratio.toFixed(3)}`]] : [];
  };
  // ── ML vias (synthetic position id; no persistent annotation) ──────
  // Checked first because the prefix is unambiguous and the layer lookup
  // is cheap — keeps `parseNetPartId` and the prefix switch focused on
  // the persisted-annotation paths below.
  if (isMlViaId(id)) {
    const v = mlViasLayer?.findViaById(id) ?? null;
    if (!v) {
      // Tile evicted (model switch / refetch) — keep the slot so the user
      // sees *something* and can deselect; we just don't have score/kind.
      return {
        typeLabel: "ML via",
        displayName: `ML via ${short(id)}`,
        uid: id,
        rows: [["status", "not in current cache"]]
      };
    }
    const typeLabel = v.kind === "point" ? "ML via point" : "ML via region";
    return {
      typeLabel,
      displayName: `${typeLabel} ${short(id)}`,
      uid: id,
      rows: [
        ["confidence", `${(v.score * 100).toFixed(1)}%`],
        ["position", `(${Math.round(v.x)}, ${Math.round(v.y)})`],
        ["source", "ML prediction"]
      ]
    };
  }

  // ── Nets (incl. a selected segment / vertex sub-part) ──────────────
  const net = parseNetPartId(id);
  if (net) {
    const n = ann.nets.find((x) => x.id === net.netId);
    if (!n) return null;
    const base: Resolved = {
      typeLabel: "Net",
      displayName: n.name || `Net ${short(n.id)}`,
      uid: n.id,
      rows: [["color", <NetColorField key="color" net={n} />]],
      name: {
        value: n.name ?? "",
        onCommit: (name) =>
          void dispatcher.dispatch({
            kind: "upsertNet",
            net: { ...n, name },
            prevNet: n
          })
      }
    };
    if (net.part === "edge" && net.partId) {
      const e = n.edges.find((x) => x.id === net.partId);
      const a = e && n.nodes.find((nd) => nd.id === e.from);
      const b = e && n.nodes.find((nd) => nd.id === e.to);
      if (e && a && b) {
        const len = Math.round(Math.hypot(b.x - a.x, b.y - a.y));
        const stack = useSession.getState().metalStack ?? DEFAULT_METAL_STACK;
        const setLayer = (layer: string | null) => {
          const edges = n.edges.map((x) => {
            if (x.id !== e.id) return x;
            if (layer) return { ...x, layer: layer as WireLayer };
            const { layer: _drop, ...rest } = x;
            return rest;
          });
          void dispatcher.dispatch({
            kind: "upsertNet",
            net: { ...n, edges },
            prevNet: n
          });
        };
        base.sub = {
          kind: "Segment",
          id: e.id,
          rows: [
            ["from", `(${Math.round(a.x)}, ${Math.round(a.y)})`],
            ["to", `(${Math.round(b.x)}, ${Math.round(b.y)})`],
            ["length", `${len} px`],
            ["color", <EdgeColorValue key="color" netId={n.id} edge={e} />],
            [
              "layer",
              <WireLayerSelect
                key="layer"
                metals={stack.metals}
                wrap
                value={e.layer ?? null}
                onChange={setLayer}
              />
            ]
          ]
        };
      }
    } else if (net.part === "node" && net.partId) {
      const nd = n.nodes.find((x) => x.id === net.partId);
      if (nd) {
        const deg = n.edges.filter(
          (e) => e.from === nd.id || e.to === nd.id
        ).length;
        base.sub = {
          kind: "Vertex",
          id: nd.id,
          rows: [
            ["position", `(${Math.round(nd.x)}, ${Math.round(nd.y)})`],
            ["edges", String(deg)]
          ]
        };
      }
    }
    return base;
  }

  const [prefix, eid] = splitId(id);
  switch (prefix) {
    case "cellType": {
      const ct = ann.cellTypes.find((x) => x.id === eid);
      if (!ct) return null;
      return {
        typeLabel: "Cell type",
        displayName: ct.name || `Cell type ${short(ct.id)}`,
        uid: ct.id,
        name: {
          value: ct.name ?? "",
          onCommit: (name) =>
            void dispatcher.dispatch({
              kind: "upsertCellType",
              cellType: { ...ct, name },
              prevCellType: ct
            })
        },
        rows: [["color", <CellColorField key="color" cellType={ct} dispatcher={dispatcher} />]]
      };
    }
    case "cell": {
      const c = ann.cells.find((x) => x.id === eid);
      if (!c) return null;
      const ct = ann.cellTypes.find((t) => t.id === c.cellTypeId);
      // Like net→segment: the cell *type* is the editable top-level entity;
      // the placed instance is a read-only sub-section underneath.
      const base: Resolved = ct
        ? {
            typeLabel: "Cell type",
            displayName: ct.name || `Cell type ${short(ct.id)}`,
            uid: ct.id,
            name: {
              value: ct.name ?? "",
              onCommit: (name) =>
                void dispatcher.dispatch({
                  kind: "upsertCellType",
                  cellType: { ...ct, name },
                  prevCellType: ct
                })
            },
            rows: [["color", <CellColorField key="color" cellType={ct} dispatcher={dispatcher} />], ...ownerRow(ct.id)]
          }
        : { typeLabel: "Cell", displayName: `Cell ${short(c.id)}`, uid: c.id };
      const rows: [string, ReactNode][] = [
        ["position", `(${Math.round(c.x)}, ${Math.round(c.y)})`]
      ];
      if (c.rotation) rows.push(["rotation", `${c.rotation}°`]);
      if (ct) {
        // The instance may be drawn at its own scale (see `Cell.scale`).
        const k = cellInstanceScale(c, ct, library.scale);
        // Die footprint (oriented); a resized cell differs from its type's box.
        const box = cellWorldRect(c, ct.cropRect.width * k, ct.cropRect.height * k);
        rows.push([
          "size",
          c.bounds
            ? `${box.width}×${box.height} (type ${ct.cropRect.width}×${ct.cropRect.height})`
            : `${box.width}×${box.height}`
        ]);
        const count = cellTypeCounts?.get(ct.id) ?? 1;
        rows.push(["relationship", count > 1 ? `Linked (×${count})` : "Unique"]);
        // A device laid out by the analog library: its parameters travel with
        // the cell type, so the user can see what it was generated from.
        const pcell = ct.pcell;
        if (pcell) {
          const p = pcell.params;
          rows.push(["device", p.kind === "mos" ? p.mosType.toUpperCase() : p.bjtType.toUpperCase()]);
          rows.push(["W × L", `${p.W_um} × ${p.L_um} µm`]);
          rows.push(["fingers", String(p.fingers)]);
          if (p.kind === "mos") rows.push(["bulk", p.bulk === "tap" ? "well tap" : "none"]);
          if (onEditAnalogCell) {
            rows.push([
              "edit",
              <button
                key="edit-device"
                type="button"
                className="btn ghost"
                title="Lay this device out again — change its parameters; hand-made layer edits are lost"
                onClick={() => onEditAnalogCell(c, ct)}
              >
                edit parameters
              </button>
            ]);
          }
        }
      }
      if (c.scale != null) {
        rows.push(["own scale", `${Number(c.scale.toFixed(4))} px / library unit`]);
      }
      rows.push(["flipped", c.flippedV ? "vertical" : "no"]);
      if (c.mlDetected) {
        rows.push(["ml status", "CV detected"]);
        if (c.mlConfidence != null) rows.push(["confidence", c.mlConfidence.toFixed(3)]);
      }
      base.sub = { kind: "Cell", id: c.id, rows };
      return base;
    }
    case "pin": {
      const p = ann.pins?.find((x) => x.id === eid);
      if (!p) return null;
      const pads = padCountByPin(ann.pins).get(p.pin) ?? 1;
      return {
        typeLabel: pads > 1 ? `I/O pin · ${pads} pads` : "I/O pin",
        displayName: p.name || `pin ${p.pin}`,
        uid: p.id,
        name: {
          value: p.name ?? "",
          // Every pad of this pin number (pasted copies) is renamed with it.
          onCommit: (name) => {
            const actions = renamePinActions(ann.pins, p.pin, name);
            if (actions.length > 0) void dispatcher.dispatch({ kind: "batch", actions });
          }
        }
      };
    }
    case "floorplan": {
      const f = ann.floorplanRegions?.find((x) => x.id === eid);
      if (!f) return null;
      const xs = f.geometry.map((p) => p.x);
      const ys = f.geometry.map((p) => p.y);
      const w = Math.round(Math.max(...xs) - Math.min(...xs));
      const h = Math.round(Math.max(...ys) - Math.min(...ys));
      const rows: [string, ReactNode][] = [
        ["shape", f.kind === "rect" ? "rectangle" : `polygon · ${f.geometry.length} pts`],
        ["position", `(${Math.round(Math.min(...xs))}, ${Math.round(Math.min(...ys))})`],
        ["size", `${w}×${h}`],
        [
          "color",
          <FloorplanColorField key="color" region={f} dispatcher={dispatcher} />
        ]
      ];
      if (f.createdByName) rows.push(["created by", f.createdByName]);
      if (f.reservedByName) rows.push(["reserved by", f.reservedByName]);
      return {
        typeLabel: "Floorplan",
        displayName: floorplanNameInline(floorplanDisplayName(f)) || `Floorplan ${short(f.id)}`,
        uid: f.id,
        name: {
          value: f.name ?? "",
          multiline: true,
          onCommit: (name) =>
            void dispatcher.dispatch({
              kind: "upsertFloorplan",
              region: { ...f, name: normalizeFloorplanName(name) },
              prevRegion: f
            })
        },
        rows
      };
    }
    case "anno": {
      const a = ann.annotations?.find((x) => x.id === eid);
      if (!a) return null;
      const g = a.geometry;
      const typeLabel = a.class === "point_via" ? "Via point" : "Via region";
      const geomRow: [string, ReactNode] =
        g.kind === "point"
          ? ["point", `(${Math.round(g.x)}, ${Math.round(g.y)})`]
          : g.kind === "rectangle"
            ? ["size", `${Math.round(g.width)}×${Math.round(g.height)}`]
            : ["points", `${g.points.length} pts`];
      return {
        typeLabel,
        displayName: `${typeLabel} ${short(a.id)}`,
        uid: a.id,
        rows: [
          ["class", a.class],
          geomRow,
          ...(a.layer ? [["via layer", a.layer] as [string, ReactNode]] : []),
          ["color", <ViaColorField key="color" vias={[a]} dispatcher={dispatcher} />]
        ]
      };
    }
    case "roi": {
      const r = ann.rois?.find((x) => x.id === eid);
      if (!r) return null;
      const classes = r.classes ?? [];
      return {
        typeLabel: "ML ROI",
        displayName: `ML ROI ${short(r.id)}`,
        uid: r.id,
        rows: [
          ["size", `${r.width}×${r.height}`],
          [
            "labels",
            <AnnotationClassSelect
              key="cls"
              value={classes}
              onChange={(next) =>
                void dispatcher.dispatch({
                  kind: "upsertRoi",
                  roi: { ...r, classes: next },
                  prevRoi: r
                })
              }
            />
          ]
        ]
      };
    }
    case "ignore": {
      const i = ann.ignores?.find((x) => x.id === eid);
      if (!i) return null;
      return {
        typeLabel: "Ignore region",
        displayName: `Ignore region ${short(i.id)}`,
        uid: i.id,
        rows: [["size", `${i.width}×${i.height}`]]
      };
    }
    default: {
      if (!eid) return null;
      const typeLabel = cap(prefix);
      return { typeLabel, displayName: `${typeLabel} ${short(eid)}`, uid: eid };
    }
  }
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function splitId(id: string): [string, string] {
  const i = id.indexOf(":");
  return i < 0 ? [id, ""] : [id.slice(0, i), id.slice(i + 1)];
}

/**
 * Right-side panel: tabbed Inspector / ML. The Inspector shows the selected
 * object's type + name in a common title bar, then its properties (name
 * editable where supported, uid read-only), with a sub-panel for a selected
 * net segment or vertex. ML is intentionally empty for now.
 */
export function InspectorPanel({
  annotations,
  dispatcher,
  dieId,
  die,
  library,
  mlViasLayer,
  vectorLayer,
  getTraceSnapTargets,
  cellTypeCounts,
  proposals = [],
  devices = [],
  netNames = new Map<number, string>(),
  warnings = [],
  floorplanRegions = [],
  onActivateAssistantFinding,
  onOpenAssistantNetlist,
  onEditAnalogCell,
  analogCell,
}: {
  annotations: DieAnnotations | undefined;
  dispatcher: ActionDispatcher;
  dieId: string;
  die: DieMetadata | undefined;
  /** The die's cell library (other dies' types it shares). */
  library: CellLibraryView;
  /** Live ML via layer — the inspector resolves `ml-via:` selection ids
   *  through it to fetch score / class. May be null while the page is still
   *  bootstrapping. */
  mlViasLayer: MLViasLayer | null;
  /** Live classical-vectorize overlay layer — the Vector section drives its
   *  params and materializes its traces. May be null while bootstrapping. */
  vectorLayer: VectorizeLayer | null;
  /** Wire-tool snap candidates (device contacts / cell terminals / IO pins)
   *  for the traces→nets materialization. Absent ⇒ the button is disabled. */
  getTraceSnapTargets?: () => TraceSnapTarget[];
  /** Visible ML cell proposals — resolves `ml-cell:` selection ids. */
  proposals?: Proposal[];
  /** cellTypeId → instance count for relationship display. */
  cellTypeCounts?: Map<string, number>;
  /** Current browser extraction projection; submitted read-only for analysis. */
  devices?: AnalogDevice[];
  netNames?: Map<number, string>;
  warnings?: string[];
  floorplanRegions?: FloorplanRegion[];
  onActivateAssistantFinding?: (finding: AssistantFinding | null) => void;
  onOpenAssistantNetlist?: (finding: AssistantFinding, view: "code" | "graph" | "schematic") => void;
  /** Load a placed analog-library device back into the placement tool, so
   *  it can be laid out again with other parameters. */
  onEditAnalogCell?: (cell: Cell, cellType: CellType) => void;
  /** The analog-library tool — its state and controls live in the "Lib" tab. */
  analogCell?: AnalogCellTool;
}) {
  const tab = usePreferences((s) => s.inspectorTab);
  const setTab = usePreferences((s) => s.setInspectorTab);
  const selectedIds = useDieViewerStore((s) => s.selectedIds);

  // Two rows: row 1 = the analysis tabs, row 2 = Trace + MCP. One row for
  // all seven labels overflowed the panel width and produced a stray
  // horizontal scrollbar. "Trace" holds the vector traces (no model) — the
  // recommended wire path; see the notice in the ML tab.
  const row1 = ["inspector", "ml", "cells", "cv", "ai", "lib"] as const;
  const row2 = ["trace", "mcp"] as const;
  const tabLabel = (k: (typeof row1)[number] | (typeof row2)[number]): string =>
    k === "inspector"
      ? "Inspector"
      : k === "ml"
        ? "ML"
        : k === "cells"
          ? "Cells"
          : k === "cv"
            ? "CV"
            : k === "lib"
              ? "Lib"
              : k === "ai"
                ? "AI"
                : k === "trace"
                  ? "Trace"
                  : "MCP";
  const tabTitle = (k: string): string | undefined =>
    k === "lib"
      ? "Analog library — lay a device out and place it (I)"
      : k === "trace"
        ? "Vector traces (no model) — classical wire extraction, the recommended path"
        : k === "ml"
          ? "ML inference — experimental wire/via detection, not fully validated"
          : undefined;

  const renderTabButton = (k: (typeof row1)[number] | (typeof row2)[number]) => (
    <button
      key={k}
      type="button"
      className={"tab" + (tab === k ? " on" : "")}
      style={{ background: "transparent", cursor: "pointer" }}
      onClick={() => setTab(k)}
      title={tabTitle(k)}
    >
      {tabLabel(k)}
    </button>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: "1 1 auto" }}>
      <div style={{ display: "flex", flexDirection: "column", flex: "0 0 auto" }}>
        <div className="ph" style={{ padding: 0, gap: 0, height: 28 }}>
          {row1.map(renderTabButton)}
        </div>
        <div className="ph" style={{ padding: 0, gap: 0, height: 28 }}>
          {row2.map(renderTabButton)}
        </div>
      </div>

      <div style={{ flex: "1 1 auto", overflow: "auto", minHeight: 0 }}>
        {tab === "ai" ? (
          <AssistantPanel
            dieId={dieId}
            annotations={annotations}
            devices={devices}
            netNames={netNames}
            warnings={warnings}
            floorplanRegions={floorplanRegions}
            onActivateFinding={onActivateAssistantFinding ?? (() => {})}
            onOpenNetlist={onOpenAssistantNetlist ?? (() => {})}
          />
        ) : tab === "ml" ? (
          <MLPanel
            dieId={dieId}
            annotations={annotations}
            dispatcher={dispatcher}
            die={die}
            mlViasLayer={mlViasLayer}
            getTraceSnapTargets={getTraceSnapTargets}
          />
        ) : tab === "trace" ? (
          <TracePanel
            dieId={dieId}
            annotations={annotations}
            dispatcher={dispatcher}
            die={die}
            vectorLayer={vectorLayer}
            getTraceSnapTargets={getTraceSnapTargets}
          />
        ) : tab === "cells" ? (
          <CellDetectionPanel dieId={dieId} annotations={annotations} library={library} />
        ) : tab === "lib" && analogCell ? (
          <AnalogLibPanel tool={analogCell} />
        ) : tab === "cv" ? (
          <CVPanel dieId={dieId} annotations={annotations} dispatcher={dispatcher} />
        ) : tab === "mcp" ? (
          <McpPanel dieId={dieId} />
        ) : (
          <InspectorBody
            annotations={annotations}
            dispatcher={dispatcher}
            dieId={dieId}
            die={die}
            library={library}
            ids={selectedIds}
            mlViasLayer={mlViasLayer}
            proposals={proposals}
            cellTypeCounts={cellTypeCounts}
            onEditAnalogCell={onEditAnalogCell}
          />
        )}
      </div>
    </div>
  );
}

function InspectorBody({
  annotations,
  dispatcher,
  dieId,
  die,
  library,
  ids,
  mlViasLayer,
  proposals,
  cellTypeCounts,
  onEditAnalogCell,
}: {
  annotations: DieAnnotations | undefined;
  dispatcher: ActionDispatcher;
  dieId: string;
  die: DieMetadata | undefined;
  library: CellLibraryView;
  ids: ReadonlySet<string>;
  mlViasLayer: MLViasLayer | null;
  proposals: Proposal[];
  cellTypeCounts?: Map<string, number>;
  onEditAnalogCell?: (cell: Cell, cellType: CellType) => void;
}) {
  // Nothing selected: the die itself.
  if (ids.size === 0)
    return <DieProperties die={die} library={library} umPerPx={annotations?.umPerPx} />;
  if (!annotations) return <Empty>loading…</Empty>;

  // A cell type selected from the outline tree comes with all of its placed
  // instances (so they highlight / delete together). Keep the type's
  // inspector up in that case and just report how many instances are in.
  let only: string;
  let extraRows: [string, ReactNode][] = [];
  if (ids.size > 1) {
    const typeIds = [...ids].filter((id) => id.startsWith("cellType:"));
    const typeId = typeIds.length === 1 ? typeIds[0] : null;
    const allOwnCells =
      typeId !== null &&
      [...ids].every((id) => {
        if (id === typeId) return true;
        if (!id.startsWith("cell:")) return false;
        const c = annotations.cells.find((x) => x.id === id.slice(5));
        return !!c && `cellType:${c.cellTypeId}` === typeId;
      });
    if (allOwnCells && typeId !== null) {
      only = typeId;
      extraRows = [["selected", `${ids.size - 1} instance${ids.size - 1 === 1 ? "" : "s"} — Delete removes them all`]];
    } else {
      const vias = selectedVias(annotations, ids);
      if (vias.length === 0) return <Empty>{ids.size} items selected</Empty>;
      return (
        <div>
          <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--l1)" }}>
            <div className="u">Selection</div>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--ink)", marginTop: 3, fontFamily: "var(--mono)" }}>
              {vias.length === ids.size ? `${vias.length} vias` : `${ids.size} items · ${vias.length} vias`}
            </div>
          </div>
          <Prop label={vias.length === ids.size ? "color" : "via color"}>
            <ViaColorField vias={vias} dispatcher={dispatcher} />
          </Prop>
        </div>
      );
    }
  } else {
    only = ids.values().next().value as string;
  }

  if (isMlCellId(only)) {
    return (
      <ProposalInspector
        dieId={dieId}
        id={only}
        dispatcher={dispatcher}
        proposals={proposals}
      />
    );
  }
  const r = resolve(only, annotations, dispatcher, mlViasLayer, library, cellTypeCounts, onEditAnalogCell);
  if (!r) return <Empty>Selection not found</Empty>;

  return (
    <div>
      <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--l1)" }}>
        <div className="u">{r.typeLabel}</div>
        <div
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: "var(--ink)",
            marginTop: 3,
            fontFamily: "var(--mono)",
            wordBreak: "break-word"
          }}
        >
          {r.displayName}
        </div>
      </div>

      {r.name && (
        <Prop label="name">
          <NameField uid={r.uid} value={r.name.value} onCommit={r.name.onCommit} multiline={r.name.multiline} />
        </Prop>
      )}
      <Prop label="uid">
        <span
          title={r.uid}
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: "var(--ink2)"
          }}
        >
          {r.uid}
        </span>
      </Prop>

      {[...(r.rows ?? []), ...extraRows].map(([label, value]) => (
        <Prop key={label} label={label}>
          {value}
        </Prop>
      ))}

      {r.sub && (
        <>
          <SubHeader>
            {r.sub.kind} · {short(r.sub.id)}
          </SubHeader>
          {r.sub.rows.map(([label, value]) => (
            <Prop key={label} label={label}>
              {value}
            </Prop>
          ))}
        </>
      )}
    </div>
  );
}

/**
 * The ML tab: an Inference section (model selection, the die-wide inference
 * job + its live progress, confidence threshold) and a Training section
 * (mask sizing + dataset export). Inference job state is shared via WS so
 * progress a teammate triggered shows here too.
 */
function MLPanel({
  dieId,
  annotations,
  dispatcher,
  die,
  mlViasLayer,
  getTraceSnapTargets
}: {
  dieId: string;
  annotations: DieAnnotations | undefined;
  dispatcher: ActionDispatcher;
  die: DieMetadata | undefined;
  mlViasLayer: MLViasLayer | null;
  getTraceSnapTargets?: () => TraceSnapTarget[];
}) {
  return (
    <div>
      <div
        style={{
          margin: "8px 10px 0",
          padding: "7px 9px",
          border: "1px solid var(--warn, #d9a441)",
          borderRadius: 4,
          background: "rgba(217, 164, 65, 0.08)",
          fontSize: 10,
          lineHeight: 1.5,
          color: "var(--ink2)"
        }}
      >
        <b style={{ color: "var(--warn, #d9a441)" }}>ML wire detection is experimental</b>{" "}
        — not fully implemented or validated yet. For metal traces use the{" "}
        <b>Trace</b> tab (Vector traces, no model): classical CV extraction
        with tunable parameters, no checkpoint required.
      </div>
      <MLSectionHeader>Inference</MLSectionHeader>
      <InferenceSection
        dieId={dieId}
        dispatcher={dispatcher}
        mlViasLayer={mlViasLayer}
        getTraceSnapTargets={getTraceSnapTargets}
      />
      <MLSectionHeader>ML Vias</MLSectionHeader>
      <ApproveSection dieId={dieId} annotations={annotations} dispatcher={dispatcher} mlViasLayer={mlViasLayer} />
      <MLSectionHeader>Training</MLSectionHeader>
      <TrainingSection dieId={dieId} />
    </div>
  );
}

/** The "Trace" tab: classical vector wire extraction (no model) — the
 *  recommended path for metal traces. The ML confidence slider is
 *  duplicated here on purpose: it is shared state (it also filters vector
 *  traces by their brightness margin), and the Trace tab should be
 *  self-contained. */
function TracePanel({
  dieId,
  annotations,
  dispatcher,
  die,
  vectorLayer,
  getTraceSnapTargets
}: {
  dieId: string;
  annotations: DieAnnotations | undefined;
  dispatcher: ActionDispatcher;
  die: DieMetadata | undefined;
  vectorLayer: VectorizeLayer | null;
  getTraceSnapTargets?: () => TraceSnapTarget[];
}) {
  return (
    <div>
      <VectorSection
        dieId={dieId}
        annotations={annotations}
        dispatcher={dispatcher}
        dieWidth={die?.width ?? 0}
        dieHeight={die?.height ?? 0}
        vectorLayer={vectorLayer}
        getTraceSnapTargets={getTraceSnapTargets}
      />
    </div>
  );
}

/** Approve ML vias — convert selected predictions to human annotations. */
function ApproveSection({
  annotations,
  dispatcher,
  mlViasLayer
}: {
  dieId: string;
  annotations: DieAnnotations | undefined;
  dispatcher: ActionDispatcher;
  mlViasLayer: MLViasLayer | null;
}) {
  const selectedIds = useDieViewerStore((s) => s.selectedIds);
  const mlViaIds = [...selectedIds].filter(isMlViaId);
  const count = mlViaIds.length;
  const vias = (useSession((s) => s.metalStack) ?? DEFAULT_METAL_STACK).vias;

  // Detect via layer from the first selected ML via
  const detectedLayer = count > 0 && mlViasLayer
    ? mlViasLayer.findViaById(mlViaIds[0])?.viaLayer
    : undefined;

  const [selectedViaId, setSelectedViaId] = useState<string | null>(
    detectedLayer && vias.some((v) => v.id === detectedLayer) ? detectedLayer : (vias[0]?.id ?? null)
  );

  // Reset selectedViaId when detectedLayer changes (new selection)
  // We use a ref to track the previous detectedLayer to avoid loop
  const prevDetectedRef = usePrevious(detectedLayer);
  if (detectedLayer !== prevDetectedRef && detectedLayer && vias.some((v) => v.id === detectedLayer)) {
    setSelectedViaId(detectedLayer);
  }

  const approveSelected = async () => {
    if (!mlViasLayer || !annotations || !selectedViaId) return;
    for (const id of mlViaIds) {
      const hit = mlViasLayer.findViaById(id);
      if (!hit) continue;
      void dispatcher.dispatch({
        kind: "upsertAnnotation",
        annotation: {
          id: uuid(),
          class: "point_via",
          geometry: { kind: "point", x: hit.x, y: hit.y },
          source: "approved",
          layer: selectedViaId,
        },
        prevAnnotation: null
      });
    }
  };

  if (count === 0) {
    return (
      <div style={{ padding: "12px" }}>
        <div
          className="m"
          style={{ fontSize: 10.5, color: "var(--ink3)", marginBottom: 10 }}
        >
          Select ML vias on the die to approve them as permanent annotations.
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: "12px" }}>
      <div
        className="m"
        style={{ fontSize: 10.5, color: "var(--ink3)", marginBottom: 10 }}
      >
        {count} ML via{count > 1 ? "s" : ""} selected.
        {detectedLayer && <span style={{ color: "var(--ink2)" }}> (detected: {detectedLayer})</span>}
      </div>

      {/* Via layer selector */}
      <div
        className="row"
        style={{ gap: 4, flexWrap: "wrap", marginBottom: 10 }}
      >
        <span className="u" style={{ fontSize: 10, minWidth: 40, alignSelf: "center" }}>
          Set as
        </span>
        {vias.map((v) => (
          <button
            key={v.id}
            type="button"
            className={"chip" + (selectedViaId === v.id ? " on" : "")}
            style={{
              cursor: "pointer",
              borderColor: v.color,
              ...(selectedViaId === v.id ? { background: v.color, color: "#000" } : {})
            }}
            onClick={() => setSelectedViaId(v.id)}
          >
            {v.id.toLowerCase()}
          </button>
        ))}
      </div>

      <button
        type="button"
        className="btn"
        style={{ width: "100%", cursor: "pointer" }}
        onClick={() => void approveSelected()}
      >
        Approve as {selectedViaId?.toLowerCase() ?? "via"} ({count})
      </button>
    </div>
  );
}

/** Returns the previous value of a variable across renders. */
function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T | undefined>(undefined);
  useEffect(() => { ref.current = value; });
  return ref.current;
}

function MLSectionHeader({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: "7px 12px",
        borderBottom: "1px solid var(--l1)",
        background: "var(--panel)"
      }}
    >
      <span className="u">{children}</span>
    </div>
  );
}

/** CV cell detection: select a reference cell, run contour matching, place results. */

const SELECT_STYLE: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: "var(--panel)",
  color: "var(--ink)",
  border: "1px solid var(--l1)",
  borderRadius: 4,
  padding: "3px 6px",
  fontSize: 11,
  fontFamily: "var(--mono)"
};

function jobStatusLine(job: MLInferenceJob | null | undefined): string {
  if (!job) return "—";
  const { status, completedTiles: done, totalTiles: total, percentage } = job;
  if (status === "running")
    return `Running · ${done}/${total} tiles (${percentage}%)`;
  if (status === "completed") return `Complete · ${total} tiles`;
  if (status === "failed")
    return `Failed${job.error ? ` · ${job.error}` : ""}`;
  if (done > 0)
    return `Stopped · ${done}/${total} tiles cached (${percentage}%)`;
  return `Idle · 0/${total} tiles`;
}

/** Model dropdown, start/stop, live job progress, confidence threshold. */
/**
 * Shared traces→nets materialization for both overlays (ML and vector):
 * snap → stitch → union → an undoable `batch` of `upsertNet`s. Returns
 * `null` when the user cancelled, `{ error }` when there's nothing to make.
 */
async function materializeTraces(
  traces: MLTracePolyline[],
  dispatcher: ActionDispatcher,
  snapTargets: TraceSnapTarget[],
  dialog: { confirm(message: string, title?: string): Promise<boolean> },
  outlines?: [number, number][][],
  userPolylines?: UserNetPolyline[],
  traceRegions?: TraceRegionLike[],
  traceBlockages?: { x: number; y: number; width: number; height: number }[]
): Promise<{ created: number } | { error: string } | null> {
  const prefs = usePreferences.getState();
  const rawTraceCount = traces.length;
  // P2-2: traces AND outlines outside every drawn trace region are dropped,
  // then anything inside a trace blockage (no regions = whole die). Blockage
  // wins over regions. Runs before the hand-drawn filter.
  const regionFilter =
    (traceRegions && traceRegions.length > 0) || (traceBlockages && traceBlockages.length > 0)
      ? filterTracesByRegions(traces, outlines ?? [], traceRegions ?? [], traceBlockages ?? [])
      : null;
  if (regionFilter) {
    traces = regionFilter.traces;
    outlines = regionFilter.outlines;
  }
  const droppedOutsideRegion = regionFilter?.droppedOutsideRegion ?? 0;
  const droppedInBlockage = regionFilter?.droppedInBlockage ?? 0;
  // P2-1: traces matching hand-drawn nets are dropped BEFORE materialization
  // (the decoder re-detects wires the user already drew). Skipped when no
  // hand-drawn nets exist or the toggle is off.
  const userFilter =
    userPolylines && userPolylines.length > 0 && prefs.vectorRespectUserNets
      ? filterTracesByUserNets(traces, userPolylines, outlines)
      : null;
  if (userFilter) traces = userFilter.traces;
  const respect = !!userFilter;
  const droppedUserNets = userFilter?.droppedUserNets ?? 0;
  const result = buildNetsFromTraces({
    traces,
    outlines,
    minScore: prefs.traceConfidenceThreshold,
    snapTargets,
    snapTol: Math.max(8, prefs.viaSize * 2),
    // Fragment-stitch distance tracks the Min-gap the user allows: fragments
    // the decode itself would bridge (relief breaks) — NOT a licence to glue
    // nearby wires. A hard 12 px used to stitch ends of ADJACENT buses.
    stitchTol: Math.max(6, 2 * Math.round(prefs.vectorParams.bridgePx) + 2),
    minDeviceContacts: prefs.vectorMinContacts,
    dropIrregular: prefs.vectorDropIrregular,
    maxBranchLen: prefs.vectorMaxBranchLen,
    layer: "metal1"
  });
  if (!result.nets.length) {
    const score = prefs.traceConfidenceThreshold;
    const reasons: string[] = [];
    if (droppedOutsideRegion > 0)
      reasons.push(`trace-region filter dropped ${droppedOutsideRegion} outside the drawn regions`);
    if (droppedInBlockage > 0)
      reasons.push(`trace-blockage filter dropped ${droppedInBlockage} inside the blockages`);
    if (respect && droppedUserNets > 0)
      reasons.push(`Respect hand-drawn nets dropped ${droppedUserNets} matching your drawn nets`);
    if (result.filteredByScore > 0)
      reasons.push(`score filter (${score.toFixed(2)}) dropped ${result.filteredByScore}`);
    if (result.droppedLowContacts > 0)
      reasons.push(`min contacts/net = ${prefs.vectorMinContacts} dropped ${result.droppedLowContacts}`);
    if (result.droppedIrregular > 0)
      reasons.push(`drop irregular dropped ${result.droppedIrregular}`);
    return {
      error:
        reasons.length > 0
          ? `no traces left: collected ${rawTraceCount}; ${reasons.join("; ")} — loosen the filters or re-decode`
          : `nothing to materialize (collected ${rawTraceCount}) — check width/min length and that the viewport is decoded`
    };
  }
  // Structured summary: result block + every drop counter on its own line
  // (0-counters omitted) + warnings last. Plain text for dialog.confirm.
  const dropLines: string[] = [];
    if (droppedOutsideRegion > 0) dropLines.push(`  outside trace regions:        ${droppedOutsideRegion}`);
    if (droppedInBlockage > 0) dropLines.push(`  inside trace blockages:      ${droppedInBlockage}`);
    if (droppedUserNets > 0) dropLines.push(`  matching hand-drawn nets:    ${droppedUserNets}`);
  if (result.filteredByScore > 0) dropLines.push(`  score filter:                ${result.filteredByScore}`);
  if (result.droppedLowContacts > 0) dropLines.push(`  low contacts (< ${prefs.vectorMinContacts}):      ${result.droppedLowContacts}`);
  if (result.droppedIrregular > 0) dropLines.push(`  irregular (non-octilinear):  ${result.droppedIrregular}`);
  if (result.outlineDropped > 0) dropLines.push(`  branch len > Max branch len: ${result.outlineDropped}`);
  if (result.droppedTwins > 0) dropLines.push(`  skeleton duplicates:         ${result.droppedTwins}`);
  if (result.droppedDegenerate > 0) dropLines.push(`  degenerate:                  ${result.droppedDegenerate}`);
  const msg =
    `Create ${result.nets.length} nets from ${rawTraceCount} traces?\n` +
    `\nAttachments\n` +
    `  ends snapped to contacts:    ${result.snappedEnds}\n` +
    `  gaps stitched:               ${result.stitchedPairs}\n` +
    (result.outlineConnected > 0
      ? `  joined via metal outline:    ${result.outlineConnected}\n`
      : "") +
    (dropLines.length > 0
      ? `\nDropped traces\n${dropLines.join("\n")}\n`
      : "") +
    `\nThe action goes to Undo.` +
    (result.warnings.length
      ? `\n\nWarnings:\n${result.warnings.join("\n").split("\n").map((w) => `  ${w}`).join("\n")}`
      : "");
  if (!(await dialog.confirm(msg, "Vector → nets"))) return null;
  await dispatcher.dispatch({
    kind: "batch",
    actions: result.nets.map((net) => ({ kind: "upsertNet", net, prevNet: null }))
  });
  return { created: result.nets.length };
}

function InferenceSection({
  dieId,
  dispatcher,
  mlViasLayer,
  getTraceSnapTargets
}: {
  dieId: string;
  dispatcher: ActionDispatcher;
  mlViasLayer: MLViasLayer | null;
  getTraceSnapTargets?: () => TraceSnapTarget[];
}) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const models = useMLModels();
  const status = useMLStatus();
  const job = useMLJob(dieId);
  const confidence = usePreferences((s) => s.viaConfidenceThreshold);
  const setConfidence = usePreferences((s) => s.setViaConfidenceThreshold);
  const [busy, setBusy] = useState<null | "model" | "job" | "traces">(null);
  const [err, setErr] = useState<string | null>(null);

  const modelList = models.data?.models ?? [];
  const residentName =
    modelList.find((m) => m.resident)?.name ?? status.data?.checkpoint ?? "";
  const running = job.data?.status === "running";
  const sidecarDown = status.data?.reachable === false;

  const switchModel = async (name: string) => {
    if (!name || name === residentName) return;
    if (
      !await dialog.confirm(
        "Switching the model clears every cached inference result for all " +
          "dies — you'll need to re-run inference. Continue?"
      )
    )
      return;
    setBusy("model");
    setErr(null);
    try {
      await selectMLModel(name);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["mlModels"] }),
        qc.invalidateQueries({ queryKey: ["mlStatus"] }),
        qc.invalidateQueries({ queryKey: mlJobKey(dieId) })
      ]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "model switch failed");
    } finally {
      setBusy(null);
    }
  };

  const overlayLayers = useOverlayLayers((s) => s.layers);
  const visibleOverlay = overlayLayers.find((l) => !l.hidden && l.loaded);
  const overlayName = visibleOverlay?.serverFilename ?? visibleOverlay?.name ?? null;

  const toggleJob = async () => {
    setBusy("job");
    setErr(null);
    try {
      const next = running ? await stopMLJob(dieId) : await startMLJob(dieId, overlayName ?? undefined);
      qc.setQueryData(mlJobKey(dieId), next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "inference job failed");
    } finally {
      setBusy(null);
    }
  };

  const pct = job.data?.percentage ?? 0;

  return (
    <div style={{ padding: "12px" }}>
      {/* Model selection */}
      <div
        className="row"
        style={{ gap: 8, alignItems: "center", marginBottom: 10 }}
      >
        <span className="u" style={{ fontSize: 10, minWidth: 38 }}>
          Model
        </span>
        <select
          value={modelList.length > 0 ? residentName : ""}
          disabled={busy !== null || running || modelList.length === 0}
          onChange={(e) => void switchModel(e.target.value)}
          style={SELECT_STYLE}
        >
          {modelList.length === 0 && (
            <option value="">
              {sidecarDown ? "sidecar offline" : "no models"}
            </option>
          )}
          {modelList.map((m) => (
            <option key={m.name} value={m.name}>
              {m.name}
            </option>
          ))}
        </select>
      </div>

      {/* Source badge */}
      <div
        className="row"
        style={{ gap: 8, alignItems: "center", marginBottom: 8, fontSize: 10, color: "var(--ink3)" }}
      >
        <span className="u" style={{ fontSize: 10 }}>
          Source
        </span>
        <span className="m">
          {overlayName ? `overlay: ${overlayName}` : "base image"}
        </span>
      </div>

      {/* Start / stop */}
      <button
        type="button"
        className="btn"
        style={{ width: "100%", cursor: "pointer" }}
        disabled={busy !== null || sidecarDown}
        onClick={() => void toggleJob()}
      >
        {busy === "job"
          ? "…"
          : running
            ? "Stop inference"
            : "Start inference"}
      </button>

      {/* Job status + progress */}
      <div
        className="m"
        style={{ fontSize: 10.5, color: "var(--ink2)", margin: "8px 0 6px" }}
      >
        {jobStatusLine(job.data)}
      </div>
      <div
        style={{
          height: 5,
          borderRadius: 3,
          background: "var(--l1)",
          overflow: "hidden"
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${Math.min(100, Math.max(0, pct))}%`,
            background: "var(--accent, #7fb2ff)",
            transition: "width 0.2s"
          }}
        />
      </div>

      {err && (
        <div
          className="m"
          style={{
            marginTop: 8,
            fontSize: 10.5,
            color: "var(--danger, #e36854)",
            wordBreak: "break-word"
          }}
        >
          {err}
        </div>
      )}

      <div style={{ borderTop: "1px solid var(--l1)", margin: "14px 0 12px" }} />

      {/* Confidence threshold */}
      <div
        className="row"
        style={{ justifyContent: "space-between", marginBottom: 4 }}
      >
        <span className="u" style={{ fontSize: 10 }}>
          Confidence threshold
        </span>
        <span className="m" style={{ fontSize: 11, color: "var(--ink2)" }}>
          {confidence.toFixed(2)}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={confidence}
        style={{ width: "100%" }}
        onChange={(e) => setConfidence(Number(e.target.value))}
      />
      <div
        className="m"
        style={{ fontSize: 10, color: "var(--ink3)", marginTop: 4 }}
      >
        Filters ML vias below this model confidence.
      </div>

      {/* Traces → nets materialization */}
      <button
        type="button"
        className="btn"
        style={{ width: "100%", marginTop: 12 }}
        disabled={busy !== null || !mlViasLayer || !getTraceSnapTargets}
        title="Materialize decoded trace centrelines into real annotation nets (ends snapped to device contacts / terminals / pins). Undoable."
        onClick={async () => {
          if (!mlViasLayer || !getTraceSnapTargets) return;
          setErr(null);
          setBusy("traces");
          try {
            const traces = mlViasLayer.collectTraces();
            const outcome = await materializeTraces(
              traces,
              dispatcher,
              getTraceSnapTargets(),
              dialog
            );
            if (outcome && "error" in outcome) setErr(outcome.error);
          } catch (e) {
            setErr(e instanceof Error ? e.message : "traces → nets failed");
          } finally {
            setBusy(null);
          }
        }}
      >
        {busy === "traces" ? "Creating nets…" : "Traces → nets"}
      </button>
    </div>
  );
}

/** One labelled range slider row for the vectorize param panel. */
function VSlider({
  label,
  value,
  min,
  max,
  step = 1,
  format,
  title,
  onChange
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
  /** Extended tooltip on the label + slider (longer explanations move
   *  here instead of a visible hint paragraph). */
  title?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div title={title}>
      <div
        className="row"
        style={{ justifyContent: "space-between", marginBottom: 2, marginTop: 8 }}
      >
        <span className="u" style={{ fontSize: 10 }}>
          {label}
        </span>
        <span className="m" style={{ fontSize: 11, color: "var(--ink2)" }}>
          {format ? format(value) : value}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ width: "100%" }}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

/** Decode-phase progress labels (the worker's stage names → readable text). */
const DECODE_STAGE_LABEL: Record<string, string> = {
  queued: "starting",
  read: "reading mask",
  widthmap: "width map",
  skeletonize: "skeleton",
  graph: "wire graph",
  runs: "extracting traces",
  outlines: "metal outlines",
  write: "saving result"
};

/** mm:ss (or h:mm:ss) for the decode elapsed / ETA readout. */
function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

/**
 * Classical (no-model) metal vectorization: threshold a brightness/colour
 * channel of the visible image, decode skeleton traces + mask outlines, and
 * materialize them into nets — no training, no checkpoint. Params are
 * user-tunable (live refetch, debounced) and persist as named presets.
 */
function VectorSection({
  dieId,
  annotations,
  dispatcher,
  dieWidth,
  dieHeight,
  vectorLayer,
  getTraceSnapTargets
}: {
  dieId: string;
  annotations: DieAnnotations | undefined;
  dispatcher: ActionDispatcher;
  /** Die size in source px — the whole-die nets source fetches the cached
   *  sweep payload for [0, 0, dieWidth, dieHeight]. */
  dieWidth: number;
  dieHeight: number;
  vectorLayer: VectorizeLayer | null;
  getTraceSnapTargets?: () => TraceSnapTarget[];
}) {
  // µm calibration: when the die has umPerPx, physical sliders (min wire
  // gap, length, width) are shown in µm and converted to source px for the
  // params — the decoder and presets stay px-based.
  const umPerPx = annotations?.umPerPx ?? 0;
  const fmtUm = (um: number) =>
    um >= Math.max(0.1, umPerPx / 2)
      ? `${(Math.round(um * 100) / 100).toFixed(2)} µm`
      : "off";
  const dialog = useDialog();
  const toast = useToast();
  const params = usePreferences((s) => s.vectorParams);
  const patch = usePreferences((s) => s.patchVectorParams);
  // P2-3: pre-threshold conditioning (neutral unless the user opens a knob).
  // Old persisted presets may lack the subobject — fall back to neutral.
  const pp = params.preprocess ?? NEUTRAL_VECTOR_PREPROCESS;
  const patchPP = (partial: Partial<VectorizePreprocess>) =>
    patch({ preprocess: { ...pp, ...partial } });
  const preprocessActive = !(
    pp.brightness === 0 &&
    pp.contrast === 1 &&
    pp.gamma === 1 &&
    pp.shadows === 0 &&
    pp.highlights === 0 &&
    pp.claheClip <= 0 &&
    pp.sharpenAmount <= 0 &&
    pp.denoiseMedian <= 0
  );
  // P2-3: blit the preprocessed viewport crop under the overlay while tuning.
  // A PREFERENCE (persisted) — the transient store flag used to silently
  // reset itself to OFF on every page reload / app restart.
  const preprocessPreview = usePreferences((s) => s.vectorPreprocessPreview);
  const setPreprocessPreview = usePreferences((s) => s.setVectorPreprocessPreview);
  const resetParams = usePreferences((s) => s.resetVectorParams);
  const presets = usePreferences((s) => s.vectorPresets);
  const savePreset = usePreferences((s) => s.saveVectorPreset);
  const deletePreset = usePreferences((s) => s.deleteVectorPreset);
  const hidden = usePreferences((s) => s.vectorOverlayHidden);
  const setHidden = usePreferences((s) => s.setVectorOverlayHidden);
  const outlineAlpha = usePreferences((s) => s.vectorOutlineAlpha);
  const setOutlineAlpha = usePreferences((s) => s.setVectorOutlineAlpha);
  const status = useDieViewerStore((s) => s.vectorStatus);
  const previewStatus = status.preview;
  const pipetteArmed = useDieViewerStore((s) => s.vectorPipetteArmed);
  const setPipetteArmed = useDieViewerStore((s) => s.setVectorPipetteArmed);
  const samples = useDieViewerStore((s) => s.vectorSamples);
  const clearSamples = useDieViewerStore((s) => s.clearVectorSamples);
  const [busy, setBusy] = useState<null | "nets">(null);
  const [err, setErr] = useState<string | null>(null);
  const [tol, setTol] = useState(25);
  const scoreFilter = usePreferences((s) => s.traceConfidenceThreshold);
  // Materialization filters (netlist side, not decode params — no cache
  // impact): min device contacts per net + irregular-trace drop.
  const minContacts = usePreferences((s) => s.vectorMinContacts);
  const setMinContacts = usePreferences((s) => s.setVectorMinContacts);
  const dropIrregular = usePreferences((s) => s.vectorDropIrregular);
  const setDropIrregular = usePreferences((s) => s.setVectorDropIrregular);
  const maxBranchLen = usePreferences((s) => s.vectorMaxBranchLen);
  const setMaxBranchLen = usePreferences((s) => s.setVectorMaxBranchLen);
  // P2-1: skip decoder traces duplicating hand-drawn nets.
  const respectUserNets = usePreferences((s) => s.vectorRespectUserNets);
  const setRespectUserNets = usePreferences((s) => s.setVectorRespectUserNets);
  // The buffer around a hand-drawn wire uses the effective net stroke width
  // (global or per-die) so matching mirrors what the user actually sees.
  const netWidth = usePreferences(selectNetWidth(dieId));
  const userNetPolylines = useMemo(
    () => (respectUserNets ? collectUserNetPolylines(annotations, netWidth) : []),
    [respectUserNets, annotations, netWidth]
  );
  // P2-2: the die's drawn trace regions restrict what materializes, and
  // blockages cut holes out of them (persisted in the annotations blob).
  const traceRegions = useMemo(
    () => annotations?.traceRegions ?? [],
    [annotations]
  );
  const traceBlockages = useMemo(
    () => annotations?.traceBlockages ?? [],
    [annotations]
  );
  // Where the Vector → nets traces come from: the cached whole-die sweep
  // payload (default — the point of the sweep) or the live viewport decodes.
  const [netsSource, setNetsSource] = useState<"whole-die" | "preview">("whole-die");
  // Which saved whole-die run to materialize: the CURRENT params (auto) or a
  // specific saved layer from the Vector Layers list (old runs keep working
  // even after the params changed).
  const savedLayers = useDieViewerStore((s) => s.savedVectorLayers);
  const [layerHash, setLayerHash] = useState<string>("auto");
  const [sweep, setSweep] = useState<VectorSweepStatus>({
    dieId: "",
    status: "idle",
    done: 0,
    total: 0
  });
  const presetNames = Object.keys(presets).sort();

  // Poll the sweep while it runs; refresh the layer's cache when it ends.
  // A dead backend must NOT hold the overlay hostage: after 3 consecutive
  // status polls fail, settle local state to "failed" and release the
  // sweep-running flag (the user restarts the app and the job map is empty).
  useEffect(() => {
    useDieViewerStore.getState().setVectorSweepRunning(sweep.status === "running");
    if (sweep.status !== "running") return;
    let failures = 0;
    const t = setInterval(() => {
      getVectorSweep(dieId)
        .then((s) => {
          failures = 0;
          const wasRunning = sweep.status === "running";
          setSweep(s);
          if (s.status !== "running") {
            useDieViewerStore.getState().setVectorSweepRunning(false);
            vectorLayer?.clearCache();
            useDieViewerStore.getState().bumpSavedVectorLayers();
            // "Notify when it's done": the whole-die decode takes minutes
            // with the user working elsewhere — celebrate the finish.
            if (wasRunning && s.status === "completed") {
              toast.success(
                "Whole-die decode finished",
                `${s.done}/${s.total} blocks decoded — overlay + Vector Layers updated`
              );
            } else if (wasRunning && s.status === "failed") {
              toast.error("Whole-die decode failed", s.error ?? undefined);
            }
          }
        })
        .catch(() => {
          failures += 1;
          if (failures >= 3) {
            failures = 0;
            setSweep((prev) => ({
              ...prev,
              status: prev.status === "running" ? "failed" : prev.status,
              error: "backend unreachable — job status unknown (restart the app to clear the sweep)"
            }));
            useDieViewerStore.getState().setVectorSweepRunning(false);
          }
        });
    }, 1000);
    return () => clearInterval(t);
  }, [sweep.status, dieId, vectorLayer]);

  // Also fetch the job once on mount — a sweep started elsewhere (or before
  // a reload) shows its progress here and pauses the live overlay.
  useEffect(() => {
    let gone = false;
    getVectorSweep(dieId)
      .then((s) => {
        if (gone) return;
        setSweep(s);
        useDieViewerStore.getState().setVectorSweepRunning(s.status === "running");
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [dieId]);

  const startSweep = async () => {
    setErr(null);
    try {
      const layers = useOverlayLayers.getState().layers;
      const visible = layers.find((l) => !l.hidden && l.loaded);
      const overlaySource = visible?.serverFilename ?? visible?.name ?? undefined;
      const s = await startVectorSweep(dieId, params, overlaySource);
      setSweep(s);
      useDieViewerStore.getState().setVectorSweepRunning(s.status === "running");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "sweep start failed");
    }
  };

  const stopSweep = async () => {
    try {
      const s = await stopVectorSweep(dieId);
      setSweep(s);
      if (s.status !== "running") useDieViewerStore.getState().setVectorSweepRunning(false);
    } catch {
      /* poll will settle the state */
    }
  };

  // Pipette maths: channel value + mean RGB of the accumulated samples.
  // Gray matches the decoder's Rec.601 luma; a raw channel reads its own
  // plane. The RGB triple also feeds the mean colour swatch.
  const pipetteMean = (() => {
    if (samples.length === 0) return null;
    let r = 0;
    let g = 0;
    let b = 0;
    for (const s of samples) {
      r += s.rgb[0];
      g += s.rgb[1];
      b += s.rgb[2];
    }
    r /= samples.length;
    g /= samples.length;
    b /= samples.length;
    const v =
      params.channel === "r"
        ? r
        : params.channel === "g"
          ? g
          : params.channel === "b"
            ? b
            : 0.299 * r + 0.587 * g + 0.114 * b;
    return { r, g, b, v };
  })();
  const vOfMean = pipetteMean?.v ?? -1;
  const meanSwatch =
    pipetteMean &&
    `rgb(${Math.round(pipetteMean.r)}, ${Math.round(pipetteMean.g)}, ${Math.round(pipetteMean.b)})`;

  const saveAsPreset = async () => {
    const name = await dialog.prompt(
      "Preset name (e.g. “LM2937 SEM”, “optical metal”):",
      "",
      "Save vector preset"
    );
    if (!name?.trim()) return;
    savePreset(name.trim(), params);
  };

  const vectorToNets = async () => {
    if (!vectorLayer || !getTraceSnapTargets) return;
    setErr(null);
    setBusy("nets");
    try {
      let traces: MLTracePolyline[];
      let outlines: [number, number][][] | undefined;
      if (netsSource === "whole-die") {
        // Whole-die path: either the cached sweep payload for the CURRENT
        // params, or a SPECIFIC saved run picked in the selector (old runs
        // keep working even after the params changed).
        if (!dieWidth || !dieHeight) throw new Error("die size unknown");
        let resp: VectorBlocksResponse;
        if (layerHash !== "auto") {
          resp = await fetchVectorLayerBlocks(dieId, layerHash, [0, 0, dieWidth, dieHeight]);
          if (!resp.blocks.length || resp.missing > 0) {
            throw new Error(`saved run ${layerHash} has no payload on disk (deleted?)`);
          }
        } else {
          const layers = useOverlayLayers.getState().layers;
          const visible = layers.find((l) => !l.hidden && l.loaded);
          const overlaySource = visible?.serverFilename ?? visible?.name ?? undefined;
          resp = await fetchVectorBlocks(
            dieId,
            [0, 0, dieWidth, dieHeight],
            usePreferences.getState().vectorParams,
            overlaySource
          );
          if (!resp.blocks.length || resp.missing > 0) {
            throw new Error(
              "whole-die payload not found for the current params — run «Decode whole die» or pick a saved run below"
            );
          }
        }
        // Namespace the payload's group ids (they restart at 0) so they
        // can't collide inside one materialize call.
        traces = resp.blocks
          .flatMap((b) => b.traces)
          .map((t) =>
            typeof t.group === "number" ? { ...t, group: 1_000_000 + t.group } : t
          );
        outlines = resp.blocks.flatMap((b) => b.outlines);
      } else {
        traces = vectorLayer.collectTraces();
        outlines = vectorLayer.collectOutlines();
      }
      const outcome = await materializeTraces(
        traces,
        dispatcher,
        getTraceSnapTargets(),
        dialog,
        outlines,
        userNetPolylines,
        traceRegions,
        traceBlockages
      );
      if (outcome && "error" in outcome) setErr(outcome.error);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "vector → nets failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ padding: "12px" }}>
      <div
        className="m"
        style={{ fontSize: 10.5, color: "var(--ink3)", marginBottom: 8 }}
      >
        Live threshold vectorization of the visible image — no model needed.
        Tune until metal is solid and noise minimal, then materialize.
      </div>

      {/* Overlay visibility */}
      <button
        type="button"
        className="btn"
        style={{ width: "100%", cursor: "pointer" }}
        onClick={() => setHidden(!hidden)}
      >
        {hidden ? "Show vector overlay" : "Hide vector overlay"}
      </button>

      {/* Live status — ALWAYS visible, incl. the preview lifecycle: a dead
          preview must never be silent mystery #2 (the error text lives at
          the top-level line, not only in the collapsed section). */}
      <div
        className="m"
        style={{ fontSize: 10.5, color: "var(--ink2)", margin: "8px 0 4px" }}
      >
        {hidden
          ? "overlay hidden"
          : status.loading
            ? "decoding…"
            : status.error
              ? `error: ${status.error}`
              : `${status.traces} trace(s) decoded` +
                (status.droppedWidth ? ` · width-filtered: ${status.droppedWidth}` : "") +
                (status.irregular ? ` · irregular: ${status.irregular}` : "")}
        {preprocessPreview && status.preview && (
          <span
            style={{
              color:
                status.preview.state === "fail"
                  ? "var(--danger, #e36854)"
                  : "var(--ink3)"
            }}
          >
            {" · preview "}
            {status.preview.state === "fail"
              ? `failed ×${status.preview.failures} — ${status.preview.error ?? "unknown"}`
              : status.preview.state}
          </span>
        )}
      </div>
      {scoreFilter > 0 && (
        <div className="m" style={{ fontSize: 10, color: "var(--warn, #d9a441)", marginBottom: 4 }}>
          Trace confidence = {scoreFilter.toFixed(2)} also filters these
          traces (brightness margin) — outlines show everything, traces don't.
        </div>
      )}

      {/* Outline opacity: the amber "what did the threshold capture"
          contours are the tuning feedback — sometimes they need to be near
          opaque to read against a busy die. Traces keep their style. */}
      <div
        className="row"
        style={{ justifyContent: "space-between", marginBottom: 4, marginTop: 6 }}
      >
        <span className="u" style={{ fontSize: 10 }}>
          Outline opacity
        </span>
        <span className="m" style={{ fontSize: 11, color: "var(--ink2)" }}>
          {Math.round(outlineAlpha * 100)}%
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={outlineAlpha}
        style={{ width: "100%" }}
        onChange={(e) => setOutlineAlpha(Number(e.target.value))}
      />
      <div
        className="m"
        style={{ fontSize: 10, color: "var(--ink3)", marginTop: 4, marginBottom: 6 }}
      >
        Transparency of the metal OUTLINES (both live and saved layers). 100%
        = solid amber silhouette of the captured metal; centrelines are
        unaffected.
      </div>

      {/* Channel + polarity */}
      <div
        className="row"
        style={{ gap: 8, alignItems: "center", marginBottom: 6, marginTop: 4 }}
      >
        <span className="u" style={{ fontSize: 10, minWidth: 44 }}>
          Channel
        </span>
        <select
          value={params.channel}
          disabled={hidden}
          onChange={(e) => patch({ channel: e.target.value as VectorizeParams["channel"] })}
          style={{ flex: 1, minWidth: 0 }}
          title="brightness = pixel luma (SEM / monochrome shots); R/G/B = raw colour planes (optical shots). Pipette samples keep RGB — switching the channel needs no re-sampling."
        >
          <option value="gray">brightness (luma)</option>
          <option value="r">R plane</option>
          <option value="g">G plane</option>
          <option value="b">B plane</option>
        </select>
        <label
          className="row"
          style={{ gap: 4, alignItems: "center", fontSize: 10, cursor: "pointer" }}
        >
          <input
            type="checkbox"
            checked={params.invert}
            disabled={hidden}
            onChange={(e) => patch({ invert: e.target.checked })}
          />
          dark metal
        </label>
      </div>

      {params.adaptive ? (
        <>
          <VSlider
            label="Adapt. block"
            value={params.adaptiveBlock}
            min={3}
            max={201}
            step={2}
            onChange={(v) => patch({ adaptiveBlock: v })}
          />
          <VSlider
            label="Adapt. C"
            value={params.adaptiveC}
            min={0}
            max={64}
            onChange={(v) => patch({ adaptiveC: v })}
          />
        </>
      ) : (
        <>
          <VSlider
            label="Thresh low"
            value={params.threshLow}
            min={0}
            max={255}
            onChange={(v) => patch({ threshLow: v })}
          />
          <VSlider
            label="Thresh high"
            value={params.threshHigh}
            min={0}
            max={255}
            onChange={(v) => patch({ threshHigh: v })}
          />
        </>
      )}
      <label
        className="row"
        style={{ gap: 4, alignItems: "center", fontSize: 10, marginTop: 6, cursor: "pointer" }}
      >
        <input
          type="checkbox"
          checked={params.adaptive}
          disabled={hidden}
          onChange={(e) => patch({ adaptive: e.target.checked })}
        />
        adaptive (uneven lighting)
      </label>

      <VSlider
        label="Open (denoise)"
        value={params.openPx}
        min={0}
        max={6}
        onChange={(v) => patch({ openPx: v })}
      />

      {umPerPx > 0 ? (
        <>
          <VSlider
            label="Min gap (merges breaks)"
            value={umPerPx * params.bridgePx * 2}
            min={0}
            max={10}
            step={umPerPx}
            format={fmtUm}
            title="Minimum wire spacing — gaps smaller than this are relief breaks in ONE wire and get merged. 0 = off."
            onChange={(um) => patch({ bridgePx: Math.round(um / umPerPx / 2) })}
          />
          <VSlider
            label="Min length"
            value={umPerPx * params.minLength}
            min={0}
            max={umPerPx * 120}
            step={umPerPx}
            format={fmtUm}
            title="Skeleton branches shorter than this are dropped."
            onChange={(um) => patch({ minLength: Math.round(um / umPerPx) })}
          />
          <VSlider
            label="Wire width min"
            value={umPerPx * params.widthMin}
            min={0}
            max={50}
            step={umPerPx * 0.5}
            format={fmtUm}
            title="Keep branches with median corridor width ≥ this — width filtering drops pads, text and halos out of the traces."
            onChange={(um) => patch({ widthMin: Math.round((um / umPerPx) * 2) / 2 })}
          />
          <VSlider
            label="Wire width max"
            value={umPerPx * params.widthMax}
            min={0}
            max={50}
            step={umPerPx * 0.5}
            format={fmtUm}
            title="Keep branches with median corridor width ≤ this. Raise it if fat buses lose their centreline."
            onChange={(um) => patch({ widthMax: Math.round((um / umPerPx) * 2) / 2 })}
          />
        </>
      ) : (
        <>
          <VSlider
            label="Bridge gaps (px)"
            value={params.bridgePx}
            min={0}
            max={8}
            title="Minimum wire spacing — gaps smaller than this are relief breaks in ONE wire and get merged. 0 = off."
            onChange={(v) => patch({ bridgePx: v })}
          />
          <VSlider
            label="Min length (px)"
            value={params.minLength}
            min={2}
            max={120}
            format={(v) => `${v} px`}
            title="Skeleton branches shorter than this are dropped."
            onChange={(v) => patch({ minLength: v })}
          />
          <VSlider
            label="Width min (px)"
            value={params.widthMin}
            min={0}
            max={30}
            step={0.5}
            format={(v) => (v === 0 ? "off" : `${v} px`)}
            title="Keep branches with median corridor width ≥ this — width filtering drops pads, text and halos out of the traces."
            onChange={(v) => patch({ widthMin: v })}
          />
          <VSlider
            label="Width max (px)"
            value={params.widthMax}
            min={0}
            max={60}
            step={0.5}
            format={(v) => (v === 0 ? "off" : `${v} px`)}
            title="Keep branches with median corridor width ≤ this. Raise it if fat buses lose their centreline."
            onChange={(v) => patch({ widthMax: v })}
          />
          <div className="m" style={{ fontSize: 10, color: "var(--ink3)", marginTop: 4 }}>
            No µm/px calibration on this die (set umPerPx in the ruler tool) —
            sliders are in source pixels.
          </div>
        </>
      )}

      <label
        className="row"
        style={{
          gap: 6,
          alignItems: "center",
          marginTop: 8,
          fontSize: 11,
          cursor: "pointer"
        }}
        title="0/45/90° centrelines: traces drawn the way a human sketches them (straight runs, right-angle and 45° turns on the die-aligned lattice). Off = the standard runs decoder."
      >
        <input
          type="checkbox"
          checked={params.decoder === "octilinear"}
          onChange={(e) =>
            patch({ decoder: e.target.checked ? "octilinear" : "runs" })
          }
        />
        Octilinear decodes
      </label>
      {params.decoder === "octilinear" ? (
        <VSlider
          label="Δ snap (px)"
          value={params.octDeltaPx > 0 ? params.octDeltaPx : 0}
          min={0}
          max={6}
          step={0.25}
          format={(v) => (v === 0 ? "auto" : `${v} px`)}
          onChange={(v) => patch({ octDeltaPx: v })}
        />
      ) : null}
      {params.decoder === "octilinear" ? (
        <div className="m" style={{ fontSize: 10, color: "var(--ink3)", marginTop: 2 }}>
          Δ = how far a drawn line may drift from the raw axis (0 = auto: half
          the thinnest wire). Traces that cannot honestly snap (say, a wire
          drawn at 30°) stay as-is and report irregular.
        </div>
      ) : null}

      {/* P2-3: pre-threshold image conditioning — tune the crop so metal is
          uniform + high-contrast FIRST, then the threshold sees a cleaner
          image. Collapsible: neutral until any knob is opened. Changing any
          value re-decodes (it changes the vector params hash). */}
      <details style={{ marginTop: 10 }}>
        <summary
          className="u"
          style={{
            fontSize: 11,
            cursor: "pointer",
            color: preprocessActive ? "var(--accent, #7ec8f0)" : undefined
          }}
        >
          Preprocess {preprocessActive ? "· active" : "· off"}
          {preprocessPreview && status.preview && (
            <span style={{ color: status.preview.state === "fail" ? "var(--danger, #e36854)" : "var(--ink3)" }}>
              {" · preview "}
              {status.preview.state}
            </span>
          )}
        </summary>
        <div style={{ marginTop: 4 }}>
          <label
            className="u"
            style={{ fontSize: 10, display: "flex", gap: 4, alignItems: "center", cursor: "pointer", marginBottom: 4 }}
            title="Paint the PREPROCESSED pixels of the live viewport (amber-dashed extent), independent of the vector overlay — tune brightness/CLAHE/etc. and the image repaints on its own, no canvas movement needed"
          >
            <input
              type="checkbox"
              checked={preprocessPreview}
              onChange={(e) => setPreprocessPreview(e.target.checked)}
            />
            preprocess preview (live viewport)
          </label>
          {/* Preview lifecycle, surfaced HERE so a dead preview can't be a
              silent mystery: state + consecutive failures + last error. */}
          {preprocessPreview && previewStatus && (
            <div className="m" style={{ fontSize: 10, color: previewStatus.state === "fail" ? "var(--danger, #e36854)" : "var(--ink3)", marginBottom: 4 }}>
              {previewStatus.state === "fetching" && "preview: fetching…"}
              {previewStatus.state === "ok" && "preview: ok"}
              {previewStatus.state === "off" && "preview: off — waiting for a viewport frame"}
              {previewStatus.state === "fail" &&
                `preview failed ×${previewStatus.failures} — ${previewStatus.error ?? "unknown error"} (retrying…)`}
            </div>
          )}
          <VSlider
            label="Brightness"
            value={pp.brightness}
            min={-100}
            max={100}
            step={5}
            format={(v) => (v === 0 ? "off" : `${v > 0 ? "+" : ""}${v}`)}
            onChange={(v) => patchPP({ brightness: v })}
          />
          <VSlider
            label="Contrast"
            value={pp.contrast}
            min={0}
            max={2}
            step={0.05}
            format={(v) => (v === 1 ? "off" : `×${v.toFixed(2)}`)}
            onChange={(v) => patchPP({ contrast: v })}
          />
          <VSlider
            label="Gamma"
            value={pp.gamma}
            min={0.2}
            max={5}
            step={0.05}
            format={(v) => (v === 1 ? "off" : v.toFixed(2))}
            onChange={(v) => patchPP({ gamma: v })}
          />
          <VSlider
            label="Shadows"
            value={pp.shadows}
            min={0}
            max={100}
            step={5}
            format={(v) => (v === 0 ? "off" : `${v}`)}
            onChange={(v) => patchPP({ shadows: v })}
          />
          <VSlider
            label="Highlights"
            value={pp.highlights}
            min={0}
            max={100}
            step={5}
            format={(v) => (v === 0 ? "off" : `${v}`)}
            onChange={(v) => patchPP({ highlights: v })}
          />
          <VSlider
            label="CLAHE clip (0 = off)"
            value={pp.claheClip}
            min={0}
            max={10}
            step={0.25}
            format={(v) => (v === 0 ? "off" : v.toFixed(2))}
            onChange={(v) => patchPP({ claheClip: v })}
          />
          {pp.claheClip > 0 ? (
            <VSlider
              label="CLAHE tiles"
              value={pp.claheTiles}
              min={1}
              max={16}
              step={1}
              format={(v) => `${v}×${v}`}
              onChange={(v) => patchPP({ claheTiles: Math.round(v) })}
            />
          ) : null}
          <VSlider
            label="Sharpen (0 = off)"
            value={pp.sharpenAmount}
            min={0}
            max={200}
            step={5}
            format={(v) => (v === 0 ? "off" : `${v}%`)}
            onChange={(v) => patchPP({ sharpenAmount: v })}
          />
          {pp.sharpenAmount > 0 ? (
            <VSlider
              label="Sharpen radius"
              value={pp.sharpenRadius}
              min={0.5}
              max={5}
              step={0.25}
              format={(v) => `${v.toFixed(2)} px`}
              onChange={(v) => patchPP({ sharpenRadius: v })}
            />
          ) : null}
          <VSlider
            label="Denoise median (0 = off)"
            value={pp.denoiseMedian}
            min={0}
            max={5}
            step={1}
            format={(v) => (v === 0 ? "off" : `${v} px`)}
            onChange={(v) => patchPP({ denoiseMedian: Math.round(v) })}
          />
          <div className="m" style={{ fontSize: 10, color: "var(--ink3)", marginTop: 2 }}>
            Applied before the threshold; any change re-decodes.
          </div>
          {preprocessActive && (
            <button
              type="button"
              className="btn"
              style={{ width: "100%", marginTop: 4 }}
              onClick={() => patch({ preprocess: { ...NEUTRAL_VECTOR_PREPROCESS } })}
            >
              Reset preprocess
            </button>
          )}
        </div>
      </details>

      {/* Presets */}
      <div
        className="row"
        style={{ gap: 6, alignItems: "center", marginTop: 12 }}
      >
        <select
          value=""
          disabled={presetNames.length === 0}
          onChange={(e) => {
            const name = e.target.value;
            const p = presets[name];
            if (p) patch(p);
          }}
          style={{ flex: 1, minWidth: 0 }}
          title="Apply a saved parameter preset"
        >
          <option value="">{presetNames.length ? "apply preset…" : "no presets"}</option>
          {presetNames.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn"
          style={{ cursor: "pointer" }}
          title="Save the current parameters as a named preset (independent of the overlay's visibility)"
          onClick={() => void saveAsPreset()}
        >
          Save
        </button>
        <button
          type="button"
          className="btn"
          style={{ cursor: "pointer" }}
          disabled={presetNames.length === 0}
          title="Delete a preset"
          onClick={async () => {
            const name = await dialog.prompt(
              `Preset to delete (${presetNames.join(", ")}):`,
              "",
              "Delete vector preset"
            );
            if (name?.trim()) deletePreset(name.trim());
          }}
        >
          Del
        </button>
      </div>

      <div
        className="row"
        style={{ gap: 6, marginTop: 8 }}
      >
        <button
          type="button"
          className="btn"
          style={{ flex: 1, cursor: "pointer" }}
          onClick={() => resetParams()}
          title="Reset parameters to the defaults"
        >
          Reset params
        </button>
      </div>

      {/* Whole-die sweep: decode every block, cache, overlay reads blocks */}
      <div style={{ borderTop: "1px solid var(--l1)", margin: "12px 0 10px" }} />
      <div className="m" style={{ fontSize: 10.5, color: "var(--ink3)", marginBottom: 6 }}>
        Decode every block of the die with the current parameters — panning is
        instant afterwards (blocks come from cache).
      </div>
      {sweep.status === "running" ? (
        <>
          <button
            type="button"
            className="btn"
            style={{ width: "100%", cursor: "pointer" }}
            onClick={() => void stopSweep()}
          >
            Stop whole-die decode{" "}
            {sweep.phase === "decoding"
              ? "(decoding — stop now kills the sidecar decode too)"
              : `(${sweep.done}/${sweep.total})`}
          </button>
          {sweep.phase === "decoding" ? (
            <>
              <div
                style={{
                  height: 5,
                  borderRadius: 3,
                  background: "var(--l1)",
                  overflow: "hidden",
                  marginTop: 6
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: sweep.decode
                      ? `${Math.max(2, sweep.decode.pct)}%`
                      : "100%",
                    background: "var(--accent, #7fb2ff)",
                    transition: "width 0.4s",
                    // No progress.json yet (worker starting / legacy): pulse
                    // the full-width bar so it doesn't read as frozen.
                    opacity: sweep.decode ? 1 : 0.5,
                    animation: sweep.decode ? undefined : "vectorPulse 1.6s ease-in-out infinite"
                  }}
                />
              </div>
              <div
                className="m"
                style={{ fontSize: 10, color: "var(--ink3)", marginTop: 4 }}
              >
                {sweep.decode
                  ? `${DECODE_STAGE_LABEL[sweep.decode.stage] ?? sweep.decode.stage} · ` +
                    `elapsed ${fmtDuration(sweep.decode.elapsedMs)}` +
                    (sweep.decode.etaMs != null
                      ? ` · ~${fmtDuration(sweep.decode.etaMs)} left`
                      : "")
                  : "starting decode…"}
                {" — typically several minutes on a dense die. Keep the app "}
                open; the overlay comes back from cache when it finishes.
              </div>
            </>
          ) : (
            <div
              style={{
                height: 5,
                borderRadius: 3,
                background: "var(--l1)",
                overflow: "hidden",
                marginTop: 6
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${sweep.total ? Math.round((sweep.done / sweep.total) * 100) : 0}%`,
                  background: "var(--accent, #7fb2ff)",
                  transition: "width 0.2s"
                }}
              />
            </div>
          )}
        </>
      ) : (
        <button
          type="button"
          className="btn"
          style={{ width: "100%", cursor: "pointer" }}
          disabled={!vectorLayer}
          title="Decode the whole die with the current parameters (block-by-block, ~4 s per Mpx). Results are cached on disk; the overlay then reads them everywhere."
          onClick={() => void startSweep()}
        >
          Decode whole die
        </button>
      )}
      {sweep.status === "completed" && (
        <div className="m" style={{ fontSize: 10, color: "var(--ink3)", marginTop: 4 }}>
          cached · {sweep.done} block(s) · changing any parameter switches the
          overlay back to live mode (re-run to re-cache) · the result is in
          "Vector Layers" (left panel)
        </div>
      )}
      {sweep.warning && (
        <div className="m" style={{ fontSize: 10, color: "var(--warn, #d9a441)", marginTop: 4 }}>
          {sweep.warning}
        </div>
      )}
      {sweep.error && (
        <div className="m" style={{ fontSize: 10, color: "var(--danger, #e36854)", marginTop: 4 }}>
          {sweep.error}
        </div>
      )}

      {/* Pipette: sample the metal colour on the canvas, average, apply.
          A compact instrument row: icon toggle → live status with the mean
          swatch → tolerance + Apply/Clear. */}
      <div style={{ borderTop: "1px solid var(--l1)", margin: "12px 0 8px" }} />
      <div className="row" style={{ gap: 6, alignItems: "center" }}>
        <button
          type="button"
          className="btn"
          style={{
            width: 30,
            height: 24,
            padding: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            ...(pipetteArmed
              ? { background: "var(--accent, #7fb2ff)", color: "#101418" }
              : {})
          }}
          title="Pipette — click the metal on the canvas; each click samples a 7×7 px patch (markers show their shade value). Apply sets the threshold from the mean."
          onClick={() => {
            const next = !pipetteArmed;
            setPipetteArmed(next);
            if (next) clearSamples();
          }}
        >
          {Ic.pipette}
        </button>
        <span className="u" style={{ fontSize: 10 }}>
          Pipette
        </span>
        <span
          className="m"
          style={{ fontSize: 10.5, color: "var(--ink2)", display: "flex", gap: 4, alignItems: "center", minWidth: 0 }}
        >
          {samples.length === 0
            ? pipetteArmed
              ? "click the metal…"
              : "off"
            : pipetteArmed
              ? `on · ${samples.length} click(s)`
              : `${samples.length} sample(s)`}
          {samples.length > 0 && pipetteMean && (
            <>
              <span style={{ color: "var(--ink3)" }}>mean</span>
              <span
                style={{
                  width: 10,
                  height: 10,
                  background: meanSwatch as string,
                  border: "1px solid rgba(0,0,0,0.2)",
                  borderRadius: 2,
                  flex: "0 0 auto",
                  display: "inline-block"
                }}
              />
              <span style={{ fontVariantNumeric: "tabular-nums" }}>
                {Math.round(vOfMean)}/255
              </span>
            </>
          )}
        </span>
      </div>
      {pipetteArmed && (
        <div className="row" style={{ gap: 6, alignItems: "center", marginTop: 6 }}>
          <span className="u" style={{ fontSize: 10 }}>
            Tol ±
          </span>
          <input
            type="number"
            min={0}
            max={100}
            step={5}
            value={tol}
            style={{ width: 56 }}
            onChange={(e) => setTol(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
          />
          <button
            type="button"
            className="btn"
            style={{ flex: 1, cursor: "pointer" }}
            disabled={samples.length === 0}
            title={
              params.invert
                ? "Set Thresh high = mean + tolerance (selects this colour and darker)"
                : "Set Thresh low = mean − tolerance (selects this colour and brighter)"
            }
            onClick={() => {
              if (samples.length === 0) return;
              const v = Math.round(
                Math.max(0, Math.min(255, vOfMean))
              );
              if (params.invert) {
                patch({ threshHigh: Math.min(255, v + tol) });
              } else {
                patch({ threshLow: Math.max(0, v - tol) });
              }
              clearSamples();
              setPipetteArmed(false);
            }}
          >
            {params.invert ? "Apply → thresh high" : "Apply → thresh low"}
          </button>
          <button
            type="button"
            className="btn"
            style={{ cursor: "pointer" }}
            disabled={samples.length === 0}
            title="Drop the accumulated samples"
            onClick={() => clearSamples()}
          >
            Clear
          </button>
        </div>
      )}

      {err && (
        <div
          className="m"
          style={{
            marginTop: 8,
            fontSize: 10.5,
            color: "var(--danger, #e36854)",
            wordBreak: "break-word"
          }}
        >
          {err}
        </div>
      )}

      {/* Vector traces → nets materialization */}
      <div className="row" style={{ gap: 6, marginTop: 12, alignItems: "center" }}>
        <span className="u" style={{ fontSize: 10 }}>Nets from</span>
        <select
          value={netsSource}
          style={{ fontSize: 10, flex: 1 }}
          onChange={(e) => setNetsSource(e.target.value as "whole-die" | "preview")}
        >
          <option value="whole-die">whole die (saved run)</option>
          <option value="preview">preview (live decodes)</option>
        </select>
      </div>
      {netsSource === "whole-die" && (
        <div className="row" style={{ gap: 6, marginTop: 4, alignItems: "center" }}>
          <span className="u" style={{ fontSize: 10 }}>Run</span>
          <select
            value={layerHash}
            style={{ fontSize: 10, flex: 1 }}
            onChange={(e) => setLayerHash(e.target.value)}
          >
            <option value="auto">current params (auto)</option>
            {savedLayers.map((l) => (
              <option key={l.hash} value={l.hash}>
                {l.name ?? "run"} · {l.traces} traces ·{" "}
                {new Date(l.modified).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="row" style={{ gap: 6, marginTop: 4, alignItems: "center" }}>
        <span className="u" style={{ fontSize: 10 }}>Min contacts / net</span>
        <select
          value={minContacts}
          style={{ fontSize: 10 }}
          onChange={(e) => setMinContacts(Number(e.target.value) as 0 | 1 | 2)}
        >
          <option value={0}>off</option>
          <option value={1}>1</option>
          <option value={2}>2</option>
        </select>
        <label
          className="u"
          style={{ fontSize: 10, display: "flex", gap: 4, alignItems: "center", cursor: "pointer" }}
          title="Skip octilinear traces kept raw (irregular) — they did not fit the 0/45/90° lattice within Delta"
        >
          <input
            type="checkbox"
            checked={dropIrregular}
            onChange={(e) => setDropIrregular(e.target.checked)}
          />
          drop irregular
        </label>
      </div>
      <label
        className="u"
        style={{
          fontSize: 10,
          display: "flex",
          gap: 4,
          alignItems: "center",
          cursor: "pointer",
          marginTop: 4
        }}
        title="Skip vectorized traces that duplicate nets you already drew by hand (a trace crossing a drawn wire or lying inside a drawn net's metal). The dropped count shows in the materialize dialog."
      >
        <input
          type="checkbox"
          checked={respectUserNets}
          onChange={(e) => setRespectUserNets(e.target.checked)}
        />
        respect hand-drawn nets
        <span style={{ color: "var(--ink3)" }}>
          {userNetPolylines.length > 0 ? ` · ${annotations?.nets?.length ?? 0} drawn` : " · none drawn"}
        </span>
      </label>
      <VSlider
        label={umPerPx > 0 ? "Max branch len (contact → wire)" : "Max branch len (px)"}
        value={umPerPx > 0 ? umPerPx * maxBranchLen : maxBranchLen}
        min={0}
        max={umPerPx > 0 ? 50 : 200}
        step={umPerPx > 0 ? umPerPx * 0.5 : 1}
        format={umPerPx > 0 ? fmtUm : (v) => (v === 0 ? "off" : `${v} px`)}
        title="Cap on the contact → wire branch edge (0 = off). A contact inside a big pad whose centreline was width-filtered away otherwise ties to a far wire with a long straight line."
        onChange={(v) => setMaxBranchLen(umPerPx > 0 ? Math.round((v / umPerPx) * 2) / 2 : Math.round(v))}
      />
      <button
        type="button"
        className="btn"
        style={{ width: "100%", marginTop: 6 }}
        disabled={
          busy !== null ||
          !vectorLayer ||
          !getTraceSnapTargets ||
          // Only the preview source needs the live overlay: whole-die
          // materializes from the saved sweep payload, the overlay state is
          // irrelevant (it used to be disabled while the overlay was hidden
          // — its default! — even with "whole die" selected).
          (netsSource === "preview" && hidden)
        }
        title="Materialize decoded vector traces into real annotation nets (ends snapped to device contacts / terminals / pins; a contact lying ON the wire splits it and connects mid-wire). Undoable."
        onClick={() => void vectorToNets()}
      >
        {busy === "nets" ? "Creating nets…" : "Vector → nets"}
      </button>
    </div>
  );
}

/** Mask sizing (source-px) + dataset export. */
function TrainingSection({ dieId }: { dieId: string }) {  const mlConfig = useDieViewerStore((s) => s.mlConfig);
  const setMlConfig = useDieViewerStore((s) => s.setMlConfig);
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<
    { ok: true } | { ok: false; msg: string } | null
  >(null);
  const overlayLayers = useOverlayLayers((s) => s.layers);
  const visibleOverlay = overlayLayers.find((l) => !l.hidden && l.loaded);
  const overlayName = visibleOverlay?.serverFilename ?? visibleOverlay?.name ?? undefined;

  const runExport = async () => {
    setExporting(true);
    setResult(null);
    try {
      await exportMlData(dieId, Math.max(1, Math.round(mlConfig.pointViaSize)), overlayName);
      setResult({ ok: true });
    } catch (e) {
      setResult({ ok: false, msg: e instanceof Error ? e.message : "failed" });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div style={{ padding: "12px 12px 16px" }}>
      <div
        className="m"
        style={{ fontSize: 10.5, color: "var(--ink3)", marginBottom: 10 }}
      >
        Real-die sizes baked into the generated training pixel masks. The
        canvas previews these while this tab is open.
      </div>

      <div
        className="row"
        style={{ gap: 8, alignItems: "center", marginBottom: 8, fontSize: 10, color: "var(--ink3)" }}
      >
        <span className="u" style={{ fontSize: 10 }}>
          Source
        </span>
        <span className="m">
          {overlayName ? `overlay: ${overlayName}` : "base image"}
        </span>
      </div>

      <MLSlider
        label="Trace width"
        min={1}
        max={40}
        value={mlConfig.traceWidth}
        onChange={(v) => setMlConfig({ traceWidth: v })}
      />
      <MLSlider
        label="Via size"
        min={1}
        max={30}
        value={mlConfig.pointViaSize}
        onChange={(v) => setMlConfig({ pointViaSize: v })}
      />

      <div style={{ borderTop: "1px solid var(--l1)", margin: "14px 0 12px" }} />

      <button
        type="button"
        className="btn"
        style={{ width: "100%", cursor: "pointer" }}
        disabled={exporting}
        onClick={() => void runExport()}
      >
        {exporting ? "Exporting…" : "Export training data"}
      </button>
      {result && (
        <div
          className="m"
          style={{
            marginTop: 8,
            fontSize: 10.5,
            color: result.ok ? "var(--ink2)" : "var(--danger, #e36854)",
            wordBreak: "break-word"
          }}
        >
          {result.ok
            ? "Export started — written to the server's ML exports dir (see server logs)."
            : `Export failed: ${result.msg}`}
        </div>
      )}

      <button
        type="button"
        className="btn"
        style={{ width: "100%", marginTop: 8, opacity: 0.55 }}
        disabled
        title="Not implemented yet"
      >
        Start training
      </button>
      <div
        className="m"
        style={{ fontSize: 10, color: "var(--ink3)", marginTop: 4 }}
      >
        Training from the UI not available yet, please use the CLI.
      </div>
    </div>
  );
}

function MLSlider({
  label,
  min,
  max,
  value,
  onChange
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div
        className="row"
        style={{ justifyContent: "space-between", marginBottom: 4 }}
      >
        <span className="u" style={{ fontSize: 10 }}>
          {label}
        </span>
        <span
          className="m"
          style={{ fontSize: 11, color: "var(--ink2)" }}
        >
          {value} px
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        style={{ width: "100%" }}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

/** Hex of a color in the Inspector's mono style. */
function HexText({ color }: { color: string }) {
  return (
    <span style={{ color: "var(--ink2)", fontFamily: "var(--mono)", fontSize: 11 }}>{toHex(color)}</span>
  );
}

/** Copies the color's hex (#rrggbb, #rrggbbaa if translucent); ✓ briefly. */
function CopyHexButton({ color }: { color: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const hex = toHex(color);
  return (
    <button
      type="button"
      className="btn sm plain"
      title={`Copy ${hex}`}
      style={{ padding: "0 4px", minWidth: 0 }}
      onClick={() => {
        void navigator.clipboard?.writeText(hex).then(() => {
          setCopied(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? "✓" : Ic.copy}
    </button>
  );
}

/** Swatch + hex + copy button. */
function ColorValue({ color, note }: { color: string; note?: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
      <span style={{ width: 12, height: 12, borderRadius: 2, flex: "none", background: color, border: "1px solid var(--l2)" }} />
      <HexText color={color} />
      <CopyHexButton color={color} />
      {note && <span style={{ color: "var(--ink3)", fontSize: 10 }}>{note}</span>}
    </span>
  );
}

function useNetColorPrefs(): NetColorPrefs {
  const netColor = usePreferences((s) => s.netColor);
  const netColorsPref = usePreferences((s) => s.netColors);
  const customNetColorsEnabled = usePreferences((s) => s.customNetColorsEnabled);
  const wireLayerColors = usePreferences((s) => s.wireLayerColors);
  return { netColor, netColors: netColorsPref, customNetColorsEnabled, wireLayerColors };
}

/**
 * Colors a net is drawn with (one per distinct segment color, e.g. by layer);
 * the first one is editable and sets the net's own color (a per-user
 * preference, so not an undo step).
 */
function NetColorField({ net }: { net: AnnotationNet }) {
  const prefs = useNetColorPrefs();
  const setNetColorOverride = usePreferences((s) => s.setNetColorOverride);
  const setCustomNetColorsEnabled = usePreferences((s) => s.setCustomNetColorsEnabled);
  const key = `net:${net.id}`;
  const colors = netColors(net, prefs, WIRE_LAYER_COLOR);
  const own = prefs.customNetColorsEnabled && prefs.netColors[key];
  const note = own ? "own" : colors.length > 1 ? "by layer" : undefined;
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
      <ColorField
        color={colors[0]}
        title="Net color"
        note={note}
        onPick={(c) => {
          setNetColorOverride(key, c);
          // A picked color would stay invisible in the by-layer view.
          if (!prefs.customNetColorsEnabled) setCustomNetColorsEnabled(true);
        }}
        onReset={prefs.netColors[key] ? () => setNetColorOverride(key, null) : undefined}
        resetTitle="Back to the layer / global net color"
      />
      {colors.slice(1).map((c) => (
        <ColorValue key={c} color={c} note={note} />
      ))}
    </span>
  );
}

/** Color one wire segment is drawn with. */
function EdgeColorValue({ netId, edge }: { netId: string; edge: AnnotationNetEdge }) {
  const prefs = useNetColorPrefs();
  return <ColorValue color={edgeColor(netId, edge, prefs, WIRE_LAYER_COLOR)} />;
}

/** Color cells of a type are drawn with (the type's own, else the global
 *  cell color); editable as one undoable step. */
function CellColorField({ cellType, dispatcher }: { cellType: CellType; dispatcher: ActionDispatcher }) {
  const globalCellColor = usePreferences((s) => s.cellColor);
  const apply = (color: string | null) => {
    if ((cellType.color ?? null) === color) return;
    let next: CellType;
    if (color === null) {
      const { color: _drop, ...rest } = cellType;
      next = rest;
    } else {
      next = { ...cellType, color };
    }
    void dispatcher.dispatch({ kind: "upsertCellType", cellType: next, prevCellType: cellType });
  };
  return (
    <ColorField
      color={cellTypeColor(cellType, globalCellColor)}
      title="Cell type color"
      note={cellType.color ? undefined : "default"}
      onPick={apply}
      onReset={cellType.color ? () => apply(null) : undefined}
      resetTitle="Back to the global cell color"
    />
  );
}

/** Color of a floorplan region; editable as one undoable step. */
function FloorplanColorField({ region, dispatcher }: { region: FloorplanRegion; dispatcher: ActionDispatcher }) {
  return (
    <ColorField
      color={region.color || "#4dabf7"}
      title="Floorplan color"
      onPick={(color) => {
        if (color === region.color) return;
        void dispatcher.dispatch({ kind: "upsertFloorplan", region: { ...region, color }, prevRegion: region });
      }}
    />
  );
}

/**
 * Color of one or several placed vias: swatch + custom color input + reset
 * to the via layer / global color. One undoable step for all of them.
 */
function ViaColorField({ vias, dispatcher }: { vias: HumanAnnotation[]; dispatcher: ActionDispatcher }) {
  const viaLayerColors = usePreferences((s) => s.viaLayerColors);
  const globalViaColor = usePreferences((s) => s.viaColor);
  const stackVias = (useSession((s) => s.metalStack) ?? DEFAULT_METAL_STACK).vias;
  const shown = vias.map((a) => a.color ?? viaBaseColor(a, viaLayerColors, stackVias, globalViaColor));
  const mixed = shown.some((c) => c !== shown[0]);
  const overridden = vias.some((a) => a.color);
  const apply = (color: string | null) => {
    const action = viaColorAction(vias, color);
    if (action) void dispatcher.dispatch(action);
  };
  return (
    <ColorField
      color={mixed ? null : shown[0]}
      title={vias.length > 1 ? `Color of ${vias.length} vias` : "Via color"}
      onPick={apply}
      onReset={overridden ? () => apply(null) : undefined}
      resetTitle="Back to the via layer color"
    />
  );
}

/**
 * Editable color: native color input + hex + copy button, and a ↺ reset
 * when `onReset` is given. `color` null = several differing colors ("mixed").
 */
function ColorField({
  color,
  title,
  note,
  onPick,
  onReset,
  resetTitle
}: {
  color: string | null;
  title: string;
  note?: string;
  onPick: (color: string) => void;
  onReset?: () => void;
  resetTitle?: string;
}) {
  // <input type="color"> only takes #rrggbb (translucent colors drop alpha).
  const hex6 = color && toHex(color).slice(0, 7);
  const hex = hex6 && /^#[0-9a-f]{6}$/.test(hex6) ? hex6 : "#2e97ff";
  // Live value while the native picker is open; committed once on its
  // "change" (picker closed), not per drag step (each would be an undo step
  // and a server write).
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const onCommit = () => {
      setDraft(null);
      pickRef.current(el.value);
    };
    el.addEventListener("change", onCommit);
    return () => el.removeEventListener("change", onCommit);
  }, []);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <input
        ref={inputRef}
        type="color"
        value={draft ?? hex}
        onChange={(e) => setDraft(e.target.value)}
        title={title}
        style={{ width: 28, height: 20, padding: 0, cursor: "pointer", border: "1px solid var(--l2)", borderRadius: 3, background: "none" }}
      />
      {color === null ? (
        <span style={{ color: "var(--ink2)", fontFamily: "var(--mono)", fontSize: 11 }}>mixed</span>
      ) : (
        <>
          <HexText color={color} />
          <CopyHexButton color={color} />
        </>
      )}
      {note && <span style={{ color: "var(--ink3)", fontSize: 10 }}>{note}</span>}
      {onReset && (
        <button type="button" className="btn sm plain" title={resetTitle} onClick={onReset}>
          ↺
        </button>
      )}
    </span>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="m"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        minHeight: 120,
        fontSize: 11,
        color: "var(--ink3)"
      }}
    >
      {children}
    </div>
  );
}
