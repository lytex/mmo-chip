/**
 * MCP tools for the RE-cell workflow (the app's "RE cell" page): inspect one
 * cell type — its drawn layers, the photo it was drawn over, the structure the
 * extractor recovers from it — and edit the layers / labels the way a human
 * does there. Same endpoint, per-die approval, write gates and MCP undo stack
 * as the die-viewer tools.
 *
 *   list_cell_types      read   every cell type: size, layer counts, instances
 *   get_cell_type        read   one type's full layer geometry (+ filters)
 *   get_cell_image       read   the type's photo crop, optionally with its layers drawn
 *   get_cell_extraction  read   transistors / nets / ports / logic / analog devices
 *   edit_cell_layers     full   add / replace / delete / label layer shapes
 *   edit_cell_type       full   create, rename, mark matched, colour, forced sources
 *
 * Shape coordinates are cell-local: origin at the top-left of the type's
 * `cropRect`, in die-image pixels (the cell page's drawing space).
 */

import sharp from "sharp";
import type {
  AnnotationRect,
  Cell,
  CellType,
  DieAnnotations,
  ForcedDiffusionType,
  LayerShape,
  LayerType,
  ShapeLabel
} from "shared";
import { renderDieCrop } from "../api/tiles.js";
import { extractCellType } from "../cellExtraction.js";
import { resolveProjectDir } from "../projectLayout.js";
import { readAnnotations, readDieRecord } from "../store.js";
import {
  nonEmpty,
  num,
  str,
  textResult,
  ToolInputError,
  write,
  type ToolDef
} from "./mcpToolKit.js";

const LAYER_TYPES: LayerType[] = [
  "diffusion", "polysilicon", "metal1", "metal2", "metal3", "metal4", "metal5", "metal6",
  "contact", "via1", "via2", "via3", "via4", "via5", "wire_hitbox",
  "nwell", "pwell", "deep_nwell", "buried_layer", "base", "emitter", "collector_sinker",
  "jfet_gate", "jfet_channel", "resistor_body", "capacitor_bottom", "capacitor_top",
  "device_box", "hsr", "film", "npn_id", "pnp_id", "lpnp_id", "vpnp", "res_id", "cap_id",
  "diode_id", "collector", "bulk"
];
const SHAPE_LABELS: ShapeLabel[] = ["vcc", "gnd", "io", "input", "output"];

const LAYER_COLORS: Partial<Record<LayerType, string>> = {
  diffusion: "#22c55e", polysilicon: "#ef4444", metal1: "#3b82f6", metal2: "#a855f7",
  metal3: "#f59e0b", metal4: "#14b8a6", contact: "#ffffff", via1: "#fde047", via2: "#fb923c",
  wire_hitbox: "#ec4899", nwell: "#38bdf8", pwell: "#f472b6"
};
const colorOf = (layer: string) => LAYER_COLORS[layer as LayerType] ?? "#e5e7eb";

const layerSchema = { type: "string", enum: LAYER_TYPES, description: "Layer key of the cell's drawing" };
const cellTypeIdProp = { type: "string", description: "Cell type id (see list_cell_types)" };

// ─── Helpers ────────────────────────────────────────────────────────

function typeOf(annotations: DieAnnotations, id: string): CellType {
  const type = (annotations.cellTypes ?? []).find((t) => t.id === id);
  if (!type) {
    throw new ToolInputError(
      `No cell type ${id} on this die (list_cell_types shows them; types owned by another die of the cell library are edited there).`
    );
  }
  return type;
}

function shapeBox(s: LayerShape): AnnotationRect {
  switch (s.kind) {
    case "rect":
      return { x: s.x, y: s.y, width: s.width, height: s.height };
    case "line": {
      const x = Math.min(s.x1, s.x2) - s.width / 2;
      const y = Math.min(s.y1, s.y2) - s.width / 2;
      return { x, y, width: Math.abs(s.x2 - s.x1) + s.width, height: Math.abs(s.y2 - s.y1) + s.width };
    }
    case "point":
      return { x: s.x - s.size / 2, y: s.y - s.size / 2, width: s.size, height: s.size };
    case "circle":
      return { x: s.x - s.radius, y: s.y - s.radius, width: s.radius * 2, height: s.radius * 2 };
    case "polygon": {
      const xs = s.points.map((p) => p.x);
      const ys = s.points.map((p) => p.y);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
    }
  }
}

function overlaps(a: AnnotationRect, b: AnnotationRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function rectArg(args: Record<string, unknown>, key: string): AnnotationRect | undefined {
  const raw = args[key] as Record<string, unknown> | undefined;
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object") throw new ToolInputError(`"${key}" must be {x, y, width, height}`);
  return { x: num(raw, "x"), y: num(raw, "y"), width: num(raw, "width"), height: num(raw, "height") };
}

function layerArg(args: Record<string, unknown>, key = "layer"): LayerType {
  const layer = str(args, key);
  if (!(LAYER_TYPES as string[]).includes(layer)) {
    throw new ToolInputError(`"${key}" must be one of ${LAYER_TYPES.join(", ")}`);
  }
  return layer as LayerType;
}

/** Validate a shape object received from the client; returns a clean copy. */
function parseShape(raw: unknown, where: string): LayerShape {
  const o = raw as Record<string, unknown>;
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new ToolInputError(`${where}: shape must be an object`);
  const id = str(o, "id", true) ?? `mcp-shape-${Math.random().toString(36).slice(2, 10)}`;
  const common: Record<string, unknown> = { id };
  if (o.label !== undefined) common.label = parseLabel(o.label, where);
  if (o.forcedType !== undefined) common.forcedType = parseForced(o.forcedType, where);
  if (o.customName !== undefined) common.customName = String(o.customName);
  const kind = o.kind;
  try {
    switch (kind) {
      case "rect":
        return { ...common, kind, x: num(o, "x"), y: num(o, "y"), width: num(o, "width"), height: num(o, "height") } as LayerShape;
      case "line":
        return {
          ...common, kind, x1: num(o, "x1"), y1: num(o, "y1"), x2: num(o, "x2"), y2: num(o, "y2"), width: num(o, "width")
        } as LayerShape;
      case "point":
        return { ...common, kind, x: num(o, "x"), y: num(o, "y"), size: num(o, "size") } as LayerShape;
      case "circle":
        return { ...common, kind, x: num(o, "x"), y: num(o, "y"), radius: num(o, "radius") } as LayerShape;
      case "polygon": {
        const pts = o.points;
        if (!Array.isArray(pts) || pts.length < 3) throw new ToolInputError(`"points" needs at least 3 {x, y}`);
        return {
          ...common,
          kind,
          points: pts.map((p) => ({ x: num(p as Record<string, unknown>, "x"), y: num(p as Record<string, unknown>, "y") }))
        } as LayerShape;
      }
      default:
        throw new ToolInputError(`"kind" must be rect, line, point, circle or polygon`);
    }
  } catch (error) {
    if (error instanceof ToolInputError) throw new ToolInputError(`${where}: ${error.message}`);
    throw error;
  }
}

function parseLabel(v: unknown, where: string): ShapeLabel {
  if (!(SHAPE_LABELS as unknown[]).includes(v)) throw new ToolInputError(`${where}: label must be ${SHAPE_LABELS.join(", ")}`);
  return v as ShapeLabel;
}

function parseForced(v: unknown, where: string): ForcedDiffusionType {
  if (v !== "p" && v !== "n") throw new ToolInputError(`${where}: forcedType must be "p" or "n"`);
  return v;
}

function cloneType(type: CellType): CellType {
  return JSON.parse(JSON.stringify(type)) as CellType;
}

function shapeCounts(type: CellType): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [layer, shapes] of Object.entries(type.layers ?? {})) {
    if (shapes && shapes.length > 0) out[layer] = shapes.length;
  }
  return out;
}

// ─── Read tools ─────────────────────────────────────────────────────

const listCellTypes: ToolDef = {
  name: "list_cell_types",
  title: "List cell types",
  description:
    "Cell types of this die as the RE cell page shows them: id, name, matched (human-confirmed) or an " +
    "unmatched placeholder, crop size, drawn shape counts per layer, number of placed instances, pcell spec. " +
    "Use the ids with get_cell_type, get_cell_image, get_cell_extraction and the edit tools.",
  inputSchema: {
    type: "object",
    properties: {
      matched: { type: "boolean", description: "Only matched (true) or only unmatched (false) types" },
      nameContains: { type: "string", description: "Case-insensitive name filter" }
    },
    additionalProperties: false
  },
  annotations: { readOnlyHint: true },
  run: async (ctx, args) => {
    const annotations = await readAnnotations(ctx.dataRoot, ctx.dieId);
    const matched = typeof args.matched === "boolean" ? args.matched : undefined;
    const needle = str(args, "nameContains", true)?.toLowerCase();
    const instances = new Map<string, number>();
    for (const cell of annotations.cells ?? []) instances.set(cell.cellTypeId, (instances.get(cell.cellTypeId) ?? 0) + 1);
    const types = (annotations.cellTypes ?? [])
      .filter((t) => matched === undefined || Boolean(t.matched) === matched)
      .filter((t) => !needle || t.name.toLowerCase().includes(needle))
      .map((t) => ({
        id: t.id,
        name: t.name,
        matched: Boolean(t.matched),
        width: t.cropRect.width,
        height: t.cropRect.height,
        cropRect: t.cropRect,
        shapes: shapeCounts(t),
        instances: instances.get(t.id) ?? 0,
        pcell: t.pcell?.template ?? null,
        forcedSourceContacts: t.forcedSourceContacts?.length ?? 0
      }));
    return textResult({ count: types.length, cellTypes: types });
  }
};

const getCellType: ToolDef = {
  name: "get_cell_type",
  title: "Get cell type",
  description:
    "One cell type with its drawn layer geometry (cell-local pixels, origin = top-left of cropRect). " +
    "Filter with `layers` (layer keys) and/or `region` (cell-local box) to keep answers small; " +
    "`summaryOnly` returns only counts and bounding boxes per layer. Also lists the placed instances.",
  inputSchema: {
    type: "object",
    properties: {
      cellTypeId: cellTypeIdProp,
      layers: { type: "array", items: layerSchema },
      region: {
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } },
        description: "Cell-local box; only shapes touching it are returned"
      },
      summaryOnly: { type: "boolean" }
    },
    required: ["cellTypeId"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: true },
  run: async (ctx, args) => {
    const annotations = await readAnnotations(ctx.dataRoot, ctx.dieId);
    const type = typeOf(annotations, nonEmpty(str(args, "cellTypeId"), "cellTypeId"));
    const wanted = Array.isArray(args.layers) ? args.layers.map(String) : null;
    const region = rectArg(args, "region");
    const layers: Record<string, unknown> = {};
    for (const [layer, shapes] of Object.entries(type.layers ?? {})) {
      if (!shapes || (wanted && !wanted.includes(layer))) continue;
      const hit = region ? shapes.filter((s) => overlaps(shapeBox(s), region)) : shapes;
      if (hit.length === 0) continue;
      if (args.summaryOnly === true) {
        const boxes = hit.map(shapeBox);
        const x0 = Math.min(...boxes.map((b) => b.x));
        const y0 = Math.min(...boxes.map((b) => b.y));
        const x1 = Math.max(...boxes.map((b) => b.x + b.width));
        const y1 = Math.max(...boxes.map((b) => b.y + b.height));
        layers[layer] = { count: hit.length, bounds: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } };
      } else {
        layers[layer] = hit;
      }
    }
    const instances = (annotations.cells ?? [])
      .filter((c: Cell) => c.cellTypeId === type.id)
      .map((c) => ({ id: c.id, x: c.x, y: c.y, rotation: c.rotation ?? 0, flippedH: Boolean(c.flippedH), flippedV: Boolean(c.flippedV) }));
    return textResult({
      id: type.id,
      name: type.name,
      matched: Boolean(type.matched),
      cropRect: type.cropRect,
      color: type.color ?? null,
      forcedSourceContacts: type.forcedSourceContacts ?? [],
      pcell: type.pcell ?? null,
      layers,
      instances
    });
  }
};

const getCellImage: ToolDef = {
  name: "get_cell_image",
  title: "Get cell image",
  description:
    "The die photo under a cell type (its cropRect), as a JPEG, optionally with the type's drawn layers on top " +
    "(colour per layer, shape ids as small tags when `labelShapes`). The text part gives the cell-local ↔ output pixel " +
    "mapping, so shapes read off the picture can be passed straight to edit_cell_layers.",
  inputSchema: {
    type: "object",
    properties: {
      cellTypeId: cellTypeIdProp,
      layers: {
        type: "array",
        items: layerSchema,
        description: "Layers to draw over the photo (default: none — a plain crop). Pass [] for none, or list keys."
      },
      drawAllLayers: { type: "boolean", description: "Draw every layer that has shapes" },
      labelShapes: { type: "boolean", description: "Tag each drawn shape with its id" },
      maxSize: { type: "integer", minimum: 64, maximum: 2048, description: "Long side in px (default 1024)" }
    },
    required: ["cellTypeId"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: true },
  run: async (ctx, args) => {
    const record = await readDieRecord(ctx.dataRoot, ctx.dieId);
    const annotations = await readAnnotations(ctx.dataRoot, ctx.dieId);
    const type = typeOf(annotations, nonEmpty(str(args, "cellTypeId"), "cellTypeId"));
    const maxSize = Math.min(2048, Math.max(64, Math.round(num(args, "maxSize", true) ?? 1024)));
    const left = Math.max(0, Math.floor(type.cropRect.x));
    const top = Math.max(0, Math.floor(type.cropRect.y));
    const width = Math.max(1, Math.min(Math.ceil(type.cropRect.width), record.width - left));
    const height = Math.max(1, Math.min(Math.ceil(type.cropRect.height), record.height - top));
    const crop = await renderDieCrop({
      dataRoot: ctx.dataRoot,
      dieId: ctx.dieId,
      record,
      key: `mcp-type-${type.id}`,
      rect: { left, top, width, height },
      minPx: maxSize
    });
    const ratio = Math.min(maxSize / Math.max(width, height), 4);
    const outW = Math.max(1, Math.round(width * ratio));
    const outH = Math.max(1, Math.round(height * ratio));
    let image = sharp(crop.path).resize({ width: outW, height: outH, fit: "fill" });

    const drawn = args.drawAllLayers === true
      ? Object.keys(type.layers ?? {})
      : Array.isArray(args.layers) ? args.layers.map(String) : [];
    if (drawn.length > 0) {
      const tag = args.labelShapes === true;
      const parts: string[] = [];
      for (const layer of drawn) {
        const color = colorOf(layer);
        for (const s of (type.layers as Record<string, LayerShape[]> | undefined)?.[layer] ?? []) {
          const style = `fill="${color}" fill-opacity="0.25" stroke="${color}" stroke-width="${Math.max(1, 1 / ratio)}"`;
          if (s.kind === "rect") parts.push(`<rect x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" ${style}/>`);
          else if (s.kind === "line")
            parts.push(`<line x1="${s.x1}" y1="${s.y1}" x2="${s.x2}" y2="${s.y2}" stroke="${color}" stroke-opacity="0.6" stroke-width="${s.width}" stroke-linecap="butt"/>`);
          else if (s.kind === "point") parts.push(`<rect x="${s.x - s.size / 2}" y="${s.y - s.size / 2}" width="${s.size}" height="${s.size}" ${style}/>`);
          else if (s.kind === "circle") parts.push(`<circle cx="${s.x}" cy="${s.y}" r="${s.radius}" ${style}/>`);
          else parts.push(`<polygon points="${s.points.map((p) => `${p.x},${p.y}`).join(" ")}" ${style}/>`);
          if (tag) {
            const b = shapeBox(s);
            parts.push(
              `<text x="${b.x + 1}" y="${b.y + 10 / ratio}" font-size="${10 / ratio}" font-family="sans-serif" fill="#fff" stroke="#000" stroke-width="${0.5 / ratio}" paint-order="stroke">${escapeXml(s.id.slice(-6))}</text>`
            );
          }
        }
      }
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}" viewBox="0 0 ${width} ${height}">${parts.join("")}</svg>`;
      image = sharp(await image.png().toBuffer()).composite([{ input: Buffer.from(svg) }]);
    }
    const jpeg = await image.jpeg({ quality: 88 }).toBuffer();
    return {
      content: [
        { type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" },
        {
          type: "text",
          text: JSON.stringify({
            cellTypeId: type.id,
            name: type.name,
            cropRect: { x: left, y: top, width, height },
            output: { width: outW, height: outH },
            mapping: `cell_x = out_x / ${ratio.toFixed(4)}, cell_y = out_y / ${ratio.toFixed(4)} (die_x = ${left} + cell_x, die_y = ${top} + cell_y)`,
            drawnLayers: drawn
          })
        }
      ]
    };
  }
};

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c] as string);
}

const getCellExtraction: ToolDef = {
  name: "get_cell_extraction",
  title: "Get cell extraction",
  description:
    "Run the RE cell page's structural extractor on one cell type and report what it recovers: diffusion types, " +
    "MOS transistors (gate/source/drain net ids, role), nets with roles (vcc/gnd/input/output/…), ports from " +
    "wire_hitbox shapes, CMOS domains and transmission gates with boolean logic / recognised gate, analog devices, " +
    "and the extractor's warnings. Net ids refer to `nets[].id`; `nets[].shapeIds` lists the member shapes.",
  inputSchema: {
    type: "object",
    properties: {
      cellTypeId: cellTypeIdProp,
      includeNetShapes: { type: "boolean", description: "Keep per-net shapeIds (default false: only counts)" }
    },
    required: ["cellTypeId"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: true },
  run: async (ctx, args) => {
    const cellTypeId = nonEmpty(str(args, "cellTypeId"), "cellTypeId");
    typeOf(await readAnnotations(ctx.dataRoot, ctx.dieId), cellTypeId);
    const { dir } = await resolveProjectDir(ctx.dataRoot, ctx.dieId);
    const result = await extractCellType({ projectDir: dir, cellTypeId });
    if (!result.ok) throw new ToolInputError(result.error ?? "cell extraction failed");
    if (args.includeNetShapes !== true && Array.isArray(result.nets)) {
      result.nets = (result.nets as Record<string, unknown>[]).map(({ shapeIds: _s, ...rest }) => rest);
    }
    return textResult(result);
  }
};

// ─── Write tools (full edits) ───────────────────────────────────────

const editCellLayers: ToolDef = {
  name: "edit_cell_layers",
  title: "Edit cell layers",
  description:
    "Batch-edit the drawn shapes of one cell type, as on the RE cell page; applied in order and recorded as ONE MCP " +
    "undo step. Operations: `upsert` {layer, shape} adds or replaces a shape (rect {x,y,width,height}, line " +
    "{x1,y1,x2,y2,width}, point {x,y,size}, circle {x,y,radius}, polygon {points}; optional id, label " +
    "vcc|gnd|io|input|output, forcedType p|n on diffusion, customName); `delete` {layer, shapeId}; `patch` {layer, " +
    "shapeId, label?, forcedType?, customName?} sets or (null) clears those tags; `move` {layer, shapeId, layer2?} " +
    "moves a shape to another layer (e.g. nwell ↔ pwell). Coordinates are cell-local (see get_cell_type). " +
    "Requires \"Full edits\".",
  inputSchema: {
    type: "object",
    properties: {
      cellTypeId: cellTypeIdProp,
      operations: {
        type: "array",
        minItems: 1,
        maxItems: 500,
        items: {
          type: "object",
          properties: {
            op: { type: "string", enum: ["upsert", "delete", "patch", "move"] },
            layer: layerSchema,
            layer2: { ...layerSchema, description: "Target layer for move" },
            shapeId: { type: "string" },
            shape: { type: "object", description: "Shape for upsert" },
            label: { type: ["string", "null"], enum: [...SHAPE_LABELS, null] },
            forcedType: { type: ["string", "null"], enum: ["p", "n", null] },
            customName: { type: ["string", "null"] }
          },
          required: ["op", "layer"]
        }
      }
    },
    required: ["cellTypeId", "operations"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
  run: async (ctx, args) => {
    const cellTypeId = nonEmpty(str(args, "cellTypeId"), "cellTypeId");
    const ops = args.operations;
    if (!Array.isArray(ops) || ops.length === 0) throw new ToolInputError(`"operations" must be a non-empty array`);
    return write(ctx, "full", (annotations) => {
      const next = cloneType(typeOf(annotations, cellTypeId));
      const layers = (next.layers ??= {}) as Record<string, LayerShape[]>;
      const counts = { upserted: 0, deleted: 0, patched: 0, moved: 0 };
      ops.forEach((raw, i) => {
        const where = `operations[${i}]`;
        const o = raw as Record<string, unknown>;
        if (!o || typeof o !== "object") throw new ToolInputError(`${where} must be an object`);
        const layer = layerArg(o);
        const list = (layers[layer] ??= []);
        const findIndex = (id: string) => list.findIndex((s) => s.id === id);
        switch (o.op) {
          case "upsert": {
            const shape = parseShape(o.shape, where);
            const at = findIndex(shape.id);
            if (at === -1) list.push(shape);
            else list[at] = shape;
            counts.upserted++;
            break;
          }
          case "delete": {
            const id = nonEmpty(str(o, "shapeId"), "shapeId");
            const at = findIndex(id);
            if (at === -1) throw new ToolInputError(`${where}: no shape ${id} on layer ${layer}`);
            list.splice(at, 1);
            counts.deleted++;
            break;
          }
          case "patch": {
            const id = nonEmpty(str(o, "shapeId"), "shapeId");
            const at = findIndex(id);
            if (at === -1) throw new ToolInputError(`${where}: no shape ${id} on layer ${layer}`);
            const shape = { ...list[at] } as Record<string, unknown>;
            for (const key of ["label", "forcedType", "customName"] as const) {
              if (o[key] === undefined) continue;
              if (o[key] === null) delete shape[key];
              else shape[key] = key === "label" ? parseLabel(o[key], where) : key === "forcedType" ? parseForced(o[key], where) : String(o[key]);
            }
            list[at] = shape as unknown as LayerShape;
            counts.patched++;
            break;
          }
          case "move": {
            const id = nonEmpty(str(o, "shapeId"), "shapeId");
            const target = layerArg(o, "layer2");
            const at = findIndex(id);
            if (at === -1) throw new ToolInputError(`${where}: no shape ${id} on layer ${layer}`);
            const [shape] = list.splice(at, 1);
            (layers[target] ??= []).push(shape);
            counts.moved++;
            break;
          }
          default:
            throw new ToolInputError(`${where}: "op" must be upsert, delete, patch or move`);
        }
      });
      for (const key of Object.keys(layers)) if (layers[key].length === 0) delete layers[key];
      return {
        tool: "edit_cell_layers",
        summary: `Edit layers of cell type ${next.name} (${ops.length} ops)`,
        items: [{ collection: "cellTypes", id: next.id, after: next }],
        result: { cellTypeId: next.id, ...counts, shapes: shapeCounts(next) }
      };
    });
  }
};

const editCellType: ToolDef = {
  name: "edit_cell_type",
  title: "Edit cell type",
  description:
    "Create or modify a cell type's metadata. `create` needs name and cropRect {x,y,width,height} (die pixels; the " +
    "photo region the layers are drawn over). `update` may set name, matched (the RE cell page's \"matched\" " +
    "confirmation), color (#rrggbb or null) and forcedSourceContacts (contact shape ids forced to be SOURCE). " +
    "`delete` removes the type (placed instances of it are left alone — check list_cell_types first). " +
    "Requires \"Full edits\".",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["create", "update", "delete"] },
      cellTypeId: cellTypeIdProp,
      name: { type: "string" },
      cropRect: {
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } }
      },
      matched: { type: "boolean" },
      color: { type: ["string", "null"] },
      forcedSourceContacts: { type: "array", items: { type: "string" } }
    },
    required: ["action"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
  run: async (ctx, args) => {
    const action = str(args, "action");
    return write(ctx, "full", (annotations) => {
      if (action === "delete") {
        const type = typeOf(annotations, nonEmpty(str(args, "cellTypeId"), "cellTypeId"));
        const used = (annotations.cells ?? []).filter((c) => c.cellTypeId === type.id).length;
        return {
          tool: "edit_cell_type",
          summary: `Delete cell type ${type.name}`,
          items: [{ collection: "cellTypes", id: type.id, after: null }],
          result: { deleted: type.id, orphanedInstances: used }
        };
      }
      if (action !== "create" && action !== "update") throw new ToolInputError(`"action" must be create, update or delete`);
      const color = args.color;
      if (typeof color === "string" && !/^#[0-9a-fA-F]{6}$/.test(color)) {
        throw new ToolInputError(`"color" must be #rrggbb or null`);
      }
      if (action === "create") {
        const crop = rectArg(args, "cropRect");
        const name = nonEmpty(str(args, "name"), "name");
        if (!crop || crop.width <= 0 || crop.height <= 0) throw new ToolInputError(`create needs a cropRect with positive width and height`);
        const id = str(args, "cellTypeId", true) ?? `mcp-celltype-${Date.now().toString(36)}`;
        if ((annotations.cellTypes ?? []).some((t) => t.id === id)) throw new ToolInputError(`Cell type ${id} already exists`);
        const type: CellType = { id, name, cropRect: crop, layers: {} };
        if (typeof args.matched === "boolean") type.matched = args.matched;
        if (typeof color === "string") type.color = color;
        return {
          tool: "edit_cell_type",
          summary: `Create cell type ${name}`,
          items: [{ collection: "cellTypes", id, after: type }],
          result: { cellTypeId: id }
        };
      }
      const existing = typeOf(annotations, nonEmpty(str(args, "cellTypeId"), "cellTypeId"));
      const next = cloneType(existing);
      if (args.name !== undefined) next.name = nonEmpty(str(args, "name"), "name");
      if (typeof args.matched === "boolean") next.matched = args.matched;
      if (color === null) delete next.color;
      else if (typeof color === "string") next.color = color;
      if (Array.isArray(args.forcedSourceContacts)) {
        next.forcedSourceContacts = args.forcedSourceContacts.map(String);
        if (next.forcedSourceContacts.length === 0) delete next.forcedSourceContacts;
      }
      return {
        tool: "edit_cell_type",
        summary: `Update cell type ${next.name}`,
        items: [{ collection: "cellTypes", id: next.id, after: next }],
        result: { cellTypeId: next.id }
      };
    });
  }
};

export const CELL_TOOLS: ToolDef[] = [
  listCellTypes,
  getCellType,
  getCellImage,
  getCellExtraction,
  editCellLayers,
  editCellType
];
