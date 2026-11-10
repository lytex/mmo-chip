# v1.9-alpha — Vectorization (Trace → Nets), Desktop Binary, Canvas Performance

> **Alpha.** Core pipeline is stable; newer features are marked by maturity.
> The largest release since v1.8-alpha: ~95 commits.

## Vectorization (Trace → Nets)

Automated metal tracing from the die image itself, driven by the right
panel's Vectorize tab.

- **Preprocessing with preview** — the viewed region is preprocessed on the
  server; every slider repaints the preview immediately.
- **Decode whole die or a selected region** — traces are extracted as
  polylines; the whole-die sweep stitches block masks into one mask and
  decodes them in a single pass, so no wire is ever cut at a tile seam.
- **Traces become regular nets** — the same data model as hand-drawn wires:
  metal routing is drawn automatically with snapping to contacts lying in
  the same traced area (each closed metal contour = one net); the result is
  fully editable and undoable.
- **Vector layers** — saved whole-die decodes stay pinned with per-layer
  visibility and colours.
- Currently one metal level only — no via support yet; vias arrive in
  future versions.

## Desktop binary

- Windows / Linux builds with three launch modes: local (default),
  `--serve` (shared server, LAN URLs in tray), `--connect` (client);
  team setup "one server + browsers" and optional JWT auth.
- **ML sidecar as a plugin**: run `setup_ml.bat` / `setup_ml.ps1` /
  `setup_ml.sh` next to the exe — installer (uv over pip, with retries and
  resume), GPU auto-detect, automatic start on the next launch. Without the
  plugin everything else keeps working.
- Packaged backend boot verified on the Electron-embedded Node.

## Canvas performance and reliability

- Die-wide vectorized nets (thousands of edges) render fast: per-net
  spatial indexes, colour-batched stroke passes, dedicated dot/select
  passes; conductor passes with no content are skipped entirely.
- Fixed two heavy regressions: repeated full-net draws on every pass, and
  an invariant saved-vector fetch loop that re-rendered ALL canvas tiles
  after every page reload.
- Diagnostics: optional **Perf HUD** under the canvas (fps / render ms /
  last render reason) plus slow-frame console logs with per-layer and
  per-tile breakdowns.
- Presence deduplication by userId — duplicate-React-key warnings are gone.

## Documentation

- README (EN + RU): new Vectorization and MCP Server sections, refreshed
  feature lists, disclaimer and repository structure.

**Install:** use the release binary artifacts, or build with
`npm run desktop:build:win`. ML sidecar — run `setup_ml.bat` next to the
exe. MCP endpoint — `http://127.0.0.1:3101/mcp` in the local binary.
