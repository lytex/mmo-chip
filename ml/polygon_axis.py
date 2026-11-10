"""Octilinear trace decoder ("polygon axis"): 0/45/90 deg-only centrelines.

The user's ask: traces must look like a human drew them — only straight
runs with turns at exactly 90/45 deg, even when the corridor edges have
noise. The image is die-aligned, so the lattice is the canvas XY.

Architecture (v2, after the pure-polygon medial-axis experiment):

  1. the proven pixel-thinning corridor graph (wire_runs._build_graph)
     provides one ordered pixel chain per corridor between junction
     clusters — robust on live dies (296 traces / 157 groups baseline);
  2. wire_runs graph phase reused AS-IS: short drop -> collinear
     pass-through dissolving -> union-find groups;
  3. every surviving chain is then L2-SNAPPED octilinearly (this module's
     _snap_chain): directions quantized to the nearest k*45 deg, runs
     projected on the quantized line, diagonal steps grid-exact
     (|dx| == |dy|), lines may float <= delta off the anchor;
  4. stitched through surviving degree-2 junctions (dissolved corners,
     ring cycles) into ONE minimal-vertex trace per run;
  5. honesty over forcing: a chain whose raw axis cannot be represented
     within delta stays RAW with `irregular: true` instead of being bent
     into a lie. Hugging criterion: a fit that decomposes into many tiny
     legs (the staircase of an actually non-octilinear line) is irregular.

delta: allowed deviation of the snapped line from the raw axis. 0 (default)
= auto = max(0.75, width_min / 2) — "a line may drift no further than up to
half the thinnest kept wire"; per-point cap never exceeds the corridor:
min(delta, distance-to-boundary - 0.5).

`oct_strict` (hard mode: rubber-band guarantee inside the eroded polygon)
is deliberately NOT here yet — see docs/VECTOR_SKELETON.md.

The pure polygon-medial-axis (Delaunay circumcenter) attempt is in git
history ("sliver web"): thin-web phantom junctions cascaded under spur
pruning; the pixel-skeleton corridor graph avoids them entirely.
"""
from __future__ import annotations

import math
from collections import defaultdict

import cv2
import numpy as np

from octiline import oct_class
import wire_runs as WR


# Signed octilinear directions for the snap walk.
_DIRS8 = ((1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1))


def _exact_end(
    anchor: tuple[int, int], d: tuple[int, int], raw: tuple[int, int]
) -> tuple[int, int]:
    """Lattice-exact step from `anchor` towards `raw` along direction `d`.

    Axial dirs -> exact integer run; diagonal dirs -> |dx| == |dy| precisely
    (the diagonal step count closest to the raw point is chosen).
    """
    ax, ay = anchor
    rx, ry = raw
    sx, sy = d
    if sx == 0:
        return (ax, ay + int(round(ry - ay)))
    if sy == 0:
        return (ax + int(round(rx - ax)), ay)
    k = int(round(((rx - ax) * sx + (ry - ay) * sy) / 2.0))
    return (ax + k * sx, ay + k * sy)


def _reach_off(
    anchor: tuple[float, float],
    d: tuple[int, int],
    path: list[tuple[int, int]],
    start: int,
    delta_px: float,
    dist: np.ndarray,
) -> tuple[int, float]:
    """Furthest index j (>= start-1) of path points within their allowed
    deviation of SOME line parallel to anchor + t*d, plus that line's
    perpendicular offset `o` (interval intersection). The fit does not have
    to pass exactly through the anchor — junction centroids sit ~1 px off
    the true spine, and forcing them through creates kinks."""
    hyp = math.hypot(d[0], d[1])
    ux, uy = d[0] / hyp, d[1] / hyp
    h2 = ux * ux + uy * uy
    ax, ay = anchor
    t_prev = 0.0
    j = start - 1
    lo = hi = None  # common perpendicular-offset interval
    for k in range(start, len(path)):
        px, py = path[k]
        t = ((px - ax) * ux + (py - ay) * uy) / h2
        if k > start and t <= t_prev + 0.25:
            break
        # signed perpendicular distance to the anchor line; the fitted
        # line's offset o must satisfy |c - o| <= cap
        c = -(px - ax) * uy + (py - ay) * ux
        dw = float(dist[py, px])
        cap = min(delta_px, max(dw - 0.5, 0.4))
        klo, khi = c - cap, c + cap
        lo = klo if lo is None else max(lo, klo)
        hi = khi if hi is None else min(hi, khi)
        if lo > hi:
            break
        t_prev = max(t_prev, t)
        j = k
    if lo is None:
        o = 0.0
    elif lo <= 0 <= hi:
        o = 0.0  # the anchor line itself is representable
    elif hi < 0:
        o = hi
    else:
        o = lo
    return j, o


def _corner_choice(
    anchor: tuple[int, int], target: tuple[int, int], ref: tuple[float, float]
) -> tuple[int, int]:
    """Knight-move corner between two lattice points: pick the one on the
    side of the anchor->target line the raw axis approached from (`ref`)."""
    ax, ay = anchor
    bx, by = target
    c1 = (bx, ay)  # horizontal first
    if (bx - ax) * (ref[1] - ay) - (by - ay) * (ref[0] - ax) < 0:
        return c1  # raw approached from the c1 side
    return (ax, by)  # vertical first


def _snap_chain(
    path: list[tuple[int, int]], delta_px: float, dist: np.ndarray
) -> tuple[list[list[int]], int]:
    """Octilinear fit of one chain. `path` starts at the exact start anchor
    and ends at the exact end anchor (junction lattice points). Returns
    (vertices EXCLUDING the start anchor, violations).

    The polyline is octilinear by construction except where the walk had to
    brute-force past a point no direction could reach (violations) — the
    caller post-checks the whole branch and flags it irregular if the fit
    is not an honest representation."""
    out: list[list[int]] = []
    anchor = path[0]
    viol = 0
    end_anchor = path[-1]
    d_prev = None
    i = 1
    n = len(path) - 1  # path[n] is the end anchor, handled after the walk
    while i < n:
        reach = {d: _reach_off(anchor, d, path, i, delta_px, dist) for d in _DIRS8}
        best_j = max(j for j, _o in reach.values())
        cands = [d for d in _DIRS8 if reach[d][0] >= best_j - 1]
        # Momentum: among near-best directions prefer continuing the
        # previous one — a jittering straight run must not zigzag.
        best_d = d_prev if d_prev in cands else max(cands, key=lambda d: reach[d][0])
        best_j, best_o = reach[best_d]
        if best_j < i + 1:
            # no direction spans even the next raw point: emit as drawn
            viol += 1
            p = path[i]
            if [int(p[0]), int(p[1])] != [int(anchor[0]), int(anchor[1])]:
                out.append([int(p[0]), int(p[1])])
            anchor = (int(p[0]), int(p[1]))
            i += 1
            continue
        if best_o == 0:
            end = _exact_end(anchor, best_d, path[best_j])
        else:
            # float the line perpendicular off the anchor by best_o: it
            # dissolves the systematic ~1 px junction/anchor offset
            hyp = math.hypot(best_d[0], best_d[1])
            ux, uy = best_d[0] / hyp, best_d[1] / hyp
            line0 = (
                int(round(anchor[0] - uy * best_o)),
                int(round(anchor[1] + ux * best_o)),
            )
            end = _exact_end(line0, best_d, path[best_j])
        if end != anchor and (not out or [end[0], end[1]] != out[-1]):
            out.append([end[0], end[1]])
        anchor = end
        d_prev = best_d
        i = best_j

    # Final leg to the end anchor: straight when aligned, else a knight
    # move (corner picked by the side the axis approached from).
    ax, ay = anchor
    bx, by = end_anchor
    if (ax, ay) != (bx, by):
        if ax == bx or ay == by or abs(bx - ax) == abs(by - ay):
            if not out or [bx, by] != out[-1]:
                out.append([bx, by])
        else:
            ref = path[max(i - 4, 0):max(i, 0)]
            r = (
                float(np.mean([p[0] for p in ref])) if ref else (ax + bx) / 2.0,
                float(np.mean([p[1] for p in ref])) if ref else (ay + by) / 2.0,
            )
            corner = _corner_choice(anchor, end_anchor, r)
            if corner != (ax, ay) and (not out or [corner[0], corner[1]] != out[-1]):
                out.append([corner[0], corner[1]])
            if not out or [bx, by] != out[-1]:
                out.append([bx, by])

    dedup: list[list[int]] = []
    for p in out:
        if not dedup or dedup[-1] != p:
            dedup.append(p)
    return dedup, viol


def _point_seg_dist(
    px: float, py: float, ax: int, ay: int, bx: int, by: int
) -> float:
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    h2 = vx * vx + vy * vy
    if h2 == 0:
        return math.hypot(wx, wy)
    t = max(0.0, min(1.0, (wx * vx + wy * vy) / h2))
    return math.hypot(px - (ax + t * vx), py - (ay + t * vy))


def _is_irregular(
    raw: list[tuple[int, int]], fit: list[list[int]], delta_px: float
) -> bool:
    """True when the raw axis is NOT honestly representable within delta:
    a third of the points drift beyond delta (+slack), or any single point
    is way off. Either way, bending the fit would forge geometry."""
    if not fit or len(fit) < 2 or not raw:
        return False
    over = 0
    worst = 0.0
    for px, py in raw:
        d = min(
            _point_seg_dist(px, py, fit[k][0], fit[k][1], fit[k + 1][0], fit[k + 1][1])
            for k in range(len(fit) - 1)
        )
        worst = max(worst, d)
        if d > delta_px + 0.25:
            over += 1
    return over >= max(3, 0.3 * len(raw)) or worst > 2.5 * delta_px + 1.0


def _smooth_interior(
    path: list[tuple[int, int]], radius: int = 2
) -> list[tuple[int, int]]:
    """Moving-average the chain interior (anchors stay exact): pixel chains
    jitter ~0.5-1 px even on clean geometry — the snap should see the drawn
    line, not thinning noise."""
    n = len(path)
    if n <= radius * 2 + 2:
        return path
    out: list[tuple[int, int]] = [path[0]]
    for i in range(1, n - 1):
        lo = max(0, i - radius)
        hi = min(n - 1, i + radius)
        w = hi - lo + 1
        sx = sum(p[0] for p in path[lo:hi + 1])
        sy = sum(p[1] for p in path[lo:hi + 1])
        out.append((int(round(sx / w)), int(round(sy / w))))
    out.append(path[-1])
    return out


def extract_polygon_axis(
    mask_prob: np.ndarray,
    threshold: float = 0.5,
    min_len: int = 14,
    delta_px: float = 0.0,
    width_map: np.ndarray | None = None,
    width_min: float = 0.0,
    width_max: float = 0.0,
    score_map: np.ndarray | None = None,
    max_traces: int = 200_000,
    progress=None,
) -> dict:
    """Octilinear (0/45/90 deg) traces of a binary metal mask.

    Same trace contract as extract_wire_runs: {"traces": [...], "stats":
    {...}} plus per-trace `irregular` and stats["irregular"].

    `progress(stage)` — optional whole-die decode progress callback
    (skeletonize / graph from the shared corridor-graph builder, then runs
    for the per-chain octilinear snap).
    """
    binary = mask_prob > threshold
    stats = {
        "kept": 0,
        "dropped_width": 0,
        "dropped_short": 0,
        "merged": 0,
        "irregular": 0,
    }
    if not binary.any():
        return {"traces": [], "stats": stats}

    mask_u8 = binary.astype(np.uint8)
    dist = cv2.distanceTransform(mask_u8, cv2.DIST_L2, 3)
    if delta_px <= 0:
        # auto delta: no further than half the thinnest kept wire
        delta_px = max(0.75, width_min / 2.0) if width_min > 0 else 0.75

    # 1. proven pixel-skeleton corridor graph (one chain per corridor)
    graph, _skel = WR._build_graph(binary, progress=progress)

    # 2. wire_runs graph phase: short drop -> collinear dissolve
    for e in graph.edges:
        if len(e.points) < min_len:
            e.removed = True
            stats["dropped_short"] += 1
    stats["merged"] = WR._merge_collinear(graph, tol_deg=30.0)
    if progress:
        progress("runs")
    # NB: positions must be captured BEFORE the merge: it deletes dissolved
    # junction nodes from graph.nodes, but their lattice points stay valid
    # trace endpoints.
    node_backup = dict(graph.nodes)

    strength = mask_prob if score_map is None else score_map

    # 3. per-chain octilinear snap (+ width filter), keeping metadata;
    #    traces are assembled in step 4 by stitching through surviving
    #    degree-2 junctions (dissolved corners, ring cycles)
    edge_meta: dict[int, dict] = {}
    for idx, e in enumerate(graph.edges):
        if e.removed:
            continue
        a_pt = node_backup.get(e.a) if e.a is not None else None
        b_pt = node_backup.get(e.b) if e.b is not None else None
        if a_pt is None and e.a is not None:
            e.removed = True
            continue

        ys = np.array([p[1] for p in e.points])
        xs = np.array([p[0] for p in e.points])
        med_w = float(np.median(width_map[ys, xs])) if width_map is not None else None
        if width_map is not None and med_w is not None:
            if (width_min > 0 and med_w < width_min) or (width_max > 0 and med_w > width_max):
                stats["dropped_width"] += 1
                e.removed = True
                continue
        sel = strength[ys, xs]
        score = float(sel.mean()) if sel.size else 0.0

        raw = [tuple(p) for p in e.points]
        is_cycle = a_pt is None and b_pt is None
        if is_cycle:
            path = list(raw) + [raw[0]]
        else:
            path = ([tuple(a_pt)] if a_pt is not None else []) + list(raw)
            if b_pt is not None and (not path or path[-1] != tuple(b_pt)):
                path = path + [tuple(b_pt)]

        if len(path) >= 2:
            fit, viol = _snap_chain(_smooth_interior(path), delta_px, dist)
            runway = ([tuple(a_pt)] if a_pt is not None else []) + fit
            if is_cycle:
                polyline = [list(raw[0])] + fit
            elif a_pt is not None:
                polyline = [[int(a_pt[0]), int(a_pt[1])]] + fit
            else:
                polyline = list(fit)
            irregular_edge = bool(
                _is_irregular([tuple(p) for p in raw], runway, delta_px)
                or viol >= 3
                or viol > 0.25 * max(1, len(raw))
            )
        else:
            polyline = [[int(p[0]), int(p[1])] for p in path]
            irregular_edge = False

        polyline = _fuse_octilinear(_dedupe_consecutive(polyline))
        if len(polyline) < 2:
            e.removed = True
            continue
        edge_meta[idx] = {
            "points": polyline,
            "score": round(score, 4),
            "width": round(med_w, 2) if med_w is not None else None,
            "irregular": irregular_edge,
            "viol": viol,
            "nraw": len(raw),
            "a": e.a,
            "b": e.b,
        }

    # 4. stitch edge polylines through surviving degree-2 junction nodes so
    #    a ring or a straight pass-through becomes ONE trace
    surviving = list(edge_meta.keys())
    deg: dict[int, int] = defaultdict(int)
    for idx in surviving:
        meta = edge_meta[idx]
        if meta["a"] is not None:
            deg[meta["a"]] += 1
        if meta["b"] is not None:
            deg[meta["b"]] += 1 if meta["a"] != meta["b"] else 2
    adj: dict[int, list[int]] = defaultdict(list)
    for idx in surviving:
        meta = edge_meta[idx]
        if meta["a"] is not None:
            adj[meta["a"]].append(idx)
        if meta["b"] is not None:
            adj[meta["b"]].append(idx)

    used_edge: set[int] = set()

    def walk_stitch(start: int | None, first_idx: int, start_node: int | None) -> dict:
        """Concatenate edge polylines through degree-2 nodes starting at
        `start` (anchor id, or None for a standalone cycle edge)."""
        used_edge.add(first_idx)
        pts: list[list[int]] = []
        scores: list[float] = []
        widths: list[float] = []
        irr: list[bool] = []
        cur = start
        k = first_idx
        while True:
            meta = edge_meta[k]
            scores.append(meta["score"])
            if meta["width"] is not None:
                widths.append(meta["width"])
            irr.append(meta["irregular"])
            a, b, p = meta["a"], meta["b"], meta["points"]
            if a is None and b is None:
                pts.extend(p)  # standalone cycle: already closed
                break
            if cur is None:
                cur = a  # step 1 of an anchored walk: begin at `a`
            if a == cur:
                far, op = b, p
            elif b == cur:
                far, op = a, list(reversed(p))
            else:
                break  # defensive: orientation lost, keep what we have
            if pts and pts[-1] == op[0]:
                pts.extend(op[1:])
            else:
                pts.extend(op)
            if far is None:
                break
            if far == start_node or deg.get(far, 0) != 2:
                break
            nxt = [j for j in adj[far] if j not in used_edge]
            if len(nxt) != 1:
                break
            used_edge.add(nxt[0])
            cur, k = far, nxt[0]
        agg = {
            "points": _dedupe_consecutive(_straighten_legs(
                _cleanup_kinks(_fuse_octilinear(_dedupe_consecutive(pts)))
            )),
            "score": round(float(np.mean(scores)), 4) if scores else 0.0,
            "width": round(float(np.mean(widths)), 2) if widths else None,
            "irregular": any(irr),
        }
        return agg

    anchor_nodes = [n for n, d in deg.items() if d != 2]

    runs: list[tuple[int, dict]] = []
    groups_all = WR._group_edges(graph)
    for a0 in anchor_nodes:
        for j in adj.get(a0, []):
            if j in used_edge:
                continue
            runs.append((groups_all.get(j, j), walk_stitch(a0, j, a0)))
    # leftover unanchored cycles (or anything the anchor walk missed)
    for idx in surviving:
        if idx in used_edge:
            continue
        meta = edge_meta[idx]
        node0 = meta["a"] if meta["a"] is not None else meta["b"]
        runs.append((groups_all.get(idx, idx), walk_stitch(None, idx, node0)))

    # 5. emit
    out: list[dict] = []
    for group, run in runs:
        if len(run["points"]) < 2:
            continue
        pts = run["points"]
        # A fit hugging a non-octilinear draw decomposes into many tiny
        # legs; a human-drawn wire has none.
        short_legs = sum(
            1 for k in range(len(pts) - 1)
            if math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]) < 4.0
        )
        nonoct_len = sum(
            math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1])
            for k in range(len(pts) - 1)
            if _leg_slant(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]) > 2.0
        )
        run["irregular"] = bool(
            run["irregular"] or short_legs >= 4
            or nonoct_len > max(3.0 * delta_px, 6.0)
        )
        t: dict = {"points": pts, "score": run["score"]}
        if run["width"] is not None:
            t["width"] = run["width"]
        if run["irregular"]:
            t["irregular"] = True
            stats["irregular"] += 1
        t["group"] = int(group)
        out.append(t)
        stats["kept"] += 1
        if len(out) >= max_traces:
            print(f"[warn] polygon axis: hit cap {max_traces} — mask is noisy")
            break
    return {"traces": out, "stats": stats}


def _dedupe_consecutive(points: list[list[int]]) -> list[list[int]]:
    out: list[list[int]] = []
    for p in points:
        if not out or out[-1] != p:
            out.append(p)
    return out


def _fuse_octilinear(points: list[list[int]]) -> list[list[int]]:
    """Drop vertices through which an octilinear polyline passes straight
    (same direction class) — a collinear pass-through junction dissolved
    between two independently snapped chains leaves a redundant vertex."""
    if len(points) < 3:
        return points
    out = [points[0]]
    for i in range(1, len(points) - 1):
        prev = out[-1]
        cur = points[i]
        nxt = points[i + 1]
        if oct_class(cur[0] - prev[0], cur[1] - prev[1]) == oct_class(
            nxt[0] - cur[0], nxt[1] - cur[1]
        ):
            continue  # line passes straight through
        out.append(cur)
    out.append(points[-1])
    return out


def _oct_unit_sgn(dx: int, dy: int) -> tuple[float, float] | None:
    """Signed octilinear unit nearest to (dx, dy); None for zero."""
    if dx == 0 and dy == 0:
        return None
    hyp = math.hypot(dx, dy)
    ux, uy = dx / hyp, dy / hyp
    from octiline import _OCT_UNIT  # noqa: PLC0415
    best: tuple[float, float] | None = None
    best_dot = -2.0
    for u in _OCT_UNIT:
        for sgn in (1.0, -1.0):
            dotv = ux * u[0] * sgn + uy * u[1] * sgn
            if dotv > best_dot:
                best_dot = dotv
                best = (u[0] * sgn, u[1] * sgn)
    return best


def _project_on_line(
    anchor: tuple[int, int], u: tuple[float, float], p: tuple[int, int]
) -> list[int]:
    t = (p[0] - anchor[0]) * u[0] + (p[1] - anchor[1]) * u[1]
    return [int(round(anchor[0] + u[0] * t)), int(round(anchor[1] + u[1] * t))]


def _leg_slant(dx: int, dy: int) -> float:
    """Perpendicular slant (px) of a leg against its nearest octilinear
    direction: |dy| for horizontal, |dx| for vertical, the half-difference
    of |dx|/|dy| (lasered into the leftover axis) for 45 deg classes."""
    cls = oct_class(dx, dy)
    if cls == -1:
        return 0.0
    if cls == 0:
        return float(abs(dy))
    if cls == 2:
        return float(abs(dx))
    return abs(abs(dx) - abs(dy)) / 1.41421


def _straighten_legs(points, max_slant: float = 4.0) -> list[list[int]]:
    """Snap a nearly-octilinear polyline to the octilinear lattice.

    Sequentially per leg: a leg whose direction deviates from an axial/"
    diagonal lattice direction by < max_slant px total slant is straightened
    onto the lattice (corner seams between independently snapped chains sit
    ~1 px askew); legs already exactly octilinear pass through untouched.
    """
    if len(points) < 3:
        return [list(p) for p in points]
    out: list[list[int]] = [list(points[0])]
    for i in range(1, len(points)):
        b = points[i]
        a = out[-1]
        dx, dy = b[0] - a[0], b[1] - a[1]
        hyp = math.hypot(dx, dy)
        if dx == 0 or dy == 0 or abs(dx) == abs(dy) or hyp < 8.0:
            out.append([int(b[0]), int(b[1])])
            continue
        sxs, sys_ = abs(dx), abs(dy)
        new: list[int] | None = None
        if min(sxs, sys_) <= max_slant and min(sxs, sys_) * 12 < max(sxs, sys_):
            # nearly axial: firm the small component onto the anchor axis
            if sxs <= sys_:
                new = [int(a[0]), int(b[1])]
            else:
                new = [int(b[0]), int(a[1])]
        elif abs(sxs - sys_) <= max_slant and min(sxs, sys_) >= 8:
            # nearly diagonal: stretch the short component to |dx| == |dy|
            k = int(round((sxs + sys_) / 2.0))
            sdx = 1 if dx > 0 else -1
            sdy = 1 if dy > 0 else -1
            new = [int(a[0]) + sdx * k, int(a[1]) + sdy * k]
        out.append(new if new is not None else [int(b[0]), int(b[1])])
    return out


def _cleanup_kinks(points: list[list[int]], short_px: float = 3.0) -> list[list[int]]:
    """Collapse clusters of <short_px fragments between two stable legs into
    one corner vertex (the intersection of the legs' snapped directions):
    stitched chains meet at a junction with independent ~1 px fits, and the
    seam must not show as a kink."""
    if len(points) < 3:
        return points
    n = len(points)
    i = 1
    while i < n - 1:
        # maximal run of short segments starting at v[i]:
        # leg-in v[i-1]->v[i], cluster vertices v[i..j-1], leg-out v[j..]
        j = i
        short = 0
        while j < n - 1 and math.dist(points[j], points[j + 1]) < short_px:
            short += 1
            j += 1
        if short == 0 or j - i > 3:
            i += 1
            continue
        if j == n - 1:
            # kink cluster at the END of the polyline: straighten it onto
            # the leg-in direction (project the far end)
            u1 = _oct_unit_sgn(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
            if u1 is None:
                i += 1
                continue
            far = _project_on_line(points[i], u1, points[j])
            points = points[:i] + [far]
            n = len(points)
            i = max(i - 1, 1)
            continue
        u1 = _oct_unit_sgn(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
        u2 = _oct_unit_sgn(points[j + 1][0] - points[j][0], points[j + 1][1] - points[j][1])
        if u1 is None or u2 is None:
            i += 1
            continue
        cross = u1[0] * u2[1] - u1[1] * u2[0]
        if abs(cross) < 1e-9:
            # same direction class: straighten the cluster onto that line
            c1 = oct_class(u1[0], u1[1])
            if c1 == 0:  # horizontal run
                corner = [points[j][0], points[i][1]]
            elif c1 == 2:  # vertical run
                corner = [points[i][0], points[j][1]]
            else:  # diagonal: closest lattice point to the line
                corner = _project_on_line(points[i], u1, points[j])
        else:
            s = (
                (points[j][0] - points[i][0]) * u2[1]
                - (points[j][1] - points[i][1]) * u2[0]
            ) / cross
            corner = [
                int(round(points[i][0] + u1[0] * s)),
                int(round(points[i][1] + u1[1] * s)),
            ]
        points = points[:i] + [corner] + points[j + 1:]
        n = len(points)
        i = max(i - 1, 1)
    return points
