import { describe, expect, it } from "vitest";
import type { IOPin, PackagePin, WireBond } from "shared";
import { buildPinTable } from "./export";

const pins: PackagePin[] = [
  { number: 1, name: "VDD", x: 0, y: 0, w: 1, h: 0.6 },
  { number: 2, name: "GND", x: 1, y: 0, w: 1, h: 0.6 },
  { number: 3, name: "", x: 2, y: 0, w: 1, h: 0.6 },
];

const pads: IOPin[] = [
  { id: "a", x: 10, y: 10, pin: 5, name: "vdd" },
  { id: "b", x: 20, y: 20, pin: 6, name: "" },
  { id: "c", x: 30, y: 30, pin: 7, name: "gnd" },
];

const bonds: WireBond[] = [
  { id: "b1", pinNumber: 1, diePadId: "a" },
  { id: "b2", pinNumber: 2, diePadId: "b" },
  { id: "b3", pinNumber: 2, diePadId: "c" },
];

describe("buildPinTable", () => {
  it("maps each package pin to its bonded die pad numbers", () => {
    const rows = buildPinTable(pins, bonds, pads);
    expect(rows).toHaveLength(3);

    expect(rows[0]).toMatchObject({ number: 1, name: "VDD" });
    expect(rows[0].diePadNumbers).toEqual([5]);
    expect(rows[0].diePadNames).toEqual(["vdd"]);

    // Multiple parallel pads on one pin.
    expect(rows[1]).toMatchObject({ number: 2, name: "GND" });
    expect(rows[1].diePadNumbers).toEqual([6, 7]);
    expect(rows[1].diePadNames).toEqual(["gnd"]);

    expect(rows[2].diePadNumbers).toEqual([]);
    expect(rows[2].diePadNames).toEqual([]);
  });

  it("skips bonds referencing missing pads", () => {
    const rows = buildPinTable(pins, [{ id: "x", pinNumber: 3, diePadId: "nope" }], pads);
    expect(rows[2].diePadNumbers).toEqual([]);
  });
});