/**
 * Place an SP-tree on a 2-D plane and emit the symbols + wires needed to
 * render it. The result is intentionally just data — the SVG component
 * decides how each `kind` actually looks.
 *
 * Coordinate convention: y grows downward (matches SVG). "Top" of a sub-
 * tree is its lower-y edge, "bottom" is its higher-y edge.
 *
 * Series layout: children stacked vertically, container width is `max
 * (children.width)`. Each child is horizontally centered; we emit a short
 * vertical wire to bridge any gap between one child's bottomPort and the
 * next child's topPort when the two aren't at the same x (their topPort
 * gets shifted because of the centering).
 *
 * Parallel layout: children side by side, container height is `max
 * (children.height)`. Each child is vertically centered. A top bus bar
 * runs along the container's top edge from the leftmost to the rightmost
 * branch top port; vertical drop-downs connect the bar to each branch's
 * topPort. Symmetric structure on the bottom.
 */

import type { SPTree } from "./spTree";

export interface Point {
  x: number;
  y: number;
}

/** Symbol placement record. `data` is opaque payload the renderer uses to
 *  paint the actual glyph (transistor type, label, etc.). */
export interface PlacedSymbol {
  id: string;
  kind: "transistor" | "rail" | "junction";
  /** Top-left of the symbol's local box. The symbol's own coordinates are
   *  relative to this — the renderer adds them. */
  x: number;
  y: number;
  data: TransistorSymbolData | RailSymbolData | JunctionSymbolData;
}

export interface TransistorSymbolData {
  kind: "transistor";
  transistorId: string;
  /** PMOS / NMOS / unknown — drives the glyph style. */
  type: "pmos" | "nmos" | "unknown";
  /** Net id at gate / source / drain — for hover / status info. */
  gateNetId: number;
  sourceNetId: number;
  drainNetId: number;
}

export interface RailSymbolData {
  kind: "rail";
  rail: "vcc" | "gnd";
  netId?: number;
}

export interface JunctionSymbolData {
  kind: "junction";
  /** The net all wires meeting at this junction belong to. Absent for a
   *  plain annotation (e.g. a "×N" finger count next to a transistor). */
  netId?: number;
  label?: string;
}

export interface Wire {
  /** Each segment is a straight Manhattan line. */
  from: Point;
  to: Point;
  /** Net the wire carries — drives colouring and hover. */
  netId?: number;
}

export interface GateInput {
  transistorId: string;
  /** Where the gate wire enters the symbol, in container coordinates. */
  port: Point;
  /** Net the gate signal is on. */
  netId: number;
}

export interface LayoutResult {
  /** Bounding-box size of the layout in schematic units. */
  width: number;
  height: number;
  /** Where the wire from above attaches (PUN: comes from VCC; PDN: from
   *  the output node). Relative to the layout's top-left. */
  topPort: Point;
  /** Where the wire below attaches (PUN: goes to output; PDN: to GND). */
  bottomPort: Point;
  symbols: PlacedSymbol[];
  wires: Wire[];
  /** Every transistor's gate connection point so the caller can route
   *  named inputs / cross-domain wires later. */
  gates: GateInput[];
  /** Points where three or more wires meet — the renderer draws a small
   *  filled circle so the connection reads as electrical. Emitted
   *  explicitly by `layoutParallel` (each drop wire intersecting the bus
   *  bar) and stitched in by the caller for the output meeting point. */
  junctions: Point[];
}

// ── Sizing constants ─────────────────────────────────────────────

/** Width of a single transistor symbol (schematic units, ~1 grid square). */
export const SYM_W = 60;
/** Height of a single transistor symbol. */
export const SYM_H = 60;
/** Horizontal gap between parallel branches. */
export const HSPACE = 28;
/** Vertical gap between series elements. */
export const VSPACE = 22;

// ── Recursive layout ─────────────────────────────────────────────

/**
 * Per-leaf info the caller has to provide so we can populate the symbol's
 * type / gate net / S-D nets without re-walking the transistor list inside
 * the layout. Keep this tiny — the layout doesn't care about anything else.
 */
export interface LeafInfo {
  transistorId: string;
  type: "pmos" | "nmos" | "unknown";
  gateNetId: number;
  /** Source/drain nets as they appear on the (top, bottom) sub-problem this
   *  leaf was placed in. `topNetId` is whatever S/D net of the transistor
   *  is the "top" side; `bottomNetId` is the other. */
  topNetId: number;
  bottomNetId: number;
}

export function layoutTree(
  tree: SPTree,
  leafInfo: (transistorId: string) => LeafInfo,
): LayoutResult {
  switch (tree.kind) {
    case "leaf":
      return layoutLeaf(leafInfo(tree.transistorId));
    case "series":
      return layoutSeries(tree.parts.map((p) => layoutTree(p, leafInfo)));
    case "parallel":
      return layoutParallel(tree.branches.map((b) => layoutTree(b, leafInfo)));
  }
}

function layoutLeaf(info: LeafInfo): LayoutResult {
  const sym: PlacedSymbol = {
    id: info.transistorId,
    kind: "transistor",
    x: 0,
    y: 0,
    data: {
      kind: "transistor",
      transistorId: info.transistorId,
      type: info.type,
      gateNetId: info.gateNetId,
      sourceNetId: info.topNetId,
      drainNetId: info.bottomNetId,
    },
  };
  return {
    width: SYM_W,
    height: SYM_H,
    topPort: { x: SYM_W / 2, y: 0 },
    bottomPort: { x: SYM_W / 2, y: SYM_H },
    symbols: [sym],
    wires: [],
    gates: [
      {
        transistorId: info.transistorId,
        port: { x: 0, y: SYM_H / 2 },
        netId: info.gateNetId,
      },
    ],
    junctions: [],
  };
}

function layoutSeries(children: LayoutResult[]): LayoutResult {
  const width = Math.max(...children.map((c) => c.width));
  const symbols: PlacedSymbol[] = [];
  const wires: Wire[] = [];
  const gates: GateInput[] = [];
  const junctions: Point[] = [];

  // Single pass: place each child at the running y, then emit the wire
  // connecting it to the previous child's bottom port. The horizontal
  // centering offset (`dx`) shifts where each child's top/bottom ports
  // land in the parent's frame.
  let y = 0;
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    const dx = (width - c.width) / 2;
    if (i > 0) {
      const prev = children[i - 1];
      const prevDx = (width - prev.width) / 2;
      const fromX = prev.bottomPort.x + prevDx;
      const fromY = (y - VSPACE) + (prev.bottomPort.y - prev.height); // = y - VSPACE
      const toX = c.topPort.x + dx;
      const toY = y + c.topPort.y; // = y (topPort.y is 0 by convention)
      // If horizontally aligned, one vertical wire; otherwise a 3-segment
      // Manhattan jog through the midpoint of the gap.
      if (fromX === toX) {
        wires.push({ from: { x: fromX, y: fromY }, to: { x: toX, y: toY } });
      } else {
        const midY = (fromY + toY) / 2;
        wires.push({ from: { x: fromX, y: fromY }, to: { x: fromX, y: midY } });
        wires.push({ from: { x: fromX, y: midY }, to: { x: toX, y: midY } });
        wires.push({ from: { x: toX, y: midY }, to: { x: toX, y: toY } });
      }
    }
    translateInto(c, dx, y, symbols, wires, gates, junctions);
    y += c.height;
    if (i < children.length - 1) y += VSPACE;
  }
  return {
    width,
    height: y,
    topPort: {
      x: children[0].topPort.x + (width - children[0].width) / 2,
      y: 0,
    },
    bottomPort: {
      x:
        children[children.length - 1].bottomPort.x +
        (width - children[children.length - 1].width) / 2,
      y,
    },
    symbols,
    wires,
    gates,
    junctions,
  };
}

function layoutParallel(children: LayoutResult[]): LayoutResult {
  const height = Math.max(...children.map((c) => c.height));
  const symbols: PlacedSymbol[] = [];
  const wires: Wire[] = [];
  const gates: GateInput[] = [];
  const junctions: Point[] = [];
  const tops: Point[] = [];
  const bottoms: Point[] = [];
  let x = 0;
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    const dy = (height - c.height) / 2; // vertical centering offset
    translateInto(c, x, dy, symbols, wires, gates, junctions);
    tops.push({ x: c.topPort.x + x, y: dy + c.topPort.y });
    bottoms.push({ x: c.bottomPort.x + x, y: dy + c.bottomPort.y });
    x += c.width;
    if (i < children.length - 1) x += HSPACE;
  }
  const width = x;
  // Top bus bar: horizontal line at y=0 from leftmost to rightmost branch
  // top-x, plus a drop wire from the bar down to each branch top port.
  // Junction dot at every place where 3+ wires meet:
  //   - interior drops (bus split + drop down)
  //   - the parent-connection point `(midX, 0)` (bus split + the wire the
  //     parent draws to attach to this parallel's `topPort`)
  // The two are deduped at the end of layout to handle the case where
  // `midX` coincides with a branch drop.
  const minTopX = Math.min(...tops.map((p) => p.x));
  const maxTopX = Math.max(...tops.map((p) => p.x));
  const midX = width / 2;
  if (maxTopX > minTopX) {
    wires.push({ from: { x: minTopX, y: 0 }, to: { x: maxTopX, y: 0 } });
  }
  for (const tp of tops) {
    if (tp.y > 0) wires.push({ from: { x: tp.x, y: 0 }, to: { x: tp.x, y: tp.y } });
    // Junction at every interior drop (skip the two ends — they're the
    // wire's natural termini and conventionally drawn without a dot).
    if (tp.x !== minTopX && tp.x !== maxTopX) junctions.push({ x: tp.x, y: 0 });
  }
  // Parent-connection junction: only when a bus actually exists (>1
  // branch) and the parent wire meets the bus in its interior. If `midX`
  // happens to be at one of the bus endpoints, no dot — the parent meets
  // a bus terminus, which is a 2-way corner.
  if (maxTopX > minTopX && midX > minTopX && midX < maxTopX) {
    junctions.push({ x: midX, y: 0 });
  }
  // Bottom bus bar — mirror.
  const minBotX = Math.min(...bottoms.map((p) => p.x));
  const maxBotX = Math.max(...bottoms.map((p) => p.x));
  if (maxBotX > minBotX) {
    wires.push({ from: { x: minBotX, y: height }, to: { x: maxBotX, y: height } });
  }
  for (const bp of bottoms) {
    if (bp.y < height) wires.push({ from: { x: bp.x, y: bp.y }, to: { x: bp.x, y: height } });
    if (bp.x !== minBotX && bp.x !== maxBotX) junctions.push({ x: bp.x, y: height });
  }
  if (maxBotX > minBotX && midX > minBotX && midX < maxBotX) {
    junctions.push({ x: midX, y: height });
  }
  return {
    width,
    height,
    topPort: { x: midX, y: 0 },
    bottomPort: { x: midX, y: height },
    symbols,
    wires,
    gates,
    junctions,
  };
}

// ── Translation helper ───────────────────────────────────────────

/** Copy a child layout's symbols / wires / gates / junctions into the
 *  parent's arrays with a (dx, dy) translation applied. Mutating the
 *  targets avoids the array-spreading overhead in tight nested layouts. */
function translateInto(
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

