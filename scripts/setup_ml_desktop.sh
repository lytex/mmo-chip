#!/usr/bin/env bash
# setup_ml_desktop.sh — install the optional ML sidecar plugin into an
# unpacked mmo-chip desktop app (linux-unpacked dir, AppImage payload or deb
# payload — anything containing resources/app/ml/sidecar.py).
#
# The plugin is a Python venv at resources/app/ml/.venv (the same layout the
# dev repo uses). On the next launch the app detects it and starts the
# sidecar next to the backend; without it the app runs as usual and ML
# features stay off.
#
# Usage:
#   bash setup_ml.sh                          # in-bundle copy (app root)
#   bash scripts/setup_ml_desktop.sh <appdir> # from a repo checkout
#
# Checkpoints go to resources/app/ml/checkpoints/*.pt (or train from the ML
# tab). Updating/replacing the app folder wipes the plugin — re-run this.
set -e

# ── locate the app dir ─────────────────────────────────────────────
APP_DIR="${1:-$(cd "$(dirname "$0")" && pwd)}"
ML_DIR="$APP_DIR/resources/app/ml"

if [ ! -f "$ML_DIR/sidecar.py" ]; then
    echo "ERROR: ML sources not found at $ML_DIR" >&2
    echo "This does not look like an unpacked mmo-chip desktop app (or it is older" >&2
    echo "than the ML-plugin staging). Pass the app dir explicitly:" >&2
    echo "  bash scripts/setup_ml_desktop.sh <unpacked app dir>" >&2
    exit 1
fi
APP_DIR="$(cd "$APP_DIR" && pwd)"
ML_DIR="$APP_DIR/resources/app/ml"
echo "=== mmo-chip ML plugin setup ==="
echo "App dir: $APP_DIR"

# ── find Python ≥ 3.10 ─────────────────────────────────────────────
PYTHON=""
for cmd in python3 python; do
    if command -v "$cmd" &>/dev/null; then
        if "$cmd" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
            PYTHON="$cmd"
            break
        fi
    fi
done
if [ -z "$PYTHON" ]; then
    echo "ERROR: Python 3.10+ not found. Install python3 (3.10 or newer) first."
    exit 1
fi
echo "Python: $($PYTHON --version)"

# ── ensure the venv module is available ────────────────────────────
if ! "$PYTHON" -c "import venv" 2>/dev/null; then
    echo "python3-venv not found — attempting to install..."
    if command -v apt &>/dev/null; then
        sudo apt install -y python3-venv
    elif command -v dnf &>/dev/null; then
        sudo dnf install -y python3-virtualenv
    elif command -v pacman &>/dev/null; then
        sudo pacman -S --noconfirm python-virtualenv
    elif command -v zypper &>/dev/null; then
        sudo zypper install -y python311-venv
    else
        echo "ERROR: cannot install python3-venv automatically."
        echo "Install it manually, then re-run this script."
        exit 1
    fi
fi

# ── create or repair the venv (the plugin marker) ──────────────────
VENV_PY="$ML_DIR/.venv/bin/python"
if [ -x "$VENV_PY" ]; then
    echo "venv already exists at ml/.venv"
else
    if [ -d "$ML_DIR/.venv" ]; then
        echo "broken venv found — recreating..."
        rm -rf "$ML_DIR/.venv"
    fi
    echo "Creating venv at ml/.venv..."
    "$PYTHON" -m venv "$ML_DIR/.venv"
fi

PIP() {
    # Retry once + long timeout: flaky CDNs (files.pythonhosted.org,
    # download.pytorch.org) drop mid-download and pip spins on the dead
    # socket. Fetched wheels stay cached. pip honours PIP_INDEX_URL env.
    "$VENV_PY" -m pip --timeout 60 --retries 5 "$@" || {
        echo "pip failed — retrying once..."
        "$VENV_PY" -m pip --timeout 60 --retries 5 "$@"
    }
}

# Same as PIP plus resumable downloads for the multi-GB torch/IPEX wheels
# (requires pip >= 25.1 — only used after the pip upgrade step).
PIP_RESUMABLE() {
    "$VENV_PY" -m pip --timeout 60 --retries 5 --resume-retries 5 "$@" || {
        echo "pip failed — retrying once..."
        "$VENV_PY" -m pip --timeout 60 --retries 5 --resume-retries 5 "$@"
    }
}

# uv (Rust installer) beats pip when present: pip's Python TLS can wedge on
# flaky networks while uv's Rust HTTP stack survives. uv installs into any
# venv via --python, so the venv itself is still created with python -m venv.
UV_EXE=""
if command -v uv &>/dev/null; then UV_EXE="uv"; fi

install_pkgs() {
    if [ -n "$UV_EXE" ]; then
        echo "uv pip install $*"
        uv pip install --python "$VENV_PY" "$@" || { echo "ERROR: uv pip install failed"; exit 1; }
        return
    fi
    PIP_RESUMABLE install "$@"
}

if [ -n "$UV_EXE" ]; then
    echo "Package installer: uv"
else
    echo "Package installer: pip (uv not found)"
    echo "Upgrading pip..."
    PIP install --upgrade pip
fi

# ── GPU detection ──────────────────────────────────────────────────
MODE="${GPU:-auto}"
if [ "$MODE" = "auto" ]; then
    HAS_NVIDIA=0
    if $PYTHON -c "import ctypes; ctypes.CDLL('libcuda.so.1')" 2>/dev/null && command -v nvidia-smi &>/dev/null; then
        HAS_NVIDIA=1
    fi
    HAS_INTEL_ARC=0
    if lspci 2>/dev/null | grep -qiE "Intel.*(Arc|DG[2-9])"; then
        HAS_INTEL_ARC=1
    fi
    if [ "$HAS_NVIDIA" -eq 1 ]; then MODE="nvidia"; elif [ "$HAS_INTEL_ARC" -eq 1 ]; then MODE="intel"; else MODE="cpu"; fi
fi
echo "Install variant: $MODE"

# Non-torch packages (the non-torch subset of ml/requirements.txt) — installed
# first so a torch-variant failure never blocks the base stack.
echo "Installing base ML packages..."
install_pkgs opencv-contrib-python-headless numpy scipy pillow tqdm fastapi "uvicorn[standard]" python-multipart

install_torch_extras() {
    echo "Installing segmentation-models-pytorch + albumentations..."
    install_pkgs segmentation-models-pytorch albumentations
}

# ── optional: Intel Arc compute drivers (Ubuntu) ───────────────────
install_intel_drivers() {
    if command -v apt &>/dev/null && ! dpkg -s intel-level-zero-gpu &>/dev/null 2>&1; then
        echo "Installing Intel GPU compute drivers..."
        sudo apt install -y ca-certificates wget
        wget -qO - https://repositories.intel.com/gpu/intel-graphics.key |
            sudo gpg --dearmor -o /usr/share/keyrings/intel-graphics.gpg 2>/dev/null
        echo "deb [arch=amd64 signed-by=/usr/share/keyrings/intel-graphics.gpg] https://repositories.intel.com/gpu/ubuntu noble client" |
            sudo tee /etc/apt/sources.list.d/intel-gpu.list >/dev/null
        sudo apt update
        sudo apt install -y intel-opencl-icd intel-level-zero-gpu level-zero
    fi
}

case "$MODE" in
    nvidia)
        echo "NVIDIA GPU — installing CUDA PyTorch from PyPI (large download, ~2.5 GB)..."
        install_pkgs -r "$ML_DIR/requirements.txt"
        ;;
    intel)
        # torch >= 2.6 ships native torch.xpu — no intel-extension-for-pytorch
        # needed (verified live: sidecar reports device=xpu without IPEX).
        echo "Intel Arc — installing XPU PyTorch 2.6 (native torch.xpu)..."
        install_intel_drivers
        if install_pkgs torch==2.6.0+xpu torchvision==0.21.0+xpu --index-url https://download.pytorch.org/whl/xpu; then
            install_torch_extras
        else
            echo "XPU install failed — falling back to CPU PyTorch."
            install_pkgs torch torchvision --index-url https://download.pytorch.org/whl/cpu --force-reinstall
            install_torch_extras
        fi
        ;;
    *)
        echo "No supported GPU — installing CPU-only PyTorch..."
        install_pkgs torch torchvision --index-url https://download.pytorch.org/whl/cpu
        install_torch_extras
        ;;
esac

# ── checkpoints dir (models the sidecar picks up) ──────────────────
mkdir -p "$ML_DIR/checkpoints"

# ── smoke test ─────────────────────────────────────────────────────
echo "Verifying the stack..."
"$VENV_PY" -c "import torch, cv2, fastapi, uvicorn; print('torch', torch.__version__, '| opencv', cv2.__version__)" ||
    echo "WARNING: import check failed — check the pip output above." >&2

echo ""
echo "=== ML plugin installed ==="
echo "  venv:        $VENV_PY"
echo "  checkpoints: $ML_DIR/checkpoints  (put *.pt here or train from the ML tab)"
echo "Next: (re)start the app — the log will show 'ml sidecar: plugin found'."
echo "Remove the plugin any time: delete the ml/.venv folder."
