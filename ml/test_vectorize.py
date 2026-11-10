"""Offline tests for the classical vectorize decoder (no model needed).

Run directly:
    python test_vectorize.py
or via pytest later — plain asserts + a main() that exits nonzero.
"""
from __future__ import annotations

import sys

import cv2
import numpy as np

from vectorize import VectorParams, vectorize_region


def _blank(h: int = 120, w: int = 200) -> np.ndarray:
    return np.zeros((h, w, 3), dtype=np.uint8)


def test_empty_image_decodes_to_empty() -> None:
    r = vectorize_region(_blank(), VectorParams(thresh_low=150))
    assert r["traces"] == [] and r["outlines"] == []


def test_band_threshold_selects_bright_metal() -> None:
    img = _blank()
    img[30:34, 10:180] = 200  # bright wire
    img[70:74, 10:180] = 60   # dim wire — outside the band
    p = VectorParams(thresh_low=150, min_len=14, width_min=1.5, width_max=12)
    r = vectorize_region(img, p)
    assert len(r["traces"]) == 1, f"expected 1 trace, got {len(r['traces'])}"
    ys = {pt[1] for pt in r["traces"][0]["points"]}
    assert all(30 <= y <= 33 for y in ys), f"wrong wire: {sorted(ys)}"


def test_invert_selects_dark_metal() -> None:
    img = np.full((120, 200, 3), 220, dtype=np.uint8)
    img[30:34, 10:180] = 40  # dark wire on bright field
    p = VectorParams(invert=True, thresh_low=100, min_len=14, width_min=1.5, width_max=12)
    r = vectorize_region(img, p)
    assert len(r["traces"]) == 1, f"expected 1 trace, got {len(r['traces'])}"


def test_width_filter_drops_fat_blobs() -> None:
    img = _blank()
    img[30:34, 10:180] = 200                          # 4 px wire
    img[70:92, 10:120] = 210                          # 22 px wide, long bus
    cv2.rectangle(img, (40, 100), (55, 115), 210, -1)  # 16×16 pad blob
    p = VectorParams(thresh_low=150, min_len=8, width_min=1.5, width_max=12)
    r = vectorize_region(img, p)
    assert len(r["traces"]) == 1, f"fat bar survived: {[(len(t['points']), t.get('width')) for t in r['traces']]}"
    assert r["traces"][0]["width"] <= 12
    assert r["stats"]["dropped_width"] == 1, f"drop stats off: {r['stats']}"
    assert r["stats"]["kept"] == 1


def test_min_len_drops_specks() -> None:
    # NB: min_len measures the degree-2 corridor BETWEEN node pixels — the
    # node pixels at a wire's free ends don't count, so a straight bar's
    # usable length is ~4 px shorter than its mask length.
    img = _blank()
    img[30:34, 10:180] = 200    # long wire (~170 px)
    img[90:94, 40:60] = 200     # 20 px speck (corridor ~15 px)
    p_long = VectorParams(thresh_low=150, min_len=40, width_min=0)
    r = vectorize_region(img, p_long)
    assert len(r["traces"]) == 1, f"speck survived min_len=40: {len(r['traces'])} traces"
    p_short = VectorParams(thresh_low=150, min_len=10, width_min=0)
    r2 = vectorize_region(img, p_short)
    assert len(r2["traces"]) == 2, f"expected wire + speck: {len(r2['traces'])}"


def test_bridging_connects_gapped_wire() -> None:
    img = _blank()
    img[30:34, 10:100] = 200
    img[30:34, 105:190] = 200  # 5 px gap — wider than the default 2 bridge
    p = VectorParams(thresh_low=150, min_len=20, width_min=0, bridge_px=3)
    r = vectorize_region(img, p)
    assert len(r["traces"]) == 1, f"gap not bridged: {len(r['traces'])} traces"
    p0 = VectorParams(thresh_low=150, min_len=20, width_min=0, bridge_px=0)
    r0 = vectorize_region(img, p0)
    assert len(r0["traces"]) == 2, "bridge_px=0 should still split at the gap"


def test_colour_channel_selection() -> None:
    img = _blank()
    img[30:34, 10:180, 1] = 220  # green-only wire
    img[60:64, 10:180, 0] = 220  # red-only wire
    p = VectorParams(channel="g", thresh_low=150, min_len=14, width_min=0)
    r = vectorize_region(img, p)
    assert len(r["traces"]) == 1
    ys = {pt[1] for pt in r["traces"][0]["points"]}
    assert all(30 <= y <= 33 for y in ys), "picked the red wire with channel=g"


def test_adaptive_mode_runs_on_gradient_lighting() -> None:
    # Uneven illumination: a global band can't fit both sides at once.
    x = np.linspace(40, 200, 200, dtype=np.float32)
    grad = np.tile(x, (120, 1))
    img = np.stack([grad] * 3, axis=-1).astype(np.uint8)
    img[30:34, :] = 255  # wire brighter than its local background everywhere
    p = VectorParams(adaptive=True, adaptive_block=51, adaptive_c=8,
                     min_len=14, width_min=0)
    r = vectorize_region(img, p)
    assert len(r["traces"]) >= 1, "adaptive threshold lost the wire"


def test_reports_per_trace_width_and_score() -> None:
    img = _blank()
    img[30:36, 10:180] = 230  # 6 px wire
    p = VectorParams(thresh_low=150, min_len=14, width_min=0)
    r = vectorize_region(img, p)
    assert len(r["traces"]) == 1
    t = r["traces"][0]
    assert 4 <= t["width"] <= 8, f"width estimate off: {t['width']}"
    assert 0.0 < t["score"] <= 1.0


# ── Octilinear decoder (polygon axis + 45/90 snap) ────────────────────────


def _oct(img: np.ndarray, **kw) -> dict:
    kw.setdefault("min_len", 14)
    kw.setdefault("width_min", 0)
    return vectorize_region(img, VectorParams(decoder="octilinear", **kw))


def _wire(points: list[tuple[int, int]], thick: int = 6) -> np.ndarray:
    """Fat polyline wire mask (thickness `thick`, drawn as a stroked path)."""
    img = _blank(160, 240)
    pts = np.array(points, dtype=np.int32).reshape(-1, 1, 2)
    cv2.polylines(img, [pts], False, (200, 200, 200), thickness=thick)
    return img


def test_octilinear_empty_decodes_to_empty() -> None:
    r = _oct(_blank())
    assert r["traces"] == [] and r["outlines"] == []


def test_octilinear_straight_noisy_wire_is_one_two_point_trace() -> None:
    # a straight bus with jagged (staircase) edges: a human drew a line
    img = _blank(160, 240)
    rng = np.random.default_rng(7)
    for x in range(20, 220):
        j0 = int(rng.integers(-1, 2))
        j1 = int(rng.integers(-1, 2))
        img[30 + j0:36 + j1, x] = 200
    r = _oct(img, oct_delta_px=1.5)
    assert r["traces"], "no traces at all"
    t = r["traces"][0]
    assert len(t["points"]) == 2, f"expected ONE straight segment, got {t['points']}"
    (x0, y0), (x1, y1) = t["points"]
    assert y0 == y1, f"not horizontal: {t['points']}"
    assert x1 > x0


def test_octilinear_L_turn_only_orthogonal() -> None:
    # path: right along y=100, then up
    img = _wire([(20, 120), (150, 120), (150, 40)])
    r = _oct(img, oct_delta_px=1.5)
    assert r["traces"], "no traces"
    # trace must consist of only axial/diagonal-45 segments, ≥7 verts not
    # expected — one turn kept as a corner vertex
    assert len(r["traces"][0]["points"]) <= 3, r["traces"][0]["points"]
    pts = r["traces"][0]["points"]
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        assert x0 == x1 or y0 == y1 or abs(x1 - x0) == abs(y1 - y0), (
            f"non-octilinear segment {(x0, y0)}->{(x1, y1)}"
        )


def test_octilinear_diagonal_is_exact_45() -> None:
    img = _wire([(20, 110), (120, 10)])  # dx == -dy: a true 45 degree run
    r = _oct(img, oct_delta_px=1.5)
    assert r["traces"], "no traces"
    pts = r["traces"][0]["points"]
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        assert x0 == x1 or y0 == y1 or abs(x1 - x0) == abs(y1 - y0), (
            f"non-octilinear segment {(x0, y0)}->{(x1, y1)}"
        )
    assert len(pts) <= 3, f"diagonal not straight: {pts}"


def test_octilinear_T_junction_one_group() -> None:
    img = _wire([(20, 100), (220, 100)])  # bus
    img2 = _wire([(110, 20), (110, 100)])  # stem drops onto the bus
    img = img | img2
    r = _oct(img, oct_delta_px=1.5)
    assert len(r["traces"]) >= 2, f"T junction lost arms: {r['stats']}"
    groups = {t["group"] for t in r["traces"]}
    assert len(groups) == 1, f"T should be ONE group, got {groups}"


def test_octilinear_ring_is_closed_cycle_one_group() -> None:
    img = _blank(160, 240)
    cv2.rectangle(img, (30, 30), (200, 120), (200, 200, 200), 6)  # closed ring
    r = _oct(img, oct_delta_px=1.5)
    assert r["traces"], "ring produced no traces"
    assert len(r["traces"]) == 1, f"ring split: {[(len(t['points'])) for t in r['traces']]}"
    t = r["traces"][0]
    assert t["points"][0] == t["points"][-1], "cycle not closed"


def test_octilinear_irregular_flag_for_non_octilinear_draw() -> None:
    # a corridor drawn at ~30 deg (not octilinear, deviation > delta)
    img = _wire([(20, 130), (160, 60)], thick=8)  # dy=-70 over dx=140: 27 deg
    r = _oct(img, oct_delta_px=0.75)
    assert r["traces"], "no traces"
    assert any(t.get("irregular") for t in r["traces"]), (
        "30-deg trace should stay raw with irregular=True"
    )


def test_octilinear_stats_report_irregular_count() -> None:
    img = _wire([(20, 130), (160, 60)], thick=8)
    r = _oct(img, oct_delta_px=0.75)
    assert r["stats"]["irregular"] >= 1


def main() -> int:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"ok   {t.__name__}")
        except AssertionError as exc:
            failed += 1
            print(f"FAIL {t.__name__}: {exc}")
    print(f"{len(tests) - failed}/{len(tests)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
