"""Classical metal vectorization (no model): threshold → clean → decode.

The tuning-first alternative to the ML trace channel: pick a brightness or
colour channel of the source crop, band-pass it into a binary metal mask,
clean speckle/bridges morphologically, and decode the SAME skeleton traces
the ML path produces — plus the mask outlines, so the user sees exactly what
their threshold captured while tuning. Everything downstream (endpoint snap
to contacts, fragment stitching, traces→nets) is shared with the ML pipeline.
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from heatmap import extract_trace_polylines
from polygon_axis import extract_polygon_axis
from wire_runs import extract_wire_runs

@dataclass
class VectorParams:
    channel: str = "gray"          # gray | r | g | b
    invert: bool = False           # select DARK pixels instead of bright
    thresh_low: int = 120          # band-pass on the channel value (0..255)
    thresh_high: int = 255         # 255 = no upper cut
    adaptive: bool = False         # local gaussian threshold instead of band
    adaptive_block: int = 51       # odd neighbourhood size
    adaptive_c: int = 8            # subtracted from the local mean
    open_px: int = 1               # speckle-removal radius
    bridge_px: int = 2             # gap-bridging radius
    min_len: int = 14              # min skeleton branch length (px)
    width_min: float = 1.5         # keep branches with median width in range
    width_max: float = 0.0         # 0 = no upper bound
    max_outlines: int = 4000       # cap on the preview outline count
    decoder: str = "runs"          # "runs" (skeleton, default) | "octilinear"
    oct_delta_px: float = 0.0      # 0 = auto (max(0.75, width_min/2))
    oct_strict: bool = False       # reserved: hard octilinear mode (L3), not implemented yet
    preprocess: "PreprocessParams" = None  # P2-3: set by the handlers


@dataclass
class PreprocessParams:
    """P2-3: optional pre-threshold image conditioning (applied to the crop
    BEFORE the channel extraction: tone LUT → median denoise → CLAHE →
    unsharp). All values neutral at 0 / 1 respectively; each stage skips
    when neutral so the default is a strict no-op."""
    brightness: float = 0.0        # tone offset, -100..100 (8-bit levels)
    contrast: float = 1.0          # factor around mid-gray, 0..2
    gamma: float = 1.0             # exponent, 0.2..5 (1 = neutral)
    shadows: float = 0.0           # shadow lift 0..100
    highlights: float = 0.0        # highlight compression 0..100
    clahe_clip: float = 0.0        # clip limit 0..10; 0 = off
    clahe_tiles: int = 8           # tile grid 1..16
    sharpen_amount: float = 0.0    # unsharp amount 0..200 (%)
    sharpen_radius: float = 1.0    # unsharp radius, px 0.5..5
    denoise_median: int = 0        # median radius px, 0 = off

    def neutral(self) -> bool:
        return (
            self.brightness == 0 and self.contrast == 1 and self.gamma == 1
            and self.shadows == 0 and self.highlights == 0 and self.clahe_clip <= 0
            and self.sharpen_amount <= 0 and self.denoise_median <= 0
        )


def _camel_to_snake(key: str) -> str:
    """claheClip → clahe_clip (the shared TS type is camelCase; the dataclass
    is snake_case — accept BOTH spellings so a knob can never silently fall
    back to neutral because of a key mismatch: that is exactly what used to
    hide CLAHE / sharpen / denoise while the tone knobs 'worked' by luck of
    one-word names being case-insensitive)."""
    out = []
    for ch in key:
        if ch.isupper():
            out.append("_")
            out.append(ch.lower())
        else:
            out.append(ch)
    return "".join(out)


def parse_preprocess(raw) -> PreprocessParams:
    """Clamp an untrusted preprocess dict (JSON) into the ranges below —
    the sidecar never second-guesses the caller once these pass. Accepts
    camelCase AND snake_case keys (see _camel_to_snake)."""
    raw = raw if isinstance(raw, dict) else {}
    raw = {_camel_to_snake(str(k)): v for k, v in raw.items()}
    def num(key, fallback, lo, hi):
        try:
            v = float(raw.get(key, fallback))
        except (TypeError, ValueError):
            v = fallback
        if not (v == v):  # NaN guard
            v = fallback
        return max(lo, min(hi, v))
    return PreprocessParams(
        brightness=num("brightness", 0.0, -100, 100),
        contrast=num("contrast", 1.0, 0, 2),
        gamma=num("gamma", 1.0, 0.2, 5),
        shadows=num("shadows", 0.0, 0, 100),
        highlights=num("highlights", 0.0, 0, 100),
        clahe_clip=num("clahe_clip", 0.0, 0, 10),
        clahe_tiles=int(max(1, min(16, num("clahe_tiles", 8, 1, 16)))),
        sharpen_amount=num("sharpen_amount", 0.0, 0, 200),
        sharpen_radius=num("sharpen_radius", 1.0, 0.5, 5),
        denoise_median=int(max(0, min(5, num("denoise_median", 0, 0, 5)))),
    )


def apply_preprocess(rgb: np.ndarray, pp: PreprocessParams) -> np.ndarray:
    """Pre-threshold conditioning of the crop (P2-3). Cheap on purpose:
    the whole tonal cascade is ONE 256-entry LUT over the RGB, then the
    local ops (median / CLAHE / unsharp) only when their knobs are open.
    Pushed to runVectorize's crop path + the sweep's per-block mask crops,
    so live region decodes, whole-die blocks and trace-region crops all
    see the same preprocessed pixels."""
    if pp is None or pp.neutral():
        return rgb

    # ── 1. One composed tone LUT (per-value, identical across channels) ──
    x = np.arange(256, dtype=np.float32)
    t = x / 255.0
    out = x + pp.brightness                    # brightness offset
    out = (out - 127.5) * pp.contrast + 127.5  # contrast around mid-gray
    if abs(pp.gamma - 1.0) > 1e-3:
        # clamp to [0,1] BEFORE pow — out may be out of range until now.
        safe = np.clip(out / 255.0, 0.0, 1.0)
        out = 255.0 * np.power(safe, 1.0 / pp.gamma)
    if pp.shadows > 0:
        out = out + (pp.shadows / 100.0) * (1.0 - t) ** 2 * (255.0 - x)
    if pp.highlights > 0:
        out = out - (pp.highlights / 100.0) * t ** 2 * x
    lut = np.clip(np.round(out), 0, 255).astype(np.uint8)
    img = cv2.LUT(rgb, lut)

    # ── 2. Median denoise (odd kernel) ──────────────────────────────────
    if pp.denoise_median > 0:
        img = cv2.medianBlur(img, 2 * int(pp.denoise_median) + 1)

    # ── 3. CLAHE — per channel, equalizes metal-vs-background contrast ──
    if pp.clahe_clip > 0:
        tiles = max(1, int(pp.clahe_tiles))
        clahe = cv2.createCLAHE(clipLimit=float(pp.clahe_clip), tileGridSize=(tiles, tiles))
        img = cv2.merge([clahe.apply(img[:, :, i]) for i in range(3)])

    # ── 4. Unsharp mask (last — sharpness must survive the denoise) ─────
    if pp.sharpen_amount > 0:
        amount = min(2.0, pp.sharpen_amount / 100.0)
        sigma = max(0.3, float(pp.sharpen_radius) / 2.0)
        ksize = int(6 * sigma + 1) | 1  # odd, cover ~3σ
        blur = cv2.GaussianBlur(img, (ksize, ksize), sigma)
        img = cv2.addWeighted(img, 1.0 + amount, blur, -amount, 0)

    return img


def _channel_image(rgb: np.ndarray, channel: str) -> np.ndarray:
    """uint8 single-channel view of the crop."""
    if channel == "r":
        return np.ascontiguousarray(rgb[:, :, 0])
    if channel == "g":
        return np.ascontiguousarray(rgb[:, :, 1])
    if channel == "b":
        return np.ascontiguousarray(rgb[:, :, 2])
    # Rec.601 luma — reads as "brightness" for SEM grayscale as well.
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)


def _empty(w: int, h: int) -> dict:
    return {"traces": [], "outlines": [], "width": int(w), "height": int(h)}


def mask_pad_px(p: VectorParams) -> int:
    """Crop padding that makes the mask EXACT inside the core: every op that
    reaches beyond a pixel (morphology kernels, adaptive gaussian block, the
    P2-3 preprocess's median/unsharp radii — they run BEFORE the mask) is
    covered, so block-assembled masks are pixel-identical to a whole-image
    decode — no tile seams by construction."""
    import math
    pp = p.preprocess if p.preprocess is not None else PreprocessParams()
    return max(
        int(p.open_px),
        int(p.bridge_px),
        math.ceil(int(p.adaptive_block) / 2),
        int(pp.denoise_median),
        math.ceil(pp.sharpen_radius * 3),
    ) + 2


def build_mask(rgb: np.ndarray, p: VectorParams) -> np.ndarray:
    """Threshold → clean: the binary metal mask (uint8 0/1) of the crop."""
    ch = _channel_image(rgb, p.channel)

    # ── Binary metal mask ────────────────────────────────────────────
    if p.adaptive:
        block = max(3, int(p.adaptive_block) | 1)  # force odd
        flag = cv2.THRESH_BINARY_INV if p.invert else cv2.THRESH_BINARY
        binary = cv2.adaptiveThreshold(
            ch, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, flag, block, max(0, int(p.adaptive_c))
        ) > 0
    else:
        lo = max(0, min(255, int(p.thresh_low)))
        hi = max(lo, min(255, int(p.thresh_high)))
        band = (ch >= lo) & (ch <= hi)
        binary = (~band) if p.invert else band

    if not binary.any():
        return np.zeros(binary.shape, dtype=np.uint8)

    # ── Morphological cleanup ────────────────────────────────────────
    bin_u8 = binary.astype(np.uint8)
    if p.open_px > 0:
        k = cv2.getStructuringElement(cv2.MORPH_RECT, (2 * p.open_px + 1,) * 2)
        bin_u8 = cv2.morphologyEx(bin_u8, cv2.MORPH_OPEN, k)
    if p.bridge_px > 0:
        # RECT (not ellipse): must match the bridging behaviour of the
        # skeleton decoder in heatmap.py — elliptical kernels under-bridge.
        k = cv2.getStructuringElement(cv2.MORPH_RECT, (2 * p.bridge_px + 1,) * 2)
        bin_u8 = cv2.morphologyEx(bin_u8, cv2.MORPH_CLOSE, k)
    return bin_u8


def decode_mask(mask_u8: np.ndarray, p: VectorParams, progress=None) -> dict:
    """Runs decode of a binary mask: traces (grouped) + outlines + stats.

    `progress(stage)` — optional whole-die decode progress callback; the
    worker in decode_worker.py turns stage transitions + per-stage durations
    into the progress.json the sweep's UI reads."""
    h, w = mask_u8.shape[:2]
    if not mask_u8.any():
        return _empty(w, h)
    binary = mask_u8.astype(bool)

    # Width map: distance transform of the mask ×2 — every pixel's value is
    # then the local wire width (distance-to-edge ≈ half width).
    if progress:
        progress("widthmap")
    dist = cv2.distanceTransform(mask_u8, cv2.DIST_L2, 3) * 2.0

    # Strength = depth inside the band — a cheap score proxy the client's
    # existing trace-confidence slider can filter on.
    lo = max(0, min(255, int(p.thresh_low)))
    hi = max(lo, min(255, int(p.thresh_high)))
    lo_f, hi_f = lo / 255.0, max(hi, lo + 1) / 255.0
    # NB: mask-only decode has no channel values; score = 1 inside the mask
    # unless the caller provides strength (live path passes it separately).
    strength = None

    if p.decoder == "octilinear":
        runs = extract_polygon_axis(
            binary.astype(np.float32),
            threshold=0.5,
            min_len=max(2, int(p.min_len)),
            delta_px=float(p.oct_delta_px),
            width_map=dist,
            width_min=p.width_min,
            width_max=p.width_max,
            score_map=strength,
            progress=progress,
        )
    else:
        runs = extract_wire_runs(
            binary.astype(np.float32),
            threshold=0.5,
            min_len=max(2, int(p.min_len)),
            width_map=dist,
            width_min=p.width_min,
            width_max=p.width_max,
            score_map=strength,
            progress=progress,
        )

    # Outlines: v1 contour polylines of the cleaned mask — the "what did my
    # threshold capture" preview the user tunes against.
    if progress:
        progress("outlines")
    outlines = extract_trace_polylines(
        binary.astype(np.float32),
        threshold=0.5,
        epsilon=1.5,
        min_len=max(6, int(p.min_len) // 2),
        max_polylines=max(1, int(p.max_outlines)),
    )
    return {
        "traces": runs["traces"],
        "outlines": [o["points"] for o in outlines],
        "stats": {
            "kept": runs["stats"]["kept"],
            "dropped_width": runs["stats"]["dropped_width"],
            "dropped_short": runs["stats"]["dropped_short"],
            "merged": runs["stats"]["merged"],
            "irregular": runs["stats"].get("irregular", 0),
        },
        "width": int(w),
        "height": int(h),
    }


def vectorize_region(rgb: np.ndarray, p: VectorParams) -> dict:
    """Threshold → clean → decode. Returns traces + outline polylines in
    crop-local pixel coords (Node translates them to source coords)."""
    h, w = rgb.shape[:2]
    ch = _channel_image(rgb, p.channel)
    mask_u8 = build_mask(rgb, p)
    result = decode_mask(mask_u8, p)
    if result["traces"] or result["outlines"]:
        # Score: depth inside the band — brightness margin per trace.
        if p.adaptive:
            strength_full = ch.astype(np.float32) / 255.0
        else:
            lo = max(0, min(255, int(p.thresh_low)))
            hi = max(lo, min(255, int(p.thresh_high)))
            lo_f, hi_f = lo / 255.0, max(hi, lo + 1) / 255.0
            norm = (ch.astype(np.float32) / 255.0 - lo_f) / (hi_f - lo_f)
            strength_full = np.clip((1.0 - norm) if p.invert else norm, 0.0, 1.0)
        for t in result["traces"]:
            pts = t["points"]
            xs = np.array([pt[0] for pt in pts])
            ys = np.array([pt[1] for pt in pts])
            sel = strength_full[ys, xs]
            t["score"] = round(float(sel.mean()) if sel.size else 0.0, 4)
    result["width"] = int(w)
    result["height"] = int(h)
    return result
