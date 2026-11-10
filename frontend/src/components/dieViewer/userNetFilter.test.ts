import { describe, it, expect } from "vitest";
import {
  filterTracesByUserNets,
  filterTracesByRegions,
  traceRegionBox,
  polylineEntersRect,
  collectUserNetPolylines,
  USER_NET_DEFAULT_TOL
} from "./userNetFilter";
import type { MLTracePolyline } from "shared";

const t = (points: [number, number][]): MLTracePolyline => ({ points, score: 1 });

describe("filterTracesByUserNets", () => {
  it("passes everything through when no hand-drawn nets exist", () => {
    const traces = [t([[0, 0], [100, 0]])];
    const r = filterTracesByUserNets(traces, [], undefined);
    expect(r.traces).toBe(traces); // same array, untouched
    expect(r.droppedUserNets).toBe(0);
  });

  it("drops a trace whose segment strictly crosses a drawn wire", () => {
    const traces = [
      t([[0, 100], [200, 100]]), // horizontal, crosses the drawn vertical
      t([[0, 0], [100, 300]]) // past the drawn wire's end — kept
    ];
    const r = filterTracesByUserNets(
      traces,
      [{ netId: "u1", points: [[100, 0], [100, 200]], width: 6 }],
      undefined
    );
    expect(r.droppedUserNets).toBe(1);
    expect(r.traces).toHaveLength(1);
    expect(r.traces[0].points).toEqual([[0, 0], [100, 300]]);
  });

  it("drops a trace whose vertex falls inside the drawn buffer", () => {
    // Buffer radius = max(width/2, tol): width 6 → 4 (DEFAULT_TOL wins for r=3)
    const traces = [
      t([[0, 0], [110, 0]]) // right vertex 10px beyond the drawn endpoint
    ];
    const r = filterTracesByUserNets(
      traces,
      [{ netId: "u1", points: [[100, 0], [100, 50]], width: 20 }],
      undefined
    );
    // width/2 = 10, vertex at (110,0) is exactly at the radius of the first
    // segment → inside the buffer → dropped.
    expect(r.droppedUserNets).toBe(1);
    expect(r.traces).toHaveLength(0);
  });

  it("keeps a trace that merely runs past the drawn wire without touching", () => {
    const traces = [t([[0, 0], [100, 0]])];
    const r = filterTracesByUserNets(
      traces,
      [{ netId: "u1", points: [[0, 50], [100, 50]], width: 6 }],
      undefined,
      USER_NET_DEFAULT_TOL
    );
    // 44px clearance, buffer ≈ 7-10 px → kept.
    expect(r.droppedUserNets).toBe(0);
    expect(r.traces).toHaveLength(1);
  });

  it("drops traces fully inside an outline polygon crossed by ONE drawn net", () => {
    const outline: [number, number][] = [[0, 0], [500, 0], [500, 100], [0, 100]];
    const traces = [
      t([[50, 50], [450, 50]]), // fully inside, centre
      t([[50, 20], [450, 20]]) // fully inside, upper rail
    ];
    const r = filterTracesByUserNets(
      traces,
      [{ netId: "u1", points: [[250, -20], [250, 120]], width: 6 }], // crosses the poly
      [outline]
    );
    expect(r.droppedUserNets).toBe(2);
    expect(r.traces).toHaveLength(0);
  });

  it("does NOT wholesale-drop inside a polygon crossed by two DIFFERENT nets", () => {
    const outline: [number, number][] = [[0, 0], [500, 0], [500, 100], [0, 100]];
    // The trace rides between the two drawn wires: neither wire crosses it
    // and no vertex rides inside a buffer.
    const traces = [t([[50, 30], [450, 30]])];
    const r = filterTracesByUserNets(
      traces,
      [
        { netId: "u1", points: [[250, -20], [250, 15]], width: 6 }, // crosses top edge
        { netId: "u2", points: [[250, 60], [250, 120]], width: 6 } // crosses bottom edge
      ],
      [outline]
    );
    // Ambiguous polygon → the exact-overlap rule only: this trace neither
    // crosses a wire nor rides inside a buffer, so it is kept.
    expect(r.droppedUserNets).toBe(0);
    expect(r.traces).toHaveLength(1);
  });

  it("keeps traces inside a polygon NO drawn wire crosses", () => {
    const outline: [number, number][] = [[0, 0], [500, 0], [500, 100], [0, 100]];
    const traces = [t([[50, 50], [450, 50]])];
    const r = filterTracesByUserNets(
      traces,
      [{ netId: "u1", points: [[700, 10], [700, 90]], width: 6 }],
      [outline]
    );
    expect(r.droppedUserNets).toBe(0);
    expect(r.traces).toHaveLength(1);
  });

  it("collectUserNetPolylines flattens net node-edge graph into segments", () => {
    const lines = collectUserNetPolylines(
      {
        nets: [
          {
            id: "net1",
            name: "ML-1",
            nodes: [
              { id: "a", x: 0, y: 0 },
              { id: "b", x: 10, y: 0 },
              { id: "c", x: 999, y: 0 }
            ],
            edges: [
              { id: "e1", from: "a", to: "b" },
              { id: "e2", from: "b", to: "zzz-missing" }
            ]
          }
        ]
      },
      8
    );
    expect(lines).toHaveLength(1); // the dangling edge is skipped
    expect(lines[0]).toEqual({ netId: "net1", points: [[0, 0], [10, 0]], width: 8 });
  });

  it("collectUserNetPolylines tolerates missing annotations", () => {
    expect(collectUserNetPolylines(undefined, 8)).toEqual([]);
  });

  it("traceRegionBox culls a rect and a polygon by their extents", () => {
    expect(traceRegionBox({ kind: "rect", x: 10, y: 20, width: 30, height: 40 })).toEqual({
      x: 10,
      y: 20,
      width: 30,
      height: 40
    });
    expect(
      traceRegionBox({ kind: "poly", points: [[0, 0], [100, 10], [50, 90]] })
    ).toEqual({ x: 0, y: 0, width: 100, height: 90 });
  });

  it("filterTracesByRegions keeps traces inside / touching a region", () => {
    const traces = [
      t([[10, 10], [90, 90]]), // inside
      t([[200, 10], [290, 90]]), // outside → dropped
      t([[95, 10], [150, 90]]) // straddles the region edge → kept
    ];
    const outlines: [number, number][][] = [
      [[20, 20], [80, 20], [80, 80], [20, 80]], // inside → kept
      [[300, 300], [320, 300], [320, 320], [300, 320]] // outside → dropped
    ];
    const r = filterTracesByRegions(traces, outlines, [{ kind: "rect", x: 0, y: 0, width: 100, height: 100 }]);
    expect(r.traces).toHaveLength(2);
    expect(r.droppedOutsideRegion).toBe(1);
    expect(r.outlines).toHaveLength(1);
  });

  it("filterTracesByRegions passes everything through without regions", () => {
    const traces = [t([[0, 0], [5, 5]])];
    const outlines: [number, number][][] = [[[1, 1], [2, 1], [2, 2]]];
    const r = filterTracesByRegions(traces, outlines, []);
    expect(r.traces).toBe(traces);
    expect(r.outlines).toBe(outlines);
    expect(r.droppedOutsideRegion).toBe(0);
  });

  // Regression: the blockage used to cull on per-trace BBOX overlap, so a
  // chain whose bbox merely SPANS the blockage (an L-shaped trace that bends
  // around it — exactly what the decoder emits) was dropped although its
  // centreline never entered the rect.
  it("blockage drops only traces whose geometry actually enters it", () => {
    const blockage = { x: 100, y: 100, width: 50, height: 50 };
    const traces = [
      t([[110, 110], [130, 130]]), // inside → dropped
      t([[50, 125], [200, 125]]), // straight through the middle → dropped
      t([[0, 50], [80, 50], [80, 160], [200, 160]]), // L-shaped, bends around; bbox spans the blockage → kept
      t([[10, 10], [90, 90]]) // far away → kept
    ];
    const r = filterTracesByRegions(traces, [], [], [blockage]);
    expect(r.traces.map((x) => x.points)).toEqual([
      [[0, 50], [80, 50], [80, 160], [200, 160]],
      [[10, 10], [90, 90]]
    ]);
    expect(r.droppedInBlockage).toBe(2);
    expect(r.droppedOutsideRegion).toBe(0);
  });

  it("blockage wins over a region that contains it", () => {
    const traces = [
      t([[110, 110], [130, 130]]), // inside the blockage, inside the region
      t([[10, 10], [50, 50]]) // in the region, outside the blockage
    ];
    const r = filterTracesByRegions(
      traces,
      [],
      [{ kind: "rect", x: 0, y: 0, width: 300, height: 300 }],
      [{ x: 100, y: 100, width: 50, height: 50 }]
    );
    expect(r.traces).toHaveLength(1);
    expect(r.traces[0].points).toEqual([[10, 10], [50, 50]]);
    expect(r.droppedInBlockage).toBe(1);
  });

  it("polylineEntersRect distinguishes entering from bbox-spanning", () => {
    const r = { x: 100, y: 100, width: 50, height: 50 };
    expect(polylineEntersRect([[120, 120]], r)).toBe(true); // vertex inside
    expect(polylineEntersRect([[0, 125], [200, 125]], r)).toBe(true); // crosses
    expect(polylineEntersRect([[0, 50], [80, 50], [80, 160], [200, 160]], r)).toBe(false); // L-shape; bbox spans
    expect(polylineEntersRect([[0, 99], [200, 99]], r)).toBe(false); // below the rect
    expect(polylineEntersRect([[101, 100], [101, 160]], r)).toBe(true); // rides the left edge in and out
    expect(polylineEntersRect([], r)).toBe(false);
  });
});
