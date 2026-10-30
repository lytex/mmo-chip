import type {
  McpPromptEvidence,
  McpPromptField,
  McpPromptImage,
  McpPromptOption,
  McpPromptStats,
  McpUserPrompt
} from "shared";
import { readAnnotations, readDieRecord } from "../store.js";
import { parseRenderSpec, renderAnnotated, renderSpecSchemaProperties } from "./annotatedRender.js";
import { num, str, textResult, ToolInputError, type McpToolContext, type ToolDef } from "./mcpToolKit.js";
import { layerStackOf } from "./mcpWires.js";
import { createPrompt } from "./userPrompt.js";

/**
 * `ask_user` — let an MCP client stop and ask the human.
 *
 * Reverse engineering hits forks the agent cannot resolve from pixels alone:
 * which of two well assignments is right, whether two cell types are really
 * the same cell, what a supply voltage was. This tool turns that into a modal
 * in the mmo-chip GUI that carries the evidence the client chooses — annotated
 * renders / crops / overlay views, a SPICE netlist, simulation statistics or
 * any small table — and resolves with the answer.
 *
 * The tool itself writes nothing. `proposal` is echoed back untouched; when
 * the client wants the user to approve an edit it puts a description of that
 * edit there, gets `approved: true`, and then runs the real (gated) write
 * tool. Keeping the write out of `ask_user` means a prompt can never change
 * the project on its own.
 */

const MAX_IMAGES = 6;
const MAX_OPTIONS = 8;
const MAX_FIELDS = 8;
const MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024;
const NUMERIC_RE = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;

const OPTION_ROLES = ["approve", "reject", "cancel", "neutral"] as const;
const OPTION_TONES = ["primary", "danger", "neutral"] as const;
const FIELD_TYPES = ["text", "number", "select", "boolean"] as const;

function objectArray(args: Record<string, unknown>, key: string, max: number): Record<string, unknown>[] {
  const value = args[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ToolInputError(`"${key}" must be an array`);
  if (value.length > max) throw new ToolInputError(`"${key}" takes at most ${max} entries`);
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ToolInputError(`"${key}[${index}]" must be an object`);
    }
    return entry as Record<string, unknown>;
  });
}

function parseOptions(args: Record<string, unknown>): McpPromptOption[] {
  const raw = objectArray(args, "options", MAX_OPTIONS);
  const seen = new Set<string>();
  return raw.map((option, index) => {
    const id = str(option, "id");
    if (!id.trim()) throw new ToolInputError(`options[${index}].id must not be empty`);
    if (seen.has(id)) throw new ToolInputError(`Duplicate option id "${id}"`);
    seen.add(id);
    const role = option.role;
    if (role !== undefined && !(OPTION_ROLES as readonly unknown[]).includes(role)) {
      throw new ToolInputError(`options[${index}].role must be one of ${OPTION_ROLES.join(", ")}`);
    }
    const tone = option.tone;
    if (tone !== undefined && !(OPTION_TONES as readonly unknown[]).includes(tone)) {
      throw new ToolInputError(`options[${index}].tone must be one of ${OPTION_TONES.join(", ")}`);
    }
    const description = str(option, "description", true);
    return {
      id,
      label: str(option, "label"),
      ...(description ? { description } : {}),
      ...(role ? { role: role as McpPromptOption["role"] } : {}),
      ...(tone ? { tone: tone as McpPromptOption["tone"] } : {})
    };
  });
}

/** A confirmation without explicit buttons gets the obvious three. */
function defaultOptions(kind: McpUserPrompt["kind"]): McpPromptOption[] {
  if (kind !== "confirm") return [];
  return [
    { id: "approve", label: "Approve", role: "approve", tone: "primary" },
    { id: "reject", label: "Reject", role: "reject", tone: "neutral" },
    { id: "cancel", label: "Not now", role: "cancel", tone: "neutral" }
  ];
}

function parseFields(args: Record<string, unknown>): McpPromptField[] {
  const raw = objectArray(args, "fields", MAX_FIELDS);
  const seen = new Set<string>();
  return raw.map((field, index) => {
    const id = str(field, "id");
    if (!id.trim()) throw new ToolInputError(`fields[${index}].id must not be empty`);
    if (seen.has(id)) throw new ToolInputError(`Duplicate field id "${id}"`);
    seen.add(id);
    const type = field.type;
    if (!(FIELD_TYPES as readonly unknown[]).includes(type)) {
      throw new ToolInputError(`fields[${index}].type must be one of ${FIELD_TYPES.join(", ")}`);
    }
    const options =
      type === "select"
        ? objectArray(field, "options", 24).map((option, oi) => ({
            value: str(option, "value"),
            label: str(option, "label", true) ?? str(option, "value")
          }))
        : undefined;
    if (type === "select" && (!options || options.length === 0)) {
      throw new ToolInputError(`fields[${index}] is a select but has no options`);
    }
    const fallback = field.default;
    const defaultValue =
      type === "boolean"
        ? typeof fallback === "boolean"
          ? fallback
          : undefined
        : type === "number"
          ? typeof fallback === "number"
            ? fallback
            : typeof fallback === "string" && NUMERIC_RE.test(fallback)
              ? Number(fallback)
              : undefined
          : typeof fallback === "string"
            ? fallback
            : fallback === undefined
              ? undefined
              : String(fallback);
    if (type === "select" && defaultValue !== undefined && !options!.some((o) => o.value === defaultValue)) {
      throw new ToolInputError(`fields[${index}].default must be one of its option values`);
    }
    const placeholder = str(field, "placeholder", true);
    const hint = str(field, "hint", true);
    return {
      id,
      label: str(field, "label"),
      type: type as McpPromptField["type"],
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
      ...(options ? { options } : {}),
      ...(placeholder ? { placeholder } : {}),
      ...(field.required === true ? { required: true } : {}),
      ...(hint ? { hint } : {})
    };
  });
}

interface RenderedImage {
  image: Omit<McpPromptImage, "index">;
  bytes: number;
}

/** Turn one image request into an inline JPEG (annotated render or raw crop). */
async function renderPromptImage(
  ctx: McpToolContext,
  record: Awaited<ReturnType<typeof readDieRecord>>,
  annotations: Awaited<ReturnType<typeof readAnnotations>>,
  raw: Record<string, unknown>,
  index: number
): Promise<RenderedImage> {
  const label = str(raw, "label", true) ?? `Image ${index + 1}`;
  const caption = str(raw, "caption", true);
  const mode = raw.mode ?? "annotated";
  if (mode !== "annotated" && mode !== "photo") {
    throw new ToolInputError(`images[${index}].mode must be "annotated" or "photo"`);
  }
  // Cap the long side so several images still fit comfortably in one prompt.
  const requested = Math.round(num(raw, "maxSize", true) ?? 900);
  const maxSize = Math.min(1280, Math.max(128, requested));
  const spec = await parseRenderSpec(ctx.dataRoot, record, { ...raw, maxSize });
  if (mode === "photo") {
    spec.layers.clear();
    spec.highlight.clear();
    spec.dimOthers = false;
    spec.legend = false;
  }
  const { jpeg, width, height } = await renderAnnotated({
    dataRoot: ctx.dataRoot,
    record,
    annotations,
    stack: layerStackOf(record, annotations),
    spec
  });
  return {
    bytes: jpeg.length,
    image: {
      label,
      width,
      height,
      ...(caption ? { caption } : {}),
      dataUrl: `data:image/jpeg;base64,${jpeg.toString("base64")}`
    }
  };
}

function parseNetlist(raw: unknown): McpPromptEvidence["netlist"] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") {
    if (!raw.trim()) return undefined;
    return { text: raw };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ToolInputError(`"netlist" must be a string or { title, text }`);
  }
  const obj = raw as Record<string, unknown>;
  const text = str(obj, "text");
  const title = str(obj, "title", true);
  return { text, ...(title ? { title } : {}) };
}

function parseStats(raw: unknown): McpPromptStats | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ToolInputError(`"stats" must be an object`);
  const obj = raw as Record<string, unknown>;

  let metrics: McpPromptStats["metrics"];
  if (obj.metrics !== undefined) {
    metrics = objectArray(obj, "metrics", 40).map((metric, index) => {
      const value = metric.value;
      if (typeof value !== "string" && typeof value !== "number") {
        throw new ToolInputError(`stats.metrics[${index}].value must be a string or number`);
      }
      const hint = str(metric, "hint", true);
      return { label: str(metric, "label"), value: String(value), ...(hint ? { hint } : {}) };
    });
  }

  let columns: string[] | undefined;
  let rows: McpPromptStats["rows"];
  if (obj.columns !== undefined) {
    if (!Array.isArray(obj.columns) || obj.columns.some((c) => typeof c !== "string")) {
      throw new ToolInputError(`stats.columns must be a list of strings`);
    }
    columns = obj.columns as string[];
  }
  if (obj.rows !== undefined) {
    if (!Array.isArray(obj.rows) || obj.rows.length > 100) {
      throw new ToolInputError(`stats.rows must be an array of at most 100 rows`);
    }
    rows = obj.rows.map((row, index) => {
      if (!Array.isArray(row)) throw new ToolInputError(`stats.rows[${index}] must be an array`);
      if (columns && row.length !== columns.length) {
        throw new ToolInputError(`stats.rows[${index}] has ${row.length} cells but there are ${columns.length} columns`);
      }
      return row.map((cell) => {
        if (cell === null || typeof cell === "string" || typeof cell === "number") return cell;
        throw new ToolInputError(`stats.rows[${index}] cells must be strings, numbers or null`);
      });
    });
    if (!columns) {
      const width = Math.max(...rows.map((row) => row.length), 0);
      if (width === 0) throw new ToolInputError(`stats.rows is empty; either fill it or drop it`);
      columns = Array.from({ length: width }, (_, i) => `#${i + 1}`);
    }
  }
  if (!metrics && !columns) throw new ToolInputError(`"stats" needs metrics or columns/rows`);

  const title = str(obj, "title", true);
  return {
    ...(title ? { title } : {}),
    ...(metrics ? { metrics } : {}),
    ...(columns ? { columns } : {}),
    ...(rows ? { rows } : {})
  };
}

function parseNotes(args: Record<string, unknown>): string[] | undefined {
  const value = args.notes;
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((n) => typeof n !== "string")) {
    throw new ToolInputError(`"notes" must be a list of strings`);
  }
  const notes = (value as string[]).map((n) => n.trim()).filter(Boolean);
  return notes.length > 0 ? notes : undefined;
}

/** `proposal` travels back untouched, so keep it small and valid. */
function parseProposal(raw: unknown): unknown {
  if (raw === undefined) return undefined;
  let json: string;
  try {
    json = JSON.stringify(raw);
  } catch {
    throw new ToolInputError(`"proposal" must be JSON-serialisable`);
  }
  if (json.length > 20_000) throw new ToolInputError(`"proposal" is too large (${json.length} chars, max 20000)`);
  return raw;
}

const imageItemSchema = {
  type: "object",
  properties: {
    label: { type: "string", description: "Short title above the image, e.g. \"Cell 15 diffusion\"" },
    caption: { type: "string", description: "One line under the image" },
    mode: {
      type: "string",
      enum: ["annotated", "photo"],
      description: '"annotated" (default) draws wires, cells, pins and marks; "photo" is the bare die pixels'
    },
    ...renderSpecSchemaProperties
  },
  additionalProperties: false
};

const askUser: ToolDef = {
  name: "ask_user",
  title: "Ask the human",
  description:
    "Ask the person at the mmo-chip GUI a question you cannot decide yourself. This opens a modal and BLOCKS " +
    "until they answer, dismiss it, or `timeoutSec` runs out; only use it when the answer changes what you do " +
    "next, and ask one clear question at a time. Show your evidence: annotate renders/crops/overlays (`images`), " +
    "paste a SPICE netlist (`netlist`), simulation numbers (`stats`), and what you already ruled out (`notes`). " +
    "Use options for a decision (give the approve/reject options `role`, or let kind \"confirm\" add them), free " +
    "text for an open question, and `fields` for values (voltage, temperature, model name). To get a write " +
    "approved (merging cell types, renaming nets, flipping a well), describe it under `proposal`, get " +
    "`approved: true`, then run the real write tool — ask_user itself never changes the project.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question, one or two sentences" },
      detail: { type: "string", description: "Longer explanation / why it matters" },
      kind: {
        type: "string",
        enum: ["confirm", "choose", "text", "review"],
        description:
          '"confirm" (yes/no, default options added if omitted), "choose" (pick options), "text" (free answer), "review" (evidence + notes, no buttons)'
      },
      options: {
        type: "array",
        maxItems: MAX_OPTIONS,
        description: "Buttons. `role` sets `approved` (approve / reject) and `cancel` settles as cancelled.",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            label: { type: "string" },
            description: { type: "string" },
            role: { type: "string", enum: [...OPTION_ROLES] },
            tone: { type: "string", enum: [...OPTION_TONES] }
          },
          required: ["id", "label"],
          additionalProperties: false
        }
      },
      multiSelect: { type: "boolean", description: "Let the user tick several options (default false)" },
      allowFreeText: { type: "boolean", description: "Show a free-text box (default true for kind text/review)" },
      fields: {
        type: "array",
        maxItems: MAX_FIELDS,
        description: "Small form filled in along with (or instead of) the buttons",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            label: { type: "string" },
            type: { type: "string", enum: [...FIELD_TYPES] },
            default: { oneOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] },
            options: {
              type: "array",
              items: {
                type: "object",
                properties: { value: { type: "string" }, label: { type: "string" } },
                required: ["value"],
                additionalProperties: false
              }
            },
            placeholder: { type: "string" },
            hint: { type: "string" },
            required: { type: "boolean" }
          },
          required: ["id", "label", "type"],
          additionalProperties: false
        }
      },
      images: {
        type: "array",
        maxItems: MAX_IMAGES,
        description: "Evidence images, rendered server-side from the die + annotations",
        items: imageItemSchema
      },
      netlist: {
        oneOf: [
          { type: "string" },
          {
            type: "object",
            properties: { title: { type: "string" }, text: { type: "string" } },
            required: ["text"],
            additionalProperties: false
          }
        ],
        description: "SPICE netlist (or any text) shown verbatim in a scroll box"
      },
      stats: {
        type: "object",
        properties: {
          title: { type: "string" },
          metrics: {
            type: "array",
            items: {
              type: "object",
              properties: { label: { type: "string" }, value: { oneOf: [{ type: "string" }, { type: "number" }] }, hint: { type: "string" } },
              required: ["label", "value"],
              additionalProperties: false
            }
          },
          columns: { type: "array", items: { type: "string" } },
          rows: { type: "array", items: { type: "array", items: { oneOf: [{ type: "string" }, { type: "number" }, { type: "null" }] } } }
        },
        additionalProperties: false,
        description: "Simulation / layout numbers: a metric list, a small table, or both"
      },
      notes: { type: "array", items: { type: "string" }, description: "Bullet lines, e.g. what you already ruled out" },
      proposal: {
        type: "object",
        description:
          "What you will do if the user approves. Echoed back untouched; ask_user never writes it.",
        additionalProperties: true
      },
      timeoutSec: {
        type: "number",
        minimum: 10,
        maximum: 1800,
        description: "How long to wait for an answer (default 300 s). The call returns answered:false, reason:\"timeout\"."
      }
    },
    required: ["question"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: true },
  run: async (ctx, args) => {
    const question = str(args, "question").trim();
    if (!question) throw new ToolInputError(`"question" must not be empty`);

    const kindRaw = args.kind ?? "choose";
    const kinds = ["confirm", "choose", "text", "review"] as const;
    if (!(kinds as readonly unknown[]).includes(kindRaw)) {
      throw new ToolInputError(`"kind" must be one of ${kinds.join(", ")}`);
    }
    const kind = kindRaw as McpUserPrompt["kind"];

    let options = parseOptions(args);
    if (options.length === 0) options = defaultOptions(kind);
    const fields = parseFields(args);
    const multiSelect = args.multiSelect === true;
    if (multiSelect && options.length < 2) throw new ToolInputError(`multiSelect needs at least two options`);
    const allowFreeText =
      typeof args.allowFreeText === "boolean" ? args.allowFreeText : kind === "text" || kind === "review";
    if (options.length === 0 && !allowFreeText && fields.length === 0) {
      throw new ToolInputError(`A prompt needs options, free text or fields — otherwise the user cannot answer`);
    }
    if (supportsApproval(kind) && !options.some((option) => option.role === "approve" || option.role === "reject")) {
      // A "confirm" without an approve/reject role cannot set `approved`.
      throw new ToolInputError(`A confirm prompt needs an option with role "approve" (and usually "reject")`);
    }

    const notes = parseNotes(args);
    const netlist = parseNetlist(args.netlist);
    const stats = parseStats(args.stats);
    const proposal = parseProposal(args.proposal);

    const record = await readDieRecord(ctx.dataRoot, ctx.dieId);
    const rawImages = objectArray(args, "images", MAX_IMAGES);
    let images: McpPromptImage[] = [];
    if (rawImages.length > 0) {
      const annotations = await readAnnotations(ctx.dataRoot, ctx.dieId);
      let total = 0;
      for (const [index, raw] of rawImages.entries()) {
        const { image, bytes } = await renderPromptImage(ctx, record, annotations, raw, index);
        total += bytes;
        if (total > MAX_TOTAL_IMAGE_BYTES) {
          throw new ToolInputError(`The images add up to more than ${MAX_TOTAL_IMAGE_BYTES / 1024 / 1024} MB; shrink maxSize or send fewer`);
        }
        images.push({ index, ...image });
      }
    }

    const hasEvidence = images.length > 0 || netlist !== undefined || stats !== undefined || (notes?.length ?? 0) > 0;
    const evidence: McpPromptEvidence | undefined = hasEvidence
      ? {
          ...(images.length > 0 ? { images } : {}),
          ...(netlist ? { netlist } : {}),
          ...(stats ? { stats } : {}),
          ...(notes ? { notes } : {})
        }
      : undefined;

    const timeoutSec = Math.min(1800, Math.max(10, Math.round(num(args, "timeoutSec", true) ?? 300)));
    const { prompt, done } = createPrompt({
      dieId: ctx.dieId,
      dieName: record.name,
      clientName: ctx.clientName,
      question,
      ...(args.detail !== undefined && typeof args.detail === "string" ? { detail: args.detail } : {}),
      kind,
      options,
      fields,
      allowFreeText,
      multiSelect,
      ...(evidence ? { evidence } : {}),
      ...(proposal !== undefined ? { proposal } : {}),
      timeoutMs: timeoutSec * 1000
    });

    const result = await done;
    const answer = result.answered ? result.labels.join(", ") || result.text || "(filled fields)" : "(not answered)";
    return textResult({
      promptId: prompt.id,
      answered: result.answered,
      ...(result.reason ? { reason: result.reason } : {}),
      optionId: result.optionId,
      optionIds: result.optionIds,
      labels: result.labels,
      text: result.text,
      fields: result.fields,
      approved: result.approved,
      answeredBy: result.answeredBy,
      answeredAt: result.answeredAt,
      elapsedSec: Math.round(result.elapsedMs / 100) / 10,
      ...(result.proposal !== undefined ? { proposal: result.proposal } : {}),
      summary: result.answered
        ? `The user answered: ${answer}`
        : result.reason === "timeout"
          ? `No answer within ${timeoutSec} s; the question expired. Do not guess — ask again later or proceed with what you can verify.`
          : "The user dismissed the question. Do not treat that as approval."
    });
  }
};

function supportsApproval(kind: McpUserPrompt["kind"]): boolean {
  return kind === "confirm";
}

export const ASK_TOOLS: ToolDef[] = [askUser];
