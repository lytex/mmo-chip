"""ML HTTP sidecar.

Stateless-per-request inference service with the U-Net resident in memory.
The Node backend proxies to this; the browser never talks to it directly.

Run:
    python sidecar.py --checkpoint checkpoints/model.pt --port 8001

Step 1 surface: /health + model-load-on-boot. Prediction / training endpoints
are added in later steps; the module is structured so they slot into STATE.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import math
import os

# Prefer a responsive desktop over maximum single-job throughput.
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("NUMEXPR_NUM_THREADS", "1")
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import cv2
import numpy as np
import torch
import uvicorn
from fastapi import FastAPI, File, Form, Header, HTTPException, Response, UploadFile
from pydantic import BaseModel

from augment import normalize_only
from cv_match import akaze_verify_matches, akaze_debug_matches, match_contour_pipeline, match_template_pipeline
from heatmap import extract_components, extract_peaks, extract_trace_skeleton
from model import build_model, infer_num_classes
from tiling import tile_predict
from trainer import TrainParams, run_training
from vectorize import (
    PreprocessParams,
    VectorParams,
    apply_preprocess,
    build_mask,
    decode_mask,
    mask_pad_px,
    parse_preprocess,
    vectorize_region,
)

# Running whole-die decode subprocesses (job_id -> Popen) — cancelled by
# POST /vectorize/decode/cancel when the sweep's Stop button fires.
DECODE_JOBS: dict[str, "subprocess.Popen"] = {}
DECODE_JOBS_LOCK = threading.Lock()
# save_to (full.json path) -> job_id of the in-flight decode — a repeated
# sweep start (double click / retried POST) must JOIN the running worker,
# not spawn a second CPU-eating twin over the same mask.
DECODE_SAVE_TO: dict[str, str] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()

_NORM_TF = normalize_only()


def _normalize(tile_uint8_rgb: np.ndarray) -> torch.Tensor:
    return _NORM_TF(image=tile_uint8_rgb)["image"]

ML_DIR = Path(__file__).resolve().parent


def auto_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    if hasattr(torch, "xpu") and torch.xpu.is_available():
        return "xpu"
    try:
        import torch_directml
        return str(torch_directml.device())
    except ImportError:
        return "cpu"


def checkpoint_hash(path: Path) -> str:
    """Stable short hash of the checkpoint file content. Drives Node cache keys —
    a retrained model produces a new hash, so cached predictions auto-invalidate."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:12]


@dataclass
class ModelState:
    device: str = field(default_factory=auto_device)
    data_root: Path = ML_DIR.parent / "data"
    checkpoint_path: Path | None = None
    checkpoint_hash: str | None = None
    encoder: str = "resnet18"
    num_classes: int = 1
    model: torch.nn.Module | None = None
    model_loaded: bool = False
    training_active: bool = False
    # Trace-channel decode: binarize lower than the via peak threshold — an
    # under-trained trace mask dips along wires, and a 0.5 cut fragments the
    # skeleton into disjoint segments.
    trace_threshold: float = 0.35
    # Serializes GPU work. Step 1 doesn't use it yet; later steps (predict /
    # train) acquire this so concurrent tile requests don't race the device.
    lock: threading.Lock = field(default_factory=threading.Lock)

    def load(self, checkpoint_path: Path) -> None:
        if not checkpoint_path.exists():
            self.checkpoint_path = checkpoint_path
            self.model = None
            self.model_loaded = False
            self.checkpoint_hash = None
            print(f"[sidecar] no checkpoint at {checkpoint_path} — running unloaded")
            return
        try:
            ckpt = torch.load(checkpoint_path, map_location=self.device, weights_only=False)
            encoder = ckpt.get("encoder", "resnet18")
            n_classes = infer_num_classes(ckpt["model_state"])
            model = build_model(encoder_name=encoder, encoder_weights=None,
                                classes=n_classes).to(self.device)
            model.load_state_dict(ckpt["model_state"])
            model.eval()
        except Exception as exc:  # noqa: BLE001 — degrade gracefully, never crash boot
            self.model = None
            self.model_loaded = False
            self.checkpoint_path = checkpoint_path
            self.checkpoint_hash = None
            print(f"[sidecar] failed to load {checkpoint_path}: {exc} — running unloaded")
            return
        self.model = model
        self.encoder = encoder
        self.num_classes = n_classes
        self.checkpoint_path = checkpoint_path
        self.checkpoint_hash = checkpoint_hash(checkpoint_path)
        self.model_loaded = True
        print(f"[sidecar] loaded {checkpoint_path} ({encoder}, {n_classes} classes) "
              f"hash={self.checkpoint_hash} device={self.device}")


STATE = ModelState()

# The checkpoint last loaded successfully, so a sidecar restart (e.g. `npm run
# dev`) comes back on the model the user picked instead of the CLI default.
# Node keys its prediction cache by checkpoint hash, so coming up on a
# different model makes every cached via "disappear" from the UI.
RESIDENT_FILE = ML_DIR / "checkpoints" / ".resident"


def remember_resident(path: Path) -> None:
    try:
        RESIDENT_FILE.parent.mkdir(parents=True, exist_ok=True)
        RESIDENT_FILE.write_text(str(path.resolve()) + "\n", encoding="utf-8")
    except OSError as exc:
        print(f"[sidecar] could not record resident checkpoint: {exc}")


def recall_resident() -> Path | None:
    try:
        raw = RESIDENT_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    p = Path(raw)
    return p if raw and p.exists() else None


@dataclass
class JobRecord:
    job_id: str
    kind: str  # "train" | "predict_die"
    status: str  # "running" | "done" | "error"
    epochs: int = 0
    epoch: int = 0
    loss: float | None = None
    checkpoint_path: str | None = None
    error: str | None = None
    cancel: bool = False
    started_at: str = field(default_factory=_now)
    updated_at: str = field(default_factory=_now)

    def as_dict(self) -> dict:
        # NaN/inf are not valid JSON — surface them as null so the Node/UI
        # contract is always parseable (a diverged run shows loss: null).
        loss = self.loss if (self.loss is not None and math.isfinite(self.loss)) else None
        return {
            "job_id": self.job_id,
            "kind": self.kind,
            "status": self.status,
            "epoch": self.epoch,
            "epochs": self.epochs,
            "loss": loss,
            "checkpoint_path": self.checkpoint_path,
            "error": self.error,
            "started_at": self.started_at,
            "updated_at": self.updated_at,
        }


JOBS: dict[str, JobRecord] = {}
JOBS_LOCK = threading.Lock()


class TrainBody(BaseModel):
    data_dir: str
    epochs: int = 50  # snappier than the CLI default (200) for the retrain loop
    encoder: str = "resnet18"
    lr: float = 1e-3
    crop_size: int = 256
    steps_per_epoch: int = 100
    batch_size: int = 8
    output: str | None = None  # defaults to the resident checkpoint path


class ReloadBody(BaseModel):
    checkpoint_path: str




# CV resource safety: keep the desktop responsive on large die images.
# All heavy CV endpoints share one gate; the job layer will provide queueing/cancel.
CV_OPENCV_THREADS = max(1, int(os.getenv("CV_OPENCV_THREADS", "1")))
CV_TORCH_THREADS = max(1, int(os.getenv("CV_TORCH_THREADS", "1")))
CV_TORCH_INTEROP_THREADS = max(1, int(os.getenv("CV_TORCH_INTEROP_THREADS", "1")))
CV_GATE_WAIT_SECONDS = max(0.0, float(os.getenv("CV_GATE_WAIT_SECONDS", "0.25")))
CV_RESOURCE_GATE = threading.BoundedSemaphore(1)
CANCELLED_CV_JOBS: set[str] = set()
CV_JOB_PROGRESS: dict[str, dict] = {}

try:
    cv2.setNumThreads(CV_OPENCV_THREADS)
except Exception:
    pass
try:
    torch.set_num_threads(CV_TORCH_THREADS)
    torch.set_num_interop_threads(CV_TORCH_INTEROP_THREADS)
except Exception:
    # PyTorch may reject changing inter-op threads after work has started.
    pass


def cv_resource_guard(fn):
    """Serialize heavy CV requests and fail fast instead of freezing the host."""
    from functools import wraps

    @wraps(fn)
    def guarded(*args, **kwargs):
        acquired = CV_RESOURCE_GATE.acquire(timeout=CV_GATE_WAIT_SECONDS)
        if not acquired:
            raise HTTPException(
                status_code=429,
                detail={
                    "code": "cv_busy",
                    "message": "Another CV operation is already using the resource budget",
                },
            )
        try:
            return fn(*args, **kwargs)
        except MemoryError as exc:
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "resource_exhausted",
                    "message": "CV operation exceeded the available memory budget",
                },
            ) from exc
        finally:
            CV_RESOURCE_GATE.release()

    return guarded

app = FastAPI(title="chiptool-ml-sidecar")


def _infer_via_layer(checkpoint_path: Path | None) -> str | None:
    """Infer via layer id from checkpoint filename convention.
    E.g. via12_model.pt → VIA12, via23_2026-07.pt → VIA23.
    Returns None when the filename doesn't match the pattern.
    """
    if checkpoint_path is None:
        return None
    name = checkpoint_path.stem.lower()
    # Match patterns like via12, via23, etc.
    import re
    m = re.search(r"via(\d+)", name)
    if m:
        return f"VIA{m.group(1)}"
    return None


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "device": STATE.device,
        "checkpoint": STATE.checkpoint_path.name if STATE.checkpoint_path else None,
        "checkpoint_hash": STATE.checkpoint_hash,
        "encoder": STATE.encoder,
        "num_classes": STATE.num_classes,
        "model_loaded": STATE.model_loaded,
        "training_active": STATE.training_active,
        "via_layer": _infer_via_layer(STATE.checkpoint_path),
    }


@app.post("/predict/region")
def predict_region(
    image: UploadFile = File(...),
    threshold: float = Form(0.5),
    min_distance: int = Form(4),
    return_heatmap: bool = Form(False),
) -> dict:
    """Stateless: decode the posted crop, run the U-Net, return peaks in
    *crop-local* pixel coords. Node owns the source-coord translation,
    tile math, padding, filtering and caching. Sync endpoint so FastAPI
    runs it in a worker thread; STATE.lock serializes the single device."""
    if not STATE.model_loaded or STATE.model is None:
        raise HTTPException(status_code=503, detail="model not loaded")
    if STATE.training_active:
        raise HTTPException(status_code=503, detail="training")

    raw = image.file.read()
    arr = np.frombuffer(raw, dtype=np.uint8)
    bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if bgr is None:
        raise HTTPException(status_code=400, detail="could not decode image")
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    h, w = rgb.shape[:2]

    with STATE.lock:
        maps = tile_predict(
            STATE.model, rgb,
            tile_size=512, overlap=64,
            device=STATE.device, batch_size=4,
            normalize=_normalize,
        )  # (C, H, W) — C=1 (old vias-only model) or C=3 (multi-class)
    n_ch = maps.shape[0]
    ch0 = maps[0]
    ch1 = maps[1] if n_ch >= 2 else None
    ch2 = maps[2] if n_ch >= 3 else None

    peaks = extract_peaks(ch0, threshold=threshold, min_distance=min_distance)
    resp: dict = {
        "point_vias": [{"x": int(x), "y": int(y), "score": float(s)} for (x, y, s) in peaks],
        "irregular_vias": extract_components(ch1, threshold=threshold) if ch1 is not None else [],
        "traces": extract_trace_skeleton(
            ch2, threshold=STATE.trace_threshold, bridge_px=2
        ) if ch2 is not None else [],
        "width": w,
        "height": h,
        "num_classes": n_ch,
        "checkpoint_hash": STATE.checkpoint_hash,
    }
    if return_heatmap:
        # Raw sigmoid maps → RGB PNG: R=point_via, G=irregular_via, B=trace.
        # 1-class model → point_via in R, G/B zero. Node crops to the exact
        # tile; frontend colorizes / splits channels.
        zeros = np.zeros_like(ch0)
        rgb_hm = np.stack([
            np.clip(ch0 * 255.0, 0, 255),
            np.clip((ch1 if ch1 is not None else zeros) * 255.0, 0, 255),
            np.clip((ch2 if ch2 is not None else zeros) * 255.0, 0, 255),
        ], axis=-1).astype(np.uint8)
        ok, png = cv2.imencode(".png", cv2.cvtColor(rgb_hm, cv2.COLOR_RGB2BGR))
        if not ok:
            raise HTTPException(status_code=500, detail="heatmap encode failed")
        resp["heatmap_png_b64"] = base64.b64encode(png.tobytes()).decode("ascii")
    return resp


@app.post("/vectorize/region")
@cv_resource_guard
def vectorize_region_endpoint(
    image: UploadFile = File(...),
    channel: str = Form("gray"),
    invert: bool = Form(False),
    thresh_low: int = Form(120),
    thresh_high: int = Form(255),
    adaptive: bool = Form(False),
    adaptive_block: int = Form(51),
    adaptive_c: int = Form(8),
    open_px: int = Form(1),
    bridge_px: int = Form(2),
    min_len: int = Form(14),
    width_min: float = Form(1.5),
    width_max: float = Form(0.0),
    max_outlines: int = Form(4000),
    decoder: str = Form("runs"),
    oct_delta_px: float = Form(0.0),
    oct_strict: bool = Form(False),
    preprocess: str = Form("{}"),
) -> dict:
    """Classical (no-model) metal vectorization of the posted crop: threshold
    a brightness/colour channel into a mask, clean it, decode skeleton traces
    + mask outlines in *crop-local* pixel coords. Works without any checkpoint
    — the ML path and this path share only the decode stage. Serialized by
    the CV gate like the other heavy CV endpoints."""
    raw = image.file.read()
    arr = np.frombuffer(raw, dtype=np.uint8)
    bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if bgr is None:
        raise HTTPException(status_code=400, detail="could not decode image")
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)

    params = VectorParams(
        channel=channel if channel in ("gray", "r", "g", "b") else "gray",
        invert=invert,
        thresh_low=thresh_low,
        thresh_high=thresh_high,
        adaptive=adaptive,
        adaptive_block=adaptive_block,
        adaptive_c=adaptive_c,
        open_px=open_px,
        bridge_px=bridge_px,
        min_len=min_len,
        width_min=width_min,
        width_max=width_max,
        max_outlines=max_outlines,
        decoder=decoder if decoder in ("runs", "octilinear") else "runs",
        oct_delta_px=oct_delta_px,
        oct_strict=oct_strict,
    )
    try:
        # P2-3: pre-threshold conditioning (tone LUT / denoise / CLAHE /
        # unsharp), applied to the crop before the channel extraction.
        import json as _json
        params.preprocess = parse_preprocess(_json.loads(preprocess) if preprocess else {})
        rgb = apply_preprocess(rgb, params.preprocess)
        return vectorize_region(rgb, params)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 — surface the cause, not a bare 500
        import traceback
        tail = traceback.format_exc().strip().splitlines()[-1]
        raise HTTPException(
            status_code=500, detail=f"vectorize failed: {exc} | {tail}"
        ) from exc


class MaskBody(BaseModel):
    channel: str = "gray"
    invert: bool = False
    thresh_low: int = 120
    thresh_high: int = 255
    adaptive: bool = False
    adaptive_block: int = 51
    adaptive_c: int = 8
    open_px: int = 1
    bridge_px: int = 2
    decoder: str = "runs"
    oct_delta_px: float = 0.0
    oct_strict: bool = False
    preprocess: dict = {}


def _params_from_mask_body(b: MaskBody) -> VectorParams:
    return VectorParams(
        channel=b.channel if b.channel in ("gray", "r", "g", "b") else "gray",
        invert=b.invert,
        thresh_low=b.thresh_low,
        thresh_high=b.thresh_high,
        adaptive=b.adaptive,
        adaptive_block=b.adaptive_block,
        adaptive_c=b.adaptive_c,
        open_px=b.open_px,
        bridge_px=b.bridge_px,
        decoder=b.decoder if b.decoder in ("runs", "octilinear") else "runs",
        oct_delta_px=b.oct_delta_px,
        oct_strict=b.oct_strict,
        preprocess=parse_preprocess(b.preprocess),
    )


@app.post("/vectorize/mask")
def vectorize_mask(image: UploadFile = File(...), body: str = Form(...)) -> dict:
    """Binary metal mask of the posted crop (whole-die sweep step 1). The
    backend assembles block masks into one seamless die-sized mask and
    decodes it ONCE — no tile seams by construction. Returns the mask as a
    base64 PNG (0/255). NB: intentionally NOT CV-gated — the sweep must not
    starve behind the user's live viewport decodes; masks are cheap."""
    import json as _json
    raw = image.file.read()
    arr = np.frombuffer(raw, dtype=np.uint8)
    bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if bgr is None:
        raise HTTPException(status_code=400, detail="could not decode image")
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    try:
        body = MaskBody(**_json.loads(body))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"bad mask params: {exc}") from exc
    maskParams = _params_from_mask_body(body)
    # P2-3: the mask must come from the SAME preprocessed pixels the live
    # region decode sees — apply before build_mask.
    rgb = apply_preprocess(rgb, maskParams.preprocess)
    mask = build_mask(rgb, maskParams)
    ok, png = cv2.imencode(".png", mask * 255)
    if not ok:
        raise HTTPException(status_code=500, detail="mask encode failed")
    return {
        "mask_png_b64": base64.b64encode(png.tobytes()).decode("ascii"),
        "width": int(mask.shape[1]),
        "height": int(mask.shape[0]),
        # Padding baked into this mask (see mask_pad_px): the caller crops
        # [pad .. width-pad] back to its core when assembling the die mask.
        "pad": mask_pad_px(maskParams),
    }


@app.post("/vectorize/preprocess")
def preprocess_endpoint(image: UploadFile = File(...), preprocess: str = Form("{}")) -> Response:
    """P2-3 preview: return ONLY the preprocessed crop as PNG. The vector
    layer blits it under the traces/outlines over the live viewport — the
    user tunes brightness/contrast/gamma/shadows/highlights/CLAHE/unsharp
    while SEEING the processed pixels instead of guessing from the overlay.
    Intentionally NOT CV-gated (like /vectorize/mask): the caller sends a
    downscaled crop (~≤1.2 Mpx), the cascade is one LUT + cheap local ops."""
    import json as _json
    raw = image.file.read()
    arr = np.frombuffer(raw, dtype=np.uint8)
    bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if bgr is None:
        raise HTTPException(status_code=400, detail="could not decode image")
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    try:
        pp = parse_preprocess(_json.loads(preprocess) if preprocess else {})
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"bad preprocess params: {exc}")
    out = apply_preprocess(rgb, pp)
    ok, png = cv2.imencode(".png", out)
    if not ok:
        raise HTTPException(status_code=500, detail="preview encode failed")
    return Response(content=png.tobytes(), media_type="image/png")


@app.post("/vectorize/decode")
def vectorize_decode(
    image: UploadFile = File(...),
    body: str = Form(...),
    job_id: str = Form(default=""),
) -> dict:
    """Whole-die decode (sweep step 2): runs decoder over the assembled
    seamless mask — grouped, spur-free, minimal-turn centreline traces.
    Intentionally NOT CV-gated: it runs for minutes and must not starve
    behind (or starve) the live viewport decodes; they coexist on CPU.
    Runs in a SUBPROCESS (ml/decode_worker.py): the heavy skeletonize call
    cannot be interrupted in-process, a child process can be terminated —
    `job_id` registers it for POST /vectorize/decode/cancel."""
    import json as _json
    raw = image.file.read()
    arr = np.frombuffer(raw, dtype=np.uint8)
    m = cv2.imdecode(arr, cv2.IMREAD_GRAYSCALE)
    if m is None:
        raise HTTPException(status_code=400, detail="could not decode mask")
    try:
        b = _json.loads(body)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"bad decode params: {exc}") from exc
    # Guard before spawning anything: a threshold that captures the
    # background (bright-field shots with a low threshLow) makes the mask
    # 90%+ white — decoding it is pointless and memory-lethal.
    coverage = float((m > 127).sum(dtype=np.int64)) / m.size
    if coverage > 0.7:
        raise HTTPException(
            status_code=400,
            detail=(
                f"threshold captures {coverage:.0%} of the die — that is background, "
                "not metal. Narrow the band (Thresh low/high) or use the pipette, "
                "then re-run the whole-die decode."
            ),
        )

    import json
    import subprocess
    import sys
    import tempfile
    import time
    import uuid

    jid = job_id or b.get("job_id") or f"decode-{uuid.uuid4().hex[:8]}"
    save_to = str(b["save_to"]) if b.get("save_to") else None
    tmp_dir = Path(tempfile.gettempdir())

    # Join-into-flight: another worker is already decoding the same target
    # (retried/double-started POST) — wait for ITS full.json instead of
    # spawning a twin that would halve (or worse) everyone's CPU share.
    with DECODE_JOBS_LOCK:
        existing_jid = DECODE_SAVE_TO.get(save_to) if save_to else None
        existing_proc = DECODE_JOBS.get(existing_jid) if existing_jid else None
    if existing_proc is not None and existing_proc.poll() is None:
        deadline_join = time.monotonic() + 3600  # same extended budget
        while True:
            if existing_proc.poll() is not None:
                break
            if time.monotonic() > deadline_join:
                raise HTTPException(status_code=499, detail="joined decode wait timed out")
            time.sleep(1.0)
        if save_to and Path(save_to).exists():
            try:
                joined = json.loads(Path(save_to).read_text(encoding="utf-8"))
            except Exception:
                joined = None
            if joined and "error" not in joined:
                return joined
        raise HTTPException(status_code=499, detail="joined decode failed — retry")

    mask_path = tmp_dir / f"mmochip_decode_{jid}.png"
    # DISTINCT filenames: the worker OVERWRITES its spec with the result,
    # so sharing one name used to make a killed worker's leftover SPEC read
    # back as a "successful" (trace-less) decode — the sweep then wrote a
    # poison-empty payload. `.result.json` cannot pre-exist as a spec.
    out_path = tmp_dir / f"mmochip_decode_{jid}.result.json"
    spec_path = tmp_dir / f"mmochip_decode_{jid}.spec.json"
    worker = Path(__file__).resolve().parent / "decode_worker.py"
    mask_path.write_bytes(raw)
    spec = {
        "mask": str(mask_path),
        "out": str(out_path),
        "params": {
            "min_len": b.get("min_len", 14),
            "width_min": b.get("width_min", 0.0),
            "width_max": b.get("width_max", 0.0),
            "decoder": b.get("decoder", "runs"),
            "oct_delta_px": b.get("oct_delta_px", 0.0),
            "oct_strict": b.get("oct_strict", False),
        },
    }
    if save_to:
        spec["save_to"] = save_to
    if b.get("progress_path"):
        # The worker writes live decode progress (stage/pct/eta) there; the
        # sweep backend reads the same file for its status endpoint.
        spec["progress_path"] = str(b["progress_path"])
        try:  # stale error dump of a previous attempt must not mislead
            Path(b["progress_path"]).with_name("decode-error.txt").unlink(missing_ok=True)
        except OSError:
            pass
    spec_path.write_text(json.dumps(spec), encoding="utf-8")
    proc = subprocess.Popen(
        [sys.executable, str(worker), str(spec_path)],
        cwd=str(worker.parent.parent),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    with DECODE_JOBS_LOCK:
        DECODE_JOBS[jid] = proc
        if save_to:
            DECODE_SAVE_TO[save_to] = jid
    deadline = time.monotonic() + 3600  # 60 min — die-sized "graph" stages
    # (pure corridor walk over tens of millions of skeleton px) measured
    # ~25 min ALONE on a 56 Mpx die; 30 min used to behead a run that was
    # otherwise healthy.
    try:
        while True:
            code = proc.poll()
            if code is not None:
                break
            if time.monotonic() > deadline:
                proc.terminate()
                raise HTTPException(status_code=500, detail="whole-die decode timed out (30 min)")
            time.sleep(1.0)
        if not out_path.exists():
            raise HTTPException(status_code=499, detail="whole-die decode cancelled")
        # Forensics: persist WHY a decode died next to the sweep's progress
        # file — the temp out file is unlinked below and the raw traceback
        # otherwise exists only in the worker's vanished stdout.
        def _dump_worker_error(text: str) -> None:
            pp = b.get("progress_path")
            if not pp:
                return
            try:
                Path(pp).with_name("decode-error.txt").write_text(text, encoding="utf-8")
            except OSError:
                pass
        try:
            result = json.loads(out_path.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            tail = ""
            try:
                tail = out_path.read_text(errors="ignore")[-800:]
            except Exception:  # noqa: BLE001 — gone or locked
                tail = "(out file unreadable)"
            _dump_worker_error(f"out file unreadable: {exc}\ntail: {tail}")
            raise HTTPException(status_code=500, detail=f"decode worker lost output: {exc}") from exc
        if "error" in result:
            _dump_worker_error(str(result["error"]))
            detail = str(result["error"]).strip().splitlines()[-1]
            raise HTTPException(status_code=500, detail=f"decode failed: {detail}")
        # Shape check: anything that parses but is not a decode result
        # (stale spec leftovers, truncated junk) must not reach the client
        # as success — an empty payload then poisons the frontend overlay.
        if "traces" not in result or "stats" not in result:
            _dump_worker_error(f"result shape invalid: keys={sorted(result)[:10]}")
            raise HTTPException(
                status_code=500,
                detail=f"decode worker lost output: result is not a decode payload (keys: {sorted(result)})"
            )
        return result
    finally:
        with DECODE_JOBS_LOCK:
            DECODE_JOBS.pop(jid, None)
            if save_to and DECODE_SAVE_TO.get(save_to) == jid:
                DECODE_SAVE_TO.pop(save_to, None)
        if proc.poll() is None:
            proc.terminate()
        for p in (mask_path, out_path, spec_path):
            try:
                p.unlink(missing_ok=True)
            except OSError:
                pass


@app.post("/vectorize/decode/cancel")
def vectorize_decode_cancel(job_id: str = Form(...)) -> dict:
    """Terminate a running whole-die decode subprocess (sweep Stop button).
    The parent's in-flight decode request then returns 499 'cancelled'."""
    with DECODE_JOBS_LOCK:
        proc = DECODE_JOBS.get(job_id)
    if proc is None or proc.poll() is not None:
        return {"cancelled": False}
    proc.terminate()
    return {"cancelled": True}


def _train_worker(job: JobRecord, params: TrainParams, out: str) -> None:
    def on_epoch(ep: int, total: int, loss: float) -> None:
        with JOBS_LOCK:
            job.epoch = ep
            job.epochs = total
            job.loss = loss
            job.updated_at = _now()

    try:
        run_training(params, on_epoch=on_epoch,
                     should_stop=lambda: job.cancel, use_tqdm=False)
        # Auto-reload: new weights → new checkpoint_hash → Node caches invalidate.
        with STATE.lock:
            STATE.load(Path(out))
        with JOBS_LOCK:
            job.status = "done"
            job.checkpoint_path = out
            job.updated_at = _now()
    except Exception as exc:  # noqa: BLE001 — surface any failure to the job
        with JOBS_LOCK:
            job.status = "error"
            job.error = str(exc)
            job.updated_at = _now()
        print(f"[sidecar] train job {job.job_id} failed: {exc}")
    finally:
        STATE.training_active = False


@app.post("/train")
def train(body: TrainBody) -> dict:
    if STATE.training_active:
        raise HTTPException(status_code=409, detail="training already in progress")

    data_dir = Path(body.data_dir)
    if not data_dir.is_absolute():
        data_dir = STATE.data_root / body.data_dir
    if not data_dir.exists():
        raise HTTPException(status_code=400, detail=f"data_dir not found: {data_dir}")

    if body.output:
        out = body.output if Path(body.output).is_absolute() else str(ML_DIR / body.output)
    elif STATE.checkpoint_path:
        out = str(STATE.checkpoint_path)
    else:
        out = str(ML_DIR / "checkpoints" / "model.pt")

    job = JobRecord(job_id=uuid4().hex[:12], kind="train",
                    status="running", epochs=body.epochs)
    with JOBS_LOCK:
        JOBS[job.job_id] = job
    # Set before the thread starts so an immediate /predict gets 503.
    STATE.training_active = True

    params = TrainParams(
        data_dir=str(data_dir),
        epochs=body.epochs,
        batch_size=body.batch_size,
        lr=body.lr,
        crop_size=body.crop_size,
        steps_per_epoch=body.steps_per_epoch,
        encoder=body.encoder,
        output=out,
        device=STATE.device,
    )
    threading.Thread(target=_train_worker, args=(job, params, out), daemon=True).start()
    return {"job_id": job.job_id}


@app.get("/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="job not found")
        return job.as_dict()


def _scan_checkpoints(ckpt_dir: Path) -> list[Path]:
    """Return sorted .pt files from ckpt_dir, or empty list."""
    if not ckpt_dir.is_dir():
        return []
    return sorted(ckpt_dir.glob("*.pt"))


def _find_checkpoint(name: str) -> Path | None:
    """Resolve a checkpoint filename in either checkpoints/ location.
    Priority: project root checkpoints/ then ml/checkpoints/.
    """
    for base in (ML_DIR.parent / "checkpoints", ML_DIR / "checkpoints"):
        p = base / name
        if p.exists():
            return p.resolve()
    return None


@app.post("/cv/match")
def cv_match(
    search: UploadFile = File(...),
    ref_x: int = Form(...),
    ref_y: int = Form(...),
    ref_w: int = Form(...),
    ref_h: int = Form(...),
    detection_mode: str = Form("threshold"),
    gradient_kernel: int = Form(5),
    min_area: int = Form(5000),
    min_distance: int = Form(15),
    area_lo: float = Form(0.6),
    area_hi: float = Form(1.8),
    aspect_thresh: float = Form(0.5),
    merge_dist_px: float = Form(20),
    merge_area_ratio: float = Form(0.5),
    efd_harmonics: int = Form(5),
    fuzzy_thresh: float = Form(1.2),
    min_ref_children: int = Form(2),
    struct_thresh: float = Form(0.2),
    rotation_min_matches: int = Form(2),
    w_shape: float = Form(0.6),
    w_area: float = Form(1.0),
    w_bbox: float = Form(1.0),
    w_pos: float = Form(0.5),
    max_matches: int = Form(100),
) -> dict:
    """Tree-based contour matching — extracts the pocket→base→emitter hierarchy
    from both reference and candidate crops, matches them recursively, recovers
    rotation from the matched children's principal axes.
    """
    search_raw = search.file.read()
    search_arr = np.frombuffer(search_raw, dtype=np.uint8)
    search_bgr = cv2.imdecode(search_arr, cv2.IMREAD_COLOR)
    if search_bgr is None:
        raise HTTPException(status_code=400, detail="could not decode search image")
    search_rgb = cv2.cvtColor(search_bgr, cv2.COLOR_BGR2RGB)

    params = {
        "detection_mode": detection_mode,
        "gradient_kernel": gradient_kernel,
        "min_area": min_area,
        "min_distance": min_distance,
        "area_lo": area_lo,
        "area_hi": area_hi,
        "aspect_thresh": aspect_thresh,
        "merge_dist_px": merge_dist_px,
        "merge_area_ratio": merge_area_ratio,
        "efd_harmonics": efd_harmonics,
        "fuzzy_thresh": fuzzy_thresh,
        "min_ref_children": min_ref_children,
        "struct_thresh": struct_thresh,
        "rotation_min_matches": rotation_min_matches,
        "w_shape": w_shape,
        "w_area": w_area,
        "w_bbox": w_bbox,
        "w_pos": w_pos,
        "max_matches": max_matches,
    }

    matches = match_contour_pipeline(search_rgb, (ref_x, ref_y, ref_w, ref_h), params)
    if len(matches) > max_matches:
        matches = matches[:max_matches]
    return {"matches": matches, "total": len(matches)}


@app.post("/cv/debug")
def cv_debug(
    search: UploadFile = File(...),
    ref_x: int = Form(...),
    ref_y: int = Form(...),
    ref_w: int = Form(...),
    ref_h: int = Form(...),
    detection_mode: str = Form("threshold"),
    gradient_kernel: int = Form(5),
    min_area: int = Form(5000),
    min_distance: int = Form(15),
    area_lo: float = Form(0.6),
    area_hi: float = Form(1.8),
    aspect_thresh: float = Form(0.5),
    merge_dist_px: float = Form(20),
    merge_area_ratio: float = Form(0.5),
    efd_harmonics: int = Form(5),
    fuzzy_thresh: float = Form(1.2),
    min_ref_children: int = Form(2),
    struct_thresh: float = Form(0.2),
    rotation_min_matches: int = Form(2),
    w_shape: float = Form(0.6),
    w_area: float = Form(1.0),
    w_bbox: float = Form(1.0),
    w_pos: float = Form(0.5),
) -> dict:
    """CV debug endpoint — returns ref tree, search preview, and top matches."""
    search_raw = search.file.read()
    search_arr = np.frombuffer(search_raw, dtype=np.uint8)
    search_bgr = cv2.imdecode(search_arr, cv2.IMREAD_COLOR)
    if search_bgr is None:
        raise HTTPException(status_code=400, detail="could not decode search image")
    search_rgb = cv2.cvtColor(search_bgr, cv2.COLOR_BGR2RGB)

    params = {
        "detection_mode": detection_mode,
        "gradient_kernel": gradient_kernel,
        "min_area": min_area,
        "min_distance": min_distance,
        "area_lo": area_lo,
        "area_hi": area_hi,
        "aspect_thresh": aspect_thresh,
        "merge_dist_px": merge_dist_px,
        "merge_area_ratio": merge_area_ratio,
        "efd_harmonics": efd_harmonics,
        "fuzzy_thresh": fuzzy_thresh,
        "min_ref_children": min_ref_children,
        "struct_thresh": struct_thresh,
        "rotation_min_matches": rotation_min_matches,
        "w_shape": w_shape,
        "w_area": w_area,
        "w_bbox": w_bbox,
        "w_pos": w_pos,
    }

    from cv_match import debug_match_pipeline
    return debug_match_pipeline(search_rgb, (ref_x, ref_y, ref_w, ref_h), params)


@app.post("/cv/debug-dump")
def cv_debug_dump(
    search: UploadFile = File(...),
    ref_x: int = Form(...),
    ref_y: int = Form(...),
    ref_w: int = Form(...),
    ref_h: int = Form(...),
    detection_mode: str = Form("threshold"),
    gradient_kernel: int = Form(5),
    min_area: int = Form(5000),
    min_distance: int = Form(15),
    area_lo: float = Form(0.6),
    area_hi: float = Form(1.8),
    aspect_thresh: float = Form(0.5),
    merge_dist_px: float = Form(20),
    merge_area_ratio: float = Form(0.5),
    efd_harmonics: int = Form(5),
    fuzzy_thresh: float = Form(1.2),
    min_ref_children: int = Form(2),
    struct_thresh: float = Form(0.2),
    rotation_min_matches: int = Form(2),
    w_shape: float = Form(0.6),
    w_area: float = Form(1.0),
    w_bbox: float = Form(1.0),
    w_pos: float = Form(0.5),
) -> dict:
    """CV debug endpoint — writes debug data to disk for agent analysis."""
    from datetime import datetime
    search_raw = search.file.read()
    search_arr = np.frombuffer(search_raw, dtype=np.uint8)
    search_bgr = cv2.imdecode(search_arr, cv2.IMREAD_COLOR)
    if search_bgr is None:
        raise HTTPException(status_code=400, detail="could not decode search image")
    search_rgb = cv2.cvtColor(search_bgr, cv2.COLOR_BGR2RGB)

    params = {
        "detection_mode": detection_mode,
        "gradient_kernel": gradient_kernel,
        "min_area": min_area,
        "min_distance": min_distance,
        "area_lo": area_lo,
        "area_hi": area_hi,
        "aspect_thresh": aspect_thresh,
        "merge_dist_px": merge_dist_px,
        "merge_area_ratio": merge_area_ratio,
        "efd_harmonics": efd_harmonics,
        "fuzzy_thresh": fuzzy_thresh,
        "min_ref_children": min_ref_children,
        "struct_thresh": struct_thresh,
        "rotation_min_matches": rotation_min_matches,
        "w_shape": w_shape,
        "w_area": w_area,
        "w_bbox": w_bbox,
        "w_pos": w_pos,
    }

    from cv_match import debug_match_pipeline
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    dump_path = str((ML_DIR.parent / "data" / "tmp" / f"cv_debug_{ts}.json").resolve())

    result = debug_match_pipeline(search_rgb, (ref_x, ref_y, ref_w, ref_h), params,
                                   dump_path=dump_path)
    return {**result, "dump_path": dump_path}


@app.post("/cv/template-match")
@cv_resource_guard
def cv_template_match(
    search: UploadFile = File(...),
    job_id: str | None = Header(default=None, alias="x-cv-job-id"),
    ref_x: int = Form(...),
    ref_y: int = Form(...),
    ref_w: int = Form(...),
    ref_h: int = Form(...),
    threshold: float = Form(0.5),
    rotation_steps: int = Form(4),
    max_matches: int = Form(100),
    min_distance: int = Form(15),
    sobel_ksize: int = Form(3),
    nms_iou: float = Form(0.3),
    nms_dist: int = Form(30),
) -> dict:
    """Template matching (Sobel + matchTemplate) — multi-angle + NMS."""
    search_raw = search.file.read()
    search_arr = np.frombuffer(search_raw, dtype=np.uint8)
    search_bgr = cv2.imdecode(search_arr, cv2.IMREAD_COLOR)
    if search_bgr is None:
        raise HTTPException(status_code=400, detail="could not decode search image")
    search_rgb = cv2.cvtColor(search_bgr, cv2.COLOR_BGR2RGB)

    params = {
        "threshold": threshold,
        "rotation_steps": rotation_steps,
        "max_matches": max_matches,
        "min_distance": min_distance,
        "sobel_ksize": sobel_ksize,
        "nms_iou": nms_iou,
        "nms_dist": nms_dist,
    }

    matches = match_template_pipeline(search_rgb, (ref_x, ref_y, ref_w, ref_h), params)
    return {"matches": matches, "total": len(matches)}


def update_cv_job_progress(job_id: str, stage: str, completed: int, total: int, percentage: int) -> None:
    CV_JOB_PROGRESS[job_id] = {
        "stage": stage,
        "completed": completed,
        "total": total,
        "percentage": max(0, min(99, int(percentage))),
    }


@app.get("/cv/template-match-progress/{job_id}")
def cv_template_match_progress(job_id: str) -> dict:
    return CV_JOB_PROGRESS.get(job_id, {"stage": "queued", "completed": 0, "total": 1, "percentage": 0})


@app.post("/cv/template-match-cancel/{job_id}")
def cv_template_match_cancel(job_id: str) -> dict:
    CANCELLED_CV_JOBS.add(job_id)
    return {"ok": True, "job_id": job_id}


@app.get("/cv/template-debug-progress/{job_id}")
def cv_template_debug_progress(job_id: str) -> dict:
    return CV_JOB_PROGRESS.get(job_id, {"stage": "queued", "completed": 0, "total": 1, "percentage": 0})


@app.post("/cv/template-debug-cancel/{job_id}")
def cv_template_debug_cancel(job_id: str) -> dict:
    CANCELLED_CV_JOBS.add(job_id)
    return {"ok": True, "job_id": job_id}

@app.post("/cv/template-debug")
@cv_resource_guard
def cv_template_debug(
    search: UploadFile = File(...),
    job_id: str | None = Header(default=None, alias="x-cv-job-id"),
    ref_x: int = Form(...),
    ref_y: int = Form(...),
    ref_w: int = Form(...),
    ref_h: int = Form(...),
    threshold: float = Form(0.5),
    rotation_steps: int = Form(4),
    max_matches: int = Form(100),
    min_distance: int = Form(15),
    sobel_ksize: int = Form(3),
    nms_iou: float = Form(0.3),
    nms_dist: int = Form(30),
) -> dict:
    """Template matching debug — preview with pre/post NMS overlay, Sobel edges."""
    search_raw = search.file.read()
    search_arr = np.frombuffer(search_raw, dtype=np.uint8)
    search_bgr = cv2.imdecode(search_arr, cv2.IMREAD_COLOR)
    if search_bgr is None:
        raise HTTPException(status_code=400, detail="could not decode search image")
    search_rgb = cv2.cvtColor(search_bgr, cv2.COLOR_BGR2RGB)

    params = {
        "threshold": threshold,
        "rotation_steps": rotation_steps,
        "max_matches": max_matches,
        "min_distance": min_distance,
        "sobel_ksize": sobel_ksize,
        "nms_iou": nms_iou,
        "nms_dist": nms_dist,
    }

    from cv_match import debug_template_pipeline
    if job_id:
        update_cv_job_progress(job_id, "preprocessing", 0, 1, 3)
        params["cancel_check"] = lambda: job_id in CANCELLED_CV_JOBS
        params["progress_callback"] = lambda stage, completed, total, percentage: update_cv_job_progress(
            job_id, stage, completed, total, percentage
        )
    result = debug_template_pipeline(search_rgb, (ref_x, ref_y, ref_w, ref_h), params)
    if job_id:
        update_cv_job_progress(job_id, "done", 1, 1, 99)
    return result


@app.post("/cv/akaze-verify")
def cv_akaze_verify(
    search: UploadFile = File(...),
    matches_json: str = Form(...),
    ref_x: int = Form(...),
    ref_y: int = Form(...),
    ref_w: int = Form(...),
    ref_h: int = Form(...),
    sift_threshold: float = Form(0.5),
    ratio_thresh: float = Form(0.75),
    padding: float = Form(0.15),
    blur_ksize: int = Form(0),
    use_sobel: bool = Form(False),
) -> dict:
    """AKAZE-based post-verification: compare each match against the reference cell."""
    import json

    search_raw = search.file.read()
    search_arr = np.frombuffer(search_raw, dtype=np.uint8)
    search_bgr = cv2.imdecode(search_arr, cv2.IMREAD_COLOR)
    if search_bgr is None:
        raise HTTPException(status_code=400, detail="could not decode search image")
    search_rgb = cv2.cvtColor(search_bgr, cv2.COLOR_BGR2RGB)

    # Extract reference patch
    ref_patch = search_bgr[ref_y:ref_y+ref_h, ref_x:ref_x+ref_w]
    if ref_patch.size == 0:
        raise HTTPException(status_code=400, detail="ref patch is empty")

    try:
        matches = json.loads(matches_json)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="invalid matches_json")

    params = {
        "sift_threshold": sift_threshold,
        "ratio_thresh": ratio_thresh,
        "padding": padding,
        "blur_ksize": blur_ksize,
        "use_sobel": use_sobel,
    }

    return akaze_verify_matches(search_rgb, matches, ref_patch, params)


@app.post("/cv/akaze-debug")
def cv_akaze_debug(
    search: UploadFile = File(...),
    matches_json: str = Form(...),
    ref_x: int = Form(...),
    ref_y: int = Form(...),
    ref_w: int = Form(...),
    ref_h: int = Form(...),
    ratio_thresh: float = Form(0.75),
    padding: float = Form(0.15),
    blur_ksize: int = Form(0),
    use_sobel: bool = Form(False),
    max_pairs: int = Form(6),
) -> dict:
    """AKAZE debug — draw ref-vs-each keypoint matches."""
    import json

    search_raw = search.file.read()
    search_arr = np.frombuffer(search_raw, dtype=np.uint8)
    search_bgr = cv2.imdecode(search_arr, cv2.IMREAD_COLOR)
    if search_bgr is None:
        raise HTTPException(status_code=400, detail="could not decode search image")
    search_rgb = cv2.cvtColor(search_bgr, cv2.COLOR_BGR2RGB)

    ref_patch = search_bgr[ref_y:ref_y+ref_h, ref_x:ref_x+ref_w]
    if ref_patch.size == 0:
        raise HTTPException(status_code=400, detail="ref patch is empty")

    try:
        matches = json.loads(matches_json)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="invalid matches_json")

    params = {
        "ratio_thresh": ratio_thresh,
        "padding": padding,
        "blur_ksize": blur_ksize,
        "use_sobel": use_sobel,
    }

    return akaze_debug_matches(search_rgb, matches, ref_patch, params, max_pairs=max_pairs)


@app.get("/models")
def list_models() -> dict:
    """List checkpoint files from both checkpoints/ directories.

    Node surfaces this as the model dropdown. Hashes let the caller tell
    whether a switch actually changes the resident weights. Files in the
    project-root checkpoints/ take priority when names collide."""
    seen: set[str] = set()
    resident = STATE.checkpoint_path.resolve() if STATE.checkpoint_path else None
    models: list[dict] = []
    for ckpt_dir in (ML_DIR.parent / "checkpoints", ML_DIR / "checkpoints"):
        for p in _scan_checkpoints(ckpt_dir):
            if p.name in seen:
                continue
            seen.add(p.name)
            try:
                h: str | None = checkpoint_hash(p)
            except Exception:  # noqa: BLE001
                h = None
            models.append({
                "name": p.name,
                "hash": h,
                "size_bytes": p.stat().st_size,
                "resident": resident is not None and p.resolve() == resident,
            })
    return {"models": models}


@app.post("/model/reload")
def model_reload(body: ReloadBody) -> dict:
    if STATE.training_active:
        raise HTTPException(status_code=409, detail="cannot reload during training")
    p = Path(body.checkpoint_path)
    if not p.is_absolute():
        # Try resolving relative to both checkpoints/ directories
        p = _find_checkpoint(p.name)
        if p is None:
            p = ML_DIR / body.checkpoint_path
    if not p.exists():
        raise HTTPException(status_code=400, detail=f"checkpoint not found: {p}")
    with STATE.lock:
        STATE.load(p)
    if STATE.model_loaded and STATE.checkpoint_path:
        remember_resident(STATE.checkpoint_path)
    return {
        "checkpoint": STATE.checkpoint_path.name if STATE.checkpoint_path else None,
        "checkpoint_hash": STATE.checkpoint_hash,
        "model_loaded": STATE.model_loaded,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", default=os.environ.get("ML_CHECKPOINT"),
                        help="checkpoint to load; default: the last one loaded via "
                             "/model/reload, else checkpoints/model.pt")
    parser.add_argument("--data-root", default=os.environ.get("ML_DATA_ROOT", str(ML_DIR.parent / "data")))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=int(os.environ.get("ML_SIDECAR_PORT", 8001)))
    parser.add_argument("--trace-threshold", type=float,
                        default=float(os.environ.get("ML_TRACE_THRESHOLD", 0.35)),
                        help="trace-channel binarization threshold (lower = fewer "
                             "gaps in the decoded wires; vias keep using --threshold)")
    args = parser.parse_args()

    STATE.data_root = Path(args.data_root)
    STATE.trace_threshold = args.trace_threshold
    if args.checkpoint:
        ckpt = Path(args.checkpoint)
        if not ckpt.is_absolute():
            found = _find_checkpoint(ckpt.name)
            ckpt = found if found else ML_DIR / ckpt
    else:
        remembered = recall_resident()
        if remembered is not None:
            print(f"[sidecar] resuming resident checkpoint {remembered}")
        ckpt = remembered or (ML_DIR / "checkpoints" / "model.pt")
    STATE.load(ckpt)
    if STATE.model_loaded and STATE.checkpoint_path:
        remember_resident(STATE.checkpoint_path)

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
