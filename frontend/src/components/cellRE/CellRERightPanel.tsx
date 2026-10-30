import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CellType, LayerShape, LayerType, ResistorType, AnalogDevice } from "shared";
import { Ic } from "../../icons";
import type {
  CellExtraction,
  CmosDomain,
  ExtractedNet,
  ExtractedShape,
  ExtractionWarning,
  InferredCellExtraction,
  InferredDiffusion,
  Transistor,
  TransmissionGate,
} from "../../lib/extraction";
import { parseShapeKey, shapeKey, useCellREStore } from "../../state/cellRE";
import { usePreferences } from "../../state/preferences";
import { setDeviceOverride, getDeviceRecord, getRegistryVersion } from "../../state/deviceRegistry";
import { effectiveSheetR } from "../../lib/export/resistorDefaults";
import { effectiveCapacitance } from "../../lib/export/capacitorDefaults";
import {
  rowMatchesEntity,
  type HoverEntity,
} from "./hoverEntity";
import {
  RowContextMenu,
  type RowContextMenuState,
} from "./RowContextMenu";
import type { ForcedDiffusionType, ShapeLabel } from "shared";
import {
  formatBoolExpr,
  gateLabel,
  recognizeGate,
  type GateMatch,
} from "../../lib/extraction";
import { displayLabel, netDisplayName } from "../../lib/labels";
import { renderGateSymbol } from "../../lib/schematic/logicSymbols";

/** Inline check glyph — `Ic` doesn't carry one. */
const CHECK = (
  <svg viewBox="0 0 16 16" className="ico" fill="none" stroke="currentColor" strokeWidth={2}>
    <path d="M3 8.5l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

interface Props {
  cellType: CellType | null;
  extraction: CellExtraction | null;
  loading: boolean;
  error: string | null;
  /** Currently-hovered entity (from anywhere — image canvas cursor,
   *  schematic, this very panel). Each row matches against it via
   *  `rowMatchesEntity` for the highlight strip. */
  hoverEntity?: HoverEntity;
  /** Pinned selection keys. Used only for the secondary "this row's shapes
   *  are in the selection" highlight (shape-key intersection); selection is
   *  inherently multi-shape so the broad shape-key match still applies
   *  here even though hover got the narrow entity treatment. */
  selectedShapeIds?: Set<string>;
  /** Which CmosDomain the schematic tab is currently showing — drives the
   *  ✓ marker on the matching row. */
  activeDomainId?: string | null;
  /** Active canvas tab. The panel adapts row behaviour by tab:
   *   - on a schematic tab (`schematic` or `logicSchematic`), clicking
   *     rows doesn't pin a canvas selection (the schematic tabs don't
   *     visualise selection);
   *   - on the `schematic` (CMOS) tab specifically, clicking a domain
   *     row opens that domain — the small chevron is a finicky target
   *     when the schematic itself is already visible. */
  canvasTab?: "image" | "schematic" | "logicSchematic" | "analogSchematic";
  /** Fired when the cursor enters / leaves a row. Carries the row's typed
   *  entity (or `null` on leave). The page routes this through the
   *  shared hover state so the image canvas + schematic light up the
   *  matching elements. */
  onHoverEntity?: (entity: HoverEntity) => void;
  /** Scale factor: µm per pixel. Passed through for resistor width display. */
  umPerPx?: number;
  /** Callback to update width of selected line shapes.
   *  Receives layer, array of shape ids, and new width in pixels. */
  onUpdateLineWidths?: (layer: LayerType, shapeIds: string[], widthPx: number) => void;
  /** Replace the canvas selection with these shape keys. */
  onSelect: (ids: Set<string>) => void;
  /** Rename the active cell type. Called by the header's double-click
   *  inline edit and by the "Accept Name" button. */
  onRename?: (newName: string) => void;
  /** Set / clear a custom display name on a net. Empty string clears.
   *  The page resolves the netId to a member shape and writes
   *  `customName` there; the extractor propagates back to the net. */
  onRenameNet?: (netId: number, newName: string) => void;
  /** Set / clear the role label (VCC / GND / I/O / INPUT / OUTPUT)
   *  on a net. Used by the right-click context menu. Same plumbing
   *  as `onRenameNet`: the page resolves to a representative shape
   *  and writes `label` there. */
  onSetNetLabel?: (netId: number, label: ShapeLabel | null) => void;
  /** Set / clear the diffusion-only forced P/N override on a
   *  specific diffusion shape. Used by the right-click context menu
   *  on diffusion rows. */
  onSetDiffusionForcedType?: (
    diffusionShapeId: string,
    type: ForcedDiffusionType | null,
  ) => void;
  /** Open a CMOS domain in the schematic tab. */
  onDomainOpen?: (domainId: string) => void;
}

/**
 * The Cells-RE right panel. Header summarises the cell + extractor verdict,
 * followed by a warnings strip and the lists the extractor emits (nets,
 * transistors, diffusions, domains, TGs).
 *
 * Rows are mouse-interactive: hovering paints a soft halo over the related
 * shapes on the canvas; clicking replaces the canvas selection with them.
 * Sub-region ids (synthetic) fold to their parent diffusion id so the
 * highlight lands on a real, user-drawn shape.
 */
export function CellRERightPanel({
  cellType,
  extraction,
  loading,
  error,
  hoverEntity,
  selectedShapeIds,
  activeDomainId,
  canvasTab,
  onHoverEntity,
  onSelect,
  umPerPx,
  onRename,
  onRenameNet,
  onSetNetLabel,
  onSetDiffusionForcedType,
  onUpdateLineWidths,
  onDomainOpen,
}: Props) {
  const inferred =
    extraction && extraction.kind === "inferred"
      ? (extraction as InferredCellExtraction)
      : null;
  const analogDevices = inferred?.analogDevices ?? [];
  const hasAnalogDevices = analogDevices.length > 0;

  const activeCellTypeId = useCellREStore((s) => s.activeCellTypeId);

  // Build a single shape index once per render so every row's hover/click
  // handler can map its (mixed) shape ids → canvas selection keys without
  // re-scanning the shape list.
  const shapeIndex = useMemo(
    () => indexShapes(inferred?.shapes ?? []),
    [inferred?.shapes],
  );

  // Net-id → display label resolver used to pretty-print boolean
  // expressions in domain rows / the result header. Falls back to
  // `netN` when the net carries no semantic label, matching how the
  // rest of the panel surfaces nets.
  const netName = useMemo(() => {
    const labels = new Map<number, string>();
    for (const n of inferred?.nets ?? []) labels.set(n.id, netDisplayName(n));
    return (id: number) => labels.get(id) ?? `net${id}`;
  }, [inferred?.nets]);

  // Convenience: `bind` builds the row's full interaction state — the
  // three mouse handlers (enter/leave/click) plus the "this row is
  // currently the hover target or part of the selection" flag.
  //
  // `entity` is the typed entity this row represents. Hover matching uses
  // it directly via `rowMatchesEntity`; selection (which is inherently
  // multi-shape) keeps the broad shape-key intersection logic since one
  // selection can span multiple rows of different kinds.
  const bind = (
    shapeIds: Iterable<string>,
    entity: HoverEntity,
  ): RowHandlers => {
    const keys = shapesToSelectionKeys(shapeIndex, shapeIds);
    // Selection-based highlight (broad shape-key intersection).
    let highlighted = false;
    if (selectedShapeIds && selectedShapeIds.size > 0) {
      for (const k of keys) {
        if (selectedShapeIds.has(k)) {
          highlighted = true;
          break;
        }
      }
    }
    // Hover-based highlight (narrow typed-entity match).
    if (!highlighted && entity && hoverEntity) {
      highlighted = rowMatchesEntity(entity, hoverEntity, extraction);
    }
    return {
      highlighted,
      onMouseEnter: () => {
        onHoverEntity?.(entity);
      },
      onMouseLeave: () => {
        onHoverEntity?.(null);
      },
      // Selection is image-tab-only: clicking a row in either schematic
      // tab shouldn't pin a selection that the schematics don't even
      // visualise. DomainRow overrides this in CMOS-schematic mode to
      // "open the domain"; other rows fall through to a no-op.
      onClick:
        canvasTab === "image" ? () => onSelect(keys) : () => {},
    };
  };

  // Row right-click menu — net rows get a role-label submenu,
  // diffusion rows get a forced P/N submenu. Kept inside the panel
  // because the menu only acts on a single row (no selection
  // semantics) and rendering it here keeps the page lean.

  // Read selection directly from Zustand so changes from inside mouse
  // event handlers (getConnectedLines) are reflected synchronously.
  const localSelectedShapeIds = useCellREStore((s) => s.selectedShapeIds);

  // Prefer prop when provided (for external control), fall back to store.
  const effectiveSelection = selectedShapeIds ?? localSelectedShapeIds;

  // Resistor body layer keys that support polyline width editing
  const RESISTOR_BODY_KEYS = ["resistor_body","polysilicon","base","emitter","hsr","film"] as const;
  // ── Selected resistor info ───────────────────────────────────
  // Find the resistor chain from the current selection. If one or more
  // line shapes are selected, find all connected segments forming that
  // resistor and show its info (segs, L, W, corners, squares).
  const selectedResistorInfo = useMemo(() => {

    if (!cellType || !effectiveSelection || effectiveSelection.size === 0) {
      return null;
    }
    // Find the first selected line shape.
    let seedId: string | null = null;
    let seedLayer: string | null = null;
    for (const key of effectiveSelection) {
      const p = parseShapeKey(key);
      if (!p) continue;
      const shapes = cellType.layers?.[p.layer as LayerType] ?? [];
      const s = shapes.find((s: any) => s.id === p.id);
      if (s?.kind === "line") { seedId = p.id; seedLayer = p.layer; break; }
    }

    if (!seedId || !seedLayer) return null;
    const layerKey = seedLayer;
    const lines = ((cellType.layers?.[layerKey as LayerType] ?? []) as any[]).filter(
      (s: any) => s.kind === "line"
    );
    if (lines.length === 0) return null;
    // Build adjacency map: lineId -> Set<neighborId> (shared endpoint)
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
    // BFS from the seed to find the connected component.
    const comp = new Set<string>();
    const queue = [seedId];
    while (queue.length > 0) {
      const id = queue.pop()!;
      if (comp.has(id)) continue;
      comp.add(id);
      for (const n of adj.get(id) ?? []) if (!comp.has(n)) queue.push(n);
    }
    const chain = lines.filter((l: any) => comp.has(l.id));
    if (chain.length === 0) return null;
    // Compute metrics.
    const w = chain[0].width || 4;
    let totalL = 0, corners = 0;
    let prevAngle: number | null = null;
    for (let i = 0; i < chain.length; i++) {
      const l = chain[i];
      const dx = l.x2 - l.x1, dy = l.y2 - l.y1;
      totalL += Math.sqrt(dx * dx + dy * dy);
      if (i > 0) {
        const a = Math.atan2(dy, dx);
        if (prevAngle != null && Math.abs(a - prevAngle) > Math.PI / 6) corners++;
        prevAngle = a;
      } else {
        prevAngle = Math.atan2(dy, dx);
      }
    }
    const sq = (totalL - corners * w) / w + 0.55 * corners;
    const chainIds = new Set(chain.map((l: any) => l.id));
    return { layerKey, totalL: totalL.toFixed(0), width: w, corners, squares: sq.toFixed(1), segs: chain.length, chainIds, seedId };
  }, [cellType?.layers, effectiveSelection]);

  const [rowMenu, setRowMenu] = useState<RowContextMenuState | null>(null);
  const openNetMenu = (
    e: React.MouseEvent,
    netId: number,
    currentLabel: ShapeLabel | null,
  ) => {
    if (!onSetNetLabel) return;
    e.preventDefault();
    setRowMenu({
      kind: "net",
      x: e.clientX,
      y: e.clientY,
      netId,
      currentLabel,
    });
  };
  const openDiffMenu = (
    e: React.MouseEvent,
    diffusionShapeId: string,
    currentForcedType: ForcedDiffusionType | null,
  ) => {
    if (!onSetDiffusionForcedType) return;
    e.preventDefault();
    setRowMenu({
      kind: "diffusion",
      x: e.clientX,
      y: e.clientY,
      diffusionShapeId,
      currentForcedType,
    });
  };

  return (
    <aside style={panelStyle}>
      <ResultHeader
        cellType={cellType}
        extraction={extraction}
        loading={loading}
        error={error}
        netName={netName}
        onRename={onRename}
      />
      <div style={{ overflow: "auto", flex: "1 1 auto", minHeight: 0 }}>
        {hasAnalogDevices && (
          <Section title="Analog Device Extractor" count={analogDevices.length}>
            <List>
              {analogDevices.map((ad) => (
                <AnalogDeviceRow
                  key={ad.id}
                  device={ad}
                  cellTypeId={activeCellTypeId ?? ""}
                  onOverride={(deviceKey, param, value) => {
                    const templateUuid = (ad as any)._templateUuid as string | undefined;
                    if (templateUuid) setDeviceOverride(templateUuid, param, value);
                    usePreferences.setState((s: any) => ({
                      analogOverrides: {
                        ...(s.analogOverrides ?? {}),
                        [activeCellTypeId ?? ""]: {
                          ...((s.analogOverrides ?? {})[activeCellTypeId ?? ""] ?? {}),
                          [deviceKey]: {
                            ...(((s.analogOverrides ?? {})[activeCellTypeId ?? ""] ?? {})[deviceKey] ?? {}),
                            [param]: value,
                          },
                        },
                      },
                    }));
                  }}
                />
              ))}
            </List>
          </Section>
        )}
        <Section
          title="Digital StdCell Extractor"
          count={null}
          defaultOpen={!hasAnalogDevices}
        >
        {inferred && inferred.warnings.length > 0 && (
          <WarningsSection warnings={inferred.warnings} bind={bind} />
        )}
        <Section title="Nets" count={inferred?.nets.length ?? 0}>
          {inferred && inferred.nets.length > 0 ? (
            <List>
              {inferred.nets.map((n) => (
                <NetRow
                  key={n.id}
                  net={n}
                  handlers={bind(n.shapeIds, { kind: "net", netId: n.id })}
                  onRenameNet={onRenameNet}
                  onContextMenu={
                    onSetNetLabel
                      ? (e) => openNetMenu(e, n.id, n.label ?? null)
                      : undefined
                  }
                />
              ))}
            </List>
          ) : (
            <Empty>{emptyHint(loading, error, cellType)}</Empty>
          )}
        </Section>
        <Section title="Transistors" count={inferred?.transistors.length ?? 0}>
          {inferred && inferred.transistors.length > 0 ? (
            <List>
              {inferred.transistors.map((t) => (
                <TransistorRow
                  key={t.id}
                  transistor={t}
                  handlers={bind(
                    [t.gate.shapeId, t.source.shapeId, t.drain.shapeId],
                    { kind: "transistor", transistorId: t.id },
                  )}
                />
              ))}
            </List>
          ) : (
            <Empty>{emptyHint(loading, error, cellType)}</Empty>
          )}
        </Section>
        <Section title="Diffusion regions" count={inferred?.diffusions.length ?? 0}>
          {inferred && inferred.diffusions.length > 0 ? (
            <List>
              {inferred.diffusions.map((d) => (
                <DiffusionRow
                  key={d.shapeId}
                  diff={d}
                  handlers={bind(
                    [d.shapeId, ...d.subRegionIds],
                    { kind: "diffusion", diffusionShapeId: d.shapeId },
                  )}
                  onContextMenu={
                    onSetDiffusionForcedType
                      ? (e) => {
                          // The diff's `type` reflects the resolved
                          // value (auto or forced); `forced` says
                          // whether the user pinned it. Only treat as
                          // a current-forced state when both apply
                          // AND the type is concrete (not "unknown").
                          const current: ForcedDiffusionType | null =
                            d.forced && (d.type === "p" || d.type === "n")
                              ? d.type
                              : null;
                          openDiffMenu(e, d.shapeId, current);
                        }
                      : undefined
                  }
                />
              ))}
            </List>
          ) : (
            <Empty>{emptyHint(loading, error, cellType)}</Empty>
          )}
        </Section>
        <Section title="Domains" count={inferred?.domains.length ?? 0}>
          {inferred && inferred.domains.length > 0 ? (
            <List>
              {inferred.domains.map((d) => (
                <DomainRow
                  key={d.id}
                  domain={d}
                  active={d.id === activeDomainId}
                  netName={netName}
                  handlers={bind(
                    domainShapeIds(d, inferred.transistors),
                    { kind: "domain", domainId: d.id },
                  )}
                  onOpen={onDomainOpen ? () => onDomainOpen(d.id) : undefined}
                  rowOpens={canvasTab === "schematic"}
                />
              ))}
            </List>
          ) : (
            <Empty>{emptyHint(loading, error, cellType)}</Empty>
          )}
        </Section>
        {rowMenu && (
          <RowContextMenu
            menu={rowMenu}
            onClose={() => setRowMenu(null)}
            onSetNetLabel={(netId, label) => onSetNetLabel?.(netId, label)}
            onSetDiffusionForcedType={(shapeId, type) =>
              onSetDiffusionForcedType?.(shapeId, type)
            }
          />
        )}
        <Section
          title="Transmission gates"
          count={inferred?.transmissionGates.length ?? 0}
        >
          {inferred && inferred.transmissionGates.length > 0 ? (
            <List>
              {inferred.transmissionGates.map((tg) => (
                <TGRow
                  key={tg.id}
                  tg={tg}
                  handlers={bind(
                    tgShapeIds(tg, inferred.transistors),
                    { kind: "tg", tgId: tg.id },
                  )}
                />
              ))}
            </List>
          ) : (
            <Empty>none detected</Empty>
          )}
        </Section>
        </Section>
      </div>
  
      {selectedResistorInfo && (() => {
        const px = selectedResistorInfo.width;
        const um = umPerPx ? Math.round(px * umPerPx) : px;
        // Commit by µm: round to nearest µm, then convert to px once.
        const commitWidthUm = (umVal: number) => {
          const roundedUm = Math.max(1, Math.round(umVal));
          const pxVal = umPerPx ? Math.round(roundedUm / umPerPx) : roundedUm;
          onUpdateLineWidths?.(selectedResistorInfo.layerKey as LayerType, Array.from(selectedResistorInfo.chainIds), pxVal);
        };
        return (
          <div style={{borderTop:'1px solid var(--l1)',padding:'6px 10px',fontSize:10,color:'var(--ink2)'}}>
            <div className="u" style={{fontSize:9,color:'var(--ink3)',marginBottom:3}}>RESISTOR ({selectedResistorInfo.layerKey})</div>
            <div>segs: {selectedResistorInfo.segs} | L: {selectedResistorInfo.totalL}px{umPerPx ? ' (' + (parseFloat(selectedResistorInfo.totalL) * umPerPx).toFixed(1) + 'µm)' : ''}</div>
            <div style={{display:'flex',alignItems:'center',gap:6,margin:'4px 0'}}>
              <span style={{fontSize:9.5,color:'var(--ink3)',minWidth:16}}>W:</span>
              <input type="range" min={1} max={50} step={0.5} value={Math.min(um, 50)}
                onChange={e => commitWidthUm(parseFloat(e.target.value))}
                style={{flex:1,height:14,accentColor:'var(--accent)',cursor:'pointer'}} />
              <input type="number" min={0.5} step={0.5} value={um}
                onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v) && v >= 0.5) commitWidthUm(v); }}
                style={{width:44,background:'var(--bg1)',border:'1px solid var(--border)',color:'var(--ink0)',fontSize:10,padding:'1px 3px',borderRadius:3,textAlign:'center'}} />
              <span style={{fontSize:9.5,color:'var(--ink3)'}}>µm</span>
            </div>
            <div className="m" style={{fontSize:9.5,color:'var(--ink3)',marginTop:1}}>corners: {selectedResistorInfo.corners} | squares: {selectedResistorInfo.squares}</div>
          </div>
        );
      })()}
  </aside>
  );
}

// ── Header ───────────────────────────────────────────────────────

function ResultHeader({
  cellType,
  extraction,
  loading,
  error,
  netName,
  onRename,
}: {
  cellType: CellType | null;
  extraction: CellExtraction | null;
  loading: boolean;
  error: string | null;
  /** Resolver used to pretty-print net ids inside the cell-level
   *  boolean expression (when one was derived). */
  netName: (id: number) => string;
  /** Fires when the user commits a rename (double-click → input, or
   *  the Accept Name button). The page wraps this in an
   *  `upsertCellType` action so it lands in the undo stack. */
  onRename?: (newName: string) => void;
}) {
  if (!cellType) {
    return (
      <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--l2)" }}>
        <div className="u" style={{ fontSize: 10, color: "var(--ink3)" }}>
          —
        </div>
        <div style={{ fontSize: 13, color: "var(--ink2)", marginTop: 4 }}>
          select a cell type
        </div>
      </div>
    );
  }

  const verdict = verdictFor(extraction, loading, error);
  // Proposed cell-type name from gate recognition (e.g. "AND2",
  // "AOI21B1"). Falls back to undefined when the cell wasn't
  // recognised as a single library gate — the Accept Name button
  // disables in that case.
  const proposedName =
    extraction?.kind === "inferred" && extraction.logic
      ? gateLabel(recognizeGate(extraction.logic))
      : undefined;
  const canAccept =
    proposedName != null &&
    proposedName !== "compound" &&
    proposedName !== cellType.name &&
    !!onRename;

  return (
    <div
      style={{
        padding: "10px 12px",
        borderBottom: "1px solid var(--l2)",
        background: "var(--card)",
      }}
    >
      <div className="row" style={{ alignItems: "center", gap: 8 }}>
        <span
          className="u"
          style={{
            fontSize: 9.5,
            color: verdict.color,
            letterSpacing: 0.7,
          }}
        >
          {verdict.label}
        </span>
        <button
          className="btn"
          style={{
            marginLeft: "auto",
            fontSize: 10.5,
            opacity: canAccept ? 1 : 0.5,
          }}
          title={
            canAccept
              ? `Rename cell type to "${proposedName}"`
              : proposedName === cellType.name
                ? "The cell is already named the recognised gate"
                : "No single-library-gate name recognised for this cell"
          }
          disabled={!canAccept}
          onClick={() => {
            if (canAccept && proposedName) onRename?.(proposedName);
          }}
        >
          {CHECK} Accept Name{proposedName && canAccept ? ` (${proposedName})` : ""}
        </button>
      </div>
      <CellNameField
        name={cellType.name}
        onCommit={onRename}
      />
      <div style={{ fontSize: 11, color: "var(--ink2)", marginTop: 4 }}>
        {verdict.detail}
      </div>
      {/* Cell-level boolean — only set for single-output combinational
          cells whose domain graph has no feedback. Stays hidden for
          sequential / multi-output cells so the header doesn't lie about
          what the cell does. */}
      {extraction?.kind === "inferred" && extraction.logic && (() => {
        const gate = recognizeGate(extraction.logic);
        return (
          <>
            <div
              className="row"
              style={{ marginTop: 6, gap: 8, alignItems: "center" }}
            >
              <GateChip gate={gate} />
              <span
                className="m"
                style={{ fontSize: 10.5, color: "var(--ink3)" }}
                title="recognised standard-cell shape of this entire cell"
              >
                cell-level gate
              </span>
              <span style={{ flex: 1 }} />
              {/* Symbol preview pinned to the right of the header strip
                  so the chip + label stay readable on narrow widths and
                  the symbol gets as much room as it needs. */}
              <GatePreview gate={gate} />
            </div>
            <div
              className="m"
              style={{
                marginTop: 4,
                fontSize: 11,
                color: "var(--ink2)",
                fontFamily: "var(--mono)",
                wordBreak: "break-all",
              }}
            >
              out = {formatBoolExpr(extraction.logic, netName)}
            </div>
          </>
        );
      })()}
    </div>
  );
}

/**
 * The cell name display + double-click-to-rename inline editor.
 * Stable across the cellType's identity: when the name prop changes
 * externally (action dispatched) we drop any in-progress edit.
 * Commit on blur or Enter, cancel on Escape — both well-established
 * inline-edit conventions.
 */
function CellNameField({
  name,
  onCommit,
}: {
  name: string;
  onCommit?: (newName: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Re-seed the draft whenever the underlying name changes — covers
  // the rename-from-elsewhere case and also cell-type-switch.
  useEffect(() => {
    setDraft(name);
    setEditing(false);
  }, [name]);
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);
  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed.length === 0 || trimmed === name) return;
    onCommit?.(trimmed);
  };
  const cancel = () => {
    setDraft(name);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") cancel();
        }}
        style={{
          width: "100%",
          marginTop: 2,
          fontSize: 15,
          fontWeight: 600,
          color: "var(--ink)",
          fontFamily: "var(--font)",
          background: "var(--canvas-bg)",
          border: "1px solid var(--accent)",
          borderRadius: 3,
          padding: "2px 4px",
          boxSizing: "border-box",
        }}
      />
    );
  }
  return (
    <div
      onDoubleClick={() => onCommit && setEditing(true)}
      title={onCommit ? "Double-click to rename" : undefined}
      style={{
        fontSize: 15,
        fontWeight: 600,
        color: "var(--ink)",
        marginTop: 2,
        fontFamily: "var(--font)",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        cursor: onCommit ? "text" : "default",
        userSelect: "none",
      }}
    >
      {name}
    </div>
  );
}

function verdictFor(
  extraction: CellExtraction | null,
  loading: boolean,
  error: string | null,
): { label: string; color: string; detail: string } {
  if (error) {
    return {
      label: "ERROR",
      color: "var(--err)",
      detail: `extraction unavailable: ${error}`,
    };
  }
  if (loading) {
    return {
      label: "LOADING",
      color: "var(--ink3)",
      detail: "loading WASM …",
    };
  }
  if (!extraction || extraction.kind !== "inferred") {
    return {
      label: "MANUAL",
      color: "var(--accent)",
      detail: "placeholder / hand-written cell",
    };
  }
  const e = extraction as InferredCellExtraction;
  if (e.transistors.length === 0) {
    return {
      label: "EMPTY",
      color: "var(--ink3)",
      detail: "no transistors found",
    };
  }
  const summary =
    `${e.transistors.length} transistor${e.transistors.length === 1 ? "" : "s"} · ` +
    `${e.domains.length} domain${e.domains.length === 1 ? "" : "s"}` +
    (e.transmissionGates.length > 0
      ? ` · ${e.transmissionGates.length} TG${e.transmissionGates.length === 1 ? "" : "s"}`
      : "");
  return {
    label: "INFERRED",
    color: "var(--ok)",
    detail: summary,
  };
}

function emptyHint(
  loading: boolean,
  error: string | null,
  cellType: CellType | null,
): string {
  if (error) return "extraction unavailable";
  if (loading) return "loading …";
  if (!cellType) return "select a cell type";
  return "nothing extracted";
}

// ── Warnings ─────────────────────────────────────────────────────

function WarningsSection({
  warnings,
  bind,
}: {
  warnings: ExtractionWarning[];
  bind: (ids: Iterable<string>, entity: HoverEntity) => RowHandlers;
}) {
  const errs = warnings.filter((w) => w.severity === "error").length;
  const warns = warnings.filter((w) => w.severity === "warning").length;
  const infos = warnings.filter((w) => w.severity === "info").length;
  return (
    <Section
      title="Warnings"
      count={warnings.length}
      header={
        <span className="row" style={{ gap: 4, marginLeft: 6 }}>
          {errs > 0 && (
            <span className="chip err" style={{ height: 16, padding: "0 5px" }}>
              {errs} err
            </span>
          )}
          {warns > 0 && (
            <span className="chip warn" style={{ height: 16, padding: "0 5px" }}>
              {warns} warn
            </span>
          )}
          {infos > 0 && (
            <span className="chip" style={{ height: 16, padding: "0 5px" }}>
              {infos} info
            </span>
          )}
        </span>
      }
      defaultOpen={errs > 0}
    >
      <List>
        {warnings.map((w, i) => {
          const shapeIds = w.refs?.shapeIds ?? [];
          return (
            <WarningRow
              key={i}
              warning={w}
              handlers={bind(
                shapeIds,
                shapeIds.length > 0
                  ? { kind: "warning", shapeIds }
                  : null,
              )}
            />
          );
        })}
      </List>
    </Section>
  );
}

function WarningRow({
  warning,
  handlers,
}: {
  warning: ExtractionWarning;
  handlers: RowHandlers;
}) {
  const color =
    warning.severity === "error"
      ? "var(--err)"
      : warning.severity === "warning"
        ? "var(--warn)"
        : "var(--ink3)";
  const hasShapes = (warning.refs?.shapeIds?.length ?? 0) > 0;
  const highlighted = hasShapes && handlers.highlighted;
  return (
    <div
      className="m"
      style={{
        display: "flex",
        gap: 6,
        padding: "4px 9px",
        paddingLeft: highlighted ? 9 : 12,
        fontSize: 10.5,
        lineHeight: 1.35,
        borderBottom: "1px solid var(--l1)",
        borderLeft: highlighted ? "3px solid var(--accent)" : "0",
        background: highlighted ? "var(--accentBg)" : "transparent",
        cursor: hasShapes ? "pointer" : "default",
      }}
      onMouseEnter={hasShapes ? handlers.onMouseEnter : undefined}
      onMouseLeave={hasShapes ? handlers.onMouseLeave : undefined}
      onClick={hasShapes ? handlers.onClick : undefined}
    >
      <span style={{ color, flex: "0 0 auto" }}>●</span>
      <span style={{ flex: 1, color: "var(--ink2)" }}>
        <span style={{ color, fontWeight: 600 }}>{warning.code}</span>
        <span style={{ color: "var(--ink3)" }}> · </span>
        {warning.message}
      </span>
    </div>
  );
}

// ── Rows ─────────────────────────────────────────────────────────

function NetRow({
  net,
  handlers,
  onRenameNet,
  onContextMenu,
}: {
  net: ExtractedNet;
  handlers: RowHandlers;
  onRenameNet?: (netId: number, newName: string) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const roleColor = roleColorFor(net.role);
  // `label` is set whenever the user explicitly tagged a shape in this net
  // (Label as VCC / GND / Chip I/O / Input / Output). When set, the role
  // chip is driven by that label — surface a "FORCED" badge so the user
  // can tell auto-inferred roles from manually-pinned ones, mirroring the
  // diffusion row's treatment.
  const forced = net.label != null;
  return (
    <Row handlers={handlers} onContextMenu={onContextMenu}>
      <NetNameField
        net={net}
        onRename={onRenameNet}
      />
      <RoleChip text={net.role ?? "—"} color={roleColor} />
      {forced && (
        <span
          className="m"
          style={{ fontSize: 9, color: "var(--accent)", letterSpacing: 0.6 }}
        >
          FORCED
        </span>
      )}
      <span
        className="m"
        style={{ marginLeft: "auto", fontSize: 9.5, color: "var(--ink3)" }}
      >
        {net.shapeIds.length} shape{net.shapeIds.length === 1 ? "" : "s"}
      </span>
    </Row>
  );
}

/**
 * Inline-editable display name for a net. Shows the current display
 * name (customName > label > netN); double-click switches to an input
 * so the user can rename. Commit on blur / Enter; cancel on Escape.
 * Mirrors `CellNameField`'s pattern.
 *
 * Edit fires `onRename(netId, newName)`; passing an empty string
 * clears the customName.
 */
function NetNameField({
  net,
  onRename,
}: {
  net: ExtractedNet;
  onRename?: (netId: number, newName: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  // Edit the customName directly (so an empty input clears it). Start
  // empty for nets without one — typing a name SETS it.
  const [draft, setDraft] = useState(net.customName ?? "");
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    setDraft(net.customName ?? "");
    setEditing(false);
  }, [net.customName, net.id]);
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);
  const display = netDisplayName(net);
  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed === (net.customName ?? "")) return; // no-op
    onRename?.(net.id, trimmed);
  };
  const cancel = () => {
    setDraft(net.customName ?? "");
    setEditing(false);
  };
  // Stop the row's own click/hover-stop handlers from firing on the
  // input — otherwise typing into the input would clear the
  // selection / hover (the parent Row catches click anywhere).
  const stop = (e: React.MouseEvent | React.KeyboardEvent) =>
    e.stopPropagation();

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onClick={stop}
        onDoubleClick={stop}
        onKeyDown={(e) => {
          stop(e);
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") cancel();
        }}
        placeholder={`net${net.id}`}
        style={{
          width: 80,
          fontSize: 11,
          fontFamily: "var(--mono, ui-monospace)",
          color: "var(--ink)",
          background: "var(--canvas-bg)",
          border: "1px solid var(--accent)",
          borderRadius: 2,
          padding: "1px 3px",
          boxSizing: "border-box",
        }}
      />
    );
  }
  return (
    <span
      className="m"
      style={{
        color: net.customName ? "var(--ink2)" : "var(--ink3)",
        minWidth: 50,
        cursor: onRename ? "text" : "default",
      }}
      title={onRename ? "Double-click to rename this net" : undefined}
      onDoubleClick={
        onRename
          ? (e) => {
              e.stopPropagation();
              setEditing(true);
            }
          : undefined
      }
    >
      {display}
    </span>
  );
}

function TransistorRow({
  transistor,
  handlers,
}: {
  transistor: Transistor;
  handlers: RowHandlers;
}) {
  const typeColor =
    transistor.type === "pmos"
      ? "#c45a90"
      : transistor.type === "nmos"
        ? "#3c8aa0"
        : "var(--ink3)";
  return (
    <Row handlers={handlers}>
      <span
        className="m"
        style={{
          color: typeColor,
          width: 36,
          fontWeight: 600,
          textTransform: "uppercase",
          fontSize: 10,
        }}
      >
        {transistor.type}
      </span>
      <RoleChip
        text={transistor.role ?? "—"}
        color={transistorRoleColor(transistor.role)}
      />
      <span
        className="m"
        style={{ fontSize: 9.5, color: "var(--ink2)" }}
        title={`gate=net${transistor.gate.netId}, source=net${transistor.source.netId}, drain=net${transistor.drain.netId}`}
      >
        g{transistor.gate.netId}·s{transistor.source.netId}·d{transistor.drain.netId}
      </span>
      <span
        className="m"
        style={{ marginLeft: "auto", fontSize: 9.5, color: "var(--ink3)" }}
      >
        {Math.round(transistor.region.width)}×{Math.round(transistor.region.height)}
      </span>
    </Row>
  );
}

function DiffusionRow({
  diff,
  handlers,
  onContextMenu,
}: {
  diff: InferredDiffusion;
  handlers: RowHandlers;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const typeColor =
    diff.type === "p"
      ? "#c45a90"
      : diff.type === "n"
        ? "#3c8aa0"
        : "var(--ink3)";
  return (
    <Row handlers={handlers} onContextMenu={onContextMenu}>
      <span
        className="m"
        style={{ color: "var(--ink3)", width: 60, fontSize: 10 }}
      >
        {diff.shapeId.slice(0, 6)}
      </span>
      <span
        className="m"
        style={{
          color: typeColor,
          fontWeight: 600,
          fontSize: 10,
          textTransform: "uppercase",
        }}
      >
        {diff.type}-type
      </span>
      {diff.forced && (
        <span
          className="m"
          style={{ fontSize: 9, color: "var(--accent)", letterSpacing: 0.6 }}
        >
          FORCED
        </span>
      )}
      <span
        className="m"
        style={{ marginLeft: "auto", fontSize: 9.5, color: "var(--ink3)" }}
      >
        {diff.subRegionIds.length} sub
      </span>
    </Row>
  );
}

function DomainRow({
  domain,
  active,
  netName,
  handlers,
  onOpen,
  rowOpens,
}: {
  domain: CmosDomain;
  /** True when the schematic tab is currently rendering this domain. */
  active: boolean;
  /** Resolver used to pretty-print net ids inside the boolean
   *  expression subline (so VDD/GND/INPUT show as named, not as raw
   *  `netN` ids). */
  netName: (id: number) => string;
  handlers: RowHandlers;
  /** Single-click on the chevron always opens; when `rowOpens` is true
   *  (typically while the schematic tab is active), clicking anywhere on
   *  the row body opens too — the small chevron is finicky once the user
   *  is already in the schematic tab. */
  onOpen?: () => void;
  rowOpens?: boolean;
}) {
  // When `rowOpens` is on, the row's main click goes to `onOpen` instead of
  // the default `onSelect`-shapes behaviour. Hover still drives the same
  // shape-key highlights so the user can preview before clicking.
  const rowHandlers: RowHandlers =
    rowOpens && onOpen
      ? { ...handlers, onClick: onOpen }
      : handlers;
  // Boolean expression of the output. Falls back to "non-SP" when the
  // walker bailed (bridge / pass topology) — that's an interesting
  // signal in itself so we keep the line visible rather than hiding it.
  const exprText = domain.logic
    ? `${netName(domain.outputNetIds[0] ?? -1)} = ${formatBoolExpr(domain.logic, netName)}`
    : "non-SP (no boolean form)";
  return (
    <Row
      handlers={rowHandlers}
      subline={
        <span style={{ fontFamily: "var(--mono)" }}>{exprText}</span>
      }
    >
      <span
        className="m"
        style={{ color: "var(--ink2)", fontSize: 10, fontWeight: 600 }}
      >
        out: {domain.outputNetIds.map((n) => netName(n)).join(", ")}
      </span>
      {domain.gate && <GateChip gate={domain.gate} />}
      <span
        className="m"
        style={{ marginLeft: "auto", fontSize: 9.5, color: "var(--ink3)" }}
      >
        {domain.pmosTransistorIds.length}P · {domain.nmosTransistorIds.length}N ·{" "}
        {domain.inputNetIds.length} in
      </span>
      {onOpen && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          title={active ? "currently shown in schematic tab" : "open in schematic tab"}
          style={{
            background: "transparent",
            border: 0,
            padding: "2px 4px",
            margin: "0 -4px 0 4px",
            cursor: "pointer",
            color: active ? "var(--accent)" : "var(--ink3)",
            fontFamily: "var(--mono)",
            fontSize: 11,
            lineHeight: 1,
          }}
        >
          {active ? "●" : "›"}
        </button>
      )}
    </Row>
  );
}

function TGRow({ tg, handlers }: { tg: TransmissionGate; handlers: RowHandlers }) {
  return (
    <Row handlers={handlers}>
      <span
        className="m"
        style={{ color: "var(--ink2)", fontSize: 10, fontWeight: 600 }}
      >
        net{tg.bridgedNetIds[0]} ↔ net{tg.bridgedNetIds[1]}
      </span>
      <span
        className="m"
        style={{ marginLeft: "auto", fontSize: 9.5, color: "var(--ink3)" }}
        title="control nets (PMOS gate, NMOS gate) — usually complementary"
      >
        ctrl: net{tg.controlPmosGateNetId} / net{tg.controlNmosGateNetId}
      </span>
    </Row>
  );
}

// ── Hover/click plumbing ─────────────────────────────────────────

interface RowHandlers {
  /** True when any of this row's shape keys is in the canvas's current
   *  selection or hover set. Drives the left-border accent. */
  highlighted: boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onClick: () => void;
}

/** Look-up table built once per render: shapeId → ExtractedShape. The shape
 *  list is small (tens of entries for a typical cell) so a Map is fine; we
 *  use it both to read each shape's `layer` and to fold sub-regions back to
 *  their parent diffusion when building selection keys. */
function indexShapes(shapes: ExtractedShape[]): Map<string, ExtractedShape> {
  const m = new Map<string, ExtractedShape>();
  for (const s of shapes) m.set(s.id, s);
  return m;
}

/**
 * Convert any mix of user-drawn shape ids and diffusion sub-region ids into
 * the canvas's selection-key format (`${layer}:${id}`). Sub-regions fold up
 * to their parent diffusion id — they aren't user-drawn shapes, so picking
 * them on the canvas wouldn't make sense. Unknown ids are silently dropped.
 */
function shapesToSelectionKeys(
  index: Map<string, ExtractedShape>,
  ids: Iterable<string>,
): Set<string> {
  const out = new Set<string>();
  for (const id of ids) {
    const shape = index.get(id);
    if (shape?.parentDiffId) {
      out.add(shapeKey("diffusion" as LayerType, shape.parentDiffId));
    } else if (shape) {
      out.add(shapeKey(shape.layer, shape.id));
    } else {
      // Unindexed id — could be a transistor or net id that snuck through.
      // Quietly skip; the no-shapes case is handled by the caller's `bind`.
    }
  }
  return out;
}

/** Union the shape ids touched by every transistor in a CMOS domain. */
function domainShapeIds(
  domain: CmosDomain,
  transistors: Transistor[],
): string[] {
  const byId = new Map(transistors.map((t) => [t.id, t]));
  const ids = new Set<string>();
  for (const id of [...domain.pmosTransistorIds, ...domain.nmosTransistorIds]) {
    const t = byId.get(id);
    if (!t) continue;
    ids.add(t.gate.shapeId);
    ids.add(t.source.shapeId);
    ids.add(t.drain.shapeId);
  }
  return Array.from(ids);
}

/** Same as `domainShapeIds`, for TGs. */
function tgShapeIds(tg: TransmissionGate, transistors: Transistor[]): string[] {
  const byId = new Map(transistors.map((t) => [t.id, t]));
  const ids = new Set<string>();
  for (const id of [tg.pmosTransistorId, tg.nmosTransistorId]) {
    const t = byId.get(id);
    if (!t) continue;
    ids.add(t.gate.shapeId);
    ids.add(t.source.shapeId);
    ids.add(t.drain.shapeId);
  }
  return Array.from(ids);
}

// ── Tiny shared bits ─────────────────────────────────────────────

/**
 * Standard-cell label chip ("NAND2", "AOI21", …). Compound shapes get a
 * dimmer treatment because the matcher couldn't fit them into a single
 * library cell — the user reads the boolean form on the subline for
 * those.
 */
function GateChip({ gate }: { gate: GateMatch }) {
  const isCompound = gate.kind === "compound";
  const color = isCompound ? "var(--ink3)" : "var(--ok)";
  return (
    <span
      className="m"
      style={{
        fontSize: 9,
        padding: "1px 4px",
        background: "transparent",
        border: `1px solid ${color}`,
        borderRadius: 2,
        color,
        letterSpacing: 0.4,
        fontWeight: 600,
      }}
      title={isCompound ? "doesn't match a single library cell" : undefined}
    >
      {gateLabel(gate)}
    </span>
  );
}

/**
 * Small SVG preview of a recognised gate symbol. Used in the cell-level
 * header for at-a-glance "did the matcher get it right?" confirmation.
 *
 * Padding around the symbol gives the bubble + back-curve overhang
 * (XOR's extra arc, NAND's output bubble) room to breathe without
 * clipping. The viewBox sizes itself to the symbol's bounding box plus
 * that padding.
 */
function GatePreview({ gate, scale = 1 }: { gate: GateMatch; scale?: number }) {
  const rendered = renderGateSymbol(gate);
  const pad = 6;
  // The XOR back curve overhangs to the left of the body by ~5px; give
  // it (and any input wire stubs) horizontal room. We also draw short
  // wire stubs poking out of every pin so the symbol reads as "wired"
  // rather than floating.
  const stubLen = 6;
  const vbW = rendered.width + 2 * pad + 2 * stubLen;
  const vbH = rendered.height + 2 * pad;
  return (
    <svg
      width={vbW * scale}
      height={vbH * scale}
      viewBox={`${-pad - stubLen} ${-pad} ${vbW} ${vbH}`}
      style={{ flex: "0 0 auto", display: "block" }}
      aria-label={gateLabel(gate)}
    >
      {/* Input stubs poking left out of the symbol. */}
      {rendered.inputs.map((p, i) => (
        <line
          key={`in-${i}`}
          x1={p.x - stubLen}
          y1={p.y}
          x2={p.x}
          y2={p.y}
          stroke="var(--ink2)"
          strokeWidth={1.5}
        />
      ))}
      {/* Output stub poking right. */}
      <line
        x1={rendered.output.x}
        y1={rendered.output.y}
        x2={rendered.output.x + stubLen}
        y2={rendered.output.y}
        stroke="var(--ink2)"
        strokeWidth={1.5}
      />
      {rendered.svg}
    </svg>
  );
}

function RoleChip({ text, color }: { text: string; color: string }) {
  return (
    <span
      className="m"
      style={{
        fontSize: 9,
        padding: "1px 4px",
        background: "transparent",
        border: `1px solid ${color}`,
        borderRadius: 2,
        color,
        textTransform: "uppercase",
        letterSpacing: 0.4,
      }}
    >
      {text}
    </span>
  );
}

function roleColorFor(role: ExtractedNet["role"]): string {
  switch (role) {
    case "vcc":
      return "var(--err)";
    case "gnd":
      return "var(--accent)";
    case "output":
      return "var(--ok)";
    case "input":
      return "var(--ink2)";
    case "io":
      return "var(--warn)";
    case "pass":
      return "var(--warn)";
    case "internal":
      return "var(--ink3)";
    case "unused":
      return "var(--muted)";
    default:
      return "var(--ink3)";
  }
}

function transistorRoleColor(role: Transistor["role"]): string {
  switch (role) {
    case "pun":
      return "#c45a90";
    case "pdn":
      return "#3c8aa0";
    case "tg":
      return "var(--warn)";
    case "pass":
      return "var(--warn)";
    case "dummy":
      return "var(--ink3)";
    case "unknown":
      return "var(--err)";
    default:
      return "var(--ink3)";
  }
}

function Row({
  children,
  handlers,
  subline,
  onContextMenu,
}: {
  children: ReactNode;
  /** Optional — header / non-interactive rows can omit. */
  handlers?: RowHandlers;
  /** Optional secondary line rendered below the main content (e.g. a
   *  domain row's boolean expression). Inherits the row's hover/click
   *  region so the user can still mouse over the whole strip. */
  subline?: ReactNode;
  /** Optional right-click handler — row-type-specific (e.g. net rows
   *  open a label menu, diffusion rows a forced-type menu). */
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  // Left-border accent + slight tint when this row's shapes are part of the
  // canvas's current selection or hover target. Keeps the inverse mapping
  // (shape → row) discoverable without taking over the row's own styling.
  const highlighted = handlers?.highlighted ?? false;
  const inner = (
    <div
      className="row"
      style={{ gap: 6, alignItems: "center", minHeight: 22 }}
    >
      {children}
    </div>
  );
  return (
    <div
      style={{
        padding: "4px 9px",
        paddingLeft: highlighted ? 9 : 12,
        borderBottom: "1px solid var(--l1)",
        borderLeft: highlighted ? "3px solid var(--accent)" : "0",
        background: highlighted ? "var(--accentBg)" : "transparent",
        cursor: handlers ? "pointer" : "default",
      }}
      onMouseEnter={handlers?.onMouseEnter}
      onMouseLeave={handlers?.onMouseLeave}
      onClick={handlers?.onClick}
      onContextMenu={onContextMenu}
    >
      {inner}
      {subline != null && (
        <div
          className="m"
          style={{
            marginTop: 2,
            fontSize: 10,
            color: "var(--ink3)",
            wordBreak: "break-all",
          }}
        >
          {subline}
        </div>
      )}
    </div>
  );
}

function List({ children }: { children: ReactNode }) {
  return <div style={{ display: "flex", flexDirection: "column" }}>{children}</div>;
}

/** A collapsible result section with cardinality on the right. */
function Section({
  title,
  count,
  children,
  header,
  defaultOpen = true,
}: {
  title: string;
  count: number | string | null;
  children: ReactNode;
  /** Extra inline content rendered between the title and the cardinality
   *  (e.g. severity chips for Warnings). */
  header?: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    setOpen(defaultOpen);
  }, [defaultOpen]);
  return (
    <div style={{ borderBottom: "1px solid var(--l2)" }}>
      <button
        type="button"
        className="row"
        onClick={() => setOpen((o) => !o)}
        style={{
          width: "100%",
          padding: "6px 10px",
          gap: 6,
          background: "var(--panel)",
          border: 0,
          cursor: "pointer",
          alignItems: "center",
        }}
      >
        <span style={{ color: "var(--ink3)", display: "inline-flex" }}>
          {open ? Ic.caretD : Ic.caretR}
        </span>
        <span
          className="u"
          style={{
            fontSize: 10,
            color: "var(--ink2)",
            letterSpacing: 0.6,
            textAlign: "left",
          }}
        >
          {title}
        </span>
        {header}
        <span style={{ flex: 1 }} />
        {count != null && (
          <span className="m" style={{ fontSize: 10, color: "var(--ink3)" }}>
            {count}
          </span>
        )}
      </button>
      {open && children}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div
      className="m"
      style={{ padding: "8px 14px", fontSize: 10.5, color: "var(--ink3)", fontStyle: "italic" }}
    >
      {children}
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  width: 300,
  flex: "0 0 auto",
  background: "var(--card)",
  borderLeft: "1px solid var(--l2)",
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
};

// ── Analog Device Row (editable params) ────────────────────

const DEVICE_COLORS: Record<string, string> = {
  mos: "#4488ff", bjt_npn: "#22cc66", bjt_pnp: "#ff8844",
  jfet_n: "#aa44ff", jfet_p: "#aa44ff",
  resistor: "#ffaa44", capacitor: "#44ddff",
  diode: "#ff4444", zener: "#ff6666", schottky: "#dd6666",
  inductor: "#66aaff", unknown: "#888888",
};

/**
 * Render the physical-type tag for an analog device. Surfaces the actual
 * nmos/pmos/npn/pnp distinction (encoded in `geometry.mosType` /
 * `geometry.bjtType`) instead of the raw `kind` value, so a `mos` device
 * reads as "nmos" or "pmos" in the right panel rather than the generic
 * "mos". Mirrors the canvas overlay's `physicalType()` helper so both
 * surfaces agree on what to call each device.
 */
function analogDeviceTypeLabel(device: AnalogDevice): string {
  const g = device.geometry as unknown as Record<string, unknown>;
  switch (device.kind) {
    case "mos": {
      const t = g.mosType as string | undefined;
      return t === "pmos" ? "pmos" : t === "nmos" ? "nmos" : "mos";
    }
    case "bjt_npn": return "npn";
    case "bjt_pnp": return "pnp";
    case "jfet_n": return "n-jfet";
    case "jfet_p": return "p-jfet";
    default: return device.kind;
  }
}

/** Stable empty record used as zustand selector sentinel — avoids
 *  creating a new `{}` every render (which triggers infinite re-render
 *  via useSyncExternalStore's snapshot comparison). */
const NO_OVERRIDES: Record<string, number> = {};

interface AnalogDeviceRowProps {
  device: import("shared").AnalogDevice;
  cellTypeId: string;
  /** Called when user overrides a parameter. Stored in preferences. */
  onOverride?: (deviceId: string, param: string, value: number) => void;
}

function AnalogDeviceRow({ device, cellTypeId, onOverride }: AnalogDeviceRowProps) {
  const color = DEVICE_COLORS[device.kind] ?? "#888";
  const g = device.geometry as unknown as Record<string, unknown>;
  const fingerprint = (device as any)._cellLevelKey as string | undefined ?? device.id;
  // Cell RE works at the cell-type level, so it uses the *template* UUID
  // (one identity per device-in-cell-type). Per-instance UUIDs are
  // created later by the die-level pipeline and live in their own records.
  const templateUuid = (device as any)._templateUuid as string | undefined;
  // Subscribe to the registry version so this row re-renders when overrides
  // change (the registry is plain localStorage, not a reactive store).
  const [registryTick, setRegistryTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      // Poll the registry version — cheap integer compare. This picks up
      // cross-component writes (e.g. DeviceInspector rename) without
      // coupling the registry to React.
      setRegistryTick(getRegistryVersion());
    }, 200);
    return () => clearInterval(id);
  }, []);

  // Prefer the device registry (UUID-keyed). Fall back to legacy
  // preferences.analogOverrides keyed by (cellTypeId, _cellLevelKey) while
  // migration is still pending.
  const legacyOverrides = usePreferences((s) =>
    (s as any).analogOverrides?.[cellTypeId]?.[fingerprint] ?? NO_OVERRIDES
  ) as Record<string, number>;
  const overrides = templateUuid
    ? (getDeviceRecord(templateUuid)?.overrides ?? legacyOverrides)
    : legacyOverrides;
  // Reference registryTick so React keeps the subscription alive.
  void registryTick;

  // Specific capacitance per unit area [fF/μm²].
  const capDensity = usePreferences((s) => s.capDensity);
  const label = device.instanceName ?? device.id;
  // Physical type (nmos/pmos/npn/pnp/...) rather than the raw kind value,
  // so the panel agrees with the canvas overlay (see physicalType in
  // CellRECanvas.tsx).
  const subtitle = analogDeviceTypeLabel(device);

  // Helper: get effective value (override → extracted)
  const eff = (key: string, fallback: number): number =>
    overrides[key] ?? (g[key] as number) ?? fallback;
  const isOverridden = (key: string) => overrides[key] != null;
  const setOv = (paramKey: string, val: number) => onOverride?.(fingerprint, paramKey, val);

  // One-line param summary
  let paramStr = "";
  switch (device.kind) {
    case "mos":
      paramStr = `W=${eff("W_um", 0).toFixed(1)} L=${eff("L_um", 0).toFixed(2)}`;
      if ((g.fingers as number) > 1) paramStr += ` NF=${g.fingers}`;
      break;
    case "bjt_npn":
      paramStr = `AE=${eff("AE_um2", 0).toFixed(2)}μm²`;
      break;
    case "bjt_pnp": {
      const pe = eff("PE_um", 0);
      paramStr = pe > 0 ? `PE=${pe.toFixed(1)}μm` : `AE=${eff("AE_um2", 0).toFixed(2)}μm²`;
      break;
    }
    case "resistor": {
      const sq = eff("squares", 0);
      const type = ((g as any).resistorType ?? "poly") as ResistorType;
      const sheetROverrides = usePreferences.getState().sheetR ?? {};
      const sr = effectiveSheetR(type, sheetROverrides);
      paramStr = `${sq.toFixed(1)}sq ${Math.round(sr * sq)}Ω`;
      break;
    }
    case "capacitor": {
      const area = eff("area_um2", 0);
      // The capacitance comes from the plate area × the specific
      // capacitance, unless the user pinned it by hand.
      const cFf = isOverridden("capacitance_fF")
        ? eff("capacitance_fF", 0)
        : effectiveCapacitance(
            { area_um2: area, capacitance_fF: g.capacitance_fF as number | undefined },
            capDensity,
          );
      paramStr = `${area.toFixed(1)}μm²`;
      if (cFf != null) paramStr += ` ${cFf.toFixed(2)}fF`;
      break;
    }
    case "diode":
      paramStr = `${eff("area_um2", 0).toFixed(1)}μm²`;
      break;
  }

  // Editable parameter groups by device kind
  const editableParams = useMemo<(keyof typeof g & string)[]>(() => {
    switch (device.kind) {
      case "mos": return ["W_um", "L_um", "fingers", "multiplier"];
      case "bjt_npn": case "bjt_pnp": return ["AE_um2", "PE_um", "multiplier"];
      case "resistor": return ["squares", "L_um"];
      case "capacitor": return ["area_um2", "capacitance_fF"];
      case "diode": return ["area_um2"];
      default: return [];
    }
  }, [device.kind]);

  return (
    <div
      style={{
        display: "flex", gap: 8, padding: "6px 12px", cursor: "default",
        borderBottom: "1px solid var(--l2)",
      }}
    >
      <span
        style={{
          width: 12, height: 12, borderRadius: "50%",
          background: color, flex: "0 0 auto", marginTop: 2,
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>{label}</span>
          <span className="m" style={{ fontSize: 10, color: "var(--ink3)" }}>
            {subtitle}
          </span>
        </div>
        {paramStr && (
          <div style={{ fontSize: 10, color: "var(--ink3)", marginTop: 2, marginBottom: 2 }}>
            {paramStr}
          </div>
        )}
        {/* Always-visible override inputs */}
        {editableParams.length > 0 && (
          <div
            style={{
              display: "flex", flexWrap: "wrap", gap: 6,
              marginTop: 6, padding: 6,
              background: "var(--l1)", borderRadius: 4,
            }}
          >
            {editableParams.map((key) => {
              const val = eff(key, 0);
              const over = isOverridden(key);
              return (
                <label
                  key={key}
                  style={{
                    display: "flex", alignItems: "center", gap: 3,
                    fontSize: 9.5, color: over ? "var(--accent)" : "var(--ink2)",
                  }}
                >
                  <span style={{ minWidth: 0, whiteSpace: "nowrap" }}>{key.replace("_", " ")}:</span>
                  <input
                    type="number"
                    step="any"
                    value={val}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      if (!isNaN(v)) setOv(key, v);
                    }}
                    style={{
                      width: 55, height: 20,
                      fontSize: 9.5, fontFamily: "var(--mono)",
                      background: over ? "var(--accentBg)" : "var(--bg1)",
                      border: `1px solid ${over ? "var(--accent)" : "var(--border)"}`,
                      borderRadius: 3, color: "var(--ink0)",
                      padding: "0 4px",
                    }}
                  />
                  {over && (
                    <span
                      style={{
                        fontSize: 8, cursor: "pointer", color: "var(--err)",
                        padding: "0 2px",
                      }}
                      onClick={() => setOv(key, (g[key] as number) ?? 0)}
                      title="Reset to extracted value"
                    >↺</span>
                  )}
                </label>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
