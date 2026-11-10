"""Robust wire-centreline extraction ("runs") for the vectorize path.

The plain skeleton decoder (heatmap.extract_trace_skeleton) walks degree-2
corridors between junction clusters as-is — noise inside an otherwise clean
metal mask creates spurious junctions that cut one physical wire into
several traces, and every skeleton wiggle becomes a vertex. This module
decodes the same skeleton but post-processes the branch graph the way a
chip drawing is actually drawn:

  1. spur pruning — dead-end arms shorter than `spur_px` (noise stubs) are
     removed and their junction dissolves, so one physical wire stops
     splitting into fragments;
  2. collinear merge — a junction with exactly two incident branches whose
     directions align (the line passes straight through) dissolves; real
     corners (~90°/45°) and true T/X junctions stay;
  3. straight-run simplification — each branch is Douglas-Peucker'd and
     consecutive segments turning less than `turn_tol_deg` are fused, so a
     trace is a minimal-vertex polyline: straight orthogonal / diagonal
     runs with vertices only at real turns;
  4. grouping — connected components of the SURVIVING branch graph (after
     the width filter) become `group` ids: one group = one net candidate,
     because a closed metal contour cannot contain two nets — that would be
     a virtual break.

Works on the mask the vectorize path already builds, so live viewport
decodes and whole-die sweeps produce identical geometry for the same pixels.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import cv2
import numpy as np

@dataclass
class _Edge:
    """One corridor path between two node clusters (or a detached cycle).

    `points` are ordered (x, y) corridor pixels from the `a` end toward the
    `b` end. `a`/`b` are node-cluster ids, or None for a cycle with no node
    at that end. A loop edge has a == b (attached to the same node twice).
    """
    a: int | None
    b: int | None
    points: list[tuple[int, int]]
    removed: bool = False


@dataclass
class _Graph:
    nodes: dict[int, tuple[int, int]]                 # id -> (x, y)
    edges: list[_Edge] = field(default_factory=list)

    def degree(self, node: int) -> int:
        d = 0
        for e in self.edges:
            if e.removed:
                continue
            if e.a == node:
                d += 1
            if e.b == node and e.a != e.b:
                d += 1
            elif e.b == node and e.a == e.b:
                d += 2
        return d


def _build_graph(binary: np.ndarray, progress=None) -> tuple[_Graph, np.ndarray]:
    """skeletonize + cluster junction/end pixels + one edge per corridor.

    The corridor ordering is VECTORIZED: flat-index lookup maps and a
    precomputed 8-neighbour matrix (in the original walk's offset order)
    replaced the old per-pixel python set walk, which ground for tens of
    minutes on die-sized masks (the whole-die decode spent 20+ minutes
    inside "graph" — this stage). Output contract is unchanged: identical
    component enumeration, start-point choice, tie-break directions and
    node attachments, so traces are bit-identical for the same mask.

    `progress(stage)` — optional coarse-stage callback for the whole-die
    decode progress bar (skeletonize is the minutes-long stage)."""
    from scipy.ndimage import center_of_mass, label as scipy_label
    from skimage.morphology import skeletonize

    if progress:
        progress("skeletonize")
    skel = skeletonize(binary).astype(np.uint8)
    if progress:
        progress("graph")
    h, w = skel.shape
    padded = np.pad(skel, 1, mode="constant")
    neighbours = np.zeros((h, w), dtype=np.uint8)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dy != 0 or dx != 0:
                neighbours += padded[1 + dy:1 + dy + h, 1 + dx:1 + dx + w]

    node_mask = skel.astype(bool) & ((neighbours >= 3) | (neighbours == 1))
    node_labels, n_nodes = scipy_label(node_mask)
    nodes: dict[int, tuple[int, int]] = {}
    if n_nodes:
        coms = center_of_mass(node_mask, node_labels, range(1, n_nodes + 1))
        for lab, (cy, cx) in enumerate(coms, start=1):
            nodes[lab] = (int(round(cx)), int(round(cy)))

    # Corridor components (8-connected label): between junction clusters each
    # component is a simple path; a node-free ring is one closed component.
    corridors = skel.astype(bool) & ~node_mask
    cor_labels, n_cor = scipy_label(
        corridors.astype(np.uint8), structure=np.ones((3, 3), dtype=np.uint8)
    )
    graph = _Graph(nodes=nodes)
    if n_cor == 0:
        return graph, skel

    # ── Vectorized corridor index ────────────────────────────────────
    # Corridor pixels (flat row-major, like np.nonzero per label produced),
    # grouped per component label in the SAME row-major order the original
    # per-label np.nonzero yielded (it decided each walk's start pixel).
    cor_flat = cor_labels.ravel()
    nz_flat = np.flatnonzero(cor_flat)         # corridor pixels, ascending
    labs_all = cor_flat[nz_flat]
    by_lab = np.argsort(labs_all, kind="stable")
    rows_by_lab = by_lab                        # rows of the grouped array
    grouped_flat = nz_flat[by_lab]              # flat idx, grouped by label
    grouped_lab = labs_all[by_lab]
    n = grouped_flat.size
    lab_edges = np.searchsorted(
        grouped_lab, np.arange(1, n_cor + 2), side="left"
    )
    # Global flat idx -> row in the grouped arrays (for neighbour lookup).
    sorted_by_flat = np.argsort(grouped_flat)
    flat_sorted = grouped_flat[sorted_by_flat]  # ascending flat idx

    # Offsets in the EXACT order the original walk scanned neighbours
    # (dy -1..1 x dx -1..1) — tie-breaks must stay identical.
    offsets = [(dy, dx) for dy in (-1, 0, 1) for dx in (-1, 0, 1) if dx or dy]

    ys_all = grouped_flat // w
    xs_all = grouped_flat % w
    nbrs = np.full((n, 8), -1, dtype=np.int32)
    node_nbrs = np.zeros((n, 8), dtype=np.int32)
    node_lab_flat = node_labels.ravel()
    for j, (dy, dx) in enumerate(offsets):
        ny = ys_all + dy
        nx = xs_all + dx
        valid = (ny >= 0) & (ny < h) & (nx >= 0) & (nx < w)
        nf = np.clip(ny, 0, h - 1) * w + np.clip(nx, 0, w - 1)
        pos = np.searchsorted(flat_sorted, nf).clip(max=n - 1)
        hit = valid & (flat_sorted[pos] == nf)
        row = np.where(hit, sorted_by_flat[pos], -1)
        same = hit & (grouped_lab[np.maximum(row, 0)] == grouped_lab)
        nbrs[:, j] = np.where(same, row, -1)
        node_nbrs[:, j] = np.where(
            valid, np.maximum(node_lab_flat[nf], 0), 0
        )

    # First junction label adjacent to each pixel (offset order — the
    # original end_node() returned the first nonzero scan hit).
    first_node = np.full(n, 0, dtype=np.int32)
    any_node_rows = np.nonzero((node_nbrs > 0).any(axis=1))[0]
    if any_node_rows.size:
        j0 = np.argmax(node_nbrs[any_node_rows] > 0, axis=1)
        first_node[any_node_rows] = node_nbrs[any_node_rows, j0]

    seen = np.zeros(n, dtype=bool)
    for lab in range(1, n_cor + 1):
        s, e = lab_edges[lab - 1], lab_edges[lab]
        if e == s:
            continue
        # Start pixel: first (row-major) pixel with exactly one in-component
        # neighbour — an endpoint; a node-free ring starts at its first px.
        local = nbrs[s:e]
        cnt = (local >= 0).sum(axis=1)
        end_rows = np.nonzero(cnt == 1)[0]
        cur = s + (int(end_rows[0]) if end_rows.size else 0)
        ordered: list[int] = [cur]
        seen[cur] = True
        while True:
            row = nbrs[cur]
            nxt = -1
            for j in range(8):
                q = row[j]
                if q >= 0 and not seen[q]:
                    nxt = int(q)
                    break
            if nxt < 0:
                break
            ordered.append(nxt)
            seen[nxt] = True
            cur = nxt
        seen[np.asarray(ordered, dtype=np.int64)] = False
        flat_pts = grouped_flat[np.asarray(ordered, dtype=np.int64)]
        pts = [(int(f % w), int(f // w)) for f in flat_pts]
        a = int(first_node[ordered[0]])
        b = int(first_node[ordered[-1]])
        graph.edges.append(_Edge(
            a=a if a > 0 else None, b=b if b > 0 else None, points=pts
        ))
    return graph, skel


def _incident(graph: _Graph, node: int) -> list[tuple[_Edge, bool]]:
    """(edge, at_start) pairs for every surviving edge end at `node`.
    at_start=True when the edge's `a` end is the node; a loop edge yields
    (edge, True) and (edge, False)."""
    out: list[tuple[_Edge, bool]] = []
    for e in graph.edges:
        if e.removed:
            continue
        if e.a == node:
            out.append((e, True))
        if e.b == node:
            out.append((e, False))
    return out


def _other(e: _Edge, at_start: bool) -> int | None:
    return e.b if at_start else e.a


def _prune_spurs(graph: _Graph, spur_px: int) -> int:
    """(Superseded by the graph-phase min_len drop in extract_wire_runs —
    kept for reference/debugging.) Iteratively drop dead-end arms shorter
    than spur_px; removing one may expose another, hence the loop."""
    removed = 0
    changed = True
    while changed:
        changed = False
        for e in list(graph.edges):
            if e.removed:
                continue
            ends = [(e.a, True), (e.b, False)]
            for node, _at_start in ends:
                if node is None:
                    continue
                if graph.degree(node) != 1:
                    continue
                if len(e.points) < spur_px:
                    e.removed = True
                    removed += 1
                    changed = True
                    break
    return removed


def _edge_dir_at(graph: _Graph, e: _Edge, at_start: bool) -> tuple[float, float] | None:
    """Unit direction of travel INTO the edge's far end when walking from the
    `at_start` end (i.e. the direction of the last/first few pixels)."""
    pts = e.points if at_start else list(reversed(e.points))
    if len(pts) < 2:
        return None
    k = min(4, len(pts))
    x0, y0 = pts[0]
    x1, y1 = pts[k - 1]
    dx, dy = x1 - x0, y1 - y0
    n = math.hypot(dx, dy)
    if n == 0:
        return None
    return (dx / n, dy / n)


def _merge_collinear(graph: _Graph, tol_deg: float) -> int:
    """Dissolve junctions with exactly two aligned incidents (straight pass-
    through). Real corners (~90°) and T/X junctions survive. Returns merges.

    Incremental rewrite of the rescan-everything loop: node -> incident
    edges adjacency is MAINTAINED, and candidates live in a heap keyed by
    the dict insertion order. Decisions are unchanged — the original scan
    always dissolved the FIRST eligible node in insertion order and
    recomputed everything after each dissolve; the heap pops exactly that.
    The old full rescan was O(nodes x edges) per dissolve — on a die-sized
    graph (18k junction clusters / 13k corridors) it ground for 15+
    minutes inside the whole-die decode's "graph" stage."""
    import heapq

    edges = graph.edges

    # Adjacency: node -> [(edge_id, at_start)], built in the same order the
    # old _incident scan saw them (edges in list order, a-before-b).
    adj: dict[int, list[tuple[int, bool]]] = {}
    for i, e in enumerate(edges):
        if e.removed:
            continue
        if e.a is not None:
            adj.setdefault(e.a, []).append((i, True))
        if e.b is not None:
            adj.setdefault(e.b, []).append((i, False))
        if e.a == e.b and e.a is not None:  # loop attached twice
            adj[e.a].append((i, False))

    def live_inc(node: int) -> list[tuple[int, bool]]:
        inc = [p for p in adj.get(node, []) if not edges[p[0]].removed]
        # Drop consumed entries so lists don't bloat across dissolves.
        if len(inc) != len(adj.get(node, [])):
            adj[node] = inc if inc else []
        return inc

    # Candidates: every node that could possibly be eligible. Heap keyed by
    # dict insertion order = "first eligible node" of the original rescan.
    order = {node: pos for pos, node in enumerate(graph.nodes)}
    pending: list[tuple[int, int]] = [
        (order[n], n) for n in graph.nodes if len(adj.get(n, [])) == 2
    ]
    heapq.heapify(pending)

    merges = 0
    while pending:
        _pos, node = heapq.heappop(pending)
        if node not in graph.nodes:
            continue
        inc = live_inc(node)
        if len(inc) != 2:
            continue
        (e1_id, s1), (e2_id, s2) = inc
        if e1_id == e2_id:
            continue  # loop attached twice — not a pass-through
        e1, e2 = edges[e1_id], edges[e2_id]
        if not e1.points or not e2.points:
            continue
        d1 = _edge_dir_at(graph, e1, not s1)  # travel INTO the node along e1
        d2 = _edge_dir_at(graph, e2, s2)      # travel OUT of the node along e2
        if d1 is None or d2 is None:
            continue
        dot = max(-1.0, min(1.0, d1[0] * d2[0] + d1[1] * d2[1]))
        ang = math.degrees(math.acos(dot))
        if ang > tol_deg:
            continue  # real corner/other topology — drop until a change

        # Reorient: e1 must walk INTO the node, e2 must walk OUT of it;
        # capture pre-merge attachment ends for adjacency maintenance.
        a1_old, b1_old = e1.a, e1.b
        a2_old, b2_old = e2.a, e2.b
        if s1:
            e1.a, e1.b = e1.b, e1.a
            e1.points.reverse()
        if not s2:
            e2.a, e2.b = e2.b, e2.a
            e2.points.reverse()
        # after reorientation e1.b == node and e2.a == node
        e1.points = e1.points + [graph.nodes[node]] + e2.points
        new_a, new_b = e1.a, e2.b  # e1 takes over e2's far end
        e1.b = new_b
        e2.removed = True
        del graph.nodes[node]
        merges += 1

        # ── Maintain adjacency surgically: drop e1/e2's stale entries at
        #    their old ends, re-add e1 at its new pair of ends ──
        for nid, removed_edge in (
            (a1_old, e1_id), (b1_old, e1_id),
            (a2_old, e2_id), (b2_old, e2_id),
        ):
            if nid is None:
                continue
            lst = adj.get(nid)
            if lst:
                adj[nid] = [p for p in lst if p[0] != removed_edge]
        if new_a is not None:
            adj.setdefault(new_a, []).append((e1_id, True))
        if new_b is not None:
            adj.setdefault(new_b, []).append((e1_id, False))
        for nid in (new_a, new_b):
            if nid is not None and nid in graph.nodes:
                heapq.heappush(pending, (order[nid], nid))
    return merges


def _angle_between(v1: tuple[float, float], v2: tuple[float, float]) -> float:
    n1 = math.hypot(*v1)
    n2 = math.hypot(*v2)
    if n1 == 0 or n2 == 0:
        return 180.0
    dot = (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2)
    return math.degrees(math.acos(max(-1.0, min(1.0, dot))))


def _fuse_small_turns(pts: list[list[int]], tol_deg: float) -> list[list[int]]:
    """Drop vertices whose turn angle is below tol_deg — the trace keeps
    vertices only at real (≈45°/90°) direction changes."""
    out = [list(p) for p in pts]
    changed = True
    while changed and len(out) > 2:
        changed = False
        i = 1
        while i < len(out) - 1:
            v1 = (out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1])
            v2 = (out[i + 1][0] - out[i][0], out[i + 1][1] - out[i][1])
            if _angle_between(v1, v2) <= tol_deg:
                del out[i]
                changed = True
            else:
                i += 1
    return out


def _group_edges(graph: _Graph) -> dict[int, int]:
    """Union-find over surviving edges: shared node → same group; detached
    cycles get their own group. Returns edge index -> group id."""
    parent: dict[int, int] = {}

    def find(x: int) -> int:
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    for idx, e in enumerate(graph.edges):
        if e.removed:
            continue
        find(idx)
        if e.a is not None and e.b is not None:
            union(idx, 10_000_000 + e.a)
            union(idx, 10_000_000 + e.b)
    # Detached cycles (a is None): unique group via the edge's own index.
    out: dict[int, int] = {}
    seen_groups: dict[int, int] = {}
    next_group = 0
    for idx, e in enumerate(graph.edges):
        if e.removed:
            continue
        root = find(idx)
        if root not in seen_groups:
            seen_groups[root] = next_group
            next_group += 1
        out[idx] = seen_groups[root]
    return out


def _drop_parallel_duplicates(traces: list[dict], stats: dict) -> list[dict]:
    """Remove same-group traces that just run PARALLEL to a longer one.

    A fat wire (or an over-bridged mask) often yields two collinear
    skeleton arms — the two "sides" of the corridor, sometimes closed into
    a loop at the ends. Within one decoder group (= one physical wire)
    such duplicates are pure artifacts: real parallel wires live in
    DIFFERENT groups (they never share junctions). Rule: a trace is a
    duplicate when most of its vertices lie within `dup_tol` of a longer
    same-group trace's segments. The longer one is kept.
    """
    import numpy as np

    if len(traces) < 2:
        return traces
    by_group: dict[int, list[int]] = {}
    for i, t in enumerate(traces):
        by_group.setdefault(int(t.get("group", -1)), []).append(i)

    def plen(pts: list) -> float:
        return float(
            sum(
                math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])
                for i in range(len(pts) - 1)
            )
        )

    dropped = set()
    for members in by_group.values():
        if len(members) < 2:
            continue
        members.sort(key=lambda i: -plen(traces[i]["points"]))
        kept: list[int] = []
        for i in members:
            pts = np.asarray(traces[i]["points"], dtype=np.float64)
            dup = False
            for j in kept:
                ref = np.asarray(traces[j]["points"], dtype=np.float64)
                # Vectorized point-to-segment distance: |pts| x |ref|-1.
                a = ref[:-1]
                b = ref[1:]
                ab = b - a
                ap = pts[:, None, :] - a[None, :, :]
                ab_len2 = (ab * ab).sum(axis=1)
                ab_len2[ab_len2 == 0] = 1.0
                u = np.clip((ap * ab[None, :, :]).sum(axis=2) / ab_len2[None, :], 0.0, 1.0)
                proj = a[None, :, :] + u[:, :, None] * ab[None, :, :]
                dmin = np.sqrt(((pts[:, None, :] - proj) ** 2).sum(axis=2)).min(axis=1)
                w_c = float(traces[i].get("width", 0.0))
                w_r = float(traces[j].get("width", 0.0))
                dup_tol = max(2.5, 0.6 * min(w for w in (w_c, w_r) if w > 0) if (w_c > 0 and w_r > 0) else 2.5)
                close = float((dmin <= dup_tol).sum()) / len(dmin)
                if close >= 0.7:
                    dup = True
                    break
            if dup:
                dropped.add(i)
            else:
                kept.append(i)
    if not dropped:
        return traces
    stats["dropped_parallel"] = len(dropped)
    return [t for i, t in enumerate(traces) if i not in dropped]


def extract_wire_runs(
    mask_prob: np.ndarray,
    threshold: float = 0.5,
    epsilon: float = 2.5,
    min_len: int = 14,
    width_map: np.ndarray | None = None,
    width_min: float = 0.0,
    width_max: float = 0.0,
    score_map: np.ndarray | None = None,
    turn_tol_deg: float = 20.0,
    max_traces: int = 200_000,
    progress=None,
) -> dict:
    """Skeleton → cleaned branch graph → one minimal-vertex polyline per
    straight run, grouped by graph connectivity. Returns
    {"traces": [{points, score, width?, group}], "stats": {...}}.

    `progress(stage)` — optional whole-die decode progress callback; stages
    (skeletonize / graph / runs) come from _build_graph and the emit phase."""
    binary = mask_prob > threshold
    stats = {"kept": 0, "dropped_width": 0, "dropped_short": 0, "merged": 0, "dropped_parallel": 0}
    if not binary.any():
        return {"traces": [], "stats": stats}

    graph, _skel = _build_graph(binary, progress=progress)
    # Graph-phase short-edge drop FIRST: noise arms off a junction vanish
    # here, which dissolves the junction (degree 3→2) so the collinear merge
    # below can stitch the long branches back into ONE wire. Doing it in the
    # emit phase instead would keep spurious junctions alive.
    for e in graph.edges:
        if len(e.points) < min_len:
            e.removed = True
            stats["dropped_short"] += 1
    stats["merged"] = _merge_collinear(graph, tol_deg=30.0)
    if progress:
        progress("runs")

    strength = mask_prob if score_map is None else score_map
    traces: list[dict] = []
    for idx, e in enumerate(graph.edges):
        if e.removed:
            continue
        ys_arr = np.array([p[1] for p in e.points])
        xs_arr = np.array([p[0] for p in e.points])
        median_w = float(np.median(width_map[ys_arr, xs_arr])) if width_map is not None else None
        if width_map is not None and median_w is not None:
            if (width_min > 0 and median_w < width_min) or (width_max > 0 and median_w > width_max):
                stats["dropped_width"] += 1
                e.removed = True
                continue
        sel = strength[ys_arr, xs_arr]
        score = float(sel.mean()) if sel.size else 0.0

        # Polyline: node centroid anchors at both attached ends + DP.
        pts_src: list[tuple[int, int]] = []
        if e.a is not None and e.a in graph.nodes:
            pts_src.append(graph.nodes[e.a])
        pts_src.extend(e.points)
        if e.b is not None and e.b in graph.nodes:
            pts_src.append(graph.nodes[e.b])
        arr = np.array(pts_src, dtype=np.int32).reshape(-1, 1, 2)
        approx = (cv2.approxPolyDP(arr, epsilon, closed=False).reshape(-1, 2)
                  if len(arr) >= 3 else arr.reshape(-1, 2))
        polyline = _fuse_small_turns([[int(x), int(y)] for x, y in approx], turn_tol_deg)
        if len(polyline) < 2:
            continue
        trace: dict = {"points": polyline, "score": round(score, 4)}
        if median_w is not None:
            trace["width"] = round(median_w, 2)
        traces.append((idx, trace))

    groups = _group_edges(graph)
    out: list[dict] = []
    for idx, t in traces:
        t = dict(t)
        t["group"] = int(groups.get(idx, idx))
        out.append(t)
        stats["kept"] += 1
        if len(out) >= max_traces:
            print(f"[warn] wire runs: hit cap {max_traces} — mask is noisy")
            break
    # Same-group parallel duplicates (both sides of one fat corridor, the
    # closed-loop artifact) — keep the longer representative of each pair.
    out = _drop_parallel_duplicates(out, stats)
    stats["kept"] = len(out)
    return {"traces": out, "stats": stats}
