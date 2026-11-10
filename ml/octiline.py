"""Octilinear ring cleanup (L1) for the polygon-axis decoder.

The polygon-axis decoder (ml/polygon_axis.py) derives each trace centreline
from the OUTLINE of the vectorized metal polygon, so pixel-level jaggies the
contour walker leaves behind would leak into the axis. This module
straightens a contour ring BEFORE the medial-axis step:

  1. approxPolyDP (~1 px) kills the per-pixel staircase the crack walker
     produced;
  2. vertices closer than `min_seg` collapse and near-collinear neighbours
     fuse — a run of 20-30 deg mini segments becomes one segment;
  3. every segment whose direction is within `deg_tol` of a multiple of 45
     deg is rotated onto it (end rotates about start, chain-anchored, so the
     corrections accumulate as sub-pixel drift — no gaps in the ring).

A truly curvy wall (direction further than deg_tol from any 45 deg multiple)
is kept as drawn: forcing it would be geometry forgery. Honesty for such
geometry lives one level up — polygon_axis marks those traces `irregular`.

No new dependencies: cv2/numpy only.
"""
from __future__ import annotations

import math

import cv2
import numpy as np

# Unsigned direction classes mod 180 deg: 0=(1,0) 1=(1,1) 2=(0,1) 3=(-1,1).
_OCT_UNIT = (
    (1.0, 0.0),
    (math.sqrt(0.5), math.sqrt(0.5)),
    (0.0, 1.0),
    (-math.sqrt(0.5), math.sqrt(0.5)),
)


def oct_class(dx: float, dy: float) -> int:
    """Unsigned octilinear class (0..3) of a direction vector (-1: zero)."""
    if dx == 0 and dy == 0:
        return -1
    ang = math.degrees(math.atan2(dy, dx)) % 180.0
    return int(round(ang / 45.0)) % 4


def _angle_at(a: tuple[float, float], b: tuple[float, float], c: tuple[float, float]) -> float:
    """Angle (deg) between the rays b->a and b->c (0 = straight through b)."""
    v1 = (a[0] - b[0], a[1] - b[1])
    v2 = (c[0] - b[0], c[1] - b[1])
    n1 = math.hypot(*v1)
    n2 = math.hypot(*v2)
    if n1 == 0 or n2 == 0:
        return 180.0
    dot = max(-1.0, min(1.0, (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2)))
    return math.degrees(math.acos(dot))


def _collapse_tiny(pts: list[tuple[float, float]], min_seg: float) -> list[tuple[float, float]]:
    """Drop vertices that sit closer than min_seg to their kept neighbour."""
    if len(pts) < 5:
        return pts
    out = [pts[0]]
    for p in pts[1:]:
        if math.dist(out[-1], p) >= min_seg:
            out.append(p)
    # Closed ring: the last vertex must also be min_seg from the first one.
    if len(out) >= 5 and math.dist(out[-1], out[0]) < min_seg:
        out.pop()
    return out if len(out) >= 5 else pts


def _fuse_collinear(pts: list[tuple[float, float]], tol_deg: float) -> list[tuple[float, float]]:
    """Iteratively drop ring vertices through which the outline passes
    (nearly) straight; real corners survive. Closed-ring aware."""
    changed = True
    while changed and len(pts) > 4:
        changed = False
        n = len(pts)
        keep: list[tuple[float, float]] = []
        for i in range(n):
            a = pts[(i - 1) % n]
            b = pts[i]
            c = pts[(i + 1) % n]
            if _angle_at(a, b, c) > tol_deg:
                keep.append(b)
            else:
                changed = True
        pts = keep
    return pts


def _snap_directions(
    pts: list[tuple[float, float]], deg_tol: float
) -> list[tuple[float, float]]:
    """Rotate every segment within deg_tol of a 45 deg multiple onto it.

    Chain-anchored: each segment starts at the (possibly rotated) end of the
    previous one, so small rotations accumulate but never create gaps. The
    ring start stays put; the closing segment may stay unrotated if the
    accumulated drift exceeds the tolerance — the axis side does not care
    about sub-pixel closing slack.
    """
    n = len(pts)
    if n < 3:
        return pts
    out = [pts[0]]
    cur = pts[0]
    for i in range(1, n):
        tgt = pts[i]
        dx, dy = tgt[0] - cur[0], tgt[1] - cur[1]
        length = math.hypot(dx, dy)
        if length < 1e-6:
            continue
        cls = oct_class(dx, dy)
        exact = math.degrees(math.atan2(dy, dx)) % 180.0
        base = 45.0 * cls % 180.0
        off = min(abs(exact - base), 180.0 - abs(exact - base))
        if off <= deg_tol:
            ux, uy = _OCT_UNIT[cls]
            # keep the SIGN (< 90 deg between the raw dir and the snapped
            # unit) — the class is mod 180, a leftward run must stay leftward
            sgn = 1.0 if (dx * ux + dy * uy) >= 0 else -1.0
            cur = (cur[0] + ux * sgn * length, cur[1] + uy * sgn * length)
        else:
            cur = tgt
        out.append(cur)
    return out


def quantize_ring(
    ring: np.ndarray,
    deg_tol: float = 12.0,
    min_seg: float = 2.5,
    eps_px: float = 2.0,
) -> list[list[int]]:
    """Raw contour ring (N,2 int) -> octilinear vertex list [[x, y], ...].

    Steps: approxPolyDP -> tiny-vertex collapse -> collinear fusion ->
    45 deg direction snap. Fewer than 4 vertices is returned rounded as-is
    (degenerate specks are skipped by the caller anyway). eps_px=2 by
    default: edge features under ~2 px are staircase noise, real chip
    corners survive (they are at least that far from the fitted edge).
    """
    if ring is None or len(ring) == 0:
        return []
    arr = np.asarray(ring, dtype=np.float32).reshape(-1, 2)
    if arr.shape[0] < 4:
        return [[int(round(x)), int(round(y))] for x, y in arr]

    simplified = cv2.approxPolyDP(arr.reshape(-1, 1, 2), float(eps_px), True).reshape(-1, 2)
    pts = [(float(x), float(y)) for x, y in simplified]
    pts = _collapse_tiny(pts, float(min_seg))
    pts = _fuse_collinear(pts, deg_tol + 12.0)
    pts = _snap_directions(pts, deg_tol)
    return [[int(round(x)), int(round(y))] for x, y in pts]


def resample_ring(
    ring: list[list[int]], step: float = 2.0
) -> list[tuple[int, int]]:
    """Dense boundary samples of a closed ring, evenly spaced ~`step` px.

    Yields integer lattice points for the Delaunay input; duplicates are
    fine here, the caller dedups.
    """
    n = len(ring)
    if n < 3:
        return []
    out: list[tuple[int, int]] = []
    for i in range(n):
        ax, ay = ring[i]
        bx, by = ring[(i + 1) % n]
        dx, dy = bx - ax, by - ay
        length = math.hypot(dx, dy)
        if length == 0:
            continue
        k = max(1, int(length / step))
        for t in range(k):
            out.append((int(round(ax + dx * t / k)), int(round(ay + dy * t / k))))
    return out
