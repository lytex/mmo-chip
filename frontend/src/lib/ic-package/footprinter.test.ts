import { describe, it, expect } from "vitest";
import { loadPackageGeom, PACKAGE_PRESETS } from "./footprinter";

describe("loadPackageGeom", () => {
  it("loads SOIC-8 with 8 pins and positive body bounds", () => {
    const g = loadPackageGeom("soic8");
    expect(g.pins.length).toBe(8);
    expect(g.body.maxX).toBeGreaterThan(g.body.minX);
    expect(g.body.maxY).toBeGreaterThan(g.body.minY);
    // Pins start un-named.
    expect(g.pins.every((p) => p.name === "")).toBe(true);
    // Sorted by number.
    const nums = g.pins.map((p) => p.number);
    expect(nums).toEqual([...nums].sort((a, b) => a - b));
  });

  it("SOT-23-5 has 5 pads", () => {
    expect(loadPackageGeom("sot25").pins.length).toBe(5);
  });

  it("DIP-8 has 8 plated holes", () => {
    const g = loadPackageGeom("dip8");
    expect(g.pins.length).toBe(8);
  });

  it("PACKAGE_PRESETS all parse without throwing", () => {
    for (const pr of PACKAGE_PRESETS) {
      expect(() => loadPackageGeom(pr.value)).not.toThrow();
    }
  });
});
