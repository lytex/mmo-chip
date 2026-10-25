import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { McpAccessEntry, McpStatus, McpWriteMode } from "shared";
import { requireAuth } from "../auth/middleware.js";
import { listDieRecords, readDieRecord } from "../store.js";
import { commentImagePath } from "../mcp/commentImages.js";
import {
  getDieAccess,
  listDieAccess,
  requestDieAccess,
  setDieAccess,
  waitForDecision
} from "../mcp/mcpAccess.js";
import { callMcpTool, listMcpTools, type McpToolResult } from "../mcp/mcpTools.js";
import {
  historyItem,
  McpEditError,
  readMcpState,
  setMcpSettings,
  stepMcpHistory
} from "../mcp/mcpState.js";

/**
 * MCP (Model Context Protocol) access to the dies.
 *
 *   POST /mcp                        Streamable HTTP transport (JSON responses
 *                                    only, no server-initiated SSE stream) for
 *                                    every die: each tool takes a `dieId`
 *   GET  /api/mcp/access             access entries of all dies (GUI prompt)
 *   PUT  /api/mcp/access/:dieId      { state: "approved" | "denied" }
 *   GET  /api/dies/:dieId/mcp        status for the GUI's MCP panel
 *   PUT  /api/dies/:dieId/mcp/settings { mode?: "off" | "create" | "edit", wires?: boolean, full?: boolean }
 *   GET  /api/dies/:dieId/comment-images/:file   images attached to comments
 *                                    (public like the other GET /api/dies/*
 *                                    image routes, so <img> can load them)
 *   POST /api/dies/:dieId/mcp/undo   undo / redo the newest MCP change
 *   POST /api/dies/:dieId/mcp/redo
 *
 * The MCP endpoint sits outside /api (so it isn't caught by the public
 * GET /api/dies/* exemption) and requires the same Bearer JWT as the API when
 * auth is enabled.
 *
 * The endpoint only touches a die a user approved (mcpAccess.ts): the first
 * call on a die nobody decided on yet marks it pending, the GUI shows a prompt
 * and the call waits up to `approvalWaitMs` for the answer.
 */

const SERVER_NAME = "mmo-chip";
const SERVER_VERSION = "0.1.0";
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MCP_MODES: McpWriteMode[] = ["off", "create", "edit"];

const INSTRUCTIONS =
  "This server exposes the chip dies of mmo-chip, a tool for reverse engineering integrated circuits " +
  "from die photos. Call list_dies first; every other tool takes the `dieId` of the die to work on. " +
  "A user must approve MCP access to each die once: the first call on a new die waits for that " +
  "approval in the mmo-chip GUI, and a die marked denied stays off limits — ask the user if you need it. " +
  "Coordinates are full-resolution die image pixels (origin top-left). Per die, start with " +
  "get_die_info, look at the die with get_die_image (zoom in with a region), and read the extracted " +
  "circuit with get_annotations (find_wires_near gives exact wire ids around a point). Everything is " +
  "read-only except, when a user enabled it for that die: markup (comments, floorplan regions, rulers) " +
  "and, behind a separate switch, wires and vias — or everything with full edits. get_die_info says " +
  "what is currently allowed. render_annotated_image draws the layout with annotations, highlights and " +
  "your own marks; attach such a render to a comment with add_comment's `image` to show people what you mean.\n\n" +
  "How to present findings: write like Ken Shirriff's die-photo teardowns on righto.com — a readable, " +
  "ELI5 article, not a data dump. Start with the big picture (what the chip or block does and why it " +
  "matters), then walk through the circuit step by step, explaining every term the first time it shows up " +
  "(what a transistor, a current mirror or a diffusion layer is and how to spot one in the photo). " +
  "Interleave prose with pictures: after each idea, show it. Use render_annotated_image with highlights " +
  "and your own boxes, arrows and short labels to make one figure per point, each with a caption that says " +
  "what to look at; zoom from the whole die down to the detail you are explaining. Add schematic or " +
  "block diagrams (SVG, Mermaid or similar) that map the layout to the circuit, and label them with the " +
  "same names used in the photos. If your client can produce a document, page or artifact, deliver the " +
  "write-up there as one illustrated article; otherwise use Markdown with the images inline. " +
  "Pixel coordinates are for tool calls only — never put them in your answer. People cannot read " +
  "\"(1234, 567)\"; point at things with the labels and arrows in your figures and with landmarks " +
  "(\"the large transistor below the top-left bond pad\", \"the comparator in the middle of the die\"). " +
  "When you can write markup, pin your figures to the die with add_comment so readers can jump to the spot.";

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** clientInfo.name per session, for attribution in the undo history. */
const sessionClients = new Map<string, string | null>();
const MAX_SESSIONS = 500;

const DEFAULT_APPROVAL_WAIT_MS = 50_000;

const DIE_ID_PROPERTY = {
  type: "string",
  description: "Id of the die to work on (see list_dies)."
};

const LIST_DIES_TOOL = {
  name: "list_dies",
  title: "List dies",
  description:
    "All dies in this mmo-chip instance: id, name, image size and whether MCP may use it " +
    "(access: approved, pending, denied, or not_requested — the first call on such a die asks the user).",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true }
};

interface RouterConfig {
  dataRoot: string;
  onAnnotationsChanged?: (dieId: string, rev: number) => void;
  /** A die's MCP access entry was created or changed. */
  onAccessChanged?: () => void;
  /** How long a call on a pending die waits for the user's decision. */
  approvalWaitMs?: number;
}

interface CallContext {
  config: RouterConfig;
  clientName: string | null;
}

export function createMcpRouter(config: RouterConfig) {
  const router = Router();

  // ─── MCP endpoint ────────────────────────────────────────────────

  router.post("/mcp", rejectForeignOrigin, requireAuth, async (request, response) => {
    const body = request.body as JsonRpcMessage | JsonRpcMessage[] | undefined;
    const messages = Array.isArray(body) ? body : body ? [body] : [];
    if (messages.length === 0 || messages.some((m) => !m || typeof m !== "object" || m.jsonrpc !== "2.0")) {
      response.status(400).json(rpcError(null, -32600, "Invalid JSON-RPC request"));
      return;
    }

    let sessionId = request.header("mcp-session-id") ?? null;
    const replies: unknown[] = [];
    for (const message of messages) {
      // Notifications (no id) and client responses need no reply.
      if (message.id === undefined || !message.method) continue;
      if (message.method === "initialize") {
        sessionId = randomUUID();
        const clientInfo = message.params?.clientInfo as { name?: unknown } | undefined;
        rememberClient(sessionId, typeof clientInfo?.name === "string" ? clientInfo.name : null);
      }
      replies.push(
        await handle(message, {
          config,
          clientName: sessionId ? sessionClients.get(sessionId) ?? null : null
        })
      );
    }

    if (sessionId) response.setHeader("Mcp-Session-Id", sessionId);
    if (replies.length === 0) {
      response.status(202).end();
      return;
    }
    response.json(Array.isArray(body) ? replies : replies[0]);
  });

  // No server-initiated stream and no session teardown to do.
  router.get("/mcp", (_request, response) => {
    response.status(405).set("Allow", "POST").end();
  });
  router.delete("/mcp", (_request, response) => {
    response.status(405).set("Allow", "POST").end();
  });

  // ─── GUI: per-die access approval ────────────────────────────────

  router.get("/api/mcp/access", async (_request, response, next) => {
    try {
      const access = await listDieAccess(config.dataRoot);
      const records = await listDieRecords(config.dataRoot);
      const dies: McpAccessEntry[] = records
        .filter((record) => access[record.id])
        .map((record) => ({ dieId: record.id, dieName: record.name, ...access[record.id] }));
      response.json({ endpointPath: "/mcp", dies });
    } catch (error) {
      next(error);
    }
  });

  router.put("/api/mcp/access/:dieId", async (request, response, next) => {
    try {
      const { dieId } = request.params;
      const { state } = (request.body ?? {}) as { state?: unknown };
      if (state !== "approved" && state !== "denied") {
        response.status(400).json({ error: "state must be approved or denied" });
        return;
      }
      await readDieRecord(config.dataRoot, dieId);
      const access = await setDieAccess(config.dataRoot, dieId, state);
      config.onAccessChanged?.();
      response.json({ ok: true, access });
    } catch (error) {
      next(error);
    }
  });

  // ─── GUI: status, mode, undo / redo ──────────────────────────────

  router.get("/api/dies/:dieId/mcp", async (request, response, next) => {
    try {
      const { dieId } = request.params;
      await readDieRecord(config.dataRoot, dieId);
      const state = await readMcpState(config.dataRoot, dieId);
      const status: McpStatus = {
        mode: state.mode,
        wires: state.wires,
        full: state.full,
        endpointPath: "/mcp",
        access: await getDieAccess(config.dataRoot, dieId),
        undo: state.undo.map(historyItem),
        redo: state.redo.map(historyItem)
      };
      response.json(status);
    } catch (error) {
      next(error);
    }
  });

  router.put("/api/dies/:dieId/mcp/settings", async (request, response, next) => {
    try {
      const { mode, wires, full } = (request.body ?? {}) as { mode?: unknown; wires?: unknown; full?: unknown };
      if (mode !== undefined && !MCP_MODES.includes(mode as McpWriteMode)) {
        response.status(400).json({ error: `mode must be one of ${MCP_MODES.join(", ")}` });
        return;
      }
      if ((wires !== undefined && typeof wires !== "boolean") || (full !== undefined && typeof full !== "boolean")) {
        response.status(400).json({ error: "wires and full must be booleans" });
        return;
      }
      await setMcpSettings(config.dataRoot, request.params.dieId, {
        mode: mode as McpWriteMode | undefined,
        wires,
        full
      });
      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/dies/:dieId/comment-images/:file", async (request, response, next) => {
    try {
      const file = await commentImagePath(config.dataRoot, request.params.dieId, request.params.file);
      if (!file) {
        response.status(404).json({ error: "Not found" });
        return;
      }
      response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      response.sendFile(file);
    } catch (error) {
      next(error);
    }
  });

  for (const direction of ["undo", "redo"] as const) {
    router.post(`/api/dies/:dieId/mcp/${direction}`, async (request, response, next) => {
      const { dieId } = request.params;
      try {
        const { rev, entry } = await stepMcpHistory(config.dataRoot, dieId, direction);
        config.onAnnotationsChanged?.(dieId, rev);
        response.json({ ok: true, rev, entry });
      } catch (error) {
        if (error instanceof McpEditError) {
          response.status(error.status).json({ error: error.message });
          return;
        }
        next(error);
      }
    });
  }

  return router;
}

async function handle(message: JsonRpcMessage, ctx: CallContext): Promise<unknown> {
  const id = message.id ?? null;
  const params = message.params ?? {};
  switch (message.method) {
    case "initialize": {
      const requested = params.protocolVersion;
      const protocolVersion =
        typeof requested === "string" && PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: SERVER_NAME,
          title: "mmo-chip",
          version: SERVER_VERSION
        },
        instructions: INSTRUCTIONS
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, {
        tools: [LIST_DIES_TOOL, ...listMcpTools().map(withDieIdArgument)]
      });
    case "tools/call": {
      const name = params.name;
      const args = params.arguments ?? {};
      if (typeof name !== "string" || typeof args !== "object" || Array.isArray(args)) {
        return rpcError(id, -32602, "tools/call needs a tool name and an arguments object");
      }
      try {
        const result = await callTool(ctx, name, args as Record<string, unknown>);
        return result ? rpcResult(id, result) : rpcError(id, -32602, `Unknown tool: ${name}`);
      } catch (error) {
        // Unexpected failures are still tool results, so the model can see them.
        console.error(`[mcp] ${name} failed:`, error);
        const reason = error instanceof Error ? error.message : String(error);
        return rpcResult(id, { content: [{ type: "text", text: `Tool failed: ${reason}` }], isError: true });
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${message.method}`);
  }
}

/** Resolve the die from the `dieId` argument, check access, run the tool. */
async function callTool(
  ctx: CallContext,
  name: string,
  args: Record<string, unknown>
): Promise<McpToolResult | null> {
  const { config } = ctx;
  if (name === "list_dies") return listDies(config.dataRoot);
  if (!listMcpTools().some((tool) => tool.name === name)) return null;

  const { dieId, ...toolArgs } = args;
  if (typeof dieId !== "string" || !dieId) {
    return toolError(`"dieId" is required: the id of the die to work on (see list_dies).`);
  }
  try {
    await readDieRecord(config.dataRoot, dieId);
  } catch {
    return toolError(`Unknown die ${dieId}. list_dies shows the available dies.`);
  }

  const denied = await checkAccess(ctx, dieId);
  if (denied) return toolError(denied);
  return callMcpTool(
    {
      dataRoot: config.dataRoot,
      dieId,
      clientName: ctx.clientName,
      onAnnotationsChanged: config.onAnnotationsChanged
    },
    name,
    toolArgs
  );
}

/** null when MCP may use the die, else why not (asking the user first if needed). */
async function checkAccess(ctx: CallContext, dieId: string): Promise<string | null> {
  const { config } = ctx;
  const { access, created } = await requestDieAccess(config.dataRoot, dieId, ctx.clientName);
  if (created) config.onAccessChanged?.();
  let state = access.state;
  if (state === "pending") {
    const decided = await waitForDecision(config.dataRoot, dieId, config.approvalWaitMs ?? DEFAULT_APPROVAL_WAIT_MS);
    state = decided?.state ?? "pending";
  }
  if (state === "approved") return null;
  const name = await readDieRecord(config.dataRoot, dieId).then((r) => r.name, () => dieId);
  if (state === "denied") {
    return `A user denied MCP access to die "${name}" (${dieId}). Only they can change that, in the die's MCP tab.`;
  }
  return (
    `MCP access to die "${name}" (${dieId}) is waiting for a user's approval in the mmo-chip GUI. ` +
    `Ask the user to approve it (prompt in the app, or the die viewer's MCP tab), then call again.`
  );
}

async function listDies(dataRoot: string): Promise<McpToolResult> {
  const records = await listDieRecords(dataRoot);
  const access = await listDieAccess(dataRoot);
  const dies = records.map((record) => ({
    dieId: record.id,
    name: record.name,
    width: record.width,
    height: record.height,
    access: access[record.id]?.state ?? "not_requested"
  }));
  return { content: [{ type: "text", text: JSON.stringify({ dies }) }] };
}

function withDieIdArgument<T extends { inputSchema: Record<string, unknown> }>(tool: T): T {
  const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
  return {
    ...tool,
    inputSchema: {
      ...schema,
      properties: { dieId: DIE_ID_PROPERTY, ...(schema.properties ?? {}) },
      required: ["dieId", ...(schema.required ?? [])]
    }
  };
}

function toolError(text: string): McpToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function rpcResult(id: string | number | null, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function rememberClient(sessionId: string, name: string | null): void {
  sessionClients.set(sessionId, name);
  if (sessionClients.size > MAX_SESSIONS) {
    const oldest = sessionClients.keys().next().value;
    if (oldest !== undefined) sessionClients.delete(oldest);
  }
}

/**
 * DNS-rebinding guard required by the MCP spec: a browser page from another
 * site must not be able to drive the endpoint. Native MCP clients send no
 * Origin; a browser one must come from a loopback host.
 */
function rejectForeignOrigin(request: Request, response: Response, next: () => void): void {
  const origin = request.header("origin");
  if (origin) {
    let host = "";
    try {
      host = new URL(origin).hostname;
    } catch {
      // unparsable → rejected below
    }
    if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) {
      response.status(403).json(rpcError(null, -32002, "Origin not allowed"));
      return;
    }
  }
  next();
}
