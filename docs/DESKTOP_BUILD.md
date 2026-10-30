# Desktop build (Electron)

The desktop app is the same repo, packaged: an Electron window around the Node
backend, with the simulators bundled. One command rebuilds everything after a
change:

```sh
npm run desktop:build:win    # Windows: stages payload + bundles sims + zip artifact
npm run desktop:build:linux  # Linux (needs 7z only for the Windows ngspice path)
```

### Downloads and caches (universal build)

`pkg:win` / `pkg:linux` run through [desktop/pkg.cjs](../desktop/pkg.cjs),
which points electron-builder's caches into the repo
(`desktop/.electron-cache`, `desktop/.electron-builder-cache` — both
gitignored) instead of the default `%LOCALAPPDATA%`. On machines where the
user profile is not fully writable the default location fails mid-download
(`open …zip.part5: Access is denied`); with the repo cache the first build
fills it once and every later build is an offline cache hit — no proxy env
and no per-machine setup. If GitHub itself is unreachable, the last-resort
escape hatch is still `ELECTRON_GET_USE_PROXY=1` +
`GLOBAL_AGENT_HTTPS_PROXY=http://<proxy:port>` (caller-set env beats the
repo default).

Artifacts land in `desktop/build/dist/` — `mmo-chip-<version>[-win].zip` /
unpacked `win-unpacked/` (testable as-is), AppImage + `.deb` for Linux.

CI pushes a `desktop-v*` tag (or runs the workflow manually) and both
platforms build in [.github/workflows/desktop.yml](../.github/workflows/desktop.yml).

## Layout inside the app

```
mmo-chip.exe (Electron main, desktop/main.cjs)
 ├─ spawns process.execPath with ELECTRON_RUN_AS_NODE=1
 │    └─ --import tsx resources/app/backend/dist/index.js   (plain Node 20)
 │         ├─ Express: /api, /mcp (Streamable HTTP), WebSocket /api/ws
 │         ├─ serves frontend/dist as static + SPA fallback
 │         └─ re-spawns node --import tsx scripts/netlist-export.ts (unchanged)
 ├─ resources/app/     repo-mirror: backend/dist, shared/, frontend/{src,dist},
 │                     scripts/netlist-export.ts, node_modules (prod deps + tsx)
 │                     ml/*.py — ML sidecar sources (optional plugin, see below)
 ├─ resources/bin/     Spice64/{bin,lib,share} (ngspice_con.exe), vyges-lvs
 │   → env NGSPICE_BIN / LVS_CLI_PATH, so the system installs are never probed
 ├─ setup_ml.ps1/.bat/.sh  optional ML plugin installers (at the app root)
 └─ frameless window → http://127.0.0.1:3101/ (TopBar doubles as the title bar)
```

Why this shape instead of bundling: the backend must stay able to re-spawn
`node --import tsx scripts/netlist-export.ts` and resolve TS-covered `shared`
sources through node_modules. The Electron binary itself becomes that "node
runtime" (`ELECTRON_RUN_AS_NODE=1`), and `--import tsx` in the initial spawn
is inherited by any grandchild — the whole chain behaves exactly like the dev
setup, zero rewrites.

## User data

`%APPDATA%/mmo-chip/` (`app.getPath("userData")`): `data/` (dies, overlays,
users.json…) + `window.json` bounds. `MMOCHECK_DATA_ROOT` overrides for tests /
portable runs; `MMOCHECK_PORT` moves the backend off 3101.

## Restricted environments

`ELECTRON_RUN_AS_NODE` children behave like normal node.exe — no sandbox, disk
and network are just Node's. On locked-down machines Electron itself may block
per-process temp writes (shared agent sandboxes do); that also kills crashpad.
Users on normal machines are unaffected; for tests set `TMP/TEMP` to a
writable location.

## Frameless window and the launcher

`mmo-chip.exe` inside the package is a ~300 KB Rust launcher
([desktop/launcher](../desktop/launcher)): it sets `ELECTRON_DISABLE_SANDBOX`
and spawns `mmo-chip-app.exe` (the real Electron binary). On several target
machines Chromium's sandbox initialization crashes Electron before main.js
runs (silent exit, `0xc0000005` in the crash dump) — the launcher sidesteps
that. Electron-builder's `afterPack` hook
([scripts/desktop-after-pack.cjs](../scripts/desktop-after-pack.cjs)) does the
rename/swap; without a built launcher the plain exe is kept.

Every session logs to `<userData>/logs/mmo-chip.log` (backend stdout/stderr
included) and user data lives in `%APPDATA%/mmo-chip`; if the user profile is
not writable (locked-down machines), everything falls back to a
`portable-data/` directory next to the resources and the backend failure is
shown in a dialog instead of exiting silently.

## Development attach

`npm run dev` (Vite 5173 + backend 3001 + ML sidecar) and, from `desktop/`,
`npm run dev:vite` — the shell loads Vite and spawns no backend of its own.

## ML sidecar as an optional plugin

ML is not bundled (torch is a ~2.5 GB dependency), but every package ships the
sidecar sources (`resources/app/ml/*.py`) and the installers at the app root.
The plugin is deliberately the **same layout as the dev repo**: a Python venv
at `resources/app/ml/.venv` plus `checkpoints/` — nothing new to learn.

Windows (in the extracted app folder):

```powershell
# double-click setup_ml.bat, or:
powershell -ExecutionPolicy Bypass -File setup_ml.ps1
# from a repo checkout against a built dist:
powershell -File scripts\setup_ml_desktop.ps1 -AppDir desktop\build\dist\win-unpacked
```

Linux:

```sh
bash setup_ml.sh                             # in-bundle copy (app root)
bash scripts/setup_ml_desktop.sh <appdir>    # from a repo checkout
```

What the installer does: finds Python ≥ 3.10, creates the venv, detects the
GPU (NVIDIA → CUDA wheels from PyPI; Intel Arc → XPU wheels + IPEX with a
CPU fallback; otherwise CPU-only torch; `-Gpu nvidia|intel|cpu` overrides),
installs the ML dependencies and creates `ml/checkpoints/` for `*.pt` models.
It is idempotent — re-run it to repair or after an app update (updating the
app folder wipes the plugin).

On the next launch the shell picks the plugin up automatically: the log shows
`ml sidecar: плагин найден — запускаю на 127.0.0.1:8001`, the sidecar starts
next to the backend (local and `--serve` modes; a `--connect` client never
spawns one — ML runs on the server machine). `CHIPTOOL_ML_SIDECAR_URL` moves
the port. Removing the plugin = deleting `resources/app/ml/.venv`.

Without the plugin the app works exactly as before: ML endpoints answer
`sidecar unreachable`, everything else (ngspice, vyges-lvs, MCP) is unaffected.

Installer notes: when `uv` is on PATH the installs go through it (Rust HTTP
stack — survives flaky networks where pip's Python TLS wedges at 100% CPU on
a dropped socket; observed on real machines); pip with long timeouts and
`--resume-retries` is the fallback. torch ≥ 2.6 ships native `torch.xpu`, so
the Intel route needs no IPEX. If even uv stalls, `PIP_INDEX_URL` (mirror) or
`HTTPS_PROXY` (a local proxy, if one runs) still work as overrides.

## Verify checklist (what was actually run when this landed)

- `desktop/build/dist/win-unpacked` boots: `/api/health` 200, `/` serves the
  SPA, `/login` SPA fallback, `POST /mcp` initialize 200.
- Grandchild extraction inside the package with a real die project:
  `expect __RESULT__{"ok":true,...}` for `import-bde5eb7bae88`
  (see scripts/netlist-export.ts contract).
- Bundled `ngspice_con.exe -b t.cir` writes analysis output with the Spice64
  layout intact (bin/lib/share).
- vyges-lvs.exe bundled from `~/.cargo/bin`.
- Launcher swap: `mmo-chip.exe` (300 KB) → `mmo-chip-app.exe` (Electron) via
  afterPack; `ELECTRON_DISABLE_SANDBOX=1` makes the Electron binary survive
  its early init on sandbox-crashing machines (verified for 33.4.11 and
  45.1.0 with `--version`).

## Known trade-offs

- Windows artifact is a zip (choose a signed NSIS build later; NSIS mmap bug
  hits 100 MB+ payloads on some hosts: `npx electron-builder --win nsis`).
- No code signing / notarization yet.
- ML sidecar is not bundled (torch is huge): it installs as an optional
  plugin via `setup_ml.ps1` / `setup_ml.sh` at the app root — see
  "ML sidecar as an optional plugin" above. ngspice/vyges/MCP all work out
  of the box. (A UI "download ML pack" button remains a follow-up.)
- No auto-update plumbing yet (electron-updater wants signed builds first).
- Chromium sandbox is disabled for the packaged app (launcher env) because of
  the machine-specific early-init crash; revisit when the root cause is known
  or Electron ships a fix.
