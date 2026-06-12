# mmo-chip

A tool for reverse-engineering integrated circuits from die photographs, with a special focus on CMOS Gate Array/Standard Cell chips.
Import and tile gigapixel die shots, annotate them (vias, traces, standard cells) with optional ML assistance, and extract the circuit,
per-cell transistor and logic-gate schematics, and a die-level Verilog netlist.

**Die viewer** — navigate the whole die, with placed cells, nets, and I/O pins.

![Die viewer](docs/die-viewer.png)

**Cell RE** — annotate a cell's layers; transistors, gates, and logic are inferred.

![Cell reverse-engineering](docs/cell-re.png)

Die shots in those screenshots are from [InfoSecDJ](http://infosecdj.net/).

## Structure

```
frontend/   Vite + React + TypeScript UI (die viewer, cell RE, schematics, Verilog)
backend/    Node + TypeScript API — image import, tiling, JSON persistence, WebSocket
shared/     Shared TypeScript types (the annotation schema)
ml/         Python U-Net for via/trace detection + FastAPI prediction sidecar
data/       Imported dies, tile pyramids, and ML exports
```

## Dependencies

- **Node ≥ 20** (npm workspaces) — required.
- **Python ≥ 3.10** — only for the ML sidecar (assisted via/trace annotation).

```sh
# JS/TS workspaces (frontend + backend + shared)
npm install

# ML sidecar (optional)
python3 -m venv ml/.venv
ml/.venv/bin/pip install -r ml/requirements.txt
```

## Run locally

```sh
npm run dev
```

Starts the backend (http://localhost:3001), the frontend
(http://localhost:5173), and the ML sidecar together. Open the frontend URL.

Without the ML sidecar, run just the two TypeScript apps:

```sh
npm run dev -w backend
npm run dev -w frontend
```

Build and test:

```sh
npm run build
npm test
```

**IMPORTANT NOTE:** This software is still very early in development and has been tested only locally (firewalled). Use at your own risk.
