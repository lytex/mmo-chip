/**
 * findingsToSubcircuits — Convert LLM assistant findings to SubcircuitEntry array.
 *
 * Uses the same data format as the real AI fragment:
 * - Real terminal net names (from namedNets map)
 * - Real resistance/capacitance values (from device geometry)
 * - Correct terminal order per device kind
 */

import type { AssistantFinding, AnalogDevice, DeviceGeometryResistor, DeviceGeometryCapacitor, DeviceGeometryBJT, SpiceConfig } from "shared";
import type { SubcircuitEntry } from "../../components/simulation/SubcircuitPicker";
import { effectiveSheetR } from "../export/resistorDefaults";

/**
 * Extract device instance names from netlist text.
 * Handles both formats:
 *   Spectre: "Q11 (ref Net_37 GND 0) npn" → "Q11"
 *   SPICE:   "Q11 C B E npn"               → "Q11"
 */
export function extractDeviceNames(netlist: string): string[] {
  const names: string[] = [];
  for (const line of netlist.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("*") || t.startsWith(".") || t.startsWith("//")) continue;
    const match = t.match(/^([A-Za-z][A-Za-z0-9_]*)\s/);
    if (match) names.push(match[1]);
  }
  return names;
}

const TERMINAL_ORDER: Record<string, string[]> = {
  mos: ["D", "G", "S", "B"],
  bjt_npn: ["C", "B", "E"],
  bjt_pnp: ["C", "B", "E"],
  jfet_n: ["D", "G", "S", "B"],
  jfet_p: ["D", "G", "S", "B"],
  resistor: ["PLUS", "MINUS"],
  capacitor: ["PLUS", "MINUS"],
  diode: ["PLUS", "MINUS"],
  zener: ["PLUS", "MINUS"],
  schottky: ["PLUS", "MINUS"],
  inductor: ["PLUS", "MINUS"],
};

const MODEL_TOKEN: Record<string, string> = {
  mos: "nmos",
  bjt_npn: "npn",
  bjt_pnp: "pnp",
  jfet_n: "njf",
  jfet_p: "pjf",
  resistor: "resistor",
  capacitor: "capacitor",
  diode: "diode",
  zener: "diode",
  schottky: "diode",
  inductor: "inductor",
};

/**
 * Format a device line in Spectre netlist format (matching the real AI fragment).
 */
function formatDeviceLine(
  device: AnalogDevice,
  namedNets: Map<number, string>,
  config: SpiceConfig,
): string {
  const instName = device.instanceName ?? device.id;
  const order = TERMINAL_ORDER[device.kind] ?? [];

  // Resolve terminal net names
  const terminals = order.map((role) => {
    const t = device.terminals.find((tt) => tt.name === role);
    if (!t) return "0";
    return namedNets.get(t.netId) ?? `n${t.netId}`;
  });

  const token = MODEL_TOKEN[device.kind] ?? device.kind;
  const g = device.geometry;

  switch (device.kind) {
    case "bjt_npn":
    case "bjt_pnp": {
      const bg = g as DeviceGeometryBJT;
      const m = bg.multiplier && bg.multiplier > 1 ? ` m=${bg.multiplier}` : "";
      return `  ${instName} (${terminals.join(" ")}) ${token}${m}`;
    }
    case "resistor": {
      const rg = g as DeviceGeometryResistor;
      const rType = (rg.resistorType ?? "poly") as any;
      const sr = effectiveSheetR(rType, config?.sheetR_ohms);
      const rOhms = Math.round((rg.squares ?? 1) * sr);
      return `  ${instName} (${terminals.join(" ")}) ${token} r=${rOhms}`;
    }
    case "capacitor": {
      const cg = g as DeviceGeometryCapacitor;
      const cFf = cg.capacitance_fF ?? (cg.area_um2 ?? 1) * 2;
      return `  ${instName} (${terminals.join(" ")}) ${token} c=${cFf.toFixed(1)}f`;
    }
    case "diode":
    case "zener":
    case "schottky":
      return `  ${instName} (${terminals.join(" ")}) ${token}`;
    case "mos":
      return `  ${instName} (${terminals.join(" ")}) ${token}`;
    default:
      return `  ${instName} (${terminals.join(" ")}) ${token}`;
  }
}

/**
 * Convert assistant findings to subcircuit entries for the spice sim page.
 * Each finding becomes a selectable DUT with its own netlist.
 */
export function findingsToSubcircuits(
  findings: AssistantFinding[],
  allDevices: AnalogDevice[],
  namedNets: Map<number, string>,
  config: SpiceConfig = {},
): SubcircuitEntry[] {
  if (!findings || findings.length === 0) return [];

  // Build UUID → device lookup
  const deviceByUuid = new Map<string, AnalogDevice>();
  for (const d of allDevices) {
    const uuid = String((d as any)._uuid ?? d.id);
    deviceByUuid.set(uuid, d);
  }

  const entries: SubcircuitEntry[] = [];

  for (const finding of findings) {
    if (!finding.deviceUuids || finding.deviceUuids.length === 0) continue;

    const devices = finding.deviceUuids
      .map((uuid) => deviceByUuid.get(uuid))
      .filter((d): d is AnalogDevice => Boolean(d));

    if (devices.length === 0) continue;

    // Generate device lines matching the real AI fragment format
    const lines = devices.map((d) => formatDeviceLine(d, namedNets, config));
    const netlist = lines.join("\n");
    const name = finding.label || `finding_${finding.id.slice(0, 8)}`;
    const deviceNames = devices.map((d) => d.instanceName ?? d.id);

    entries.push({
      name: `${name} (AI)`,
      netlist,
      deviceCount: devices.length,
      source: "ai",
      deviceNames,
    });
  }

  return entries;
}
