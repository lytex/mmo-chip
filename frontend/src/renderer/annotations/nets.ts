import type { AnnotationNet } from "shared";
import {
  distancePointToSegment,
  pointInRect,
  segmentIntersectsRect,
  type Rect
} from "../../lib/geometry";
import type { Annotation } from "../layers/AnnotationLayer";
import {
  NET_NODE_RADIUS_MULT,
  PICK,
  SELECT_COLOR,
  SELECT_NODE_MULT,
  SELECT_OUTLINE_PX,
  SELECT_RING,
  SELECT_WIDTH_MULT,
  WIRE_LAYER_COLOR,
  netScreenWidth
} from "./style";

/**
 * Build the spatially-indexed annotation for one net. Exported so callers can
 * `layer.update(...)` a single net during a live vertex drag without clearing
 * and rebuilding the whole index.
 */
export function buildNetAnnotation(
  net: AnnotationNet,
  getWidth: () => number,
  getColor: () => string,
  /** ML mode: stroke uses the real document-space width (source px, scales
   *  with zoom like the image) and vertices are drawn flush with it (radius =
   *  half the stroke), so a net renders as the uniform-width trace the export
   *  rasterises. Default false → zoom-stable on-screen width + larger edit
   *  handles. */
  getMatchWidth: () => boolean = () => false
): Annotation {
  // Compute bbox from all nodes.
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const n of net.nodes) {
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x > maxX) maxX = n.x;
    if (n.y > maxY) maxY = n.y;
  }
  if (!isFinite(minX)) {
    minX = minY = maxX = maxY = 0;
  }
  const bbox: Rect = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  const nodeIndex = new Map(net.nodes.map((n) => [n.id, n]));
  const netId = `net:${net.id}`;
  const nodeSubId = (nodeId: string) => `${netId}/node:${nodeId}`;
  const edgeSubId = (edgeId: string) => `${netId}/edge:${edgeId}`;

  return {
    id: netId,
    kind: "net",
    pickPriority: PICK.net,
    bbox,
    draw(ctx, bounds, state) {
      // ML mode: the stroke is the real document-space width (source px), so
      // it scales with the image like the export footprint. Otherwise it's a
      // zoom-stable on-screen width (clamped, then back to world units).
      const mlMode = getMatchWidth();
      const screenWidth = netScreenWidth(bounds.zoom, getWidth());
      const worldWidth = mlMode ? getWidth() : screenWidth / bounds.zoom;
      const baseColor = net.color ?? getColor();
      const whole = state.selected;
      const edgeSel = (e: AnnotationNet["edges"][number]) =>
        whole || state.isSelected(edgeSubId(e.id));
      const nodeSel = (n: AnnotationNet["nodes"][number]) =>
        whole || state.isSelected(nodeSubId(n.id));

      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      // Unselected edges: one batched path per layer color (unknown layer →
      // the configurable base color). Selected edges then drawn on top in the
      // amber accent, thicker, so the selection stands out regardless of layer.
      const byColor = new Map<string, AnnotationNet["edges"]>();
      for (const e of net.edges) {
        if (edgeSel(e)) continue;
        const col = net.color ?? (e.layer ? WIRE_LAYER_COLOR[e.layer] : baseColor);
        const list = byColor.get(col);
        if (list) list.push(e);
        else byColor.set(col, [e]);
      }
      ctx.lineWidth = worldWidth;
      for (const [col, es] of byColor) {
        ctx.strokeStyle = col;
        ctx.beginPath();
        for (const e of es) {
          const a = nodeIndex.get(e.from);
          const b = nodeIndex.get(e.to);
          if (!a || !b) continue;
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
        }
        ctx.stroke();
      }

      ctx.strokeStyle = SELECT_COLOR;
      ctx.lineWidth = worldWidth * SELECT_WIDTH_MULT;
      ctx.beginPath();
      let anySel = false;
      for (const e of net.edges) {
        if (!edgeSel(e)) continue;
        const a = nodeIndex.get(e.from);
        const b = nodeIndex.get(e.to);
        if (!a || !b) continue;
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        anySel = true;
      }
      if (anySel) ctx.stroke();

      // Nodes: fill unselected, then larger fill + white ring for selected on
      // top (the ring pops against dark imagery).
      // ML mode: a vertex is just the wire's rounded join — radius = half the
      // stroke — so junctions don't bulge. Otherwise the bigger edit handle.
      const nodeRadius = mlMode
        ? worldWidth / 2
        : (screenWidth * NET_NODE_RADIUS_MULT) / bounds.zoom;
      ctx.fillStyle = baseColor;
      for (const n of net.nodes) {
        if (nodeSel(n)) continue;
        ctx.beginPath();
        ctx.arc(n.x, n.y, nodeRadius, 0, Math.PI * 2);
        ctx.fill();
      }
      const selRadius = nodeRadius * SELECT_NODE_MULT;
      ctx.fillStyle = SELECT_COLOR;
      ctx.strokeStyle = SELECT_RING;
      ctx.lineWidth = SELECT_OUTLINE_PX / bounds.zoom;
      for (const n of net.nodes) {
        if (!nodeSel(n)) continue;
        ctx.beginPath();
        ctx.arc(n.x, n.y, selRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(n.x, n.y, selRadius, 0, Math.PI * 2);
        ctx.stroke();
      }
    },
    hitTest(p, tol) {
      // Vertices win over segments — they're the smaller, on-top target.
      const nodeR = getWidth() * NET_NODE_RADIUS_MULT + tol;
      let bestNode: { id: string; d: number } | null = null;
      for (const n of net.nodes) {
        const d = Math.hypot(p.x - n.x, p.y - n.y);
        if (d <= nodeR && (!bestNode || d < bestNode.d)) {
          bestNode = { id: n.id, d };
        }
      }
      if (bestNode) return nodeSubId(bestNode.id);

      const edgeThreshold = getWidth() / 2 + tol;
      let bestEdge: { id: string; d: number } | null = null;
      for (const e of net.edges) {
        const a = nodeIndex.get(e.from);
        const b = nodeIndex.get(e.to);
        if (!a || !b) continue;
        const d = distancePointToSegment(p, a, b);
        if (d <= edgeThreshold && (!bestEdge || d < bestEdge.d)) {
          bestEdge = { id: e.id, d };
        }
      }
      if (bestEdge) return edgeSubId(bestEdge.id);
      return null;
    },
    intersectsRect(r) {
      // Any node inside the rect → hit.
      for (const n of net.nodes) {
        if (pointInRect(n, r)) return true;
      }
      // Any edge crosses the rect → hit (catches long edges that span the rect
      // with no node inside).
      for (const e of net.edges) {
        const a = nodeIndex.get(e.from);
        const b = nodeIndex.get(e.to);
        if (!a || !b) continue;
        if (segmentIntersectsRect(a, b, r)) return true;
      }
      return false;
    }
  };
}
