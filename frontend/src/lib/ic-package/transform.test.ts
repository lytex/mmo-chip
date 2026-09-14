import { describe, it, expect } from "vitest";
import {
  transformDiePoint,
  inverseTransformDiePoint,
  findNearestPad,
  findClickedPin,
  DEFAULT_DIE_TRANSFORM,
  rotatedImageBbox,
} from "./transform";
import type { IOPin } from "shared";

const IMG = { width: 1000, height: 1000 };

describe("transformDiePoint", () => {
  it("identity: returns the input point", () => {
    const r = transformDiePoint(100, 200, IMG.width, IMG.height, DEFAULT_DIE_TRANSFORM);
    expect(r.x).toBeCloseTo(100);
    expect(r.y).toBeCloseTo(200);
  });

  it("180° rotation maps (x,y) → (W-x, H-y)", () => {
    const r = transformDiePoint(100, 200, IMG.width, IMG.height, {
      rotationDeg: 180, mirrorX: false, mirrorY: false,
    });
    expect(r.x).toBeCloseTo(IMG.width - 100);
    expect(r.y).toBeCloseTo(IMG.height - 200);
  });

  it("90° rotation maps (x,y) → (W-y, x) (counter-clockwise math, applied to image)", () => {
    const r = transformDiePoint(100, 200, IMG.width, IMG.height, {
      rotationDeg: 90, mirrorX: false, mirrorY: false,
    });
    expect(r.x).toBeCloseTo(IMG.width - 200);
    expect(r.y).toBeCloseTo(100);
  });

  it("mirrorX alone flips X around center", () => {
    const r = transformDiePoint(100, 200, IMG.width, IMG.height, {
      rotationDeg: 0, mirrorX: true, mirrorY: false,
    });
    expect(r.x).toBeCloseTo(IMG.width - 100);
    expect(r.y).toBeCloseTo(200);
  });

  it("mirrorY alone flips Y around center", () => {
    const r = transformDiePoint(100, 200, IMG.width, IMG.height, {
      rotationDeg: 0, mirrorX: false, mirrorY: true,
    });
    expect(r.x).toBeCloseTo(100);
    expect(r.y).toBeCloseTo(IMG.height - 200);
  });

  it("180° + mirrorX = mirrorY (well-known identity)", () => {
    const a = transformDiePoint(100, 200, IMG.width, IMG.height, {
      rotationDeg: 180, mirrorX: true, mirrorY: false,
    });
    const b = transformDiePoint(100, 200, IMG.width, IMG.height, {
      rotationDeg: 0, mirrorX: false, mirrorY: true,
    });
    expect(a.x).toBeCloseTo(b.x);
    expect(a.y).toBeCloseTo(b.y);
  });
});

describe("inverseTransformDiePoint", () => {
  it("inverse undoes forward", () => {
    for (const t of [
      { rotationDeg: 0, mirrorX: false, mirrorY: false },
      { rotationDeg: 90, mirrorX: false, mirrorY: false },
      { rotationDeg: 180, mirrorX: true, mirrorY: true },
      { rotationDeg: 270, mirrorX: true, mirrorY: false },
    ]) {
      const fwd = transformDiePoint(123, 456, IMG.width, IMG.height, t);
      const inv = inverseTransformDiePoint(fwd.x, fwd.y, IMG.width, IMG.height, t);
      expect(inv.x).toBeCloseTo(123);
      expect(inv.y).toBeCloseTo(456);
    }
  });
});

describe("findNearestPad", () => {
  const pads: IOPin[] = [
    { id: "p1", x: 100, y: 100, pin: 1, name: "" },
    { id: "p2", x: 200, y: 200, pin: 2, name: "" },
    { id: "p3", x: 300, y: 300, pin: 3, name: "" },
  ];

  it("finds the nearest pad under identity transform", () => {
    const r = findNearestPad(105, 98, pads, IMG.width, IMG.height, DEFAULT_DIE_TRANSFORM, 10);
    expect(r?.id).toBe("p1");
  });

  it("respects max distance", () => {
    const r = findNearestPad(500, 500, pads, IMG.width, IMG.height, DEFAULT_DIE_TRANSFORM, 10);
    expect(r).toBeNull();
  });

  it("applies rotation when finding nearest", () => {
    // With 180° rotation, the original p3 (300,300) appears at (700,700).
    const r = findNearestPad(702, 698, pads, IMG.width, IMG.height, {
      rotationDeg: 180, mirrorX: false, mirrorY: false,
    }, 10);
    expect(r?.id).toBe("p3");
  });
});

describe("rotatedImageBbox", () => {
  it("0°/180°: returns source rect", () => {
    expect(rotatedImageBbox(1000, 500, 0)).toEqual({ x: 0, y: 0, width: 1000, height: 500 });
    expect(rotatedImageBbox(1000, 500, 180)).toEqual({ x: 0, y: 0, width: 1000, height: 500 });
  });

  it("90°: rect swap, centered on original center, may extend outside source rect", () => {
    const b = rotatedImageBbox(1000, 500, 90);
    expect(b.width).toBe(500);
    expect(b.height).toBe(1000);
    // center stays at (500, 250)
    expect(b.x + b.width / 2).toBeCloseTo(500);
    expect(b.y + b.height / 2).toBeCloseTo(250);
    // y extends below 0
    expect(b.y).toBeLessThan(0);
    expect(b.y + b.height).toBeGreaterThan(500);
  });

  it("270°: same dims as 90°, same center", () => {
    const a = rotatedImageBbox(1000, 500, 90);
    const b = rotatedImageBbox(1000, 500, 270);
    expect(a).toEqual(b);
  });

  it("square image: bbox stays in source rect", () => {
    const b = rotatedImageBbox(500, 500, 90);
    expect(b).toEqual({ x: 0, y: 0, width: 500, height: 500 });
  });
});

describe("findClickedPin", () => {
  const pins = [
    { number: 1, name: "", x: 0, y: 0, w: 1, h: 0.5 },
    { number: 2, name: "", x: 5, y: 0, w: 1, h: 0.5 },
  ];

  it("picks the nearest pin within tolerance", () => {
    expect(findClickedPin(0.2, 0.1, pins, 0.5)).toBe(1);
    expect(findClickedPin(5.0, 0.0, pins, 0.5)).toBe(2);
  });

  it("returns null outside tolerance", () => {
    expect(findClickedPin(100, 100, pins, 0.5)).toBeNull();
  });
});
