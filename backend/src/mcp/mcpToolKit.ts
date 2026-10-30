import type { DieAnnotations, McpCollection } from "shared";
import {
  applyMcpEdit,
  describe,
  findItem,
  McpEditError,
  type McpDieState,
  type McpEdit,
  type McpOwned
} from "./mcpState.js";

/** Shared plumbing for the MCP tool modules (mcpTools.ts, mcpWires.ts). */

export interface McpToolContext {
  dataRoot: string;
  dieId: string;
  clientName: string | null;
  /** Origin of this backend, for tools that reuse its own HTTP routes. */
  baseUrl?: string;
  /** Bearer token of the MCP request, forwarded to those internal routes. */
  authToken?: string | null;
  onAnnotationsChanged?: (dieId: string, rev: number) => void;
}

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface McpToolResult {
  content: McpContent[];
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  run: (ctx: McpToolContext, args: Record<string, unknown>) => Promise<McpToolResult>;
}

/** Thrown for bad tool arguments; reported to the client as a tool error. */
export class ToolInputError extends Error {}

// ─── Argument helpers ───────────────────────────────────────────────

export function num(args: Record<string, unknown>, key: string): number;
export function num(args: Record<string, unknown>, key: string, optional: true): number | undefined;
export function num(args: Record<string, unknown>, key: string, optional?: true): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    if (optional) return undefined;
    throw new ToolInputError(`"${key}" is required`);
  }
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ToolInputError(`"${key}" must be a number`);
  return value;
}

export function str(args: Record<string, unknown>, key: string): string;
export function str(args: Record<string, unknown>, key: string, optional: true): string | undefined;
export function str(args: Record<string, unknown>, key: string, optional?: true): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    if (optional) return undefined;
    throw new ToolInputError(`"${key}" is required`);
  }
  if (typeof value !== "string") throw new ToolInputError(`"${key}" must be a string`);
  return value;
}

export function nonEmpty(value: string, key: string): string {
  if (!value.trim()) throw new ToolInputError(`"${key}" must not be empty`);
  return value;
}

export function clip(text: string, max = 40): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export const point = { type: "number", description: "Die image pixel coordinate (full resolution)" };

// ─── Results ────────────────────────────────────────────────────────

export function textResult(value: unknown): McpToolResult {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] };
}

export function errorResult(message: string): McpToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

// ─── Write gating ───────────────────────────────────────────────────

export function authorName(ctx: McpToolContext): string {
  return ctx.clientName ? `MCP · ${ctx.clientName}` : "MCP";
}

/** "create" / "edit": the markup mode; "wires": the separate wire toggle;
 *  "full": the full-edit toggle, which also satisfies every other gate. */
export type WriteGate = "create" | "edit" | "wires" | "full";

export function requireGate(state: McpDieState, gate: WriteGate): void {
  if (state.full) return;
  if (gate === "full") {
    throw new McpEditError(
      "Full MCP edits are off for this die. A user can enable \"Full edits\" in the die viewer's MCP panel."
    );
  }
  if (gate === "wires") {
    if (!state.wires) {
      throw new McpEditError(
        "MCP wire edits are off for this die. A user can enable \"Allow wire edits\" in the die viewer's MCP panel."
      );
    }
    return;
  }
  if (state.mode === "off") {
    throw new McpEditError(
      "MCP write access is off for this die. A user can enable it in the die viewer's MCP panel."
    );
  }
  if (gate === "edit" && state.mode !== "edit") {
    throw new McpEditError(
      "This die only allows MCP to create new markup, not to modify or delete it. A user can switch the MCP panel to \"Create + edit own\"."
    );
  }
}

/** Whether MCP may change `id`: it created it, or full edits are on. */
export function isMine(state: McpDieState, owned: keyof McpOwned, id: string): boolean {
  return state.full || state.owned[owned].includes(id);
}

export function requireOwned<T>(
  annotations: DieAnnotations,
  state: McpDieState,
  collection: McpCollection & keyof McpOwned,
  id: string
): T {
  const item = findItem<T>(annotations, collection, id);
  if (!item) throw new McpEditError(`No ${describe(collection)} with id ${id}`, 404);
  if (!isMine(state, collection, id)) {
    throw new McpEditError(`${cap(describe(collection))} ${id} was not created by MCP; it is read-only.`, 403);
  }
  return item;
}

export const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export function assertOnDie(annotationsDie: { width: number; height: number }, pts: { x: number; y: number }[]): void {
  for (const p of pts) {
    if (p.x < 0 || p.y < 0 || p.x > annotationsDie.width || p.y > annotationsDie.height) {
      throw new ToolInputError(
        `Point (${p.x}, ${p.y}) is outside the die image (0..${annotationsDie.width}, 0..${annotationsDie.height})`
      );
    }
  }
}

export async function write(
  ctx: McpToolContext,
  gate: WriteGate,
  build: (annotations: DieAnnotations, state: McpDieState) => McpEdit
): Promise<McpToolResult> {
  const { rev, result } = await applyMcpEdit(ctx.dataRoot, ctx.dieId, ctx.clientName, (annotations, state) => {
    requireGate(state, gate);
    return build(annotations, state);
  });
  ctx.onAnnotationsChanged?.(ctx.dieId, rev);
  return textResult({ ok: true, rev, ...result });
}
