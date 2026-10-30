/**
 * mcpAnalyze.ts — analysis tools for reverse engineering.
 *
 * These are the questions the existing tool set could not answer without
 * dumping the whole project and eyeballing it:
 *
 *  - `analyze_netlist`  — topology facts about an extracted deck (degrees,
 *    cross-coupled pairs, parallel/series passives, floating nodes).
 *  - `find_shapes`      — geometry search over analog layers, cell types,
 *    cell instances and wire segments, with cluster/isolation/overlap filters.
 *  - `sample_layers`    — pixel statistics at die points / rectangles / layer
 *    shapes, with a rendered preview, so a material hypothesis ("this is
 *    nwell") can be checked against the image.
 *  - `set_cell_type_well` — one atomic edit of the well layer (and diffusion
 *    forced type) of a set of cell types: the "Cell 12/15 are nwell" fix.
 *  - `rename_nets`      — atomic batch rename plus a report of duplicate
 *    names and nets with identical geometry (the "Net 95 / copy" audit).
 *
 * All of them are read-only except the last two, which need "Full edits".
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import sharp from "sharp";
import type {
  AnnotationNet,
  Cell,
  CellType,
  DieAnnotations,
  LayerShape,
  LayerType
} from "shared";
import { getOverlayCropSource } from "../api/overlayImages.js";
import { cellDieRect, renderDieCrop } from "../api/tiles.js";
import { extractNetlist } from "../netlistExtraction.js";
import { resolveProjectDir } from "../projectLayout.js";
import { readAnnotations, readDieRecord } from "../store.js";
import type { DieRecord } from "../types.js";
import { num, str, textResult, ToolInputError, write, type ToolDef } from "./mcpToolKit.js";

// ─── Shared geometry / value helpers ────────────────────────────────

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const round = (v: number, digits = 2) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

const boxCenter = (b: Box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

function boxesOverlap(a: Box, b: Box, gap = 0): boolean {
  return (
    a.x - gap < b.x + b.width &&
    b.x - gap < a.x + a.width &&
    a.y - gap < b.y + b.height &&
    b.y - gap < a.y + a.height
  );
}

function pointBoxDistance(b: Box, p: { x: number; y: number }): number {
  const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.width));
  const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.height));
  return Math.hypot(dx, dy);
}

function unionBoxes(boxes: Box[]): Box | null {
  if (boxes.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.width);
    y1 = Math.max(y1, b.y + b.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function shapeBox(shape: LayerShape): Box {
  switch (shape.kind) {
    case "rect":
      return { x: shape.x, y: shape.y, width: shape.width, height: shape.height };
    case "line": {
      const hw = (shape.width ?? 1) / 2;
      const x0 = Math.min(shape.x1, shape.x2) - hw;
      const y0 = Math.min(shape.y1, shape.y2) - hw;
      return {
        x: x0,
        y: y0,
        width: Math.abs(shape.x2 - shape.x1) + hw * 2,
        height: Math.abs(shape.y2 - shape.y1) + hw * 2
      };
    }
    case "point":
      return { x: shape.x - shape.size / 2, y: shape.y - shape.size / 2, width: shape.size, height: shape.size };
    case "circle":
      return { x: shape.x - shape.radius, y: shape.y - shape.radius, width: shape.radius * 2, height: shape.radius * 2 };
    case "polygon": {
      const xs = shape.points.map((p) => p.x);
      const ys = shape.points.map((p) => p.y);
      const x0 = Math.min(...xs);
      const y0 = Math.min(...ys);
      const x1 = Math.max(...xs);
      const y1 = Math.max(...ys);
      return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    }
  }
}

function polygonArea(points: { x: number; y: number }[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

function shapeArea(shape: LayerShape): number {
  switch (shape.kind) {
    case "rect":
      return Math.abs(shape.width * shape.height);
    case "line":
      return Math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1) * (shape.width ?? 1);
    case "point":
      return shape.size * shape.size;
    case "circle":
      return Math.PI * shape.radius * shape.radius;
    case "polygon":
      return polygonArea(shape.points);
  }
}

/** SPICE numeric literal (`2.4p`, `1.8u`, `10k`, `2meg`) → SI value. */
const VALUE_SCALE: Record<string, number> = {
  meg: 1e6,
  t: 1e12,
  g: 1e9,
  k: 1e3,
  m: 1e-3,
  u: 1e-6,
  n: 1e-9,
  p: 1e-12,
  f: 1e-15
};

export function spiceValue(text: string): number | null {
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*([a-z]+)?/i.exec(text.trim());
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  const suffix = (m[2] ?? "").toLowerCase();
  const key = Object.keys(VALUE_SCALE)
    .sort((a, b) => b.length - a.length)
    .find((k) => suffix.startsWith(k));
  return key ? value * VALUE_SCALE[key] : value;
}

// ─── analyze_netlist ────────────────────────────────────────────────

type DeviceKind = "M" | "R" | "C" | "L" | "D" | "Q" | "J" | "X" | "V" | "I" | "OTHER";

interface ParsedDevice {
  name: string;
  kind: DeviceKind;
  nodes: string[];
  model?: string;
  /** First numeric value after the nodes, for two-terminal devices. */
  value?: number;
  valueText?: string;
  params: Record<string, number>;
  line: string;
}

interface ParsedNetlist {
  devices: ParsedDevice[];
  ports: string[];
  subcktName: string | null;
  models: Map<string, string>;
}

const TWO_TERMINAL: DeviceKind[] = ["R", "C", "L", "D", "V", "I"];
const PASSIVE: DeviceKind[] = ["R", "C", "L", "D"];

function logicalLines(text: string): string[] {
  const out: string[] = [];
  let inControl = false;
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    if (/^\.control\b/i.test(line)) {
      inControl = true;
      continue;
    }
    if (inControl) {
      if (/^\.endc\b/i.test(line)) inControl = false;
      continue;
    }
    line = line.replace(/\s+\$.*$/, "").replace(/\s+;.*$/, "");
    if (line.startsWith("*")) continue;
    if (line.startsWith("+")) {
      if (out.length > 0) out[out.length - 1] += ` ${line.slice(1).trim()}`;
      continue;
    }
    out.push(line);
  }
  return out;
}

function parseParams(tokens: string[]): Record<string, number> {
  const params: Record<string, number> = {};
  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq <= 0) continue;
    const key = token.slice(0, eq).toLowerCase();
    const value = spiceValue(token.slice(eq + 1).replace(/[{}]/g, ""));
    if (value !== null) params[key] = value;
  }
  return params;
}

function parseNetlist(text: string): ParsedNetlist {
  const devices: ParsedDevice[] = [];
  const ports: string[] = [];
  const models = new Map<string, string>();
  let subcktName: string | null = null;

  for (const line of logicalLines(text)) {
    const tokens = line.split(/\s+/);
    const name = tokens[0];
    if (/^\.model\b/i.test(line)) {
      const modelType = tokens[2] ?? "";
      models.set((tokens[1] ?? "").toLowerCase(), modelType.toLowerCase());
      continue;
    }
    if (/^\.subckt\b/i.test(line)) {
      subcktName = tokens[1] ?? null;
      for (const port of tokens.slice(2)) {
        if (port.includes("=")) break;
        ports.push(port);
      }
      continue;
    }
    if (/^\.(ends|end|tran|ac|dc|op|meas|measure|print|plot|save|options|param|temp|ic|nodeset|step|width|four|fft)\b/i.test(line)) {
      continue;
    }
    if (!/^[A-Za-z]/.test(name)) continue;

    const letter = name[0].toUpperCase();
    const kind: DeviceKind = (["M", "R", "C", "L", "D", "Q", "J", "X", "V", "I"] as const).includes(
      letter as "M"
    )
      ? (letter as DeviceKind)
      : "OTHER";
    if (kind === "OTHER") continue;

    let nodes: string[] = [];
    let model: string | undefined;
    let value: number | undefined;
    let valueText: string | undefined;
    let params: Record<string, number> = {};

    switch (kind) {
      case "M":
        nodes = tokens.slice(1, 5);
        model = tokens[5];
        params = parseParams(tokens.slice(6));
        break;
      case "Q":
        model = tokens[4];
        nodes = tokens.slice(1, 4);
        // c b e [substrate] model: a fifth token after the name that is not a
        // parameter and not a known model name is the substrate node.
        if (tokens[5] && !tokens[5].includes("=") && !models.has((tokens[4] ?? "").toLowerCase())) {
          nodes = tokens.slice(1, 5);
          model = tokens[5];
        }
        params = parseParams(tokens.slice(nodes.length + 1));
        break;
      case "J":
        nodes = tokens.slice(1, 4);
        model = tokens[4];
        params = parseParams(tokens.slice(5));
        break;
      case "X": {
        const eq = tokens.findIndex((t, i) => i > 0 && t.includes("="));
        const end = eq === -1 ? tokens.length : eq;
        nodes = tokens.slice(1, end - 1);
        model = tokens[end - 1];
        params = parseParams(tokens.slice(end));
        break;
      }
      case "V":
      case "I": {
        nodes = tokens.slice(1, 3);
        valueText = tokens.slice(3).join(" ");
        const dc = /\bDC\s+([-+.\d][^\s)]*)/i.exec(valueText);
        value = dc ? spiceValue(dc[1]) ?? undefined : /^[-+.\d]/i.test(valueText) ? spiceValue(valueText) ?? undefined : undefined;
        break;
      }
      default:
        nodes = tokens.slice(1, 3);
        valueText = tokens[3];
        value = valueText === undefined ? undefined : spiceValue(valueText) ?? undefined;
        if (kind === "D") model = tokens[3];
        if (kind === "R" || kind === "C" || kind === "L") params = parseParams(tokens.slice(3));
        break;
    }

    devices.push({ name, kind, nodes: nodes.filter(Boolean), model, value, valueText, params, line });
  }

  return { devices, ports, subcktName, models };
}

function mosPolarity(device: ParsedDevice, models: Map<string, string>): "nmos" | "pmos" | "unknown" {
  const model = (device.model ?? "").toLowerCase();
  const card = models.get(model) ?? "";
  const all = `${model} ${card}`;
  if (all.includes("pmos") || all.startsWith("pch") || all.includes("pch")) return "pmos";
  if (all.includes("nmos") || all.startsWith("nch") || all.includes("nch")) return "nmos";
  return "unknown";
}

const terminalNames = (d: ParsedDevice): string[] =>
  d.kind === "M"
    ? ["D", "G", "S", "B"]
    : d.kind === "Q"
      ? ["C", "B", "E", "S"]
      : d.kind === "J"
        ? ["D", "G", "S"]
        : ["P", "N"];

const deviceTypeName = (d: ParsedDevice): string => {
  if (d.kind === "M") return "MOS";
  if (d.kind === "R") return "R";
  if (d.kind === "C") return "C";
  if (d.kind === "L") return "L";
  if (d.kind === "D") return "D";
  if (d.kind === "Q") return "Q";
  if (d.kind === "J") return "J";
  if (d.kind === "X") return "X";
  if (d.kind === "V") return "V";
  if (d.kind === "I") return "I";
  return "OTHER";
};

function siValue(value: number | undefined): string | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  if (value === 0) return "0";
  const abs = Math.abs(value);
  const units: Array<[number, string]> = [
    [1e9, "G"],
    [1e6, "M"],
    [1e3, "k"],
    [1, ""],
    [1e-3, "m"],
    [1e-6, "µ"],
    [1e-9, "n"],
    [1e-12, "p"],
    [1e-15, "f"]
  ];
  for (const [scale, suffix] of units) {
    if (abs >= scale) return `${round(value / scale, 4)}${suffix}`;
  }
  return value.toExponential(3);
}

function analyzeParsed(parsed: ParsedNetlist, options: { focusNodes: string[]; includeDevices: boolean; includeNodes: boolean; maxNodes: number }) {
  const devices = parsed.devices;
  const terminals = new Map<string, Array<{ device: ParsedDevice; terminal: string }>>();
  const add = (node: string, device: ParsedDevice, terminal: string) => {
    if (!node) return;
    const list = terminals.get(node) ?? [];
    list.push({ device, terminal });
    terminals.set(node, list);
  };

  for (const device of devices) {
    const names = terminalNames(device);
    device.nodes.forEach((node, index) => add(node, device, names[index] ?? `T${index}`));
  }

  const degree = (node: string) => terminals.get(node)?.length ?? 0;
  const isMos = (d: ParsedDevice) => d.kind === "M";
  const mosList = devices.filter(isMos);
  const passives = devices.filter((d) => PASSIVE.includes(d.kind));

  // Parallel passives: identical unordered node pair.
  const parallelMap = new Map<string, ParsedDevice[]>();
  for (const device of passives) {
    if (device.nodes.length !== 2 || device.value === undefined) continue;
    const key = `${device.kind}|${[...device.nodes].sort().join("\u0000")}`;
    parallelMap.set(key, [...(parallelMap.get(key) ?? []), device]);
  }
  const parallelGroups = [...parallelMap.values()]
    .filter((group) => group.length > 1)
    .map((group) => {
      const values = group.map((d) => d.value as number);
      const kind = group[0].kind;
      let equivalent: number | null = null;
      if (kind === "R" || kind === "L") {
        const conductance = values.reduce((sum, v) => sum + (v !== 0 ? 1 / v : 0), 0);
        equivalent = conductance > 0 ? 1 / conductance : null;
      } else if (kind === "C") {
        equivalent = values.reduce((sum, v) => sum + v, 0);
      }
      return {
        kind,
        nodes: group[0].nodes,
        count: group.length,
        devices: group.map((d) => d.name),
        values: values.map((v) => ({ value: v, text: siValue(v) })),
        equivalent: equivalent === null ? null : { value: equivalent, text: siValue(equivalent) }
      };
    })
    .sort((a, b) => b.count - a.count);

  // Series resistors: endpoints of a chain of R devices through degree-2 nodes.
  const rByNode = new Map<string, ParsedDevice[]>();
  for (const d of devices.filter((x) => x.kind === "R" && x.nodes.length === 2 && x.value !== undefined)) {
    for (const node of d.nodes) rByNode.set(node, [...(rByNode.get(node) ?? []), d]);
  }
  const visitedR = new Set<ParsedDevice>();
  const seriesChains: Array<{ nodes: string[]; devices: string[]; total: { value: number; text: string | null } }> = [];
  for (const start of [...rByNode.values()].flat()) {
    if (visitedR.has(start)) continue;
    const ends = start.nodes.filter((node) => !(degree(node) === 2 && (rByNode.get(node)?.length ?? 0) === 2));
    if (ends.length !== 2) continue;
    const chain = [start];
    visitedR.add(start);
    let guard = 0;
    let current = start;
    while (guard++ < 1000) {
      const nextEnd = current.nodes.find(
        (node) => degree(node) === 2 && (rByNode.get(node)?.length ?? 0) === 2
      );
      if (!nextEnd) break;
      const next = (rByNode.get(nextEnd) ?? []).find((d) => d !== current);
      if (!next || visitedR.has(next)) break;
      visitedR.add(next);
      chain.push(next);
      current = next;
    }
    if (chain.length < 2) continue;
    const nodePath = [chain[0].nodes.find((n) => !chain[1].nodes.includes(n)) ?? chain[0].nodes[0]];
    for (const r of chain) {
      const next = r.nodes.find((n) => !nodePath.includes(n));
      if (next) nodePath.push(next);
    }
    const total = chain.reduce((sum, r) => sum + (r.value ?? 0), 0);
    seriesChains.push({
      nodes: nodePath,
      devices: chain.map((r) => r.name),
      total: { value: total, text: siValue(total) }
    });
  }

  // Cross-coupled MOS pairs (latch) and current mirrors, grouped by the node
  // pair they share: a pump stage has several devices on the same two nodes,
  // and listing every combination would drown the topology in duplicates.
  const crossMap = new Map<string, { type: string; nodes: { gateA: string; drainA: string; gateB: string; drainB: string }; devices: string[] }>();
  const mirrorMap = new Map<string, { gate: string; source: string; drains: string[]; devices: string[] }>();
  const sameNode = (a: string | undefined, b: string | undefined) =>
    a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
  for (let i = 0; i < mosList.length; i++) {
    for (let j = i + 1; j < mosList.length; j++) {
      const a = mosList[i];
      const b = mosList[j];
      if (a.nodes.length < 4 || b.nodes.length < 4) continue;
      const [ad, ag, as] = a.nodes;
      const [bd, bg, bs] = b.nodes;
      if (sameNode(ag, bd) && sameNode(bg, ad) && !sameNode(ad, bd)) {
        const polarity = mosPolarity(a, parsed.models);
        const nodeKey = [ad, bd].map((n) => n.toLowerCase()).sort().join("|");
        const key = `${polarity}|${nodeKey}`;
        const group = crossMap.get(key);
        if (group) group.devices.push(b.name);
        else crossMap.set(key, { type: polarity, nodes: { gateA: ag, drainA: ad, gateB: bg, drainB: bd }, devices: [a.name, b.name] });
      }
      if (sameNode(ag, bg) && sameNode(as, bs) && !sameNode(ad, bd)) {
        const key = `${ag.toLowerCase()}|${as.toLowerCase()}`;
        const group = mirrorMap.get(key);
        if (group) {
          group.devices.push(b.name);
          if (!group.drains.includes(bd)) group.drains.push(bd);
        } else {
          mirrorMap.set(key, { gate: ag, source: as, drains: [ad, bd], devices: [a.name, b.name] });
        }
      }
    }
  }
  const crossCoupled = [...crossMap.values()].map((group) => ({ ...group, devices: [...new Set(group.devices)] }));
  const mirrors = [...mirrorMap.values()].map((group) => ({ ...group, devices: [...new Set(group.devices)] }));

  // Floating / dangling nodes (ground names are never "floating" in practice).
  const groundLike = (node: string) => node === "0" || /^(gnd|vss|ground)$/i.test(node);
  const floatingNodes = [...terminals.entries()]
    .filter(([node, list]) => list.length === 1 && !groundLike(node))
    .map(([node, list]) => ({ node, degree: 1, terminal: list[0].terminal, device: list[0].device.name }))
    .sort((a, b) => a.node.localeCompare(b.node));

  // Independent sources: all of them, then the DC / named ones as supplies.
  const sources = devices
    .filter((d) => d.kind === "V" || d.kind === "I")
    .map((source) => {
      const waveform = /^(pulse|sin|exp|pwl|sffm|am)\s*\(/i.test((source.valueText ?? "").trim());
      return {
        name: source.name,
        kind: source.kind,
        nodes: source.nodes,
        dc: source.value ?? null,
        dcText: source.value === undefined ? source.valueText ?? null : siValue(source.value),
        waveform,
        degree: source.nodes.reduce((sum, node) => sum + (node ? degree(node) : 0), 0)
      };
    });

  const supplyNets: Array<Record<string, unknown>> = [];
  for (const source of sources) {
    if (source.waveform) continue;
    for (const node of source.nodes) {
      if (groundLike(node)) continue;
      if (supplyNets.some((s) => s.node === node)) continue;
      supplyNets.push({
        node,
        source: source.name,
        dc: source.dc,
        dcText: source.dcText,
        degree: degree(node)
      });
    }
  }
  for (const node of terminals.keys()) {
    if (/^(vdd|vcc|vss|gnd|avdd|dvdd)$/i.test(node) && !supplyNets.some((s) => s.node === node)) {
      supplyNets.push({ node, source: null, dc: null, dcText: null, degree: degree(node) });
    }
  }

  const nameCounts = new Map<string, number>();
  for (const d of devices) nameCounts.set(d.name.toLowerCase(), (nameCounts.get(d.name.toLowerCase()) ?? 0) + 1);
  const duplicateDeviceNames = [...nameCounts.entries()].filter(([, n]) => n > 1).map(([name]) => name);

  const focus = options.focusNodes.map((node) => {
    const matches = [...terminals.keys()].filter((n) => n.toLowerCase() === node.toLowerCase());
    return {
      requested: node,
      found: matches,
      connections: matches.map((name) => ({
        node: name,
        degree: degree(name),
        terminals: (terminals.get(name) ?? []).map((t) => ({
          device: t.device.name,
          type: deviceTypeName(t.device),
          model: t.device.model ?? null,
          terminal: t.terminal,
          value: t.device.value === undefined ? null : siValue(t.device.value),
          w: t.device.params.w ?? null,
          l: t.device.params.l ?? null,
          m: t.device.params.m ?? null
        }))
      }))
    };
  });

  const nodes = [...terminals.entries()]
    .map(([node, list]) => ({
      node,
      degree: list.length,
      devices: list.map((t) => `${t.device.name}.${t.terminal}`)
    }))
    .sort((a, b) => b.degree - a.degree || a.node.localeCompare(b.node));

  const mosByType = { nmos: 0, pmos: 0, unknown: 0 };
  for (const mos of mosList) mosByType[mosPolarity(mos, parsed.models)]++;

  const portNets = parsed.ports.map((port) => ({
    port,
    degree: degree(port),
    connected: degree(port) > 0
  }));

  return {
    subckt: parsed.subcktName,
    ports: parsed.ports,
    portNets,
    unconnectedPorts: parsed.ports.filter((port) => degree(port) === 0),
    deviceCount: devices.length,
    deviceCounts: devices.reduce<Record<string, number>>((counts, d) => {
      const key = deviceTypeName(d);
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {}),
    mos: {
      total: mosList.length,
      ...mosByType,
      withWidth: mosList.filter((m) => m.params.w !== undefined).length
    },
    nodeCount: terminals.size,
    floatingNodes,
    sources,
    supplyNets,
    crossCoupledPairs: crossCoupled,
    currentMirrors: mirrors,
    parallelGroups,
    seriesResistorChains: seriesChains,
    duplicateDeviceNames,
    focus,
    ...(options.includeNodes ? { nodes: nodes.slice(0, options.maxNodes), nodesTruncated: nodes.length > options.maxNodes } : {}),
    ...(options.includeDevices
      ? {
          devices: devices.map((d) => ({
            name: d.name,
            type: deviceTypeName(d),
            nodes: d.nodes,
            model: d.model ?? null,
            value: d.value === undefined ? null : siValue(d.value),
            w: d.params.w === undefined ? null : siValue(d.params.w),
            l: d.params.l === undefined ? null : siValue(d.params.l),
            m: d.params.m === undefined ? null : siValue(d.params.m)
          }))
        }
      : {})
  };
}

const analyzeNetlist: ToolDef = {
  name: "analyze_netlist",
  title: "Analyze a SPICE netlist",
  description:
    "Topology report for a SPICE deck: device and node counts, MOS polarity, ports, floating nodes, supply nets, " +
    "cross-coupled (latch) MOS pairs, current mirrors, parallel passives with their equivalent value, series " +
    "resistor chains, duplicate device names, and per-node connectivity for focusNodes. Pass `netlist` to analyze " +
    "text, or omit it to run the server-side extraction on the CURRENT annotations. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      netlist: { type: "string", description: "SPICE deck to analyze. Omit to extract from the project." },
      moduleName: { type: "string", description: "Module name for extraction (default netlist)." },
      dialect: { type: "string", enum: ["cdl", "spectre", "hspice"] },
      focusNodes: {
        type: "array",
        items: { type: "string" },
        description: "Nodes whose full connectivity should be returned (case-insensitive)."
      },
      includeDevices: { type: "boolean", description: "Return the normalised device list (default true)." },
      includeNodes: { type: "boolean", description: "Return every node with its degree and terminals (default false)." },
      maxNodes: { type: "integer", minimum: 1, maximum: 5000, description: "Cap for includeNodes (default 200)." }
    },
    additionalProperties: false
  },
  annotations: { readOnlyHint: true },
  run: async (ctx, args) => {
    const netlistText = str(args, "netlist", true);
    const focusNodes = Array.isArray(args.focusNodes) ? args.focusNodes.map(String) : [];
    const includeDevices = args.includeDevices !== false;
    const includeNodes = args.includeNodes === true;
    const maxNodes = Math.min(num(args, "maxNodes", true) ?? 200, 5000);

    let text = netlistText;
    let extraction: Awaited<ReturnType<typeof extractNetlist>> | null = null;
    if (text === undefined) {
      const { dir } = await resolveProjectDir(ctx.dataRoot, ctx.dieId);
      extraction = await extractNetlist({
        dieId: ctx.dieId,
        projectDir: dir,
        moduleName: str(args, "moduleName", true),
        dialect: str(args, "dialect", true) as "cdl" | "spectre" | "hspice" | undefined
      });
      if (!extraction.ok || typeof extraction.text !== "string") {
        throw new ToolInputError(`Netlist extraction failed: ${extraction.error ?? "no text returned"}`);
      }
      text = extraction.text;
    }
    if (!text.trim()) throw new ToolInputError("The netlist is empty");

    const parsed = parseNetlist(text);
    const report = analyzeParsed(parsed, { focusNodes, includeDevices, includeNodes, maxNodes });
    return textResult({
      source: extraction ? "extraction" : "netlist",
      extraction: extraction
        ? {
            ok: extraction.ok,
            deviceCount: extraction.deviceCount,
            totalDevices: extraction.totalDevices,
            byKind: extraction.byKind,
            warnings: extraction.warnings ?? [],
            virtualConnects: extraction.virtualConnects ?? []
          }
        : null,
      ...report
    });
  }
};

// ─── find_shapes ────────────────────────────────────────────────────

type ShapeScope = "analog" | "types" | "cells" | "wires" | "all";

interface ShapeHit {
  id: string;
  scope: "analog" | "cellType" | "cell" | "wire";
  source: string;
  layer: string;
  kind: string;
  box: Box;
  areaPx2: number;
  label?: string;
  customName?: string;
  cellTypeId?: string;
  cellTypeName?: string;
  cellId?: string;
  netId?: string;
  netName?: string;
  detail?: Record<string, unknown>;
}

interface ShapeFilters {
  layer?: string;
  within?: Box;
  withinMode: "contain" | "intersect";
  near?: { x: number; y: number; radius: number };
  minAreaPx2?: number;
  maxAreaPx2?: number;
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  minAspect?: number;
  maxAspect?: number;
  kinds?: string[];
  isolated?: boolean;
  isolatedGap: number;
  overlapsLayer?: string;
  cellTypeIds?: string[];
  netIds?: string[];
}

function shapeMatches(hit: ShapeHit, f: ShapeFilters): boolean {
  if (f.layer && hit.layer.toLowerCase() !== f.layer.toLowerCase()) return false;
  if (f.netIds && (!hit.netId || !f.netIds.includes(hit.netId))) return false;
  if (f.cellTypeIds && (!hit.cellTypeId || !f.cellTypeIds.includes(hit.cellTypeId))) return false;
  if (f.kinds && !f.kinds.includes(hit.kind)) return false;
  if (f.within) {
    const b = hit.box;
    const inside =
      b.x >= f.within.x &&
      b.y >= f.within.y &&
      b.x + b.width <= f.within.x + f.within.width &&
      b.y + b.height <= f.within.y + f.within.height;
    if (f.withinMode === "contain" ? !inside : !boxesOverlap(b, f.within)) return false;
  }
  if (f.near && pointBoxDistance(hit.box, f.near) > f.near.radius) return false;
  if (f.minAreaPx2 !== undefined && hit.areaPx2 < f.minAreaPx2) return false;
  if (f.maxAreaPx2 !== undefined && hit.areaPx2 > f.maxAreaPx2) return false;
  if (f.minWidth !== undefined && hit.box.width < f.minWidth) return false;
  if (f.maxWidth !== undefined && hit.box.width > f.maxWidth) return false;
  if (f.minHeight !== undefined && hit.box.height < f.minHeight) return false;
  if (f.maxHeight !== undefined && hit.box.height > f.maxHeight) return false;
  const long = Math.max(hit.box.width, hit.box.height);
  const short = Math.max(1e-9, Math.min(hit.box.width, hit.box.height));
  const aspect = long / short;
  if (f.minAspect !== undefined && aspect < f.minAspect) return false;
  if (f.maxAspect !== undefined && aspect > f.maxAspect) return false;
  return true;
}

function collectShapeHits(annotations: DieAnnotations, scope: ShapeScope): ShapeHit[] {
  const hits: ShapeHit[] = [];
  const wantAnalog = scope === "analog" || scope === "all";
  const wantTypes = scope === "types" || scope === "all";
  const wantCells = scope === "cells" || scope === "all";
  const wantWires = scope === "wires" || scope === "all";

  if (wantAnalog && annotations.analogLayers) {
    for (const [layer, shapes] of Object.entries(annotations.analogLayers)) {
      for (const shape of shapes ?? []) {
        const box = shapeBox(shape);
        hits.push({
          id: shape.id,
          scope: "analog",
          source: "analogLayers",
          layer,
          kind: shape.kind,
          box,
          areaPx2: shapeArea(shape),
          label: shape.label,
          customName: shape.customName
        });
      }
    }
  }

  if (wantTypes) {
    for (const type of annotations.cellTypes ?? []) {
      for (const [layer, shapes] of Object.entries(type.layers ?? {})) {
        for (const shape of shapes ?? []) {
          const box = shapeBox(shape);
          hits.push({
            id: shape.id,
            scope: "cellType",
            source: `cellType:${type.id}`,
            layer,
            kind: shape.kind,
            box,
            areaPx2: shapeArea(shape),
            label: shape.label,
            customName: shape.customName,
            cellTypeId: type.id,
            cellTypeName: type.name,
            detail: { typeFrame: true, cropRect: type.cropRect }
          });
        }
      }
    }
  }

  if (wantCells) {
    const types = new Map((annotations.cellTypes ?? []).map((t) => [t.id, t]));
    for (const cell of annotations.cells ?? []) {
      const type = types.get(cell.cellTypeId);
      const w = type?.cropRect.width ?? 0;
      const h = type?.cropRect.height ?? 0;
      const rect = cellDieRect(cell, w, h);
      hits.push({
        id: cell.id,
        scope: "cell",
        source: `cell:${cell.cellTypeId}`,
        layer: "cell",
        kind: "cell",
        box: rect,
        areaPx2: rect.width * rect.height,
        cellTypeId: cell.cellTypeId,
        cellTypeName: type?.name,
        cellId: cell.id,
        detail: {
          cellTypeId: cell.cellTypeId,
          cellTypeName: type?.name ?? null,
          rotation: cell.rotation ?? 0,
          flippedH: cell.flippedH === true,
          flippedV: cell.flippedV === true,
          mlDetected: cell.mlDetected === true,
          mlConfidence: cell.mlConfidence ?? null
        }
      });
    }
  }

  if (wantWires) {
    for (const net of annotations.nets ?? []) {
      const nodes = new Map(net.nodes.map((n) => [n.id, n]));
      for (const edge of net.edges ?? []) {
        const a = nodes.get(edge.from);
        const b = nodes.get(edge.to);
        if (!a || !b) continue;
        const x0 = Math.min(a.x, b.x);
        const y0 = Math.min(a.y, b.y);
        const width = Math.abs(b.x - a.x);
        const height = Math.abs(b.y - a.y);
        const length = Math.hypot(width, height);
        hits.push({
          id: edge.id,
          scope: "wire",
          source: "nets",
          layer: edge.layer ?? "unknown",
          kind: "segment",
          box: { x: x0, y: y0, width, height },
          areaPx2: length,
          netId: net.id,
          netName: net.name,
          detail: {
            from: { x: a.x, y: a.y },
            to: { x: b.x, y: b.y },
            lengthPx: round(length, 2),
            note: "wire areaPx2 = length × 1 px (nominal width)"
          }
        });
      }
    }
  }

  return hits;
}

function clusterHits(hits: ShapeHit[]): Array<Record<string, unknown>> {
  const groups = new Map<string, ShapeHit[]>();
  for (const hit of hits) {
    const key = `${hit.scope}|${hit.source}|${hit.layer}`;
    groups.set(key, [...(groups.get(key) ?? []), hit]);
  }
  const clusters: Array<Record<string, unknown>> = [];
  for (const group of groups.values()) {
    const parent = group.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const join = (a: number, b: number) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    };
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (boxesOverlap(group[i].box, group[j].box)) join(i, j);
      }
    }
    const members = new Map<number, ShapeHit[]>();
    group.forEach((hit, i) => {
      const root = find(i);
      members.set(root, [...(members.get(root) ?? []), hit]);
    });
    for (const list of members.values()) {
      const box = unionBoxes(list.map((m) => m.box));
      if (!box) continue;
      clusters.push({
        layer: list[0].layer,
        scope: list[0].scope,
        source: list[0].source,
        cellTypeId: list[0].cellTypeId ?? null,
        netIds: [...new Set(list.map((m) => m.netId).filter(Boolean))],
        count: list.length,
        box,
        areaPx2: round(list.reduce((sum, m) => sum + m.areaPx2, 0), 1),
        ids: list.slice(0, 20).map((m) => m.id),
        idsTruncated: list.length > 20
      });
    }
  }
  return clusters.sort((a, b) => (b.areaPx2 as number) - (a.areaPx2 as number));
}

const findShapes: ToolDef = {
  name: "find_shapes",
  title: "Find shapes by layer and geometry",
  description:
    "Search every geometry source for shapes matching a filter: die-level analog layers, cell-type layers (in the " +
    "TYPE frame — 0,0 is the type crop origin), cell instances (die coords), and wire segments (nets). Filters: " +
    "layer, rectangle (`within`), proximity (`near`), size/area/aspect, shape kind, `isolated` (no other shape of " +
    "the same layer/source nearby), `overlapsLayer` (e.g. diffusion touching nwell), cellTypeIds/netIds, and " +
    "`clusters: true` (connected components of the matched shapes). Sizes are returned in px and µm when the die " +
    "has umPerPx. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      scope: {
        type: "string",
        enum: ["analog", "types", "cells", "wires", "all"],
        description: "Where to search (default all)."
      },
      layer: { type: "string", description: "Layer name, e.g. nwell, metal4, diffusion, polysilicon." },
      within: {
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } },
        required: ["x", "y", "width", "height"],
        description: "Die-pixel rectangle (for cell-type shapes these are type-frame pixels)."
      },
      withinMode: { type: "string", enum: ["contain", "intersect"], description: "Default contain." },
      near: {
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" }, radius: { type: "number" } },
        required: ["x", "y", "radius"],
        description: "Keep shapes whose bounding box is within `radius` of the point."
      },
      minAreaPx2: { type: "number" },
      maxAreaPx2: { type: "number" },
      minWidth: { type: "number" },
      maxWidth: { type: "number" },
      minHeight: { type: "number" },
      maxHeight: { type: "number" },
      minAspect: { type: "number", description: "long side / short side, minimum" },
      maxAspect: { type: "number", description: "long side / short side, maximum" },
      kinds: {
        type: "array",
        items: { type: "string" },
        description: "rect, line, point, circle, polygon, cell, segment"
      },
      isolated: { type: "boolean", description: "Only shapes with no other shape of the same layer/source nearby." },
      isolatedGap: { type: "number", description: "Gap in px for `isolated` (default 2)." },
      overlapsLayer: { type: "string", description: "Only shapes whose box intersects a shape of this layer in the same source." },
      cellTypeIds: { type: "array", items: { type: "string" } },
      cellTypeNames: {
        type: "array",
        items: { type: "string" },
        description: "Cell-type names to include (exact unless match=regex)."
      },
      match: { type: "string", enum: ["exact", "regex"], description: "How cellTypeNames are matched (default exact)." },
      netIds: { type: "array", items: { type: "string" } },
      clusters: { type: "boolean", description: "Return connected components instead of individual shapes." },
      sort: { type: "string", enum: ["area", "width", "height", "x", "y", "none"], description: "Default area." },
      limit: { type: "integer", minimum: 1, maximum: 500, description: "Default 100." }
    },
    additionalProperties: false
  },
  annotations: { readOnlyHint: true },
  run: async (ctx, args) => {
    const annotations = await readAnnotations(ctx.dataRoot, ctx.dieId);
    const record = await readDieRecord(ctx.dataRoot, ctx.dieId);
    const scope = (str(args, "scope", true) ?? "all") as ShapeScope;
    const withinArg = args.within as Record<string, unknown> | undefined;
    const nearArg = args.near as Record<string, unknown> | undefined;
    const typeNames = Array.isArray(args.cellTypeNames) ? args.cellTypeNames.map(String) : [];
    const typeMatch = (str(args, "match", true) ?? "exact") as "exact" | "regex";
    let cellTypeIds = Array.isArray(args.cellTypeIds) ? args.cellTypeIds.map(String) : undefined;
    if (typeNames.length > 0) {
      const regexes = typeMatch === "regex"
        ? typeNames.map((n) => {
            try {
              return new RegExp(n);
            } catch (error) {
              throw new ToolInputError(`Invalid regex "${n}": ${(error as Error).message}`);
            }
          })
        : [];
      const matched = (annotations.cellTypes ?? []).filter((type) =>
        typeMatch === "regex"
          ? regexes.some((re) => re.test(type.name))
          : typeNames.some((n) => n.toLowerCase() === type.name.toLowerCase())
      );
      if (matched.length === 0) {
        throw new ToolInputError(
          `No cell type matches ${typeNames.map((n) => `"${n}"`).join(", ")}. ` +
            `Types: ${(annotations.cellTypes ?? []).map((t) => t.name).slice(0, 40).join(", ")}`
        );
      }
      cellTypeIds = [...new Set([...(cellTypeIds ?? []), ...matched.map((t) => t.id)])];
    }
    const filters: ShapeFilters = {
      layer: str(args, "layer", true),
      within: withinArg
        ? {
            x: num(withinArg, "x"),
            y: num(withinArg, "y"),
            width: num(withinArg, "width"),
            height: num(withinArg, "height")
          }
        : undefined,
      withinMode: (str(args, "withinMode", true) ?? "contain") as "contain" | "intersect",
      near: nearArg ? { x: num(nearArg, "x"), y: num(nearArg, "y"), radius: num(nearArg, "radius") } : undefined,
      minAreaPx2: num(args, "minAreaPx2", true),
      maxAreaPx2: num(args, "maxAreaPx2", true),
      minWidth: num(args, "minWidth", true),
      maxWidth: num(args, "maxWidth", true),
      minHeight: num(args, "minHeight", true),
      maxHeight: num(args, "maxHeight", true),
      minAspect: num(args, "minAspect", true),
      maxAspect: num(args, "maxAspect", true),
      kinds: Array.isArray(args.kinds) ? args.kinds.map(String) : undefined,
      isolated: args.isolated === true,
      isolatedGap: num(args, "isolatedGap", true) ?? 2,
      overlapsLayer: str(args, "overlapsLayer", true),
      cellTypeIds,
      netIds: Array.isArray(args.netIds) ? args.netIds.map(String) : undefined
    };

    const all = collectShapeHits(annotations, scope);
    let hits = all.filter((hit) => shapeMatches(hit, filters));

    if (filters.isolated) {
      hits = hits.filter((hit) => {
        const siblings = all.filter(
          (other) =>
            other.id !== hit.id &&
            other.scope === hit.scope &&
            other.source === hit.source &&
            other.layer === hit.layer
        );
        return !siblings.some((other) => boxesOverlap(other.box, hit.box, filters.isolatedGap));
      });
    }
    if (filters.overlapsLayer) {
      const layer = filters.overlapsLayer.toLowerCase();
      hits = hits.filter((hit) => {
        const others = all.filter(
          (other) =>
            other.layer.toLowerCase() === layer &&
            other.scope === hit.scope &&
            other.source === hit.source
        );
        return others.some((other) => boxesOverlap(other.box, hit.box));
      });
    }

    const umPerPx = annotations.umPerPx;
    const dec = (hit: ShapeHit) => {
      const center = boxCenter(hit.box);
      const long = Math.max(hit.box.width, hit.box.height);
      const short = Math.max(1e-9, Math.min(hit.box.width, hit.box.height));
      return {
        id: hit.id,
        scope: hit.scope,
        source: hit.source,
        layer: hit.layer,
        kind: hit.kind,
        cellTypeId: hit.cellTypeId ?? null,
        cellTypeName: hit.cellTypeName ?? null,
        cellId: hit.cellId ?? null,
        netId: hit.netId ?? null,
        netName: hit.netName ?? null,
        label: hit.label ?? null,
        customName: hit.customName ?? null,
        box: {
          x: round(hit.box.x, 2),
          y: round(hit.box.y, 2),
          width: round(hit.box.width, 2),
          height: round(hit.box.height, 2)
        },
        center: { x: round(center.x, 2), y: round(center.y, 2) },
        areaPx2: round(hit.areaPx2, 1),
        aspect: round(long / short, 2),
        ...(umPerPx
          ? {
              widthUm: round(hit.box.width * umPerPx, 3),
              heightUm: round(hit.box.height * umPerPx, 3),
              ...(hit.scope === "wire"
                ? { lengthUm: round(hit.areaPx2 * umPerPx, 3) }
                : { areaUm2: round(hit.areaPx2 * umPerPx * umPerPx, 3) })
            }
          : hit.scope === "wire"
            ? { lengthPx: round(hit.areaPx2, 2) }
            : {}),
        ...(hit.detail ? { detail: hit.detail } : {})
      };
    };

    const sort = str(args, "sort", true) ?? "area";
    if (sort !== "none") {
      const key = sort === "area" ? "areaPx2" : sort === "width" ? "width" : sort === "height" ? "height" : sort;
      hits.sort((a, b) => {
        if (key === "x") return a.box.x - b.box.x;
        if (key === "y") return a.box.y - b.box.y;
        const va = key === "areaPx2" ? a.areaPx2 : key === "width" ? a.box.width : a.box.height;
        const vb = key === "areaPx2" ? b.areaPx2 : key === "width" ? b.box.width : b.box.height;
        return vb - va;
      });
    }

    const limit = Math.min(num(args, "limit", true) ?? 100, 500);
    const clusters = args.clusters === true;
    const list = clusters ? clusterHits(hits).slice(0, limit) : hits.slice(0, limit).map(dec);
    const availableLayers = all.reduce<Record<string, number>>((counts, h) => {
      counts[h.layer] = (counts[h.layer] ?? 0) + 1;
      return counts;
    }, {});
    return textResult({
      scope,
      layer: filters.layer ?? null,
      umPerPx: umPerPx ?? null,
      image: { width: record.width, height: record.height },
      counts: {
        allShapes: all.length,
        matched: hits.length,
        returned: list.length,
        byScope: all.reduce<Record<string, number>>((counts, h) => {
          counts[h.scope] = (counts[h.scope] ?? 0) + 1;
          return counts;
        }, {})
      },
      availableLayers,
      note:
        scope === "types" || scope === "all"
          ? "cellType shapes are in the TYPE frame (0,0 = that type's crop top-left); use scope=cells for die coords."
          : undefined,
      ...(filters.layer &&
      !Object.keys(availableLayers).some((k) => k.toLowerCase() === filters.layer!.toLowerCase())
        ? { warning: `No shape uses layer "${filters.layer}". availableLayers lists what exists.` }
        : {}),
      ...(clusters ? { clusters: list } : { shapes: list })
    });
  }
};

// ─── sample_layers ──────────────────────────────────────────────────

interface PixelStats {
  rgb: [number, number, number];
  hex: string;
  luma: number;
  lumaStd: number;
  contrast: number;
  histogram?: number[];
}

function statsOfPixels(
  data: Buffer,
  info: { width: number; height: number; channels: number },
  histogram: boolean
): PixelStats {
  const pixels = info.width * info.height;
  const step = Math.max(1, Math.floor(pixels / 80_000));
  let n = 0;
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let sl = 0;
  let sl2 = 0;
  const lumas: number[] = [];
  const bins = new Array<number>(16).fill(0);
  for (let i = 0; i < pixels; i += step) {
    const o = i * info.channels;
    const r = data[o] ?? 0;
    const g = data[o + 1] ?? 0;
    const b = data[o + 2] ?? 0;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sr += r;
    sg += g;
    sb += b;
    sl += luma;
    sl2 += luma * luma;
    if (histogram) {
      lumas.push(luma);
      bins[Math.min(15, Math.floor(luma / 16))]++;
    }
    n++;
  }
  const rgb: [number, number, number] = [
    Math.round(sr / Math.max(1, n)),
    Math.round(sg / Math.max(1, n)),
    Math.round(sb / Math.max(1, n))
  ];
  const luma = sl / Math.max(1, n);
  const variance = Math.max(0, sl2 / Math.max(1, n) - luma * luma);
  let contrast = 0;
  if (histogram && lumas.length > 1) {
    lumas.sort((a, b) => a - b);
    contrast = lumas[Math.floor(lumas.length * 0.95)] - lumas[Math.floor(lumas.length * 0.05)];
  } else if (n > 1) {
    contrast = Math.sqrt(variance) * 3.3;
  }
  const hex = `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  return {
    rgb,
    hex,
    luma: round(luma, 2),
    lumaStd: round(Math.sqrt(variance), 2),
    contrast: round(contrast, 1),
    ...(histogram ? { histogram: bins } : {})
  };
}

const sampleLayers: ToolDef = {
  name: "sample_layers",
  title: "Sample die pixels / layer shapes",
  description:
    "Measure what the die image actually looks like under points, rectangles or annotated layer shapes. Returns " +
    "mean RGB / hex / luma / contrast (+ optional 16-bin histogram and colour distance to the first sample) and, by " +
    "default, a rendered preview of the sampled area. Use it to test material hypotheses (nwell vs pwell, metal vs " +
    "passivation), to compare two cell types (Cell 12 vs Cell 15), or to confirm that an annotation sits on the " +
    "feature it claims. Sources: explicit die points/rects; `layer` in `analogLayers`; `layer` + `cellTypeIds` " +
    "(the type's shapes placed at each cell instance); `cellIds` (the whole instance box). Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      points: {
        type: "array",
        items: {
          type: "object",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            label: { type: "string" },
            size: { type: "number", description: "Window size in px (default 9)." }
          },
          required: ["x", "y"]
        }
      },
      rects: {
        type: "array",
        items: {
          type: "object",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            width: { type: "number" },
            height: { type: "number" },
            label: { type: "string" }
          },
          required: ["x", "y", "width", "height"]
        }
      },
      layer: { type: "string", description: "Sample every shape of this layer (see description for scope)." },
      cellTypeIds: {
        type: "array",
        items: { type: "string" },
        description: "With `layer`: only these cell types. Without `layer`: sample whole instances of these types."
      },
      cellTypeNames: {
        type: "array",
        items: { type: "string" },
        description: "Same as cellTypeIds, by name (exact unless match=regex)."
      },
      match: { type: "string", enum: ["exact", "regex"], description: "How cellTypeNames are matched (default exact)." },
      cellIds: {
        type: "array",
        items: { type: "string" },
        description: "Cell instances to place the layer shapes on (default: the first instance of each type)."
      },
      maxInstances: { type: "integer", minimum: 1, maximum: 50, description: "Per type when cellIds is omitted (default 1)." },
      size: { type: "number", description: "Default point window size in px (default 9)." },
      histogram: { type: "boolean", description: "Include a 16-bin luma histogram and contrast (default false)." },
      image: { type: "string", description: "\"base\" (default) or an overlay source id." },
      includePreview: { type: "boolean", description: "Attach a preview JPEG (default true)." },
      maxPreviewPx: { type: "integer", minimum: 100, maximum: 4000, description: "Long side of the preview (default 1000)." },
      maxSamples: { type: "integer", minimum: 1, maximum: 200, description: "Cap on returned samples (default 60)." }
    },
    additionalProperties: false
  },
  annotations: { readOnlyHint: true },
  run: async (ctx, args) => {
    const record = await readDieRecord(ctx.dataRoot, ctx.dieId);
    const annotations = await readAnnotations(ctx.dataRoot, ctx.dieId);
    const image = str(args, "image", true) ?? "base";
    const overlaySourceId = image === "base" ? undefined : image;
    const defaultSize = num(args, "size", true) ?? 9;
    const histogram = args.histogram === true;
    const maxSamples = Math.min(num(args, "maxSamples", true) ?? 60, 200);
    const maxInstances = Math.min(num(args, "maxInstances", true) ?? 1, 50);

    interface Req {
      label: string;
      box: Box;
      layer?: string;
      source: string;
      cellTypeId?: string;
      cellId?: string;
      shapeId?: string;
    }
    const reqs: Req[] = [];
    const notes: string[] = [];
    let layerShapeCount = 0;

    const pointList = Array.isArray(args.points) ? args.points : [];
    pointList.forEach((p, i) => {
      const o = p as Record<string, unknown>;
      const size = num(o, "size", true) ?? defaultSize;
      const x = num(o, "x");
      const y = num(o, "y");
      reqs.push({
        label: str(o, "label", true) ?? `point ${i + 1} (${round(x)}, ${round(y)})`,
        box: { x: x - size / 2, y: y - size / 2, width: size, height: size },
        source: "point"
      });
    });

    const rectList = Array.isArray(args.rects) ? args.rects : [];
    rectList.forEach((r, i) => {
      const o = r as Record<string, unknown>;
      const x = num(o, "x");
      const y = num(o, "y");
      const width = num(o, "width");
      const height = num(o, "height");
      reqs.push({
        label: str(o, "label", true) ?? `rect ${i + 1}`,
        box: { x, y, width, height },
        source: "rect"
      });
    });

    const types = new Map((annotations.cellTypes ?? []).map((t) => [t.id, t]));
    const cells = annotations.cells ?? [];
    const layer = str(args, "layer", true);
    const typeNames = Array.isArray(args.cellTypeNames) ? args.cellTypeNames.map(String) : [];
    const typeMatch = (str(args, "match", true) ?? "exact") as "exact" | "regex";
    let cellTypeIds = Array.isArray(args.cellTypeIds) ? args.cellTypeIds.map(String) : [];
    if (typeNames.length > 0) {
      const regexes = typeMatch === "regex"
        ? typeNames.map((n) => {
            try {
              return new RegExp(n);
            } catch (error) {
              throw new ToolInputError(`Invalid regex "${n}": ${(error as Error).message}`);
            }
          })
        : [];
      const matched = (annotations.cellTypes ?? []).filter((type) =>
        typeMatch === "regex"
          ? regexes.some((re) => re.test(type.name))
          : typeNames.some((n) => n.toLowerCase() === type.name.toLowerCase())
      );
      if (matched.length === 0) {
        throw new ToolInputError(
          `No cell type matches ${typeNames.map((n) => `"${n}"`).join(", ")}. ` +
            `Types: ${(annotations.cellTypes ?? []).map((t) => t.name).slice(0, 40).join(", ")}`
        );
      }
      cellTypeIds = [...new Set([...cellTypeIds, ...matched.map((t) => t.id)])];
    }
    const cellIdsArg = Array.isArray(args.cellIds) ? args.cellIds.map(String) : [];

    const cellsForType = (typeId: string) => {
      const own = cells.filter((c) => c.cellTypeId === typeId && (cellIdsArg.length === 0 || cellIdsArg.includes(c.id)));
      return own.slice(0, cellIdsArg.length > 0 ? own.length : maxInstances);
    };

    if (layer && cellTypeIds.length === 0 && cellIdsArg.length > 0) {
      // `layer` + explicit instances: derive their types, otherwise the call
      // would silently fall back to analogLayers and find nothing.
      cellTypeIds = [
        ...new Set(cells.filter((c) => cellIdsArg.includes(c.id)).map((c) => c.cellTypeId))
      ];
      if (cellTypeIds.length === 0) {
        throw new ToolInputError(`None of the given cellIds exists on this die`);
      }
    }

    const mapTypePoint = (type: CellType, cell: Cell, p: { x: number; y: number }) => {
      const w = type.cropRect.width;
      const h = type.cropRect.height;
      let qx = p.x - w / 2;
      let qy = p.y - h / 2;
      if (cell.flippedH) qx = -qx;
      if (cell.flippedV) qy = -qy;
      switch (cell.rotation ?? 0) {
        case 90:
          [qx, qy] = [-qy, qx];
          break;
        case 180:
          [qx, qy] = [-qx, -qy];
          break;
        case 270:
          [qx, qy] = [qy, -qx];
          break;
      }
      return { x: cell.x + qx + w / 2, y: cell.y + qy + h / 2 };
    };

    if (layer) {
      if (cellTypeIds.length > 0) {
        for (const typeId of cellTypeIds) {
          const type = types.get(typeId);
          if (!type) throw new ToolInputError(`No cell type ${typeId}`);
          const shapes = type.layers?.[layer as LayerType] ?? [];
          layerShapeCount += shapes.length;
          if (shapes.length === 0) {
            notes.push(`${type.name}: no ${layer} shapes`);
            continue;
          }
          const placed = cellsForType(typeId);
          if (placed.length === 0) {
            notes.push(`${type.name}: ${shapes.length} ${layer} shape(s), but no placed cell instance`);
            continue;
          }
          for (const cell of placed) {
            for (const shape of shapes) {
              const sb = shapeBox(shape);
              const c1 = mapTypePoint(type, cell, { x: sb.x, y: sb.y });
              const c2 = mapTypePoint(type, cell, { x: sb.x + sb.width, y: sb.y + sb.height });
              const box = {
                x: Math.min(c1.x, c2.x),
                y: Math.min(c1.y, c2.y),
                width: Math.abs(c2.x - c1.x),
                height: Math.abs(c2.y - c1.y)
              };
              reqs.push({
                label: `${type.name} · ${layer} · ${shape.id.slice(0, 8)} @ ${cell.id.slice(0, 8)}`,
                box,
                layer,
                source: "cellType",
                cellTypeId: typeId,
                cellId: cell.id,
                shapeId: shape.id
              });
            }
          }
        }
      } else {
        const analog = annotations.analogLayers?.[layer as LayerType] ?? [];
        layerShapeCount += analog.length;
        for (const shape of analog) {
          reqs.push({
            label: `analog ${layer} · ${shape.id.slice(0, 8)}`,
            box: shapeBox(shape),
            layer,
            source: "analogLayers",
            shapeId: shape.id
          });
        }
      }
      if (reqs.length === 0) {
        throw new ToolInputError(
          `No ${layer} shapes could be sampled.` +
            (layerShapeCount > 0
              ? ` The shapes exist, but none of the selected cell types has a placed cell instance.`
              : cellTypeIds.length
                ? ` None of the selected cell types has ${layer} shapes.`
                : ` analogLayers has no ${layer} shapes — pass cellTypeIds for cell-type layers, or explicit points/rects.`)
        );
      }
    } else if (cellTypeIds.length > 0 || cellIdsArg.length > 0) {
      const wantedTypes = cellTypeIds.length > 0 ? cellTypeIds : [...new Set(cells.filter((c) => cellIdsArg.includes(c.id)).map((c) => c.cellTypeId))];
      for (const typeId of wantedTypes) {
        const type = types.get(typeId);
        if (!type) throw new ToolInputError(`No cell type ${typeId}`);
        const placed = cellsForType(typeId);
        if (placed.length === 0) {
          notes.push(`${type.name}: no placed cell instance`);
          continue;
        }
        for (const cell of placed) {
          const rect = cellDieRect(cell, type.cropRect.width, type.cropRect.height);
          reqs.push({
            label: `${type.name} instance ${cell.id.slice(0, 8)}`,
            box: rect,
            source: "cell",
            cellTypeId: typeId,
            cellId: cell.id
          });
        }
      }
    }

    if (reqs.length === 0) {
      throw new ToolInputError(
        "Nothing to sample: pass points, rects, layer and/or cellTypeIds/cellIds" +
          (notes.length > 0 ? ` (${notes.join("; ")})` : "")
      );
    }

    const clipToDie = (b: Box): Box | null => {
      const x0 = Math.max(0, Math.floor(b.x));
      const y0 = Math.max(0, Math.floor(b.y));
      const x1 = Math.min(record.width, Math.ceil(b.x + b.width));
      const y1 = Math.min(record.height, Math.ceil(b.y + b.height));
      if (x1 - x0 < 1 || y1 - y0 < 1) return null;
      return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    };

    const samples: Array<Record<string, unknown>> = [];
    let firstRgb: [number, number, number] | null = null;
    for (const req of reqs.slice(0, maxSamples)) {
      const rect = clipToDie(req.box);
      if (!rect) continue;
      const crop = await renderDieCrop({
        dataRoot: ctx.dataRoot,
        dieId: ctx.dieId,
        record,
        key: "sample",
        rect: { left: rect.x, top: rect.y, width: rect.width, height: rect.height },
        overlaySourceId
      });
      const { data, info } = await sharp(crop.path).raw().toBuffer({ resolveWithObject: true });
      const stats = statsOfPixels(data, info, histogram);
      firstRgb ??= stats.rgb;
      const colorDistance = Math.round(
        Math.hypot(stats.rgb[0] - firstRgb[0], stats.rgb[1] - firstRgb[1], stats.rgb[2] - firstRgb[2])
      );
      samples.push({
        label: req.label,
        source: req.source,
        layer: req.layer ?? null,
        cellTypeId: req.cellTypeId ?? null,
        cellId: req.cellId ?? null,
        shapeId: req.shapeId ?? null,
        rect,
        ...stats,
        colorDistanceToFirst: colorDistance,
        scale: crop.scale
      });
    }

    const result: Record<string, unknown> = {
      image,
      umPerPx: annotations.umPerPx ?? null,
      sampleCount: samples.length,
      requested: reqs.length,
      truncated: reqs.length > maxSamples,
      ...(notes.length > 0 ? { notes } : {}),
      samples
    };

    const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
      { type: "text", text: JSON.stringify(result) }
    ];

    if (args.includePreview !== false && samples.length > 0) {
      const union = unionBoxes(samples.map((s) => s.rect as Box));
      if (union) {
        const margin = Math.max(8, Math.round(Math.max(union.width, union.height) * 0.02));
        const previewRect = clipToDie({
          x: union.x - margin,
          y: union.y - margin,
          width: union.width + margin * 2,
          height: union.height + margin * 2
        });
        if (previewRect) {
          const preview = await renderDieCrop({
            dataRoot: ctx.dataRoot,
            dieId: ctx.dieId,
            record,
            key: "sample-preview",
            rect: { left: previewRect.x, top: previewRect.y, width: previewRect.width, height: previewRect.height },
            minPx: Math.min(num(args, "maxPreviewPx", true) ?? 1000, Math.max(previewRect.width, previewRect.height)),
            overlaySourceId
          });
          const bytes = await fs.readFile(preview.path);
          // A tiny crop is unreadable at 1:1; upscale it so the image is
          // actually usable for judging what is under the annotation.
          const meta = await sharp(bytes).metadata();
          const longSide = Math.max(meta.width ?? 0, meta.height ?? 0);
          let payload: Uint8Array = bytes;
          let mime = "image/jpeg";
          if (longSide > 0 && longSide < 512) {
            const factor = Math.min(8, 512 / longSide);
            payload = await sharp(bytes)
              .resize({
                width: Math.round((meta.width ?? 1) * factor),
                height: Math.round((meta.height ?? 1) * factor),
                kernel: sharp.kernel.nearest
              })
              .jpeg({ quality: 92 })
              .toBuffer();
            mime = "image/jpeg";
          }
          content.push({ type: "image", data: Buffer.from(payload).toString("base64"), mimeType: mime });
        }
      }
    }

    return { content };
  }
};

// ─── find_image_blobs ───────────────────────────────────────────────

interface Blob {
  area: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  sx: number;
  sy: number;
  touchesEdge: boolean;
}

/**
 * Separable square dilation (any set pixel within `r`). Used only to *merge*
 * parts of one feature — a pad with slots, a plate with hatch — so connectivity
 * is judged on the dilated mask while all reported geometry still comes from
 * the original pixels.
 */
function dilateMask(src: Uint8Array, width: number, height: number, r: number): Uint8Array {
  if (r <= 0) return src;
  const horizontal = new Uint8Array(src.length);
  const rowPrefix = new Int32Array(width + 1);
  for (let y = 0; y < height; y++) {
    const off = y * width;
    for (let x = 0; x < width; x++) rowPrefix[x + 1] = rowPrefix[x] + (src[off + x] ? 1 : 0);
    for (let x = 0; x < width; x++) {
      const a = Math.max(0, x - r);
      const b = Math.min(width, x + r + 1);
      if (rowPrefix[b] - rowPrefix[a] > 0) horizontal[off + x] = 1;
    }
  }
  const out = new Uint8Array(src.length);
  const colPrefix = new Int32Array(height + 1);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) colPrefix[y + 1] = colPrefix[y] + (horizontal[y * width + x] ? 1 : 0);
    for (let y = 0; y < height; y++) {
      const a = Math.max(0, y - r);
      const b = Math.min(height, y + r + 1);
      if (colPrefix[b] - colPrefix[a] > 0) out[y * width + x] = 1;
    }
  }
  return out;
}

/** 4-connected components; `core` (default: the same mask) supplies geometry. */
function connectedBlobs(mask: Uint8Array, width: number, height: number, core: Uint8Array = mask): Blob[] {
  const seen = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  const blobs: Blob[] = [];
  const push = (list: Int32Array, top: number, p: number) => {
    seen[p] = 1;
    list[top++] = p;
    return top;
  };
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let top = push(stack, 0, start);
    let area = 0;
    let sx = 0;
    let sy = 0;
    let x0 = width;
    let y0 = height;
    let x1 = -1;
    let y1 = -1;
    let touchesEdge = false;
    while (top > 0) {
      const p = stack[--top];
      const y = (p / width) | 0;
      const x = p - y * width;
      if (core[p]) {
        area++;
        sx += x;
        sy += y;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
        if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesEdge = true;
      }
      for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, y > 0 ? p - width : -1, y < height - 1 ? p + width : -1]) {
        if (q >= 0 && mask[q] && !seen[q]) top = push(stack, top, q);
      }
    }
    if (area > 0) blobs.push({ area, x0, y0, x1, y1, sx, sy, touchesEdge });
  }
  return blobs;
}

const findImageBlobs: ToolDef = {
  name: "find_image_blobs",
  title: "Find blobs on the die / an overlay",
  description:
    "Connected-component detection on image pixels: the CV counterpart to find_shapes (annotation geometry) and " +
    "sample_layers (statistics). For an overlay source (e.g. me1…me4, via12) the default mode thresholds the " +
    "alpha channel, so a blob is exactly a drawn shape — that is how isolated metal plates / bond-pad candidates " +
    "are found even when nothing is annotated. For the base image, mode dark/bright thresholds luma and color " +
    "thresholds distance from a reference RGB. `gap` merges parts of one feature (slots, hatching) before " +
    "labelling while area/bbox stay measured on the original pixels. Returns boxes, centroids, area, fill ratio, " +
    "“touches the scan edge”, plus an optional preview with the detected boxes drawn. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      image: { type: "string", description: "\"base\" (default) or an overlay source id (list_overlay_layers)." },
      rect: {
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } },
        required: ["x", "y", "width", "height"],
        description: "Die-pixel region to scan (default: the whole die)."
      },
      mode: {
        type: "string",
        enum: ["alpha", "dark", "bright", "color"],
        description: "alpha for overlays (default when image != base), dark/bright for luma, color for RGB distance."
      },
      threshold: {
        type: "number",
        description:
          "0..1 threshold for alpha/dark/bright. Omit to let dark/bright use an Otsu split of the luma histogram; alpha defaults to 0.5."
      },
      color: { type: "array", items: { type: "number" }, description: "Reference RGB for mode=color." },
      tolerance: { type: "number", description: "RGB distance for mode=color (default 40)." },
      gap: { type: "number", description: "Merge parts closer than this many die px (default 0)." },
      minAreaPx2: { type: "number", description: "Minimum blob area in die px² (default 16)." },
      maxAreaPx2: { type: "number" },
      minWidth: { type: "number", description: "Minimum bbox width in die px." },
      minHeight: { type: "number", description: "Minimum bbox height in die px." },
      minFill: { type: "number", description: "Minimum area / bbox area (0..1), rejects sparse noise." },
      maxDim: { type: "integer", minimum: 200, maximum: 4096, description: "Analysis resolution long side (default 1600)." },
      limit: { type: "integer", minimum: 1, maximum: 500, description: "Default 40." },
      includePreview: { type: "boolean", description: "Draw the detected boxes on a preview (default true)." },
      maxPreviewPx: { type: "integer", minimum: 200, maximum: 3000, description: "Preview long side (default 1200)." }
    },
    additionalProperties: false
  },
  annotations: { readOnlyHint: true },
  run: async (ctx, args) => {
    const record = await readDieRecord(ctx.dataRoot, ctx.dieId);
    const annotations = await readAnnotations(ctx.dataRoot, ctx.dieId);
    const image = str(args, "image", true) ?? "base";
    const rectArg = args.rect as Record<string, unknown> | undefined;
    const rect: Box = rectArg
      ? { x: num(rectArg, "x"), y: num(rectArg, "y"), width: num(rectArg, "width"), height: num(rectArg, "height") }
      : { x: 0, y: 0, width: record.width, height: record.height };
    const left = Math.max(0, Math.floor(rect.x));
    const top = Math.max(0, Math.floor(rect.y));
    const cropRect = {
      left,
      top,
      width: Math.max(1, Math.min(Math.ceil(rect.width), record.width - left)),
      height: Math.max(1, Math.min(Math.ceil(rect.height), record.height - top))
    };

    const mode = (str(args, "mode", true) ?? (image === "base" ? "dark" : "alpha")) as "alpha" | "dark" | "bright" | "color";
    if (!["alpha", "dark", "bright", "color"].includes(mode)) {
      throw new ToolInputError(`"mode" must be alpha, dark, bright or color`);
    }
    const threshold = num(args, "threshold", true) ?? 0.5;
    const color = Array.isArray(args.color) ? (args.color as unknown[]).map(Number) : undefined;
    if (mode === "color" && (!color || color.length !== 3 || color.some((c) => !Number.isFinite(c)))) {
      throw new ToolInputError(`mode=color needs color: [r, g, b]`);
    }
    const tolerance = num(args, "tolerance", true) ?? 40;
    const gap = num(args, "gap", true) ?? 0;
    const minArea = num(args, "minAreaPx2", true) ?? 16;
    const maxArea = num(args, "maxAreaPx2", true);
    const minWidth = num(args, "minWidth", true);
    const minHeight = num(args, "minHeight", true);
    const minFill = num(args, "minFill", true);
    const maxDim = Math.min(num(args, "maxDim", true) ?? 1600, 4096);

    const ratio = Math.min(1, maxDim / Math.max(cropRect.width, cropRect.height));
    const outW = Math.max(1, Math.round(cropRect.width * ratio));
    const outH = Math.max(1, Math.round(cropRect.height * ratio));

    const notes: string[] = [];
    let data: Buffer;
    let info: { width: number; height: number; channels: number };
    let previewPath: string | null = null;

    if (image === "base") {
      const crop = await renderDieCrop({
        dataRoot: ctx.dataRoot,
        dieId: ctx.dieId,
        record,
        key: "blobs",
        rect: cropRect,
        minPx: maxDim
      });
      previewPath = crop.path;
      ({ data, info } = await sharp(crop.path)
        .resize({ width: outW, height: outH, fit: "fill" })
        .raw()
        .toBuffer({ resolveWithObject: true }));
    } else {
      const overlay = await getOverlayCropSource({
        dataRoot: ctx.dataRoot,
        dieId: ctx.dieId,
        sourceId: image
      });
      if (!overlay) {
        throw new ToolInputError(
          `No overlay image "${image}". Use list_overlay_layers to see the available source ids.`
        );
      }
      ({ data, info } = await sharp(overlay.originalPath, { limitInputPixels: false })
        .extract({ left, top, width: cropRect.width, height: cropRect.height })
        .resize({ width: outW, height: outH, fit: "fill" })
        .raw()
        .toBuffer({ resolveWithObject: true }));
    }

    const channels = info.channels;
    const pixels = info.width * info.height;
    const mask = new Uint8Array(pixels);
    const hasAlpha = channels === 4;
    let effectiveMode = mode;
    if (mode === "alpha") {
      if (!hasAlpha) {
        effectiveMode = "bright";
        notes.push(`"${image}" has no alpha channel — fell back to mode=bright (luma).`);
      } else {
        // Many overlays are colourised renderings saved fully opaque; an alpha
        // threshold would then return one blob covering everything.
        let transparent = 0;
        const stride = Math.max(1, Math.floor(pixels / 50_000));
        let counted = 0;
        for (let i = 0; i < pixels; i += stride) {
          counted++;
          if ((data[i * channels + 3] ?? 255) < 250) transparent++;
        }
        if (transparent / Math.max(1, counted) < 0.02) {
          effectiveMode = "bright";
          notes.push(
            `"${image}" is (almost) fully opaque — its alpha carries no geometry, so alpha mode fell back to ` +
              `bright (luma). Pass a colour threshold (mode=color) if the light/dark split is not the shape you want.`
          );
        }
      }
    }

    // Threshold: explicit, or Otsu over the luma histogram — an objective split
    // instead of a magic number nobody can justify.
    const explicitThreshold = num(args, "threshold", true);
    let effectiveThreshold = explicitThreshold ?? 0.5;
    let thresholdSource: "explicit" | "default" | "otsu" = explicitThreshold !== undefined ? "explicit" : "default";
    if ((effectiveMode === "dark" || effectiveMode === "bright") && explicitThreshold === undefined) {
      const histogram = new Uint32Array(256);
      for (let i = 0; i < pixels; i++) {
        const o = i * channels;
        const luma = 0.2126 * (data[o] ?? 0) + 0.7152 * (data[o + 1] ?? 0) + 0.0722 * (data[o + 2] ?? 0);
        histogram[Math.min(255, Math.max(0, Math.round(luma)))]++;
      }
      let total = 0;
      let sum = 0;
      for (let v = 0; v < 256; v++) {
        total += histogram[v];
        sum += v * histogram[v];
      }
      let sumB = 0;
      let weightB = 0;
      let bestVariance = -1;
      let bestLevel = 128;
      for (let v = 0; v < 256; v++) {
        weightB += histogram[v];
        if (weightB === 0) continue;
        const weightF = total - weightB;
        if (weightF === 0) break;
        sumB += v * histogram[v];
        const meanB = sumB / weightB;
        const meanF = (sum - sumB) / weightF;
        const variance = weightB * weightF * (meanB - meanF) * (meanB - meanF);
        if (variance > bestVariance) {
          bestVariance = variance;
          bestLevel = v;
        }
      }
      effectiveThreshold = bestLevel / 255;
      thresholdSource = "otsu";
    }

    const levelMin = effectiveThreshold * 255;
    for (let i = 0; i < pixels; i++) {
      const o = i * channels;
      const r = data[o] ?? 0;
      const g = data[o + 1] ?? 0;
      const b = data[o + 2] ?? 0;
      if (effectiveMode === "alpha") {
        if ((data[o + 3] ?? 0) >= levelMin) mask[i] = 1;
      } else if (effectiveMode === "color") {
        const d = Math.hypot(r - color![0], g - color![1], b - color![2]);
        if (d <= tolerance) mask[i] = 1;
      } else {
        const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (effectiveMode === "bright" ? luma >= levelMin : luma <= levelMin) mask[i] = 1;
      }
    }

    const gapPx = Math.max(0, Math.round(gap / Math.max(cropRect.width / outW, cropRect.height / outH)));
    const connectivity = gapPx > 0 ? dilateMask(mask, outW, outH, gapPx) : mask;
    const rx = cropRect.width / outW;
    const ry = cropRect.height / outH;
    const umPerPx = annotations.umPerPx;

    const found = connectedBlobs(connectivity, outW, outH, mask).map((blob) => {
      const box: Box = {
        x: cropRect.left + blob.x0 * rx,
        y: cropRect.top + blob.y0 * ry,
        width: (blob.x1 - blob.x0 + 1) * rx,
        height: (blob.y1 - blob.y0 + 1) * ry
      };
      return {
        blob,
        box,
        center: { x: cropRect.left + (blob.sx / blob.area + 0.5) * rx, y: cropRect.top + (blob.sy / blob.area + 0.5) * ry },
        areaPx2: blob.area * rx * ry,
        fill: blob.area / Math.max(1, (blob.x1 - blob.x0 + 1) * (blob.y1 - blob.y0 + 1))
      };
    });

    const filtered = found.filter((b) => {
      if (b.areaPx2 < minArea) return false;
      if (maxArea !== undefined && b.areaPx2 > maxArea) return false;
      if (minWidth !== undefined && b.box.width < minWidth) return false;
      if (minHeight !== undefined && b.box.height < minHeight) return false;
      if (minFill !== undefined && b.fill < minFill) return false;
      return true;
    });
    filtered.sort((a, b) => b.areaPx2 - a.areaPx2);
    const limit = Math.min(num(args, "limit", true) ?? 40, 500);
    const returned = filtered.slice(0, limit);

    const blobs = returned.map((b, i) => ({
      index: i + 1,
      box: {
        x: round(b.box.x, 1),
        y: round(b.box.y, 1),
        width: round(b.box.width, 1),
        height: round(b.box.height, 1)
      },
      center: { x: round(b.center.x, 1), y: round(b.center.y, 1) },
      areaPx2: round(b.areaPx2, 1),
      fill: round(b.fill, 3),
      aspect: round(Math.max(b.box.width, b.box.height) / Math.max(1e-9, Math.min(b.box.width, b.box.height)), 2),
      touchesEdge: b.blob.touchesEdge,
      ...(umPerPx
        ? {
            widthUm: round(b.box.width * umPerPx, 2),
            heightUm: round(b.box.height * umPerPx, 2),
            areaUm2: round(b.areaPx2 * umPerPx * umPerPx, 2)
          }
        : {})
    }));

    const result: Record<string, unknown> = {
      image,
      mode: effectiveMode,
      threshold: round(effectiveThreshold, 4),
      thresholdSource,
      ...(effectiveMode === "color" ? { color, tolerance } : {}),
      rect: cropRect,
      analysis: {
        width: outW,
        height: outH,
        diePxPerAnalysisPx: [round(rx, 3), round(ry, 3)],
        gapPx: gapPx
      },
      counts: {
        blobs: filtered.length,
        returned: blobs.length,
        onPixels: mask.reduce((sum, v) => sum + v, 0),
        areaPx2: round(filtered.reduce((sum, b) => sum + b.areaPx2, 0), 1)
      },
      ...(notes.length > 0 ? { notes } : {}),
      blobs,
      ...(blobs.length === 0
        ? { note: "Nothing matched. Try a lower threshold / larger gap / smaller minAreaPx2, or another mode." }
        : {})
    };

    const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
      { type: "text", text: JSON.stringify(result) }
    ];

    if (args.includePreview !== false && blobs.length > 0) {
      if (!previewPath) {
        const preview = await renderDieCrop({
          dataRoot: ctx.dataRoot,
          dieId: ctx.dieId,
          record,
          key: "blobs-preview",
          rect: cropRect,
          minPx: Math.min(num(args, "maxPreviewPx", true) ?? 1200, Math.max(cropRect.width, cropRect.height)),
          overlaySourceId: image === "base" ? undefined : image
        });
        previewPath = preview.path;
      }
      const basePreview = sharp(previewPath).resize({ width: outW, height: outH, fit: "fill" });
      const shapes = returned
        .map((b, i) => {
          const x = (b.box.x - cropRect.left) / rx;
          const y = (b.box.y - cropRect.top) / ry;
          const w = b.box.width / rx;
          const h = b.box.height / ry;
          const stroke = i === 0 ? "#ff2d55" : "#00e5a0";
          return (
            `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" ` +
            `fill="none" stroke="${stroke}" stroke-width="${Math.max(1, outW / 400).toFixed(1)}"/>`
          );
        })
        .join("");
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}">${shapes}</svg>`;
      const bytes = await basePreview.composite([{ input: Buffer.from(svg) }]).jpeg({ quality: 90 }).toBuffer();
      content.push({ type: "image", data: bytes.toString("base64"), mimeType: "image/jpeg" });
    }

    return { content };
  }
};

// ─── set_cell_type_well ─────────────────────────────────────────────

type WellName = "nwell" | "pwell" | "none";

function cloneType(type: CellType): CellType {
  return JSON.parse(JSON.stringify(type)) as CellType;
}

function selectCellTypes(
  annotations: DieAnnotations,
  args: Record<string, unknown>,
  argName: string
): CellType[] {
  const ids = Array.isArray(args.cellTypeIds) ? args.cellTypeIds.map(String) : [];
  const names = Array.isArray(args.names) ? args.names.map(String) : [];
  const match = (str(args, "match", true) ?? "exact") as "exact" | "regex";
  if (ids.length === 0 && names.length === 0 && args.all !== true) {
    throw new ToolInputError(`Pass ${argName} or names, or all: true`);
  }
  let regexes: RegExp[] = [];
  if (names.length > 0 && match === "regex") {
    regexes = names.map((n) => {
      try {
        return new RegExp(n);
      } catch (error) {
        throw new ToolInputError(`Invalid regex "${n}": ${(error as Error).message}`);
      }
    });
  }
  return (annotations.cellTypes ?? []).filter((type) => {
    if (args.all === true) return true;
    if (ids.includes(type.id)) return true;
    if (names.length === 0) return false;
    return match === "regex"
      ? regexes.some((re) => re.test(type.name))
      : names.some((n) => n.toLowerCase() === type.name.toLowerCase());
  });
}

const setCellTypeWell: ToolDef = {
  name: "set_cell_type_well",
  title: "Set cell-type well / diffusion type",
  description:
    "Atomically move a set of cell types between nwell and pwell (the geometry is preserved; only the layer key " +
    "changes), optionally create a well rect covering the type's crop when the type has none, and optionally force " +
    "the diffusion shapes to n or p. This is the batch fix for the 'Cell 12 / Cell 15 are nwell, not pwell' class " +
    "of error. Select by cellTypeIds, by names (exact or regex), or all:true. `dryRun` reports the plan without " +
    "writing. Requires \"Full edits\".",
  inputSchema: {
    type: "object",
    properties: {
      cellTypeIds: { type: "array", items: { type: "string" } },
      names: { type: "array", items: { type: "string" }, description: "Type names, exact unless match=regex." },
      match: { type: "string", enum: ["exact", "regex"], description: "Default exact." },
      all: { type: "boolean", description: "Select every cell type (explicit, dangerous)." },
      well: { type: "string", enum: ["nwell", "pwell", "none"], description: "Target well; none removes both well layers." },
      diffusionType: { type: "string", enum: ["n", "p", "clear"], description: "Force the diffusion body type (clear = remove)." },
      createWellFromCrop: {
        type: "boolean",
        description: "When the type has no well shapes, add one rect covering its crop (default false)."
      },
      dryRun: { type: "boolean", description: "Report the plan without writing (default false)." }
    },
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
  run: async (ctx, args) => {
    const well = str(args, "well") as WellName;
    if (!["nwell", "pwell", "none"].includes(well)) throw new ToolInputError(`"well" must be nwell, pwell or none`);
    const diffusionType = str(args, "diffusionType", true);
    if (diffusionType !== undefined && !["n", "p", "clear"].includes(diffusionType)) {
      throw new ToolInputError(`"diffusionType" must be n, p or clear`);
    }
    const dryRun = args.dryRun === true;
    const createWellFromCrop = args.createWellFromCrop === true;
    const apply = (annotations: DieAnnotations) => {
      const targets = selectCellTypes(annotations, args, "cellTypeIds");
      const changed: Array<Record<string, unknown>> = [];
      const skipped: Array<Record<string, unknown>> = [];
      const updates: Array<{ id: string; after: CellType; report: Record<string, unknown> }> = [];

      for (const original of targets) {
        const before = cloneType(original);
        const after = cloneType(original);
        const layers = after.layers ?? {};
        const previous: string[] = [];
        if (layers.nwell && layers.nwell.length > 0) previous.push("nwell");
        if (layers.pwell && layers.pwell.length > 0) previous.push("pwell");

        let moved = 0;
        if (well === "none") {
          moved += layers.nwell?.length ?? 0;
          moved += layers.pwell?.length ?? 0;
          delete layers.nwell;
          delete layers.pwell;
        } else {
          const other = well === "nwell" ? "pwell" : "nwell";
          const target = layers[well] ?? [];
          const fromOther = layers[other] ?? [];
          if (fromOther.length > 0) {
            layers[well] = [...target, ...fromOther];
            moved += fromOther.length;
            delete layers[other];
          } else if (target.length === 0 && createWellFromCrop) {
            const rect = {
              id: randomUUID(),
              kind: "rect" as const,
              x: 0,
              y: 0,
              width: after.cropRect.width,
              height: after.cropRect.height
            };
            layers[well] = [rect];
            moved += 1;
          }
        }

        let diffusionChanged = 0;
        if (diffusionType !== undefined && (layers.diffusion?.length ?? 0) > 0) {
          layers.diffusion = (layers.diffusion ?? []).map((shape) => {
            if (diffusionType === "clear") {
              if (shape.forcedType === undefined) return shape;
              const { forcedType: _drop, ...rest } = shape;
              diffusionChanged++;
              return rest as LayerShape;
            }
            if (shape.forcedType === diffusionType) return shape;
            diffusionChanged++;
            return { ...shape, forcedType: diffusionType } as LayerShape;
          });
        }

        if (Object.keys(layers).length === 0) delete after.layers;
        else after.layers = layers;

        const changedAtAll = JSON.stringify(before) !== JSON.stringify(after);
        const report = {
          cellTypeId: after.id,
          name: after.name,
          previousWells: previous,
          well: previous.length === 0 && well !== "none" && moved === 0 ? null : well,
          movedWellShapes: moved,
          wellShapeCount: after.layers?.[well === "none" ? "nwell" : well]?.length ?? 0,
          diffusionShapes: after.layers?.diffusion?.length ?? 0,
          diffusionChanged
        };
        if (changedAtAll) {
          changed.push(report);
          updates.push({ id: after.id, after, report });
        } else {
          skipped.push({ ...report, reason: "already in the requested state" });
        }
      }
      return { targets, changed, skipped, updates };
    };

    if (dryRun) {
      const annotations = await readAnnotations(ctx.dataRoot, ctx.dieId);
      const plan = apply(annotations);
      return textResult({
        ok: true,
        dryRun: true,
        well,
        diffusionType: diffusionType ?? null,
        selected: plan.targets.length,
        wouldChange: plan.changed.length,
        changed: plan.changed,
        skipped: plan.skipped
      });
    }

    // Do not bump the revision (or push an empty undo step) for a no-op.
    const preview = await readAnnotations(ctx.dataRoot, ctx.dieId);
    const previewPlan = apply(preview);
    if (previewPlan.updates.length === 0) {
      return textResult({
        ok: true,
        rev: preview.rev,
        selected: previewPlan.targets.length,
        changed: 0,
        changedTypes: [],
        skipped: previewPlan.skipped
      });
    }

    return write(ctx, "full", (annotations) => {
      const plan = apply(annotations);
      if (plan.updates.length === 0) {
        return {
          tool: "set_cell_type_well",
          summary: `No cell-type well change needed (${plan.targets.length} selected)`,
          items: [],
          result: { selected: plan.targets.length, changed: 0, skipped: plan.skipped }
        };
      }
      return {
        tool: "set_cell_type_well",
        summary:
          `Set ${well} on ${plan.updates.length} cell type${plan.updates.length === 1 ? "" : "s"}` +
          (diffusionType !== undefined ? `, diffusion→${diffusionType}` : ""),
        items: plan.updates.map((u) => ({ collection: "cellTypes" as const, id: u.id, after: u.after })),
        result: {
          selected: plan.targets.length,
          changed: plan.updates.length,
          changedTypes: plan.changed,
          skipped: plan.skipped
        }
      };
    });
  }
};

// ─── rename_nets ────────────────────────────────────────────────────

interface NetRenameRule {
  netId?: string;
  from?: string;
  to?: string;
  prefix?: string;
  suffix?: string;
  filter?: string;
}

function netGeometryKey(net: AnnotationNet): string {
  if (net.nodes.length === 0) return `empty:${net.id}`;
  return net.nodes
    .map((n) => `${Math.round(n.x * 10) / 10},${Math.round(n.y * 10) / 10}`)
    .sort()
    .join("|");
}

function netAudit(annotations: DieAnnotations) {
  const nets = annotations.nets ?? [];
  const byName = new Map<string, AnnotationNet[]>();
  for (const net of nets) {
    const key = net.name.trim().toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), net]);
  }
  const duplicateNames = [...byName.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([name, list]) => ({
      name,
      count: list.length,
      nets: list.map((n) => ({
        id: n.id,
        name: n.name,
        nodes: n.nodes.length,
        edges: n.edges.length,
        box: unionBoxes([
          {
            x: Math.min(...n.nodes.map((p) => p.x)),
            y: Math.min(...n.nodes.map((p) => p.y)),
            width:
              Math.max(...n.nodes.map((p) => p.x)) - Math.min(...n.nodes.map((p) => p.x)),
            height:
              Math.max(...n.nodes.map((p) => p.y)) - Math.min(...n.nodes.map((p) => p.y))
          }
        ])
      }))
    }));

  const byGeometry = new Map<string, AnnotationNet[]>();
  for (const net of nets) {
    if (net.nodes.length === 0) continue;
    const key = netGeometryKey(net);
    byGeometry.set(key, [...(byGeometry.get(key) ?? []), net]);
  }
  const identicalGeometry = [...byGeometry.values()]
    .filter((list) => list.length > 1)
    .map((list) => ({
      ids: list.map((n) => n.id),
      names: list.map((n) => n.name),
      nodes: list[0].nodes.length,
      note: "same vertex coordinates (not necessarily the same net: check edges/layers)"
    }));

  return {
    netCount: nets.length,
    duplicateNames,
    identicalGeometry,
    emptyNets: nets.filter((n) => n.nodes.length === 0).map((n) => ({ id: n.id, name: n.name })),
    unnamedNets: nets.filter((n) => !n.name.trim()).map((n) => n.id)
  };
}

const renameNets: ToolDef = {
  name: "rename_nets",
  title: "Rename nets (batch) / audit net names",
  description:
    "Rename nets atomically, or audit them. Rename via `renames` [{netId|from, to}], or via `map` {from: to}, or " +
    "via `prefix` / `suffix` / `filter` (regex). Names are validated to be unique (case-insensitive, SPICE rules) " +
    "unless allowDuplicates. With no rename rule (or reportOnly:true) it returns: duplicate net names, nets with " +
    "identical vertex geometry, empty and unnamed nets — the check that told us 'Net 95 / copy / copy copy' were " +
    "three different series nodes. Requires \"Full edits\" to actually rename.",
  inputSchema: {
    type: "object",
    properties: {
      renames: {
        type: "array",
        items: {
          type: "object",
          properties: {
            netId: { type: "string" },
            from: { type: "string", description: "Exact current name (ambiguous names need netId)." },
            to: { type: "string" }
          },
          required: ["to"]
        }
      },
      map: { type: "object", additionalProperties: { type: "string" }, description: "Current name → new name." },
      prefix: { type: "string" },
      suffix: { type: "string" },
      filter: { type: "string", description: "Regex on the current name; only matching nets are renamed." },
      dryRun: { type: "boolean", description: "Return the plan without writing." },
      reportOnly: { type: "boolean", description: "Only audit names / geometry." },
      allowDuplicates: { type: "boolean", description: "Allow two nets to end up with the same name (default false)." }
    },
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
  run: async (ctx, args) => {
    const annotations = await readAnnotations(ctx.dataRoot, ctx.dieId);
    const nets = annotations.nets ?? [];

    if (args.reportOnly === true || (args.renames === undefined && args.map === undefined && args.prefix === undefined && args.suffix === undefined)) {
      return textResult({ ok: true, reportOnly: true, ...netAudit(annotations) });
    }

    const rules: NetRenameRule[] = [];
    if (Array.isArray(args.renames)) {
      for (const raw of args.renames) {
        const o = raw as Record<string, unknown>;
        rules.push({ netId: str(o, "netId", true), from: str(o, "from", true), to: str(o, "to") });
      }
    }
    if (args.map && typeof args.map === "object") {
      for (const [from, to] of Object.entries(args.map as Record<string, unknown>)) {
        if (typeof to !== "string") throw new ToolInputError(`map["${from}"] must be a string`);
        rules.push({ from, to });
      }
    }
    const prefix = str(args, "prefix", true);
    const suffix = str(args, "suffix", true);
    const filterText = str(args, "filter", true);
    let filter: RegExp | undefined;
    if (filterText !== undefined) {
      try {
        filter = new RegExp(filterText);
      } catch (error) {
        throw new ToolInputError(`Invalid filter regex: ${(error as Error).message}`);
      }
    }

    const explicit = new Map<string, string>(); // net id → new name
    const problems: string[] = [];
    for (const rule of rules) {
      let target: AnnotationNet | undefined;
      if (rule.netId) {
        target = nets.find((n) => n.id === rule.netId);
        if (!target) throw new ToolInputError(`No net with id ${rule.netId}`);
      } else if (rule.from !== undefined) {
        const matches = nets.filter((n) => n.name === rule.from);
        if (matches.length === 0) throw new ToolInputError(`No net named "${rule.from}"`);
        if (matches.length > 1) {
          throw new ToolInputError(
            `"${rule.from}" matches ${matches.length} nets (${matches.map((n) => n.id).join(", ")}); use netId`
          );
        }
        target = matches[0];
      }
      if (!target) continue;
      const to = (rule.to ?? `${prefix ?? ""}${target.name}${suffix ?? ""}`).trim();
      if (!to) throw new ToolInputError(`Refusing to rename "${target.name}" to an empty name`);
      explicit.set(target.id, to);
    }

    if (prefix !== undefined || suffix !== undefined || filter !== undefined) {
      for (const net of nets) {
        if (explicit.has(net.id)) continue;
        if (filter && !filter.test(net.name)) continue;
        const to = `${prefix ?? ""}${net.name}${suffix ?? ""}`.trim();
        if (!to) throw new ToolInputError(`Prefix/suffix would empty the name of "${net.name}"`);
        if (to !== net.name) explicit.set(net.id, to);
      }
    }

    if (explicit.size === 0) {
      return textResult({ ok: true, changed: 0, message: "No rule matched a net", ...netAudit(annotations) });
    }

    const finalNames = nets.map((net) => explicit.get(net.id) ?? net.name);
    const seen = new Map<string, string[]>();
    nets.forEach((net, i) => {
      const key = finalNames[i].trim().toLowerCase();
      seen.set(key, [...(seen.get(key) ?? []), net.id]);
    });
    const collisions = [...seen.entries()].filter(([, ids]) => ids.length > 1);
    if (collisions.length > 0 && args.allowDuplicates !== true) {
      throw new ToolInputError(
        `Rename would create duplicate net names: ` +
          collisions.map(([name, ids]) => `"${name}" (${ids.join(", ")})`).join("; ") +
          `. Pass allowDuplicates:true if this is intentional.`
      );
    }

    const plan = nets
      .filter((net) => explicit.has(net.id))
      .map((net) => ({ id: net.id, from: net.name, to: explicit.get(net.id) as string }));

    const apply = (current: DieAnnotations) => {
      const currentNets = current.nets ?? [];
      const items: Array<{ collection: "nets"; id: string; after: AnnotationNet }> = [];
      for (const net of currentNets) {
        const to = explicit.get(net.id);
        if (to === undefined) continue;
        items.push({ collection: "nets", id: net.id, after: { ...net, name: to } });
      }
      return items;
    };

    if (args.dryRun === true) {
      return textResult({
        ok: true,
        dryRun: true,
        wouldRename: plan.length,
        renames: plan,
        collisions: collisions.map(([name, ids]) => ({ name, ids })),
        audit: netAudit(annotations)
      });
    }

    return write(ctx, "full", (current) => {
      const items = apply(current);
      if (items.length === 0) {
        return { tool: "rename_nets", summary: "No net to rename", items: [], result: { changed: 0 } };
      }
      return {
        tool: "rename_nets",
        summary: `Rename ${items.length} net${items.length === 1 ? "" : "s"}`,
        items,
        result: {
          changed: items.length,
          renames: items.map((item) => ({ id: item.id, to: item.after.name })),
          collisions: collisions.map(([name, ids]) => ({ name, ids }))
        }
      };
    });
  }
};

export const ANALYZE_TOOLS: ToolDef[] = [
  analyzeNetlist,
  findShapes,
  sampleLayers,
  findImageBlobs,
  setCellTypeWell,
  renameNets
];
