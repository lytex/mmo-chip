import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { isProcessLayer, PROCESS_LAYERS, SUBSTRATE_NAMES, type ProcessTag } from "shared";
import type {
  CommentAnnotation,
  CommentImage,
  CommentReply,
  DieAnnotations,
  FloorplanRegion,
  RulerMeasurement
} from "shared";
import { listManifests } from "../api/overlayImages.js";
import { renderDieCrop } from "../api/tiles.js";
import { readAnnotations, readDieRecord } from "../store.js";
import { parseRenderSpec, renderAnnotated, renderSpecSchemaProperties } from "./annotatedRender.js";
import { saveCommentImage } from "./commentImages.js";
import { FULL_EDIT_TOOLS } from "./mcpFullEdit.js";
import { EXTENDED_TOOLS } from "./mcpExtended.js";
import {
  findItem,
  MCP_AUTHOR_ID,
  McpEditError,
  readMcpState
} from "./mcpState.js";
import {
  assertOnDie,
  authorName,
  clip,
  errorResult,
  isMine,
  nonEmpty,
  num,
  point,
  requireGate,
  requireOwned,
  str,
  textResult,
  ToolInputError,
  write,
  type McpToolContext,
  type McpToolResult,
  type ToolDef
} from "./mcpToolKit.js";
import { layerStackOf, WIRE_TOOLS } from "./mcpWires.js";

export type { McpToolContext, McpToolResult } from "./mcpToolKit.js";

/**
 * MCP tools for one die. Reads cover the whole die (image + every annotation
 * section). Writes are markup — comments (+ replies), floorplan regions and
 * rulers, gated by the die's MCP write mode (see McpWriteMode) — and wires +
 * vias (mcpWires.ts), gated by the separate wire toggle.
 */

// ─── Markup argument helpers ────────────────────────────────────────

function points(value: unknown, kind: FloorplanRegion["kind"]): { x: number; y: number }[] {
  if (!Array.isArray(value)) throw new ToolInputError(`"points" must be an array of {x, y}`);
  const pts = value.map((p) => {
    const x = (p as { x?: unknown })?.x;
    const y = (p as { y?: unknown })?.y;
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
      throw new ToolInputError(`"points" must be an array of {x, y} numbers`);
    }
    return { x: Math.round(x), y: Math.round(y) };
  });
  if (kind === "rect") {
    if (pts.length !== 2) throw new ToolInputError(`A rect region takes exactly 2 opposite corners`);
    const [a, b] = pts;
    return [
      { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) },
      { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) }
    ];
  }
  if (pts.length < 3) throw new ToolInputError(`A polygon region needs at least 3 points`);
  return pts;
}

function processTag(value: string | undefined): ProcessTag | undefined {
  if (value === undefined) return undefined;
  if (value !== "psub" && value !== "nsub" && !isProcessLayer(value)) {
    throw new ToolInputError(`"layerTag" must be psub, nsub or one of: ${Object.keys(PROCESS_LAYERS).join(", ")}`);
  }
  return value as ProcessTag;
}

function regionKind(value: unknown): FloorplanRegion["kind"] {
  if (value !== "rect" && value !== "polygon") throw new ToolInputError(`"kind" must be "rect" or "polygon"`);
  return value;
}

function color(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) throw new ToolInputError(`"color" must be a #rrggbb hex color`);
  return value.toLowerCase();
}

// ─── Read tools ─────────────────────────────────────────────────────

const ANNOTATION_SECTIONS = [
  "nets",
  "cellTypes",
  "cells",
  "grids",
  "pins",
  "mlConfig",
  "annotations",
  "rois",
  "ignores",
  "guides",
  "analogLayers",
  "umPerPx",
  "rulers",
  "comments",
  "floorplanRegions",
  "icPackage"
] as const;

type Rect = { x: number; y: number; width: number; height: number };

/**
 * Whether anything in `value` lies in `bbox`: any nested {x, y} point,
 * {x, y, width, height} box or {x1, y1, x2, y2} segment. Approximate by
 * design — e.g. a cell is tested by its origin and box, a net by its nodes.
 */
function touchesBox(value: unknown, bbox: Rect): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((v) => touchesBox(v, bbox));
  const o = value as Record<string, unknown>;
  const inside = (x: number, y: number) =>
    x >= bbox.x && y >= bbox.y && x <= bbox.x + bbox.width && y <= bbox.y + bbox.height;
  if (typeof o.x === "number" && typeof o.y === "number") {
    if (typeof o.width === "number" && typeof o.height === "number") {
      if (
        o.x <= bbox.x + bbox.width &&
        o.y <= bbox.y + bbox.height &&
        o.x + o.width >= bbox.x &&
        o.y + o.height >= bbox.y
      ) {
        return true;
      }
    } else if (inside(o.x, o.y)) {
      return true;
    }
  }
  if (
    typeof o.x1 === "number" && typeof o.y1 === "number" &&
    typeof o.x2 === "number" && typeof o.y2 === "number" &&
    (inside(o.x1, o.y1) || inside(o.x2, o.y2))
  ) {
    return true;
  }
  return Object.values(o).some((v) => touchesBox(v, bbox));
}

function sectionCounts(annotations: DieAnnotations): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const key of ANNOTATION_SECTIONS) {
    const value = annotations[key];
    if (Array.isArray(value)) counts[key] = value.length;
  }
  counts.analogLayerShapes = Object.values(annotations.analogLayers ?? {}).reduce(
    (sum, shapes) => sum + (shapes?.length ?? 0),
    0
  );
  return counts;
}

const getDieInfo: ToolDef = {
  name: "get_die_info",
  title: "Die info",
  description:
    "Overview of the die: image size in pixels, scale (µm per pixel, if set), " +
    "overlay images, annotation counts per section, and what this MCP client may write. Call this first.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
  run: async (ctx) => {
    const record = await readDieRecord(ctx.dataRoot, ctx.dieId);
    const annotations = await readAnnotations(ctx.dataRoot, ctx.dieId);
    const state = await readMcpState(ctx.dataRoot, ctx.dieId);
    const overlays = await listManifests(ctx.dataRoot, ctx.dieId).catch(() => []);
    const stack = layerStackOf(record, annotations);
    return textResult({
      dieId: record.id,
      name: record.name,
      originalFilename: record.originalFilename,
      width: record.width,
      height: record.height,
      umPerPx: annotations.umPerPx ?? null,
      coordinates:
        "All coordinates are full-resolution die image pixels, origin top-left, x right, y down.",
      overlays: overlays.map((o) => ({
        id: o.id,
        name: o.name,
        width: o.width,
        height: o.height,
        purpose: o.purpose ?? null,
        purposeSource: o.purposeSource ?? "none",
        suggestedPurpose: o.suggestedPurpose ?? null
      })),
      annotationRev: annotations.rev,
      annotationCounts: sectionCounts(annotations),
      mcpWriteMode: state.mode,
      mcpWriteModeMeaning: {
        off: "read-only",
        create: "may add comments, comment replies, floorplan regions and rulers",
        edit: "may also modify / delete markup this MCP client created (never human-made items)"
      }[state.mode],
      mcpWireEdits: state.wires
        ? "allowed: create nets, extend / connect into any net, edit or delete nodes, segments and vias this MCP client created"
        : "off (wires and vias are read-only)",
      mcpFullEdits: state.full
        ? "ON: edit_annotations may change any annotation (human-made too), and the ownership limits above are lifted"
        : "off",
      process: annotations.process
        ? {
            kind: annotations.process.kind,
            substrate: SUBSTRATE_NAMES[annotations.process.substrate],
            layers: annotations.process.layers.map((l) => ({ layer: l, name: PROCESS_LAYERS[l].name })),
            note: "Process layers are wire layers like metals; CT_* vias contact them to metal 1, TAP_* vias tap wells / epi / isolation / buried layer."
          }
        : null,
      metalStack: {
        wireLayers: [...new Set(["poly", ...stack.metals.map((m) => m.layer)])],
        metals: stack.metals.map(({ id, layer, name }) => ({ id, layer, name })),
        vias: stack.vias.map(({ id, from, to }) => ({ id, from, to }))
      }
    });
  }
};

const getAnnotations: ToolDef = {
  name: "get_annotations",
  title: "Get annotations",
  description:
    "Read the die's annotations as JSON: nets (wires/vias), cell types and placed cells, I/O pins, analog " +
    "device layers, ML annotations, rulers, comments, floorplan regions, IC package mapping, etc. Pick " +
    "sections to keep the answer small; list sections are paginated with offset/limit. Optionally only " +
    "return items touching a bbox (approximate: tested on their points / boxes). The result also lists " +
    "`mcpOwnedIds` — the markup this MCP client created and may edit in \"edit\" mode.",
  inputSchema: {
    type: "object",
    properties: {
      sections: {
        type: "array",
        items: { type: "string", enum: [...ANNOTATION_SECTIONS] },
        description: "Sections to return (default: all)"
      },
      offset: { type: "integer", minimum: 0, description: "Skip this many items of each list section (default 0)" },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 5000,
        description: "Max items per list section (default 200)"
      },
      bbox: {
        type: "object",
        properties: { x: point, y: point, width: { type: "number" }, height: { type: "number" } },
        required: ["x", "y", "width", "height"],
        description: "Only items touching this die-pixel rectangle"
      }
    },
    additionalProperties: false
  },
  annotations: { readOnlyHint: true },
  run: async (ctx, args) => {
    const annotations = await readAnnotations(ctx.dataRoot, ctx.dieId);
    const state = await readMcpState(ctx.dataRoot, ctx.dieId);
    const requested = args.sections === undefined ? [...ANNOTATION_SECTIONS] : args.sections;
    if (!Array.isArray(requested) || requested.some((s) => !(ANNOTATION_SECTIONS as readonly string[]).includes(s))) {
      throw new ToolInputError(`"sections" must be a list of: ${ANNOTATION_SECTIONS.join(", ")}`);
    }
    const offset = Math.max(0, Math.floor(num(args, "offset", true) ?? 0));
    const limit = Math.min(5000, Math.max(1, Math.floor(num(args, "limit", true) ?? 200)));
    let bbox: Rect | undefined;
    if (args.bbox !== undefined) {
      const b = args.bbox as Record<string, unknown>;
      bbox = { x: num(b, "x"), y: num(b, "y"), width: num(b, "width"), height: num(b, "height") };
    }

    const sections: Record<string, unknown> = {};
    const pages: Record<string, { total: number; offset: number; returned: number }> = {};
    for (const key of requested as (typeof ANNOTATION_SECTIONS)[number][]) {
      let value: unknown = annotations[key];
      if (value === undefined) continue;
      if (key === "analogLayers" && bbox) {
        const layers: Record<string, unknown[]> = {};
        for (const [layer, shapes] of Object.entries(value as Record<string, unknown[]>)) {
          const hit = (shapes ?? []).filter((s) => touchesBox(s, bbox!));
          if (hit.length) layers[layer] = hit;
        }
        value = layers;
      }
      if (Array.isArray(value)) {
        const all = bbox && key !== "cellTypes" ? value.filter((v) => touchesBox(v, bbox!)) : value;
        const page = all.slice(offset, offset + limit);
        pages[key] = { total: all.length, offset, returned: page.length };
        value = page;
      }
      sections[key] = value;
    }
    return textResult({
      rev: annotations.rev,
      ...(bbox ? { bbox } : {}),
      pagination: pages,
      sections,
      mcpOwnedIds: state.owned
    });
  }
};

const getDieImage: ToolDef = {
  name: "get_die_image",
  title: "Get die image",
  description:
    "Get the die photo (or a region of it) as a JPEG. Without a region you get the whole die downscaled. " +
    "Zoom in by passing a smaller region; the image is never larger than maxSize on its long side. " +
    "The text part says how output pixels map back to die pixel coordinates. Pass overlayId (see " +
    "get_die_info) to composite an aligned overlay image (e.g. another layer photo) on top.",
  inputSchema: {
    type: "object",
    properties: {
      x: { ...point, description: "Region left (die pixels, default 0)" },
      y: { ...point, description: "Region top (die pixels, default 0)" },
      width: { type: "number", description: "Region width (die pixels, default: to the right edge)" },
      height: { type: "number", description: "Region height (die pixels, default: to the bottom edge)" },
      maxSize: {
        type: "integer",
        minimum: 64,
        maximum: 2048,
        description: "Max output long side in pixels (default 1024)"
      },
      overlayId: { type: "string", description: "Overlay image id to composite on top" }
    },
    additionalProperties: false
  },
  annotations: { readOnlyHint: true },
  run: async (ctx, args) => {
    const record = await readDieRecord(ctx.dataRoot, ctx.dieId);
    const x = Math.max(0, Math.round(num(args, "x", true) ?? 0));
    const y = Math.max(0, Math.round(num(args, "y", true) ?? 0));
    if (x >= record.width || y >= record.height) {
      throw new ToolInputError(`Region starts outside the die (${record.width}×${record.height} px)`);
    }
    const width = Math.min(Math.round(num(args, "width", true) ?? record.width - x), record.width - x);
    const height = Math.min(Math.round(num(args, "height", true) ?? record.height - y), record.height - y);
    if (width <= 0 || height <= 0) throw new ToolInputError(`Region must have a positive width and height`);
    const maxSize = Math.min(2048, Math.max(64, Math.round(num(args, "maxSize", true) ?? 1024)));
    const overlayId = str(args, "overlayId", true);
    if (overlayId && !(await listManifests(ctx.dataRoot, ctx.dieId)).some((o) => o.id === overlayId)) {
      throw new ToolInputError(`No overlay image with id ${overlayId} (see get_die_info)`);
    }

    const rect = { left: x, top: y, width, height };
    const crop = await renderDieCrop({
      dataRoot: ctx.dataRoot,
      dieId: ctx.dieId,
      record,
      key: "mcp",
      rect,
      minPx: maxSize,
      overlaySourceId: overlayId
    });
    const { data, info } = await sharp(crop.path)
      .resize({ width: maxSize, height: maxSize, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer({ resolveWithObject: true });
    const perPx = width / info.width;
    return {
      content: [
        { type: "image", data: data.toString("base64"), mimeType: "image/jpeg" },
        {
          type: "text",
          text: JSON.stringify({
            region: { x, y, width, height },
            output: { width: info.width, height: info.height },
            diePixelsPerOutputPixel: Number(perPx.toFixed(4)),
            mapping: `die_x = ${x} + out_x * ${perPx.toFixed(4)}, die_y = ${y} + out_y * ${(height / info.height).toFixed(4)}`,
            ...(overlayId ? { overlayId } : {})
          })
        }
      ]
    };
  }
};

// ─── Write tools: create ────────────────────────────────────────────

const renderAnnotatedImage: ToolDef = {
  name: "render_annotated_image",
  title: "Render annotated image",
  description:
    "Render the die (or a region) with its annotations drawn on top — wires colored by layer, vias, cells " +
    "with type names, I/O pins, floorplan regions, numbered comment pins, rulers — like a die viewer " +
    "screenshot. Highlight ids in yellow (others fade) and add your own marks (boxes, arrows, labels) to " +
    "illustrate an answer. To show the image to people on the die, pass the same arguments as `image` to " +
    "add_comment or reply_to_comment.",
  inputSchema: { type: "object", properties: renderSpecSchemaProperties, additionalProperties: false },
  annotations: { readOnlyHint: true },
  run: async (ctx, args) => {
    const record = await readDieRecord(ctx.dataRoot, ctx.dieId);
    const spec = await parseRenderSpec(ctx.dataRoot, record, args);
    const annotations = await readAnnotations(ctx.dataRoot, ctx.dieId);
    const { jpeg, ...meta } = await renderAnnotated({
      dataRoot: ctx.dataRoot,
      record,
      annotations,
      stack: layerStackOf(record, annotations),
      spec
    });
    const k = meta.diePixelsPerOutputPixel;
    return {
      content: [
        { type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" },
        {
          type: "text",
          text: JSON.stringify({
            ...meta,
            mapping: `die_x = ${meta.region.x} + out_x * ${k}, die_y = ${meta.region.y} + out_y * ${k}`
          })
        }
      ]
    };
  }
};

const imageSchema = {
  type: "object",
  properties: { ...renderSpecSchemaProperties, caption: { type: "string" } },
  additionalProperties: false,
  description: "Attach an annotated render (same arguments as render_annotated_image, plus an optional caption)"
};

/** Render and store `args.image` for a comment / reply; checks the gate first
 *  so a refused write doesn't leave an image file behind. */
async function attachImage(ctx: McpToolContext, args: Record<string, unknown>): Promise<CommentImage[] | undefined> {
  if (args.image === undefined) return undefined;
  if (!args.image || typeof args.image !== "object" || Array.isArray(args.image)) {
    throw new ToolInputError(`"image" must be an object`);
  }
  requireGate(await readMcpState(ctx.dataRoot, ctx.dieId), "create");
  const image = args.image as Record<string, unknown>;
  const caption = str(image, "caption", true);
  const record = await readDieRecord(ctx.dataRoot, ctx.dieId);
  const spec = await parseRenderSpec(ctx.dataRoot, record, image);
  const annotations = await readAnnotations(ctx.dataRoot, ctx.dieId);
  const rendered = await renderAnnotated({
    dataRoot: ctx.dataRoot,
    record,
    annotations,
    stack: layerStackOf(record, annotations),
    spec
  });
  return [
    await saveCommentImage(ctx.dataRoot, ctx.dieId, rendered.jpeg, {
      width: rendered.width,
      height: rendered.height,
      caption
    })
  ];
}

const addComment: ToolDef = {
  name: "add_comment",
  title: "Add comment",
  description:
    "Pin a comment at a point on the die (shown to users as a comment marker), optionally with an " +
    "annotated image (see render_annotated_image) people see in the comment window. Requires MCP write " +
    "mode \"create\" or \"edit\". Undoable from the die viewer's MCP panel.",
  inputSchema: {
    type: "object",
    properties: { x: point, y: point, text: { type: "string" }, image: imageSchema },
    required: ["x", "y", "text"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
  run: async (ctx, args) => {
    const record = await readDieRecord(ctx.dataRoot, ctx.dieId);
    const p = { x: Math.round(num(args, "x")), y: Math.round(num(args, "y")) };
    assertOnDie(record, [p]);
    const text = nonEmpty(str(args, "text"), "text");
    const images = await attachImage(ctx, args);
    return write(ctx, "create", () => {
      const comment: CommentAnnotation = {
        id: randomUUID(),
        ...p,
        text,
        authorId: MCP_AUTHOR_ID,
        authorName: authorName(ctx),
        createdAt: new Date().toISOString(),
        replies: [],
        ...(images ? { images } : {})
      };
      return {
        tool: "add_comment",
        summary: `Comment "${clip(text)}"`,
        items: [{ collection: "comments", id: comment.id, after: comment }],
        own: { comments: [comment.id] },
        result: { commentId: comment.id, ...(images ? { imageId: images[0].id } : {}) }
      };
    });
  }
};

const replyToComment: ToolDef = {
  name: "reply_to_comment",
  title: "Reply to comment",
  description:
    "Add a reply to any comment (a user's or your own), optionally with an annotated image. Requires MCP " +
    "write mode \"create\" or \"edit\".",
  inputSchema: {
    type: "object",
    properties: { commentId: { type: "string" }, text: { type: "string" }, image: imageSchema },
    required: ["commentId", "text"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
  run: async (ctx, args) => {
    const commentId = str(args, "commentId");
    const text = nonEmpty(str(args, "text"), "text");
    const before = await readAnnotations(ctx.dataRoot, ctx.dieId);
    if (!findItem(before, "comments", commentId)) throw new McpEditError(`No comment with id ${commentId}`, 404);
    const images = await attachImage(ctx, args);
    return write(ctx, "create", (annotations) => {
      const comment = findItem<CommentAnnotation>(annotations, "comments", commentId);
      if (!comment) throw new McpEditError(`No comment with id ${commentId}`, 404);
      const reply: CommentReply = {
        id: randomUUID(),
        text,
        authorId: MCP_AUTHOR_ID,
        authorName: authorName(ctx),
        createdAt: new Date().toISOString(),
        ...(images ? { images } : {})
      };
      return {
        tool: "reply_to_comment",
        summary: `Reply "${clip(text)}"`,
        items: [{ collection: "comments", id: commentId, after: { ...comment, replies: [...(comment.replies ?? []), reply] } }],
        own: { replies: [reply.id] },
        result: { commentId, replyId: reply.id, ...(images ? { imageId: images[0].id } : {}) }
      };
    });
  }
};

const addFloorplanRegion: ToolDef = {
  name: "add_floorplan_region",
  title: "Add floorplan region",
  description:
    "Outline a functional block on the die (e.g. \"bandgap\", \"UVLO\"). kind \"rect\" takes 2 opposite " +
    "corners, \"polygon\" 3+ vertices. Requires MCP write mode \"create\" or \"edit\".",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      kind: { type: "string", enum: ["rect", "polygon"] },
      points: {
        type: "array",
        items: { type: "object", properties: { x: point, y: point }, required: ["x", "y"] }
      },
      color: { type: "string", description: "Outline color #rrggbb (default #4dabf7)" },
      layerTag: {
        type: "string",
        description: "Canonical process layer the region outlines (psub, nsub, nwell, pwell, ndiff, pdiff, poly, nbl, nepi, pbase, piso…); flips with the die's polarity toggle"
      }
    },
    required: ["name", "kind", "points"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
  run: async (ctx, args) => {
    const record = await readDieRecord(ctx.dataRoot, ctx.dieId);
    const name = nonEmpty(str(args, "name"), "name");
    const kind = regionKind(args.kind);
    const geometry = points(args.points, kind);
    assertOnDie(record, geometry);
    const regionColor = color(str(args, "color", true)) ?? "#4dabf7";
    const layerTag = processTag(str(args, "layerTag", true));
    return write(ctx, "create", () => {
      const region: FloorplanRegion = {
        id: randomUUID(),
        name,
        kind,
        geometry,
        color: regionColor,
        createdBy: MCP_AUTHOR_ID,
        createdByName: authorName(ctx),
        createdAt: new Date().toISOString(),
        reservedBy: null,
        reservedByName: null,
        reservedAt: null,
        ...(layerTag ? { layerTag } : {})
      };
      return {
        tool: "add_floorplan_region",
        summary: `Floorplan "${clip(name)}"`,
        items: [{ collection: "floorplanRegions", id: region.id, after: region }],
        own: { floorplanRegions: [region.id] },
        result: { regionId: region.id }
      };
    });
  }
};

function rulerLengths(annotations: DieAnnotations, r: Pick<RulerMeasurement, "x1" | "y1" | "x2" | "y2">) {
  const lengthPx = Math.hypot(r.x2 - r.x1, r.y2 - r.y1);
  return { lengthPx, lengthUm: lengthPx * (annotations.umPerPx ?? 0) };
}

const addRuler: ToolDef = {
  name: "add_ruler",
  title: "Add ruler",
  description:
    "Add a ruler (measurement line) between two die points; its length is shown in µm when the die scale " +
    "is set. Requires MCP write mode \"create\" or \"edit\".",
  inputSchema: {
    type: "object",
    properties: { x1: point, y1: point, x2: point, y2: point, name: { type: "string" } },
    required: ["x1", "y1", "x2", "y2"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
  run: async (ctx, args) => {
    const record = await readDieRecord(ctx.dataRoot, ctx.dieId);
    const ends = { x1: num(args, "x1"), y1: num(args, "y1"), x2: num(args, "x2"), y2: num(args, "y2") };
    assertOnDie(record, [{ x: ends.x1, y: ends.y1 }, { x: ends.x2, y: ends.y2 }]);
    const name = str(args, "name", true);
    return write(ctx, "create", (annotations) => {
      const ruler: RulerMeasurement = {
        id: randomUUID(),
        ...(name ? { name } : {}),
        ...ends,
        ...rulerLengths(annotations, ends)
      };
      return {
        tool: "add_ruler",
        summary: `Ruler ${name ? `"${clip(name)}" ` : ""}${Math.round(ruler.lengthPx)} px`,
        items: [{ collection: "rulers", id: ruler.id, after: ruler }],
        own: { rulers: [ruler.id] },
        result: { rulerId: ruler.id, lengthPx: ruler.lengthPx, lengthUm: ruler.lengthUm }
      };
    });
  }
};

// ─── Write tools: edit own ──────────────────────────────────────────

const updateComment: ToolDef = {
  name: "update_comment",
  title: "Update comment",
  description:
    "Change the text or position of a comment this MCP client created, or (with replyId) the text of one " +
    "of its own replies. Requires MCP write mode \"edit\".",
  inputSchema: {
    type: "object",
    properties: {
      commentId: { type: "string" },
      replyId: { type: "string", description: "Edit this reply instead of the comment" },
      text: { type: "string" },
      x: point,
      y: point
    },
    required: ["commentId"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
  run: async (ctx, args) => {
    const record = await readDieRecord(ctx.dataRoot, ctx.dieId);
    const commentId = str(args, "commentId");
    const replyId = str(args, "replyId", true);
    const text = str(args, "text", true);
    if (text !== undefined) nonEmpty(text, "text");
    const x = num(args, "x", true);
    const y = num(args, "y", true);
    return write(ctx, "edit", (annotations, state) => {
      if (replyId) {
        const comment = findItem<CommentAnnotation>(annotations, "comments", commentId);
        if (!comment) throw new McpEditError(`No comment with id ${commentId}`, 404);
        const reply = comment.replies?.find((r) => r.id === replyId);
        if (!reply) throw new McpEditError(`No reply ${replyId} on comment ${commentId}`, 404);
        if (!isMine(state, "replies", replyId)) {
          throw new McpEditError(`Reply ${replyId} was not created by MCP; it is read-only.`, 403);
        }
        if (text === undefined) throw new ToolInputError(`"text" is required when editing a reply`);
        return {
          tool: "update_comment",
          summary: `Edit reply "${clip(text)}"`,
          items: [{
            collection: "comments",
            id: commentId,
            after: { ...comment, replies: comment.replies.map((r) => (r.id === replyId ? { ...r, text } : r)) }
          }]
        };
      }
      const comment = requireOwned<CommentAnnotation>(annotations, state, "comments", commentId);
      if (text === undefined && x === undefined && y === undefined) {
        throw new ToolInputError(`Nothing to change: pass text and/or x, y`);
      }
      const next = {
        ...comment,
        ...(text !== undefined ? { text } : {}),
        ...(x !== undefined ? { x: Math.round(x) } : {}),
        ...(y !== undefined ? { y: Math.round(y) } : {})
      };
      assertOnDie(record, [next]);
      return {
        tool: "update_comment",
        summary: `Edit comment "${clip(next.text)}"`,
        items: [{ collection: "comments", id: commentId, after: next }]
      };
    });
  }
};

const deleteComment: ToolDef = {
  name: "delete_comment",
  title: "Delete comment",
  description:
    "Delete a comment this MCP client created (only if no user replied to it), or with replyId one of its " +
    "own replies. Requires MCP write mode \"edit\". Users can undo it from the MCP panel.",
  inputSchema: {
    type: "object",
    properties: { commentId: { type: "string" }, replyId: { type: "string" } },
    required: ["commentId"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
  run: async (ctx, args) => {
    const commentId = str(args, "commentId");
    const replyId = str(args, "replyId", true);
    return write(ctx, "edit", (annotations, state) => {
      if (replyId) {
        const comment = findItem<CommentAnnotation>(annotations, "comments", commentId);
        if (!comment) throw new McpEditError(`No comment with id ${commentId}`, 404);
        const reply = comment.replies?.find((r) => r.id === replyId);
        if (!reply) throw new McpEditError(`No reply ${replyId} on comment ${commentId}`, 404);
        if (!isMine(state, "replies", replyId)) {
          throw new McpEditError(`Reply ${replyId} was not created by MCP; it is read-only.`, 403);
        }
        return {
          tool: "delete_comment",
          summary: `Delete reply "${clip(reply.text)}"`,
          items: [{
            collection: "comments",
            id: commentId,
            after: { ...comment, replies: comment.replies.filter((r) => r.id !== replyId) }
          }]
        };
      }
      const comment = requireOwned<CommentAnnotation>(annotations, state, "comments", commentId);
      if (!state.full && (comment.replies ?? []).some((r) => !state.owned.replies.includes(r.id))) {
        throw new McpEditError(`Comment ${commentId} has replies from users; it can't be deleted by MCP.`, 403);
      }
      return {
        tool: "delete_comment",
        summary: `Delete comment "${clip(comment.text)}"`,
        items: [{ collection: "comments", id: commentId, after: null }]
      };
    });
  }
};

function requireUnreserved(region: FloorplanRegion): void {
  if (region.reservedBy && region.reservedBy !== MCP_AUTHOR_ID) {
    throw new McpEditError(
      `Floorplan region ${region.id} is reserved by ${region.reservedByName ?? region.reservedBy}.`,
      403
    );
  }
}

const updateFloorplanRegion: ToolDef = {
  name: "update_floorplan_region",
  title: "Update floorplan region",
  description:
    "Rename, recolor or reshape a floorplan region this MCP client created. To reshape pass kind + points. " +
    "Requires MCP write mode \"edit\".",
  inputSchema: {
    type: "object",
    properties: {
      regionId: { type: "string" },
      name: { type: "string" },
      color: { type: "string", description: "#rrggbb" },
      layerTag: {
        type: "string",
        description: "Canonical process layer the region outlines (psub, nsub, nwell, pwell, ndiff, pdiff, poly, nbl, nepi, pbase, piso…); \"none\" removes it; flips with the die's polarity toggle"
      },
      kind: { type: "string", enum: ["rect", "polygon"] },
      points: {
        type: "array",
        items: { type: "object", properties: { x: point, y: point }, required: ["x", "y"] }
      }
    },
    required: ["regionId"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
  run: async (ctx, args) => {
    const record = await readDieRecord(ctx.dataRoot, ctx.dieId);
    const regionId = str(args, "regionId");
    const name = str(args, "name", true);
    if (name !== undefined) nonEmpty(name, "name");
    const regionColor = color(str(args, "color", true));
    if ((args.kind === undefined) !== (args.points === undefined)) {
      throw new ToolInputError(`Pass kind and points together to reshape`);
    }
    const kind = args.kind === undefined ? undefined : regionKind(args.kind);
    const geometry = kind ? points(args.points, kind) : undefined;
    if (geometry) assertOnDie(record, geometry);
    const rawTag = str(args, "layerTag", true);
    const layerTag = rawTag === "none" ? null : processTag(rawTag);
    if (name === undefined && regionColor === undefined && !geometry && rawTag === undefined) {
      throw new ToolInputError(`Nothing to change: pass name, color, layerTag and/or kind + points`);
    }
    return write(ctx, "edit", (annotations, state) => {
      const region = requireOwned<FloorplanRegion>(annotations, state, "floorplanRegions", regionId);
      requireUnreserved(region);
      const next: FloorplanRegion = {
        ...region,
        ...(name !== undefined ? { name } : {}),
        ...(regionColor !== undefined ? { color: regionColor } : {}),
        ...(kind && geometry ? { kind, geometry } : {})
      };
      if (layerTag === null) delete next.layerTag;
      else if (layerTag !== undefined) next.layerTag = layerTag;
      return {
        tool: "update_floorplan_region",
        summary: `Edit floorplan "${clip(next.name)}"`,
        items: [{ collection: "floorplanRegions", id: regionId, after: next }]
      };
    });
  }
};

const deleteFloorplanRegion: ToolDef = {
  name: "delete_floorplan_region",
  title: "Delete floorplan region",
  description: "Delete a floorplan region this MCP client created. Requires MCP write mode \"edit\".",
  inputSchema: {
    type: "object",
    properties: { regionId: { type: "string" } },
    required: ["regionId"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
  run: async (ctx, args) => {
    const regionId = str(args, "regionId");
    return write(ctx, "edit", (annotations, state) => {
      const region = requireOwned<FloorplanRegion>(annotations, state, "floorplanRegions", regionId);
      requireUnreserved(region);
      return {
        tool: "delete_floorplan_region",
        summary: `Delete floorplan "${clip(region.name)}"`,
        items: [{ collection: "floorplanRegions", id: regionId, after: null }]
      };
    });
  }
};

const updateRuler: ToolDef = {
  name: "update_ruler",
  title: "Update ruler",
  description: "Move the ends of, or rename, a ruler this MCP client created. Requires MCP write mode \"edit\".",
  inputSchema: {
    type: "object",
    properties: { rulerId: { type: "string" }, x1: point, y1: point, x2: point, y2: point, name: { type: "string" } },
    required: ["rulerId"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
  run: async (ctx, args) => {
    const record = await readDieRecord(ctx.dataRoot, ctx.dieId);
    const rulerId = str(args, "rulerId");
    const patch = {
      x1: num(args, "x1", true),
      y1: num(args, "y1", true),
      x2: num(args, "x2", true),
      y2: num(args, "y2", true)
    };
    const name = str(args, "name", true);
    if (name === undefined && Object.values(patch).every((v) => v === undefined)) {
      throw new ToolInputError(`Nothing to change: pass x1/y1/x2/y2 and/or name`);
    }
    return write(ctx, "edit", (annotations, state) => {
      const ruler = requireOwned<RulerMeasurement>(annotations, state, "rulers", rulerId);
      const ends = {
        x1: patch.x1 ?? ruler.x1,
        y1: patch.y1 ?? ruler.y1,
        x2: patch.x2 ?? ruler.x2,
        y2: patch.y2 ?? ruler.y2
      };
      assertOnDie(record, [{ x: ends.x1, y: ends.y1 }, { x: ends.x2, y: ends.y2 }]);
      const next: RulerMeasurement = {
        ...ruler,
        ...ends,
        ...(name !== undefined ? { name } : {}),
        ...rulerLengths(annotations, ends)
      };
      return {
        tool: "update_ruler",
        summary: `Edit ruler${next.name ? ` "${clip(next.name)}"` : ""}`,
        items: [{ collection: "rulers", id: rulerId, after: next }],
        result: { lengthPx: next.lengthPx, lengthUm: next.lengthUm }
      };
    });
  }
};

const deleteRuler: ToolDef = {
  name: "delete_ruler",
  title: "Delete ruler",
  description: "Delete a ruler this MCP client created. Requires MCP write mode \"edit\".",
  inputSchema: {
    type: "object",
    properties: { rulerId: { type: "string" } },
    required: ["rulerId"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
  run: async (ctx, args) => {
    const rulerId = str(args, "rulerId");
    return write(ctx, "edit", (annotations, state) => {
      const ruler = requireOwned<RulerMeasurement>(annotations, state, "rulers", rulerId);
      return {
        tool: "delete_ruler",
        summary: `Delete ruler${ruler.name ? ` "${clip(ruler.name)}"` : ""}`,
        items: [{ collection: "rulers", id: rulerId, after: null }]
      };
    });
  }
};

const TOOLS: ToolDef[] = [
  getDieInfo,
  getAnnotations,
  getDieImage,
  renderAnnotatedImage,
  addComment,
  replyToComment,
  addFloorplanRegion,
  addRuler,
  updateComment,
  deleteComment,
  updateFloorplanRegion,
  deleteFloorplanRegion,
  updateRuler,
  deleteRuler,
  ...WIRE_TOOLS,
  ...FULL_EDIT_TOOLS,
  ...EXTENDED_TOOLS
];

export function listMcpTools() {
  return TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({
    name,
    title,
    description,
    inputSchema,
    annotations
  }));
}

/** Run a tool. Unknown tool → null (a JSON-RPC error, not a tool error). */
export async function callMcpTool(
  ctx: McpToolContext,
  name: string,
  args: Record<string, unknown>
): Promise<McpToolResult | null> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return null;
  try {
    return await tool.run(ctx, args);
  } catch (error) {
    if (error instanceof ToolInputError || error instanceof McpEditError) return errorResult(error.message);
    throw error;
  }
}
