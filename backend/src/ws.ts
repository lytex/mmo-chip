import type { Server as HttpServer } from "node:http";
import type { CellDetectionJob, CellImagingJob, MLInferenceJob } from "shared";
import { WebSocketServer, type WebSocket } from "ws";
import type { AuthPayload } from "./types.js";

/**
 * Realtime change broadcaster + presence.
 *
 * Protocol:
 *   client → server :  { "type": "subscribe",   "dieId": "<id>" }
 *                      { "type": "unsubscribe", "dieId": "<id>" }
 *                      { "type": "status",      "dieId": "<id>|null", "tool": "<tool>|null" }
 *                      { "type": "ping" }
 *   server → client :  { "type": "annotations", "dieId": "<id>", "rev": <number> }
 *                      { "type": "mlJob",       "dieId": "<id>", "job": <MLInferenceJob> }
 *                      { "type": "cellJob",     "dieId": "<id>", "job": <CellDetectionJob> }
 *                      { "type": "imagingJob",  "dieId": "<id>", "job": <CellImagingJob> }
 *                      { "type": "user/online",  "userId": "<id>", "username": "<name>",
 *                                                          "dieId": "<id>|null", "tool": "<tool>|null" }
 *                      { "type": "user/offline", "userId": "<id>" }
 *                      { "type": "user/status",  "userId": "<id>", "dieId": "<id>|null",
 *                                                          "tool": "<tool>|null" }
 *                      { "type": "mcp/access" }   (any die's MCP access changed)
 *                      { "type": "mcp/prompts" }  (ask_user prompt queue changed)
 *                      { "type": "pong" }
 *
 * Auth: token in query string (`?token=<jwt>`). Invalid token → connection closed.
 */

type ServerMessage =
  | { type: "annotations"; dieId: string; rev: number }
  | { type: "mlJob"; dieId: string; job: MLInferenceJob }
  | { type: "cellJob"; dieId: string; job: CellDetectionJob }
  | { type: "imagingJob"; dieId: string; job: CellImagingJob }
  | { type: "die"; dieId: string }
  | { type: "user/list"; users: Array<{ userId: string; username: string; dieId: string | null; tool: string | null }> }
  | { type: "user/online"; userId: string; username: string; dieId: string | null; tool: string | null }
  | { type: "user/offline"; userId: string }
  | { type: "user/status"; userId: string; dieId: string | null; tool: string | null }
  | { type: "mcp/access" }
  | { type: "mcp/prompts" }
  | { type: "pong" };

type ClientMessage =
  | { type: "subscribe"; dieId: string }
  | { type: "unsubscribe"; dieId: string }
  | { type: "status"; dieId: string | null; tool: string | null }
  | { type: "ping" };

interface Subscription {
  socket: WebSocket;
  userId: string;
  username: string;
  dies: Set<string>;
  dieId: string | null;
  tool: string | null;
}

export interface AnnotationBroadcaster {
  /** Notify subscribed clients that a die's annotations advanced to `rev`. */
  emitAnnotationChange(dieId: string, rev: number): void;
  /** Push an ML inference job-state change to subscribed clients. */
  emitMLJob(job: MLInferenceJob): void;
  /** Tell every client that an MCP access request / decision changed. */
  emitMcpAccess(): void;
  /** Tell every client that the pending ask_user prompt queue changed. */
  emitMcpPrompts(): void;
  /** Push a cell-detection job-state change to subscribed clients. */
  emitCellJob(job: CellDetectionJob): void;
  /** Push a cell-imaging (specimens / wire map) job-state change. */
  emitImagingJob(job: CellImagingJob): void;
  /** A die's properties changed (cell library / scale). Sent to every
   *  client, not just the die's subscribers: dies sharing a library draw
   *  each other's cell types, so they all care. */
  emitDieChange(dieId: string): void;
  /** Get current list of online users with their status. */
  getOnlineUsers(): Array<{ userId: string; username: string; dieId: string | null; tool: string | null }>;
  /** Close the server. */
  close(): Promise<void>;
}

export function attachWebSocketBroadcaster(
  httpServer: HttpServer,
  verifyToken: (token: string) => AuthPayload | null,
  authEnabled: boolean
): AnnotationBroadcaster {
  const wss = new WebSocketServer({ server: httpServer, path: "/api/ws" });
  const subscriptions = new Map<WebSocket, Subscription>();

  wss.on("connection", (socket, request) => {
    let authPayload: AuthPayload | null = null;

    if (authEnabled) {
      // Auth: extract token from query string
      const url = request.url ?? "";
      const queryIndex = url.indexOf("?");
      if (queryIndex !== -1) {
        const params = new URLSearchParams(url.slice(queryIndex));
        const token = params.get("token");
        if (token) {
          authPayload = verifyToken(token);
        }
      }

      if (!authPayload) {
        socket.close(4001, "Authentication required");
        return;
      }
    } else {
      // Auth disabled (dev/test mode)
      authPayload = { userId: "dev", username: "dev" };
    }

    const sub: Subscription = {
      socket,
      userId: authPayload.userId,
      username: authPayload.username,
      dies: new Set(),
      dieId: null,
      tool: null
    };
    subscriptions.set(socket, sub);

    // Send current users list to the newly connected client
    const onlineUsers = getOnlineUsersList();
    send(socket, { type: "user/list", users: onlineUsers });

    // Broadcast user online to everyone else (skip self)
    broadcast({
      type: "user/online",
      userId: sub.userId,
      username: sub.username,
      dieId: null,
      tool: null
    }, socket);

    socket.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        return; // ignore malformed
      }
      switch (msg.type) {
        case "subscribe":
          if (typeof msg.dieId === "string") sub.dies.add(msg.dieId);
          return;
        case "unsubscribe":
          if (typeof msg.dieId === "string") sub.dies.delete(msg.dieId);
          return;
        case "status":
          sub.dieId = msg.dieId ?? null;
          sub.tool = msg.tool ?? null;
          broadcast({
            type: "user/status",
            userId: sub.userId,
            dieId: sub.dieId,
            tool: sub.tool
          }, socket);
          return;
        case "ping":
          send(socket, { type: "pong" });
          return;
      }
    });

    socket.on("close", () => {
      subscriptions.delete(socket);
      broadcast({
        type: "user/offline",
        userId: sub.userId
      }, null);
    });
    socket.on("error", () => {
      subscriptions.delete(socket);
      broadcast({
        type: "user/offline",
        userId: sub.userId
      }, null);
    });
  });

  function send(socket: WebSocket, msg: ServerMessage) {
    if (socket.readyState !== socket.OPEN) return;
    try {
      socket.send(JSON.stringify(msg));
    } catch {
      // ignore — closed sockets are cleaned up by the close/error handlers
    }
  }

  /** Get the current list of online users from subscriptions. */
  function getOnlineUsersList() {
    const users: Array<{ userId: string; username: string; dieId: string | null; tool: string | null }> = [];
    for (const sub of subscriptions.values()) {
      users.push({ userId: sub.userId, username: sub.username, dieId: sub.dieId, tool: sub.tool });
    }
    return users;
  }

  /** Broadcast to all sockets, optionally excluding `skip` */
  function broadcast(msg: ServerMessage, skip: WebSocket | null) {
    for (const [socket, _sub] of subscriptions) {
      if (socket === skip) continue;
      send(socket, msg);
    }
  }

  return {
    emitAnnotationChange(dieId, rev) {
      for (const sub of subscriptions.values()) {
        if (!sub.dies.has(dieId)) continue;
        send(sub.socket, { type: "annotations", dieId, rev });
      }
    },
    emitMLJob(job) {
      for (const sub of subscriptions.values()) {
        if (!sub.dies.has(job.dieId)) continue;
        send(sub.socket, { type: "mlJob", dieId: job.dieId, job });
      }
    },
    emitMcpAccess() {
      broadcast({ type: "mcp/access" }, null);
    },
    emitMcpPrompts() {
      broadcast({ type: "mcp/prompts" }, null);
    },
    emitCellJob(job) {
      for (const sub of subscriptions.values()) {
        if (!sub.dies.has(job.dieId)) continue;
        send(sub.socket, { type: "cellJob", dieId: job.dieId, job });
      }
    },
    emitImagingJob(job) {
      for (const sub of subscriptions.values()) {
        if (!sub.dies.has(job.dieId)) continue;
        send(sub.socket, { type: "imagingJob", dieId: job.dieId, job });
      }
    },
    emitDieChange(dieId) {
      for (const sub of subscriptions.values()) send(sub.socket, { type: "die", dieId });
    },
    getOnlineUsers() {
      return getOnlineUsersList();
    },
    async close() {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  };
}
