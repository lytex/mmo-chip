import { describe, expect, it } from "vitest";
import type { AnnotationNet } from "shared";
import { buildNetAnnotation } from "./nets";

const net: AnnotationNet = {
  id: "n1",
  name: "Net 1",
  nodes: [
    { id: "a", x: 10, y: 10 },
    { id: "b", x: 30, y: 10 },
    { id: "c", x: 50, y: 10 },
  ],
  edges: [
    { id: "ab", from: "a", to: "b" },
    { id: "bc", from: "b", to: "c" },
  ],
};

describe("net marquee parts", () => {
  it("selects only fully contained segments left-to-right", () => {
    const annotation = buildNetAnnotation(net, () => 10, () => "#fff");
    expect(annotation.rectPickParts?.({ x: 5, y: 5, width: 30, height: 10 }, true)).toEqual([
      "net:n1/edge:ab",
    ]);
  });

  it("selects crossing segments right-to-left", () => {
    const annotation = buildNetAnnotation(net, () => 10, () => "#fff");
    expect(annotation.rectPickParts?.({ x: 25, y: 5, width: 10, height: 10 }, false)).toEqual([
      "net:n1/edge:ab",
      "net:n1/edge:bc",
    ]);
  });
});
