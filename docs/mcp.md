# MCP server (`/mcp`)

The app serves a [Model Context Protocol](https://modelcontextprotocol.io) endpoint
directly from the backend: **`POST /mcp`**, Streamable HTTP with JSON responses (no
server-initiated SSE stream). There is no separate stdio server any more; `list_dies`
returns every project, and every other tool takes a `dieId`.

```
MCP client  --HTTP POST /mcp-->  backend :3001  -->  project data
```

## Connect

The endpoint is shown in the die viewer's **MCP** tab. For local development it is
`http://127.0.0.1:3001/mcp`.

- **Claude Code**: `claude mcp add --transport http mmo-chip http://127.0.0.1:3001/mcp`
- **opencode**: `opencode.json` in the repo root already points at it as a remote server.
- **Claude Desktop**: `npm run mcpb` builds `dist/mmo-chip.mcpb`; install it and paste the
  endpoint into the extension settings.
- **Auth**: only needed when the backend runs with `JWT_SECRET`. Send the login token as
  `Authorization: Bearer …` (MCPB asks for it, Claude Code accepts headers).

The first call on a die nobody approved yet becomes **pending** and waits up to 50 seconds
for a user decision in the GUI (`McpAccessPrompt`). Approve/Deny is per die and persists in
`<dataRoot>/mcp-access.json`. `list_dies` reports `not_requested`, `pending`, `approved` or
`denied`.

## Tools (36)

**Read**

| Tool | Does |
| --- | --- |
| `list_dies` | All projects, size and MCP access state. Start here. |
| `get_die_info` | Size, scale, overlays (with `purpose` / `purposeSource`), annotation counts, write mode, process, metal stack. |
| `get_annotations` | JSON sections with `offset`/`limit` and an approximate `bbox` filter; returns `mcpOwnedIds`. |
| `get_die_image` | Die photo, a region, `maxSize` and optional `overlayId`; returns JPEG + coordinate mapping. |
| `render_annotated_image` | Die region with annotations, highlights, marks (box/circle/arrow/polyline/label) and legend. |
| `list_overlay_layers` | Base + overlays with dimensions, tile progress, `purpose`, `purposeSource`, `suggestedPurpose`. |
| `get_region_summary` | Cells/nets/pins/comments/floorplans/rulers intersecting a rect, with bboxes. |
| `find_wires_near` | Exact net nodes, segments and vias around a point, with ids, distance and ownership. |
| `get_spice_config` | Saved SPICE technology config. |
| `get_analog_devices` | Analog device-name store. |

**Markup / wires**

| Tool | Does |
| --- | --- |
| `add_comment`, `reply_to_comment`, `update_comment`, `delete_comment` | Comments and replies; optional rendered image attachment. |
| `add_floorplan_region`, `update_floorplan_region`, `delete_floorplan_region` | Functional-block outlines. |
| `add_ruler`, `update_ruler`, `delete_ruler` | Measurements in die pixels / µm. |
| `add_wire`, `update_wire`, `delete_wire` | Create nets, extend/connect/merge nets; only MCP-owned geometry is editable in `edit` mode. |
| `add_via`, `update_via`, `delete_via` | Vias on the metal/process stack. |
| `edit_cells`, `edit_pins` | Place/move/reorient/delete cells and I/O pads (full-edit gate). |
| `edit_annotations` | Batch `upsert`/`delete`/`set` of any section (full-edit gate). |

**Analysis / simulation**

| Tool | Does |
| --- | --- |
| `export_netlist` | Re-run extraction on current annotations; CDL/Spectre/HSPICE text + counts/warnings. |
| `run_ngspice` | Run a deck or `subcircuit` + `directives`; measurements/variables/notes. `publish` stores the run for SPICE. |
| `simulate_block` | Extract a floorplan/cell/net selection as `.SUBCKT` with rigid ports, auto-`X1`, run the testbench and publish the handoff. |
| `run_lvs` | `vyges-lvs` or name-based layout-vs-schematic comparison. |
| `export_project` | Portable ZIP (`light`/`full`) written to a local temp path. |
| `ml_job` | `status` / `start` / `stop` the ML via sweep. |
| `cell_detection` | `status` / `start` / `stop` / `list` cell-placement proposals. |

`edit_nets` is deliberately not a separate tool: the wire/via tools above cover nets with
stricter ownership and graph rules. `set_scale` and `get_crop(cellId/cellTypeId)` are not
exposed by design: scaling is a user action, and `get_die_image` by rect + `overlayId`
covers crops. `get_metal_stack` is not separate either — `get_die_info.metalStack` has it.

## Write access

Per die, in the MCP tab:

- `mode`: `off` (read-only), `create` (comments, replies, floorplans, rulers),
  `edit` (also modify/delete MCP-created markup);
- `wires`: separate toggle for nets/vias (creating into any net is allowed, but only
  MCP-created nodes/segments/vias may be moved or deleted);
- `full`: overrides both — any annotation, human-made included, can be changed.

MCP writes have their own server-side undo/redo stack (MCP tab), independent of the die
viewer's Ctrl+Z. `get_die_info` reports the current gates before you write.

## Layers

`list_overlay_layers` returns `__base__` plus uploaded overlays. A user can set an
explicit purpose in the die viewer's overlay list; otherwise the name heuristic applies
(`sirtl` → diffusion, `me1` → metal1, `via12` → via). `purposeSource` is `user`, `auto` or
`none`, so an unlabelled layer is explicit rather than guessed.

## Block simulation and SPICE handoff

`simulate_block` selects devices by `regionId`, `cellIds` and/or annotation `netIds`, then:

- a net touched only by selected devices is **internal**;
- a net that also reaches an unselected device becomes a **port**;
- the generated `X1` uses `block.ports`; the testbench contains only sources, loads,
  analysis and `.measure` (do not write `X1`/`.SUBCKT`).

With `publish:true` (default) the run is stored at `<project>/spice-runs/latest.json`.
The SPICE Simulation tab shows an **“MCP agent run”** banner and opens it through the
normal handoff path, so the testbench/models stay editable and the run can be replayed.
`run_ngspice` accepts the same `publish` flag.

## Development

```bash
npm run dev                                   # backend on :3001
npx tsc -p backend/tsconfig.json --noEmit     # typecheck
node --import tsx --test backend/src/mcp/mcp.test.ts
```

The MCP implementation lives in `backend/src/api/mcp.ts` (transport, approval, GUI routes),
`backend/src/mcp/mcpTools.ts` (read/markup tools), `mcpWires.ts`, `mcpFullEdit.ts`,
`mcpExtended.ts` (netlist/SPICE/LVS/ML/export), `mcpBlock.ts` (rigid block partition),
`mcpAccess.ts` (per-die approval), `mcpState.ts` (write gates and undo history).
