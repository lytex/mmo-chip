import { randomUUID } from "node:crypto";
import type {
  McpPromptAnswerInput,
  McpPromptEvidence,
  McpPromptField,
  McpPromptImage,
  McpPromptResult,
  McpUserPrompt,
  McpUserPromptEntry
} from "shared";

/**
 * Questions an MCP client asks the human through the GUI (`ask_user`).
 *
 * This is the same shape as the die-access approval in `mcpAccess.ts`: the
 * tool call registers a pending prompt, the GUI learns about it over the
 * websocket, the user answers, and the held call resolves. The difference is
 * that a prompt carries content â€” images, a netlist, a stats table â€” and a
 * richer answer than approve/deny.
 *
 * Prompts live in memory only. That is deliberate: the thing being waited on
 * is an HTTP request, so if the process restarts the caller is gone too. A
 * GUI reload, on the other hand, loses nothing â€” the prompt is still in this
 * map and the list endpoint hands it back.
 */

/** A client that fires prompts in a loop must not stack modals forever. */
const MAX_PENDING = 24;

/** The answer does not fit the prompt (unknown option, missing field, …). */
export class PromptAnswerError extends Error {}

interface Pending {
  prompt: McpUserPrompt;
  /** Parallel to `prompt.evidence.images`, already data URLs. */
  images: McpPromptImage[];
  createdAt: number;
  resolve: (result: McpPromptResult) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, Pending>();

/** Set by the app once: fans prompt changes out over the websocket. */
let changeHandler: (() => void) | null = null;

export function setPromptChangeHandler(handler: (() => void) | null): void {
  changeHandler = handler;
}

function emitChange(): void {
  changeHandler?.();
}

export function listPendingPrompts(): McpUserPromptEntry[] {
  return [...pending.values()]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((entry) => ({
      dieId: entry.prompt.dieId,
      dieName: entry.prompt.dieName,
      prompt: entry.prompt
    }));
}

export function pendingPromptCount(dieId?: string): number {
  if (!dieId) return pending.size;
  let count = 0;
  for (const entry of pending.values()) if (entry.prompt.dieId === dieId) count++;
  return count;
}

function fieldDefaults(fields: McpPromptField[] | undefined): Record<string, string | number | boolean> {
  const values: Record<string, string | number | boolean> = {};
  for (const field of fields ?? []) {
    if (field.default !== undefined) values[field.id] = field.default;
  }
  return values;
}

function settle(entry: Pending, result: McpPromptResult): void {
  clearTimeout(entry.timer);
  if (pending.delete(entry.prompt.id)) emitChange();
  entry.resolve(result);
}

function baseResult(entry: Pending, patch: Partial<McpPromptResult>): McpPromptResult {
  return {
    promptId: entry.prompt.id,
    answered: false,
    optionId: null,
    optionIds: [],
    labels: [],
    text: null,
    fields: fieldDefaults(entry.prompt.fields),
    approved: null,
    answeredBy: null,
    answeredAt: null,
    elapsedMs: Date.now() - entry.createdAt,
    ...(entry.prompt.proposal !== undefined ? { proposal: entry.prompt.proposal } : {}),
    ...patch
  };
}

export interface CreatePromptParams {
  dieId: string;
  dieName: string;
  clientName: string | null;
  question: string;
  detail?: string;
  kind: McpUserPrompt["kind"];
  options: McpUserPrompt["options"];
  fields?: McpPromptField[];
  allowFreeText: boolean;
  multiSelect: boolean;
  evidence?: Omit<McpPromptEvidence, "images"> & { images?: Array<Omit<McpPromptImage, "index">> };
  proposal?: unknown;
  timeoutMs: number;
}

/**
 * Register a prompt and hold until it is answered / dismissed / times out.
 * `images` become indexed data URLs on the prompt itself.
 */
export function createPrompt(params: CreatePromptParams): {
  prompt: McpUserPrompt;
  done: Promise<McpPromptResult>;
} {
  if (pending.size >= MAX_PENDING) {
    throw new Error(
      `${pending.size} questions are already waiting for the user in the mmo-chip GUI; ` +
        `answer or dismiss them before asking another (or raise MAX_PENDING).`
    );
  }
  const id = randomUUID();
  const images: McpPromptImage[] = (params.evidence?.images ?? []).map((image, index) => ({
    index,
    ...image
  }));
  const createdAt = Date.now();
  const prompt: McpUserPrompt = {
    id,
    dieId: params.dieId,
    dieName: params.dieName,
    clientName: params.clientName,
    createdAt: new Date(createdAt).toISOString(),
    expiresAt: new Date(createdAt + params.timeoutMs).toISOString(),
    question: params.question,
    ...(params.detail ? { detail: params.detail } : {}),
    kind: params.kind,
    options: params.options,
    ...(params.fields && params.fields.length > 0 ? { fields: params.fields } : {}),
    allowFreeText: params.allowFreeText,
    multiSelect: params.multiSelect,
    ...(params.evidence
      ? {
          evidence: {
            ...(images.length > 0 ? { images } : {}),
            ...(params.evidence.netlist ? { netlist: params.evidence.netlist } : {}),
            ...(params.evidence.stats ? { stats: params.evidence.stats } : {}),
            ...(params.evidence.notes && params.evidence.notes.length > 0 ? { notes: params.evidence.notes } : {})
          }
        }
      : {}),
    ...(params.proposal !== undefined ? { proposal: params.proposal } : {})
  };

  let entry!: Pending;
  const done = new Promise<McpPromptResult>((resolve) => {
    const timer = setTimeout(() => {
      settle(entry, baseResult(entry, { answered: false, reason: "timeout" }));
    }, params.timeoutMs);
    entry = { prompt, images, createdAt, resolve, timer };
  });
  pending.set(id, entry);
  emitChange();
  return { prompt, done };
}

function findOption(prompt: McpUserPrompt, optionId: string) {
  return prompt.options.find((option) => option.id === optionId);
}

/** Apply a user's answer. Returns the result, or null for an unknown id. */
export function answerPrompt(
  id: string,
  input: McpPromptAnswerInput,
  answeredBy: string | null
): McpPromptResult | null {
  const entry = pending.get(id);
  if (!entry) return null;
  const { prompt } = entry;

  const wanted = [
    ...(Array.isArray(input.optionIds) ? input.optionIds : []),
    ...(input.optionId ? [input.optionId] : [])
  ];
  const unique = [...new Set(wanted)];
  const unknown = unique.filter((optionId) => !findOption(prompt, optionId));
  if (unknown.length > 0) {
    throw new PromptAnswerError(`No such option: ${unknown.join(", ")}`);
  }
  if (unique.length > 1 && !prompt.multiSelect) {
    throw new PromptAnswerError(`This prompt takes a single option, got ${unique.join(", ")}`);
  }

  const options = unique
    .map((optionId) => findOption(prompt, optionId))
    .filter((option): option is NonNullable<typeof option> => option !== undefined);
  const text = typeof input.text === "string" && input.text.trim() ? input.text : null;
  if (options.length === 0 && !text && !input.fields) {
    throw new PromptAnswerError(`An answer needs an option, text or fields`);
  }

  const fields = { ...fieldDefaults(prompt.fields), ...(input.fields ?? {}) };
  for (const field of prompt.fields ?? []) {
    if (field.required && (fields[field.id] === undefined || fields[field.id] === "")) {
      throw new PromptAnswerError(`"${field.label}" is required`);
    }
  }

  // A single chosen option decides approval; "choose + free text" does not.
  const approvalOption = options.length === 1 ? options[0] : undefined;
  const approved =
    approvalOption?.role === "approve" ? true : approvalOption?.role === "reject" ? false : null;

  const result = baseResult(entry, {
    answered: true,
    optionId: options[0]?.id ?? null,
    optionIds: options.map((option) => option.id),
    labels: options.map((option) => option.label),
    text,
    fields,
    approved,
    answeredBy,
    answeredAt: new Date().toISOString()
  });

  // "Cancel" is a dismissal, not an answer â€” the client should stop and ask
  // again later rather than treating it as a decision.
  if (approvalOption?.role === "cancel") {
    settle(entry, { ...result, answered: false, reason: "cancelled" });
    return { ...result, answered: false, reason: "cancelled" };
  }
  settle(entry, result);
  return result;
}

/** Dismissed from the GUI (Escape / close button). */
export function cancelPrompt(id: string, by: string | null): McpPromptResult | null {
  const entry = pending.get(id);
  if (!entry) return null;
  const result = baseResult(entry, {
    answered: false,
    reason: "cancelled",
    answeredBy: by,
    answeredAt: new Date().toISOString()
  });
  settle(entry, result);
  return result;
}

/** Resolve every prompt of a die (used when a die is closed / access denied). */
export function cancelPromptsForDie(dieId: string, by: string | null): number {
  let cancelled = 0;
  for (const entry of [...pending.values()]) {
    if (entry.prompt.dieId !== dieId) continue;
    cancelPrompt(entry.prompt.id, by);
    cancelled++;
  }
  return cancelled;
}

/** Test hook: drop everything without resolving (the callers are gone). */
export function clearPromptsForTests(): void {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  pending.clear();
}
