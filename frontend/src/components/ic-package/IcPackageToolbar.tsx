import { ToolDivider } from "../shell/SubBar";
import { useIcPackageStore, type IcPackageTool } from "../../state/icPackage";

interface ToolbarProps {
  /** Click handler for "Apply to Die Viewer pins" — write package pin names
   * back to annotations.pins[]. */
  onApplyToDieViewer: () => void;
  /** Disable Apply when no named bonds exist. */
  applyDisabled: boolean;
  /** Export the pin-planner scene as a document-friendly PNG. */
  onExportPng: () => void;
  /** Export the pin table as CSV. */
  onExportCsv: () => void;
  /** Optional right-aligned extra content (status, layer selector). */
  right?: React.ReactNode;
}

const TOOLS: Array<{ kind: IcPackageTool; icon: string; key: string; label: string }> = [
  { kind: "pan", icon: "✥", key: "S", label: "Pan / zoom — drag canvas, scroll to zoom" },
  { kind: "name", icon: "Aa", key: "T", label: "Name — click a package pin to set its name" },
  { kind: "bond", icon: "↔", key: "W", label: "Bond — click pin, then click die pad" },
];

export function IcPackageToolbar({ onApplyToDieViewer, applyDisabled, onExportPng, onExportCsv, right }: ToolbarProps) {
  const tool = useIcPackageStore((s) => s.tool);
  const setTool = useIcPackageStore((s) => s.setTool);
  const bondWireWidthUm = useIcPackageStore((s) => s.bondWireWidthUm);
  const setBondWireWidthUm = useIcPackageStore((s) => s.setBondWireWidthUm);
  return (
    <div
      style={{
        height: 38,
        borderBottom: "1px solid var(--l2)",
        background: "var(--card)",
        display: "flex",
        alignItems: "center",
        padding: "0 8px",
        gap: 4,
        flex: "0 0 auto",
      }}
    >
      <span className="u" style={{ fontSize: 10, color: "var(--ink3)", margin: "0 4px 0 2px" }}>
        tools
      </span>
      {TOOLS.map((t) => (
        <button
          key={t.kind}
          type="button"
          title={`${t.label} (${t.key.toUpperCase()})`}
          onClick={() => setTool(t.kind)}
          className={"chip" + (tool === t.kind ? " on" : "")}
          style={{
            minWidth: 28,
            height: 24,
            cursor: "pointer",
            fontWeight: 600,
            fontSize: 12,
            justifyContent: "center",
          }}
        >
          {t.icon}
        </button>
      ))}
      <ToolDivider />
      <span className="u" style={{ fontSize: 9, color: "var(--ink3)", marginRight: 4 }}>
        S pan · T text · W bond
      </span>
      <ToolDivider />
      <button
        type="button"
        className="chip"
        onClick={onApplyToDieViewer}
        disabled={applyDisabled}
        title="Copy package pin names to die viewer pads (annotations.pins[].name)"
        style={{
          fontSize: 11,
          cursor: applyDisabled ? "default" : "pointer",
          opacity: applyDisabled ? 0.5 : 1,
        }}
      >
        Apply to Die Viewer pins
      </button>
      <ToolDivider />
      <button
        type="button"
        className="chip"
        onClick={onExportPng}
        title="Export pin planner as a white-background PNG for documents"
        style={{ fontSize: 11, cursor: "pointer" }}
      >
        Export PNG
      </button>
      <button
        type="button"
        className="chip"
        onClick={onExportCsv}
        title="Export the pin table as CSV"
        style={{ fontSize: 11, cursor: "pointer" }}
      >
        Export pins (CSV)
      </button>
      <ToolDivider />
      <label className="u" style={{ fontSize: 10, color: "var(--ink3)", marginLeft: 4 }}>
        wire
      </label>
      <input
        type="number"
        min={1}
        value={bondWireWidthUm}
        onChange={(e) => setBondWireWidthUm(Number(e.target.value))}
        style={{ width: 52, fontSize: 11, padding: "2px 4px" }}
        title="Bond wire thickness in µm (default 15)"
      />
      <span className="u" style={{ fontSize: 10, color: "var(--ink3)" }}>um</span>
      <div style={{ flex: 1 }} />
      {right}
    </div>
  );
}
