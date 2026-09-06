import type { AnnotationNet } from "shared";
import {
  distancePointToSegment,
  pointInRect,
  segmentIntersectsRect,
  type Rect
} from "../../lib/geometry";
import { UNTAGGED_LAYER, type Annotation } from "../layers/AnnotationLayer";
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
  getColor: (netId: string) => string,
  /** ML mode: stroke uses the real document-space width (source px, scales
   *  with zoom like the image) and vertices are drawn flush with it (radius =
   *  half the stroke), so a net renders as the uniform-width trace the export
   *  rasterises. Default false → zoom-stable on-screen width + larger edit
   *  handles. */
  getMatchWidth: () => boolean = () => false,
  /** Optional: per-net colour override that should win over layer-based
   *  colouring. When non-null for a netId, ALL edges of that net render in
   *  this colour (ignoring WIRE_LAYER_COLOR) — this makes an overridden net
   *  visually cohesive across all metal layers. */
  getNetOverrideColor?: (netId: string) => string | null,
  /** Optional: per-conductor-layer wire colour override. Return value wins
   *  over `WIRE_LAYER_COLOR[e.layer]`. Absent / returns undefined → use
   *  the default from `WIRE_LAYER_COLOR`. */
  getLayerColor?: (layer: string) => string | undefined,
  /** Optional: node radius multiplier (relative to net width). 0 = hide
   *  junction dots entirely. Default = `NET_NODE_RADIUS_MULT`. */
  getNodeRadiusMult?: () => number,
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

  // Composite drawOrder = (min_layer + 1) * 100 + (max_layer + 1).
  // This sorts: m1-only (202) < m1+m2 (203) < m2-only (303) < m3-only (404).
  // No-layer nets get 0 (draw alongside cells/vias).
  const NET_Z: Record<string, number> = {
    poly: 0, metal1: 1, metal2: 2, metal3: 3, metal4: 4, metal5: 5, metal6: 6
  };
  let minZ = 99, maxZ = -1;
  for (const e of net.edges) {
    if (e.layer) {
      const z = NET_Z[e.layer] ?? -1;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  const drawOrder =
    maxZ >= 0 ? (minZ + 1) * 100 + (maxZ + 1) : 0;
  return {
    id: netId,
    kind: "net",
    pickPriority: PICK.net,
    drawOrder,
    bbox,
    draw(ctx, bounds, state) {
      // ML mode: the stroke is the real document-space width (source px), so
      // it scales with the image like the export footprint. Otherwise it's a
      // zoom-stable on-screen width (clamped, then back to world units).
      const mlMode = getMatchWidth();
      const screenWidth = netScreenWidth(bounds.zoom, getWidth());
      const worldWidth = mlMode ? getWidth() : screenWidth / bounds.zoom;
      const baseColor = getColor(netId);
      const whole = state.selected;
      const edgeSel = (e: AnnotationNet["edges"][number]) =>
        whole || state.isSelected(edgeSubId(e.id));
      const nodeSel = (n: AnnotationNet["nodes"][number]) =>
        whole || state.isSelected(nodeSubId(n.id));

      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      // Unselected edges: one batched path per colour. When a per-net colour
      // override is active for this net, ALL edges use it (overriding the
      // layer-based colours) so the net reads as one cohesive trace across
      // metal layers. Otherwise use the per-layer colour, falling back to the
      // configurable base colour for edges without a known layer.
      // When the AnnotationLayer does multi-pass z-ordering, `layerFilter`
      // restricts which edges to draw in the current pass.
      const netOverrideColor = getNetOverrideColor?.(netId);
      const byColor = new Map<string, AnnotationNet["edges"]>();
      for (const e of net.edges) {
        if (edgeSel(e)) continue;
        if (state.layerFilter === UNTAGGED_LAYER) {
          if (e.layer) continue;
        } else if (state.layerFilter && e.layer !== state.layerFilter) continue;
        const layerCol = e.layer && (getLayerColor?.(e.layer) ?? WIRE_LAYER_COLOR[e.layer]);
        const col = netOverrideColor ?? layerCol ?? baseColor;
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

      // Selected edges draw on top of everything in SELECT_COLOR.
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
      // stroke — so junctions don't bulge. Otherwise the bigger edit handle,
      // scaled by the user-configurable node radius multiplier.
      const nodeMult = getNodeRadiusMult?.() ?? NET_NODE_RADIUS_MULT;
      const showNodes = nodeMult > 0;
      const nodeRadius = mlMode
        ? worldWidth / 2
        : (screenWidth * nodeMult) / bounds.zoom;
      // Node colour: use highest-layer connected edge's colour so dots on
      // metal1 turns match teal, dots on metal2 turn violet, etc.
      const nodeColor = new Map<string, string>();
      for (const n of net.nodes) {
        let bestLayer: string | undefined;
        let bestP = -1;
        const NET_P: Record<string, number> = {
          poly: 0, metal1: 1, metal2: 2, metal3: 3, metal4: 4, metal5: 5, metal6: 6
        };
        for (const e of net.edges) {
          if (e.from !== n.id && e.to !== n.id) continue;
          if (e.layer && (NET_P[e.layer] ?? -1) > bestP) {
            bestP = NET_P[e.layer];
            bestLayer = e.layer;
          }
        }
        if (bestLayer) {
          const layerCol = getLayerColor?.(bestLayer) ?? WIRE_LAYER_COLOR[bestLayer];
          nodeColor.set(n.id, netOverrideColor ?? layerCol ?? baseColor);
        } else {
          nodeColor.set(n.id, baseColor);
        }
      }

      if (showNodes) {
        for (const n of net.nodes) {
          if (nodeSel(n)) continue;
          ctx.fillStyle = nodeColor.get(n.id) ?? baseColor;
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
      }
    },
    hitTest(p, tol) {
      // Vertices win over segments — they're the smaller, on-top target.
      const nodeMult = getNodeRadiusMult?.() ?? NET_NODE_RADIUS_MULT;
      const nodeR = getWidth() * nodeMult + tol;
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
