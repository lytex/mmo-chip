"""Render Gaussian targets; per-class decoders for the 3 model channels.

Decoders:
  ch0 point_via    -> extract_peaks            -> points
  ch1 irregular_via-> extract_components       -> {bbox, centroid, area}
  ch2 trace        -> extract_trace_polylines  -> contour polylines
(True skeleton->graph for trace is the later assisted-tracing phase; contour
polylines are the dependency-free v1 decode.)
"""
from __future__ import annotations

from typing import Iterable

import cv2
import numpy as np
from scipy.ndimage import maximum_filter
from scipy.ndimage import mean as ndi_mean


def render_heatmap(points: Iterable[tuple[float, float]],
                   shape: tuple[int, int],
                   sigma: float) -> np.ndarray:
    h, w = shape
    heatmap = np.zeros((h, w), dtype=np.float32)
    radius = max(1, int(np.ceil(3 * sigma)))
    two_sigma_sq = 2.0 * sigma * sigma
    for x, y in points:
        cx, cy = float(x), float(y)
        x0 = max(0, int(np.floor(cx - radius)))
        x1 = min(w, int(np.ceil(cx + radius + 1)))
        y0 = max(0, int(np.floor(cy - radius)))
        y1 = min(h, int(np.ceil(cy + radius + 1)))
        if x0 >= x1 or y0 >= y1:
            continue
        ys, xs = np.mgrid[y0:y1, x0:x1]
        g = np.exp(-((xs - cx) ** 2 + (ys - cy) ** 2) / two_sigma_sq)
        view = heatmap[y0:y1, x0:x1]
        np.maximum(view, g, out=view)
    return heatmap


def extract_peaks(heatmap: np.ndarray,
                  threshold: float = 0.3,
                  min_distance: int = 3) -> list[tuple[int, int, float]]:
    size = 2 * min_distance + 1
    local_max = maximum_filter(heatmap, size=size, mode="constant", cval=0.0) == heatmap
    above = heatmap > threshold
    coords = np.argwhere(local_max & above)
    if coords.size == 0:
        return []
    scores = heatmap[coords[:, 0], coords[:, 1]]
    order = np.argsort(-scores)
    coords = coords[order]
    scores = scores[order]
    return [(int(c[1]), int(c[0]), float(s)) for c, s in zip(coords, scores)]


def extract_components(mask_prob: np.ndarray,
                       threshold: float = 0.5,
                       min_area: int = 4) -> list[dict]:
    """irregular_via decode: connected components → bbox/centroid/area/score.

    Per-label mean score is computed in a SINGLE vectorized pass. (Previously
    `mask_prob[labels == i].mean()` ran inside the loop — O(n_components·H·W),
    which on a gigapixel near-noise mask hangs effectively forever.)
    """
    binary = (mask_prob > threshold).astype(np.uint8)
    n, labels, stats, centroids = cv2.connectedComponentsWithStats(binary, 8)
    if n <= 1:
        return []
    idx = np.arange(1, n)
    means = np.atleast_1d(ndi_mean(mask_prob, labels=labels, index=idx))
    out: list[dict] = []
    for k, i in enumerate(idx):  # 0 = background
        area = int(stats[i, cv2.CC_STAT_AREA])
        if area < min_area:
            continue
        out.append({
            "bbox": [int(stats[i, cv2.CC_STAT_LEFT]), int(stats[i, cv2.CC_STAT_TOP]),
                     int(stats[i, cv2.CC_STAT_WIDTH]), int(stats[i, cv2.CC_STAT_HEIGHT])],
            "centroid": [float(centroids[i][0]), float(centroids[i][1])],
            "area": area,
            "score": float(means[k]),
        })
    return out


def extract_trace_skeleton(mask_prob: np.ndarray,
                           threshold: float = 0.5,
                           epsilon: float = 2.0,
                           min_len: int = 14,
                           max_polylines: int = 100_000,
                           bridge_px: int = 2,
                           score_map: np.ndarray | None = None,
                           width_map: np.ndarray | None = None,
                           width_range: tuple[float, float] | None = None) -> list[dict]:
    """trace decode (v2): skeleton → branch graph → centreline polylines.

    Thin the thresholded mask to 1-px centrelines (scikit-image), group
    junction/endpoint pixels into node clusters, and walk the degree-2
    corridors between them: one polyline per branch, ends snapped to node
    centroids. Unlike v1's fat contour outlines, these centrelines carry
    meaningful END coordinates — the snap targets for vias / device contacts.

    `bridge_px` closes small mask gaps first (morphological close with a
    (2·bridge+1)² kernel): an under-trained mask dips below the threshold
    along a wire for a few pixels, which would otherwise cut the skeleton —
    and the wire — into fragments.

    `score_map` — what the per-branch "score" averages (defaults to
    `mask_prob`; the vectorize decoder passes the normalized channel image
    so score becomes a brightness margin instead of a model probability).

    `width_map` + `width_range` — when a distance-transform map is given,
    each branch reports its median corridor width ("width") and branches
    whose median falls outside `width_range` are dropped: wires have a
    narrow, known width, so this kills fat blobs (pads, text, charging
    halos) and the wide bridges where parallel wires bleed together.

    Returns [{"points": [[x, y], …], "score": mean prob along branch,
              "width": median corridor width?}].
    """
    from scipy.ndimage import center_of_mass, label as scipy_label
    from skimage.morphology import skeletonize

    binary = mask_prob > threshold
    if not binary.any():
        return []
    if bridge_px > 0:
        # Morphological close bridges sub-threshold dips so the skeleton
        # stays connected along a wire instead of fragmenting.
        k = 2 * bridge_px + 1
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (k, k))
        binary = cv2.morphologyEx(binary.astype(np.uint8), cv2.MORPH_CLOSE, kernel).astype(bool)
        if not binary.any():
            return []
    skel = skeletonize(binary).astype(np.uint8)
    h, w = skel.shape

    # 8-neighbour count per skeleton pixel (padded shifts).
    padded = np.pad(skel, 1, mode="constant")
    neighbours = np.zeros((h, w), dtype=np.uint8)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dy != 0 or dx != 0:
                neighbours += padded[1 + dy:1 + dy + h, 1 + dx:1 + dx + w]

    # Nodes: junctions (≥3 neighbours) and free endpoints (1). Adjacent node
    # pixels collapse into one node cluster; the cluster centroid is the
    # polyline endpoint coordinates.
    node_mask = skel.astype(bool) & ((neighbours >= 3) | (neighbours == 1))
    node_labels, n_nodes = scipy_label(node_mask)
    centroids: dict[int, tuple[int, int]] = {}
    if n_nodes:
        coms = center_of_mass(node_mask, node_labels, range(1, n_nodes + 1))
        for lab, (cy, cx) in enumerate(coms, start=1):
            centroids[lab] = (int(round(cy)), int(round(cx)))

    def neighbours_of(py: int, px: int) -> list[tuple[int, int]]:
        out = []
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dy == 0 and dx == 0:
                    continue
                ny, nx_ = py + dy, px + dx
                if 0 <= ny < h and 0 <= nx_ < w and skel[ny, nx_]:
                    out.append((ny, nx_))
        return out

    # Corridor pixels (degree-2 skeleton pixels between node clusters) form
    # disjoint paths and cycles: every corridor pixel has ≤2 corridor
    # neighbours, so walk each connected component from an endpoint (or
    # anywhere, for cycles) — deterministic, no mid-corridor splits.
    corridors = skel.astype(bool) & ~node_mask
    cor_set = set(zip(*np.nonzero(corridors)))
    cor_n: dict[tuple[int, int], list[tuple[int, int]]] = {
        p: [q for q in neighbours_of(*p) if q in cor_set] for p in cor_set
    }
    visited_cor: set[tuple[int, int]] = set()
    paths: list[list[tuple[int, int]]] = []

    def follow(start: tuple[int, int], nxt: tuple[int, int]) -> list[tuple[int, int]]:
        path = [start, nxt]
        visited_cor.update((start, nxt))
        prev, cur = start, nxt
        while True:
            cands = [q for q in cor_n[cur] if q != prev]
            if not cands:
                break
            q = cands[0]
            if q == start or q in visited_cor:
                break  # cycle closed / component fully consumed
            prev, cur = cur, q
            path.append(cur)
            visited_cor.add(cur)
            if len(path) > 4_000_000:  # runaway guard
                break
        return path

    # Seed path components from their END pixels first (exactly one corridor
    # neighbour) so a component is walked whole; cycles (no ends) follow in a
    # second pass from any pixel.
    for p in cor_set:
        if p in visited_cor:
            continue
        if len(cor_n[p]) == 1:
            paths.append(follow(p, cor_n[p][0]))
    for p in cor_set:
        if p in visited_cor:
            continue
        nb = cor_n[p]
        if len(nb) >= 1:
            paths.append(follow(p, nb[0]))
        else:
            paths.append([p])
            visited_cor.add(p)

    # Attach node-cluster centroids at both path ends (a corridor component
    # terminates on a node cluster at each end, or is a detached cycle).
    def attach(path: list[tuple[int, int]]) -> list[tuple[int, int]]:
        pts = list(path)
        for q in neighbours_of(*path[0]):
            lab = int(node_labels[q]) if node_mask[q] else 0
            if lab:
                pts.insert(0, centroids[lab])
                break
        for q in neighbours_of(*path[-1]):
            lab = int(node_labels[q]) if node_mask[q] else 0
            if lab:
                pts.append(centroids[lab])
                break
        return pts

    traces: list[dict] = []
    for path in paths:
        if len(path) < 2 or len(path) < min_len:
            continue
        ys_arr = np.array([py for (py, _) in path])
        xs_arr = np.array([px for (_, px) in path])
        sel = mask_prob[ys_arr, xs_arr]
        score_map_ref = mask_prob if score_map is None else score_map
        sel_score = score_map_ref[ys_arr, xs_arr]
        score = float(sel_score.mean()) if sel_score.size else 0.0
        # Median corridor width from the distance transform (if provided):
        # the cheap discriminator between wires and fat mask blobs.
        median_w = float(np.median(width_map[ys_arr, xs_arr])) if width_map is not None else None
        if width_range is not None and median_w is not None:
            w_lo, w_hi = width_range
            if median_w < w_lo or (w_hi > 0 and median_w > w_hi):
                continue
        pts_src = attach(path)
        arr = np.array([[px, py] for (py, px) in pts_src], dtype=np.int32)
        approx = (cv2.approxPolyDP(arr.reshape(-1, 1, 2), epsilon, closed=False).reshape(-1, 2)
                  if len(arr) >= 3 else arr)
        polyline = [[int(px), int(py)] for px, py in approx]
        if len(polyline) < 2:
            continue
        trace = {"points": polyline, "score": round(score, 4)}
        if median_w is not None:
            trace["width"] = round(median_w, 2)
        traces.append(trace)
        if len(traces) >= max_polylines:
            print(f"[warn] trace decode v2: hit cap {max_polylines} — mask is noisy")
            break
    return traces


def extract_trace_polylines(mask_prob: np.ndarray,
                            threshold: float = 0.5,
                            epsilon: float = 1.5,
                            min_len: int = 8,
                            max_polylines: int = 100_000) -> list[dict]:
    """trace decode (v1): contour polylines of the thresholded mask.

    Returns a list of {"points": [[x, y], …], "score": mean-prob-inside}.
    The score is the mean sigmoid probability of the contour's own pixels —
    a cheap per-trace confidence the client can threshold noise with. A true
    skeleton→graph is the later assisted-tracing phase; contours are enough
    for the UI to overlay proposed conductor paths.

    Guarded against an under-trained / low-threshold mask exploding into
    millions of speckle contours: contours are sorted by length and only the
    longest `max_polylines` kept (a runaway count means raise the threshold or
    decode per-tile instead of whole-die).
    """
    binary = (mask_prob > threshold).astype(np.uint8)
    contours, _ = cv2.findContours(binary, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    kept = [c for c in contours if cv2.arcLength(c, closed=False) >= min_len]
    if len(kept) > max_polylines:
        print(f"[warn] trace decode: {len(kept)} contours > cap {max_polylines} "
              f"— mask is noisy (raise --threshold or decode per-tile); "
              f"keeping the {max_polylines} longest")
        kept.sort(key=lambda c: cv2.arcLength(c, closed=False), reverse=True)
        kept = kept[:max_polylines]
    traces: list[dict] = []
    for c in kept:
        approx = cv2.approxPolyDP(c, epsilon, closed=False)
        points = [[int(p[0][0]), int(p[0][1])] for p in approx]
        # Mean probability inside the filled contour (patch-local for speed).
        score = 0.0
        x, y, w, h = cv2.boundingRect(c)
        if w > 0 and h > 0:
            patch = mask_prob[y:y + h, x:x + w]
            inside = np.zeros((h, w), dtype=np.uint8)
            cv2.drawContours(inside, [c - [x, y]], -1, 1, thickness=-1)
            sel = patch[inside > 0]
            if sel.size:
                score = float(sel.mean())
        traces.append({"points": points, "score": round(score, 4)})
    return traces
