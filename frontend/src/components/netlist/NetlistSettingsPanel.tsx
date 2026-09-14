/**
 * NetlistSettingsPanel.tsx — Settings modal for the Netlist schematic tabs
 * (Static + Interactive engines). Mirrors the die viewer SettingsPanel
 * (modal + ESC-to-close) but scoped to schematic renderer controls:
 *
 *   - shared layout (strategy / direction / compaction)
 *   - fine spacing / behavior toggles (edge gaps, merge, straight edges)
 *
 * The Interactive engine forwards these into `AnalogLayoutOptions`;
 * the Static engine uses them via the existing netlist2svg skin selectors.
 */

import { useEffect, useRef } from "react";
import {
  LAYOUT_STRATEGIES,
  LAYOUT_DIRECTIONS,
  COMPACTION_LEVELS,
  type LayoutStrategy,
  type LayoutDirection,
  type CompactionLevel,
} from "../../lib/schematic/netlist2svgSkin";

type Props = {
  open: boolean;
  onClose: () => void;
  // Shared layout
  layoutStrategy: LayoutStrategy;
  setLayoutStrategy: (v: LayoutStrategy) => void;
  layoutDirection: LayoutDirection;
  setLayoutDirection: (v: LayoutDirection) => void;
  compactionLevel: CompactionLevel;
  setCompactionLevel: (v: CompactionLevel) => void;
  // Fine spacing / behavior (interactive engine)
  nodeNode: number | undefined;
  setNodeNode: (v: number | undefined) => void;
  betweenLayers: number | undefined;
  setBetweenLayers: (v: number | undefined) => void;
  edgeEdge: number | undefined;
  setEdgeEdge: (v: number | undefined) => void;
  edgeNode: number | undefined;
  setEdgeNode: (v: number | undefined) => void;
  favorStraightEdges: boolean;
  setFavorStraightEdges: (v: boolean) => void;
  showIoPins: boolean;
  setShowIoPins: (v: boolean) => void;
  showHierarchy: boolean;
  setShowHierarchy: (v: boolean) => void;
  showLegacyStatic: boolean;
  setShowLegacyStatic: (v: boolean) => void;
  dragMode: "surgical" | "full";
  setDragMode: (v: "surgical" | "full") => void;
};

const labelStyle: React.CSSProperties = {
  fontSize: 10, color: "var(--ink3)", marginBottom: 3, display: "block",
};

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "5px 8px", fontSize: 11,
  background: "var(--l1)", border: "1px solid var(--l2)",
  borderRadius: 4, color: "#fff", outline: "none",
  boxSizing: "border-box",
};

const btnBase: React.CSSProperties = {
  flex: 1, padding: "5px 8px", fontSize: 11, cursor: "pointer",
  background: "var(--l1)", border: "1px solid var(--l2)",
  borderRadius: 4, color: "var(--ink2)", outline: "none", textAlign: "center",
};
const btnActive: React.CSSProperties = {
  background: "var(--accent)", borderColor: "var(--accent)", color: "#fff",
};

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", cursor: "pointer" }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ margin: 0 }} />
      <span style={{ fontSize: 11, color: "var(--ink2)" }}>{label}</span>
    </label>
  );
}

function SelectField<T extends string | number>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string; desc?: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      <select
        value={String(value)}
        onChange={(e) => onChange(options.find((o) => String(o.value) === e.target.value)!.value)}
        style={{ ...inputStyle, cursor: "pointer" }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} title={o.desc}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Number input that reports `undefined` when cleared/empty — lets the
 *  engine fall back to ELK defaults instead of pinning a hard value. */
function OptNumberField({ label, value, onChange, min, max, step, hint }: {
  label: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
}) {
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      <input
        type="number"
        value={value ?? ""}
        placeholder="default"
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") { onChange(undefined); return; }
          const v = Number(raw);
          if (Number.isFinite(v)) onChange(v);
        }}
        style={inputStyle}
      />
      {hint && <div style={{ fontSize: 9, color: "var(--ink3)", lineHeight: 1.4, marginTop: 3 }}>{hint}</div>}
    </div>
  );
}

export function NetlistSettingsPanel({
  open,
  onClose,
  layoutStrategy, setLayoutStrategy,
  layoutDirection, setLayoutDirection,
  compactionLevel, setCompactionLevel,
  nodeNode, setNodeNode,
  betweenLayers, setBetweenLayers,
  edgeEdge, setEdgeEdge,
  edgeNode, setEdgeNode,
  favorStraightEdges, setFavorStraightEdges,
  showIoPins, setShowIoPins,
  showHierarchy, setShowHierarchy,
  showLegacyStatic, setShowLegacyStatic,
  dragMode, setDragMode,
}: Props) {
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={backdropRef}
      onClick={(e) => {
        if (e.target === backdropRef.current) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1100,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        className="dark"
        style={{
          background: "var(--card)",
          border: "1px solid var(--l2)",
          borderRadius: 8,
          boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
          maxWidth: 480,
          width: "90%",
          maxHeight: "80vh",
          overflow: "auto",
          padding: "16px 20px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", marginBottom: 14 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>
            Netlist Settings
          </span>
          <div style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onClose} style={{ fontSize: 11, color: "var(--ink3)" }}>
            Esc to close
          </button>
        </div>

        {/* Shared layout */}
        <div style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: "var(--ink3)", textTransform: "uppercase", letterSpacing: 0.5 }}>
            Layout
          </div>
          <SelectField label="Placement strategy" value={layoutStrategy} options={LAYOUT_STRATEGIES} onChange={setLayoutStrategy} />
          <SelectField label="Flow direction" value={layoutDirection} options={LAYOUT_DIRECTIONS} onChange={setLayoutDirection} />
          <SelectField label="Post-compaction" value={compactionLevel} options={COMPACTION_LEVELS} onChange={setCompactionLevel} />
        </div>

        {/* Fine spacing / behavior (interactive engine) */}
        <div style={{ marginBottom: 4 }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: "var(--ink3)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
            Fine spacing (Interactive)
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <OptNumberField
              label="Device ↔ device gap"
              value={nodeNode}
              onChange={setNodeNode}
              min={0}
              step={5}
              hint="elk.spacing.nodeNode — default 35 (matches static). Raise for a roomier schematic."
            />
            <OptNumberField
              label="Layer → layer gap"
              value={betweenLayers}
              onChange={setBetweenLayers}
              min={0}
              step={1}
              hint="elk.layered.spacing.nodeNodeBetweenLayers — default 5 (matches static)."
            />
            <OptNumberField
              label="Wire ↔ wire gap"
              value={edgeEdge}
              onChange={setEdgeEdge}
              min={0}
              step={2}
              hint="elk.spacing.edgeEdge — default 10. Higher spreads parallel wires apart."
            />
            <OptNumberField
              label="Wire ↔ device gap"
              value={edgeNode}
              onChange={setEdgeNode}
              min={0}
              step={2}
              hint="elk.spacing.edgeNode — default 12. Higher keeps wires further from symbols."
            />
            <Toggle
              label="Prefer straight edges"
              checked={favorStraightEdges}
              onChange={setFavorStraightEdges}
            />
            <div style={{ marginBottom: 10 }}>
              <div style={labelStyle}>Drag re-route <span style={{ color: "var(--ink4)", fontWeight: 400 }}>(Shift = full)</span></div>
              <div style={{ display: "flex", gap: 4 }}>
                <button
                  type="button"
                  onClick={() => setDragMode("surgical")}
                  style={{
                    ...btnBase, ...(dragMode === "surgical" ? btnActive : {}),
                  }}
                >
                  Surgical
                </button>
                <button
                  type="button"
                  onClick={() => setDragMode("full")}
                  style={{
                    ...btnBase, ...(dragMode === "full" ? btnActive : {}),
                  }}
                >
                  Full
                </button>
              </div>
            </div>
            <Toggle
              label="Show die I/O pins"
              checked={showIoPins}
              onChange={setShowIoPins}
            />
            <Toggle
              label="Show hierarchy (floorplan blocks)"
              checked={showHierarchy}
              onChange={setShowHierarchy}
            />
            <div style={{ fontSize: 9, color: "var(--ink3)", lineHeight: 1.4 }}>
              Fine-tuning applies to the Interactive engine. Changing layout settings re-arranges
              the schematic (locked devices stay put). Clearing a gap box returns the ELK default.
            </div>
          </div>
        </div>

        {/* Display — legacy renderer visibility */}
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, color: "var(--ink3)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
            Display
          </div>
          <Toggle
            label="Show legacy static renderer"
            checked={showLegacyStatic}
            onChange={setShowLegacyStatic}
          />
          <div style={{ fontSize: 9, color: "var(--ink3)", lineHeight: 1.4, marginTop: 4 }}>
            The interactive canvas is the default engine. Enable this to restore the legacy
            netlist2svg renderer controls: Static/Interactive toggle, Functional diagram,
            pan/zoom buttons and SVG/PNG/JSON download.
          </div>
        </div>
      </div>
    </div>
  );
}