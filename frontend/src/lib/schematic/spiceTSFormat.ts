/**
 * spiceTSFormat.ts — Generate @spice-ts/core-compatible SPICE netlists
 * from mmo-chip's analog device data.
 *
 * Key differences from CDL/Spectre format:
 *   - Resistors: R a b <value>  (no model name between pins)
 *   - Capacitors: C a b <value> (no model)
 *   - No .PARAM expressions (pre-resolved values)
 *   - .MODEL cards for active devices (MOS, BJT, diode)
 *   - Passives need no .MODEL
 *   - Flat standalone netlist per block (ready for parse() → toIR())
 */

import type {
  AnalogDevice,
  DeviceGeometryMOS,
  DeviceGeometryBJT,
  DeviceGeometryJFET,
  DeviceGeometryResistor,
  DeviceGeometryCapacitor,
  DeviceGeometryDiode,
  DieAnnotations,
  SpiceConfig,
  FloorplanRegion,
} from "shared";
import {
  assignInstanceNames,
  sanitizeSpiceName,
} from "../export/spice";
import { collectDieWideAnalogDevices } from "../../api/dieWideAnalog";
import { matchGeometry } from "../export/matching";

// ── Default model stubs for @spice-ts ─────────────────────────

const DEFAULT_MODELS: Record<string, string> = {
  MOS_N: ".MODEL NMOS NMOS (VTO=0.7 KP=120u LAMBDA=0.01 GAMMA=0.4 PHI=0.7)",
  MOS_P: ".MODEL PMOS PMOS (VTO=-0.7 KP=40u LAMBDA=0.02 GAMMA=0.4 PHI=0.7)",
  BJT_NPN: ".MODEL npn NPN (BF=200 IS=1e-14 VAF=100)",
  BJT_PNP: ".MODEL pnp PNP (BF=100 IS=1e-14 VAF=50)",
  DIODE: ".MODEL diode D (IS=1e-14 BV=50 N=1)",
  ZENER: ".MODEL zener D (IS=1e-14 BV=5.6 N=1)",
  SCHOTTKY: ".MODEL diode D (IS=1e-10 N=1.05)",
  JFET_N: ".MODEL njf NJF (VTO=-2 BETA=1e-3)",
  JFET_P: ".MODEL pjf PJF (VTO=2 BETA=1e-3)",
};

// ── Value formatting ──────────────────────────────────────────────

function fmtW(geom: DeviceGeometryMOS): string {
  return `W=${geom.W_um}u`;
}
function fmtL(geom: DeviceGeometryMOS): string {
  return `L=${geom.L_um}u`;
}
function fmtM(mult?: number): string {
  return mult && mult > 1 ? `m=${mult}` : "";
}

// ── Model name per device kind ────────────────────────────────────

function modelForDevice(d: AnalogDevice): string {
  const modelMap: Record<string, string> = {
    mos_n: "NMOS",
    mos_p: "PMOS",
    bjt_npn: "npn",
    bjt_pnp: "pnp",
    diode: "diode",
    zener: "zener",
    schottky: "diode",
    jfet_n: "njf",
    jfet_p: "pjf",
  };
  if (d.kind === "mos") {
    const g = d.geometry as DeviceGeometryMOS;
    return modelMap[g.mosType === "pmos" ? "mos_p" : "mos_n"];
  }
  return modelMap[d.kind] ?? "";
}

// ── Terminal string (same as spice.ts terminalString) ────────────

function terminalString(
  kind: string,
  terminals: Array<{ name: string; netId: number }>,
  nl: Map<number, string>,
  vdd: string,
  gnd: string,
): string {
  const tn = (name: string) => {
    const t = terminals.find((te) => te.name === name);
    if (!t) return "0";
    const netName = nl.get(t.netId);
    if (!netName) return "0";
    if (netName === "VDD" || netName === "VSS") return netName;
    return sanitizeSpiceName(netName);
  };

  switch (kind) {
    case "mos":
      // D G S B
      return `${tn("D")} ${tn("G")} ${tn("S")} ${tn("B")}`;
    case "bjt_npn":
    case "bjt_pnp":
      // C B E [S]
      return `${tn("C")} ${tn("B")} ${tn("E")} ${tn("S")}`;
    case "jfet_n":
    case "jfet_p":
      return `${tn("D")} ${tn("G")} ${tn("S")}`;
    default:
      return `${tn("PLUS")} ${tn("MINUS")}`;
  }
}

// ── Device instance line (spice-ts format) ────────────────────────

function deviceLine(
  d: AnalogDevice,
  nl: Map<number, string>,
  vdd: string,
  gnd: string,
  indent: string,
): string {
  const instName = d.instanceName ?? d.id;
  const ts = terminalString(d.kind, d.terminals, nl, vdd, gnd);
  const model = modelForDevice(d);
  const g = d.geometry;

  switch (d.kind) {
    case "mos": {
      const mg = g as DeviceGeometryMOS;
      return `${indent}${instName} ${ts} ${model} ${fmtW(mg)} ${fmtL(mg)} ${fmtM(mg.multiplier)}`.trim();
    }
    case "bjt_npn":
    case "bjt_pnp": {
      const bg = g as DeviceGeometryBJT;
      return `${indent}${instName} ${ts} ${model} ${fmtM(bg.multiplier)}`.trim();
    }
    case "jfet_n":
    case "jfet_p": {
      const jg = g as DeviceGeometryJFET;
      return `${indent}${instName} ${ts} ${model} W=${jg.W_um}u L=${jg.L_um}u ${fmtM(jg.multiplier)}`.trim();
    }
    case "resistor": {
      const rg = g as DeviceGeometryResistor;
      // spice-ts: plain value, no model name
      return `${indent}${instName} ${ts} ${rg.resistance_ohms}`;
    }
    case "capacitor": {
      const cg = g as DeviceGeometryCapacitor;
      // Farads (spice-ts expects F, not fF)
      const val = (cg.capacitance_fF ?? 0) * 1e-15;
      return `${indent}${instName} ${ts} ${val}`;
    }
    case "diode":
    case "zener":
    case "schottky": {
      const dg = g as DeviceGeometryDiode;
      return `${indent}${instName} ${ts} ${model} ${fmtM(dg.multiplier)}`.trim();
    }
    default:
      return `${indent}${instName} ${ts} ${model}`;
  }
}

// ── Build net name map (same as spice.ts) ────────────────────────

function buildNetNameMap(
  devices: AnalogDevice[],
  namedNets: Map<number, string>,
): Map<number, string> {
  const nm = new Map<number, string>(namedNets);
  const netIds = new Set<number>();
  for (const d of devices) {
    for (const t of d.terminals) {
      if (t.netId >= 0) netIds.add(t.netId);
    }
  }
  let counter = 0;
  for (const id of netIds) {
    if (!nm.has(id)) {
      nm.set(id, `net${id}`);
    }
  }
  return nm;
}

// ── Required .MODEL cards ─────────────────────────────────────────

function neededModels(devices: AnalogDevice[]): string[] {
  const models = new Map<string, string>();
  for (const d of devices) {
    const model = modelForDevice(d);
    if (!model) continue;
    if (models.has(model)) continue;
    // Map model name to default model card
    const modelKey = (() => {
      if (d.kind === "mos") {
        const mg = d.geometry as DeviceGeometryMOS;
        return mg.mosType === "pmos" ? "MOS_P" : "MOS_N";
      }
      return ({
        bjt_npn: "BJT_NPN",
        bjt_pnp: "BJT_PNP",
        diode: "DIODE",
        zener: "ZENER",
        schottky: "SCHOTTKY",
        jfet_n: "JFET_N",
        jfet_p: "JFET_P",
      } as Record<string, string>)[d.kind] ?? "";
    })();
    if (modelKey && DEFAULT_MODELS[modelKey]) {
      models.set(model, DEFAULT_MODELS[modelKey]);
    }
  }
  return [...models.values()];
}

// ── Public API ────────────────────────────────────────────────────

export interface SpiceTSResult {
  /** Flat SPICE netlist text compatible with @spice-ts/core */
  netlist: string;
  /** Device count */
  totalDevices: number;
  /** Device count per kind */
  byKind: Record<string, number>;
}

/**
 * Generate a standalone flat SPICE-TS netlist from a set of devices.
 */
export function formatDevicesAsSpiceTS(
  devices: AnalogDevice[],
  namedNets: Map<number, string>,
  moduleName: string,
  vdd: string,
  gnd: string,
): SpiceTSResult {
  const nl = buildNetNameMap(devices, namedNets);
  const models = neededModels(devices);
  const byKind: Record<string, number> = {};

  const lines: string[] = [];
  lines.push(`* SPICE-TS netlist generated by mmo-chip`);
  lines.push(`* Source: ${moduleName}`);
  lines.push(`* ${devices.length} devices`);
  lines.push(`.GLOBAL ${vdd} ${gnd}`);
  lines.push("");

  // Power sources (tied to global rails)
  lines.push(`VDD-main ${vdd} 0 DC 5`);
  lines.push(`VSS-main ${gnd} 0 DC 0`);
  lines.push("");

  // Model cards
  if (models.length > 0) {
    lines.push(...models);
    lines.push("");
  }

  // Device instances
  for (const d of devices) {
    const line = deviceLine(d, nl, vdd, gnd, "");
    lines.push(line);
    byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
  }

  // Analysis stub (required for parse())
  lines.push("");
  lines.push(".op");
  lines.push(".end");
  lines.push("");

  return {
    netlist: lines.join("\n"),
    totalDevices: devices.length,
    byKind,
  };
}

/**
 * Generate SPICE-TS netlists from annotations:
 *   - flat = one netlist for all devices
 *   - hierarchical = one netlist per floorplan region
 */
export function generateSpiceTSViews(
  annotations: DieAnnotations,
  moduleName: string,
  spiceConfig?: SpiceConfig,
  floorplanRegions?: FloorplanRegion[],
): { flat: SpiceTSResult; perRegion: Map<string, { name: string; result: SpiceTSResult }> } {
  const config: SpiceConfig = { vdd: "VDD", gnd: "GND", ...spiceConfig };
  const vdd = config.vdd ?? "VDD";
  const gnd = config.gnd ?? "GND";

  // Collect devices
  const { devices, namedNets } = collectDieWideAnalogDevices(
    annotations,
    spiceConfig?.umPerPx ?? annotations.umPerPx ?? 1.0,
    config,
  );

  // Assign names + optional geometry matching
  const named = assignInstanceNames(devices);
  matchGeometry(named as (AnalogDevice & { instanceName: string })[], config, namedNets);

  // Flat netlist
  const flat = formatDevicesAsSpiceTS(named, namedNets, moduleName, vdd, gnd);

  // Per-region netlists
  const perRegion = new Map<string, { name: string; result: SpiceTSResult }>();

  if (floorplanRegions && floorplanRegions.length > 0) {
    // Partition devices by region
    const assignedKeys = new Set<string>();
    for (const region of floorplanRegions) {
      const inside: AnalogDevice[] = [];
      for (const d of named) {
        const key = d.instanceName ?? d.id;
        if (assignedKeys.has(key)) continue;
        if (deviceInRegion(d, region)) {
          inside.push(d);
          assignedKeys.add(key);
        }
      }
      if (inside.length > 0) {
        const subName = sanitizeSpiceName(region.name || `Region_${region.id.slice(0, 8)}`);
        const result = formatDevicesAsSpiceTS(inside, namedNets, `${moduleName}.${subName}`, vdd, gnd);
        perRegion.set(region.id, { name: subName, result });
      }
    }
  }

  return { flat, perRegion };
}

// ── Device-in-region check (simplified) ──────────────────────────

function deviceInRegion(
  d: AnalogDevice,
  region: FloorplanRegion,
): boolean {
  // Use device bounding box center for region membership
  const bb = d.bbox;
  if (!bb) return false;
  const cx = bb.x + bb.width / 2;
  const cy = bb.y + bb.height / 2;

  // Region geometry (polygon or rect points)
  const pts = region.geometry;
  if (pts.length < 2) return false;

  if (region.kind === "rect" && pts.length >= 2) {
    const minX = Math.min(pts[0].x, pts[1].x);
    const maxX = Math.max(pts[0].x, pts[1].x);
    const minY = Math.min(pts[0].y, pts[1].y);
    const maxY = Math.max(pts[0].y, pts[1].y);
    return cx >= minX && cx <= maxX && cy >= minY && cy <= maxY;
  }

  // Polygon check using ray-casting
  if (pts.length >= 3) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x, yi = pts[i].y;
      const xj = pts[j].x, yj = pts[j].y;
      if ((yi > cy) !== (yj > cy) &&
          cx < ((xj - xi) * (cy - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  return false;
}
