# Upstream changes pulled in

What `origin/analog-re-wip` ([flxkrlv/mmo-chip-a](https://github.com/flxkrlv/mmo-chip-a)) gained since
the previous upstream merge (`8651895`), up to `b2de5ba`. 103 non-merge commits, 83 files,
about +13.9k / -0.4k lines. List them with:

```sh
git log --oneline --no-merges 8651895..b2de5ba
```

## Classical (no-model) metal vectorization
- Live-tunable vectorizer with traces → nets (`backend/src/ml/vectorize.ts`, `vectorSweep.ts`,
  `docs/VECTOR_SKELETON.md`): colour/brightness pipette, physical-unit minimum gap (µm), max width /
  branch length caps, octilinear (0/45/90°) decoder, "runs" decoder (one wire = one trace).
- Whole-die sweep: cancellable, cached, real progress (stage / % / ETA), seamless; contacts
  connect as branches by metal-contour membership; twin-rail dedupe; min-contacts filter.
- Saved Vector Layers: rename/delete, per-layer colour, persisted visibility, baked-bitmap render,
  outline opacity, saved-run selector for nets.
- P2-1: drop traces duplicating hand-drawn nets. P2-2: trace regions (restrict rendering and
  materialization to drawn areas, with die contour) and trace blockages (win over regions); Trace
  tab in the toolbar. P2-3: pre-threshold preprocessing (tone LUT, denoise, CLAHE, unsharp) with live
  preview. See `docs/PHASE2_PLAN.md`.

## ML wire/trace detection
- Trace channel rendered in the viewer; per-trace confidence and independent visibility.
- Trace decode v2: skeleton centrelines with contact snapping, gap bridging, fragment stitching;
  materialization of centrelines into annotation nets.
- Sidecar accepts camelCase preprocess keys; `ML_PYTHON` env override in `run_sidecar.js`.

## Desktop app
- ML sidecar is an optional plugin; universal build caches.
- Plugin installers: visible pip steps, retry, timeout/resume, prefer `uv`, IPEX dropped,
  scikit-image added to the base list, `setup_ml.ps1` path crash fixed.
- Packaged builds: diagnose a missing ML sidecar; stage backend `undici`; downgraded to `^7`
  (Electron 33 has no zlib zstd).

## Performance and stability
- Optional Perf HUD (FPS / render diagnostics) under the canvas; slow frames name their render reason.
- Spatial grid for nets (vectorized meganets froze the UI); memoized `collectTraces/Outlines`;
  conductor-pass skip; node dots in one batched pass; strict pass semantics.
- Saved-vector fetch loop killed; preview orchestration moved off the rAF loop.
- Presence deduped by userId (no duplicate React keys).
- ELK layout returning silent `Infinity` no longer freezes the analog schematic tab.

## UI
- Shift+click range selection in the Nets outline list.
- Vector tab cleanup, pipette redesign, English-only interface.
- Dev wrapper `frontend/scripts/dev.mjs` (restarts the dev server on crash).

## Docs
- README (EN/RU) sections on vectorization and the MCP server; `docs/RELEASE_v1.9-alpha.md`.
- LLM-assisted analysis section shrunk to an MCP-first plan.
- Day-by-day notes in `memory/` (upstream diary).

## Conflicts when merging with this fork
`OutlineTree.tsx`, `MLViasLayer.ts`, `DieViewerPage.tsx`, `memory/2026-10-30.md`: resolved by keeping
both sides (fork's `onFlipImage` / `ImageFlip` alongside upstream's trace-region additions).
