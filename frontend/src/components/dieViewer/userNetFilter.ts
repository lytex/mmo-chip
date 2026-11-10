import type { MLTracePolyline } from "shared";

/**
 * P2-1: drop vectorized traces that duplicate hand-drawn nets.
 *
 * The user has already drawn nets manually; the vectorizer re-detects the
 * same buses, and materializing both copies produces duplicate / duplicated
 * annotation nets. This pure filter runs between the trace collection and
 * `buildNetsFromTraces()` and removes decoder traces that match the user's
 * hand-drawn wires:
 *
 *  1. exact overlap — a trace segment strictly crosses a hand-drawn polyline
 *     segment, or a trace centreline vertex falls inside the hand-drawn
 *     buffer `polyline ± max(width / 2, tol)`;
 *  2. whole capture — a trace lying entirely inside a vectorized outline
 *     polygon that is crossed by exactly ONE hand-drawn net is dropped too
 *     (the polygon usually belongs to that already-drawn net). If a polygon
 *     is crossed by two or more DIFFERENT hand-drawn nets the wholesale drop
 *     is skipped (it may legitimately hold several conductors); only the
 *     exact-overlap rule applies there.
 *
 * Traces that merely run past a hand-drawn wire without touching it are kept
 * untouched.
 */

/** A hand-drawn wire: part of an annotation net, in source px. */
export interface UserNetPolyline {
  /** Id of the annotation net the wire belongs to (drives rule 2's
   *  "distinct nets crossing the polygon" ambiguity check). */
  netId: string;
  /** Centreline polyline (source px). */
  points: [number, number][];
  /** Hand-drawn stroke width (source px) — the renderer's net width. */
  width: number;
}

export interface FilterUserNetsResult {
  traces: MLTracePolyline[];
  /** Number of decoder traces removed by the two rules. */
  droppedUserNets: number;
}

/** Extra slack (source px) for the hand-drawn buffer when the drawn width
 *  is thinner than this — hand-drawn polylines are centreline-ish strokes. */
export const USER_NET_DEFAULT_TOL = 4;

type Pt = [number, number];

/** Squared distance from point p to segment ab. */
function pointSegDistSq(px: number, py: number, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let u = 0;
  if (l2 > 0) u = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l2));
  const qx = a[0] + u * dx;
  const qy = a[1] + u * dy;
  const ex = px - qx;
  const ey = py - qy;
  return ex * ex + ey * ey;
}

/** Do segments ab and cd intersect? Counts proper crossings, shared
 *  interiors and collinear overlaps; a single shared endpoint (T-touch)
 *  does not count, matching the "strictly crosses" semantics. */
function segsIntersect(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const o1 = o(a, b, c);
  const o2 = o(a, b, d);
  const o3 = o(c, d, a);
  const o4 = o(c, d, b);
  if (o1 * o2 < 0 && o3 * o4 < 0) return true;
  // Endpoint-on-segment touches (incl. collinear overlap ranges): require a
  // non-degenerate overlap for collinear cases, otherwise only an exact
  // endpoint landing strictly inside the other segment counts.
  const on = (p: Pt, q: Pt, r: Pt) =>
    Math.min(p[0], r[0]) <= q[0] &&
    q[0] <= Math.max(p[0], r[0]) &&
    Math.min(p[1], r[1]) <= q[1] &&
    q[1] <= Math.max(p[1], r[1]);
  if (o1 === 0 && on(a, c, b)) return true;
  if (o2 === 0 && on(a, d, b)) return true;
  if (o3 === 0 && on(c, a, d)) return true;
  if (o4 === 0 && on(c, b, d)) return true;
  return false;
}

/** Even-odd point-in-polygon. */
function pip(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const yi = poly[i][1];
    const yj = poly[j][1];
    if (yi > p[1] !== yj > p[1]) {
      const xi = poly[i][0];
      const xj = poly[j][0];
      if (p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** Is every vertex of the trace inside the polygon? The bbox precheck
 *  already guarantees the whole polyline is within the polygon's bbox; a
 *  boundary-rider vertex failing PIP keeps the trace (conservative keep). */
function traceFullyInside(t: MLTracePolyline, poly: Pt[]): boolean {
  return t.points.every((v) => pip(v, poly));
}

function bboxOf(pts: Pt[]): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

/** Flattened hand-drawn segment with its buffer radius (rule 1 geometry). */
interface UserSeg {
  netId: string;
  a: Pt;
  b: Pt;
  r: number;
  minx: number;
  miny: number;
  maxx: number;
  maxy: number;
}

export function filterTracesByUserNets(
  traces: MLTracePolyline[],
  userNets: UserNetPolyline[],
  outlines: [number, number][][] | undefined,
  tol: number = USER_NET_DEFAULT_TOL
): FilterUserNetsResult {
  if (userNets.length === 0) return { traces, droppedUserNets: 0 };

  // Flatten hand-drawn polylines into buffered segments.
  const segs: UserSeg[] = [];
  for (const u of userNets) {
    const r = Math.max(u.width / 2, tol);
    for (let i = 0; i < u.points.length - 1; i++) {
      const a = u.points[i];
      const b = u.points[i + 1];
      segs.push({
        netId: u.netId,
        a,
        b,
        r,
        minx: Math.min(a[0], b[0]) - r,
        miny: Math.min(a[1], b[1]) - r,
        maxx: Math.max(a[0], b[0]) + r,
        maxy: Math.max(a[1], b[1]) + r
      });
    }
  }

  const dropped = new Array<boolean>(traces.length).fill(false);

  // Rule 1 — exact overlap (crossing or vertex-in-buffer).
  for (let ti = 0; ti < traces.length; ti++) {
    const t = traces[ti];
    const [tx0, ty0, tx1, ty1] = bboxOf(t.points);
    let near: UserSeg[] = [];
    for (const s of segs) {
      if (s.maxx < tx0 || s.minx > tx1 || s.maxy < ty0 || s.miny > ty1) continue;
      near.push(s);
    }
    if (near.length === 0) continue;
    let hit = false;
    check: for (let i = 0; i < t.points.length - 1 && !hit; i++) {
      const a = t.points[i];
      const b = t.points[i + 1];
      for (const s of near) {
        if (segsIntersect(a, b, s.a, s.b)) {
          hit = true;
          break check;
        }
      }
    }
    if (!hit) {
      for (const v of t.points) {
        for (const s of near) {
          const rr = s.r * s.r;
          if (
            v[0] >= s.minx &&
            v[0] <= s.maxx &&
            v[1] >= s.miny &&
            v[1] <= s.maxy &&
            pointSegDistSq(v[0], v[1], s.a, s.b) <= rr
          ) {
            hit = true;
            break;
          }
        }
        if (hit) break;
      }
    }
    dropped[ti] = hit;
  }

  // Rule 2 — trace fully inside an outline polygon crossed by exactly one
  // distinct hand-drawn net.
  if (outlines && outlines.length > 0) {
    for (const poly of outlines) {
      const [px0, py0, px1, py1] = bboxOf(poly);
      const nets = new Set<string>();
      for (const s of segs) {
        if (s.maxx < px0 || s.minx > px1 || s.maxy < py0 || s.miny > py1) continue;
        // Crosses = an endpoint inside the poly OR a strict crossing of the
        // boundary through an edge. (Both endpoints outside with a crossing
        // is caught by segsIntersect against the edge.)
        if (pip(s.a, poly) || pip(s.b, poly)) {
          nets.add(s.netId);
          continue;
        }
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          if (segsIntersect(s.a, s.b, poly[j], poly[i])) {
            nets.add(s.netId);
            break;
          }
        }
        if (nets.size > 1) break; // ambiguous — rule 2 not applicable
      }
      if (nets.size !== 1) continue;
      for (let ti = 0; ti < traces.length; ti++) {
        if (dropped[ti]) continue;
        const t = traces[ti];
        const [tx0, ty0, tx1, ty1] = bboxOf(t.points);
        if (tx0 < px0 || ty0 < py0 || tx1 > px1 || ty1 > py1) continue;
        if (traceFullyInside(t, poly)) dropped[ti] = true;
      }
    }
  }

  let count = 0;
  const kept: MLTracePolyline[] = [];
  for (let ti = 0; ti < traces.length; ti++) {
    if (dropped[ti]) count++;
    else kept.push(traces[ti]);
  }
  return { traces: kept, droppedUserNets: count };
}

/** Build the hand-drawn wire list from annotation nets (straight segments
 *  between graph nodes — chains are unnecessary: both filter rules only
 *  consume segments). `netWidth` comes from the renderer preferences so the
 *  buffer matches what the user actually sees drawn. */
export function collectUserNetPolylines(
  annotations:
    | { nets?: { id: string; name?: string; nodes: { id: string; x: number; y: number }[]; edges: { id?: string; from: string; to: string }[] }[] }
    | undefined,
  netWidth: number
): UserNetPolyline[] {
  const out: UserNetPolyline[] = [];
  for (const net of annotations?.nets ?? []) {
    const byId = new Map(net.nodes.map((n) => [n.id, n]));
    for (const e of net.edges) {
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      if (!a || !b) continue;
      out.push({ netId: net.id, points: [[a.x, a.y], [b.x, b.y]], width: netWidth });
    }
  }
  return out;
}

// ── P2-2: trace regions + blockages ─────────────────────────────────

export interface TraceRegionLike {
  kind: "rect" | "poly";
  id?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  points?: [number, number][];
}

/** Bounding box of a trace region (a polygon region culls by the bbox of
 *  its vertices — the same approximation the plan specifies for drawing). */
export function traceRegionBox(r: TraceRegionLike): { x: number; y: number; width: number; height: number } {
  if (r.kind === "rect") {
    return { x: r.x ?? 0, y: r.y ?? 0, width: r.width ?? 0, height: r.height ?? 0 };
  }
  const [x0, y0, x1, y1] = bboxOf(r.points ?? []);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function rectsIntersectBox(
  box: { x: number; y: number; width: number; height: number },
  r: { x: number; y: number; width: number; height: number }
): boolean {
  return (
    box.x + box.width >= r.x &&
    r.x + r.width >= box.x &&
    box.y + box.height >= r.y &&
    r.y + r.height >= box.y
  );
}

/** Does an axis-aligned segment pair (a→b) cross the rect's interior? An
 *  endpoint fully INSIDE is also a hit; a segment that merely skirts the
 *  edge (T-touch) is not. Cheap AABB precheck per segment. */
function segEntersRect(a: Pt, b: Pt, r: { x: number; y: number; width: number; height: number }): boolean {
  // AABB of the segment vs the rect — rejects most segments in one test.
  if (Math.max(a[0], b[0]) < r.x || Math.min(a[0], b[0]) > r.x + r.width) return false;
  if (Math.max(a[1], b[1]) < r.y || Math.min(a[1], b[1]) > r.y + r.height) return false;
  const inside = (p: Pt) =>
    p[0] > r.x && p[0] < r.x + r.width && p[1] > r.y && p[1] < r.y + r.height;
  if (inside(a) || inside(b)) return true;
  const c0: Pt = [r.x, r.y];
  const c1: Pt = [r.x + r.width, r.y];
  const c2: Pt = [r.x + r.width, r.y + r.height];
  const c3: Pt = [r.x, r.y + r.height];
  return (
    segsIntersect(a, b, c0, c1) ||
    segsIntersect(a, b, c1, c2) ||
    segsIntersect(a, b, c2, c3) ||
    segsIntersect(a, b, c3, c0)
  );
}

/**
 * Does the polyline ACTUALLY enter the rect — a vertex strictly inside, or
 * any segment crossing the interior? Bbox-only tests wrongly cull traces
 * that merely pass NEAR the rect (a diagonal trace's bbox spans it without
 * the centreline getting close) — the "blockage eats neighbouring traces"
 * bug. Bbox reject keeps the common miss case O(1) for the draw loop.
 */
export function polylineEntersRect(
  points: Pt[],
  r: { x: number; y: number; width: number; height: number }
): boolean {
  if (points.length === 0) return false;
  const [x0, y0, x1, y1] = bboxOf(points);
  if (x1 < r.x || x0 > r.x + r.width || y1 < r.y || y0 > r.y + r.height) return false;
  for (const p of points) {
    if (p[0] > r.x && p[0] < r.x + r.width && p[1] > r.y && p[1] < r.y + r.height) return true;
  }
  for (let i = 0; i < points.length - 1; i++) {
    if (segEntersRect(points[i], points[i + 1], r)) return true;
  }
  return false;
}

/** Keep only traces / outlines that touch at least ONE region, then drop
 *  everything inside a blockage (blockages win over regions — a trace in a
 *  blockage must not materialize even when the blockage sits inside a
 *  region). When no regions AND no blockages exist the input passes through
 *  unchanged — "whole die". Runs BEFORE the hand-drawn-nets filter (P2-1)
 *  in the materialize pipeline. */
export function filterTracesByRegions(
  traces: MLTracePolyline[],
  outlines: [number, number][][],
  regions: TraceRegionLike[],
  blockages: { x: number; y: number; width: number; height: number }[] = []
): {
  traces: MLTracePolyline[];
  outlines: [number, number][][];
  droppedOutsideRegion: number;
  droppedInBlockage: number;
} {
  if (regions.length === 0 && blockages.length === 0) {
    return { traces, outlines, droppedOutsideRegion: 0, droppedInBlockage: 0 };
  }
  const boxes = regions.map(traceRegionBox);
  const classify = (pts: [number, number][]): "keep" | "outside" | "blockage" => {
    if (blockages.length > 0) {
      for (const b of blockages) {
        // Precise geometry, not the bbox: a trace whose bbox merely spans a
        // blockage never entered it and must stay.
        if (polylineEntersRect(pts, b)) return "blockage";
      }
    }
    if (boxes.length > 0) {
      const [x0, y0, x1, y1] = bboxOf(pts);
      const box = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
      if (!boxes.some((r) => rectsIntersectBox(box, r))) return "outside";
    }
    return "keep";
  };
  const tracesKept: MLTracePolyline[] = [];
  let droppedInBlockage = 0;
  for (const t of traces) {
    const verdict = classify(t.points);
    if (verdict === "keep") tracesKept.push(t);
    else if (verdict === "blockage") droppedInBlockage++;
  }
  const outlinesKept = outlines.filter((o) => classify(o) === "keep");
  return {
    traces: tracesKept,
    outlines: outlinesKept,
    droppedOutsideRegion: traces.length - tracesKept.length - droppedInBlockage,
    droppedInBlockage
  };
}
