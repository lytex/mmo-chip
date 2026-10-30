# mmo-chip — analog-re-wip

> **ENG** | [**RU**](README.ru.md)

**A fork of [mmo-chip](https://github.com/giulioz/mmo-chip) for reverse engineering analog and mixed-signal ICs.**  
Extends the original digital CMOS pipeline to **BJTs, BiCMOS, resistors, capacitors, diodes** — transistor-level extraction with SPICE/CDL/Spectre netlist export.

## About flxkrlv/mmo-chip-a

[flxkrlv/mmo-chip-a](https://github.com/flxkrlv/mmo-chip-a) extends the original [mmo-chip](https://github.com/giulioz/mmo-chip) with analog and mixed-signal reverse-engineering workflows. The project also includes substantial user-experience and image-processing improvements contributed by [lytex](https://github.com/lytex). Feature details are documented alongside the relevant workflows below.

## Acknowledgments

Many thanks to the developers of the original [mmo-chip](https://github.com/giulioz/mmo-chip) for the clean architecture and clear interfaces that made this analog extension possible.

Special thanks to [lytex](https://github.com/lytex) for the substantial contribution of features and improvements that have helped move this project forward.

The original CMOS pipeline (standard cells, logic, Verilog) is **untouched** — analog extraction works as an add-on.

## Quick Start

```sh
# Node ≥ 20
npm install
npm run dev               # backend + frontend + ML sidecar
# or individually:
npm run dev -w backend    # http://localhost:3001
npm run dev -w frontend   # http://localhost:5173

# Tests:
npm test
```

## Desktop app (binary build)

The whole app ships as an Electron desktop binary with the backend, ML-ready
frontend, MCP endpoint, bundled ngspice and vyges-lvs — no installs required
on the target machine:

```sh
npm run desktop:build:win    # → desktop/build/dist/ (zip + win-unpacked)
npm run desktop:build:linux  # → AppImage + deb
```

### Launch modes

| Command | What it does |
|---------|--------------|
| `mmo-chip.exe` | **Local (default)** — spawns a private backend and opens the window on `http://127.0.0.1:3101` |
| `mmo-chip.exe --serve` | **Shared server** — spawns the backend, no window; a tray icon lists the LAN URLs. Closing the window keeps the server running (`MMOCHECK_ROLE=server` env does the same) |
| `mmo-chip.exe --connect <host:port>` | **Client** — no local backend; the window attaches to a remote server |
| `mmo-chip.exe --local` | Forget the saved remote connection, back to local mode |
| `mmo-chip.exe --dev-vite` | Dev — attach to a running `npm run dev` stack (Vite on :5173) without spawning anything |

### Team setup: one server, many clients

1. One person starts the shared server: `mmo-chip.exe --serve`. Allow the
   Windows Firewall prompt on first run (or open TCP 3101 manually) — the
   tray shows the addresses to share.
2. Everyone else opens `http://<ip>:3101` in a regular browser — zero
   installation. For the frameless desktop window instead of a tab:
   `mmo-chip.exe --connect <ip>:3101`. The address is remembered, so plain
   launches reconnect to the server; `--local` switches back to the private
   backend.
3. All data and heavy jobs (ngspice, LVS, ML) run on the server machine —
   clients only need the browser.

Optional auth: set `JWT_SECRET` on the server to require login (the app ships
a login/register page); without it anyone on the LAN has full access.

ML is optional: run `setup_ml.bat` / `setup_ml.ps1` (Linux: `setup_ml.sh`) in
the app folder to install the Python sidecar as a plugin (GPU auto-detected);
the app starts it automatically on the next launch. Without it everything
else works out of the box.

Frameless in-app title bar, MCP via `http://127.0.0.1:3101/mcp` + the Claude
Desktop `.mcpb`. Details: [docs/DESKTOP_BUILD.md](docs/DESKTOP_BUILD.md).

---

## Data and Editing

Wire, bus, ruler and polygon tools support free, orthogonal, horizontal, vertical and diagonal angle modes remembered per die; hold `Shift` to place freely. Via colors and wire/cell colors can be inspected or copied from the Inspector. Tooltips show keyboard shortcuts, and popovers support scrolling.

---

## Supported Devices

| Device | Detection | Parameters |
|--------|-----------|------------|
| **NMOS / PMOS** | Well-based via Clipper2 (diffusion split at poly gates). No markers needed | W, L, fingers, M. Bulk: contact on well → netId; absent → VDD/GND |
| **NPN** | Marker `npn_id` + collector/base/emitter | AE (base∩emitter overlap), M |
| **PNP / LPnp** | Marker `pnp_id` | AE, PE (emitter perimeter), M |
| **Diode** | Marker `diode_id` **or** NPN/PNP without collector | Area (AE from base-emitter overlap) |
| **Resistor** | Geometric: body (poly/base/emitter/hsr/film) → ME1 → contacts → PLUS/MINUS groups. No marker needed | Ω or squares × Rₛ. Body layers: poly-R, p-base, n+, HSR, thin film |
| **Capacitor** | Marker `cap_id` (overlap area) | fF = area × density (needs verification) |

---

## How to Draw Devices

All layers are drawn in **Cell RE** with the corresponding tool (rect/polygon/polyline).

### MOS

| Layer | Purpose |
|-------|---------|
| `nwell` / `pwell` | Well — nwell→PMOS, pwell→NMOS |
| `diffusion` | Source + drain region |
| `polysilicon` | Gate(s) crossing diffusion |

1. Draw well → diffusion inside well → polysilicon across diffusion  
2. **Bulk:** place `cont` (contact) on well **outside** diffusion/poly. If absent → VDD (PMOS) / GND (NMOS)  
3. **Multi-finger:** Clipper2 splits diffusion between gates → N separate MOS  
4. **Metal-connected D/S:** drain/source connected by ME1 (or ME2+via) inside the cell get a shared netId  

> Detailed pipeline: [`docs/mos_detection.md`](docs/mos_detection.md)

### BJT

| Layer | Purpose |
|-------|---------|
| `npn_id` / `pnp_id` | Bounding box |
| `collector` / `base` / `emitter` | Device regions |

1. Draw bounding box → layers inside → `cont` on each layer (terminals matched automatically)  
2. **Multi-emitter:** multiple emitters → summed AE, multiplier M = count  
3. **PNP/LPnp:** PE = emitter perimeter (primary parameter)

### Diode

**Recommended:** draw NPN/PNP without collector → automatic diode. Base = anode, emitter = cathode.

### Resistor

| Layer | Purpose |
|-------|---------|
| `poly` / `base` / `emitter` / `hsr` / `film` | Body (choose one) |
| `contact` | Contacts (min 2) |

1. Select **body layer** → draw with **polyline tool** (`L`) — orthogonal snap, width set in toolbar (0–200 µm)  
2. Draw ME1 overlapping body → place 2+ contacts (become PLUS/MINUS)  
3. Click any segment → entire chain selected → edit width in right panel  
4. Opacity slider helps align width over the image  

> Sheet R₀: configurable in GUI (poly=25, hsr=1500, pb=200, npl=5, film=500 Ω/□)

### Capacitor

Draw `cap_id` (bbox) — PLUS/MINUS both on `contact`. Not tested.

---

## Metal Stack (configurable multi-layer)

Die viewer supports 1–6 metal layers (ME1–ME6) with corresponding vias (VIA12–VIA56).

### Configuration

**Net Settings** (gear icon next to "Nets") → **Metal layers** select (1–6). Saved per-project, no reload needed. Default: 6 metals.

| UI element | Adapts to |
|------------|-----------|
| Layer color pickers | Only configured metals |
| Wire/Via toolbar chips | Only configured metals/vias |
| Hotkeys 1..6 / Alt+1..5 | Range limited to configured stack |
| E/Q via up/down | Picks correct via from stack |
| W cycle | Cycles only through configured metals |
| ProblemNavigator | Checks dangling vias against correct metal pair |

### Per-layer colors

Custom wire and via colors in Net Settings / Via Settings popovers. Persisted per-project.

### Via labels

At zoom ≥ 8×, each via shows its type (VIA12, VIA56…) centred on the circle — black background, white bold text. Toggle: **VIA LABEL** in right panel.

---

## Die Viewer Features

### Large Images and Overlays

- Import dies and overlays from pyramidal or tiled TIFF files, including SubIFD/OME-TIFF and SVS pyramids. Stored resolution levels are used directly for zoomed-out views, and high-resolution tiles decode only the regions they cover.
- Background tile generation resumes after a backend restart and skips tiles already present on disk.
- Overlay layers can be deleted from the server; deletion affects everyone using that project.
- Export very large, high-resolution screenshots using the resolution panel described in [Screenshot](#screenshot).

### Wire Tool

- **Layer switching:** `W` activates wire tool; repeat cycles through metal stack (ME1→…→ME6→ME1)  
- **Via placement (E/Q):** places via at snapped wire-end preview (default). Toggle **Via: cursor / wire-end** in toolbar for raw cursor mode  
- **Cross-layer snap prevention:** wires of different metals only connect through a matching via annotation  
- **AutoVia (checkbox):** clicking an adjacent-metal vertex auto-places the via annotation  
- **Via tool (O):** toggles via placement; repeat cycles via types (VIA12→VIA23→…)  
- Device contacts connect to **ME1 only** — ME2+ requires a via
- **Multi-wire (`B`)** supports multiple bends and aligns staggered wire starts to a common front.
- Wire and polygon tools support free, orthogonal, horizontal, vertical and diagonal angle modes. Each tool remembers its mode per die; hold `Shift` to place freely.
- Net width is stored per die. Individual nets can have custom colors and visibility; individual cell visibility can also be toggled without changing global visibility.
- Hold over a net in the Outline Tree or canvas to zoom to it. Net vertices can show toggleable crosses.
- Right-click a cell for rotate and mirror actions. Cell resize handles resize instances of the same type together.
- I/O points can be dragged, and their labels can be toggled independently. Multiple pads may share one pin number; copy/paste pads, and renaming a pad updates all pads for that pin.
- Double-click a net to rename it or change its color. Double-click a cell to change its type. These windows are draggable and remain anchored to their objects while panning and zooming.
- Double-click an I/O pin on the canvas to rename it. The selection rectangle remains anchored to the die while zooming or scrolling and auto-pans at the canvas edge.
- The bottom information panel shows details about the object under the pointer.

### ProblemNavigator

Unified issue panel (`IssuesChip` button). Checks: connectivity (unconnected terminals), wiring (stubs), vias (dangling per metal pair), I/O pin mismatches, overlaps (same-metal), electrical warnings.

> [`docs/problem-navigator.md`](docs/problem-navigator.md)

### Cell Operations

| Action | How |
|--------|-----|
| **Copy / Paste** | `Ctrl+C` / `Ctrl+V` or right-click context menu |
| **Make Unique** | `Shift+U` or right-click — detach cell from shared type, edit independently |
| **Rotate / Flip** | Right-click a cell → Rotate 90° clockwise / Flip horizontally / Flip vertically (whole selection if the cell is selected) |
| **Copy I/O pads** | Select pads + `Ctrl+C`, or right-click → Copy pad; `Ctrl+V` adds pads with the same pin number and name |
| **Cell Relationship** | Toggle **CELL REL** in right panel — highlight all same-type cells, dim others |

### Device Registry

Each device gets a stable UUID from `kind + position + subType`. Renames and parameter overrides persist across re-extraction and sessions.

### Layer Reference (Cell RE)

| Layer | Group |
|-------|-------|
| `diffusion` / `polysilicon` / `nwell` / `pwell` | MOS |
| `collector` / `base` / `emitter` | BJT |
| `hsr` / `film` | Resistors |
| `npn_id` / `pnp_id` / `res_id` / `cap_id` | Markers |
| `metal1`–`metal6` | Metallization |
| `via1`–`via5` | Via layers |
| `contact` | Contacts |

### Screenshot

`Ctrl+Shift+S` (or the download button in the SubBar) exports the current die view as PNG, composited with all overlay layers including analog device highlights.

**Right-click the button** for the resolution panel: a slider from 0.5× to the die's **native** resolution for the current zoom (one output pixel per pixel of the finest image tiles, at least 4×), the resulting size in pixels, and a **Native** setting that follows the zoom. The choice is remembered. Higher settings re-render the view and load finer image tiles, so they add real detail; the image is rendered in bands and streamed into the PNG, so it can be far larger than the screen (up to 2 gigapixels). Progress is shown while tiles load, and long exports can be cancelled. Overlay drawings on top (analog highlights, comments) are stretched from screen resolution.

### Search

`Ctrl+F` opens a filter input in the Outline Tree. Type to filter nets/cells by name. Enter focuses the first match on canvas. Esc closes. Search icon in "Items" header.

### Miscellaneous

- **Net ID overlay:** human-readable net names on die viewer (toggle in side panel). VDD/GND hidden  
- **Layout comments:** clickable annotation icons with text, author, replies (WebSocket sync)
- **Keyboard shortcuts panel:** `Ctrl+/` opens a modal with all shortcuts grouped by category. `?` button in TopBar

---

## CV Cell Detection

Computer vision tools for automated cell instance detection. Available in the right panel (CV tab).

| Method | Status | Description |
|--------|--------|-------------|
| **Template matching** | Stable | Sobel-based template matching against a reference crop. Main working method for cell detection. |
| **AKAZE verify** | Optional | Compares detected cells pairwise via AKAZE keypoints. Cells below similarity threshold are removed. Used to filter false positives after template matching. |
| **Contour detection** | Experimental | Tree-based contour matching. Not reliable yet. |

---

## Cells — Clean Specimens, Wire Map & Shared Libraries

With cells recognised, the *Cells* tab can build a **clean specimen** per cell type: every instance is cropped, un-flipped, registered and brightness-matched, and the per-pixel median is kept, so wires routed over the cell and debris drop out. The image shown in the UI is a sharper rendering of the same idea — only the best-focused third of the instances, each registered with a small affine, reconstructed at 2× and sharpened. Merge cells uses it as the reference, and Cell RE shows it when a cell type is selected (selecting one instance shows that instance). Running it in reverse gives the **wire map**: each placed cell minus its type's specimen, keeping long straight residue, is pasted back over the die as a translucent overlay of the wires crossing recognised cells. Both are derived data under `data/dies/<die>/cell-specimens/` and `data/dies/<die>/wire-map/`.

A **cross-die cell library** shares cell types (and their specimens) between dies so the same cell can be reused across a whole project. Instances placed from the library are registered at the target die's scale, and editing a shared type propagates to every die that uses it; remote instances are badged in the Cells panel.

---

## Schematic Viewer

Transistor-level schematics from SPICE netlists with an **interactive canvas** (default engine).

- **Interactive (default)** — drag devices, lock positions (persisted), multi-select, rotate/flip symbols, undo/redo
- **Hierarchy** — floorplan regions as collapsed blocks with port labels; double-click / right-click a block to open its schematic. Region tabs (All, bandgap, …)
- **I/O pins** — die-level I/O pin symbols and nets
- ELK layout (strategy/direction/compaction + spacing/edge tuning in Netlist Settings), ctrl+wheel zoom, net-name tooltips on wires
- Export: PNG, SVG (black-on-white)
- **Legacy static renderer** (netlist2svg, opt-in): Static/Interactive toggle, Functional block diagram, pan/zoom buttons, SVG/PNG/JSON download

---

## LVS (Layout vs Schematic)

Compare extracted netlist against a hand-drawn schematic.

| Engine | When |
|--------|------|
| **name-based** | Device names match (Q1, M2, R5…) |
| **vyges-lvs** | Name-independent topology comparison (netgen-like) |

Available on the Analog Netlist page (`Alt+4`).

---

## Floorplan Regions

Rectangular/polygonal regions for marking analog blocks. Features include color, name, port aliases, reservation, global net rename, boundary port dots, editable geometry, copy/paste, multiline names and per-region visibility. Changes support undo/redo; selected regions appear in the Inspector. `Esc` exits the tool; `Enter` or double-click finishes a polygon. `Space+H` toggles floorplan visibility.

| Key | Action |
|-----|--------|
| `H` | Activate tool |
| `Ctrl+Shift+H` | Toggle overlay |

---

## Project Export / Import

```http
POST /api/dies/:dieId/export-project    # JSON: light (annotations) / full (+ images)
POST /api/dies/import-project           # Conflict handling (overwrite/skip)
POST /api/dies/:dieId/rename            # Rename die
```

Full export preserves original + overlay images. Preferences exported from localStorage.

Projects using older `data/` formats remain supported.

---

## Layout Comments

Comments and replies are synchronized through WebSocket. Drag a comment marker to move it; authors can edit or delete their comments and replies, with undo support. The close button only closes a comment; use the delete action to remove it. `Space+M` toggles comment visibility.

---

## Merge Cells

Compare and align instances of a cell type. Multi overlay shows all instances together; rotated instances are cropped from their real die footprint and displayed upright in the type's frame. Drag alignment and auto-alignment use this same frame, and merging preserves the cell-box centre. Stretch lines (`S`) let you align non-uniform geometry piece by piece in overlay, difference and candidate views; edits are undoable. Thumbnails reuse the die viewer's tiles.

---

## Code Editing

Generated netlists on the Code and Analog Netlist pages can be edited directly and re-parsed into the schematic. Popovers support scrolling, and UI tooltips show available keyboard shortcuts.

---

## Folder Projects

Projects can live in independent folders instead of the managed application data directory.

- **Open folder** — reopen an existing folder project from the Library
- **Create in folder** — create a new project in an empty directory
- Import images or project ZIPs directly into a selected folder
- Relocate a folder project after it was moved or renamed
- Removing a folder project from the Library does not delete its folder from disk

---

## SPICE Simulation

Run extracted analog netlists with ngspice directly from the application.

- WASM or server-side ngspice engine
- Select the full netlist or an extracted subcircuit
- **One model per device type** — NMOS/PMOS Level 1, EKV or BSIM4; NPN/PNP
  Gummel–Poon or Ebers–Moll; junction, zener or schottky diode. Picking one
  never selects anything for the other types, and your own card always wins
  over the library. Each `.MODEL` name is emitted exactly once, so the cards
  no longer pile up in the netlist
- **Hand-editable simulation netlist** — what you see is what ngspice runs
- **Testbench view** — the DUT is always drawn as a block with its pins, with
  the testbench sources and loads wired to them: a flat DUT (an AI finding, a
  hand-written fragment) is wrapped into a `.subckt` with inferred pins, and a
  subcircuit nobody instantiated gets its instance back
- **"Ask agent" as a collapsible right panel**, with a trace of every run
  (netlist, measurements, warnings) in the chat
- **Results that do not need a curve** — an `.op` run shows its `.measure`
  values and the operating point as tables, instead of an empty chart
- `.param` and `.step` support with step progress
- Waveform, schematic, and generated netlist views
- Interactive waveform inspection and PNG export with a white background

The testbench directives start empty on purpose: the sources and the analysis
depend on the selected DUT's pins, so a hard-coded example is always wrong.
Ask the agent to write the testbench, or type it yourself.

The extracted netlist is Spectre-flavoured, so both engines run it through
`shared/spiceNetlist` first: parenthesised node lists become positional,
arithmetic values (`16.8*250`) become numbers, `r=1.9*Rp` becomes `{1.9*Rp}`,
missing model cards are filled in with generic ones, and a title comment is
added so that SPICE does not swallow a leading `.model` line as the title.
A netlist without an analysis directive gets a `.op`, so the run never returns
ngspice's built-in constants instead of circuit results.

The assistant's SPICE tool follows the same rules and adds a little more: it
completes a testbench that forgot the supply, renames the ground rail to node
0, instantiates a subcircuit nobody instantiated, drops device lines the model
repeated, and returns the `.measure` results. When a run fails, the tool
reports the ngspice error instead of pretending it succeeded.

`testdata/analog/lm2937_bandgap.cir` is a ready-made bandgap testbench
(`ngspice -b lm2937_bandgap.cir` → `v(ref) ≈ 0.91 V` with generic models).

| Key | Action |
|-----|--------|
| `Ctrl+Enter` | Run simulation |
| `Ctrl+,` | Open simulation settings |

---

## IC Package / Pin Planner

Map die I/O pins to package pins using a footprint generated by `@tscircuit/footprinter`.

This is an alignment and bond-mapping tool, not a complete package design or mechanical land-pattern editor. It uses footprints from the supported package library and is intended for matching package pins to die I/O pads.

- Select a supported package footprint with numbered pins
- Name package pins directly on the canvas
- Rotate and mirror the die relative to the package frame
- Create multiple bond wires between package pins and die I/O pads
- Configure bond wire width, default 30 µm
- Apply names from named package connections back to die I/O pins
- Export the alignment view as PNG and the pin table as CSV

| Key | Action |
|-----|--------|
| `S` | Pan / zoom |
| `T` | Name a package pin |
| `W` | Create a bond wire |

---

## LLM-Assisted Analysis

The optional AI Assistant analyzes the extracted netlist and generates ranked hypothesis cards for possible circuit functions, device roles, or suspicious connectivity. Cards include confidence, reasoning, evidence, affected devices, and suggested checks. Hypotheses are locally checked for valid device references and connectivity before becoming interactive cards; this does not prove the electrical function.

The assistant is read-only. It can display hypotheses on the die, open them in Net Graph, and show netlist or schematic fragments.

During finding discussions, the model can use controlled tool calls when enabled:

- **`mmochip_lvs_check`** — compare a candidate subcircuit with the `analog-circuits-sky130` reference LVS library using topology matching. The active library can be selected, and users can add custom reference cells from SPICE/Spectre subcircuits.
- **`mmochip_vision`** — request rendered die crops and overlay layers for multimodal models to inspect device geometry and terminal connectivity.
- **`mmochip_spice_sim`** - run a server-side ngspice check of a hypothesis and return simulation measurements. The model writes only the testbench (the tool adds the extracted circuit itself), the tool normalises the netlist for ngspice, runs every requested analysis, and returns the node voltages plus the `.measure` results; a run that produced no data is reported as a failure instead of an empty success. The run is shown as a card in the discussion thread (netlist, measurements, warnings) with a button that opens it in the SPICE simulator.
- **`mmochip_card_update`** — propose a structured update to an existing hypothesis card.

Tool access is explicitly controlled by the user. The model proposes hypotheses and evidence; the user reviews and verifies the result.

---

## Hotkeys

| Key | Action |
|-----|--------|
| `S` | Select |
| `W` | Wire tool (repeat → cycle metal layer) |
| `E` | Via up (wire-end preview, switches to next metal) |
| `Q` | Via down (wire-end preview, switches to prev metal) |
| `B` | Multi-wire / Bus |
| `O` | Via tool (repeat → cycle via type) |
| `K` | Ruler / Measurement: draw multiple rulers |
| `Shift+K` | Delete all rulers |
| `Delete` | Delete selected ruler(s) |
| Right-click ruler | `Delete ruler` or `Set scale from ruler`; double-click remains a Set Scale shortcut |
| `R` | Add Cell |
| `P` | I/O Point |
| `F` | Fit to Screen / Pan |
| `H` | Floorplan tool |
| `+` / `=` | Zoom in |
| `-` | Zoom out |
| `1` … `6` | Select metal ME1 … ME6 |
| `Alt+1` … `Alt+5` | Select via VIA12 … VIA56 |
| `Shift+1` … `Shift+5` | Navigate tabs: Die / Merge / RE Cell / Code / Analog Netlist |
| `Ctrl+Z` / `⌘Z` | Undo |
| `Ctrl+Shift+Z` / `⌘⇧Z` | Redo |
| `Ctrl+C` / `⌘C` | Copy selected cells / I/O pads / wires |
| `Ctrl+V` / `⌘V` | Paste |
| `Shift+U` | Make Unique (cell) |
| `Ctrl+Shift+S` | Screenshot (PNG; right-click its button for resolution) |
| `Ctrl+F` | Search nets / cells |
| `Ctrl+/` | Keyboard shortcuts panel |
| Space (hold) | Temporary pan |

### Ruler tool

Press `K` and drag across the die to measure. Measurements are orthogonal by default. Create multiple rulers, use `S` to select one, `Shift+click` to select several, and click empty canvas space to clear the ruler selection. Press `Delete` to remove selected rulers or `Shift+K` to remove all rulers.

Set the scale with double-click or right-click → **Set scale from ruler**. After scale is set, lengths are shown in µm; values below 1 µm are shown in nm. At zoom below 20%, inactive rulers are hidden while the current preview and selected ruler remain visible.

### Cell RE

| Key | Tool |
|-----|------|
| `R` | Rect |
| `P` | Polygon |
| `O` | Point / via |
| `L` | Polyline (resistor) |

### Overlay Images

| Key | Action |
|-----|--------|
| `Space+B` | Toggle base image |
| `Space+C` | Toggle cell visibility |
| `Space+N` | Toggle net visibility |
| `Space+H` | Toggle floorplan visibility |
| `Space+M` | Toggle comment visibility |
| `]` / `[` | Next / previous overlay layer only |
| `Space+1..8` | Show only overlay layer N; repeat to hide it |

Overlay layer settings (visibility, opacity, offset) are persisted per-die in localStorage. **Upload to Server** saves images to the die's folder for automatic reload.

### Analog Netlist

| Key | Action |
|-----|--------|
| `G` | Toggle Code / Graph |
| `H` | Hierarchical on/off |
| `R` | Resistor format (Ω / sq·Rs) |
| `M` | Device matching on/off |
| `Alt+1..4` | Code / Graph / Schematic / LVS view |

### Merge Cells

| Key | Action |
|-----|------|
| `Alt+1`…`6` | Overlay / Side-by-side / Diff / Specimen / Candidate / Multi overlay |
| `←` / `→` | Previous / next candidate |
| `F` / `G` / `H` | Flip horizontally / Flip vertically / Rotate 90° (as shown) |
| `J` | Auto-align from ML vias |
| `S` | Stretch lines on / off |
| `Y` | Accept & merge |

---

## What's Not Done Yet (priority)

- **DMOS, Schottky diode, VPNP, JFET** — no detection or markers  
- **Wire matching** — tolerance = contact size × 0.5; dense routing may false-positive  
- **Polyline post-edit** — stretch/reshape (only redraw from scratch)  
- **Hierarchical netlist / floorplan** — interactive viewer supports it; alias collision + rename speed still need real-world validation

---

## ⚠️ Disclaimer

**Still alpha / WIP.** Only unit tests for extraction (22 tests: 18 pass, 4 skip). No e2e tests, no tests for overlay, wire matching, SPICE export, or cross-tab navigation.

---

## Repository Structure

```
frontend/     Vite + React + TypeScript — die viewer, cell RE, analog netlist
backend/      Node + TypeScript API — import, tiling, JSON persistence, WebSocket
shared/       Shared TypeScript types
ml/           Python U-Net (optional, assisted annotation)
docs/
  analog-devices.md           ← analog device detection docs
  mos_detection.md            ← MOS pipeline (Clipper2, poly gate, metal merge)
  netlist_warnings.md         ← SPICE/CDL warnings reference
  problem-navigator.md        ← ProblemNavigator details
  lvs-plan.md                 ← LVS architecture
```

Key extraction files: `dieWideAnalog.ts`, `simpleAnalog.ts`, `spice.ts` (`frontend/src/`).
