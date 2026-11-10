"""Subprocess entry for the whole-die decode (`/vectorize/decode`).

The global decode of a die-sized mask takes minutes of dense CPU work
(skeletonize on tens of megapixels). Running it in a child process lets the
sidecar CANCEL it for real (terminate) when the user presses Stop — the
in-process version could not be interrupted mid-`skeletonize` and kept
burning CPU for many minutes after the client went away.

Contract: `python decode_worker.py <spec.json>` where spec holds
{"mask": <png path>, "out": <result json path>, "params": {...}}. The
worker writes the decode result (or {"error": ...}) to `out` and exits 0.

Progress: when spec carries `progress_path`, the worker continuously writes
{"stage", "pct", "elapsed_ms", "eta_ms", "stage_ms"} there — stage
transitions come from decode_mask's callback, a 2 s ticker keeps elapsed/eta
fresh INSIDE the minutes-long skeletonize stage, and `stage_ms` accumulates
each stage's real duration so the NEXT run calibrates its percent weights
against this machine's actual speed.
"""
from __future__ import annotations

import json
import sys
import threading
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# Default percent weights when no previous run calibrated them (share of
# wall time each stage historically takes on a dense die).
DEFAULT_STAGE_MS = {
    "read": 4.0,
    "widthmap": 3.0,
    "skeletonize": 55.0,
    "graph": 20.0,
    "runs": 8.0,
    "outlines": 8.0,
    "write": 2.0,
}


class ProgressWriter:
    """Atomic progress.json writer, self-calibrating from the previous run.

    `writer(stage)` is called at stage START; the previous stage's duration
    lands in stage_ms. A daemon ticker re-writes the file every ~2 s so
    elapsed/eta move even inside one long stage (skeletonize). pct = share
    of calibrated weight completed + time-fraction of the current stage.
    """

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._lock = threading.Lock()
        self._t0 = time.monotonic()
        self._stage = "queued"
        self._stage_start = time.monotonic()
        self._stage_ms: dict[str, float] = {}
        self._done = False
        try:
            prev = json.loads(self.path.read_text(encoding="utf-8"))
            prev_ms = prev.get("stage_ms") or {}
        except Exception:  # noqa: BLE001 — first run / unreadable: defaults
            prev_ms = {}

        # Calibration: the previous run's real per-stage durations (this
        # file is written next to the payload — a re-decode of the same die
        # size on the same machine is a good speed prior). Keep the DEFAULT
        # weight for any stage the previous run never reached: merging only
        # the recorded stages starved the unseen ones down to weight 0 —
        # right after skeletonize pct jumped to 100% with eta 0 ("0:00 left"
        # forever) while "graph" was still grinding for minutes.
        weights = {
            k: float(prev_ms.get(k) or DEFAULT_STAGE_MS[k])
            for k in DEFAULT_STAGE_MS
        }
        # Clamp every stage to a sane share of the bar (2%..40% of total):
        # one gigantic measured stage (e.g. a lucky-fast skeletonize on a
        # sparse die next to a heavy unmeasured "graph") otherwise pushes
        # everything else to ~0 weight and freezes the bar at 99.9% with
        # eta ~0 s while decode grinds on for tens of minutes.
        for _ in range(4):
            total_w = sum(weights.values()) or 1.0
            lo, hi = total_w / 50.0, total_w * 0.4
            weights = {k: min(max(v, lo), hi) for k, v in weights.items()}
        self._weights = weights
        self._total_w = sum(weights.values()) or 1.0
        self._thread = threading.Thread(target=self._tick, daemon=True)
        self._thread.start()

    def _elapsed_in_stage(self, now: float) -> float:
        return (now - self._stage_start) * 1000.0

    def _pct(self, now: float) -> float:
        done_w = sum(self._weights.get(s, 0.0) for s in self._stage_ms)
        w = self._weights.get(self._stage, 0.0)
        frac = 0.0
        if w > 0.0:
            frac = min(1.0, self._elapsed_in_stage(now) / w)
        return 100.0 * min(1.0, (done_w + frac * w) / self._total_w)

    def _flush_locked(self) -> None:
        now = time.monotonic()
        elapsed = (now - self._t0) * 1000.0
        pct = 100.0 if self._done else self._pct(now)
        eta = None
        if not self._done and pct > 1.0:
            eta = max(0.0, elapsed / pct * (100.0 - pct))
        payload = {
            "stage": "done" if self._done else self._stage,
            "pct": round(pct, 1),
            "elapsed_ms": round(elapsed),
            "eta_ms": None if eta is None else round(eta),
            "stage_ms": {k: round(v) for k, v in self._stage_ms.items()},
        }
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(self.path.suffix + f".{id(self)}.tmp")
            tmp.write_text(json.dumps(payload), encoding="utf-8")
            tmp.replace(self.path)
        except Exception:  # noqa: BLE001 — progress is best-effort
            pass

    def _tick(self) -> None:
        while not self._done:
            time.sleep(2.0)
            if self._done:
                break
            with self._lock:
                self._flush_locked()

    def __call__(self, stage: str) -> None:
        now = time.monotonic()
        with self._lock:
            if self._stage != "queued":
                self._stage_ms[self._stage] = self._stage_ms.get(self._stage, 0.0) + (
                    now - self._stage_start
                ) * 1000.0
            self._stage = stage
            self._stage_start = now
            self._flush_locked()

    def finish(self, ok: bool = True) -> None:
        now = time.monotonic()
        with self._lock:
            if self._stage != "queued":
                self._stage_ms[self._stage] = self._stage_ms.get(self._stage, 0.0) + (
                    now - self._stage_start
                ) * 1000.0
            self._stage = "done" if ok else "error"
            self._done = True
            self._flush_locked()


def main() -> int:
    spec_path = sys.argv[1]
    with open(spec_path, "r", encoding="utf-8") as fh:
        spec = json.load(fh)
    out_path = spec["out"]
    progress = ProgressWriter(spec["progress_path"]) if spec.get("progress_path") else None
    try:
        import cv2
        import numpy as np

        from vectorize import VectorParams, decode_mask

        if progress:
            progress("read")
        m = cv2.imread(spec["mask"], cv2.IMREAD_GRAYSCALE)
        if m is None:
            raise ValueError("could not read mask png")
        p = VectorParams(
            min_len=int(spec["params"].get("min_len", 14)),
            width_min=float(spec["params"].get("width_min", 0.0)),
            width_max=float(spec["params"].get("width_max", 0.0)),
            decoder=spec["params"].get("decoder", "runs"),
            oct_delta_px=float(spec["params"].get("oct_delta_px", 0.0)),
            oct_strict=bool(spec["params"].get("oct_strict", False)),
        )
        result = decode_mask((m > 127).astype(np.uint8), p, progress=progress)
        result["stats"]["coverage"] = round(float((m > 127).sum()) / m.size, 4)
        if progress:
            progress("write")
        with open(out_path, "w", encoding="utf-8") as fh:
            json.dump(result, fh)
        # Save-to: the sweep passes the cache dir's full.json path. Writing
        # HERE means the payload survives even if the Node backend dies
        # mid-decode (app closed / killed) — the next sweep start or block
        # read picks the cache up instead of re-decoding for 6 minutes.
        save_to = spec.get("save_to")
        if save_to:
            try:
                save_path = Path(save_to)
                save_path.parent.mkdir(parents=True, exist_ok=True)
                tmp = Path(str(save_path) + ".tmp")
                with open(tmp, "w", encoding="utf-8") as fh:
                    json.dump(result, fh)
                tmp.replace(save_path)
            except Exception:  # noqa: BLE001 — backend still gets the payload
                pass
        if progress:
            progress.finish(ok=True)
        return 0
    except Exception:  # noqa: BLE001 — full traceback into the result file
        try:
            with open(out_path, "w", encoding="utf-8") as fh:
                json.dump({"error": traceback.format_exc()[-2000:]}, fh)
        except Exception:  # noqa: BLE001
            pass
        if progress:
            progress.finish(ok=False)
        return 1


if __name__ == "__main__":
    sys.exit(main())
