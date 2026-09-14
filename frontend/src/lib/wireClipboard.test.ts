import { describe, expect, it } from "vitest";
import type { AnnotationNet } from "shared";
import { pasteWireClipboard, snapshotWireClipboard } from "./wireClipboard";

const source: AnnotationNet = {
  id: "source",
  name: "Net 1",
  nodes: [
    { id: "a", x: 10, y: 20 },
    { id: "b", x: 30, y: 20 },
    { id: "c", x: 30, y: 40 },
  ],
  edges: [
    { id: "ab", from: "a", to: "b", layer: "metal1" },
    { id: "bc", from: "b", to: "c", layer: "metal2" },
  ],
};

describe("wire clipboard", () => {
  it("preserves selected segment connectivity and relative offsets", () => {
    const clipboard = snapshotWireClipboard(
      [source],
      new Set(["net:source/edge:ab", "net:source/edge:bc"]),
    );
    expect(clipboard?.groups).toHaveLength(1);
    expect(clipboard?.groups[0].edges).toHaveLength(2);
    expect(clipboard?.groups[0].nodes).toEqual([
      { id: "a", offsetX: 0, offsetY: 0 },
      { id: "b", offsetX: 20, offsetY: 0 },
      { id: "c", offsetX: 20, offsetY: 20 },
    ]);

    const changes = pasteWireClipboard([], clipboard!, { x: 100, y: 200 });
    expect(changes).toHaveLength(1);
    expect(changes[0].next?.edges).toHaveLength(2);
    const pasted = changes[0].next!;
    const middle = pasted.nodes.find((node) => node.x === 120 && node.y === 200);
    expect(middle).toBeDefined();
    expect(pasted.edges.some((edge) => edge.from === middle!.id || edge.to === middle!.id)).toBe(true);
  });

  it("splits and joins an existing wire when a pasted endpoint lands on it", () => {
    const existing: AnnotationNet = {
      id: "existing",
      name: "Net 2",
      nodes: [
        { id: "left", x: 0, y: 0 },
        { id: "right", x: 20, y: 0 },
      ],
      edges: [{ id: "lr", from: "left", to: "right", layer: "metal1" }],
    };
    const clipboard = snapshotWireClipboard(
      [{ ...source, nodes: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 10, y: 0 }], edges: [{ id: "ab", from: "a", to: "b", layer: "metal2" }] }],
      new Set(["net:source/edge:ab"]),
    );
    const changes = pasteWireClipboard([existing], clipboard!, { x: 10, y: 0 });
    expect(changes).toHaveLength(1);
    expect(changes[0].next?.id).toBe("existing");
    expect(changes[0].next?.nodes).toHaveLength(3);
    expect(changes[0].next?.edges).toHaveLength(3);
    expect(changes[0].next?.edges.some((edge) => edge.layer === "metal2")).toBe(true);
  });

  it("keeps wire offsets aligned to a shared cell-and-wire origin", () => {
    const clipboard = snapshotWireClipboard(
      [source],
      new Set(["net:source/edge:ab"]),
      { x: 0, y: 0 },
    );
    expect(clipboard?.groups[0].nodes).toEqual([
      { id: "a", offsetX: 10, offsetY: 20 },
      { id: "b", offsetX: 30, offsetY: 20 },
    ]);
  });
});
