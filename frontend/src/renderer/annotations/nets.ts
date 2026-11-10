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
  contrastColor,
  netNodeWorldRadius,
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
  /** Optional: junction-only drawing mode. When it returns true, a dot is
   *  drawn only where the net graph actually branches — vertices whose degree
   *  is 1 (a dangling wire end) or ≥ 3 (a real junction). Plain bends
   *  (degree 2) get no dot, matching the "dots only at connections" look of a
   *  hand-drawn schematic. When false, a dot is drawn on EVERY vertex (legacy
   *  behaviour). Drawing only — vertices stay grabbable in both modes.
   *  Default: false. */
  getJunctionsOnly?: () => boolean,
  /** Optional: returns true when (x, y) is a connection point to an analog
   *  device electrode **on this net**. In junction-only mode such a mid-net
   *  vertex (graph degree 2) is still drawn — it is a real connection even
   *  though the net graph does not branch there. */
  getConnectionPoint?: (netId: string, x: number, y: number) => boolean,
  /** Optional: when it returns false, junction dots (degree ≥ 3) are drawn
   *  without the contrasting cross. Default: true. */
  getJunctionCross?: () => boolean,
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

  const LAYER_PRIORITY: Record<string, number> = {
    poly: 0, metal1: 1, metal2: 2, metal3: 3, metal4: 4, metal5: 5, metal6: 6
  };

  // ── Per-net spatial grid (nodes + edges) ────────────────────────────
  // Vectorized nets are DIE-WIDE: thousands of edges, bbox covers the whole
  // die. The previous full scans therefore paid O(net size) for EVERY cursor
  // move (hitTest broad phase always matched the net bbox) and O(net size ×
  // overlapping tiles × 8 layer passes) per frame — the "vectorized nets →
  // sluggish canvas & UI" regression (hand-drawn nets never felt it because
  // their bbox is small). Bucketing keeps every query local.
  type EdgeHit = {
    e: AnnotationNet["edges"][number];
    a: { x: number; y: number };
    b: { x: number; y: number };
  };
  const GRID_MIN_CELL = 48;
  const GRID_MAX_CELL = 384;
  const gridCell = Math.max(
    GRID_MIN_CELL,
    Math.min(
      GRID_MAX_CELL,
      // Adaptive cell side: small nets (few edges over a small area) need a
      // coarse grid (few cells); meganets get enough buckets to stay local.
      Math.sqrt(Math.max(bbox.width, 1) * Math.max(bbox.height, 1) / Math.max(net.edges.length, 1))
    )
  );
  const gridKey = (gx: number, gy: number) => `${gx}|${gy}`;
  const nodeGrid = new Map<string, AnnotationNet["nodes"][number][]>();
  const edgeGrid = new Map<string, EdgeHit[]>();
  /** Edges whose axis-aligned cell span would duplicate them across too many
   *  buckets (long jumpers) — kept in one short always-tested list instead. */
  const longEdges: EdgeHit[] = [];
  {
    const push = <V,>(m: Map<string, V[]>, key: string, v: V) => {
      const list = m.get(key);
      if (list) list.push(v);
      else m.set(key, [v]);
    };
    for (const n of net.nodes) {
      push(
        nodeGrid,
        gridKey(Math.floor(n.x / gridCell), Math.floor(n.y / gridCell)),
        n
      );
    }
    for (const e of net.edges) {
      const a = nodeIndex.get(e.from);
      const b = nodeIndex.get(e.to);
      if (!a || !b) continue;
      const hit: EdgeHit = { e, a, b };
      const gx0 = Math.floor(Math.min(a.x, b.x) / gridCell);
      const gy0 = Math.floor(Math.min(a.y, b.y) / gridCell);
      const gx1 = Math.floor(Math.max(a.x, b.x) / gridCell);
      const gy1 = Math.floor(Math.max(a.y, b.y) / gridCell);
      if ((gx1 - gx0 + 1) * (gy1 - gy0 + 1) <= 64) {
        for (let gy = gy0; gy <= gy1; gy += 1) {
          for (let gx = gx0; gx <= gx1; gx += 1) {
            push(edgeGrid, gridKey(gx, gy), hit);
          }
        }
      } else {
        longEdges.push(hit);
      }
    }
  }
  /** Dedupe tickets: an edge/node belongs to many buckets; each query stamps
   *  the items it already visited so they process exactly once. */
  let queryTicket = 0;
  const nodeStamp = new Map<string, number>();
  const edgeStamp = new Map<string, number>();
  const forNodesInRect = (
    r: { x: number; y: number; width: number; height: number },
    fn: (n: AnnotationNet["nodes"][number]) => void
  ): void => {
    queryTicket += 1;
    const gx0 = Math.floor(r.x / gridCell);
    const gy0 = Math.floor(r.y / gridCell);
    const gx1 = Math.floor((r.x + r.width) / gridCell);
    const gy1 = Math.floor((r.y + r.height) / gridCell);
    for (let gy = gy0; gy <= gy1; gy += 1) {
      for (let gx = gx0; gx <= gx1; gx += 1) {
        const bucket = nodeGrid.get(gridKey(gx, gy));
        if (!bucket) continue;
        for (const n of bucket) {
          if (nodeStamp.get(n.id) === queryTicket) continue;
          nodeStamp.set(n.id, queryTicket);
          fn(n);
        }
      }
    }
  };
  const forEdgesInRect = (
    r: { x: number; y: number; width: number; height: number },
    fn: (h: EdgeHit) => void
  ): void => {
    queryTicket += 1;
    const gx0 = Math.floor(r.x / gridCell);
    const gy0 = Math.floor(r.y / gridCell);
    const gx1 = Math.floor((r.x + r.width) / gridCell);
    const gy1 = Math.floor((r.y + r.height) / gridCell);
    for (let gy = gy0; gy <= gy1; gy += 1) {
      for (let gx = gx0; gx <= gx1; gx += 1) {
        const bucket = edgeGrid.get(gridKey(gx, gy));
        if (!bucket) continue;
        for (const h of bucket) {
          if (edgeStamp.get(h.e.id) === queryTicket) continue;
          edgeStamp.set(h.e.id, queryTicket);
          fn(h);
        }
      }
    }
    // Long edges are not bucketed — they are always candidates, and the list
    // itself holds each of them once.
    for (const h of longEdges) fn(h);
  };

  // Highest-priority edge layer per node (O(1) lookups at draw time). Built
  // once — the previous per-node scan over ALL edges inside `draw` was
  // O(nodes × edges) per tile per frame, the dominant freeze of the
  // vectorized-net world (thousands of nodes ⟶ millions per tile ⟶ billions
  // per repaint).
  const nodeBestLayer = new Map<string, string | undefined>();
  for (const n of net.nodes) nodeBestLayer.set(n.id, undefined);
  for (const e of net.edges) {
    if (!e.layer) continue;
    const pr = LAYER_PRIORITY[e.layer] ?? -1;
    if (pr < 0) continue;
    const a = nodeBestLayer.get(e.from);
    if (a === undefined || (LAYER_PRIORITY[a] ?? -1) < pr) nodeBestLayer.set(e.from, e.layer);
    const b = nodeBestLayer.get(e.to);
    if (b === undefined || (LAYER_PRIORITY[b] ?? -1) < pr) nodeBestLayer.set(e.to, e.layer);
  }
  // Graph degree per node (junction dots / crosses) — pure graph property,
  // rebuilt once per annotation instead of once per tile per frame.
  const nodeDegree = new Map<string, number>();
  for (const e of net.edges) {
    nodeDegree.set(e.from, (nodeDegree.get(e.from) ?? 0) + 1);
    nodeDegree.set(e.to, (nodeDegree.get(e.to) ?? 0) + 1);
  }
  // Conductor layers this net actually has edges on (UNTAGGED counts as a
  // "layer"). The AnnotationLayer replays EVERY net in EVERY conductor pass;
  // a net without edges on the current pass used to be queried cell by cell
  // just to skip every candidate — now the whole pass is skipped outright.
  const layersPresent = new Set<string>();
  for (const e of net.edges) layersPresent.add(e.layer ?? UNTAGGED_LAYER);


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
  // Radius the node discs were last painted at (world units). Cached so
  // hit-testing matches the on-screen disc; see `draw`.
  let lastNodeWorldRadius = 0;
  // Node ids whose dot was actually painted on the last draw. Only these get
  // the enlarged (dot-sized) grab area; vertices filtered out by the
  // junction-only mode keep just the small click slop.
  let lastVisibleNodes: Set<string> = new Set();
  return {
    id: netId,
    kind: "net",
    pickPriority: PICK.net,
    drawOrder,
    bbox,
    draw(ctx, bounds, state) {
      // Pass split (the AnnotationLayer drives all of these):
      //   - state.pass === undefined && state.layerFilter set → a conductor
      //     pass: paint ONLY the net's unselected edges (filtered by layer).
      //   - state.pass === "select" → paint ONLY selected parts (runs once,
      //     after all conductor passes; opaque SELECT_COLOR means the same
      //     raster as the old repaint-in-every-pass selection).
      //   - state.pass === "dots" → paint ONLY node dots (runs once,
      //     after the select pass).
      // A state with a pass but none of the above (via body/label) → nothing.
      // A state with NO pass and NO layerFilter (direct callers, tests) keeps
      // the legacy everything-at-once draw.
      const isDotPass = state.pass === "dots";
      const isSelectPass = state.pass === "select";
      const isEdgePass = state.pass === undefined; // conductor pass or legacy
      const isLegacyDraw = isEdgePass && !state.layerFilter;
      if (!isDotPass && !isSelectPass && !isEdgePass) return;

      // ML mode: the stroke is the real document-space width (source px), so
      // it scales with the image like the export footprint. Otherwise it's a
      // zoom-stable on-screen width (clamped, then back to world units).
      const mlMode = getMatchWidth();
      const screenWidth = netScreenWidth(bounds.zoom, getWidth());
      const worldWidth = mlMode ? getWidth() : screenWidth / bounds.zoom;
      const baseColor = getColor(netId);
      const whole = state.selected;
      // selectedEmpty short-circuit: with nothing selected anywhere the
      // membership test is pointless work per candidate.
      const edgeSel = (e: AnnotationNet["edges"][number]) =>
        whole || (state.selectedEmpty ? false : state.isSelected(edgeSubId(e.id)));
      const nodeSel = (n: AnnotationNet["nodes"][number]) =>
        whole || (state.selectedEmpty ? false : state.isSelected(nodeSubId(n.id)));

      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      // A conductor pass whose layer this net has no edges on ends before any
      // query — its only content there would be painting nothing. Selected
      // parts no longer paint inside these passes at all (they have the
      // dedicated "select" pass), so this skip no longer needs to care about
      // the selection state — it used to disable ALL pass skips while
      // anything was selected, silently re-multiplying the frame cost.
      const passSkipsEdges =
        !!state.layerFilter &&
        state.layerFilter !== UNTAGGED_LAYER &&
        !layersPresent.has(state.layerFilter);

      const nodeMult = getNodeRadiusMult?.() ?? NET_NODE_RADIUS_MULT;
      const showNodes = nodeMult > 0;
      const nodeRadius = netNodeWorldRadius(
        bounds.zoom,
        getWidth(),
        nodeMult,
        mlMode
      );

      // Cull rect: the tile's world rect grown by everything a net may paint
      // past an edge's endpoints (stroke half-widths incl. the wider
      // selection stroke, selected node discs and their rings). Without this,
      // a DIE-WIDE vectorized net used to be stroked IN FULL into EVERY
      // overlapping tile × every layer pass — the "vectorize → lagging
      // canvas" regression. Culling is per edge, so only what's visible is
      // actually stroked.
      const pad =
        (worldWidth * SELECT_WIDTH_MULT) / 2 +
        nodeRadius * SELECT_NODE_MULT +
        SELECT_OUTLINE_PX / bounds.zoom +
        1;
      // Tests (and any caller constructing partial bounds) may omit the world
      // rect — fall back to the whole net's extent, i.e. the pre-grid draw
      // behaviour.
      const worldRect = bounds.world ?? {
        x: bbox.x - pad - 1,
        y: bbox.y - pad - 1,
        width: bbox.width + (pad + 1) * 2,
        height: bbox.height + (pad + 1) * 2
      };
      const cull = {
        x: worldRect.x - pad,
        y: worldRect.y - pad,
        width: worldRect.width + pad * 2,
        height: worldRect.height + pad * 2
      };

      // Unselected edges: one batched path per colour. When a per-net colour
      // override is active for this net, ALL edges use it (overriding the
      // layer-based colours) so the net reads as one cohesive trace across
      // metal layers. Otherwise use the per-layer colour, falling back to the
      // configurable base colour for edges without a known layer.
      // When the AnnotationLayer does multi-pass z-ordering, `layerFilter`
      // restricts which edges to draw in the current pass.
      const netOverrideColor = getNetOverrideColor?.(netId);
      const byColor = new Map<string, EdgeHit[]>();
      if (isEdgePass && !passSkipsEdges) {
        forEdgesInRect(cull, (h) => {
          const e = h.e;
          if (edgeSel(e)) return; // drawn in the selection pass below
          if (state.layerFilter === UNTAGGED_LAYER) {
            if (e.layer) return;
          } else if (state.layerFilter && e.layer !== state.layerFilter) return;
          const layerCol = e.layer && (getLayerColor?.(e.layer) ?? WIRE_LAYER_COLOR[e.layer]);
          const col = netOverrideColor ?? layerCol ?? baseColor;
          const list = byColor.get(col);
          if (list) list.push(h);
          else byColor.set(col, [h]);
        });
      }
      ctx.lineWidth = worldWidth;
      for (const [col, hs] of byColor) {
        ctx.strokeStyle = col;
        ctx.beginPath();
        for (const h of hs) {
          ctx.moveTo(h.a.x, h.a.y);
          ctx.lineTo(h.b.x, h.b.y);
        }
        ctx.stroke();
      }

      // Selected edges draw on top of everything in SELECT_COLOR — in their
      // dedicated "select" pass (or a legacy bare draw). The whole net
      // selected → all edges (one pass over the edge array, no queries).
      // Otherwise the query is candidate-scoped like the unselected pass.
      const selectedHits: EdgeHit[] = [];
      if ((isSelectPass || isLegacyDraw) && whole) {
        for (const e of net.edges) {
          const a = nodeIndex.get(e.from);
          const b = nodeIndex.get(e.to);
          if (a && b) selectedHits.push({ e, a, b });
        }
      } else if ((isSelectPass || isLegacyDraw) && !state.selectedEmpty) {
        forEdgesInRect(cull, (h) => {
          if (state.isSelected(edgeSubId(h.e.id))) selectedHits.push(h);
        });
      }
      if ((isSelectPass || isLegacyDraw) && selectedHits.length > 0) {
        ctx.strokeStyle = SELECT_COLOR;
        ctx.lineWidth = worldWidth * SELECT_WIDTH_MULT;
        ctx.beginPath();
        for (const h of selectedHits) {
          ctx.moveTo(h.a.x, h.a.y);
          ctx.lineTo(h.b.x, h.b.y);
        }
        ctx.stroke();
      }

      // Nodes: fill unselected, then larger fill + white ring for selected on
      // top (the ring pops against dark imagery).
      // ML mode: a vertex is just the wire's rounded join — radius = half the
      // stroke — so junctions don't bulge. Otherwise the bigger edit handle,
      // scaled by the user-configurable node radius multiplier.
      const junctionsOnly = getJunctionsOnly?.() ?? false;
      const junctionCross = getJunctionCross?.() ?? true;
      const nodeWantsDot = (id: string) => {
        if (!junctionsOnly) return true; // legacy: every vertex
        const d = nodeDegree.get(id) ?? 0;
        if (d === 1 || d >= 3) return true;
        // A mid-net vertex (degree 2) that is a device-electrode connection
        // point on THIS net is a real connection, so it must still be shown
        // even though the net graph does not branch there.
        if (getConnectionPoint) {
          const n = nodeIndex.get(id);
          if (n && getConnectionPoint(net.id, n.x, n.y)) return true;
        }
        return false;
      };

      // Remember the radius the dots are actually painted at so hit-testing
      // can match the visible disc (it is screen-clamped, so it differs from
      // the raw width × multiplier at extreme zooms).
      lastNodeWorldRadius = showNodes ? nodeRadius : 0;
      const visibleNodes = new Set<string>();

      // Dots paint ONLY in their dedicated pass (or a legacy bare draw).
      // Conductor passes used to repaint them identically — the grid query +
      // batching ran ×8 per tile per frame even after the dots pass existed,
      // because conductor passes carry `pass === undefined` too (they're
      // distinguished by having a `layerFilter`).
      if (showNodes && (isDotPass || isLegacyDraw)) {
        // Node colour follows the highest-priority connected edge's layer (
        // metal1 dots teal, metal2 violet, …) — the per-node best layer is
        // precomputed at build time. Dots batch by colour: N× (beginPath +
        // arc + fill) collapses into one path with N arc subpaths + ONE fill
        // per colour (moveTo before each arc prevents connecting chords);
        // junction crosses likewise become subpaths of one stroke per colour.
        type DotBatch = { dots: AnnotationNet["nodes"]; crosses: AnnotationNet["nodes"] };
        const batches = new Map<string, DotBatch>();
        const selNodes: AnnotationNet["nodes"] = [];
        const nailBatch = (col: string): DotBatch => {
          let b = batches.get(col);
          if (!b) {
            b = { dots: [], crosses: [] };
            batches.set(col, b);
          }
          return b;
        };
        forNodesInRect(cull, (n) => {
          if (nodeSel(n)) {
            selNodes.push(n);
            visibleNodes.add(n.id);
            return;
          }
          if (!nodeWantsDot(n.id)) return;
          visibleNodes.add(n.id);
          const bestLayer = nodeBestLayer.get(n.id);
          const layerCol = bestLayer && (getLayerColor?.(bestLayer) ?? WIRE_LAYER_COLOR[bestLayer]);
          const dotColor = netOverrideColor ?? layerCol ?? baseColor;
          const b = nailBatch(dotColor);
          b.dots.push(n);
          // A junction (several segments of this net meet here) gets a
          // contrasting cross inside the dot, so it reads differently from a
          // dangling end or a plain cell contact.
          if (junctionCross && (nodeDegree.get(n.id) ?? 0) >= 3) b.crosses.push(n);
        });
        for (const [col, b] of batches) {
          if (b.dots.length > 0) {
            ctx.fillStyle = col;
            ctx.beginPath();
            for (const n of b.dots) {
              ctx.moveTo(n.x + nodeRadius, n.y);
              ctx.arc(n.x, n.y, nodeRadius, 0, Math.PI * 2);
            }
            ctx.fill();
          }
          if (b.crosses.length > 0) {
            ctx.strokeStyle = contrastColor(col);
            ctx.lineWidth = Math.max(nodeRadius * 0.3, 1.5 / bounds.zoom);
            ctx.beginPath();
            const h = nodeRadius * 0.62;
            for (const n of b.crosses) {
              ctx.moveTo(n.x - h, n.y - h);
              ctx.lineTo(n.x + h, n.y + h);
              ctx.moveTo(n.x + h, n.y - h);
              ctx.lineTo(n.x - h, n.y + h);
            }
            ctx.stroke();
          }
        }
        const selRadius = nodeRadius * SELECT_NODE_MULT;
        if (selNodes.length > 0) {
          ctx.fillStyle = SELECT_COLOR;
          ctx.beginPath();
          for (const n of selNodes) {
            ctx.moveTo(n.x + selRadius, n.y);
            ctx.arc(n.x, n.y, selRadius, 0, Math.PI * 2);
          }
          ctx.fill();
          ctx.strokeStyle = SELECT_RING;
          ctx.lineWidth = SELECT_OUTLINE_PX / bounds.zoom;
          ctx.beginPath();
          for (const n of selNodes) {
            ctx.moveTo(n.x + selRadius, n.y);
            ctx.arc(n.x, n.y, selRadius, 0, Math.PI * 2);
          }
          ctx.stroke();
        }
      }
      lastVisibleNodes = visibleNodes;
    },
    hitTest(p, tol) {
      // Vertices win over segments — they're the smaller, on-top target. Only
      // a vertex whose dot was actually painted gets the enlarged (dot-sized)
      // grab area; a filtered-out vertex keeps just the small click slop.
      // Grid-scoped: the die-wide vectorized net bbox always contains the
      // cursor, so a full scan paid O(net size) per mousemove — this was the
      // "vectorized nets → sluggish UI" regression.
      // Boxed because TS narrows closure-assigned locals to `null` and then
      // flags every read below as `never`.
      const best = {
        node: null as { id: string; d: number } | null,
        edge: null as { id: string; d: number } | null
      };
      // Candidate rect must cover the LARGEST grab radius a painted dot uses
      // (unpainted vertices keep only the click slop, filtered per node).
      const nodeR = lastNodeWorldRadius + tol;
      forNodesInRect(
        {
          x: p.x - nodeR,
          y: p.y - nodeR,
          width: nodeR * 2,
          height: nodeR * 2
        },
        (n) => {
          const r = (lastVisibleNodes.has(n.id) ? lastNodeWorldRadius : 0) + tol;
          const d = Math.hypot(p.x - n.x, p.y - n.y);
          if (d <= r && (!best.node || d < best.node.d)) {
            best.node = { id: n.id, d };
          }
        }
      );
      if (best.node) return nodeSubId(best.node.id);

      const edgeThreshold = getWidth() / 2 + tol;
      forEdgesInRect(
        {
          x: p.x - edgeThreshold,
          y: p.y - edgeThreshold,
          width: edgeThreshold * 2,
          height: edgeThreshold * 2
        },
        (h) => {
          const d = distancePointToSegment(p, h.a, h.b);
          if (d <= edgeThreshold && (!best.edge || d < best.edge.d)) {
            best.edge = { id: h.e.id, d };
          }
        }
      );
      if (best.edge) return edgeSubId(best.edge.id);
      return null;
    },
    intersectsRect(r) {
      // Any node inside the rect → hit.
      let hit = false;
      forNodesInRect(r, (n) => {
        if (!hit && pointInRect(n, r)) hit = true;
      });
      if (hit) return true;
      // Any edge crosses the rect → hit (catches long edges that span the rect
      // with no node inside).
      forEdgesInRect(r, (h) => {
        if (!hit && segmentIntersectsRect(h.a, h.b, r)) hit = true;
      });
      return hit;
    },
    rectPickParts(r, fullyContained) {
      const picked: string[] = [];
      forEdgesInRect(r, (h) => {
        const hit = fullyContained
          ? pointInRect(h.a, r) && pointInRect(h.b, r)
          : segmentIntersectsRect(h.a, h.b, r);
        if (hit) picked.push(edgeSubId(h.e.id));
      });
      return picked;
    }
  };
}
