/**
 * SubcircuitPicker — left panel listing all .subckt blocks from the netlist,
 * the full netlist, and AI-generated subcircuit fragments.
 *
 * Clicking a subcircuit selects it as the DUT and loads its netlist
 * into the directive editor.
 */

import { useMemo } from "react";
import { extractDeviceNames } from "../../lib/simulation/findingsToSubcircuits";

export type SubcircuitEntry = {
  name: string;
  /** Lines of the .subckt ... .ends block */
  netlist: string;
  /** Number of devices inside */
  deviceCount: number;
  source: "netlist" | "ai" | "manual";
  /** Instance names of devices in this subcircuit (for schematic filtering). */
  deviceNames?: string[];
};

type Props = {
  subcircuits: SubcircuitEntry[];
  selected: string | null;
  onSelect: (name: string | null) => void;
};

/**
 * Parse .subckt blocks from a full SPICE netlist.
 */
export function parseSubcircuits(netlist: string): SubcircuitEntry[] {
  const entries: SubcircuitEntry[] = [];
  const lines = netlist.split("\n");
  let inSubckt = false;
  let current: string[] = [];
  let currentName = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.toUpperCase().startsWith(".SUBCKT")) {
      inSubckt = true;
      currentName = trimmed.split(/\s+/)[1] ?? "unknown";
      current = [line];
    } else if (trimmed.toUpperCase().startsWith(".ENDS")) {
      current.push(line);
      entries.push({
        name: currentName,
        netlist: current.join("\n"),
        deviceCount: current.filter((l) => {
          const t = l.trim().toUpperCase();
          return !t.startsWith(".") && !t.startsWith("*") && !t.startsWith("//") && t.length > 0;
        }).length,
        source: "netlist",
        deviceNames: extractDeviceNames(current.join("\n")),
      });
      inSubckt = false;
      current = [];
      currentName = "";
    } else if (inSubckt) {
      current.push(line);
    }
  }

  return entries;
}

/**
 * Filter out the top-level module (last .subckt in netlist, named after the project).
 */
export function filterTopLevel(entries: SubcircuitEntry[]): SubcircuitEntry[] {
  if (entries.length <= 1) return entries;
  // The last netlist entry is the top-level module — remove it.
  return entries.filter((e, i) => !(e.source === "netlist" && i === entries.length - 1));
}

export function SubcircuitPicker({ subcircuits, selected, onSelect }: Props) {
  const grouped = useMemo(() => {
    const bySource: Record<string, SubcircuitEntry[]> = {
      netlist: [],
      ai: [],
      manual: [],
    };
    for (const s of subcircuits) {
      (bySource[s.source] ?? bySource.netlist).push(s);
    }
    return bySource;
  }, [subcircuits]);

  const totalDevices = subcircuits.reduce((sum, s) => sum + s.deviceCount, 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, overflow: "auto", flex: 1 }}>
      {/* Full netlist option */}
      <div
        onClick={() => onSelect(null)}
        style={{
          padding: "6px 10px",
          cursor: "pointer",
          fontSize: 11,
          background: selected === null ? "var(--l1, #1a1a2e)" : "transparent",
          borderLeft: selected === null ? "2px solid var(--accent, #4a9eff)" : "2px solid transparent",
          color: "var(--ink, #ccc)",
        }}
      >
        <div style={{ fontWeight: 600 }}>Full Netlist</div>
        <div style={{ fontSize: 10, color: "var(--ink3, #666)" }}>
          {subcircuits.length} subcircuits · {totalDevices} devices
        </div>
      </div>

      {grouped.netlist.length > 0 && (
        <GroupSection title="From Netlist" entries={grouped.netlist} selected={selected} onSelect={onSelect} />
      )}
      {grouped.ai.length > 0 && (
        <GroupSection title="AI Hypotheses" entries={grouped.ai} selected={selected} onSelect={onSelect} />
      )}
      {grouped.manual.length > 0 && (
        <GroupSection title="Manual" entries={grouped.manual} selected={selected} onSelect={onSelect} />
      )}

      {subcircuits.length === 0 && (
        <div style={{ padding: 12, fontSize: 11, color: "var(--ink3, #666)", textAlign: "center" }}>
          No .subckt blocks found. Load a netlist first.
        </div>
      )}
    </div>
  );
}

function GroupSection({
  title,
  entries,
  selected,
  onSelect,
}: {
  title: string;
  entries: SubcircuitEntry[];
  selected: string | null;
  onSelect: (name: string) => void;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 9,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          color: "var(--ink3, #666)",
          padding: "8px 10px 2px",
        }}
      >
        {title}
      </div>
      {entries.map((entry) => (
        <div
          key={entry.name}
          onClick={() => onSelect(entry.name)}
          style={{
            padding: "5px 10px",
            cursor: "pointer",
            fontSize: 11,
            fontFamily: "var(--font-mono, monospace)",
            background: selected === entry.name ? "var(--l1, #1a1a2e)" : "transparent",
            borderLeft: selected === entry.name
              ? "2px solid var(--accent, #4a9eff)"
              : "2px solid transparent",
            color: "var(--ink, #ccc)",
          }}
        >
          <div style={{ fontWeight: 500 }}>{entry.name}</div>
          <div style={{ fontSize: 10, color: "var(--ink3, #666)" }}>
            {entry.deviceCount} devices
          </div>
        </div>
      ))}
    </div>
  );
}
