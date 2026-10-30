<#
.SYNOPSIS
  Install the optional ML sidecar plugin into an unpacked mmo-chip desktop app.

.DESCRIPTION
  Creates a Python venv inside <app>\resources\app\ml\.venv (the same layout
  the dev repo uses: ml/.venv next to sidecar.py) and installs the ML
  dependencies. On the next launch the app detects the plugin and starts the
  sidecar next to the backend. Without the plugin the app runs exactly as
  before — ML features simply stay off.

  Checkpoints live in <app>\resources\app\ml\checkpoints\*.pt — drop trained
  models there, or train from the app's ML tab. Note: replacing/updating the
  app folder wipes the plugin; re-run this script afterwards.

  Torch variants: NVIDIA → CUDA build from PyPI (large, ~2.5 GB),
  Intel Arc → XPU wheels + IPEX (falls back to CPU on failure),
  otherwise → CPU-only wheels.

.PARAMETER AppDir
  Unpacked app directory (the one containing mmo-chip.exe and resources\).
  Defaults to the directory holding this script (the in-bundle copy), or
  <repo>\desktop\build\dist\win-unpacked when run from a repo checkout.

.PARAMETER Gpu
  auto | nvidia | intel | cpu  (default auto).

.EXAMPLE
  # From the extracted zip: double-click setup_ml.bat, or:
  powershell -ExecutionPolicy Bypass -File setup_ml.ps1

  # From the repo against a built dist:
  powershell -File scripts\setup_ml_desktop.ps1 -AppDir desktop\build\dist\win-unpacked
#>
param(
  [string]$AppDir = "",
  [ValidateSet("auto", "nvidia", "intel", "cpu")]
  [string]$Gpu = "auto"
)

$ErrorActionPreference = "Stop"

# ── locate the app dir ─────────────────────────────────────────────
if (-not $AppDir) {
  $here = Split-Path -Path $MyInvocation.MyCommand.Path -Parent
  # In-bundle copy: the script sits at the app root next to resources\.
  if (Test-Path (Join-Path $here "resources\app\ml\sidecar.py")) {
    $AppDir = $here
  } else {
    # Repo copy: default to the freshly built unpacked dist.
    $AppDir = Join-Path $here "..\desktop\build\dist\win-unpacked"
  }
}
$AppDir = [System.IO.Path]::GetFullPath((Join-Path $PWD $AppDir))
$mlDir = Join-Path $AppDir "resources\app\ml"

if (-not (Test-Path (Join-Path $mlDir "sidecar.py"))) {
  Write-Host "ERROR: ML sources not found at $mlDir" -ForegroundColor Red
  Write-Host "This does not look like an unpacked mmo-chip desktop app (or it is older"
  Write-Host "than the ML-plugin staging). Pass -AppDir explicitly:"
  Write-Host "  powershell -File scripts\setup_ml_desktop.ps1 -AppDir <unpacked app dir>"
  exit 1
}
Write-Host "=== mmo-chip ML plugin setup ===" -ForegroundColor Green
Write-Host "App dir: $AppDir"

# ── find Python >= 3.10 ────────────────────────────────────────────
function Get-Python([string]$exe, [string[]]$pre) {
  try {
    $out = & $exe @pre -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $out) { return $null }
    $version = $null
    if ([version]::TryParse((@($out)[0]).Trim(), [ref]$version) -and $version -ge [version]"3.10") {
      return @{ exe = $exe; pre = $pre; version = $version }
    }
  } catch {}
  return $null
}

$python = $null
foreach ($candidate in @(
    @{ exe = "python"; pre = @() },
    @{ exe = "python3"; pre = @() },
    @{ exe = "py"; pre = @("-3") }
  )) {
  $python = Get-Python $candidate.exe $candidate.pre
  if ($python) { break }
}
if (-not $python) {
  Write-Host "ERROR: Python 3.10+ not found. Install it from https://www.python.org/downloads/" -ForegroundColor Red
  Write-Host "(tick 'Add python.exe to PATH' in the installer), then re-run this script." -ForegroundColor Red
  exit 1
}
Write-Host ("Python: {0} {1}" -f $python.exe, $python.version)

# ── create or repair the venv (the plugin marker) ──────────────────
$venvPython = Join-Path $mlDir ".venv\Scripts\python.exe"
if (Test-Path $venvPython) {
  Write-Host "venv already exists at ml\.venv" -ForegroundColor DarkGray
} else {
  if ((Test-Path (Join-Path $mlDir ".venv")) -and -not (Test-Path (Join-Path $mlDir ".venv\Scripts"))) {
    Write-Host "broken venv found — recreating..." -ForegroundColor Yellow
    Remove-Item (Join-Path $mlDir ".venv") -Recurse -Force
  }
  Write-Host "Creating venv at ml\.venv..." -ForegroundColor Green
  & $python.exe @($python.pre) -m venv (Join-Path $mlDir ".venv")
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $venvPython)) {
    Write-Host "ERROR: venv creation failed (python3-venv/venv module missing?)" -ForegroundColor Red
    exit 1
  }
}

function Invoke-Pip {
  # pip natively honours PIP_INDEX_URL / PIP_EXTRA_INDEX_URL from the
  # environment — locked-down networks can point it at a mirror that way.
  # Long timeout + retries: flaky networks drop connections that pip's
  # 15 s default can't survive.
  Write-Host "pip $($args -join ' ')" -ForegroundColor DarkGray
  & $venvPython -m pip --timeout 60 --retries 5 @args
  if ($LASTEXITCODE -ne 0) {
    # CDN connections (files.pythonhosted.org, download.pytorch.org) sometimes
    # die mid-download and pip spins at 100% CPU on the dead socket — retry
    # once before giving up (the wheels already fetched stay cached).
    Write-Host "pip failed (exit $LASTEXITCODE) — retrying once..." -ForegroundColor Yellow
    & $venvPython -m pip --timeout 60 --retries 5 @args
    if ($LASTEXITCODE -ne 0) { throw "pip install failed (args: $args)" }
  }
}

# Same as Invoke-Pip plus resumable downloads — for the multi-GB torch/IPEX
# wheels. Requires pip >= 25.1, so only used after the pip upgrade step.
function Invoke-PipResumable {
  Write-Host "pip $($args -join ' ')" -ForegroundColor DarkGray
  & $venvPython -m pip --timeout 60 --retries 5 --resume-retries 5 @args
  if ($LASTEXITCODE -ne 0) {
    Write-Host "pip failed (exit $LASTEXITCODE) — retrying once..." -ForegroundColor Yellow
    & $venvPython -m pip --timeout 60 --retries 5 --resume-retries 5 @args
    if ($LASTEXITCODE -ne 0) { throw "pip install failed (args: $args)" }
  }
}

# uv (Rust installer) beats pip when present: on machines with flaky networks
# pip's Python TLS can wedge at 100% CPU on a dropped socket while uv's Rust
# HTTP stack survives. All package installs go through uv when it exists;
# pip (with timeouts + resume) is the fallback. uv installs into any venv
# via --python, so the venv itself is still created with python -m venv.
$uvExe = (Get-Command uv -ErrorAction SilentlyContinue).Source

function Invoke-Install([string[]]$installArgs) {
  if ($uvExe) {
    Write-Host "uv pip install $($installArgs -join ' ')" -ForegroundColor DarkGray
    & $uvExe pip install --python $venvPython @installArgs
    if ($LASTEXITCODE -ne 0) { throw "uv pip install failed (args: $installArgs)" }
    return
  }
  Invoke-PipResumable @installArgs
}
if ($uvExe) {
  Write-Host "Package installer: uv ($uvExe)" -ForegroundColor Green
} else {
  Write-Host "Package installer: pip (uv not found)" -ForegroundColor DarkGray
  Write-Host "Upgrading pip..."
  Invoke-Pip install --upgrade pip
}

# ── GPU detection ──────────────────────────────────────────────────
$gpuNames = ""
try { $gpuNames = ((Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue) | ForEach-Object { $_.Name }) -join "; " } catch {}
$hasNvidia = ($gpuNames -match "NVIDIA") -or ($null -ne (Get-Command nvidia-smi -ErrorAction SilentlyContinue))
$hasIntelArc = $gpuNames -match "Intel.*(Arc|DG[2-9])"

$mode = $Gpu
if ($mode -eq "auto") {
  if ($hasNvidia) { $mode = "nvidia" } elseif ($hasIntelArc) { $mode = "intel" } else { $mode = "cpu" }
}
Write-Host "GPUs: $(if ($gpuNames) { $gpuNames } else { '(none detected)' })"
Write-Host "Install variant: $mode" -ForegroundColor Green

# Non-torch packages (the non-torch subset of ml/requirements.txt) — installed
# first so a torch-variant failure never blocks the base stack.
Write-Host "Installing base ML packages..." -ForegroundColor Green
Invoke-Install @("opencv-contrib-python-headless", "numpy", "scipy", "pillow", "tqdm", "fastapi", "uvicorn[standard]", "python-multipart")

# segmentation-models-pytorch pins torch indirectly; install it after torch.
function Install-TorchExtras {
  Write-Host "Installing segmentation-models-pytorch + albumentations..." -ForegroundColor Green
  Invoke-Install @("segmentation-models-pytorch", "albumentations")
}

switch ($mode) {
  "nvidia" {
    Write-Host "NVIDIA GPU — installing CUDA PyTorch from PyPI (large download, ~2.5 GB)..." -ForegroundColor Green
    Invoke-Install @("-r", (Join-Path $mlDir "requirements.txt"))
  }
  "intel" {
    # torch >= 2.6 ships native torch.xpu — no intel-extension-for-pytorch
    # needed (verified live: sidecar reports device=xpu without IPEX).
    Write-Host "Intel Arc — installing XPU PyTorch 2.6 (native torch.xpu)..." -ForegroundColor Green
    try {
      Invoke-Install @("torch==2.6.0+xpu", "torchvision==0.21.0+xpu", "--index-url", "https://download.pytorch.org/whl/xpu")
      Install-TorchExtras
    } catch {
      Write-Host "XPU install failed — falling back to CPU PyTorch." -ForegroundColor Yellow
      Invoke-Install @("torch", "torchvision", "--index-url", "https://download.pytorch.org/whl/cpu", "--force-reinstall")
      Install-TorchExtras
    }
  }
  default {
    Write-Host "No supported GPU — installing CPU-only PyTorch..." -ForegroundColor Green
    Invoke-Install @("torch", "torchvision", "--index-url", "https://download.pytorch.org/whl/cpu")
    Install-TorchExtras
  }
}

# ── checkpoints dir (models the sidecar picks up) ──────────────────
New-Item -ItemType Directory -Force -Path (Join-Path $mlDir "checkpoints") | Out-Null

# ── smoke test ─────────────────────────────────────────────────────
Write-Host "Verifying the stack..." -ForegroundColor Green
& $venvPython -c "import torch, cv2, fastapi, uvicorn; print('torch', torch.__version__, '| cuda:', torch.cuda.is_available(), '| opencv', cv2.__version__)"
if ($LASTEXITCODE -ne 0) {
  Write-Host "WARNING: import check failed — check the pip output above." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=== ML plugin installed ===" -ForegroundColor Green
Write-Host "  venv:        $venvPython"
Write-Host "  checkpoints: $(Join-Path $mlDir 'checkpoints')  (put *.pt here or train from the ML tab)"
Write-Host "Next: (re)start mmo-chip.exe — the log will show 'ml sidecar: plugin found'."
Write-Host "Remove the plugin any time: delete the ml\.venv folder."
