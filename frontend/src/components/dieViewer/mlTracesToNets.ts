import type { AnnotationNet, AnnotationNetEdge, AnnotationNetNode, MLTracePolyline, WireLayer } from "shared";
import { uuid } from "../../lib/uuid";

/**
 * Materialize ML trace centrelines into real annotation nets.
 *
 * v2 skeleton decode emits one polyline per metal branch with meaningful
 * endpoint coordinates. This module:
 *   1. snaps each polyline end to the nearest device contact / cell
 *      terminal / IO pin (the wire tool's snap targets) — the snapped
 *      coordinate becomes the endpoint, so the wire actually connects;
 *   2. unions branches that share an endpoint (snapped to the same contact
 *      or decoded onto the same junction) into one electrical net;
 *   3. builds one AnnotationNet per group as a node-edge graph (vertices in
 *      polyline order, edges between consecutive vertices), edge layer
 *      stamped so SPICE/RE metadata sees the conductor.
 *
 * Pure functions — the caller dispatches the resulting `upsertNet` batch
 * through the annotation dispatcher (undoable, persisted).
 */

/** A wire-tool-style snap candidate (device contact / terminal / IO pin). */
export interface TraceSnapTarget {
  x: number;
  y: number;
  label: string;
}

export interface TracesToNetsInput {
  /** Deduplicated trace polylines (layer.collectTraces()). */
  traces: MLTracePolyline[];
  /** Metal outline contours (layer.collectOutlines()) — the authoritative
   *  "is this contact ON the metal" test: a contact point INSIDE a closed
   *  contour is on the metal even where the centreline+width proxy misses
   *  (wide pads, corners, width-estimate drift). Absent → skipped. */
  outlines?: [number, number][][];
  /** Drop traces scoring below this (the trace-confidence slider value). */
  minScore: number;
  /** Max length (source px) of a contact→wire branch edge. 0 = off. Caps
   *  the outline-membership connections (a contact inside a big pad with
   *  no nearby centreline would otherwise tie to a far wire). */
  maxBranchLen?: number;
  snapTargets: TraceSnapTarget[];
  /** Snap tolerance in world (source-px) units. */
  snapTol: number;
  /** Gap-bridging tolerance: decode fragments whose ends nearly touch are
   *  stitched into one connected wire (both ends pulled to the shared
   *  point). In world (source-px) units. */
  stitchTol: number;
  /** Conductor layer stamped on every created edge. */
  layer: WireLayer;
  /** Net naming: `<prefix>1`, `<prefix>2`, … */
  namePrefix?: string;
  /** A net must touch at least this many DISTINCT device contacts (pins /
   *  electrodes / terminals) to be materialized. 0 = off. 2 filters
   *  floating artifacts: only wires joining two real contacts survive. */
  minDeviceContacts?: number;
  /** Drop octilinear-decoder traces kept raw with `irregular: true`
   *  (the raw axis could not be snapped within delta) instead of
   *  materializing their non-octilinear geometry. */
  dropIrregular?: boolean;
}

export interface TracesToNetsResult {
  nets: AnnotationNet[];
  /** How many polyline ends actually landed on a snap target. */
  snappedEnds: number;
  /** Traces dropped for having fewer than 2 vertices. */
  droppedDegenerate: number;
  /** Traces dropped by the score filter (`minScore`) — distinct from
   *  degenerate drops so the UI can say WHY nothing was materialized. */
  filteredByScore: number;
  /** How many fragment pairs were stitched into shared points. */
  stitchedPairs: number;
  /** Nets dropped by the min-device-contacts filter. */
  droppedLowContacts: number;
  /** Traces dropped by the drop-irregular filter. */
  droppedIrregular: number;
  /** Contacts connected via the outline-membership test (phase 1c) —
   *  inside a metal contour but beyond the centreline+width reach. */
  outlineConnected: number;
  /** Contacts INSIDE a metal contour whose nearest wire vertex/edge is
   *  LONGER than maxBranchLen — the snap dropped per the phase-1c budget
   *  spec (no chord across the pad; the contact stays unattached). */
  outlineDropped: number;
  /** Twin-raIL traces dropped by the outlines-based double-centreline
   *  dedupe (same metal contour, ~parallel, overlapping spans). */
  droppedTwins: number;
  /** Suspicious merges: a "group" union holding hundreds of traces usually
   *  means the MASK over-bridged wires (band too wide / Min gap too high) —
   *  the netlist is technically connected but is not what the user drew. */
  warnings: string[];
}

/** Endpoint merge key: snapped ends land on identical coordinates; decoded
 *  junction ends agree within ~2 px, so quantize to a 2 px grid. */
function endpointKey(x: number, y: number): string {
  return `${Math.round(x / 2)}:${Math.round(y / 2)}`;
}

/** Branch-attach geometry: WHERE a contact's branch leaves the wire.
 *  Normally AT THE PROJECTION (the nearest point on the polyline — a
 *  collinear split, a T-junction; the wire never bends). Only when the
 *  projection sits essentially ON a trace END vertex (< 1 px along the
 *  segment) does the branch leave from that end vertex without a split.
 *  HISTORY: this used to be index-thresholded (`at < 0.5` = "at the start",
 *  `at > len-1-0.5` = "at the end"). For runs-decoder fragments — long
 *  straight 2-POINT polylines — EVERY contact fell past the threshold, so
 *  the branch left from vertex 0 or 1, up to HALF A SEGMENT away from the
 *  projection: electrically the same net, visually attached at some far
 *  wrong vertex instead of the nearest point. */
const BRANCH_ATTACH_EPS = 1;

function branchAt(pts: [number, number][], at: number): { end?: 0 | 1; at: number } {
  const i = Math.min(Math.floor(at), pts.length - 2);
  const u = at - i;
  const segLen = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  const dStart = u * segLen;
  const dEnd = (1 - u) * segLen;
  if (dStart <= BRANCH_ATTACH_EPS) {
    // Projection sits on vertex i: branch from it as-is. For an interior
    // vertex push an integer `at` — the realize pass' near-integer check
    // branches from the existing vertex without a split.
    if (i === 0) return { end: 0, at };
    return { at: i };
  }
  if (dEnd <= BRANCH_ATTACH_EPS) {
    if (i + 1 === pts.length - 1) return { end: 1, at };
    return { at: i + 1 };
  }
  return { at };
}

/** Axis-aligned bbox of a polyline — cheap reject before point-in-polygon. */
function pointsBoxOf(points: [number, number][]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

export function buildNetsFromTraces(input: TracesToNetsInput): TracesToNetsResult {
  const {
    traces,
    minScore,
    snapTargets,
    snapTol,
    stitchTol,
    layer,
    namePrefix = "ML-",
    minDeviceContacts = 0,
    dropIrregular = false,
    maxBranchLen = 0
  } = input;

  // 1. Snap every polyline end to the nearest target (first hit wins by
  //    distance, matching the wire tool's nearest-candidate behaviour).
  let snappedEnds = 0;
  let droppedDegenerate = 0;
  let filteredByScore = 0;
  let droppedIrregular = 0;
  interface SnappedTrace {
    points: [number, number][];
    score: number;
    onContact: [boolean, boolean];
    /** Contact BRANCHES (отростки): a separate edge polyline-vertex →
     *  contact. The wire polyline itself is NEVER bent to reach a contact —
     *  mid-wire contacts split a segment COLLINEARLY at the projection
     *  point and branch from there, so the geometry stays honest. */
    branches: { vertex: number; label: string; x: number; y: number }[];
  }
  /** Point-in-polygon (even-odd ray cast) — closed-contour membership. */
  const pointInPolygon = (x: number, y: number, poly: [number, number][]): boolean => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const yi = poly[i][1];
      const yj = poly[j][1];
      if (yi > y !== yj > y) {
        const xi = poly[i][0];
        const xj = poly[j][0];
        if (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
    return inside;
  };
  /** Strict segment crossing (orientation test) — a wire can cross a pad
   *  without any of its VERTICES inside the pad. */
  const segCross = (
    ax: number, ay: number, bx: number, by: number,
    cx: number, cy: number, dx: number, dy: number
  ): boolean => {
    const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
    const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
    const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  };
  /** Every target label that gets a connection in phases 1a/1b/1c — 1c only
   *  rescues contacts nothing else connected. */
  const snappedLabels = new Set<string>();
  // Branch-length cap (the "contact → nearest wire" отросток length). The
  // proximity phases (1a/1b) already reach only effTol, so the cap shrinks
  // them only if set smaller; the outline-membership phase (1c) is where it
  // really bites — a contact inside a big pad whose own centreline was
  // width-filtered away would otherwise tie to a far wire with a long
  // straight line. 0 = off.
  const branchLenOk = (d: number, base: number): boolean =>
    d <= base && (maxBranchLen <= 0 || d <= maxBranchLen);
  interface PendingTrace {
    points: [number, number][];
    score: number;
    /** Runs-decoder connectivity group — переносим из входного trace,
     *  чтобы group-union ниже читал его у ВЫЖИВШИХ трасс (pending/snapped
     *  1:1), а не по сместившемуся индексу сырого массива. */
    group?: number;
    /** Deferred mid-wire contact splits (splice from the end AFTER phase
     *  1c, so 1c's projection indices stay valid against the original
     *  points). The split inserts the PROJECTION point — collinear, the
     *  wire does not bend; the branch edge continues to the contact. */
    insertions: { at: number; target: TraceSnapTarget }[];
    /** Contacts nearest a polyline END: branch off the end vertex, the
     *  wire keeps its shape (no more last-edge yanked to the contact). */
    endBranches: { end: 0 | 1; target: TraceSnapTarget }[];
  }
  // 1.2. TWIN-RAIL dedupe (needs outlines): a fat / double-ridged bus
  //      decodes as TWO ~parallel centreline rails INSIDE ONE metal contour
  //      (live-data offsets 9..40 px, near-equal spans; block seams of the
  //      whole-die sweep re-decode a wire the same way). Both rails sit in
  //      the SAME conductor — one of them is the phantom "net running past
  //      the bus" the user reported, duplicated by the correct in-metal
  //      trace. Keep the LONGER rail, drop the other. Real neighbouring
  //      wires never match: their contour polygons differ (a gap between
  //      conductors), so the shared-contour requirement protects them —
  //      an over-bridged mask merges real neighbours into one contour, but
  //      they are electrically one blob there anyway.
  const outlines = input.outlines ?? [];
  const droppedTwins = new Set<number>();
  if (outlines.length > 0) {
    const MIN_TWIN_LEN = 64;
    const TWIN_ANGLE_COS = 0.9988; // 0.05 rad ≈ 2.9°
    const TWIN_OFFSET_MAX = 60;
    interface LongTrace { idx: number; pts: [number, number][]; len: number; dx: number; dy: number }
    const lake: LongTrace[] = [];
    for (let i = 0; i < traces.length; i++) {
      const pts = traces[i].points;
      if (pts.length < 2) continue;
      const dx = pts[pts.length - 1][0] - pts[0][0];
      const dy = pts[pts.length - 1][1] - pts[0][1];
      const len = Math.hypot(dx, dy);
      if (len < MIN_TWIN_LEN) continue;
      lake.push({ idx: i, pts, len, dx: dx / len, dy: dy / len });
    }
    // Contour membership (any vertex inside) — lazy per trace, cached.
    const outlineBoxes = outlines.map((o) => pointsBoxOf(o));
    const contourCache = new Map<number, Set<number>>();
    const contoursOf = (idx: number, trace: MLTracePolyline): Set<number> => {
      const cached = contourCache.get(idx);
      if (cached) return cached;
      const hits = new Set<number>();
      for (const [x, y] of trace.points) {
        for (let oi = 0; oi < outlines.length; oi++) {
          const b = outlineBoxes[oi];
          if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY) continue;
          if (pointInPolygon(x, y, outlines[oi])) hits.add(oi);
        }
      }
      contourCache.set(idx, hits);
      return hits;
    };
    for (let a = 0; a < lake.length; a++) {
      const A = lake[a];
      for (let b = a + 1; b < lake.length; b++) {
        const B = lake[b];
        if (droppedTwins.has(A.idx) && droppedTwins.has(B.idx)) continue;
        const cosT = A.dx * B.dx + A.dy * B.dy;
        if (cosT < TWIN_ANGLE_COS && cosT > -TWIN_ANGLE_COS) continue;
        const longer = A.len >= B.len ? A : B;
        const shorter = longer === A ? B : A;
        // Perpendicular offset of the shorter rail's midpoint from the
        // longer rail's line:
        const mx = shorter.pts[0][0] + (shorter.pts[shorter.pts.length - 1][0] - shorter.pts[0][0]) / 2;
        const my = shorter.pts[0][1] + (shorter.pts[shorter.pts.length - 1][1] - shorter.pts[0][1]) / 2;
        const vmx = longer.pts[0][0] + (longer.pts[longer.pts.length - 1][0] - longer.pts[0][0]) / 2;
        const vmy = longer.pts[0][1] + (longer.pts[longer.pts.length - 1][1] - longer.pts[0][1]) / 2;
        const along = (mx - vmx) * longer.dx + (my - vmy) * longer.dy;
        if (Math.abs(along) > 0.5 * Math.max(A.len, B.len)) continue;
        const off = Math.abs(-(mx - vmx) * longer.dy + (my - vmy) * longer.dx);
        if (off > TWIN_OFFSET_MAX) continue;
        // Same conductor: at least ONE contour that contains BOTH rails.
        const ca = contoursOf(A.idx, traces[A.idx]);
        const cb = contoursOf(B.idx, traces[B.idx]);
        let shared = false;
        for (const oi of ca) if (cb.has(oi)) { shared = true; break; }
        if (!shared) continue;
        // Drop the SHORTER (the second on ties — seam re-decodes agree).
        droppedTwins.add(shorter.idx);
      }
    }
  }

  const pending: PendingTrace[] = [];
  for (let traceIndex = 0; traceIndex < traces.length; traceIndex++) {
    const t = traces[traceIndex];
    if (droppedTwins.has(traceIndex)) continue;
    if (dropIrregular && t.irregular === true) {
      droppedIrregular += 1;
      continue;
    }
    if ((t.score ?? 1) < minScore) {
      filteredByScore += 1;
      continue;
    }
    if (t.points.length < 2) {
      droppedDegenerate += 1;
      continue;
    }
    const pts = t.points.map((p) => [p[0], p[1]] as [number, number]);
    // Width-aware tolerance: the snap measures CONTACT POINT to CENTRELINE
    // distance, but the user's mental model is "the contact overlaps the
    // metal polygon". The centreline sits widthPx/2 away from the metal
    // edge, so a contact centre anywhere inside the metal band is up to
    // widthPx/2 off the axis — include that in the tolerance. Without this,
    // contacts on wide wires/pads visibly intersecting the metal did not
    // connect (fixed 8..12 px lost to half the wire width).
    const effTol = snapTol + (t.widthPx ?? 0) / 2;
    const effCap = maxBranchLen > 0 ? Math.min(effTol, maxBranchLen) : effTol;
    const insertions: { at: number; target: TraceSnapTarget }[] = [];
    const endBranches: { end: 0 | 1; target: TraceSnapTarget }[] = [];
    // 1a. Endpoints: the contact nearest a polyline END becomes a BRANCH
    //     off that end vertex. The endpoint itself is NOT moved onto the
    //     contact any more — yanking the last edge toward the contact broke
    //     the wire shape (the reported "ломает последний edge"); the
    //     отросток edge carries the connection instead.
    for (const end of [0, pts.length - 1] as const) {
      let best: TraceSnapTarget | null = null;
      let bestD = effCap;
      for (const s of snapTargets) {
        const d = Math.hypot(s.x - pts[end][0], s.y - pts[end][1]);
        if (d <= bestD) {
          bestD = d;
          best = s;
        }
      }
      if (best) {
        endBranches.push({ end: end === 0 ? 0 : 1, target: best });
        snappedLabels.add(best.label);
      }
    }
    // 1b. Mid-wire contacts (INTERSECTION snap): a device contact within
    //     tolerance of a SEGMENT splits the polyline at the projection
    //     point — a COLLINEAR split, the wire stays straight — and a branch
    //     edge runs from that wire point to the contact (отросток).
    for (const s of snapTargets) {
      if (snappedLabels.has(s.label)) continue;
      let bestD = effCap;
      let bestAt = -1;
      for (let i = 0; i < pts.length - 1; i++) {
        const ax = pts[i][0];
        const ay = pts[i][1];
        const bx = pts[i + 1][0];
        const by = pts[i + 1][1];
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        const u =
          len2 === 0
            ? 0
            : Math.max(0, Math.min(1, ((s.x - ax) * dx + (s.y - ay) * dy) / len2));
        const px = ax + u * dx;
        const py = ay + u * dy;
        const d = Math.hypot(s.x - px, s.y - py);
        if (d <= bestD) {
          bestD = d;
          bestAt = i + u;
        }
      }
      if (bestAt >= 0) {
        // Branch leaves AT the nearest point on the wire (collinear split);
        // the trace end vertex only when the projection sits essentially on
        // it — never "half a long segment away" (see branchAt history).
        const ba = branchAt(pts, bestAt);
        if (ba.end !== undefined) {
          endBranches.push({ end: ba.end, target: s });
        } else {
          insertions.push({ at: ba.at, target: s });
        }
        snappedLabels.add(s.label);
      }
    }
    pending.push({ points: pts, score: t.score ?? 1, insertions, endBranches, group: t.group });
  }

  // 1c. CONTACT-IN-METAL connect (the authoritative "on metal" test) —
  //     USER SPEC: a contact INSIDE the decoded vectorized metal gets ONE
  //     branch along the SHORTEST path to a wire VERTEX or EDGE of its net,
  //     and only when that distance is NOT greater than maxBranchLen —
  //     otherwise the snap is DROPPED (never a long chord across the pad).
  //     Two candidate tiers, the globally nearest wins:
  //       A. traces lying in the SAME contour(s) as the contact (a vertex
  //          inside, or a segment strictly crossing the edge) — nearest
  //          point on the wire (branchAt: split AT the projection, an end
  //          vertex only when the projection sits essentially on it).
  //       B. (maxBranchLen > 0 only) any trace whose END VERTEX is near
  //          the contact, contour-independent — the decoded wire that
  //          ALMOST reached the contact (its centreline stops short at the
  //          width filter or a min-gap the mask did not merge) attaches
  //          from its end instead of a far same-contour wire. The budget
  //          is the feature's knob — a foreign wire ends within it too,
  //          but only when it is strictly closer than everything on the
  //          contact's own metal.
  let outlineConnected = 0;
  let outlineDropped = 0;
  if (outlines.length > 0) {
    const outlineBoxes = outlines.map((o) => pointsBoxOf(o));
    for (const s of snapTargets) {
      if (snappedLabels.has(s.label)) continue;
      // Which metal contours contain the contact point (bbox prefilter).
      const hit = new Set<number>();
      for (let oi = 0; oi < outlines.length; oi++) {
        const b = outlineBoxes[oi];
        if (s.x < b.minX || s.x > b.maxX || s.y < b.minY || s.y > b.maxY) continue;
        if (pointInPolygon(s.x, s.y, outlines[oi])) hit.add(oi);
      }
      if (hit.size === 0) continue;
      // Traces lying in those contours: a vertex inside, or a segment
      // strictly crossing the contour edge (a long straight wire crosses a
      // pad without any vertex inside it).
      let bestTrace = -1;
      let bestD = Infinity;
      let bestAt = -1;
      for (let ti = 0; ti < pending.length; ti++) {
        const pts = pending[ti].points;
        let inSameContour = false;
        for (const p of pts) {
          for (const oi of hit) {
            const b = outlineBoxes[oi];
            if (p[0] < b.minX || p[0] > b.maxX || p[1] < b.minY || p[1] > b.maxY) continue;
            if (pointInPolygon(p[0], p[1], outlines[oi])) {
              inSameContour = true;
              break;
            }
          }
          if (inSameContour) break;
        }
        if (!inSameContour) {
          outer: for (let i = 0; i < pts.length - 1; i++) {
            for (const oi of hit) {
              const poly = outlines[oi];
              const b = outlineBoxes[oi];
              // Cheap reject: the segment must reach the outline bbox.
              if (
                Math.max(pts[i][0], pts[i + 1][0]) < b.minX ||
                Math.min(pts[i][0], pts[i + 1][0]) > b.maxX ||
                Math.max(pts[i][1], pts[i + 1][1]) < b.minY ||
                Math.min(pts[i][1], pts[i + 1][1]) > b.maxY
              )
                continue;
              for (let k = 0, j = poly.length - 1; k < poly.length; j = k++) {
                if (
                  segCross(
                    pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1],
                    poly[j][0], poly[j][1], poly[k][0], poly[k][1]
                  )
                ) {
                  inSameContour = true;
                  break outer;
                }
              }
            }
          }
        }
        if (!inSameContour) continue;
        for (let i = 0; i < pts.length - 1; i++) {
          const ax = pts[i][0];
          const ay = pts[i][1];
          const bx = pts[i + 1][0];
          const by = pts[i + 1][1];
          const dx = bx - ax;
          const dy = by - ay;
          const len2 = dx * dx + dy * dy;
          const u =
            len2 === 0
              ? 0
              : Math.max(0, Math.min(1, ((s.x - ax) * dx + (s.y - ay) * dy) / len2));
          const px = ax + u * dx;
          const py = ay + u * dy;
          const d = Math.hypot(s.x - px, s.y - py);
          if (d < bestD) {
            bestD = d;
            bestTrace = ti;
            bestAt = i + u;
          }
        }
      }
      // Tier B: the wire that ALMOST reached the contact — nearest trace
      // END vertex over ALL traces, contour-independent. Only when the
      // budget is on (0 = the old outline-only behaviour).
      let endTrace = -1;
      let endD = Infinity;
      let endWhich = -1;
      if (maxBranchLen > 0) {
        for (let ti = 0; ti < pending.length; ti++) {
          const pts = pending[ti].points;
          for (const end of [0, pts.length - 1] as const) {
            const d = Math.hypot(s.x - pts[end][0], s.y - pts[end][1]);
            if (d < endD) {
              endD = d;
              endTrace = ti;
              endWhich = end === 0 ? 0 : 1;
            }
          }
        }
      }
      // Winner: the globally nearest tier (ties → tier A, the contact's
      // own metal). Longer than maxBranchLen ⇒ DROP the snap (user spec):
      // the contact stays unattached rather than drawing a chord neither
      // it nor the wire explains.
      if (bestTrace < 0 && endTrace < 0) continue;
      const useProj =
        bestTrace >= 0 && (endTrace < 0 || bestD <= endD);
      const winD = useProj ? bestD : endD;
      if (maxBranchLen > 0 && winD > maxBranchLen) {
        outlineDropped += 1;
        continue;
      }
      if (useProj) {
        // Branch AT the projection (the nearest point on the wire — the
        // T-junction the user asked for); the trace end vertex only when
        // the projection sits essentially on it (branchAt, 1 px eps).
        const ba = branchAt(pending[bestTrace].points, bestAt);
        if (ba.end !== undefined) {
          pending[bestTrace].endBranches.push({ end: ba.end, target: s });
        } else {
          pending[bestTrace].insertions.push({ at: ba.at, target: s });
        }
      } else {
        pending[endTrace].endBranches.push({ end: endWhich === 0 ? 0 : 1, target: s });
      }
      snappedLabels.add(s.label);
      outlineConnected += 1;
    }
  }

  const snapped: SnappedTrace[] = [];
  // Realize every deferred connection: collinear mid-wire splits first
  // (desc so earlier indices stay valid), then end-vertex branches.
  for (const p of pending) {
    const branches: SnappedTrace["branches"] = [];
    p.insertions.sort((a, b) => b.at - a.at);
    // Pristine polyline: earlier (higher-at) splices shift `p.points`, so the
    // interpolation anchors for later splits MUST come from the original
    // array — otherwise a split lands at a biased position (the collinear
    // parametrization u is meant against the ORIGINAL vertices). The splice
    // index itself still goes against `p.points`, with branches above the
    // shift bumped below.
    const orig = p.points.slice();
    for (const ins of p.insertions) {
      // Insert the PROJECTION point (on the segment — collinear split, the
      // wire geometry does not bend) and branch from it to the contact.
      const near = Math.abs(ins.at - Math.round(ins.at)) < 0.01;
      if (near) {
        // Projection lands on an existing vertex — no split needed.
        branches.push({
          vertex: Math.round(ins.at),
          label: ins.target.label,
          x: ins.target.x,
          y: ins.target.y
        });
        continue;
      }
      const idx = Math.ceil(ins.at);
      const seg = Math.min(Math.floor(ins.at), orig.length - 2);
      const u = ins.at - seg;
      const ax = orig[seg][0];
      const ay = orig[seg][1];
      const bx = orig[seg + 1][0];
      const by = orig[seg + 1][1];
      p.points.splice(idx, 0, [ax + u * (bx - ax), ay + u * (by - ay)]);
      // Multiple contacts can split the SAME segment with EQUAL ceil(at):
      // each later splice at the same idx shifts the earlier branch's point
      // one slot right — bump every already-recorded vertex accordingly, or
      // the branch ends up attached at the OTHER contact's split point (the
      // reported "phantom rail chord to the contact": a worst case drew a
      // 230 px branch where the cap was 23 px). The wire points themselves
      // stay honest — collinear inserts use pristine anchors.
      for (const br of branches) {
        if (br.vertex >= idx) br.vertex += 1;
      }
      branches.push({
        vertex: idx,
        label: ins.target.label,
        x: ins.target.x,
        y: ins.target.y
      });
    }
    for (const eb of p.endBranches) {
      branches.push({
        vertex: eb.end === 0 ? 0 : p.points.length - 1,
        label: eb.target.label,
        x: eb.target.x,
        y: eb.target.y
      });
    }
    snappedEnds += branches.length;
    snapped.push({
      points: p.points,
      score: p.score,
      onContact: [false, false],
      branches
    });
  }

  // 1.5 Stitch decode fragments: endpoints that nearly touch are merged and
  //     pulled to a shared point (the contact end wins — it preserves the
  //     real connection — otherwise the midpoint), so the wire is physically
  //     continuous instead of "segments with gaps".
  let stitchedPairs = 0;
  interface EndRef { trace: number; end: 0 | 1; x: number; y: number; onContact: boolean }
  const ends: EndRef[] = [];
  snapped.forEach((t, i) => {
    ends.push({ trace: i, end: 0, x: t.points[0][0], y: t.points[0][1], onContact: t.onContact[0] });
    ends.push({ trace: i, end: 1, x: t.points[t.points.length - 1][0], y: t.points[t.points.length - 1][1], onContact: t.onContact[1] });
  });
  for (let a = 0; a < ends.length; a++) {
    for (let b = a + 1; b < ends.length; b++) {
      const ea = ends[a];
      const eb = ends[b];
      if (ea.trace === eb.trace) continue;
      const d = Math.hypot(ea.x - eb.x, ea.y - eb.y);
      if (d > stitchTol) continue;
      const shared: [number, number] = ea.onContact
        ? [ea.x, ea.y]
        : eb.onContact
          ? [eb.x, eb.y]
          : [(ea.x + eb.x) / 2, (ea.y + eb.y) / 2];
      snapped[ea.trace].points[ea.end === 0 ? 0 : snapped[ea.trace].points.length - 1] = shared;
      snapped[eb.trace].points[eb.end === 0 ? 0 : snapped[eb.trace].points.length - 1] = shared;
      ea.x = shared[0];
      ea.y = shared[1];
      eb.x = shared[0];
      eb.y = shared[1];
      ea.onContact = ea.onContact || eb.onContact;
      eb.onContact = ea.onContact;
      stitchedPairs += 1;
    }
  }

  // 2. Union branches whose endpoints coincide (same contact / junction).
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let root = k;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = k;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  const endsByKey = new Map<string, number[]>();
  snapped.forEach((t, i) => {
    const k = `t${i}`;
    parent.set(k, k);
    for (const end of [t.points[0], t.points[t.points.length - 1]]) {
      const ek = endpointKey(end[0], end[1]);
      const list = endsByKey.get(ek);
      if (list) {
        for (const other of list) union(k, `t${other}`);
        list.push(i);
      } else {
        endsByKey.set(ek, [i]);
      }
    }
  });

  // 1.6 Runs-decoder grouping: traces sharing a `group` belong to ONE
  //     physical wire / closed contour (the decoder already dissolved noise
  //     junctions) — union them even when no endpoints coincide.
  //     `pending`/`snapped` are 1:1 (survivors of the score/degenerate/
  //     irregular filters); reading `group` off the RAW `traces` array by
  //     the same index was wrong whenever any trace was filtered out —
  //     unions then hit FOREIGN groups and glued unrelated wires into one
  //     net.
  const groupIds = new Map<number, string>();
  snapped.forEach((_, i) => {
    const g = pending[i].group;
    if (typeof g !== "number") return;
    const key = `g${g}`;
    const prev = groupIds.get(g);
    if (prev) union(prev, `t${i}`);
    else groupIds.set(g, `t${i}`);
  });

  // 1.7 Traces branching to the SAME contact are electrically one net (the
  //     contact IS the connection point; endpoints no longer move onto it,
  //     so the coordinate-based union below can't see this any more).
  const tracesByLabel = new Map<string, number[]>();
  snapped.forEach((t, i) => {
    for (const b of t.branches) {
      const list = tracesByLabel.get(b.label);
      if (list) list.push(i);
      else tracesByLabel.set(b.label, [i]);
    }
  });
  for (const list of tracesByLabel.values()) {
    for (let j = 1; j < list.length; j++) union(`t${list[0]}`, `t${list[j]}`);
  }

  // 3. One net per group: collect vertices (endpoint-key merged so shared
  //    ends become a single node — that is the electrical connection).
  const groups = new Map<string, number[]>();
  snapped.forEach((_, i) => {
    const root = find(`t${i}`);
    const list = groups.get(root);
    if (list) list.push(i);
    else groups.set(root, [i]);
  });

  const nets: AnnotationNet[] = [];
  const warnings: string[] = [];
  const GROUP_WARN_TRACES = 64;
  let droppedLowContacts = 0;
  let n = 0;
  for (const members of groups.values()) {
    n += 1;
    if (members.length > GROUP_WARN_TRACES) {
      warnings.push(
        `net with ${members.length} traces merged by decoder group — the mask likely ` +
          "over-bridged neighbouring wires (threshold band too wide / Min gap too high). " +
          "Check the outlines; narrow the band or lower Min gap and re-decode."
      );
    }
    // Distinct device contacts this net touches (branch connections across
    // every member trace).
    const labels = new Set<string>();
    for (const i of members) {
      for (const b of snapped[i].branches) labels.add(b.label);
    }
    if (minDeviceContacts > 0 && labels.size < minDeviceContacts) {
      droppedLowContacts += 1;
      continue;
    }
    const nodes: AnnotationNetNode[] = [];
    const nodeByKey = new Map<string, AnnotationNetNode>();
    const edges: AnnotationNetEdge[] = [];
    const nodeAt = (x: number, y: number): AnnotationNetNode => {
      const key = endpointKey(x, y);
      const existing = nodeByKey.get(key);
      if (existing) return existing;
      const node: AnnotationNetNode = { id: uuid(), x, y };
      nodeByKey.set(key, node);
      nodes.push(node);
      return node;
    };
    for (const i of members) {
      const s = snapped[i];
      for (let j = 0; j < s.points.length - 1; j++) {
        const a = nodeAt(s.points[j][0], s.points[j][1]);
        const b = nodeAt(s.points[j + 1][0], s.points[j + 1][1]);
        if (a.id === b.id) continue;
        edges.push({ id: uuid(), from: a.id, to: b.id, layer });
      }
      // Contact branches (отростки): one edge from the wire vertex the
      // branch leaves (a collinear split point or an end vertex) to the
      // contact node. Same label → same node, so traces meeting at one
      // contact are connected through it.
      for (const b of s.branches) {
        const from = nodeAt(s.points[b.vertex][0], s.points[b.vertex][1]);
        const contact = nodeAt(b.x, b.y);
        if (from.id === contact.id) continue;
        edges.push({ id: uuid(), from: from.id, to: contact.id, layer });
      }
    }
    nets.push({
      id: uuid(),
      name: `${namePrefix}${n}`,
      nodes,
      edges
    });
  }

  return {
    nets,
    snappedEnds,
    droppedDegenerate,
    filteredByScore,
    stitchedPairs,
    droppedLowContacts,
    droppedIrregular,
    outlineConnected,
    outlineDropped,
    droppedTwins: droppedTwins.size,
    warnings
  };
}
