import { describe, it, expect } from "vitest";
import {
  routeNetLocal,
  gridFallback,
  buildNetIndex,
  powerDevices,
  deviceKey,
  runInteractiveLayout,
  transformPin,
  orientedSize,
  deviceObstacle,
  WIRE_OBSTACLE_PAD,
  regionExternalNets,
  blockDevices,
  blockSize,
  WireGrid,
  type LocalRouteOptions,
  type TracedEdge,
  type WireData,
  type Obstacle,
  type HierarchyBlock,
} from "./interactiveAnalogLayout";
import { parseSymbolSkin } from "./interactiveSymbols";
import type { AnalogDevice } from "shared";

const table = parseSymbolSkin();

function mos(name: string, mosType: "nmos" | "pmos", terminals: Array<[string, number]>): AnalogDevice {
  return {
    id: name,
    kind: "mos",
    instanceName: name,
    layer: "poly",
    bbox: { x: 0, y: 0, width: 1, height: 1 },
    geometry: { mosType, W_um: 1, L_um: 0.5 },
    terminals: terminals.map(([t, netId]) => ({ name: t, netId })),
  } as unknown as AnalogDevice;
}

function res(name: string, terminals: Array<[string, number]>): AnalogDevice {
  return {
    id: name,
    kind: "resistor",
    instanceName: name,
    layer: "poly",
    bbox: { x: 0, y: 0, width: 1, height: 1 },
    geometry: { resistance_ohms: 1000, squares: 10, resistorType: "poly" },
    terminals: terminals.map(([t, netId]) => ({ name: t, netId })),
  } as unknown as AnalogDevice;
}

describe("buildNetIndex", () => {
  it("maps terminals to nets incl. power devices", () => {
    const devices = [
      mos("M_1", "nmos", [["D", 5], ["G", 6], ["S", 7], ["B", 8]]),
    ];
    const nets = new Map([[7, "VDD"]]);
    const powers = powerDevices(devices, nets, { vdd: "VDD", gnd: "GND" });
    expect(powers).toHaveLength(1);
    expect(powers[0].instanceName).toBe("VDD:7");
    const idx = buildNetIndex(devices, {}, powers);
    expect(idx.get(5)).toEqual([{ deviceKey: "M_1", terminal: "D" }]);
    expect(idx.get(7)).toEqual([
      { deviceKey: "M_1", terminal: "S" },
      { deviceKey: "VDD:7", terminal: "PLUS" },
    ]);
  });
});

describe("routeNetLocal", () => {
  const noObs: Obstacle[] = [];
  const ai = (x: number, y: number, k = "d", t = "T") => ({ point: { x, y }, deviceKey: k, terminal: t });

  it("two anchors → single polyline, orthogonal, deterministic", () => {
    const w1 = routeNetLocal([ai(0, 0, "a"), ai(100, 50, "b")], noObs);
    expect(w1.polylines).toHaveLength(1);
    expect(w1.junctions).toHaveLength(0);
    const path = w1.polylines[0];
    expect(path[0]).toEqual({ x: 0, y: 0 });
    expect(path[path.length - 1]).toEqual({ x: 100, y: 50 });
    for (let i = 1; i < path.length; i++) {
      // each segment axis-aligned
      expect(path[i].x === path[i - 1].x || path[i].y === path[i - 1].y).toBe(true);
    }
    const w2 = routeNetLocal([ai(0, 0, "a"), ai(100, 50, "b")], noObs);
    expect(w2).toEqual(w1);
  });

  it("avoids an obstacle between anchors when a clean candidate exists", () => {
    // Straight H-first route would cross the box at (40..60, 20..30)
    const obs: Obstacle[] = [{ x: 40, y: 20, w: 20, h: 10 }];
    const w = routeNetLocal([ai(0, 25, "a"), ai(100, 25, "b")], obs);
    // Path must not pass through the obstacle interior
    for (const line of w.polylines) {
      for (let i = 1; i < line.length; i++) {
        const a = line[i - 1], b = line[i];
        const y = a.y;
        if (y > 20 - 12 && y < 30 + 12) {
          const lo = Math.min(a.x, b.x), hi = Math.max(a.x, b.x);
          expect(hi <= 40 - 12 || lo >= 60 + 12).toBe(true);
        }
      }
    }
  });

  it("three anchors → hub with junction", () => {
    const w = routeNetLocal(
      [ai(0, 0, "a"), ai(100, 0, "b"), ai(50, 100, "c")],
      noObs,
    );
    expect(w.polylines).toHaveLength(3);
    expect(w.junctions).toHaveLength(1);
    // hub is median of xs=50, ys=0
    expect(w.junctions[0]).toEqual({ x: 50, y: 0 });
  });

  it("empty / single anchors → no wires", () => {
    expect(routeNetLocal([], noObs).polylines).toHaveLength(0);
    expect(routeNetLocal([ai(5, 5)], noObs).polylines).toHaveLength(0);
  });

  it("returns per-edge trace for surgical re-route", () => {
    const w = routeNetLocal([ai(0, 0, "a"), ai(100, 0, "b")], noObs);
    expect(w.edges).toHaveLength(1);
    expect(w.edges![0].fromKey).toBe("a");
    expect(w.edges![0].toKey).toBe("b");
    expect(w.edges![0].polylines).toHaveLength(1);
  });

  it("N-terminal → one edge per spoke to hub", () => {
    const w = routeNetLocal([ai(0, 0, "a"), ai(100, 0, "b"), ai(50, 100, "c")], noObs);
    expect(w.edges).toHaveLength(3);
    expect(w.edges!.every((e) => e.toKey === "__hub__")).toBe(true);
  });
});

describe("deviceObstacle", () => {
  it("inflates the box by WIRE_OBSTACLE_PAD on every side", () => {
    const o = deviceObstacle({ x: 10, y: 20 }, { w: 42, h: 36 });
    expect(o).toEqual({ x: 10 - WIRE_OBSTACLE_PAD, y: 20 - WIRE_OBSTACLE_PAD, w: 42 + 2 * WIRE_OBSTACLE_PAD, h: 36 + 2 * WIRE_OBSTACLE_PAD });
  });

  it("uses oriented size for 90/270 rotation", () => {
    const o = deviceObstacle({ x: 0, y: 0 }, { w: 42, h: 36 }, { rot: 90, flip: "none" });
    expect(o.w).toBe(36 + 2 * WIRE_OBSTACLE_PAD);
    expect(o.h).toBe(42 + 2 * WIRE_OBSTACLE_PAD);
  });
});

describe("gridFallback", () => {
  it("places all devices deterministically and routes wires locally", () => {
    const devices = [
      mos("M_1", "nmos", [["D", 1], ["G", 2], ["S", 3], ["B", 3]]),
      mos("M_2", "pmos", [["D", 1], ["G", 2], ["S", 4], ["B", 4]]),
      res("R_1", [["PLUS", 1], ["MINUS", 2]]),
    ];
    const nets = new Map([
      [1, "n1"], [2, "n2"], [3, "VDD"], [4, "GND"],
    ]);
    const result = gridFallback(devices, nets, table, { vdd: "VDD", gnd: "GND" });
    expect(result.usedFallback).toBe(true);
    expect(Object.keys(result.positions).sort()).toEqual(["GND:4", "M_1", "M_2", "R_1", "VDD:3"].sort());
    // Every net got routed
    for (const netId of [1, 2, 3, 4]) {
      const w = result.wires.get(netId);
      expect(w, `net ${netId} unrouted`).toBeDefined();
      expect(w!.polylines.length).toBeGreaterThan(0);
    }
    // VDD (net 3) wires reach both M_1.S and VDD pin — ≥2 terminals
    expect(result.wires.get(3)!.polylines.length).toBeGreaterThanOrEqual(2);
    // bbox sane
    expect(result.bbox.width).toBeGreaterThan(0);
    expect(result.bbox.height).toBeGreaterThan(0);
  });
});

describe("deviceKey", () => {
  it("prefers instanceName over id", () => {
    expect(deviceKey(mos("M_9", "nmos", []))).toBe("M_9");
  });
});

describe("transformPin / orientedSize", () => {
  // NMOS_v: box 42×36, center (21,18). D top (30,0), S bottom (30,36),
  // G left (0,18), B right (36,18). Rotation is cw per SVG rotate().
  const W = 42, H = 36;
  const D = { dx: 30, dy: 0 };
  const S = { dx: 30, dy: 36 };
  const G = { dx: 0, dy: 18 };
  const B = { dx: 36, dy: 18 };

  it("identity — no transform, same coords", () => {
    expect(transformPin(D, W, H, undefined)).toEqual(D);
    expect(transformPin(S, W, H, { rot: 0, flip: "none" })).toEqual(S);
  });

  it("90° clockwise: D top→right (39,27), S bottom→left (3,27), G left→top, B right→bottom", () => {
    const r90 = { rot: 90 as const, flip: "none" as const };
    expect(transformPin(D, W, H, r90)).toEqual({ dx: 39, dy: 27 });
    expect(transformPin(S, W, H, r90)).toEqual({ dx: 3, dy: 27 });
    expect(transformPin(G, W, H, r90)).toEqual({ dx: 21, dy: -3 });
    expect(transformPin(B, W, H, r90)).toEqual({ dx: 21, dy: 33 });
  });

  it("180° flips both axes (D top ↔ S bottom, G left ↔ B right)", () => {
    const r180 = { rot: 180 as const, flip: "none" as const };
    expect(transformPin(D, W, H, r180)).toEqual({ dx: 12, dy: 36 });
    expect(transformPin(S, W, H, r180)).toEqual({ dx: 12, dy: 0 });
    expect(transformPin(G, W, H, r180)).toEqual({ dx: 42, dy: 18 });
    expect(transformPin(B, W, H, r180)).toEqual({ dx: 6, dy: 18 });
  });

  it("mirror h flips x about center: G left→(42,18), B right→(6,18)", () => {
    const fh = { rot: 0 as const, flip: "h" as const };
    expect(transformPin(G, W, H, fh)).toEqual({ dx: 42, dy: 18 });
    expect(transformPin(B, W, H, fh)).toEqual({ dx: 6, dy: 18 });
    expect(transformPin(D, W, H, fh)).toEqual({ dx: 12, dy: 0 });
  });

  it("orientedSize swaps width/height only for 90/270", () => {
    const base = { w: 42, h: 36 };
    expect(orientedSize(base, { rot: 0, flip: "none" })).toEqual(base);
    expect(orientedSize(base, { rot: 180, flip: "none" })).toEqual(base);
    expect(orientedSize(base, { rot: 90, flip: "none" })).toEqual({ w: 36, h: 42 });
    expect(orientedSize(base, { rot: 270, flip: "none" })).toEqual({ w: 36, h: 42 });
  });
});

describe("runInteractiveLayout (ELK, node)", () => {
  it("applies requested strategy/direction/compaction and echoes them back", async () => {
    const devices = [
      mos("M_1", "nmos", [["D", 1], ["G", 2], ["S", 3], ["B", 3]]),
      mos("M_2", "pmos", [["D", 1], ["G", 2], ["S", 3], ["B", 3]]),
    ];
    const nets = new Map([[1, "n1"], [2, "n2"], [3, "VDD"]]);
    const res = await runInteractiveLayout(devices, nets, table, {
      vdd: "VDD", gnd: "GND",
      strategy: "BRANDES_KOEPF",
      direction: "DOWN",
      compaction: 4,
    });
    expect(res.usedFallback).toBe(false);
    expect(res.applied).toEqual({ strategy: "BRANDES_KOEPF", direction: "DOWN", compaction: 4 });
    expect(Object.keys(res.positions).sort()).toEqual(["M_1", "M_2", "VDD:3"]);
    // DOWN direction: VDD symbol (driver) above the nmos S pin it feeds
    expect(res.positions["VDD:3"].y).toBeLessThan(res.positions["M_1"].y);
    expect(res.wires.get(1)?.polylines.length).toBeGreaterThan(0);
  }, 30000);

  it("accepts fine-tuning options (spacing, merge, straight) without fallback", async () => {
    const devices = [
      mos("M_1", "nmos", [["D", 1], ["G", 2], ["S", 3], ["B", 3]]),
      mos("M_2", "pmos", [["D", 1], ["G", 2], ["S", 3], ["B", 3]]),
    ];
    const nets = new Map([[1, "n1"], [2, "n2"], [3, "VDD"]]);
    const res = await runInteractiveLayout(devices, nets, table, {
      vdd: "VDD", gnd: "GND",
      nodeNode: 60,
      betweenLayers: 15,
      edgeEdge: 20,
      edgeNode: 25,
      favorStraightEdges: true,
    });
    expect(res.usedFallback).toBe(false);
    expect(res.wires.get(1)?.polylines.length).toBeGreaterThan(0);
    expect(res.positions["VDD:3"]).toBeDefined();
  }, 30000);

  it("direction RIGHT puts the driver left of its consumer", async () => {
    const devices = [
      mos("M_1", "nmos", [["D", 1], ["G", 2], ["S", 3], ["B", 3]]),
      mos("M_2", "pmos", [["D", 1], ["G", 2], ["S", 3], ["B", 3]]),
    ];
    const nets = new Map([[1, "n1"], [2, "n2"], [3, "VDD"]]);
    const res = await runInteractiveLayout(devices, nets, table, {
      vdd: "VDD", gnd: "GND",
      strategy: "SIMPLE",
      direction: "RIGHT",
      compaction: 0,
    });
    expect(res.applied?.direction).toBe("RIGHT");
    // VDD is the consumer (sink) now, so it's to the RIGHT of devices in RIGHT direction
    expect(res.positions["VDD:3"].x).toBeGreaterThan(res.positions["M_2"].x);
  }, 30000);

  // Regression: nets used to lose ALL their ELK edges (and thus wires)
  // when the chosen driver was locked or portless — the wire only
  // appeared after the user dragged one of the net's devices.
  function mirrorCircuit(): Array<[AnalogDevice[], Map<number, string>]> {
    const devices = [
      // classic NMOS current mirror: M_1 diode-connected
      mos("M_1", "nmos", [["D", 2], ["G", 2], ["S", 3], ["B", 3]]),
      mos("M_2", "nmos", [["D", 1], ["G", 2], ["S", 3], ["B", 3]]),
      res("R_1", [["PLUS", 4], ["MINUS", 1]]),
    ];
    const nets = new Map([[1, "out"], [2, "gate"], [3, "GND"], [4, "VDD"]]);
    return [[devices, nets]];
  }

  it("mirror circuit: EVERY net gets routed wires after ELK", async () => {
    const [devices, nets] = mirrorCircuit()[0];
    const res = await runInteractiveLayout(devices, nets, table, {
      vdd: "VDD", gnd: "GND", strategy: "BRANDES_KOEPF", direction: "DOWN", compaction: 2,
    });
    expect(res.usedFallback).toBe(false);
    for (const netId of [1, 2, 3, 4]) {
      const w = res.wires.get(netId);
      expect(w, `net ${netId} has no wires`).toBeDefined();
      expect(w!.polylines.length, `net ${netId} empty polylines`).toBeGreaterThan(0);
    }
  }, 30000);

  it("locked driver does not orphan its net (fallback driver)", async () => {
    const [devices, nets] = mirrorCircuit()[0];
    // M_3 joins the gate net; M_1 (its first member / pseudo-driver) is
    // locked. ELK edges cannot reference a locked node, but the net
    // must still be routed between the UNLOCKED members.
    devices.push(mos("M_3", "nmos", [["D", 5], ["G", 2], ["S", 3], ["B", 3]]));
    nets.set(5, "out2");
    const res = await runInteractiveLayout(devices, nets, table, {
      vdd: "VDD", gnd: "GND",
      excludeKeys: new Set(["M_1"]),
    });
    expect(res.usedFallback).toBe(false);
    // gate net still has ELK wires between unlocked members
    expect(res.wires.get(2)?.polylines.length ?? 0).toBeGreaterThan(0);
    // locked M_1 itself has no ELK position (excluded from the graph)
    expect(res.positions["M_1"]).toBeUndefined();
  }, 30000);

  // Regression from the 2A edge-role revert: a net whose members are ALL
  // one direction (e.g. two NMOS S terminals + no input-role pin) used to
  // drop every wire because consumers were empty.
  it("all-output net (nmos S×N only, no input pin) still gets wires", async () => {
    const devices = [
      mos("M_1", "nmos", [["D", 1], ["G", 2], ["S", 3], ["B", 3]]),
      mos("M_2", "nmos", [["D", 4], ["G", 2], ["S", 3], ["B", 3]]),
      // net 3 (S+B of both): every pin is output-role (S bottom) or
      // undefined (B right → input for MOS) — no power node, no io.
    ];
    const nets = new Map([[1, "n1"], [2, "gate"], [3, "n3"], [4, "n4"]]);
    const res = await runInteractiveLayout(devices, nets, table, {
      vdd: "VDD", gnd: "GND", strategy: "SIMPLE", direction: "DOWN", compaction: 0,
    });
    expect(res.usedFallback).toBe(false);
    expect(res.wires.get(3)?.polylines.length ?? 0).toBeGreaterThan(0);
    // every net with ≥2 members routed
    for (const netId of [2, 3]) {
      expect(res.wires.get(netId)?.polylines.length ?? 0, `net ${netId}`).toBeGreaterThan(0);
    }
    // single-member nets have no wires (nothing to draw to) — not a regression
    expect(res.wires.get(1) ?? res.wires.get(4) ?? { polylines: [] }).toMatchObject({ polylines: [] });
  }, 30000);

  // Power-rail fan-out: one vcc driver, many consumers. ELK edges must be
  // bounded (no N×M explosion) yet the rail wires must still exist.
  it("power rail fan-out (1 driver, many consumers) survives without crash", async () => {
    const devices: AnalogDevice[] = [
      mos("M_1", "nmos", [["D", 1], ["G", 2], ["S", 3], ["B", 3]]),
    ];
    const nets = new Map([[1, "n1"], [2, "gate"], [3, "VDD"]]);
    // 20 pmos sources all sourcing from the same VDD rail (S=3)
    let nextNet = 100;
    for (let i = 2; i <= 21; i++) {
      devices.push(mos(`M_${i}`, "pmos", [["D", nextNet], ["G", 2], ["S", 3], ["B", 3]]));
      nets.set(nextNet, `n${i}`);
      nextNet++;
      // NOTE: netId 3 stays "VDD" — power rail netNames come from
      // namedNets by netId, never clobbered by the loop.
    }
    const res = await runInteractiveLayout(devices, nets, table, {
      vdd: "VDD", gnd: "GND", strategy: "SIMPLE", direction: "DOWN", compaction: 0,
    });
    expect(res.usedFallback).toBe(false);
    // VDD rail wired (≥1 polyline), VDD symbol placed, and ELK didn't blow up
    expect(res.wires.get(3)?.polylines.length ?? 0).toBeGreaterThan(0);
    expect(res.positions["VDD:3"]).toBeDefined();
  }, 30000);
});

describe("hierarchy blocks", () => {
  it("regionExternalNets exposes only cross-region / io nets as block ports", () => {
    // net 1 crosses regions A and B → becomes a port on both.
    // net 2 is region-A-local → NOT a port.
    // net 5 is a die io pin on region A → becomes a port.
    const a = [mos("A1", "nmos", [["D", 1], ["G", 2], ["S", 5], ["B", 5]])];
    const b = [mos("B1", "pmos", [["D", 1], ["G", 3], ["S", 4], ["B", 4]])];
    const fp = new Map<string, AnalogDevice[]>([["A", a], ["B", b]]);
    const nets = new Map<number, string>([
      [1, "share"], [2, "localA"], [3, "gateB"], [4, "srcB"], [5, "ioV"],
    ]);
    const blocks: HierarchyBlock[] = regionExternalNets(
      fp, [], new Set([5]), nets, { vdd: "VDD", gnd: "GND" },
    );
    const portNames = (blk: HierarchyBlock) => blk.nets.map((n) => n.name).sort();
    const aNames = portNames(blocks.find((b) => b.regionId === "A")!);
    expect(aNames).toEqual(["ioV", "share"]); // localA excluded
    const bNames = portNames(blocks.find((b) => b.regionId === "B")!);
    expect(bNames).toEqual(["share"]);
  });

  it("regionExternalNets uses region.name when provided (readable block label)", () => {
    const a = [mos("A1", "nmos", [["D", 1], ["G", 2], ["S", 5], ["B", 5]])];
    const b = [mos("B1", "pmos", [["D", 1], ["G", 3], ["S", 4], ["B", 4]])];
    const fp = new Map<string, AnalogDevice[]>([["A", a], ["B", b]]);
    const nets = new Map<number, string>([[1, "share"], [5, "ioV"]]);
    const blocks = regionExternalNets(
      fp, [], new Set([5]), nets, { vdd: "VDD", gnd: "GND" },
      new Map([["A", "bandgap"], ["B", "diffpair"]]),
    );
    const blk = (rid: string) => blocks.find((b) => b.regionId === rid)!;
    expect(blk("A").name).toBe("bandgap");
    expect(blk("B").name).toBe("diffpair");
  });

  it("blockSize scales with block name + port label length", () => {
    const small: HierarchyBlock = {
      regionId: "A", name: "A",
      nets: [{ netId: 1, name: "in", direction: "input" }],
    };
    const big: HierarchyBlock = {
      regionId: "B", name: "amplifier_output_stage",
      nets: [{ netId: 9, name: "bandgap_reference_divider", direction: "output" }],
    };
    const s = blockSize(small);
    const bsz = blockSize(big);
    expect(bsz.w).toBeGreaterThan(s.w);
    expect(bsz.h).toBeGreaterThanOrEqual(48);
    // width is clamped to a sane max
    expect(bsz.w).toBeLessThanOrEqual(260);
  });

  it("blockDevices synthesizes in_/out_ terminals bound to the net ids", () => {
    const blocks: HierarchyBlock[] = [{
      regionId: "A",
      name: "A",
      nets: [
        { netId: 1, name: "share", direction: "input" },
        { netId: 5, name: "ioV", direction: "output" },
      ],
    }];
    const devs = blockDevices(blocks);
    expect(devs).toHaveLength(1);
    expect(deviceKey(devs[0])).toBe("blk:A");
    expect(devs[0].terminals).toEqual([
      { name: "in_share", netId: 1 },
      { name: "out_ioV", netId: 5 },
    ]);
  });

  it("runInteractiveLayout accepts blocks and routes their port nets", async () => {
    const devices = [mos("U1", "nmos", [["D", 1], ["G", 2], ["S", 3], ["B", 3]])];
    const nets = new Map<number, string>([[1, "out"], [2, "inp"], [3, "GND"], [4, "VDD"]]);
    const blocks: HierarchyBlock[] = [{
      regionId: "REG",
      name: "REG",
      nets: [
        { netId: 1, name: "out", direction: "output" },
        { netId: 2, name: "inp", direction: "input" },
      ],
    }];
    const res = await runInteractiveLayout(devices, nets, table, {
      vdd: "VDD", gnd: "GND", strategy: "SIMPLE", direction: "DOWN", compaction: 0,
      blocks,
    });
    expect(res.usedFallback).toBe(false);
    expect(res.positions["blk:REG"]).toBeDefined();
    // wires between block ports and the device via shared nets 1/2
    for (const netId of [1, 2]) {
      expect(res.wires.get(netId)?.polylines.length ?? 0, `net ${netId}`).toBeGreaterThan(0);
    }
  }, 30000);
});

describe("WireGrid (wire-wire spacing)", () => {
  it("reports zero proximity for a clear segment", () => {
    const grid = new WireGrid([{ a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }], 10);
    // Segment far below the wire at y=0 — no proximity.
    expect(grid.proximityLength({ x: 0, y: 50 }, { x: 100, y: 50 })).toBe(0);
  });

  it("penalizes a segment running on top of an existing wire", () => {
    const grid = new WireGrid([{ a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }], 10);
    // Horizontal segment exactly on the wire — full proximity.
    const prox = grid.proximityLength({ x: 0, y: 0 }, { x: 100, y: 0 });
    expect(prox).toBeGreaterThan(90);
  });

  it("inflates to neighbours — segment within gap scores proximity", () => {
    const grid = new WireGrid([{ a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }], 10);
    // Segment 5px below the wire — within the 10px gap, should score.
    const prox = grid.proximityLength({ x: 0, y: 5 }, { x: 100, y: 5 });
    expect(prox).toBeGreaterThan(0);
  });

  it("cell size clamps to minimum 2 to avoid degenerate grids", () => {
    const grid = new WireGrid([{ a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }], 0);
    // With gap=0, cell size clamps to 2. Segment on wire still scores.
    const prox = grid.proximityLength({ x: 0, y: 0 }, { x: 10, y: 0 });
    expect(prox).toBeGreaterThan(0);
  });
});

describe("routeNetLocal spacing options", () => {
  const ai = (x: number, y: number, k = "d", t = "T") => ({ point: { x, y }, deviceKey: k, terminal: t });
  it("uses edgeNode margin to steer wires around obstacles", () => {
    // Two anchors with a device obstacle between them.
    const obstacle: Obstacle = { x: 40, y: -10, w: 20, h: 60 };
    const anchors = [ai(0, 0, "a"), ai(100, 0, "b")];
    // With small edgeNode (1) the wire can pass closer to the device.
    const tight = routeNetLocal(anchors, [obstacle], { edgeNode: 1 });
    // With large edgeNode (40) the wire must detour further from the device.
    const wide = routeNetLocal(anchors, [obstacle], { edgeNode: 40 });
    // The wide-margin path should have a larger vertical detour.
    const maxY_tight = Math.max(...tight.polylines.flat().map((p) => Math.abs(p.y)));
    const maxY_wide = Math.max(...wide.polylines.flat().map((p) => Math.abs(p.y)));
    expect(maxY_wide).toBeGreaterThan(maxY_tight);
  });

  it("wireGrid pushes a candidate wire away from an existing segment", () => {
    // Existing wire along y=0. New net: two anchors at y=5 (would overlap).
    const existing = [{ a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }];
    const grid = new WireGrid(existing, 10);
    const obstacle: Obstacle = { x: 40, y: 20, w: 20, h: 20 };
    const anchors = [ai(0, 5, "a"), ai(100, 5, "b")];
    // Without grid, the straight L-paths through y=5 might be fine.
    const noGrid = routeNetLocal(anchors, [obstacle]);
    // With grid, the wire at y=5 scores proximity → detours away from y=0.
    const withGrid = routeNetLocal(anchors, [obstacle], { wireGrid: grid, edgeEdge: 10 });
    // With grid, max |y| should be at least as far from y=0 as without.
    const maxY_noGrid = Math.max(...noGrid.polylines.flat().map((p) => p.y));
    const maxY_withGrid = Math.max(...withGrid.polylines.flat().map((p) => p.y));
    expect(maxY_withGrid).toBeGreaterThanOrEqual(maxY_noGrid);
  });

  it("defaults to edgeNode=12 when options omitted", () => {
    const obstacle: Obstacle = { x: 40, y: -5, w: 20, h: 30 };
    const anchors = [ai(0, 0, "a"), ai(100, 0, "b")];
    const def = routeNetLocal(anchors, [obstacle]);
    const explicit = routeNetLocal(anchors, [obstacle], { edgeNode: 12 });
    // Same result when default matches explicit.
    expect(def.polylines).toEqual(explicit.polylines);
  });
});

describe("surgical re-route (edge trace)", () => {
  const ai = (x: number, y: number, k = "d", t = "T") => ({ point: { x, y }, deviceKey: k, terminal: t });
  it("preserves untouched edges when only one device of a 2-terminal net moves", () => {
    // Simulate an ELK-produced wire with two edges (a-b and b-c).
    const edgeAB: TracedEdge = {
      id: "e1", netId: 1, fromKey: "a", toKey: "b", fromTerminal: "D", toTerminal: "S",
      polylines: [[{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }]],
    };
    const edgeBC: TracedEdge = {
      id: "e2", netId: 1, fromKey: "b", toKey: "c", fromTerminal: "S", toTerminal: "G",
      polylines: [[{ x: 100, y: 0 }, { x: 100, y: 50 }, { x: 100, y: 100 }]],
    };
    const wd: WireData = {
      polylines: [...edgeAB.polylines, ...edgeBC.polylines],
      junctions: [{ x: 100, y: 0 }],
      edges: [edgeAB, edgeBC],
    };
    // Surgical re-route touching only "a" must keep edgeBC pixel-identical.
    const pos: Record<string, { x: number; y: number }> = { a: { x: 0, y: 10 }, b: { x: 100, y: 0 }, c: { x: 100, y: 100 } };
    const members = [{ deviceKey: "a", terminal: "D" }, { deviceKey: "b", terminal: "S" }, { deviceKey: "c", terminal: "G" }];
    const movedSet = new Set(["a"]);
    const terminalOf = new Map(members.map((m) => [m.deviceKey, m.terminal]));
    const noObs: Obstacle[] = [];
    const opts = { edgeNode: 12, edgeEdge: 10 };

    const newEdges = wd.edges!.map((edge) => {
      if (!movedSet.has(edge.fromKey) && !movedSet.has(edge.toKey)) return edge;
      const fromTerm = terminalOf.get(edge.fromKey);
      const toTerm = terminalOf.get(edge.toKey);
      const fromAnchor = fromTerm ? { x: pos[edge.fromKey].x, y: pos[edge.fromKey].y } : undefined;
      const toAnchor = toTerm ? { x: pos[edge.toKey].x, y: pos[edge.toKey].y } : undefined;
      if (!fromAnchor || !toAnchor) return edge;
      const routed = routeNetLocal(
        [{ point: fromAnchor, deviceKey: edge.fromKey, terminal: edge.fromTerminal }, { point: toAnchor, deviceKey: edge.toKey, terminal: edge.toTerminal }],
        noObs, opts,
      );
      return { ...edge, polylines: (routed.edges ?? [])[0]?.polylines ?? edge.polylines };
    });

    // edgeBC (b-c) untouched — identical polylines.
    expect(newEdges[1].polylines).toEqual(edgeBC.polylines);
    // edgeAB (a-b) re-routed — different from original (a moved from y=0 to y=10).
    expect(newEdges[0].polylines).not.toEqual(edgeAB.polylines);
    // Re-routed edge still connects a→b.
    expect(newEdges[0].fromKey).toBe("a");
    expect(newEdges[0].toKey).toBe("b");
  });

  it("full re-route (no edges trace) falls back to hub-spoke", () => {
    // WireData without edges → full re-route path.
    const wd: WireData = {
      polylines: [[{ x: 0, y: 0 }, { x: 50, y: 0 }]],
      junctions: [],
    };
    expect(wd.edges).toBeUndefined();
    // routeNetLocal with 3 anchors produces a hub + 3 spokes.
    const anchors = [ai(0, 0, "a"), ai(100, 0, "b"), ai(50, 100, "c")];
    const full = routeNetLocal(anchors, []);
    expect(full.polylines).toHaveLength(3);
    expect(full.junctions).toHaveLength(1);
  });
});
