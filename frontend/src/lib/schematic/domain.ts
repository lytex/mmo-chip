/**
 * Turn a `CmosDomain` (one pull-up / pull-down pair) into a placed schematic
 * view: SP-decompose each network, lay them out vertically, stitch a VCC
 * rail on top + output bus in the middle + GND rail on the bottom.
 *
 * The output is pure data — `SchematicView` is what the SVG component
 * paints. Anything the renderer needs that isn't in this data shape (gate
 * input labels, hover targets, etc.) should be derived from the placed
 * symbols + the original `CmosDomain` reference.
 */

import type {
  CmosDomain,
  ExtractedNet,
  Transistor,
} from "../extraction";
import { netDisplayName } from "../labels";
import { decompose, type SPEdge, type SPTree } from "./spTree";
import {
  HSPACE,
  SYM_H,
  SYM_W,
  VSPACE,
  layoutTree,
  type GateInput,
  type LayoutResult,
  type PlacedSymbol,
  type Point,
  type Wire,
} from "./layout";

/** Vertical space between the rail bar and the device it's connected to.
 *  The rail symbol's own height (label + bars) sits OUTSIDE this gap — the
 *  rail's local (0,0) is the bar itself, so positioning the rail at the
 *  PUN/PDN's bar-y is enough to land the connection. */
const RAIL_GAP = 30;
/** Width of the rail glyph (half the transistor symbol so the rail reads as
 *  a marker, not as another structural block). */
const RAIL_W = 30;
/** Vertical reach of the rail glyph above (VDD) or below (GND) the bar — for
 *  bbox padding only. */
const RAIL_LABEL_REACH = 16;
/** How far the output net's branch wire reaches to the right of the PUN
 *  centre, plus the gap before the label. */
const OUT_STUB_LEN = 40;
const OUT_LABEL_GAP = 6;

export interface SchematicView {
  symbols: PlacedSymbol[];
  wires: Wire[];
  /** Distinct gate input nets so the canvas can render labelled stubs on
   *  the left and right of the domain. Each entry has the (x, y) port it
   *  connects to. */
  gates: GateInput[];
  /** Wire junctions (3+ way meetings) — rendered as small filled dots so
   *  the meeting reads as electrical. */
  junctions: Point[];
  /** Bounding box of the placed symbols + wires. The canvas uses this to
   *  pick an initial fit-to-viewport transform. */
  bbox: { x: number; y: number; width: number; height: number };
}

export interface RenderError {
  code:
    | "no-vcc"
    | "no-gnd"
    | "no-output"
    | "non-sp-pun"
    | "non-sp-pdn"
    | "no-pass-devices";
  message: string;
}

export type RenderResult =
  | { ok: true; view: SchematicView }
  | { ok: false; error: RenderError };

/**
 * Render one CMOS domain as a classic vertical-stack schematic.
 *   - First output net is treated as THE output (multi-output cells are
 *     suspicious anyway and `MERGED_DOMAINS` warns).
 *   - VCC / GND are the first nets with those labels.
 *   - PUN is decomposed between VCC and output; PDN between output and GND.
 *   - On a non-SP network, returns `RenderError`. The caller can fall back
 *     to a free-form layout or just surface a "non-SP" message.
 */
export function renderDomain(
  domain: CmosDomain,
  transistors: ReadonlyArray<Transistor>,
  nets: ReadonlyArray<ExtractedNet>,
): RenderResult {
  const vcc = nets.find((n) => n.label === "vcc");
  const gnd = nets.find((n) => n.label === "gnd");
  if (!vcc) return err("no-vcc", "no net labelled VCC — can't pin the PUN top rail");
  if (!gnd) return err("no-gnd", "no net labelled GND — can't pin the PDN bottom rail");

  const outputNetId = domain.outputNetIds[0];
  if (outputNetId == null) {
    return err("no-output", "domain has no output net");
  }

  const tById = new Map(transistors.map((t) => [t.id, t]));
  const punTs = domain.pmosTransistorIds
    .map((id) => tById.get(id))
    .filter((t): t is Transistor => !!t);
  const pdnTs = domain.nmosTransistorIds
    .map((id) => tById.get(id))
    .filter((t): t is Transistor => !!t);

  const punTree = decompose(vcc.id, outputNetId, toEdges(punTs));
  if (!punTree) {
    return err(
      "non-sp-pun",
      "pull-up network isn't series-parallel — can't render in classic stack form",
    );
  }
  const pdnTree = decompose(outputNetId, gnd.id, toEdges(pdnTs));
  if (!pdnTree) {
    return err(
      "non-sp-pdn",
      "pull-down network isn't series-parallel — can't render in classic stack form",
    );
  }

  // Layout each half independently. `leafInfo` resolves a transistor id
  // back to its (type, gateNet, top/bottom S/D nets) so the placed symbol
  // can be hovered and labelled correctly. The (top, bottom) sub-problem
  // a leaf lives in is the same set of nets across both PUN and PDN — the
  // transistor itself contributes S and D in some order to the local
  // (top, bottom); we resolve the order by net id below.
  const punLayout = layoutTree(punTree, (tid) => leafInfoFor(tById.get(tid)!, vcc.id, outputNetId, "pmos"));
  const pdnLayout = layoutTree(pdnTree, (tid) => leafInfoFor(tById.get(tid)!, outputNetId, gnd.id, "nmos"));

  // ── Stitch ─────────────────────────────────────────────────────
  //
  // Vertical stack (top → bottom):
  //   1. VCC rail
  //   2. Drop wire from rail down to PUN top port
  //   3. PUN
  //   4. Output bus (short horizontal bar at the meeting point, labelled)
  //   5. Drop wire from PUN bottom to PDN top
  //   6. PDN
  //   7. Drop wire to GND
  //   8. GND rail
  //
  // The two halves may differ in width — we center each in the global
  // canvas width and route the rail drop wires accordingly.
  const totalWidth = Math.max(punLayout.width, pdnLayout.width, RAIL_W);
  const midX = totalWidth / 2;

  const symbols: PlacedSymbol[] = [];
  const wires: Wire[] = [];
  const gates: GateInput[] = [];
  const junctions: Point[] = [];

  // 1. VDD rail at the top. The rail's internal (0,0) IS the bar, so
  //    placing the symbol at y=vccY puts the bar at absolute y=vccY.
  const vccY = 0;
  symbols.push({
    id: "rail:vcc",
    kind: "rail",
    x: midX - RAIL_W / 2,
    y: vccY,
    data: { kind: "rail", rail: "vcc", netId: vcc.id },
  });

  // 2. Drop wire from the VDD bar straight to PUN top port — no gap.
  const punY = vccY + RAIL_GAP;
  const punDx = midX - punLayout.width / 2;
  wires.push({
    from: { x: midX, y: vccY },
    to: { x: punLayout.topPort.x + punDx, y: punY + punLayout.topPort.y },
    netId: vcc.id,
  });

  // 3. PUN — pull in its placed symbols / wires / junctions.
  pushTranslated(punLayout, punDx, punY, symbols, wires, gates, junctions);

  // 4. Output node. One continuous vertical wire from the PUN bottom port
  //    down to the PDN top port, with a horizontal branch off the right
  //    side carrying the net label. Junction dot at the branch point so
  //    the 3-way meeting reads as electrical.
  const outY = punY + punLayout.height + VSPACE;
  const punBottomX = punLayout.bottomPort.x + punDx;
  const pdnDx = midX - pdnLayout.width / 2;
  const pdnY = outY + VSPACE;
  const pdnTopX = pdnLayout.topPort.x + pdnDx;
  // Vertical PUN→branch→PDN.
  wires.push({
    from: { x: punBottomX, y: punY + punLayout.bottomPort.y },
    to: { x: punBottomX, y: outY },
    netId: outputNetId,
  });
  // If PUN and PDN don't line up exactly, jog horizontally at the branch
  // y. This is rare in practice (both halves are centered at `midX`) but
  // keeps the output wire continuous when they differ.
  if (punBottomX !== pdnTopX) {
    wires.push({
      from: { x: punBottomX, y: outY },
      to: { x: pdnTopX, y: outY },
      netId: outputNetId,
    });
  }
  wires.push({
    from: { x: pdnTopX, y: outY },
    to: { x: pdnTopX, y: pdnY + pdnLayout.topPort.y },
    netId: outputNetId,
  });
  // Horizontal stub to the right + label. Stub originates at the upper end
  // of the output wire (PUN-side x) so the dot sits at the PUN bottom's x.
  const stubX = punBottomX + OUT_STUB_LEN;
  wires.push({
    from: { x: punBottomX, y: outY },
    to: { x: stubX, y: outY },
    netId: outputNetId,
  });
  junctions.push({ x: punBottomX, y: outY });
  symbols.push({
    id: `bus:out:${outputNetId}`,
    kind: "junction",
    x: stubX + OUT_LABEL_GAP,
    y: outY,
    data: {
      kind: "junction",
      netId: outputNetId,
      label: netLabel(nets, outputNetId) ?? `net${outputNetId}`,
    },
  });

  // 5. PDN — pull in.
  pushTranslated(pdnLayout, pdnDx, pdnY, symbols, wires, gates, junctions);

  // 6. Drop from PDN bottom to GND rail. The bar y is `gndY`; the GND
  //    glyph (rail bars + label) extends downward below it.
  const gndY = pdnY + pdnLayout.height + RAIL_GAP;
  const pdnBottomX = pdnLayout.bottomPort.x + pdnDx;
  wires.push({
    from: { x: pdnBottomX, y: pdnY + pdnLayout.bottomPort.y },
    to: { x: midX, y: gndY },
    netId: gnd.id,
  });

  // 7. GND rail (bar at gndY).
  symbols.push({
    id: "rail:gnd",
    kind: "rail",
    x: midX - RAIL_W / 2,
    y: gndY,
    data: { kind: "rail", rail: "gnd", netId: gnd.id },
  });

  // BBox: include the rail labels which extend outside the bar-to-bar
  // span (VDD label above vccY, GND glyph + label below gndY) plus a bit
  // of breathing room and extra room on the right for the output label.
  const pad = 24;
  const rightPad = pad + OUT_STUB_LEN + 48;
  return {
    ok: true,
    view: {
      symbols,
      wires,
      gates,
      junctions: dedupePoints(junctions),
      bbox: {
        x: -pad,
        y: vccY - RAIL_LABEL_REACH - pad,
        width: totalWidth + pad + rightPad,
        height: gndY + RAIL_LABEL_REACH + pad * 2,
      },
    },
  };
}

/** True when `renderPassNetwork` has something to draw. */
export function hasPassNetwork(transistors: ReadonlyArray<Transistor>): boolean {
  return transistors.some(isPassDevice);
}

function isPassDevice(t: Transistor): boolean {
  return (t.role === "tg" || t.role === "pass") && t.type !== "unknown";
}

/**
 * Render the cell's transmission gates / pass transistors at transistor
 * level. These devices sit between two signal nets and never touch a rail,
 * so there is no `CmosDomain` (and no VCC/GND stack) to hang them on —
 * this is the view for pass-gate-only cells such as an analog switch.
 *
 * Devices are grouped by the pair of nets they bridge; each group is drawn
 * as one parallel stack between two labelled terminals, groups side by
 * side. Parallel fingers (same polarity, same gate net) fold into a single
 * symbol tagged "×N".
 */
export function renderPassNetwork(
  transistors: ReadonlyArray<Transistor>,
  nets: ReadonlyArray<ExtractedNet>,
): RenderResult {
  const tById = new Map(transistors.map((t) => [t.id, t]));
  const netById = new Map(nets.map((n) => [n.id, n]));
  const nameOf = (id: number) => {
    const n = netById.get(id);
    return n ? netDisplayName(n) : `net${id}`;
  };

  // Group by bridged net pair, then fold fingers within each group.
  interface Group {
    top: number;
    bottom: number;
    /** Representative transistor id → how many fingers it stands for. */
    fingers: Map<string, number>;
    repByKey: Map<string, string>;
  }
  const groups = new Map<string, Group>();
  for (const t of transistors) {
    if (!isPassDevice(t)) continue;
    const top = Math.min(t.source.netId, t.drain.netId);
    const bottom = Math.max(t.source.netId, t.drain.netId);
    const key = `${top}|${bottom}`;
    let g = groups.get(key);
    if (!g) {
      g = { top, bottom, fingers: new Map(), repByKey: new Map() };
      groups.set(key, g);
    }
    const fKey = `${t.type}|${t.gate.netId}`;
    const rep = g.repByKey.get(fKey);
    if (rep == null) {
      g.repByKey.set(fKey, t.id);
      g.fingers.set(t.id, 1);
    } else {
      g.fingers.set(rep, (g.fingers.get(rep) ?? 1) + 1);
    }
  }
  if (groups.size === 0) {
    return err("no-pass-devices", "no transmission gates or pass transistors in this cell");
  }

  const symbols: PlacedSymbol[] = [];
  const wires: Wire[] = [];
  const gates: GateInput[] = [];
  const junctions: Point[] = [];

  /** Room on the left of each group for its first gate stub + label. */
  const GATE_LABEL_ROOM = 70;
  /** Room on the right of each group for the terminal stub + label. */
  const TERMINAL_ROOM = OUT_STUB_LEN + 60;
  const stackY = RAIL_GAP;
  let x = GATE_LABEL_ROOM;
  let maxBottom = 0;

  for (const g of groups.values()) {
    // PMOS first, then NMOS — the conventional TG drawing order.
    const reps = Array.from(g.fingers.keys())
      .map((id) => tById.get(id)!)
      .sort((a, b) => (a.type === b.type ? 0 : a.type === "pmos" ? -1 : 1));
    const tree: SPTree =
      reps.length === 1
        ? { kind: "leaf", transistorId: reps[0].id }
        : {
            kind: "parallel",
            branches: reps.map((t) => ({ kind: "leaf" as const, transistorId: t.id })),
          };
    const layout = layoutTree(tree, (tid) => {
      const t = tById.get(tid)!;
      return {
        transistorId: t.id,
        type: t.type,
        gateNetId: t.gate.netId,
        topNetId: g.top,
        bottomNetId: g.bottom,
      };
    });
    pushTranslated(layout, x, stackY, symbols, wires, gates, junctions);

    // Finger-count tags, right of each folded symbol's top pin (clear
    // of the neighbouring branch's gate label at mid-height).
    for (const s of layout.symbols) {
      if (s.data.kind !== "transistor") continue;
      const n = g.fingers.get(s.data.transistorId) ?? 1;
      if (n <= 1) continue;
      symbols.push({
        id: `fingers:${s.data.transistorId}`,
        kind: "junction",
        x: x + s.x + SYM_W / 2 + 5,
        y: stackY + s.y + 10,
        data: { kind: "junction", label: `×${n}` },
      });
    }

    // Terminals: a short lead out of each end, elbowing right to a
    // labelled stub (same look as a domain's output branch).
    const terminal = (port: Point, y: number, netId: number, id: string) => {
      const px = x + port.x;
      wires.push({ from: { x: px, y: stackY + port.y }, to: { x: px, y }, netId });
      wires.push({ from: { x: px, y }, to: { x: px + OUT_STUB_LEN, y }, netId });
      symbols.push({
        id,
        kind: "junction",
        x: px + OUT_STUB_LEN + OUT_LABEL_GAP,
        y,
        data: { kind: "junction", netId, label: nameOf(netId) },
      });
    };
    const bottomY = stackY + layout.height + RAIL_GAP;
    terminal(layout.topPort, 0, g.top, `term:top:${g.top}|${g.bottom}`);
    terminal(layout.bottomPort, bottomY, g.bottom, `term:bottom:${g.top}|${g.bottom}`);
    maxBottom = Math.max(maxBottom, bottomY);

    x += Math.max(layout.width, layout.topPort.x + TERMINAL_ROOM) + GATE_LABEL_ROOM;
  }

  const pad = 24;
  return {
    ok: true,
    view: {
      symbols,
      wires,
      gates,
      junctions: dedupePoints(junctions),
      bbox: {
        x: -pad,
        y: -pad,
        width: x - GATE_LABEL_ROOM + pad * 2,
        height: maxBottom + pad * 2,
      },
    },
  };
}

/**
 * Round each point to integer coords and drop duplicates. Junctions get
 * accumulated by both `layoutParallel` (interior drops + parent connection)
 * and `renderDomain` (output branch), and a few of those positions can
 * coincide — e.g. when the parent's `midX` lands exactly on a branch's drop
 * x. Dedupe so we don't paint two dots on top of each other.
 */
function dedupePoints(pts: ReadonlyArray<Point>): Point[] {
  const seen = new Set<string>();
  const out: Point[] = [];
  for (const p of pts) {
    const key = `${Math.round(p.x)},${Math.round(p.y)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

// ── Helpers ─────────────────────────────────────────────────────

function err(code: RenderError["code"], message: string): RenderResult {
  return { ok: false, error: { code, message } };
}

function toEdges(ts: Transistor[]): SPEdge[] {
  return ts.map((t) => ({ id: t.id, a: t.source.netId, b: t.drain.netId }));
}

/**
 * Map a transistor + its (top, bottom) sub-problem into `LeafInfo`. The
 * "top" and "bottom" nets of the layout don't always match the
 * transistor's "source" and "drain" labels — those are conventional only,
 * not topological — so we look at which S/D net is on which side of the
 * sub-problem and report accordingly.
 */
function leafInfoFor(
  t: Transistor,
  subTop: number,
  subBottom: number,
  type: "pmos" | "nmos",
): {
  transistorId: string;
  type: "pmos" | "nmos" | "unknown";
  gateNetId: number;
  topNetId: number;
  bottomNetId: number;
} {
  // The transistor is one edge in the sub-problem — its endpoints are
  // {source, drain}. Determine which one sits at `subTop` vs `subBottom`.
  // For deeper recursion, neither endpoint may match `subTop/subBottom`
  // directly (the leaf is one edge of a series sub-segment) — in that
  // case we keep the canonical source/drain order.
  let topNetId = t.source.netId;
  let bottomNetId = t.drain.netId;
  if (t.source.netId === subBottom || t.drain.netId === subTop) {
    topNetId = t.drain.netId;
    bottomNetId = t.source.netId;
  }
  return {
    transistorId: t.id,
    type,
    gateNetId: t.gate.netId,
    topNetId,
    bottomNetId,
  };
}

function netLabel(
  nets: ReadonlyArray<ExtractedNet>,
  id: number,
): string | undefined {
  const n = nets.find((x) => x.id === id);
  return n?.label;
}

/** Append a sub-layout's symbols/wires/gates/junctions with a (dx, dy)
 *  offset. */
function pushTranslated(
  c: LayoutResult,
  dx: number,
  dy: number,
  symbols: PlacedSymbol[],
  wires: Wire[],
  gates: GateInput[],
  junctions: Point[],
): void {
  for (const s of c.symbols) {
    symbols.push({ ...s, x: s.x + dx, y: s.y + dy });
  }
  for (const w of c.wires) {
    wires.push({
      from: { x: w.from.x + dx, y: w.from.y + dy },
      to: { x: w.to.x + dx, y: w.to.y + dy },
      netId: w.netId,
    });
  }
  for (const g of c.gates) {
    gates.push({
      transistorId: g.transistorId,
      port: { x: g.port.x + dx, y: g.port.y + dy },
      netId: g.netId,
    });
  }
  for (const j of c.junctions) {
    junctions.push({ x: j.x + dx, y: j.y + dy });
  }
}

// Re-export so the SVG component imports from one place.
export type {
  GateInput,
  LayoutResult,
  PlacedSymbol,
  Point,
  Wire,
} from "./layout";
export type { SPTree } from "./spTree";
export { SYM_H, SYM_W, HSPACE, VSPACE };
