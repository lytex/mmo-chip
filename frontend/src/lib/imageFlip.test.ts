import { describe, expect, it } from "vitest";
import type { Cell, CellType, DieAnnotations } from "shared";
import { cellWorldRect } from "./cellFootprint";
import { cellTypeSizes, flipAnnotations, flipRect } from "./imageFlip";

const size = { width: 1000, height: 600 };

const cellType = {
  id: "t1",
  name: "inv",
  cropRect: { x: 0, y: 0, width: 40, height: 20 }
} as unknown as CellType;

const cells: Cell[] = [
  { id: "c1", cellTypeId: "t1", x: 100, y: 50 },
  { id: "c2", cellTypeId: "t1", x: 300, y: 200, rotation: 90, flippedV: true },
  { id: "c3", cellTypeId: "t1", x: 600, y: 400, rotation: 270, bounds: { x: 5, y: 2, width: 20, height: 10 } }
];

const ann: DieAnnotations = {
  version: 2,
  rev: 3,
  nets: [{ id: "n1", name: "a", nodes: [{ id: "p", x: 10, y: 20 }], edges: [] }],
  cellTypes: [cellType],
  cells,
  grids: [],
  pins: [{ id: "pin", x: 990, y: 5, pin: 1, name: "VDD" }],
  annotations: [
    { id: "v1", class: "point_via", geometry: { kind: "point", x: 1, y: 2 } },
    { id: "v2", class: "irregular_via", geometry: { kind: "rectangle", x: 10, y: 10, width: 30, height: 5 } }
  ],
  rois: [{ id: "r", x: 0, y: 0, width: 100, height: 50 }],
  guides: [
    { id: "g1", kind: "line", axis: "x", pos: 250 },
    { id: "g2", kind: "line", axis: "y", pos: 100 }
  ],
  rulers: [{ id: "ru", x1: 0, y1: 0, x2: 10, y2: 30, lengthPx: 31.6, lengthUm: 0 }],
  comments: [{ id: "cm", x: 7, y: 8, text: "hi", authorId: "u", authorName: "U", createdAt: "", replies: [] }],
  analogLayers: { nwell: [{ id: "s", kind: "rect", x: 100, y: 100, width: 50, height: 20 }] }
};

const sizes = cellTypeSizes(ann);

describe("flipAnnotations", () => {
  it.each(["h", "v"] as const)("is its own inverse (%s)", (axis) => {
    const twice = flipAnnotations(flipAnnotations(ann, axis, size, sizes), axis, size, sizes);
    expect(twice).toEqual(ann);
  });

  it.each(["h", "v"] as const)("lands each cell footprint mirrored (%s)", (axis) => {
    const out = flipAnnotations(ann, axis, size, sizes);
    out.cells.forEach((c, i) => {
      const before = cellWorldRect(cells[i], 40, 20);
      expect(cellWorldRect(c, 40, 20)).toEqual(flipRect(before, { [axis]: true }, size));
    });
    // Mirroring on the die mirrors the cell's content: one more reflection.
    expect(out.cells[0].flippedH ?? false).toBe(axis === "h");
    expect(out.cells[0].flippedV ?? false).toBe(axis === "v");
  });

  it("mirrors points, rects, guides and records the flip", () => {
    const out = flipAnnotations(ann, "h", size, sizes);
    expect(out.imageFlip).toEqual({ h: true });
    expect(out.nets[0].nodes[0]).toMatchObject({ x: 990, y: 20 });
    expect(out.pins?.[0]).toMatchObject({ x: 10, y: 5, name: "VDD" });
    expect(out.annotations?.[1].geometry).toEqual({ kind: "rectangle", x: 960, y: 10, width: 30, height: 5 });
    expect(out.rois?.[0]).toMatchObject({ x: 900, y: 0, width: 100, height: 50 });
    expect(out.guides).toEqual([
      { id: "g1", kind: "line", axis: "x", pos: 750 },
      { id: "g2", kind: "line", axis: "y", pos: 100 }
    ]);
    expect(out.rulers?.[0]).toMatchObject({ x1: 1000, x2: 990, y2: 30 });
    expect(out.analogLayers?.nwell?.[0]).toMatchObject({ x: 850, y: 100, width: 50, height: 20 });
    // Cell types stay in their own frame / raw-image crop.
    expect(out.cellTypes).toBe(ann.cellTypes);

    const both = flipAnnotations(out, "v", size, sizes);
    expect(both.imageFlip).toEqual({ h: true, v: true });
    expect(flipAnnotations(both, "h", size, sizes).imageFlip).toEqual({ v: true });
  });
});
