import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AnalogDevice,
  Cell,
  DieAnnotations,
  FloorplanRegion,
  IOPin,
  RulerMeasurement
} from "shared";
import { listManifests } from "../api/overlayImages.js";
import { runVygesLvs } from "../api/lvs.js";
import { cellDieRect } from "../api/tiles.js";
import { executeSpiceSimTool } from "../assistant/spiceSimTool.js";
import { resolveCellType } from "../cellLibrary.js";
import { compareByName } from "../lib/compareByName.js";
import { extractNetlist } from "../netlistExtraction.js";
import { resolveProjectDir } from "../projectLayout.js";
import { readAnnotations, readDieRecord } from "../store.js";
import { buildBlockSubcircuit, parseCdlDevices, selectedModels } from "./mcpBlock.js";
import {
  cap,
  errorResult,
  nonEmpty,
  num,
  point,
  str,
  textResult,
  ToolInputError,
  write,
  type McpToolContext,
  type ToolDef
} from "./mcpToolKit.js";

/** Extra tools ported from the stdio MCP, implemented in-process. */

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function pointInside(x: number, y: number, r: Rect): boolean {
  return x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
}

function pointsBBox(points: Array<{ x: number; y: number }>): Rect | null {
  if (points.length === 0) return null;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys)
  };
}

function regionPolygon(region: FloorplanRegion): Array<{ x: number; y: number }> {
  if (region.kind === "rect" && region.geometry.length >= 2) {
    const a = region.geometry[0];
    const b = region.geometry[1];
    return [
      { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) },
      { x: Math.max(a.x, b.x), y: Math.min(a.y, b.y) },
      { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) },
      { x: Math.min(a.x, b.x), y: Math.max(a.y, b.y) }
    ];
  }
  return region.geometry;
}

function pointInPoly(px: number, py: number, poly: Array<{ x: number; y: number }>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function sanitizeNetName(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(cleaned) && cleaned ? cleaned : `n_${cleaned || "net"}`;
}

function safeName(raw: string, fallback: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(cleaned) && cleaned ? cleaned : fallback;
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function internalFetch(
  ctx: McpToolContext,
  route: string,
  init: RequestInit = {}
): Promise<Response> {
  if (!ctx.baseUrl) throw new ToolInputError("Internal backend URL is unavailable for this call");
  const headers = new Headers(init.headers);
  if (ctx.authToken) headers.set("Authorization", ctx.authToken);
  const response = await fetch(new URL(route, ctx.baseUrl), { ...init, headers });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new ToolInputError(`Backend ${init.method ?? "GET"} ${route} failed (${response.status}): ${text.slice(0, 500)}`);
  }
  return response;
}

async function internalJson<T>(
  ctx: McpToolContext,
  route: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await internalFetch(ctx, route, init);
  return await response.json() as T;
}

// ─── Read: overlay layers ───────────────────────────────────────────

const listOverlayLayers: ToolDef = {
  name: "list_overlay_layers",
  title: "List overlay layers",
  description:
    "List the base image plus every overlay source, with id, name, dimensions, tile progress and " +
    "purpose (`purpose`, `purposeSource` user/auto/none, `suggestedPurpose`). `sirtl` auto-detects as " +
    "diffusion; `me1` as metal1. An overlay with no name match has purposeSource \"none\", so an " +
    "unlabelled layer is explicit rather than guessed.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
  run: async (ctx) => {
    const record = await readDieRecord(ctx.dataRoot, ctx.dieId);
    const overlays = await listManifests(ctx.dataRoot, ctx.dieId);
    return textResult({
      dieId: ctx.dieId,
      width: record.width,
      height: record.height,
      layers: [
        {
          id: "__base__",
          name: "base image",
          kind: "base",
          width: record.width,
          height: record.height,
          tileSize: record.tileSize,
          maxZoomLevel: record.maxZoomLevel,
          purpose: null,
          purposeSource: "none"
        },
        ...overlays.map((overlay) => ({
          id: overlay.id,
          name: overlay.name,
          kind: "overlay",
          width: overlay.width,
          height: overlay.height,
          tileSize: overlay.tileSize,
          tileFormat: overlay.tileFormat,
          hasAlpha: overlay.hasAlpha,
          maxZoomLevel: overlay.maxZoomLevel,
          ready: overlay.ready,
          purpose: overlay.purpose ?? null,
          explicitPurpose: overlay.explicitPurpose ?? null,
          purposeSource: overlay.purposeSource ?? "none",
          suggestedPurpose: overlay.suggestedPurpose ?? null
        }))
      ]
    });
  }
};

// ─── Read: region summary ───────────────────────────────────────────

const getRegionSummary: ToolDef = {
  name: "get_region_summary",
  title: "Summarize a region",
  description:
    "Spatial query over a die rectangle: cells with their computed rect, nets with bounding boxes, " +
    "I/O pins, comments, floorplans and rulers intersecting the rect. Cheaper and more direct than " +
    "paging get_annotations when studying one functional block.",
  inputSchema: {
    type: "object",
    properties: {
      x: point,
      y: point,
      width: { type: "number", minimum: 1 },
      height: { type: "number", minimum: 1 },
      limit: { type: "integer", minimum: 1, maximum: 500 }
    },
    required: ["x", "y", "width", "height"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: true },
  run: async (ctx, args) => {
    const record = await readDieRecord(ctx.dataRoot, ctx.dieId);
    const annotations = await readAnnotations(ctx.dataRoot, ctx.dieId);
    const region: Rect = {
      x: num(args, "x"),
      y: num(args, "y"),
      width: num(args, "width"),
      height: num(args, "height")
    };
    const limit = Math.min(500, Math.max(1, Math.floor(num(args, "limit", true) ?? 200)));
    const types = new Map(annotations.cellTypes.map((type) => [type.id, type]));
    const foreign = new Map<string, Awaited<ReturnType<typeof resolveCellType>>>();
    const cells = [];
    for (const cell of annotations.cells) {
      let type = types.get(cell.cellTypeId);
      if (!type) {
        const key = `${cell.cellTypeId}@${cell.cellTypeDieId ?? ""}`;
        if (!foreign.has(key)) {
          foreign.set(key, await resolveCellType(ctx.dataRoot, record, annotations, cell.cellTypeId, cell.cellTypeDieId));
        }
        type = foreign.get(key)?.type;
      }
      if (!type) continue;
      const rect = cellDieRect(cell, type.cropRect.width, type.cropRect.height);
      if (!intersects(rect, region)) continue;
      cells.push({ id: cell.id, cellTypeId: cell.cellTypeId, x: cell.x, y: cell.y, rect });
    }
    const nets = annotations.nets
      .map((net) => ({ id: net.id, name: net.name, bbox: pointsBBox(net.nodes), nodeCount: net.nodes.length, edgeCount: net.edges.length }))
      .filter((net) => net.bbox && intersects(net.bbox, region));
    const pins = (annotations.pins ?? []).filter((pin) => pointInside(pin.x, pin.y, region))
      .map((pin) => ({ id: pin.id, name: pin.name, pin: pin.pin, x: pin.x, y: pin.y }));
    const comments = (annotations.comments ?? []).filter((comment) => pointInside(comment.x, comment.y, region))
      .map((comment) => ({ id: comment.id, x: comment.x, y: comment.y, text: comment.text, authorName: comment.authorName }));
    const floorplans = (annotations.floorplanRegions ?? [])
      .map((item) => ({ id: item.id, name: item.name, kind: item.kind, color: item.color, bbox: pointsBBox(item.geometry) }))
      .filter((item) => item.bbox && intersects(item.bbox, region));
    const rulers = (annotations.rulers ?? [])
      .map((ruler) => ({
        id: ruler.id,
        ...(ruler.name ? { name: ruler.name } : {}),
        x1: ruler.x1, y1: ruler.y1, x2: ruler.x2, y2: ruler.y2,
        lengthPx: ruler.lengthPx, lengthUm: ruler.lengthUm,
        bbox: pointsBBox([{ x: ruler.x1, y: ruler.y1 }, { x: ruler.x2, y: ruler.y2 }])
      }))
      .filter((ruler) => ruler.bbox && intersects(ruler.bbox, region));
    return textResult({
      dieId: ctx.dieId,
      rev: annotations.rev,
      region,
      counts: {
        cells: cells.length, nets: nets.length, pins: pins.length,
        comments: comments.length, floorplans: floorplans.length, rulers: rulers.length
      },
      cells: cells.slice(0, limit),
      nets: nets.slice(0, limit),
      pins: pins.slice(0, limit),
      comments: comments.slice(0, limit),
      floorplans: floorplans.slice(0, limit),
      rulers: rulers.slice(0, limit)
    });
  }
};

// ─── Read: process / SPICE metadata ─────────────────────────────────

const getSpiceConfig: ToolDef = {
  name: "get_spice_config",
  title: "Get SPICE config",
  description: "The saved SPICE technology configuration for the die (empty object when never saved).",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
  run: async (ctx) => {
    const { dir } = await resolveProjectDir(ctx.dataRoot, ctx.dieId);
    return textResult(await readJson(path.join(dir, "spice_config.json"), {}));
  }
};

const getAnalogDevices: ToolDef = {
  name: "get_analog_devices",
  title: "Get analog device names",
  description: "The project's analog device-name store (device name → geometry / saved name).",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
  run: async (ctx) => {
    const { dir } = await resolveProjectDir(ctx.dataRoot, ctx.dieId);
    return textResult(await readJson(path.join(dir, "analog-devices.json"), { version: 1, devices: {} }));
  }
};

// ─── Netlist / simulation ───────────────────────────────────────────

const exportNetlist: ToolDef = {
  name: "export_netlist",
  title: "Export extracted netlist",
  description:
    "Run the server-side analog extraction on the CURRENT annotations and return a SPICE deck " +
    "(device counts, warnings, virtualConnects, and the text). `persist` also writes " +
    "<project>/export/<module>.cdl.",
  inputSchema: {
    type: "object",
    properties: {
      moduleName: { type: "string" },
      dialect: { type: "string", enum: ["cdl", "spectre", "hspice"] },
      includeText: { type: "boolean" },
      timeoutMs: { type: "integer", minimum: 1000, maximum: 600000 }
    },
    additionalProperties: false
  },
  annotations: { readOnlyHint: true },
  run: async (ctx, args) => {
    const { dir } = await resolveProjectDir(ctx.dataRoot, ctx.dieId);
    const result = await extractNetlist({
      dieId: ctx.dieId,
      projectDir: dir,
      moduleName: str(args, "moduleName", true),
      dialect: (str(args, "dialect", true) as "cdl" | "spectre" | "hspice" | undefined) ?? "cdl",
      timeoutMs: num(args, "timeoutMs", true)
    });
    if (!result.ok) return errorResult(result.error ?? "netlist extraction failed");
    const includeText = args.includeText !== false;
    return textResult({
      ...result,
      ...(includeText ? {} : { text: undefined }),
      textChars: result.text?.length ?? 0
    });
  }
};

const runNgspice: ToolDef = {
  name: "run_ngspice",
  title: "Run ngspice",
  description:
    "Run ngspice through the backend simulation service. Supply a full `netlist`, or `subcircuit` + " +
    "`directives`. Returns measurements, variables, notes and the simulated netlist; waveform arrays " +
    "are dropped unless `includeRawData`. Set `publish:true` to store the run for the SPICE tab.",
  inputSchema: {
    type: "object",
    properties: {
      netlist: { type: "string" },
      subcircuit: { type: "string" },
      directives: { type: "string" },
      testbench: { type: "string" },
      dutNetlist: { type: "string" },
      analysis: { type: "string", enum: ["tran", "dc", "ac"] },
      models: { type: "array", items: { type: "string" } },
      binPath: { type: "string" },
      includeRawData: { type: "boolean" },
      publish: { type: "boolean" }
    },
    additionalProperties: false
  },
  annotations: { readOnlyHint: false },
  run: async (ctx, args) => {
    const execution = await executeSpiceSimTool({
      netlist: str(args, "netlist", true),
      subcircuit: str(args, "subcircuit", true),
      directives: str(args, "directives", true),
      testbench: str(args, "testbench", true),
      dutNetlist: str(args, "dutNetlist", true),
      analysis: str(args, "analysis", true) as "tran" | "dc" | "ac" | undefined,
      models: Array.isArray(args.models) ? args.models.map(String) : undefined,
      binPath: str(args, "binPath", true)
    });
    const result = execution.result;
    const payload = {
      ...result,
      rawData: result.success && args.includeRawData === true ? execution.rawData : undefined,
      dataColumns: args.includeRawData === true ? execution.dataColumns : undefined
    };
    if (result.success && args.publish === true && ctx.baseUrl) {
      const netlist = result.run?.netlist ?? str(args, "netlist", true) ?? "";
      await internalJson(ctx, `/api/dies/${encodeURIComponent(ctx.dieId)}/spice-handoff`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          netlist,
          summary: result.run?.summary ?? `${result.plot ?? "SPICE"} — ${result.numPoints ?? 0} points`,
          plot: result.plot,
          measurements: result.measurements,
          at: Date.now()
        })
      }).catch(() => undefined);
    }
    return result.success ? textResult(payload) : errorResult(JSON.stringify(payload));
  }
};

const simulateBlock: ToolDef = {
  name: "simulate_block",
  title: "Simulate a block",
  description:
    "Extract a selection (floorplan `regionId`, `cellIds` and/or annotation `netIds`) as a `.SUBCKT` " +
    "using the rigid boundary rule: nets only inside are internal, crossing nets are ports. " +
    "Auto-instantiates X1 and runs `testbench` (sources/loads/analysis only). Publishes the run for " +
    "the SPICE tab by default.",
  inputSchema: {
    type: "object",
    properties: {
      regionId: { type: "string" },
      cellIds: { type: "array", items: { type: "string" } },
      netIds: { type: "array", items: { type: "string" } },
      name: { type: "string" },
      testbench: { type: "string" },
      models: { type: "array", items: { type: "string" } },
      binPath: { type: "string" },
      publish: { type: "boolean" }
    },
    required: ["testbench"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: false },
  run: async (ctx, args) => {
    const regionId = str(args, "regionId", true);
    const cellIds = Array.isArray(args.cellIds) ? args.cellIds.map(String) : [];
    const netIds = Array.isArray(args.netIds) ? args.netIds.map(String) : [];
    if (!regionId && cellIds.length === 0 && netIds.length === 0) {
      throw new ToolInputError("simulate_block needs regionId, cellIds or netIds");
    }
    const testbench = nonEmpty(str(args, "testbench"), "testbench");
    const [record, annotations] = await Promise.all([
      readDieRecord(ctx.dataRoot, ctx.dieId),
      readAnnotations(ctx.dataRoot, ctx.dieId)
    ]);
    const { dir } = await resolveProjectDir(ctx.dataRoot, ctx.dieId);
    const analog = await readJson<{ devices?: Record<string, string> }>(path.join(dir, "analog-devices.json"), { devices: {} });
    const netlist = await extractNetlist({ dieId: ctx.dieId, projectDir: dir, moduleName: "block_probe", dialect: "cdl" });
    if (!netlist.ok || !netlist.text) return errorResult(netlist.error ?? "netlist extraction failed");
    const devices = parseCdlDevices(netlist.text);
    const devicesByCell = new Map<string, string[]>();
    for (const [key, name] of Object.entries(analog.devices ?? {})) {
      const at = key.lastIndexOf("@");
      if (at < 0) continue;
      const cellId = key.slice(at + 1);
      devicesByCell.set(cellId, [...(devicesByCell.get(cellId) ?? []), name]);
    }
    const selected = new Set<string>();
    for (const cellId of cellIds) {
      const names = devicesByCell.get(cellId);
      if (!names?.length) throw new ToolInputError(`Cell "${cellId}" has no extracted devices`);
      for (const name of names) selected.add(name);
    }
    if (regionId) {
      const region = (annotations.floorplanRegions ?? []).find((item) => item.id === regionId);
      if (!region) throw new ToolInputError(`Floorplan region "${regionId}" not found`);
      const poly = regionPolygon(region);
      const types = new Map(annotations.cellTypes.map((type) => [type.id, type]));
      for (const cell of annotations.cells) {
        const type = types.get(cell.cellTypeId);
        if (!type) continue;
        const rect = cellDieRect(cell, type.cropRect.width, type.cropRect.height);
        if (!pointInPoly(rect.x + rect.width / 2, rect.y + rect.height / 2, poly)) continue;
        for (const name of devicesByCell.get(cell.id) ?? []) selected.add(name);
      }
    }
    if (netIds.length > 0) {
      const byId = new Map(annotations.nets.map((net) => [net.id, net]));
      const wanted = new Set<string>();
      for (const id of netIds) {
        const net = byId.get(id);
        if (!net) throw new ToolInputError(`Annotation net "${id}" not found`);
        wanted.add(sanitizeNetName(net.name));
      }
      for (const device of devices) if (device.nets.some((net) => wanted.has(net))) selected.add(device.name);
    }
    if (selected.size === 0) throw new ToolInputError("The selection contains no extracted devices");
    const blockName = safeName(str(args, "name", true) ?? "agent_block", "agent_block");
    const block = buildBlockSubcircuit(devices, selected, blockName);
    const cards = selectedModels(devices, block.selectedNames)
      .map((model) => ({
        npn: ".MODEL npn NPN (BF=200 IS=1e-14 VAF=50)",
        pnp: ".MODEL pnp PNP (BF=100 IS=1e-14 VAF=50)",
        diode: ".MODEL diode D (IS=1e-14 N=1)"
      })[model])
      .filter((card): card is string => Boolean(card));
    const body = testbench.trim().replace(/\r?\n\s*\.end\s*$/i, "").trim();
    const instance = /^\s*X\S+\s/m.test(body) ? "" : ["X1", ...block.ports, blockName].filter(Boolean).join(" ");
    const deck = [
      `* mcp simulate_block: ${blockName}`,
      ...cards,
      block.subckt,
      instance,
      "* ── Testbench ──",
      body,
      ".end"
    ].filter(Boolean).join("\n");
    const execution = await executeSpiceSimTool({
      netlist: deck,
      models: Array.isArray(args.models) ? args.models.map(String) : undefined,
      binPath: str(args, "binPath", true)
    });
    const result = execution.result;
    const summary = result.success
      ? `${result.plot ?? "block"} — ${block.deviceCount} devices, ${block.ports.length} ports`
      : "block simulation failed";
    let published = false;
    if (result.success && args.publish !== false && ctx.baseUrl) {
      try {
        await internalJson(ctx, `/api/dies/${encodeURIComponent(ctx.dieId)}/spice-handoff`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            netlist: deck,
            directives: body,
            summary,
            plot: result.plot,
            measurements: result.measurements,
            at: Date.now()
          })
        });
        published = true;
      } catch {
        // The simulation still counts; the user can open the returned deck.
      }
    }
    const payload = {
      success: result.success,
      block: {
        name: blockName,
        deviceCount: block.deviceCount,
        ports: block.ports,
        internalNets: block.internalNets,
        selectedDevices: block.selectedNames,
        missingDevices: block.missingNames
      },
      subckt: block.subckt,
      deck,
      testbench: body,
      plot: result.plot,
      numPoints: result.numPoints,
      variables: result.variables,
      measurements: result.measurements,
      notes: result.notes,
      published
    };
    return result.success ? textResult(payload) : errorResult(JSON.stringify(payload));
  }
};

const runLvs: ToolDef = {
  name: "run_lvs",
  title: "Run LVS comparison",
  description: "Compare layout and schematic netlists with vyges-lvs (default) or the name-based engine.",
  inputSchema: {
    type: "object",
    properties: {
      layoutNetlist: { type: "string" },
      schematicNetlist: { type: "string" },
      dialect: { type: "string", enum: ["cdl", "spectre", "hspice"] },
      moduleName: { type: "string" },
      engine: { type: "string", enum: ["vyges-lvs", "name-based"] }
    },
    required: ["layoutNetlist", "schematicNetlist"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: true },
  run: async (_ctx, args) => {
    const layout = nonEmpty(str(args, "layoutNetlist"), "layoutNetlist");
    const schematic = nonEmpty(str(args, "schematicNetlist"), "schematicNetlist");
    const engine = str(args, "engine", true) ?? "vyges-lvs";
    if (engine === "name-based") return textResult(compareByName(layout, schematic));
    return textResult(await runVygesLvs(layout, schematic, str(args, "dialect", true), str(args, "moduleName", true)));
  }
};

// ─── Project export (reuses the backend's own route) ────────────────

const exportProject: ToolDef = {
  name: "export_project",
  title: "Export project ZIP",
  description:
    "Export the project as a portable ZIP. `mode light` = annotations/metadata/SPICE/analog names; " +
    "`mode full` also includes images. The ZIP is written to a local temp path and its path is returned.",
  inputSchema: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["light", "full"] },
      preferences: { type: "string" },
      deviceRegistry: { type: "string" },
      analogNames: { type: "string" }
    },
    additionalProperties: false
  },
  annotations: { readOnlyHint: true },
  run: async (ctx, args) => {
    const mode = str(args, "mode", true) === "full" ? "full" : "light";
    const response = await internalFetch(ctx, `/api/dies/${encodeURIComponent(ctx.dieId)}/export-project`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode,
        ...(str(args, "preferences", true) ? { preferences: str(args, "preferences", true) } : {}),
        ...(str(args, "deviceRegistry", true) ? { deviceRegistry: str(args, "deviceRegistry", true) } : {}),
        ...(str(args, "analogNames", true) ? { analogNames: str(args, "analogNames", true) } : {})
      })
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    const filename = response.headers.get("x-filename") ?? `mmochip-${ctx.dieId}-${mode}.zip`;
    const dir = path.join(os.tmpdir(), "mmo-chip-mcp-exports");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, path.basename(filename));
    await fs.writeFile(file, bytes);
    return textResult({ path: file, bytes: bytes.length, filename, mode });
  }
};

// ─── ML / cell detection (reuses the backend's own routes) ──────────

const mlJob: ToolDef = {
  name: "ml_job",
  title: "ML inference job",
  description: "Control the ML via-detection sweep for this die: status, start, stop.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["status", "start", "stop"] },
      overlayFilename: { type: "string" }
    },
    required: ["action"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: false },
  run: async (ctx, args) => {
    const action = str(args, "action");
    const base = `/api/dies/${encodeURIComponent(ctx.dieId)}/ml/job`;
    if (action === "status") return textResult(await internalJson(ctx, base));
    return textResult(await internalJson(ctx, `${base}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(str(args, "overlayFilename", true) ? { overlayFilename: str(args, "overlayFilename", true) } : {})
    }));
  }
};

const cellDetection: ToolDef = {
  name: "cell_detection",
  title: "Cell detection job",
  description: "Control the ML cell-placement proposals for a cell type: status, start, stop, list.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["status", "start", "stop", "list"] },
      cellTypeId: { type: "string" },
      allowFlipX: { type: "boolean" },
      allowFlipY: { type: "boolean" },
      avoidExistingCells: { type: "boolean" },
      allDies: { type: "boolean" }
    },
    required: ["action"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: false },
  run: async (ctx, args) => {
    const action = str(args, "action");
    const base = `/api/dies/${encodeURIComponent(ctx.dieId)}/cell-detections`;
    if (action === "status") return textResult(await internalJson(ctx, `${base}/job`));
    if (action === "list") return textResult(await internalJson(ctx, base));
    if (action === "stop") return textResult(await internalJson(ctx, `${base}/job/stop`, { method: "POST", body: "{}" }));
    const cellTypeId = nonEmpty(str(args, "cellTypeId"), "cellTypeId");
    const body = {
      cellTypeId,
      ...(args.allowFlipX === undefined ? {} : { allowFlipX: args.allowFlipX }),
      ...(args.allowFlipY === undefined ? {} : { allowFlipY: args.allowFlipY }),
      ...(args.avoidExistingCells === undefined ? {} : { avoidExistingCells: args.avoidExistingCells }),
      ...(args.allDies === undefined ? {} : { allDies: args.allDies })
    };
    return textResult(await internalJson(ctx, `${base}/job/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }));
  }
};

// ─── Dedicated cell / pin edits (full-edit gate) ────────────────────

function rotation(value: number | undefined): number {
  const r = value ?? 0;
  if (![0, 90, 180, 270].includes(r)) throw new ToolInputError("rotation must be 0, 90, 180 or 270");
  return r;
}

const editCells: ToolDef = {
  name: "edit_cells",
  title: "Edit cells",
  description:
    "Place, move, re-orient or delete cell instances. Requires full edits. Upsert merges into an " +
    "existing cell; a new cell needs cellTypeId, x and y. A cell type owned by another die needs cellTypeDieId.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["upsert", "delete"] },
      cellId: { type: "string" },
      cellTypeId: { type: "string" },
      cellTypeDieId: { type: "string" },
      x: { type: "number" },
      y: { type: "number" },
      rotation: { type: "number" },
      flippedH: { type: "boolean" },
      flippedV: { type: "boolean" },
      scale: { type: "number" },
      bounds: {
        type: "object",
        properties: { x: point, y: point, width: { type: "number" }, height: { type: "number" } }
      }
    },
    required: ["action"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
  run: async (ctx, args) => {
    const action = str(args, "action");
    return write(ctx, "full", (annotations) => {
      if (action === "delete") {
        const cellId = nonEmpty(str(args, "cellId"), "cellId");
        const cell = annotations.cells.find((item) => item.id === cellId);
        if (!cell) throw new ToolInputError(`No cell with id ${cellId}`);
        return {
          tool: "edit_cells",
          summary: `Delete cell ${cellId}`,
          items: [{ collection: "cells", id: cellId, after: null }]
        };
      }
      const cellId = str(args, "cellId", true) ?? `mcp-cell-${Date.now().toString(36)}`;
      const existing = annotations.cells.find((item) => item.id === cellId);
      const patch = Object.fromEntries(Object.entries({
        cellTypeId: str(args, "cellTypeId", true),
        cellTypeDieId: str(args, "cellTypeDieId", true),
        x: num(args, "x", true),
        y: num(args, "y", true),
        rotation: args.rotation === undefined ? undefined : rotation(num(args, "rotation")),
        flippedH: args.flippedH,
        flippedV: args.flippedV,
        scale: args.scale,
        bounds: args.bounds
      }).filter(([, value]) => value !== undefined));
      const cell = { ...(existing ?? {}), ...patch, id: cellId } as Cell;
      if (!existing && (!cell.cellTypeId || cell.x === undefined || cell.y === undefined)) {
        throw new ToolInputError("creating a cell requires cellTypeId, x and y");
      }
      return {
        tool: "edit_cells",
        summary: `${existing ? "Update" : "Create"} cell ${cellId}`,
        items: [{ collection: "cells", id: cellId, after: cell }]
      };
    });
  }
};

const editPins: ToolDef = {
  name: "edit_pins",
  title: "Edit I/O pins",
  description: "Add, move and delete I/O pads. Requires full edits. A new pin needs x, y, pin and name.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["upsert", "delete"] },
      pinId: { type: "string" },
      x: { type: "number" },
      y: { type: "number" },
      pin: { type: "integer" },
      name: { type: "string" }
    },
    required: ["action"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
  run: async (ctx, args) => {
    const action = str(args, "action");
    return write(ctx, "full", (annotations) => {
      if (action === "delete") {
        const pinId = nonEmpty(str(args, "pinId"), "pinId");
        return {
          tool: "edit_pins",
          summary: `Delete pin ${pinId}`,
          items: [{ collection: "pins", id: pinId, after: null }]
        };
      }
      const pinId = str(args, "pinId", true) ?? `mcp-pin-${Date.now().toString(36)}`;
      const existing = (annotations.pins ?? []).find((item) => item.id === pinId);
      const patch = Object.fromEntries(Object.entries({
        x: num(args, "x", true),
        y: num(args, "y", true),
        pin: num(args, "pin", true),
        name: str(args, "name", true)
      }).filter(([, value]) => value !== undefined));
      const pin = { ...(existing ?? {}), ...patch, id: pinId } as IOPin;
      if (!existing && (pin.x === undefined || pin.y === undefined || pin.pin === undefined || pin.name === undefined)) {
        throw new ToolInputError("creating a pin requires x, y, pin and name");
      }
      return {
        tool: "edit_pins",
        summary: `${existing ? "Update" : "Create"} pin ${pinId}`,
        items: [{ collection: "pins", id: pinId, after: pin }]
      };
    });
  }
};

export const EXTENDED_TOOLS: ToolDef[] = [
  listOverlayLayers,
  getRegionSummary,
  getSpiceConfig,
  getAnalogDevices,
  exportNetlist,
  runNgspice,
  simulateBlock,
  runLvs,
  exportProject,
  mlJob,
  cellDetection,
  editCells,
  editPins
];
