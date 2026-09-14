/**
 * interactiveAnalogLayout.ts — Layout + routing engine for the
 * interactive analog schematic.
 *
 * Initial layout mirrors the STATIC netlist2svg pipeline (quality
 * parity): each device becomes an ELK node with PORTS at the skin's
 * pin anchors (`portConstraints: FIXED_POS`, same trick as
 * netlist.tsx), hyperedges split into binary driver→consumer edges,
 * ELK layered runs with ORTHOGONAL routing and direction DOWN — and we
 * keep the layout DATA (positions + edge polylines) instead of
 * rendering an SVG string.
 *
 * Drag-time re-routing is LOCAL and synchronous: only the nets
 * touched by the moved device are re-routed, through a scored L/Z
 * candidate router (picks the candidate with least device-bbox
 * overlap). ELK is never run per-frame.
 *
 * Locked devices: elkjs 0.11.1 cannot pin individual nodes (verified
 * empirically — `fixed` keeps coords but never routes edges; layered
 * re-layers everything), so locked devices are EXCLUDED from the ELK
 * graph and their wires are re-routed locally.
 */

import ELK from "elkjs/lib/elk.bundled.js";
import type { AnalogDevice } from "shared";
import {
  templateForDevice,
  pinForTerminal,
  mosType,
  type SymbolTable,
} from "./interactiveSymbols";
import { computeJunctions, type PlacedEdge } from "./netlist";
import type { LayoutStrategy, LayoutDirection, CompactionLevel } from "./netlist2svgSkin";

// ── Public types ─────────────────────────────────────────────────

export type Point = { x: number; y: number };

export interface Obstacle {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WireData {
  polylines: Point[][];
  junctions: Point[];
  /** Per-edge trace for surgical re-route. When present, only edges
   *  touching a moved device are re-routed; others stay pixel-identical
   *  to the ELK pass. Optional — absent → full re-route. */
  edges?: TracedEdge[];
}

/** One routed edge of a net: the orthogonal wire connecting two device
 *  terminals (or a device terminal to a synthetic hub). `fromKey`/`toKey`
 *  are device keys; `"__hub__"` marks a synthetic N-terminal hub. */
export interface TracedEdge {
  id: string;
  netId: number;
  fromKey: string;
  toKey: string;
  /** Terminal name at each end (from the port id) — used by surgical
   *  re-route to pick the correct pin anchor. */
  fromTerminal: string;
  toTerminal: string;
  polylines: Point[][];
}

/** Anchor paired with its device key + terminal so local routing can
 *  build per-edge traces (surgical re-route). */
export interface AnchorInfo {
  point: Point;
  deviceKey: string;
  terminal: string;
}

export interface InteractiveLayoutResult {
  /** Top-left position per node key (devices + VDD/GND + io pins). */
  positions: Record<string, Point>;
  sizes: Record<string, { w: number; h: number }>;
  /** Per-net routed wires (ELK ortho routes on initial layout). */
  wires: Map<number, WireData>;
  bbox: { width: number; height: number };
  /** True when ELK failed and grid fallback was used. */
  usedFallback: boolean;
  /** ELK settings actually applied — same as requested unless ELK kept
   *  failing and the auto-degrade stepped them down. */
  applied?: { strategy: LayoutStrategy; direction: LayoutDirection; compaction: CompactionLevel };
}

export interface AnalogLayoutOptions {
  vdd?: string;
  gnd?: string;
  /** Emit inputExt io-pin nodes for die-level named nets. */
  showIo?: boolean;
  /** Explicit io net ids (from collectDieWideAnalogDevices). */
  ioNetIds?: Set<number>;
  /** Node keys excluded from ELK placement (locked devices — elkjs
   *  cannot pin individual nodes). Their terminals still count as net
   *  members, so wires re-route locally to their stored anchors. */
  excludeKeys?: Set<string>;
  /** ELK layered node placement strategy (default BRANDES_KOEPF). */
  strategy?: LayoutStrategy;
  /** Layout flow direction (default DOWN — VDD top, GND bottom). */
  direction?: LayoutDirection;
  /** Post-compaction level 0-4 (0=off, 1=LUT, 2=scanline,
   *  3=scanline+sweep, 4=pocket). Default 2, matching the static view. */
  compaction?: CompactionLevel;
  /** Gap between adjacent devices (elk.spacing.nodeNode). Static default 35. */
  nodeNode?: number;
  /** Gap between device layers (elk.layered.spacing.nodeNodeBetweenLayers).
   *  Static default 5. */
  betweenLayers?: number;
  /** Gap between wire and wire (elk.spacing.edgeEdge). Undefined → ELK default. */
  edgeEdge?: number;
  /** Gap between wire and device (elk.spacing.edgeNode). Undefined → ELK default. */
  edgeNode?: number;
  /** Prefer straight edges over balanced placement (elk.layered.nodePlacement.favorStraightEdges).
   *  Always passed explicitly so `false` overrides ELK's orthogonal auto-default
   *  of true. Default true (best for orthogonal schematic layout). */
  favorStraightEdges?: boolean;
  /** Hierarchy blocks (floorplan regions) collapsed into subcircuit
   *  rectangles. When present they are laid out as `kind:"block"` nodes. */
  blocks?: HierarchyBlock[];
  /** Block boundary pins (external nets of the currently-open region).
   *  Rendered as inputExt/outputExt pseudo-devices at the layout edges. */
  blockPins?: Array<{ netId: number; name: string; direction: "input" | "output" }>;
}

/**
 * Port specs for a hierarchy block: one West (input) / East (output) stub
 * per external net. Mirror of the static block diagram.
 */
function blockPorts(b: HierarchyBlock): NodePortSpec[] {
  const size = blockSize(b);
  return blockPortStubs(b, size).map((s) => ({
    pid: s.terminal,
    x: s.dx,
    y: s.dy,
    side: s.isInput ? "WEST" : "EAST",
    netId: b.nets.find((n) => `${n.direction === "input" ? "in" : "out"}_${n.name}` === s.terminal)!.netId,
    terminal: s.terminal,
  }));
}

/** Read an optional spacing option, falling back to a per-key default. */
function spacingOf(v: number | undefined, dflt: number): string {
  return v == null ? String(dflt) : String(v);
}

// ── Hierarchy blocks (floorplan regions as subcircuit rectangles) ──

/** A floorplan region collapsed into a schematic block. */
export interface HierarchyBlock {
  /** Region id — becomes the node key (deviceKey = `blk:<regionId>`). */
  regionId: string;
  /** Display name (region.name or id). */
  name: string;
  /** External nets this block exposes as ports:
   *  direction input → pin on the LEFT (WEST), output → RIGHT (EAST). */
  nets: Array<{ netId: number; name: string; direction: "input" | "output" }>;
}

/** Layout height of a block with `n` ports (rows stacked 18px). */
function blockHeight(portCount: number): number {
  return Math.max(48, 22 + portCount * 20);
}
const BLOCK_MIN_WIDTH = 90;
const BLOCK_MAX_WIDTH = 260;

/**
 * Sized block box: width scales with the longest label (block name + port
 * net names) so text fits, height from the number of ports. A small extra
 * pad keeps labels off the box edge (the ELK nodeNode gap is measured from
 * this outer box, so neighbours never touch the rendered block).
 */
export function blockSize(b: HierarchyBlock): { w: number; h: number } {
  const h = blockHeight(b.nets.length) + 12;
  let maxLen = b.name.length;
  for (const n of b.nets) maxLen = Math.max(maxLen, n.name.length);
  // ~7px per glyph at 8-9px font with a small fixed padding + side pad.
  const w = Math.max(BLOCK_MIN_WIDTH, Math.min(BLOCK_MAX_WIDTH, 40 + maxLen * 7 + 16));
  return { w, h };
}

/** Block-relative port stubs: positions + direction, reused by canvas labels. */
export interface BlockPortStub {
  terminal: string;
  netName: string;
  dx: number;
  dy: number;
  isInput: boolean;
}

/** Port stubs for a hierarchy block (inputs left / outputs right). */
export function blockPortStubs(b: HierarchyBlock, size: { w: number; h: number }): BlockPortStub[] {
  const ins = b.nets.filter((n) => n.direction === "input");
  const outs = b.nets.filter((n) => n.direction === "output");
  const inStep = ins.length > 0 ? (size.h - 22) / (ins.length + 1) : 0;
  const outStep = outs.length > 0 ? (size.h - 22) / (outs.length + 1) : 0;
  const stubs: BlockPortStub[] = [];
  ins.forEach((n, i) => stubs.push({ terminal: `in_${n.name}`, netName: n.name, dx: 0, dy: 22 + (i + 1) * inStep, isInput: true }));
  outs.forEach((n, i) => stubs.push({ terminal: `out_${n.name}`, netName: n.name, dx: size.w, dy: 22 + (i + 1) * outStep, isInput: false }));
  return stubs;
}

/**
 * Build synthetic AnalogDevice nodes for hierarchy blocks. Each block owns
 * terminals named `in_<net>` / `out_<net>` (the canvas routes wires against
 * these + the port lookup), and devicePorts() maps them to WEST/EAST pins.
 */
export function blockDevices(blocks: HierarchyBlock[]): AnalogDevice[] {
  return blocks.map((b) => ({
    id: `blk:${b.regionId}`,
    kind: "block",
    instanceName: `blk:${b.regionId}`,
    layer: "metal1",
    bbox: { x: 0, y: 0, width: 1, height: 1 },
    geometry: {},
    terminals: b.nets.map((n) => ({
      name: `${n.direction === "input" ? "in" : "out"}_${n.name}`,
      netId: n.netId,
    })),
  }) as unknown as AnalogDevice);
}

/** Device-key prefix for hierarchy blocks. */
export function isBlockKey(key: string): boolean {
  return key.startsWith("blk:");
}

/** True when the device is a synthetic hierarchy block (not a real device). */
export function isBlockDevice(d: AnalogDevice): boolean {
  return (d.kind as string) === "block";
}

/**
 * External nets of each region: nets used by the region AND (used elsewhere
 * OR a die IO pin). Mirrors the static block diagram's port selection —
 * only cross-region / io nets become block ports.
 */
export function regionExternalNets(
  floorplanDevices: Map<string, AnalogDevice[]>,
  unassigned: AnalogDevice[],
  ioNetIds: Set<number>,
  namedNets: Map<number, string>,
  props: { vdd: string; gnd: string },
  regionNames?: Map<string, string>,
): HierarchyBlock[] {
  const blocks: HierarchyBlock[] = [];
  const usedElsewhere = new Set<number>();
  for (const d of unassigned) {
    for (const t of d.terminals) if (t.netId >= 0) usedElsewhere.add(t.netId);
  }
  const regionNetSets = new Map<string, Set<number>>();
  for (const [rid, devs] of floorplanDevices) {
    const s = new Set<number>();
    for (const d of devs) for (const t of d.terminals) if (t.netId >= 0) s.add(t.netId);
    regionNetSets.set(rid, s);
  }
  const regimeIds = [...regionNetSets.keys()];
  for (let i = 0; i < regimeIds.length; i++) {
    const nets = regionNetSets.get(regimeIds[i])!;
    for (const netId of nets) {
      for (let j = i + 1; j < regimeIds.length; j++) {
        if (regionNetSets.get(regimeIds[j])!.has(netId)) { usedElsewhere.add(netId); break; }
      }
    }
  }

  for (const [rid, devs] of floorplanDevices) {
    if (devs.length === 0) continue;
    const regionNets = regionNetSets.get(rid)!;
    const nets: HierarchyBlock["nets"] = [];
    for (const netId of regionNets) {
      const name = namedNets.get(netId);
      if (!name) continue;
      if (name === props.vdd || name === props.gnd) continue; // global power, not a block port
      if (!usedElsewhere.has(netId) && !ioNetIds.has(netId)) continue; // region-local
      const direction = inferBlockPortDirection(devs, netId);
      nets.push({ netId, name, direction });
    }
    if (nets.length === 0) continue;
    const displayName = regionNames?.get(rid) ?? rid;
    blocks.push({ regionId: rid, name: displayName, nets });
  }
  return blocks;
}

function inferBlockPortDirection(
  regionDevices: AnalogDevice[],
  netId: number,
): "input" | "output" {
  let hasGate = false;
  let hasPassive = false;
  for (const d of regionDevices) {
    for (const t of d.terminals) {
      if (t.netId !== netId) continue;
      if (d.kind === "mos" && t.name === "G") hasGate = true;
      else if ((d.kind === "bjt_npn" || d.kind === "bjt_pnp") && t.name === "B") hasGate = true;
      else if ((d.kind === "jfet_n" || d.kind === "jfet_p") && t.name === "G") hasGate = true;
      else hasPassive = true;
    }
  }
  if (hasGate && hasPassive) return "output"; // inout — treat as output pin
  if (hasGate) return "input";
  return "output";
}

/** Defaults kept aligned with the static skin's <s:layoutEngine>. */
export const INTERACTIVE_ELK_DEFAULTS = {
  nodeNode: 35,
  betweenLayers: 5,
  edgeEdge: 10,
  edgeNode: 12,
} as const;

// ── ELK singleton (same pattern as netlist.tsx) ──────────────────

type ElkLike = { layout: (graph: unknown) => Promise<any> };
const elk: ElkLike = new (ELK as unknown as { new (): ElkLike })();

// ── Device → node helpers ────────────────────────────────────────

export function deviceKey(d: AnalogDevice): string {
  return d.instanceName ?? d.id;
}

interface NodePortSpec {
  pid: string;
  x: number;
  y: number;
  side: string;
  netId: number;
  /** Terminal name (e.g. "D", "S", "G") — used to match the right port
   *  when a device has multiple terminals on the same net. */
  terminal: string;
}

/** All wired terminals of a device as ELK port specs (skin anchors). */
function devicePorts(d: AnalogDevice, table: SymbolTable): NodePortSpec[] {
  const template = templateForDevice(table, d);
  if (!template) return [];
  const sideOf = (pos: string): string =>
    pos === "top" ? "NORTH" : pos === "bottom" ? "SOUTH" : pos === "left" ? "WEST" : "EAST";
  const out: NodePortSpec[] = [];
  for (const term of d.terminals) {
    if (term.netId < 0) continue;
    const pin = pinForTerminal(d, term.name, template);
    if (!pin) continue;
    out.push({
      pid: pin.pid,
      x: pin.dx,
      y: pin.dy,
      side: sideOf(pin.position),
      netId: term.netId,
      terminal: term.name,
    });
  }
  return out;
}

/** Synthesized power devices: one symbol per power-net. If multiple
 *  netIds share the same power name (e.g. two "GDD nets — common for
 *  substrate connections that aren't wire-connected), a SEPARATE symbol is
 *  created per netId with a unique key ("GND:109"). This avoids key
 *  collisions in positions/portsByKey and lets the user see distinct
 *  power domains. Each symbol has a single terminal. */
export function powerDevices(
  devices: AnalogDevice[],
  namedNets: Map<number, string>,
  opts: AnalogLayoutOptions,
): AnalogDevice[] {
  const vdd = opts.vdd ?? "VDD";
  const gnd = opts.gnd ?? "GND";
  const used = new Set<number>();
  for (const d of devices) for (const t of d.terminals) if (t.netId >= 0) used.add(t.netId);
  const out: AnalogDevice[] = [];
  for (const [netId, name] of namedNets) {
    if (!used.has(netId)) continue;
    if (name === vdd || name === gnd) {
      out.push({
        id: `${name}:${netId}`,
        kind: "power",
        instanceName: `${name}:${netId}`,
        layer: "metal1",
        bbox: { x: 0, y: 0, width: 1, height: 1 },
        terminals: [{ name: "PLUS", netId }],
      } as unknown as AnalogDevice);
    }
  }
  return out;
}

/** Nets that are die-level io (named, not power). */
export function ioNetList(
  devices: AnalogDevice[],
  namedNets: Map<number, string>,
  opts: AnalogLayoutOptions,
): Array<{ netId: number; name: string }> {
  if (!opts.showIo) return [];
  const vdd = opts.vdd ?? "VDD";
  const gnd = opts.gnd ?? "GND";
  const used = new Set<number>();
  for (const d of devices) for (const t of d.terminals) if (t.netId >= 0) used.add(t.netId);
  const out: Array<{ netId: number; name: string }> = [];
  for (const [netId, name] of namedNets) {
    if (!used.has(netId)) continue;
    if (name === vdd || name === gnd) continue;
    if (opts.ioNetIds && !opts.ioNetIds.has(netId)) continue;
    out.push({ netId, name });
  }
  return out;
}

/** Terminal→net membership index used by drag re-routing. */
export function buildNetIndex(
  devices: AnalogDevice[],
  opts: AnalogLayoutOptions,
  extraDevices: AnalogDevice[] = [],
): Map<number, Array<{ deviceKey: string; terminal: string }>> {
  const index = new Map<number, Array<{ deviceKey: string; terminal: string }>>();
  const all = [...devices, ...extraDevices];
  for (const d of all) {
    const key = deviceKey(d);
    for (const term of d.terminals) {
      if (term.netId < 0) continue;
      let list = index.get(term.netId);
      if (!list) index.set(term.netId, (list = []));
      list.push({ deviceKey: key, terminal: term.name });
    }
  }
  return index;
}

/**
 * Port role of a terminal, mirroring the STATIC netlist2svg convention
 * (derived from the vendored bundle's classification):
 *
 *   - skin pin `s:position` top → input, bottom → output;
 *   - left/right pins → the explicit `port_directions` netlist2svgFormat
 *     assigns (NMOS D input / S output; PMOS S input / D output; BJT
 *     E output; JFET S output; MOS G/B and BJT B input);
 *   - power: vcc (A bottom) is the driver of its rail, gnd (A top) is a
 *     SINK (the rail is driven by e.g. NMOS S terminals);
 *   - io pseudo-nodes are inputExt = input.
 *
 * Undefined role → device is neither a driver nor consumer in ELK edge
 * terms, but still participates in the final routing (bridge/fallback).
 */
export type PortRole = "input" | "output" | undefined;

function roleFromPosition(position: string, d: AnalogDevice): PortRole {
  // The STATIC bundle classifies pins by skin position first:
  //   top → input, bottom → output
  // and only left/right pins go through explicit port_directions
  // (netlist2svgFormat: MOS G/B input, BJT B input, JFET G input;
  //  passive/diode left → input, right → output as ELK default).
  if (position === "top") return "input";
  if (position === "bottom") return "output";
  const kind = d.kind;
  if (kind === "mos") return "input"; // G/B are always inputs
  if (kind === "bjt_npn" || kind === "bjt_pnp") return "input"; // B left
  if (kind === "jfet_n" || kind === "jfet_p") return "input"; // G left
  // passives/diodes/generic with left/right pins: ELK position default
  return position === "left" ? "input" : "output";
}

/** Driver terminal of a net: prefer a port-directions "output" pin
 *  (NMOS S, PMOS D, BJT E), else the first terminal. Mirrors the
 *  port_directions netlist2svgFormat assigns for the static view.
 *  Kept for fallback path (bridge routing) only; edge building uses
 *  `portRole` (static multi-driver convention). */
function driverOf(netTerminals: Array<{ deviceKey: string; device: AnalogDevice; terminal: string }>): string {
  for (const t of netTerminals) {
    const kind = t.device.kind;
    if (kind === "mos") {
      const isP = mosType(t.device) === "pmos";
      if (t.terminal === (isP ? "D" : "S")) return t.deviceKey;
    } else if (kind === "bjt_npn" || kind === "bjt_pnp") {
      if (t.terminal === "E") return t.deviceKey;
    } else if (kind === "jfet_n" || kind === "jfet_p") {
      if (t.terminal === "S") return t.deviceKey;
    }
  }
  return netTerminals[0]?.deviceKey ?? "";
}

/** Fan-out guard for power rails / bus nets: a net with N drivers × M
 *  consumers would otherwise issue N×M ELK edges and both explode the
 *  graph and risk a layered-crash. Above this product we collapse to a
 *  single (hub) driver → all consumers, matching how a rail is drawn. */
const MAX_EDGES_PER_NET = 48;

// ── ELK graph build + run ────────────────────────────────────────

const POWER_TEMPLATE_SIZE = { vcc: { w: 20, h: 30 }, gnd: { w: 20, h: 30 }, io: { w: 30, h: 20 } };

/** Run the full ELK-with-ports layout (async).
 *
 * Settings degradation: ELK layered with BRANDES_KOEPF + heavy
 * post-compaction is known to throw on some large graphs (same as the
 * static view). Instead of dropping straight to grid we step the
 * requested settings down — compaction requested→0, then strategy
 * BRANDES_KOEPF→INTERACTIVE→SIMPLE — and only fall back to grid if
 * everything fails. The settings actually applied are reported in
 * `result.applied` so the UI can show the degradation. */
export async function runInteractiveLayout(
  devices: AnalogDevice[],
  namedNets: Map<number, string>,
  table: SymbolTable,
  opts: AnalogLayoutOptions = {},
): Promise<InteractiveLayoutResult> {
  const strategy = opts.strategy ?? "BRANDES_KOEPF";
  const direction = opts.direction ?? "DOWN";
  const requestedCompaction = opts.compaction ?? 2;
  const strategyOrder: LayoutStrategy[] =
    strategy === "BRANDES_KOEPF" ? ["BRANDES_KOEPF", "INTERACTIVE", "SIMPLE"]
    : strategy === "INTERACTIVE" ? ["INTERACTIVE", "SIMPLE"]
    : ["SIMPLE"];

  for (let si = 0; si < strategyOrder.length; si++) {
    const s = strategyOrder[si];
    // Later (fallback) strategies start from a moderate compaction so a
    // catastrophic graph doesn't burn through every level again.
    const startCompaction = si === 0 ? requestedCompaction : Math.min(requestedCompaction, 2);
    for (let c = startCompaction; c >= 0; c--) {
      try {
        const res = await elkInteractiveLayout(devices, namedNets, table, {
          ...opts,
          strategy: s,
          direction,
          compaction: c as CompactionLevel,
        });
        res.applied = { strategy: s, direction, compaction: c as CompactionLevel };
        return res;
      } catch (err) {
        console.warn(
          `[interactiveAnalogLayout] ELK failed (strategy=${s}, compaction=${c}, direction=${direction}), degrading:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
  console.warn("[interactiveAnalogLayout] all ELK settings failed — grid fallback");
  return gridFallback(devices, namedNets, table, opts);
}

async function elkInteractiveLayout(
  devices: AnalogDevice[],
  namedNets: Map<number, string>,
  table: SymbolTable,
  opts: AnalogLayoutOptions,
): Promise<InteractiveLayoutResult> {
  const powers = powerDevices(devices, namedNets, opts);
  const ioNets = ioNetList(devices, namedNets, opts);
  const blocks = opts.blocks ?? [];
  const blockDevs = blockDevices(blocks);
  const all = [...devices, ...powers, ...blockDevs];

  // Terminal membership: netId → [{deviceKey, terminal}]
  const netMembers = new Map<number, Array<{ deviceKey: string; device: AnalogDevice; terminal: string }>>();
  const portsByKey = new Map<string, NodePortSpec[]>();
  const sizes: Record<string, { w: number; h: number }> = {};

  for (const d of all) {
    const key = deviceKey(d);
    const template = templateForDevice(table, d);
    const isGnd = (d.instanceName ?? "").startsWith(opts.gnd ?? "GND");
    const isBlock = isBlockDevice(d);
    const bIndex = blocks.findIndex((b) => b.regionId === key.slice("blk:".length));
    const size =
      isBlock
        ? blockSize(bIndex >= 0 ? blocks[bIndex] : { regionId: key, name: key, nets: [] })
        : (d.kind as string) === "power"
          ? isGnd ? POWER_TEMPLATE_SIZE.gnd : POWER_TEMPLATE_SIZE.vcc
          : template
            ? { w: template.width, h: template.height }
            : { w: 30, h: 40 };
    sizes[key] = size;

    const ports: NodePortSpec[] = [];
    if ((d.kind as string) === "power") {
      for (const term of d.terminals) {
        if (term.netId < 0) continue;
        // vcc pin A at (10,30) bottom; gnd pin A at (10,-15) top of body.
        ports.push({
          pid: "A",
          x: 10,
          y: isGnd ? -15 : 30,
          side: isGnd ? "NORTH" : "SOUTH",
          netId: term.netId,
          terminal: term.name,
        });
      }
    } else if (isBlock && bIndex >= 0) {
      ports.push(...blockPorts(blocks[bIndex]));
    } else {
      ports.push(...devicePorts(d, table));
    }
    portsByKey.set(key, ports);
    for (const term of d.terminals) {
      if (term.netId < 0) continue;
      let list = netMembers.get(term.netId);
      if (!list) netMembers.set(term.netId, (list = []));
      list.push({ deviceKey: key, device: d, terminal: term.name });
    }
  }

  // IO driver nodes (inputExt, one port EAST)
  for (const io of ioNets) {
    const key = `io:${io.netId}`;
    sizes[key] = POWER_TEMPLATE_SIZE.io;
    portsByKey.set(key, [{ pid: "Y", x: 30, y: 10, side: "EAST", netId: io.netId, terminal: "Y" }]);
    netMembers.set(io.netId, [
      ...(netMembers.get(io.netId) ?? []),
      { deviceKey: key, device: { kind: "__io" } as unknown as AnalogDevice, terminal: "Y" },
    ]);
  }

  // Block boundary pin nodes (inputExt / outputExt)
  // When a subcircuit region is open, these represent the block's external nets
  // as pin symbols at the layout edges — same pattern as die I/O pins.
  // Only include pins for nets that have at least one real device member —
  // otherwise the pin would create a self-loop edge (two pins, no device)
  // which crashes ELK's scanline layout.
  const realDeviceNets = new Set<number>();
  for (const d of devices) for (const t of d.terminals) if (t.netId >= 0) realDeviceNets.add(t.netId);
  const blockPins = (opts.blockPins ?? []).filter((bp) => realDeviceNets.has(bp.netId));
  for (const bp of blockPins) {
    const key = `bp:${bp.netId}`;
    const isInput = bp.direction === "input";
    sizes[key] = POWER_TEMPLATE_SIZE.io; // 30x20
    // input pin (outputExt): port A at (0, 10) on WEST
    // output pin (inputExt): port Y at (30, 10) on EAST
    portsByKey.set(key, [{
      pid: isInput ? "A" : "Y",
      x: isInput ? 0 : 30,
      y: 10,
      side: isInput ? "WEST" : "EAST",
      netId: bp.netId,
      terminal: isInput ? "A" : "Y",
    }]);
    netMembers.set(bp.netId, [
      ...(netMembers.get(bp.netId) ?? []),
      { deviceKey: key, device: { kind: "__blockpin" } as unknown as AnalogDevice, terminal: isInput ? "A" : "Y" },
    ]);
  }

  // ELK children — locked devices (excludeKeys) are NOT laid out by
  // ELK (elkjs cannot pin individual nodes); they stay at stored
  // positions and their nets re-route locally.
  type ElkPort = { id: string; x: number; y: number; width: number; height: number; layoutOptions: Record<string, string> };
  type ElkNode = { id: string; width: number; height: number; ports: ElkPort[]; layoutOptions: Record<string, string> };
  const children: ElkNode[] = [];
  for (const d of all) {
    const key = deviceKey(d);
    if (opts.excludeKeys?.has(key)) continue;
    const size = sizes[key];
    children.push({
      id: key,
      width: size.w,
      height: size.h,
      ports: (portsByKey.get(key) ?? []).map((p, i) => ({
        id: `${key}:${p.terminal}:${i}`,
        x: p.x,
        y: p.y,
        width: 0,
        height: 0,
        layoutOptions: { "port.side": p.side },
      })),
      layoutOptions: { portConstraints: "FIXED_POS" },
    });
  }
  for (const io of ioNets) {
    const key = `io:${io.netId}`;
    children.push({
      id: key,
      width: sizes[key].w,
      height: sizes[key].h,
      ports: [{
        id: `${key}:Y:0`,
        x: 30,
        y: 10,
        width: 0,
        height: 0,
        layoutOptions: { "port.side": "EAST" },
      }],
      layoutOptions: {
        portConstraints: "FIXED_POS",
        "layered.layering.layerConstraint": "FIRST",
      },
    });
  }
  // Block boundary pin nodes — same sizing as IO, placed at layout edges.
  // Input pins (outputExt, port WEST) get WEST ports; output pins
  // (inputExt, port EAST) get EAST ports.  No layerConstraint — ELK
  // positions them naturally via port sides, avoiding scanline crashes
  // on small graphs (1–2 devices).
  for (const bp of blockPins) {
    const key = `bp:${bp.netId}`;
    const isInput = bp.direction === "input";
    const portId = isInput ? "A" : "Y";
    const portX = isInput ? 0 : 30;
    children.push({
      id: key,
      width: sizes[key].w,
      height: sizes[key].h,
      ports: [{
        id: `${key}:${portId}:0`,
        x: portX,
        y: 10,
        width: 0,
        height: 0,
        layoutOptions: { "port.side": isInput ? "WEST" : "EAST" },
      }],
      layoutOptions: {
        portConstraints: "FIXED_POS",
      },
    });
  }

  // Binary edges per (driver, consumer) — hyperedge split (netlist.tsx
  // convention; ELK layered+ORTHOGONAL rejects multi-source/multi-target).
  //
  // STATIC-convention roles (see roleFromPosition): a net's
  // output-role pins are its drivers, input-role pins its consumers;
  // power vcc is the rail driver, gnd a sink. driver→consumer edges
  // mirror the static view. Guards: driverless → pseudo-driver (first
  // member, as static does); consumerless (all pins output — e.g. a
  // bus pulled by NMOS S only) → star bridge from the first driver;
  // huge fan-out (drivers × consumers > MAX_EDGES_PER_NET) collapses to
  // one hub driver → all consumers so power rails don't explode ELK.
  type ElkEdge = { id: string; sources: string[]; targets: string[] };
  const edges: ElkEdge[] = [];
  const edgeNetId = new Map<string, number>();
  let edgeCounter = 0;
  for (const [netId, members] of netMembers) {
    // Look up the ELK port id for a (device, net, terminal). A device can
    // have multiple terminals on the same net (e.g. NMOS S+B on GND), so we
    // must match by terminal name — not just take the first port on the net.
    // Fallback: if terminal-specific match fails (e.g. port created with
    // different terminal name), match by netId alone. This ensures power
    // symbols (single terminal "PLUS") always get their port found.
    const portOf = (deviceKey: string, netId: number, terminal: string): string | undefined => {
      const specs = portsByKey.get(deviceKey) ?? [];
      let spec = specs.find((p) => p.netId === netId && p.terminal === terminal);
      if (!spec) spec = specs.find((p) => p.netId === netId);
      return spec ? `${deviceKey}:${spec.terminal}:${specs.indexOf(spec)}` : undefined;
    };
    const isIoNet = ioNets.some((io) => io.netId === netId);
    const powerDev = powers.find((p) =>
      (p.terminals ?? []).some((t) => t.netId === netId),
    );

    // Role of each routable member (has a port for this terminal, not locked).
    const routable = members.filter((m) => !opts.excludeKeys?.has(m.deviceKey) && !!portOf(m.deviceKey, netId, m.terminal));
    if (routable.length < 2) continue; // nothing to wire

    const roleOf = (m: { deviceKey: string; device: AnalogDevice; terminal: string }): PortRole => {
      if (powerDev && m.deviceKey === deviceKey(powerDev)) {
        // power roles are fixed by rail kind (vcc driver, gnd sink).
        // powerDev.instanceName is "GND:109" — check prefix, not exact match.
        const isGnd = (powerDev.instanceName ?? "").startsWith((opts.gnd ?? "GND"));
        return isGnd ? "input" : "output";
      }
      if (isIoNet && m.deviceKey === `io:${netId}`) return "input"; // inputExt
      // Block boundary pin: outputExt (input pin, terminal A) = consumer,
      // inputExt (output pin, terminal Y) = driver.
      if (m.deviceKey.startsWith("bp:")) {
        return m.terminal === "A" ? "input" : "output";
      }
      // Hierarchy block: in_* is a consumer, out_* is a driver.
      if (isBlockDevice(m.device)) {
        return m.terminal.startsWith("in_") ? "input" : "output";
      }
      // Direct skin pin position (no ELK-side round-trip needed):
      const template = templateForDevice(table, m.device);
      const pin = template ? pinForTerminal(m.device, m.terminal, template) : undefined;
      return roleFromPosition(pin?.position ?? "", m.device);
    };

    let drivers = routable.filter((m) => roleOf(m) === "output");
    let consumers = routable.filter((m) => roleOf(m) === "input");

    // Consumerless net (everything is an output — e.g. NMOS S×N + vcc):
    // star-bridge from the first driver, so the wires still draw.
    if (consumers.length === 0 && drivers.length > 0) {
      const hub = drivers[0];
      consumers = drivers.slice(1);
      drivers = [hub];
    }
    // Driverless net (e.g. VDD rail when the vcc node was dropped/locked):
    // pseudo-driver = first member (static driverless-net convention).
    if (drivers.length === 0 && consumers.length > 0) {
      drivers = [consumers[0]];
      consumers = consumers.slice(1);
    }
    if (drivers.length === 0 || consumers.length === 0) continue;

    // For power nets, every device needs its own edge to the power symbol
    // (the hub). Don't collapse drivers, and restrict consumers to just
    // the power symbol. This preserves the "bus" look and ensures all
    // devices are connected.
    const netName = namedNets.get(netId);
    const isPowerNet = netName === (opts.vdd ?? "VDD") || netName === (opts.gnd ?? "GND");
    if (isPowerNet && powerDev) {
      const pKey = deviceKey(powerDev);
      // For power nets, ALL non-power devices are drivers (current flows
      // to/from the power rail). Only the power symbol is the consumer.
      // This ensures every device gets its own edge to the power symbol,
      // regardless of pin position-based role classification.
      const powerConsumer = routable.filter((m) => m.deviceKey === pKey);
      const deviceDrivers = routable.filter((m) => m.deviceKey !== pKey);
      drivers = deviceDrivers;
      consumers = powerConsumer.length > 0 ? powerConsumer : consumers.filter((c) => c.deviceKey === pKey);
      if (drivers.length === 0 || consumers.length === 0) {
        // Fallback to original classification if something went wrong
        drivers = routable.filter((m) => roleOf(m) === "output");
        consumers = routable.filter((m) => roleOf(m) === "input");
      }
    } else {
      // Fan-out guard: collapse to a single hub driver when the full
      // product would blow up the ELK graph on a power/bus rail.
      if (drivers.length * consumers.length > MAX_EDGES_PER_NET) {
        drivers = [drivers[0]];
      }
    }

    const srcPort = portOf(drivers[0].deviceKey, netId, drivers[0].terminal);
    if (!srcPort) continue;
    for (const driver of drivers) {
      const dsrc = portOf(driver.deviceKey, netId, driver.terminal);
      if (!dsrc) continue;
      for (const c of consumers) {
        const dstPort = portOf(c.deviceKey, netId, c.terminal);
        if (!dstPort) continue;
        const id = `e${edgeCounter++}`;
        edges.push({ id, sources: [dsrc], targets: [dstPort] });
        edgeNetId.set(id, netId);
      }
    }
  }

  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      // Same three user-facing settings the static netlist2svg path
      // exposes (see netlist2svgSkin.buildSkin): placement strategy,
      // direction, post-compaction. Digit compaction values are what
      // the static skin passes; verified accepted by elkjs 0.11.1.
      "elk.direction": opts.direction ?? "DOWN",
      "elk.layered.nodePlacement.strategy": opts.strategy ?? "BRANDES_KOEPF",
      "elk.layered.compaction.postCompaction.strategy": String(opts.compaction ?? 2),
      "elk.edgeRouting": "ORTHOGONAL",
      // Static parity: the vendored netlist2svg.bundle.js forwards ONLY
      // betweenLayers + nodeNode from the skin's layoutEngine; everything
      // else is ELK defaults. Extra spacings/behavior are optional toggles
      // (Netlist Settings) to fine-tune the layout.
      "elk.spacing.nodeNode": spacingOf(opts.nodeNode, INTERACTIVE_ELK_DEFAULTS.nodeNode),
      "elk.layered.spacing.nodeNodeBetweenLayers": spacingOf(opts.betweenLayers, INTERACTIVE_ELK_DEFAULTS.betweenLayers),
      ...(opts.edgeEdge != null ? { "elk.spacing.edgeEdge": String(opts.edgeEdge) } : {}),
      ...(opts.edgeNode != null ? { "elk.spacing.edgeNode": String(opts.edgeNode) } : {}),
      "elk.layered.nodePlacement.favorStraightEdges": String(opts.favorStraightEdges),
    },
    children,
    edges,
  };

  const result = await elk.layout(graph);

  const positions: Record<string, Point> = {};
  for (const child of result.children ?? []) {
    positions[child.id] = { x: child.x ?? 0, y: child.y ?? 0 };
  }

  // Group routed sections per net → polylines → junctions.
  const byNet = new Map<number, PlacedEdge[]>();
  // Per-edge endpoint device keys + terminal names (for surgical re-route).
  // Port ids: regular `${deviceKey}:${term}:${idx}` (e.g. "Q1:B:0"),
  // io pins `io:${netId}:${term}:${idx}` (e.g. "io:123:Y:0"). The io: prefix
  // contains a colon, so split(":")[0] would yield "io" — wrong. Extract
  // the full key (io:123) and the terminal name from the port id.
  const edgeFromKey = new Map<string, string>();
  const edgeToKey = new Map<string, string>();
  const edgeFromTerm = new Map<string, string>();
  const edgeToTerm = new Map<string, string>();
  // Parse a port id back into (deviceKey, terminal). Port ids are built as
  // `${deviceKey}:${pid}:${idx}` in the ELK graph. The deviceKey itself may
  // contain colons: regular "M_1", io "io:5", power "GND:109". We parse from
  // the right: last segment = idx, second-to-last = pid, rest = deviceKey.
  const deviceKeyFromPort = (portId: string): { key: string; term: string } => {
    const p = String(portId).split(":");
    if (p.length >= 3) {
      const idx = p[p.length - 1];
      const pid = p[p.length - 2];
      const key = p.slice(0, p.length - 2).join(":");
      return { key, term: pid };
    }
    if (p.length === 2) return { key: p[0] ?? "", term: p[1] ?? "" };
    return { key: p[0] ?? "", term: "" };
  };
  for (const e of result.edges ?? []) {
    const netId = edgeNetId.get(e.id);
    if (netId == null) continue;
    const polylines = (e.sections ?? []).map((sec: any) => {
      const pts: Point[] = [{ x: sec.startPoint.x, y: sec.startPoint.y }];
      for (const b of sec.bendPoints ?? []) pts.push({ x: b.x, y: b.y });
      pts.push({ x: sec.endPoint.x, y: sec.endPoint.y });
      return pts;
    });
    let list = byNet.get(netId);
    if (!list) byNet.set(netId, (list = []));
    list.push({ id: e.id, polylines, netId });
    if (e.sources?.[0]) {
      const { key, term } = deviceKeyFromPort(e.sources[0]);
      edgeFromKey.set(e.id, key);
      edgeFromTerm.set(e.id, term);
    }
    if (e.targets?.[0]) {
      const { key, term } = deviceKeyFromPort(e.targets[0]);
      edgeToKey.set(e.id, key);
      edgeToTerm.set(e.id, term);
    }
  }
  const wires = new Map<number, WireData>();
  for (const [netId, placed] of byNet) {
    const edges: TracedEdge[] = placed.map((p) => ({
      id: p.id,
      netId,
      fromKey: edgeFromKey.get(p.id) ?? "",
      toKey: edgeToKey.get(p.id) ?? "",
      fromTerminal: edgeFromTerm.get(p.id) ?? "",
      toTerminal: edgeToTerm.get(p.id) ?? "",
      polylines: p.polylines,
    }));
    wires.set(netId, {
      polylines: placed.flatMap((p) => p.polylines),
      junctions: computeJunctions(placed).map((j) => ({ x: j.x, y: j.y })),
      edges,
    });
  }

  return {
    positions,
    sizes,
    wires,
    bbox: { width: result.width ?? 0, height: result.height ?? 0 },
    usedFallback: false,
  };
}

// ── Grid fallback ────────────────────────────────────────────────

/** Deterministic grid placement — used when ELK fails. Wires are then
 *  routed locally (motion keeps working). */
export function gridFallback(
  devices: AnalogDevice[],
  namedNets: Map<number, string>,
  table: SymbolTable,
  opts: AnalogLayoutOptions = {},
): InteractiveLayoutResult {
  const powers = powerDevices(devices, namedNets, opts);
  const blockDevs = blockDevices(opts.blocks ?? []);
  // Block pin pseudo-devices (same filtering as elkInteractiveLayout)
  const realDeviceNets = new Set<number>();
  for (const d of devices) for (const t of d.terminals) if (t.netId >= 0) realDeviceNets.add(t.netId);
  const blockPins = (opts.blockPins ?? []).filter((bp) => realDeviceNets.has(bp.netId));
  const bpDevs: AnalogDevice[] = blockPins.map((bp) => {
    const isInput = bp.direction === "input";
    return {
      id: `bp:${bp.netId}`,
      kind: "__blockpin",
      instanceName: `bp:${bp.netId}`,
      layer: "metal1",
      bbox: { x: 0, y: 0, width: 1, height: 1 },
      geometry: {},
      terminals: [{ name: isInput ? "A" : "Y", netId: bp.netId }],
    } as unknown as AnalogDevice;
  });
  const all = [...powers, ...blockDevs, ...bpDevs, ...devices];
  const positions: Record<string, Point> = {};
  const sizes: Record<string, { w: number; h: number }> = {};
  let maxW = 40;
  let maxH = 60;
  for (const d of all) {
    const t = templateForDevice(table, d);
    if (isBlockDevice(d)) {
      const b = (opts.blocks ?? []).find((x) => x.regionId === d.id.slice("blk:".length));
      const bs = blockSize(b ?? { regionId: d.id, name: d.id, nets: [] });
      maxW = Math.max(maxW, bs.w);
      maxH = Math.max(maxH, bs.h);
    } else if (t) {
      maxW = Math.max(maxW, t.width);
      maxH = Math.max(maxH, t.height);
    }
  }
  const cols = Math.max(1, Math.ceil(Math.sqrt(all.length)));
  const cw = maxW + 48;
  const ch = maxH + 56;
  all.forEach((d, i) => {
    positions[deviceKey(d)] = {
      x: 16 + (i % cols) * cw,
      y: 16 + Math.floor(i / cols) * ch,
    };
    const t = templateForDevice(table, d);
    sizes[deviceKey(d)] = isBlockDevice(d)
      ? blockSize((opts.blocks ?? []).find((b) => b.regionId === d.id.slice("blk:".length)) ?? { regionId: d.id, name: d.id, nets: [] })
      : (d.kind as string) === "power"
        ? ((d.instanceName ?? "").startsWith(opts.gnd ?? "GND") ? POWER_TEMPLATE_SIZE.gnd : POWER_TEMPLATE_SIZE.vcc)
        : (d.kind as string) === "__blockpin" || (d.kind as string) === "__io"
          ? POWER_TEMPLATE_SIZE.io
          : t ? { w: t.width, h: t.height } : { w: 30, h: 40 };
  });

  // Local routing for all nets.
  const wires = new Map<number, WireData>();
  const netIndex = buildNetIndex(devices, opts, powers);
  // Add block members into the net index so local routing covers block ports.
  for (const bd of blockDevs) {
    for (const t of bd.terminals) {
      if (t.netId < 0) continue;
      let list = netIndex.get(t.netId);
      if (!list) netIndex.set(t.netId, (list = []));
      list.push({ deviceKey: deviceKey(bd), terminal: t.name });
    }
  }
  // Add block pin members into the net index.
  for (const bp of blockPins) {
    const key = `bp:${bp.netId}`;
    const isInput = bp.direction === "input";
    let list = netIndex.get(bp.netId);
    if (!list) netIndex.set(bp.netId, (list = []));
    list.push({ deviceKey: key, terminal: isInput ? "A" : "Y" });
  }
  const obstacles: Obstacle[] = Object.entries(positions).map(([key, p]) =>
    deviceObstacle(p, sizes[key] ?? { w: 30, h: 40 }),
  );
  const keySet = new Set(Object.keys(positions));
  const lookups = new Map<string, SymbolPinLookup | undefined>();
  for (const d of all) lookups.set(deviceKey(d), portsForDeviceStatic(devices, powers, table, opts, deviceKey(d)));
  // Block lookups: hand port pins (no skin template).
  for (const bd of blockDevs) {
    const key = deviceKey(bd);
    const b = (opts.blocks ?? []).find((x) => x.regionId === key.slice("blk:".length));
    if (!b) continue;
    const bp = blockPorts(b);
    lookups.set(key, (terminal: string) => {
      const pin = bp.find((p) => p.pid === terminal);
      return pin ? { dx: pin.x, dy: pin.y } : undefined;
    });
  }
  // Block pin lookups (same pin offsets as ELK path).
  for (const bp of blockPins) {
    const key = `bp:${bp.netId}`;
    const isInput = bp.direction === "input";
    lookups.set(key, (terminal: string) => {
      if (isInput && terminal === "A") return { dx: 0, dy: 10 };
      if (!isInput && terminal === "Y") return { dx: 30, dy: 10 };
      return undefined;
    });
  }
  for (const [netId, members] of netIndex) {
    if (!members.some((m) => keySet.has(m.deviceKey))) continue;
    const anchors = members
      .filter((m) => keySet.has(m.deviceKey))
      .map((m) => ({ point: anchorWorld(m.deviceKey, positions, lookups.get(m.deviceKey), m.terminal), deviceKey: m.deviceKey, terminal: m.terminal }))
      .filter((p): p is AnchorInfo => !!p.point);
    if (anchors.length === 0) continue;
    wires.set(netId, routeNetLocal(anchors, obstacles));
  }

  // bbox
  let maxX = 0, maxY = 0;
  for (const [key, p] of Object.entries(positions)) {
    maxX = Math.max(maxX, p.x + (sizes[key]?.w ?? 30));
    maxY = Math.max(maxY, p.y + (sizes[key]?.h ?? 40));
  }
  return { positions, sizes, wires, bbox: { width: maxX + 16, height: maxY + 16 }, usedFallback: true };
}

/** Skin pin lookup by terminal name for any (real/power) device key. */
function portsForDeviceStatic(
  devices: AnalogDevice[],
  powers: AnalogDevice[],
  table: SymbolTable,
  opts: AnalogLayoutOptions,
  key: string,
): SymbolPinLookup | undefined {
  return terminalPinLookup(devices, powers, table, opts).get(key);
}

type SymbolPinLookup = (terminal: string) => { dx: number; dy: number } | undefined;

/** Per-device-key pin lookup table for anchor math in the canvas
 *  (drag-time re-routing). Power symbols use hardcoded anchors. */
export function terminalPinLookup(
  devices: AnalogDevice[],
  powers: AnalogDevice[],
  table: SymbolTable,
  opts: AnalogLayoutOptions,
): Map<string, SymbolPinLookup | undefined> {
  const map = new Map<string, SymbolPinLookup | undefined>();
  for (const d of devices) {
    const template = templateForDevice(table, d);
    map.set(deviceKey(d), template
      ? (terminal: string) => pinForTerminal(d, terminal, template)
      : undefined);
  }
  for (const p of powers) {
    const isGnd = (p.instanceName ?? "").startsWith(opts.gnd ?? "GND");
    map.set(deviceKey(p), (terminal: string) =>
      terminal === "PLUS" ? { dx: 10, dy: isGnd ? -15 : 30 } : undefined);
  }
  // Hierarchy blocks: hand pins at WEST/EAST stubs.
  for (const b of opts.blocks ?? []) {
    const bp = blockPorts(b);
    map.set(`blk:${b.regionId}`, (terminal: string) => {
      const pin = bp.find((p) => p.pid === terminal);
      return pin ? { dx: pin.x, dy: pin.y } : undefined;
    });
  }
  return map;
}

/** World-space anchor of a terminal pin given device positions. */
export function anchorWorld(
  deviceKey: string,
  positions: Record<string, Point>,
  lookup: SymbolPinLookup | undefined,
  terminal: string,
): Point | undefined {
  const pos = positions[deviceKey];
  const pin = lookup?.(terminal);
  if (!pos || !pin) return undefined;
  return { x: pos.x + pin.dx, y: pos.y + pin.dy };
}

/**
 * Transform a pin (local dx/dy within the symbol box) under a device
 * orientation. Rotation is clockwise about the symbol center, mirror is
 * applied after rotation along the box axes.
 *
 * RETURN units: the SAME local frame the caller uses for `pin.dx/dy` —
 * i.e. top-left origin, y grows down. For rot 90/270 the caller should
 * also swap the node's width/height (see `orientedSize`).
 */
export interface DeviceOrientationLike {
  rot: 0 | 90 | 180 | 270;
  flip: "none" | "h" | "v";
}

export function transformPin(
  pin: { dx: number; dy: number },
  w: number,
  h: number,
  orient?: DeviceOrientationLike,
): { dx: number; dy: number } {
  if (!orient || (orient.rot === 0 && orient.flip === "none")) return { dx: pin.dx, dy: pin.dy };
  // normalize to center-relative coords (before rotation)
  const cx = w / 2;
  const cy = h / 2;
  let x = pin.dx - cx;
  let y = pin.dy - cy;
  // Rotate along the SVG rotate(θ) convention (positive θ = clockwise in
  // screen coords, y down): matrix x' = cos·x − sin·y, y' = sin·x + cos·y.
  switch (orient.rot) {
    case 90: { const nx = -y; y = x; x = nx; break; }
    case 180: { x = -x; y = -y; break; }
    case 270: { const nx = y; y = -x; x = nx; break; }
    default: break;
  }
  if (orient.flip === "h") { x = -x; }
  if (orient.flip === "v") { y = -y; }
  return { dx: x + cx, dy: y + cy };
}

/** Node size under rotation — 90/270 swap width and height. */
export function orientedSize(
  size: { w: number; h: number },
  orient?: DeviceOrientationLike,
): { w: number; h: number } {
  if (orient && (orient.rot === 90 || orient.rot === 270)) return { w: size.h, h: size.w };
  return size;
}

// ── Local drag-time router ───────────────────────────────────────

const OVERLAP_PENALTY = 60;
const WIRE_PENALTY = 200;
const BEND_PENALTY = 2;

/**
 * Extra padding applied to every device's obstacle box on all sides, so
 * wires keep a clear visual distance from the symbol art (the raw symbol
 * template size only covers the glyph; pins and lead stubs sit on/near the
 * edges). Builders should emit obstacles as
 * `{ x: p.x - PAD, y: p.y - PAD, w: os.w + 2*PAD, h: os.h + 2*PAD }`.
 */
export const WIRE_OBSTACLE_PAD = 5;

/** Build an inflated obstacle box for a device at top-left `p`. */
export function deviceObstacle(
  p: Point,
  size: { w: number; h: number },
  orient?: DeviceOrientationLike,
): Obstacle {
  const os = orientedSize(size, orient);
  return { x: p.x - WIRE_OBSTACLE_PAD, y: p.y - WIRE_OBSTACLE_PAD, w: os.w + 2 * WIRE_OBSTACLE_PAD, h: os.h + 2 * WIRE_OBSTACLE_PAD };
}

/**
 * Uniform-grid occupancy index for wire-wire spacing. Built once per
 * re-route from the current segments of OTHER nets (the net being routed
 * is excluded). Cell size = edgeEdge gap; each occupied cell is inflated
 * to its 8 neighbours so a candidate within `edgeEdge` of an existing wire
 * scores a proximity penalty.
 */
export class WireGrid {
  private cells = new Set<string>();
  /** Cell size in px (= edgeEdge gap). */
  readonly cellSize: number;

  constructor(segments: Array<{ a: Point; b: Point }>, gap: number) {
    this.cellSize = Math.max(gap, 2);
    for (const seg of segments) this.rasterize(seg.a, seg.b);
  }

  private key(cx: number, cy: number): string {
    return `${cx},${cy}`;
  }

  /** Mark a 3x3 block of cells around each point along the segment. */
  private rasterize(a: Point, b: Point) {
    const dist = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    if (dist < 0.001) {
      this.markCellBlock(a.x, a.y);
      return;
    }
    const steps = Math.max(1, Math.ceil(dist / (this.cellSize / 2)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      this.markCellBlock(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    }
  }

  private markCellBlock(x: number, y: number) {
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        this.cells.add(this.key(cx + dx, cy + dy));
      }
    }
  }

  /** Length (px) of segment (a,b) that runs within `edgeEdge` of an
   *  existing wire. 0 when clear. */
  proximityLength(a: Point, b: Point): number {
    const dist = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    if (dist < 0.001) return 0;
    const steps = Math.max(1, Math.ceil(dist / (this.cellSize / 2)));
    let occupied = 0;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      if (this.cells.has(this.key(Math.floor(x / this.cellSize), Math.floor(y / this.cellSize)))) occupied++;
    }
    return (occupied / (steps + 1)) * dist;
  }
}

/** Segment length inside an expanded rect (0 if no overlap). */
function segmentRectOverlap(a: Point, b: Point, r: Obstacle, margin: number): number {
  const rx0 = r.x - margin, ry0 = r.y - margin;
  const rx1 = r.x + r.w + margin, ry1 = r.y + r.h + margin;
  if (Math.abs(a.y - b.y) < 0.001) {
    // horizontal
    if (a.y <= ry0 || a.y >= ry1) return 0;
    const lo = Math.min(a.x, b.x), hi = Math.max(a.x, b.x);
    return Math.max(0, Math.min(hi, rx1) - Math.max(lo, rx0));
  }
  if (Math.abs(a.x - b.x) < 0.001) {
    // vertical
    if (a.x <= rx0 || a.x >= rx1) return 0;
    const lo = Math.min(a.y, b.y), hi = Math.max(a.y, b.y);
    return Math.max(0, Math.min(hi, ry1) - Math.max(lo, ry0));
  }
  return 0;
}

function scorePath(path: Point[], obstacles: Obstacle[], edgeNode: number, wireGrid?: WireGrid): number {
  let score = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    score += Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    for (const o of obstacles) score += OVERLAP_PENALTY * segmentRectOverlap(a, b, o, edgeNode);
    if (wireGrid) score += WIRE_PENALTY * wireGrid.proximityLength(a, b);
  }
  score += BEND_PENALTY * Math.max(0, path.length - 2);
  return score;
}

/** Orthogonal candidate paths between two anchors: L-shapes and
 *  Z-shapes with a few deterministic midline offsets. */
function candidatePaths(a: Point, b: Point): Point[][] {
  const cands: Point[][] = [
    [a, { x: b.x, y: a.y }, b], // H-first L
    [a, { x: a.x, y: b.y }, b], // V-first L
  ];
  const midX = (a.x + b.x) / 2;
  const spanX = Math.abs(b.x - a.x);
  for (const off of [0, spanX * 0.25, -spanX * 0.25]) {
    const mx = midX + off;
    cands.push([a, { x: mx, y: a.y }, { x: mx, y: b.y }, b]);
  }
  const midY = (a.y + b.y) / 2;
  const spanY = Math.abs(b.y - a.y);
  for (const off of [0, spanY * 0.25, -spanY * 0.25]) {
    const my = midY + off;
    cands.push([a, { x: a.x, y: my }, { x: b.x, y: my }, b]);
  }
  return cands;
}

function bestPath(a: Point, b: Point, obstacles: Obstacle[], edgeNode: number, wireGrid?: WireGrid): Point[] {
  const cands = candidatePaths(a, b);
  // Obstacle-aware detour rails: when the plain L/Z candidates all cut
  // through a nearby device, offer above/below/left/right corridors.
  // Corridor filter keeps the candidate count bounded during drag.
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  let detours = 0;
  for (const o of obstacles) {
    if (detours >= 8) break;
    if (o.x > x1 + 24 || o.x + o.w < x0 - 24 || o.y > y1 + 24 || o.y + o.h < y0 - 24) continue;
    const m = edgeNode + 4;
    cands.push([a, { x: a.x, y: o.y - m }, { x: b.x, y: o.y - m }, b]);
    cands.push([a, { x: a.x, y: o.y + o.h + m }, { x: b.x, y: o.y + o.h + m }, b]);
    cands.push([a, { x: o.x - m, y: a.y }, { x: o.x - m, y: b.y }, b]);
    cands.push([a, { x: o.x + o.w + m, y: a.y }, { x: o.x + o.w + m, y: b.y }, b]);
    detours++;
  }
  let best = cands[0];
  let bestScore = Infinity;
  for (const c of cands) {
    const s = scorePath(c, obstacles, edgeNode, wireGrid);
    if (s < bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return best;
}

function median(values: number[]): number {
  const v = [...values].sort((x, y) => x - y);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Options for local drag-time routing — wire-device and wire-wire gaps. */
export interface LocalRouteOptions {
  /** Wire-to-device gap (replaces the old hardcoded OBSTACLE_MARGIN).
   *  Default 12 (ELK default edgeNode). */
  edgeNode?: number;
  /** Wire-to-wire gap. Default 10 (ELK default edgeEdge). */
  edgeEdge?: number;
  /** Pre-built occupancy grid of other nets' segments (built by caller). */
  wireGrid?: WireGrid;
}

/**
 * Re-route ONE net locally (drag-time). Two terminals → best L/Z
 * candidate; N terminals → median hub + L/Z spokes, junction at hub.
 * Deterministic; never runs ELK.
 *
 * Returns `edges` (per-edge trace) so the caller can do surgical
 * re-route on the result — only spokes touching a moved device need
 * re-routing; the rest stay pixel-identical.
 */
export function routeNetLocal(anchors: AnchorInfo[], obstacles: Obstacle[], options?: LocalRouteOptions): WireData {
  const edgeNode = options?.edgeNode ?? 12;
  const wireGrid = options?.wireGrid;
  const pts = anchors.filter(
    (p, i, arr) => arr.findIndex((q) => Math.abs(q.point.x - p.point.x) < 0.5 && Math.abs(q.point.y - p.point.y) < 0.5) === i,
  );
  if (pts.length === 0) return { polylines: [], junctions: [], edges: [] };
  if (pts.length === 1) return { polylines: [], junctions: [], edges: [] };
  if (pts.length === 2) {
    const polylines = [bestPath(pts[0].point, pts[1].point, obstacles, edgeNode, wireGrid)];
    return {
      polylines,
      junctions: [],
      edges: [{ id: `${pts[0].deviceKey}-${pts[1].deviceKey}`, netId: -1, fromKey: pts[0].deviceKey, toKey: pts[1].deviceKey, fromTerminal: pts[0].terminal, toTerminal: pts[1].terminal, polylines }],
    };
  }
  const hub = { x: median(pts.map((p) => p.point.x)), y: median(pts.map((p) => p.point.y)) };
  const edges: TracedEdge[] = pts.map((p) => ({
    id: `${p.deviceKey}-hub`,
    netId: -1,
    fromKey: p.deviceKey,
    toKey: "__hub__",
    fromTerminal: p.terminal,
    toTerminal: "",
    polylines: [bestPath(p.point, hub, obstacles, edgeNode, wireGrid)],
  }));
  return { polylines: edges.flatMap((e) => e.polylines), junctions: [hub], edges };
}
