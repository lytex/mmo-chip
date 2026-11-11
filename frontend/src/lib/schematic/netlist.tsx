/**
 * Cell-level logic netlist layout.
 *
 * Where the previous logic-schematic view collapsed `cell.logic` into a
 * single recursively decomposed tree, this module renders the cell as
 * its actual netlist: one symbol per CMOS domain, wired together by net
 * via orthogonal Manhattan routes, with boundary I/O pins on the left
 * and right edges.
 *
 * Placement + routing run through elkjs (Eclipse Layout Kernel ported
 * to JS) — the same engine used by netlistsvg and most browser-based
 * digital schematic tools. ELK handles layered left-to-right placement,
 * vertical position within each layer, and orthogonal edge routing with
 * port-constrained endpoints.
 *
 * Output is pure data (placed nodes + routed polylines + bounding box)
 * so the canvas can pan/zoom and hover-highlight without re-running the
 * layout. ELK is async (returns a Promise), so callers should expect a
 * loading interstitial on first render.
 *
 * Phase 3a scope:
 *   - one node per domain (every cell, not just trivial combinational)
 *   - boundary I/O pins (input/output nets)
 *   - VCC/GND not shown as explicit nodes — power is implicit in the
 *     domain symbols and showing it would add visual clutter without
 *     extra information
 *   - TGs and pass transistors are not rendered yet (Phase 3b); cells
 *     that rely on them will look incomplete in the netlist view
 *   - sequential cells (cycle in the domain graph) render with the
 *     cycle visible — ELK handles back-edges automatically, no extra
 *     work
 */

import ELK from "elkjs/lib/elk.bundled.js";
import type { ReactNode } from "react";
import type {
  BoolExpr,
  GateMatch,
  InferredCellExtraction,
} from "../extraction";
import {
  renderGateSymbol,
  renderPassSymbol,
  renderTGSymbol,
} from "./logicSymbols";
import { decomposeLogic, layoutLogicTree } from "./logicComposition";

// ── Module-level ELK singleton ────────────────────────────────────

// elkjs spawns a Web Worker under the hood. One per page is enough;
// reusing it across layouts avoids worker-startup latency on every
// re-render. The ctor is sync but the layout call is async.
type ElkLayoutFn = (graph: unknown) => Promise<unknown>;
type ElkLike = { layout: ElkLayoutFn };
const elk: ElkLike = new (ELK as unknown as { new (): ElkLike })();

// ── Public types ─────────────────────────────────────────────────

/** Metadata stamped on a placed node for hover-routing back to the
 *  right panel / image canvas. The canvas reads this to fire the
 *  appropriate `HoverEntity` on cursor enter / leave. */
export type NodeMeta =
  | { kind: "gate"; domainId: string; gate: GateMatch }
  /** `fingers` > 1 when several parallel TGs (same bridged nets, same
   *  controls — a multi-finger switch) were folded into this one node. */
  | { kind: "tg"; tgId: string; fingers?: number }
  | { kind: "pass"; transistorId: string; transistorType: "pmos" | "nmos" }
  | { kind: "cell-input"; netId: number; label: string }
  | { kind: "cell-output"; netId: number; label: string }
  /** VCC / GND used directly as a logic signal — e.g. a NAND2 with one
   *  input tied high, or a TG with a fixed-rail control. Rendered as a
   *  boundary input pin with rail-distinct styling so it doesn't read
   *  as a regular cell input. */
  | { kind: "rail-input"; netId: number; label: string; rail: "vcc" | "gnd" }
  /** Net consumed by signal pins (gate input, TG terminal, pass-tx
   *  gate) but with no driver anywhere in the cell — neither a
   *  domain output, TG output, pass output, nor a classified cell-
   *  input/rail. Surfaced as a boundary input pin with distinct
   *  amber-dashed styling: either it's a real cell input the
   *  classifier missed (the common case for TG bridge nets that ALSO
   *  drive gates), or the user's annotation is incomplete — in both
   *  cases the user needs to SEE the net to act on it. */
  | { kind: "orphan-input"; netId: number; label: string };

export interface PlacedNode {
  id: string;
  /** Absolute position of the node's local (0, 0). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Pre-rendered SVG body of the node, positioned in its local frame.
   *  Caller wraps in a `<g transform="translate(x,y)">` to place. */
  svg: ReactNode;
  meta: NodeMeta;
}

export interface PlacedEdge {
  id: string;
  /** One polyline per section ELK produced. For binary edges that's
   *  always a single polyline; for hyperedges (one driver, N
   *  consumers — the common multi-fanout case) it's N polylines that
   *  share common segments visually but are each independent here. */
  polylines: Array<Array<{ x: number; y: number }>>;
  /** Net carried by this edge — drives hover highlight + status info. */
  netId: number;
}

/** Junction dot — drawn where wires of the same net branch, so
 *  multi-fanout nets read as electrically connected instead of just
 *  visually overlapping. */
export interface Junction {
  x: number;
  y: number;
  netId: number;
}

export interface NetlistLayout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  junctions: Junction[];
  bbox: { width: number; height: number };
}

// ── Sizing constants ──────────────────────────────────────────────

/** Width of the boundary I/O pin nodes — wide enough to fit the net
 *  label inside without clipping for typical 4-8 char names. */
const IO_PIN_W = 56;
const IO_PIN_H = 18;
/** Horizontal padding ELK leaves around the whole layout. */
const PADDING = 12;

// ── Main entry ────────────────────────────────────────────────────

/**
 * Convert `extraction` into a netlist graph, run ELK layout, and
 * return the placed-and-routed result.
 *
 * `netName` formats net ids for boundary labels (typically a wrapper
 * around `displayLabel(net.label) ?? "netN"`).
 *
 * Caller passes the full `InferredCellExtraction`; we filter to the
 * domains that have a recognised gate. Domains with `gate === undefined`
 * (extraction couldn't decompose the PUN/PDN into SP, etc.) are skipped
 * with a placeholder shape so the netlist still shows their I/O.
 */
export async function layoutNetlist(
  extraction: InferredCellExtraction,
  netName: (id: number) => string,
): Promise<NetlistLayout> {
  // ── 1. Identify boundary nets ────────────────────────────────
  //
  // Cell inputs / outputs come from `classifyNets`'s role assignments.
  // VCC and GND are usually excluded (power is implicit in the gate
  // symbols) — but we'll add them later as `rail-input` boundary pins
  // if they're actually being used as a logic signal somewhere (gate
  // input, TG control, pass-transistor gate), which is rare but real.
  const cellInputNets = extraction.nets.filter((n) => n.role === "input");
  const cellOutputNets = extraction.nets.filter((n) => n.role === "output");

  // Map net id → driving source port id(s). Most nets have exactly one
  // driver, but TGs and pass transistors can share an output net (e.g.
  // a 2-to-1 MUX built from two TGs whose drains both drive the same
  // mid net), so we allow the list.
  const drivers = new Map<number, string[]>();
  /** Map net id → list of consumer port ids. A net can have many. */
  const consumerPorts = new Map<number, string[]>();
  const addDriver = (netId: number, portId: string) => {
    let list = drivers.get(netId);
    if (!list) {
      list = [];
      drivers.set(netId, list);
    }
    list.push(portId);
  };
  const addConsumer = (netId: number, portId: string) => {
    let list = consumerPorts.get(netId);
    if (!list) {
      list = [];
      consumerPorts.set(netId, list);
    }
    list.push(portId);
  };

  // ── 2. Build domain gate nodes ───────────────────────────────
  type ElkPort = {
    id: string;
    width: number;
    height: number;
    x?: number;
    y?: number;
    layoutOptions?: Record<string, string>;
  };
  type ElkNode = {
    id: string;
    width: number;
    height: number;
    ports: ElkPort[];
    layoutOptions?: Record<string, string>;
  };
  type ElkEdge = { id: string; sources: string[]; targets: string[] };

  const elkChildren: ElkNode[] = [];
  /** Pre-rendered SVG body per node id, kept aside so the result loop
   *  can attach it to each placed node without re-rendering. For simple
   *  primitive gates this is `renderGateSymbol(...).svg`; for composite
   *  nodes (AOI/OAI/AO/OA/compound) it's the layoutLogicTree-rendered
   *  sub-tree of primitives. */
  const svgBodyById = new Map<string, ReactNode>();
  const metaById = new Map<string, NodeMeta>();

  for (const domain of extraction.domains) {
    const gate = domain.gate;
    if (!gate) continue;
    const nodeId = `gate:${domain.id}`;
    const outputNetId = domain.outputNetIds[0];

    // Two render modes:
    //
    //   - Simple primitive (INV / NAND / NOR / AND / OR / XOR / XNOR /
    //     WIRE / CONST): one `renderGateSymbol` call, one symbol body.
    //
    //   - Composite (AOI / OAI / AO / OA / compound): walk
    //     `domain.logic` through decomposeLogic + layoutLogicTree so
    //     the gate renders as its constituent primitives wired up —
    //     e.g. AOI21 = AND2 → OR2 → INV inside one ELK box. The
    //     box's pre-rendered SVG body shows the internal tree;
    //     external ELK ports live at the leaf positions so wires from
    //     the cell's other nodes land on the right input pin.
    //
    // Either path produces the same shape: a width/height, an ordered
    // list of input pin coords (each tagged with its net id), and one
    // output pin coord.
    let nodeWidth: number;
    let nodeHeight: number;
    let svgBody: ReactNode;
    let inputs: Array<{ x: number; y: number; netId: number }>;
    let outputPin: { x: number; y: number };

    const isComposite =
      (gate.kind === "aoi" ||
        gate.kind === "oai" ||
        gate.kind === "ao" ||
        gate.kind === "oa" ||
        gate.kind === "compound") &&
      domain.logic != null;

    if (isComposite && domain.logic) {
      const tree = decomposeLogic(domain.logic);
      const layout = layoutLogicTree(tree, {
        netName,
        outputNetId,
        omitDecorations: true,
      });
      nodeWidth = layout.bbox.width;
      nodeHeight = layout.bbox.height;
      inputs = layout.inputs.map((p) => ({
        x: p.x,
        y: p.y,
        netId: p.netId,
      }));
      outputPin = { x: layout.output.x, y: layout.output.y };
      svgBody = (
        <>
          {layout.wires.map((w, i) => (
            <polyline
              key={`cw-${i}`}
              points={w.points.map((p) => `${p.x},${p.y}`).join(" ")}
              fill="none"
              stroke="var(--ink2)"
              strokeWidth={1.4}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
          {layout.symbols.map((s, i) => (
            <g key={`cs-${i}`} transform={`translate(${s.x}, ${s.y})`}>
              {s.rendered.svg}
            </g>
          ))}
        </>
      );
    } else {
      const rendered = renderGateSymbol(gate);
      nodeWidth = rendered.width;
      nodeHeight = rendered.height;
      svgBody = rendered.svg;
      // Map each rendered input pin index → net id by reading the
      // recognised gate's literals. The renderer's pin order matches
      // the matcher's input order so `gateInputNets` lines up with
      // `rendered.inputs[i]`.
      const inputNets = gateInputNets(gate);
      inputs = [];
      for (let i = 0; i < inputNets.length; i++) {
        const pin = rendered.inputs[i];
        if (!pin) continue;
        inputs.push({ x: pin.x, y: pin.y, netId: inputNets[i] });
      }
      outputPin = { x: rendered.output.x, y: rendered.output.y };
    }

    // Store the pre-rendered body — the result loop pulls it back
    // out by node id and wraps it in a placed `<g>` translation.
    svgBodyById.set(nodeId, svgBody);
    metaById.set(nodeId, { kind: "gate", domainId: domain.id, gate });

    const ports: ElkPort[] = [];
    for (let i = 0; i < inputs.length; i++) {
      const pin = inputs[i];
      const portId = `${nodeId}:in${i}`;
      ports.push({
        id: portId,
        x: pin.x,
        y: pin.y,
        width: 0,
        height: 0,
        // Per-port side hint so ELK puts the wire entry on the left.
        // `port.index` orders the ports top-to-bottom (lower index =
        // higher on the side). ELK uses descending index by default.
        layoutOptions: {
          "port.side": "WEST",
          "port.index": String(inputs.length - i),
        },
      });
      addConsumer(pin.netId, portId);
    }
    if (outputNetId != null) {
      const portId = `${nodeId}:out`;
      ports.push({
        id: portId,
        x: outputPin.x,
        y: outputPin.y,
        width: 0,
        height: 0,
        layoutOptions: { "port.side": "EAST" },
      });
      addDriver(outputNetId, portId);
    }

    elkChildren.push({
      id: nodeId,
      width: nodeWidth,
      height: nodeHeight,
      ports,
      // FIXED_POS keeps our pre-rendered pin coordinates intact so
      // wires meet the visual pins exactly. Without this ELK would
      // re-distribute ports along the side, breaking the symbol's
      // pin geometry.
      layoutOptions: { "portConstraints": "FIXED_POS" },
    });
  }

  // ── 3. Build boundary I/O pin nodes ─────────────────────────
  //
  // One node per cell-input / cell-output net. Single port on the
  // outward-facing side (East for inputs since they drive into the
  // cell, West for outputs since they receive from inside).
  for (const net of cellInputNets) {
    const nodeId = `cell-in:${net.id}`;
    const portId = `${nodeId}:out`;
    elkChildren.push({
      id: nodeId,
      width: IO_PIN_W,
      height: IO_PIN_H,
      ports: [{
        id: portId,
        x: IO_PIN_W,
        y: IO_PIN_H / 2,
        width: 0,
        height: 0,
        layoutOptions: { "port.side": "EAST" },
      }],
      layoutOptions: {
        "portConstraints": "FIXED_POS",
        // Hint ELK to place input pins on the leftmost layer.
        "layered.layering.layerConstraint": "FIRST",
      },
    });
    addDriver(net.id, portId);
    metaById.set(nodeId, {
      kind: "cell-input",
      netId: net.id,
      label: netName(net.id),
    });
  }

  for (const net of cellOutputNets) {
    const nodeId = `cell-out:${net.id}`;
    const portId = `${nodeId}:in`;
    elkChildren.push({
      id: nodeId,
      width: IO_PIN_W,
      height: IO_PIN_H,
      ports: [{
        id: portId,
        x: 0,
        y: IO_PIN_H / 2,
        width: 0,
        height: 0,
        layoutOptions: { "port.side": "WEST" },
      }],
      layoutOptions: {
        "portConstraints": "FIXED_POS",
        "layered.layering.layerConstraint": "LAST",
      },
    });
    addConsumer(net.id, portId);
    metaById.set(nodeId, {
      kind: "cell-output",
      netId: net.id,
      label: netName(net.id),
    });
  }

  // TG node building is deferred until AFTER the other driver sources
  // (passes, rails) are added — see the orientation-inference loop
  // below. Skipping the loop here keeps the rest of the flow
  // unchanged; the actual node construction is `buildTgNode`.
  //
  // For why the orientation matters: TGs are bidirectional, so
  // "which side is the consumer / driver" depends on the surrounding
  // circuit. The smaller-net-id convention used by the extractor
  // doesn't always match electrical reality — e.g., a chain
  // TG1 → TG2 where the shared net happens to be the smaller of
  // both TGs' bridge pairs would leave the chain disconnected
  // (both TGs treat it as their consumer side).
  const buildTgNode = (
    tg: (typeof extraction.transmissionGates)[number],
    consumerNet: number,
    driverNet: number,
  ): void => {
    const rendered = renderTGSymbol();
    const nodeId = `tg:${tg.id}`;
    const fingers = tgFingers.get(tg.id) ?? 1;
    svgBodyById.set(
      nodeId,
      fingers > 1 ? (
        <>
          {rendered.svg}
          <text
            x={rendered.width + 2}
            y={7}
            fontFamily="var(--mono, ui-monospace)"
            fontSize={8}
            fill="var(--ink3)"
          >
            ×{fingers}
          </text>
        </>
      ) : (
        rendered.svg
      ),
    );
    metaById.set(nodeId, { kind: "tg", tgId: tg.id, fingers });

    // rendered.inputs order: [ctrl_p, signal_a, ctrl_n]; output = signal_b.
    const ctrlpPort = `${nodeId}:ctrlp`;
    const aPort = `${nodeId}:a`;
    const ctrlnPort = `${nodeId}:ctrln`;
    const bPort = `${nodeId}:b`;

    elkChildren.push({
      id: nodeId,
      width: rendered.width,
      height: rendered.height,
      ports: [
        {
          id: ctrlpPort,
          x: rendered.inputs[0].x,
          y: rendered.inputs[0].y,
          width: 0,
          height: 0,
          layoutOptions: { "port.side": "NORTH" },
        },
        {
          id: aPort,
          x: rendered.inputs[1].x,
          y: rendered.inputs[1].y,
          width: 0,
          height: 0,
          layoutOptions: { "port.side": "WEST" },
        },
        {
          id: ctrlnPort,
          x: rendered.inputs[2].x,
          y: rendered.inputs[2].y,
          width: 0,
          height: 0,
          layoutOptions: { "port.side": "SOUTH" },
        },
        {
          id: bPort,
          x: rendered.output.x,
          y: rendered.output.y,
          width: 0,
          height: 0,
          layoutOptions: { "port.side": "EAST" },
        },
      ],
      layoutOptions: { "portConstraints": "FIXED_POS" },
    });

    addConsumer(tg.controlPmosGateNetId, ctrlpPort);
    addConsumer(tg.controlNmosGateNetId, ctrlnPort);
    addConsumer(consumerNet, aPort);
    addDriver(driverNet, bPort);
  };

  // ── 3c. Pass transistors (one node per role:"pass" transistor) ──
  //
  // Three ports: gate (NORTH, bubbled for PMOS), source (WEST,
  // consumer of `source.netId`), drain (EAST, driver of `drain.netId`).
  // Direction is conventional — like the TG terminals, source/drain
  // are physically interchangeable for pass devices.
  for (const t of extraction.transistors) {
    if (t.role !== "pass") continue;
    if (t.type === "unknown") continue; // can't pick a symbol variant
    const rendered = renderPassSymbol(t.type);
    const nodeId = `pass:${t.id}`;
    svgBodyById.set(nodeId, rendered.svg);
    metaById.set(nodeId, {
      kind: "pass",
      transistorId: t.id,
      transistorType: t.type,
    });

    const gPort = `${nodeId}:g`;
    const sPort = `${nodeId}:s`;
    const dPort = `${nodeId}:d`;

    elkChildren.push({
      id: nodeId,
      width: rendered.width,
      height: rendered.height,
      ports: [
        {
          id: gPort,
          x: rendered.inputs[0].x,
          y: rendered.inputs[0].y,
          width: 0,
          height: 0,
          layoutOptions: { "port.side": "NORTH" },
        },
        {
          id: sPort,
          x: rendered.inputs[1].x,
          y: rendered.inputs[1].y,
          width: 0,
          height: 0,
          layoutOptions: { "port.side": "WEST" },
        },
        {
          id: dPort,
          x: rendered.output.x,
          y: rendered.output.y,
          width: 0,
          height: 0,
          layoutOptions: { "port.side": "EAST" },
        },
      ],
      layoutOptions: { "portConstraints": "FIXED_POS" },
    });

    addConsumer(t.gate.netId, gPort);
    addConsumer(t.source.netId, sPort);
    addDriver(t.drain.netId, dPort);
  }

  // ── 3d. VCC / GND used as a logic signal ─────────────────────
  //
  // Most cells use VCC/GND only as power for the gates' implicit S/D
  // connections — those we hide. But sometimes a rail directly drives
  // a signal pin: a NAND2 with one input tied high, a TG with a
  // fixed-rail control, a tied-low input on a pass-transistor gate.
  // For those, surface the rail as a boundary input pin with
  // distinct styling so the connection is visible. We detect by
  // scanning the consumer side: a rail consumed by ANY signal port
  // (which is what every `addConsumer` call above represents).
  for (const net of extraction.nets) {
    if (net.role !== "vcc" && net.role !== "gnd") continue;
    if (!consumerPorts.has(net.id)) continue;
    // (Skip if the rail already has a driver, which shouldn't happen
    // for a rail but defensive against forced labels.)
    if (drivers.has(net.id)) continue;
    const rail = net.role; // "vcc" | "gnd"
    const nodeId = `rail-in:${net.id}`;
    const portId = `${nodeId}:out`;
    elkChildren.push({
      id: nodeId,
      width: IO_PIN_W,
      height: IO_PIN_H,
      ports: [{
        id: portId,
        x: IO_PIN_W,
        y: IO_PIN_H / 2,
        width: 0,
        height: 0,
        layoutOptions: { "port.side": "EAST" },
      }],
      layoutOptions: {
        "portConstraints": "FIXED_POS",
        "layered.layering.layerConstraint": "FIRST",
      },
    });
    addDriver(net.id, portId);
    metaById.set(nodeId, {
      kind: "rail-input",
      netId: net.id,
      label: netName(net.id),
      rail,
    });
  }

  // ── 3d-bis. TG bridge orientation + node construction ────────
  //
  // For each TG, pick which bridged net is the consumer (WEST,
  // signal_a) and which is the driver (EAST, signal_b). TGs are
  // bidirectional, so the smaller-net-id convention used by the
  // extractor doesn't always match the surrounding circuit. We do
  // better by inferring from context:
  //
  //   - If exactly one of the bridged nets already has a driver
  //     (from a domain, pass transistor, cell input, or rail), use
  //     THAT side as the consumer — the TG "reads" from the driven
  //     net and "writes" to the other.
  //   - If both have drivers, the TG is ambiguous (probably MUX-like).
  //     Defer; the fallback below picks by convention.
  //   - If neither has a driver, defer too — a later TG in the
  //     chain might add a driver to one side via its own
  //     orientation.
  //
  // Iterate until no more TGs can be decided, then fall back to the
  // sorted-id convention for any leftovers. The remaining
  // truly-orphan nets get caught by the orphan-input loop below.
  //
  // Parallel fingers first: a wide switch is drawn as many P+N pairs
  // that all bridge the same two nets under the same two controls. One
  // symbol (tagged ×N) says the same thing as N stacked ones.
  const tgFingers = new Map<string, number>();
  const pendingTGs: Array<(typeof extraction.transmissionGates)[number]> = [];
  {
    const firstByKey = new Map<string, string>();
    for (const tg of extraction.transmissionGates) {
      const key = [
        tg.bridgedNetIds[0],
        tg.bridgedNetIds[1],
        tg.controlPmosGateNetId,
        tg.controlNmosGateNetId,
      ].join("|");
      const first = firstByKey.get(key);
      if (first == null) {
        firstByKey.set(key, tg.id);
        tgFingers.set(tg.id, 1);
        pendingTGs.push(tg);
      } else {
        tgFingers.set(first, (tgFingers.get(first) ?? 1) + 1);
      }
    }
  }
  let tgProgress = true;
  while (tgProgress) {
    tgProgress = false;
    for (let i = pendingTGs.length - 1; i >= 0; i--) {
      const tg = pendingTGs[i];
      const a = tg.bridgedNetIds[0];
      const b = tg.bridgedNetIds[1];
      const aDriven = drivers.has(a);
      const bDriven = drivers.has(b);
      if (aDriven === bDriven) continue; // both or neither — defer
      const consumerNet = aDriven ? a : b;
      const driverNet = aDriven ? b : a;
      buildTgNode(tg, consumerNet, driverNet);
      pendingTGs.splice(i, 1);
      tgProgress = true;
    }
  }
  for (const tg of pendingTGs) {
    // Fallback for unresolved TGs (both / neither side has a driver):
    // keep the legacy sorted-id convention. The orphan-input loop
    // below will catch any net still consumer-only after this.
    buildTgNode(tg, tg.bridgedNetIds[0], tg.bridgedNetIds[1]);
  }

  // ── 3e. Orphan-driver nets ──────────────────────────────────
  //
  // A net consumed by signal pins (gate input, TG terminal, pass-tx
  // gate) but with no driver in the graph appears floating — its
  // wires lead nowhere visually, leaving the user wondering where
  // the signal comes from. The most common cause is a TG bridge net
  // that also drives gates elsewhere: classifyNets marks it as
  // "pass" (which beats "input"), so it never lands in
  // `cellInputNets` and never gets a boundary pin.
  //
  // Catch-all here: any consumed net without a driver gets a
  // boundary input pin with distinct dashed-amber styling. If the
  // net is a real cell input the netlist now reads correctly;
  // otherwise the visible amber pin flags an annotation gap the
  // user should investigate.
  //
  // Runs AFTER all the explicit-driver loops (domains, TGs, passes,
  // cell-inputs, rails) so it only catches what slipped through.
  const roleByNet = new Map(extraction.nets.map((n) => [n.id, n.role]));
  for (const [netId] of consumerPorts) {
    if (drivers.has(netId)) continue;
    // A net the user labelled `io` is a known cell terminal, not an
    // annotation gap — give it a regular pin instead of the amber one.
    const isIo = roleByNet.get(netId) === "io";
    const nodeId = `orphan-in:${netId}`;
    const portId = `${nodeId}:out`;
    elkChildren.push({
      id: nodeId,
      width: IO_PIN_W,
      height: IO_PIN_H,
      ports: [{
        id: portId,
        x: IO_PIN_W,
        y: IO_PIN_H / 2,
        width: 0,
        height: 0,
        layoutOptions: { "port.side": "EAST" },
      }],
      layoutOptions: {
        "portConstraints": "FIXED_POS",
        "layered.layering.layerConstraint": "FIRST",
      },
    });
    addDriver(netId, portId);
    metaById.set(nodeId, {
      kind: isIo ? "cell-input" : "orphan-input",
      netId,
      label: netName(netId),
    });
  }

  // ── 3f. Driven-but-unconsumed switch / gate outputs ──────────
  //
  // The mirror image of 3e: a net a TG, pass transistor or gate drives
  // but nothing in the cell consumes and that isn't a classified
  // `output` (so it has no boundary pin yet). That's the far terminal
  // of a pass-gate-only cell — e.g. a bare transmission gate between
  // two `io` nets. Without a pin the symbol's output would end in mid
  // air.
  for (const [netId, sources] of drivers) {
    if (consumerPorts.has(netId)) continue;
    if (!sources.some((p) => /^(tg|pass|gate):/.test(p))) continue;
    const nodeId = `cell-out:${netId}`;
    if (metaById.has(nodeId)) continue;
    const portId = `${nodeId}:in`;
    elkChildren.push({
      id: nodeId,
      width: IO_PIN_W,
      height: IO_PIN_H,
      ports: [{
        id: portId,
        x: 0,
        y: IO_PIN_H / 2,
        width: 0,
        height: 0,
        layoutOptions: { "port.side": "WEST" },
      }],
      layoutOptions: {
        "portConstraints": "FIXED_POS",
        "layered.layering.layerConstraint": "LAST",
      },
    });
    addConsumer(netId, portId);
    metaById.set(nodeId, {
      kind: "cell-output",
      netId,
      label: netName(netId),
    });
  }

  // ── 4. Build edges (one binary edge per (driver, consumer)) ──
  //
  // ELK's layered + orthogonal router rejects hyperedges (multi-
  // source / multi-target) with "Passed edge is not 'simple'", so we
  // emit one binary edge per pair. For a net with one driver and N
  // consumers that's N edges that all start at the same source port
  // and fan out — visually they share initial segments and look like
  // one wire, which is the desired behaviour. Junction dots get
  // computed manually from the polylines after layout (see
  // `computeJunctions` below).
  //
  // MUX-style nets with multiple drivers (two TGs feeding a shared
  // output) become M×N edges; ELK routes each independently. Visual
  // overlap on shared segments still looks like one electrical net.
  const elkEdges: ElkEdge[] = [];
  const edgeNetIds = new Map<string, number>();
  let edgeCounter = 0;
  for (const [netId, consumers] of consumerPorts) {
    const sources = drivers.get(netId);
    if (!sources || sources.length === 0) continue; // net has no driver in the graph — skip
    for (const source of sources) {
      for (const target of consumers) {
        const edgeId = `e${edgeCounter++}`;
        elkEdges.push({ id: edgeId, sources: [source], targets: [target] });
        edgeNetIds.set(edgeId, netId);
      }
    }
  }

  // ── 5. Run ELK ──────────────────────────────────────────────
  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      // Left-to-right is the digital schematic convention; inputs
      // arrive on the left, signals flow rightward, outputs exit on
      // the right.
      "elk.direction": "RIGHT",
      // Orthogonal Manhattan routes — what every digital schematic
      // uses; bends at right angles and runs parallel/perpendicular
      // to the layer axes.
      "elk.edgeRouting": "ORTHOGONAL",
      // Spacing tuned for the gate symbols (~30-50 px wide). The
      // defaults are too tight for our scale.
      "elk.spacing.nodeNode": "32",
      "elk.layered.spacing.nodeNodeBetweenLayers": "48",
      "elk.spacing.edgeNode": "12",
      "elk.spacing.edgeEdge": "10",
      "elk.padding": `[top=${PADDING},left=${PADDING},bottom=${PADDING},right=${PADDING}]`,
    },
    children: elkChildren,
    edges: elkEdges,
  };

  type ElkResult = {
    width?: number;
    height?: number;
    children?: Array<{
      id: string;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
    }>;
    edges?: Array<{
      id: string;
      sections?: Array<{
        startPoint: { x: number; y: number };
        endPoint: { x: number; y: number };
        bendPoints?: Array<{ x: number; y: number }>;
      }>;
    }>;
  };
  const result = (await elk.layout(graph)) as ElkResult;

  // ── 6. Translate result into our flat output shape ─────────
  const placedNodes: PlacedNode[] = [];
  for (const child of result.children ?? []) {
    const meta = metaById.get(child.id);
    if (!meta) continue;
    const x = child.x ?? 0;
    const y = child.y ?? 0;
    const w = child.width ?? 0;
    const h = child.height ?? 0;
    let svg: ReactNode;
    if (meta.kind === "gate" || meta.kind === "tg" || meta.kind === "pass") {
      // Pre-rendered SVG body — for "gate" this is either a simple
      // symbol or a composite sub-tree; for tg/pass it's the symbol.
      svg = svgBodyById.get(child.id) ?? null;
    } else {
      // Boundary I/O (cell-input, cell-output, rail-input) — labeled
      // rect with a small port marker on the appropriate side. Inline
      // so the netlist module owns the visual look without needing
      // another file for a few elements.
      svg = renderIoPin(meta, w, h);
    }
    placedNodes.push({
      id: child.id,
      x,
      y,
      width: w,
      height: h,
      svg,
      meta,
    });
  }

  const placedEdges: PlacedEdge[] = [];
  for (const e of result.edges ?? []) {
    const netId = edgeNetIds.get(e.id);
    if (netId == null) continue;
    // Each ELK section becomes one polyline. Binary edges always
    // produce a single section; we keep the `polylines[][]` shape
    // because callers iterate it uniformly.
    const polylines: Array<Array<{ x: number; y: number }>> = [];
    for (const sec of e.sections ?? []) {
      const pts: Array<{ x: number; y: number }> = [
        { x: sec.startPoint.x, y: sec.startPoint.y },
      ];
      for (const b of sec.bendPoints ?? []) pts.push({ x: b.x, y: b.y });
      pts.push({ x: sec.endPoint.x, y: sec.endPoint.y });
      polylines.push(pts);
    }
    placedEdges.push({ id: e.id, polylines, netId });
  }

  // Junction dots: scan each net's polylines for vertices where 3+
  // distinct directions converge — that's a branching point we want
  // to mark as electrically connected. ELK could compute these for
  // us via hyperedges, but its layered+orthogonal router refuses
  // those (see edge-construction comment above) so we do it manually.
  const junctions = computeJunctions(placedEdges);

  return {
    nodes: placedNodes,
    edges: placedEdges,
    junctions,
    bbox: { width: result.width ?? 0, height: result.height ?? 0 },
  };
}

/**
 * Find junction dots (3+ wires of the same net meeting at a point).
 *
 * The naive "count neighbours per polyline vertex" approach fails on
 * two real cases ELK produces with binary edges:
 *
 *   1. Two polylines that visually overlap on a long segment but
 *      bend at different x's. The branch is real but the branching
 *      vertex of one isn't a vertex of the other, so vertex-based
 *      counting misses it.
 *
 *   2. Polylines with a duplicate consecutive vertex (a degenerate
 *      "bend at the same point") — neighbour counting sees the
 *      vertex as adjacent to itself and inflates the count.
 *
 * The fix is segment-based: collect every axis-aligned wire segment
 * for the net, then for each polyline vertex split any OTHER
 * segments that pass through it. After splitting, a vertex with
 * graph degree ≥ 3 is a real junction. Coordinates snap to a 0.5px
 * grid so floating-point drift in ELK's routing doesn't fragment
 * what should be a shared point.
 */
export function computeJunctions(edges: PlacedEdge[]): Junction[] {
  const byNet = new Map<number, PlacedEdge[]>();
  for (const e of edges) {
    let list = byNet.get(e.netId);
    if (!list) {
      list = [];
      byNet.set(e.netId, list);
    }
    list.push(e);
  }

  const snap = (p: { x: number; y: number }) => ({
    x: Math.round(p.x * 2) / 2,
    y: Math.round(p.y * 2) / 2,
  });
  const keyOf = (p: { x: number; y: number }) => `${p.x},${p.y}`;

  const out: Junction[] = [];

  for (const [netId, netEdges] of byNet) {
    // ── Collect snapped vertices + segments ──────────────
    const vertices = new Map<string, { x: number; y: number }>();
    const rawSegments: Array<{ a: string; b: string }> = [];
    for (const e of netEdges) {
      for (const line of e.polylines) {
        for (let i = 0; i < line.length; i++) {
          const v = snap(line[i]);
          vertices.set(keyOf(v), v);
          if (i > 0) {
            const a = keyOf(snap(line[i - 1]));
            const b = keyOf(snap(line[i]));
            // Skip degenerate (zero-length) segments — they come
            // from duplicate consecutive points in ELK's output and
            // are the root cause of one of the false-positive bugs.
            if (a !== b) rawSegments.push({ a, b });
          }
        }
      }
    }

    // ── Split overlapping segments at interior vertices ──
    //
    // For each raw segment (a, b), find any vertices that lie
    // strictly between a and b. Split the segment into a chain that
    // visits each such vertex. After this pass, the segment graph
    // has the property that every vertex's degree equals the number
    // of distinct wires touching it.
    const adjacency = new Map<string, Set<string>>();
    const addEdge = (a: string, b: string) => {
      if (a === b) return;
      let aSet = adjacency.get(a);
      if (!aSet) {
        aSet = new Set();
        adjacency.set(a, aSet);
      }
      aSet.add(b);
      let bSet = adjacency.get(b);
      if (!bSet) {
        bSet = new Set();
        adjacency.set(b, bSet);
      }
      bSet.add(a);
    };

    for (const seg of rawSegments) {
      const a = vertices.get(seg.a)!;
      const b = vertices.get(seg.b)!;
      // Find interior vertices on this segment (orthogonal only —
      // ELK in ORTHOGONAL mode always produces axis-aligned
      // segments).
      const interior: Array<{ key: string; v: { x: number; y: number } }> = [];
      for (const [vKey, v] of vertices) {
        if (vKey === seg.a || vKey === seg.b) continue;
        if (!pointInteriorToSegment(v, a, b)) continue;
        interior.push({ key: vKey, v });
      }
      // Sort interior vertices by distance from a so the chain
      // visits them in order along the segment.
      interior.sort((p, q) => {
        const dp = (p.v.x - a.x) ** 2 + (p.v.y - a.y) ** 2;
        const dq = (q.v.x - a.x) ** 2 + (q.v.y - a.y) ** 2;
        return dp - dq;
      });
      const chain = [seg.a, ...interior.map((x) => x.key), seg.b];
      for (let i = 0; i < chain.length - 1; i++) {
        addEdge(chain[i], chain[i + 1]);
      }
    }

    // ── Emit junctions ───────────────────────────────────
    for (const [vKey, nset] of adjacency) {
      if (nset.size < 3) continue;
      const v = vertices.get(vKey);
      if (!v) continue;
      out.push({ x: v.x, y: v.y, netId });
    }
  }

  return out;
}

/** True iff `p` lies strictly between `a` and `b` on an axis-aligned
 *  segment. Endpoints don't count (they're already vertices). */
function pointInteriorToSegment(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): boolean {
  const eps = 0.001;
  // Horizontal segment (constant y).
  if (Math.abs(a.y - b.y) < eps && Math.abs(p.y - a.y) < eps) {
    const xMin = Math.min(a.x, b.x);
    const xMax = Math.max(a.x, b.x);
    return p.x > xMin + eps && p.x < xMax - eps;
  }
  // Vertical segment (constant x).
  if (Math.abs(a.x - b.x) < eps && Math.abs(p.x - a.x) < eps) {
    const yMin = Math.min(a.y, b.y);
    const yMax = Math.max(a.y, b.y);
    return p.y > yMin + eps && p.y < yMax - eps;
  }
  return false;
}

// ── Helpers ───────────────────────────────────────────────────

/**
 * Flatten a recognised `GateMatch` into the ordered list of net ids
 * its input pins consume. Output order is canonical (matches the order
 * the recogniser produced the literals from the boolean expression)
 * and aligns with `renderGateSymbol`'s `inputs[]` slots.
 *
 * `compound` falls back to walking the raw BoolExpr; the order isn't
 * meaningful but each net appears once.
 */
function gateInputNets(gate: GateMatch): number[] {
  switch (gate.kind) {
    case "inv":
    case "wire":
      return [gate.input.netId];
    case "and":
    case "or":
    case "nand":
    case "nor":
    case "xor":
    case "xnor":
      return gate.inputs.map((l) => l.netId);
    case "aoi":
    case "oai":
    case "ao":
    case "oa":
      return gate.groups.flatMap((g) => g.map((l) => l.netId));
    case "const":
      return [];
    case "compound": {
      const seen = new Set<number>();
      const out: number[] = [];
      collectNets(gate.expr, seen, out);
      return out;
    }
  }
}

function collectNets(e: BoolExpr, seen: Set<number>, out: number[]): void {
  switch (e.kind) {
    case "net":
      if (!seen.has(e.net)) {
        seen.add(e.net);
        out.push(e.net);
      }
      return;
    case "const":
      return;
    case "not":
      collectNets(e.arg, seen, out);
      return;
    case "and":
    case "or":
      for (const a of e.args) collectNets(a, seen, out);
      return;
  }
}

/**
 * Render a boundary I/O pin: small labeled rect with a directional
 * arrow at the port edge. Style intentionally matches the gate symbols
 * so the netlist reads as a single graphic instead of "gates + odd
 * boundary boxes".
 */
function renderIoPin(
  meta: Extract<
    NodeMeta,
    {
      kind: "cell-input" | "cell-output" | "rail-input" | "orphan-input";
    }
  >,
  w: number,
  h: number,
): ReactNode {
  const isOutput = meta.kind === "cell-output";
  // Per-kind palette:
  //   - cell-input / cell-output: neutral ink2.
  //   - rail-input: red (VCC) or blue (GND), matching the CMOS
  //     schematic so the user reads them as power-rail signals.
  //   - orphan-input: amber + dashed border — flag for "no driver
  //     found, check if this is a real cell input or an annotation
  //     gap." Pin is functional (the boundary works the same as a
  //     cell-input) but the styling tells the user to investigate.
  let stroke = "var(--ink2)";
  let fill = "var(--ink2)";
  let textColor = "var(--ink2)";
  let strokeDasharray: string | undefined;
  if (meta.kind === "rail-input") {
    const c = meta.rail === "vcc" ? "#ff4040" : "#4080ff";
    stroke = c;
    fill = c;
    textColor = c;
  } else if (meta.kind === "orphan-input") {
    const c = "var(--warn)";
    stroke = c;
    fill = c;
    textColor = c;
    strokeDasharray = "3 2";
  }
  // Direction marker: a triangle on the port side. Inputs have it on
  // the right edge of the box; outputs have it just past the left
  // edge (the wire arrives from the right).
  const arrowSide = isOutput ? 0 : w - 6;
  return (
    <g>
      <rect
        x={0}
        y={0}
        width={w}
        height={h}
        rx={3}
        fill="var(--canvas-bg)"
        stroke={stroke}
        strokeWidth={1.4}
        strokeDasharray={strokeDasharray}
      />
      <text
        x={w / 2}
        y={h / 2 + 4}
        textAnchor="middle"
        fontFamily="var(--mono, ui-monospace)"
        fontSize={11}
        fontWeight={600}
        fill={textColor}
      >
        {meta.label}
      </text>
      <polygon
        points={
          !isOutput
            ? `${arrowSide},${h / 2 - 3} ${arrowSide + 6},${h / 2} ${arrowSide},${h / 2 + 3}`
            : `${w},${h / 2 - 3} ${w + 6},${h / 2} ${w},${h / 2 + 3}`
        }
        fill={fill}
      />
    </g>
  );
}
