import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { CellDetectionJob, CellImagingJob, MLInferenceJob } from "shared";
import type { QueryClient } from "@tanstack/react-query";
import { annotationKeys } from "./annotations";
import { dieKeys } from "./dies";
import { getAuthToken } from "../state/auth";
import { useOnlineUsers, type OnlineUser } from "../state/onlineUsers";

// ── Connection (shared singleton) ────────────────────────────────────
//
// One WebSocket per page is plenty. `subscribeToDie` counts subscribers
// per die and reconnects on demand; when the last subscriber unmounts we
// close the socket so dev refreshes don't leak connections.

export type DieSocketMessage =
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

type MessageHandler = (msg: DieSocketMessage) => void;

interface Connection {
  socket: WebSocket;
  subscribers: Set<MessageHandler>;
  /** Per-die subscriber refcount — a die stays subscribed on the wire while
   *  any consumer (annotations, ML job, …) still wants it. */
  dieRefs: Map<string, number>;
  /** Refcount of consumers asking for this connection to stay alive. */
  refcount: number;
}

let active: Connection | null = null;
let reconnectTimer: number | null = null;

function buildUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const token = getAuthToken();
  if (token) {
    return `${proto}//${window.location.host}/api/ws?token=${encodeURIComponent(token)}`;
  }
  return `${proto}//${window.location.host}/api/ws`;
}

function connect(): Connection {
  const socket = new WebSocket(buildUrl());
  const conn: Connection = {
    socket,
    subscribers: new Set(),
    dieRefs: new Map(),
    refcount: 0
  };

  socket.addEventListener("open", () => {
    // Resubscribe to any dies that were requested before the socket opened.
    for (const dieId of conn.dieRefs.keys()) {
      socket.send(JSON.stringify({ type: "subscribe", dieId }));
    }
  });

  socket.addEventListener("message", (event) => {
    let msg: DieSocketMessage;
    try {
      msg = JSON.parse(event.data) as DieSocketMessage;
    } catch {
      return;
    }
    for (const cb of conn.subscribers) cb(msg);
  });

  const scheduleReconnect = () => {
    if (active !== conn) return; // a newer connection already took over
    active = null;
    if (conn.refcount === 0) return;
    if (reconnectTimer !== null) return;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      const next = connect();
      next.refcount = conn.refcount;
      next.subscribers = conn.subscribers;
      next.dieRefs = conn.dieRefs;
      active = next;
    }, 1000);
  };

  socket.addEventListener("close", scheduleReconnect);
  socket.addEventListener("error", () => {
    try {
      socket.close();
    } catch {
      // ignore
    }
  });

  return conn;
}

function ensureConnection(): Connection {
  if (!active) active = connect();
  return active;
}

function sendJson(conn: Connection, payload: unknown) {
  if (conn.socket.readyState !== WebSocket.OPEN) return;
  conn.socket.send(JSON.stringify(payload));
}

/**
 * Subscribe to realtime messages for a die. The handler receives every
 * message (annotations + ML job); callers filter by `type`/`dieId`. Returns
 * an unsubscribe function. Multiple consumers may subscribe to the same die
 * — the wire subscription is refcounted so one unmount doesn't silence the
 * others.
 */
export function subscribeToDie(
  dieId: string,
  handler: MessageHandler
): () => void {
  const conn = ensureConnection();
  conn.refcount += 1;
  conn.subscribers.add(handler);

  const prev = conn.dieRefs.get(dieId) ?? 0;
  conn.dieRefs.set(dieId, prev + 1);
  if (prev === 0) sendJson(conn, { type: "subscribe", dieId });

  return () => {
    conn.subscribers.delete(handler);
    const count = (conn.dieRefs.get(dieId) ?? 1) - 1;
    if (count <= 0) {
      conn.dieRefs.delete(dieId);
      sendJson(conn, { type: "unsubscribe", dieId });
    } else {
      conn.dieRefs.set(dieId, count);
    }
    conn.refcount -= 1;
    if (conn.refcount === 0 && active === conn) {
      try {
        conn.socket.close();
      } catch {
        // ignore
      }
      active = null;
    }
  };
}

/**
 * Subscribe to annotation-change events for a die and invalidate the
 * TanStack query whenever the backend reports a newer revision than what's
 * in the cache. Falls back gracefully if the WS disconnects — the next
 * mutation's `invalidateQueries` will sync the cache anyway.
 */
export function useAnnotationsWebSocket(dieId: string | undefined): void {
  const qc = useQueryClient();

  useEffect(() => {
    if (!dieId) return;
    const onAnnotations = annotationInvalidator(qc, dieId);
    return subscribeToDie(dieId, (msg) => {
      // Die properties changed somewhere (every client hears it once, here):
      // the library / scale of this die or of one it shares cells with.
      if (msg.type === "die") void qc.invalidateQueries({ queryKey: dieKeys.all });
      else onAnnotations(msg);
    });
  }, [dieId, qc]);
}

/** `useAnnotationsWebSocket` for a set of other dies — the ones a page's cell
 *  library draws on — minus the die-properties handling. */
export function useAnnotationsWebSocketMany(dieIds: readonly string[]): void {
  const qc = useQueryClient();
  const key = dieIds.join(",");
  useEffect(() => {
    if (!key) return;
    const unsubs = key.split(",").map((id) => subscribeToDie(id, annotationInvalidator(qc, id)));
    return () => unsubs.forEach((u) => u());
  }, [key, qc]);
}

function annotationInvalidator(qc: QueryClient, dieId: string): MessageHandler {
  return (msg) => {
    if (msg.type !== "annotations" || msg.dieId !== dieId) return;
    const current = qc.getQueryData<{ rev?: number }>(annotationKeys.forDie(dieId));
    if (current && typeof current.rev === "number" && current.rev >= msg.rev) {
      // We already have this revision or newer — likely our own mutation.
      return;
    }
    void qc.invalidateQueries({ queryKey: annotationKeys.forDie(dieId) });
  };
}

/**
 * Subscribe to ALL WebSocket messages (not filtered by die). Returns an
 * unsubscribe function. Used for global messages (presence, etc.).
 */
export function subscribeGlobal(
  handler: (msg: DieSocketMessage) => void
): () => void {
  const conn = ensureConnection();
  conn.refcount += 1;
  conn.subscribers.add(handler);

  return () => {
    conn.subscribers.delete(handler);
    conn.refcount -= 1;
    if (conn.refcount === 0 && active === conn) {
      try {
        conn.socket.close();
      } catch {
        // ignore
      }
      active = null;
    }
  };
}

/** Send a status update to the server (what die/tool the user is on). */
export function sendStatus(dieId: string | null, tool: string | null): void {
  const conn = active;
  if (!conn) return;
  sendJson(conn, { type: "status", dieId, tool });
}

/**
 * Subscribe to user presence events (online/offline/status) on the shared
 * WebSocket. Returns an unsubscribe function. Call once at app init.
 */
export function subscribePresence(): () => void {
  return subscribeGlobal((msg) => {
    if (msg.type === "user/list") {
      const users: OnlineUser[] = msg.users.map((u) => ({
        userId: u.userId,
        username: u.username,
        dieId: u.dieId,
        tool: u.tool
      }));
      useOnlineUsers.getState().setUsers(users);
    } else if (msg.type === "user/online") {
      const user: OnlineUser = {
        userId: msg.userId,
        username: msg.username,
        dieId: msg.dieId,
        tool: msg.tool
      };
      useOnlineUsers.getState().addUser(user);
    } else if (msg.type === "user/offline") {
      useOnlineUsers.getState().removeUser(msg.userId);
    } else if (msg.type === "user/status") {
      useOnlineUsers.getState().updateUser(msg.userId, msg.dieId, msg.tool);
    }
  });
}

/** React hook version of subscribePresence. */
export function usePresenceWebSocket(): void {
  useEffect(() => subscribePresence(), []);
}
