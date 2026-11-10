import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  AnnotationNet,
  Cell,
  CommentAnnotation,
  CommentReply,
  FloorplanRegion,
  CellLayers,
  CellType,
  DieAnnotations,
  Guide,
  HumanAnnotation,
  IgnoreRect,
  IOPin,
  ROIRectangle,
  ProcessConfig,
  RulerMeasurement as Ruler,
  TraceBlockage,
  TraceRegion
} from "shared";
import type { NetChange } from "../lib/netGraph";
import { flipAnnotations, type CellTypeSizes, type FlipAxis, type ImageSize } from "../lib/imageFlip";
import { annotationKeys, removeById, upsertById } from "./annotations";
import { apiDelete, apiGet, apiPut } from "./client";
import { useDieViewerStore } from "../state/dieViewer";

// ── Action union ─────────────────────────────────────────────────────
//
// Every annotation mutation in the UI is funnelled through this union. Each
// variant carries enough payload to re-apply forward AND compute its inverse
// without consulting current state — `removeAnnotation` carries the full
// entity it deleted so undo can put the same one back.
//
// Adding a new edit kind means three edits in this file:
//   1. add a variant to AnnotationAction
//   2. extend `inverseOf`
//   3. extend `applyAction` (cache transform) and `requestAction` (HTTP)

export type AnnotationAction =
  // Whole-net upsert. `prevNet` is the net's state before this edit (null if
  // it didn't exist), so the inverse is computable without consulting state.
  | { kind: "upsertNet"; net: AnnotationNet; prevNet: AnnotationNet | null }
  | { kind: "removeNet"; net: AnnotationNet }
  // Whole-cell / whole-cell-type upsert. `prev*` is the entity before the edit
  // (null if it didn't exist) so the inverse is computable without state.
  | { kind: "upsertCell"; cell: Cell; prevCell: Cell | null }
  | { kind: "removeCell"; cell: Cell }
  | { kind: "upsertCellType"; cellType: CellType; prevCellType: CellType | null }
  | { kind: "removeCellType"; cellType: CellType }
  | { kind: "addPin"; pin: IOPin }
  | { kind: "removePin"; pin: IOPin }
  // Whole-pin upsert with `prevPin` (null if new) so renames undo cleanly.
  | { kind: "upsertPin"; pin: IOPin; prevPin: IOPin | null }
  // ── ML annotations (schema v2) ─────────────────────────────────────
  // `HumanAnnotation` covers point_via / irregular_via (persisted classes;
  // `trace` is derived from nets, never edited here). ROIs and ignore rects
  // are separate optional collections. All carry `prev*` for clean undo.
  | {
      kind: "upsertAnnotation";
      annotation: HumanAnnotation;
      prevAnnotation: HumanAnnotation | null;
    }
  | { kind: "removeAnnotation"; annotation: HumanAnnotation }
  | { kind: "upsertRoi"; roi: ROIRectangle; prevRoi: ROIRectangle | null }
  | { kind: "removeRoi"; roi: ROIRectangle }
  | { kind: "upsertIgnore"; ignore: IgnoreRect; prevIgnore: IgnoreRect | null }
  | { kind: "removeIgnore"; ignore: IgnoreRect }
  | { kind: "upsertTraceRegion"; region: TraceRegion; prevRegion: TraceRegion | null }
  | { kind: "removeTraceRegion"; region: TraceRegion }
  | { kind: "upsertTraceBlockage"; blockage: TraceBlockage; prevBlockage: TraceBlockage | null }
  | { kind: "removeTraceBlockage"; blockage: TraceBlockage }
  | { kind: "upsertGuide"; guide: Guide; prevGuide: Guide | null }
  | { kind: "removeGuide"; guide: Guide }
  | { kind: "setUmPerPx"; umPerPx: number; prevUmPerPx: number | null }
  /** Die process (silicon layers); null = metals only. */
  | { kind: "setProcess"; process: ProcessConfig | null; prevProcess: ProcessConfig | null }
  | { kind: "upsertRuler"; ruler: Ruler; prevRuler: Ruler | null }
  | { kind: "removeRuler"; ruler: Ruler }
  // ── Analog layers (Phase 1) — stores the entire CellLayers blob
  | { kind: "upsertAnalogLayers"; layers: CellLayers; prevLayers: CellLayers | null }
  // One user gesture that touches several nets atomically (cross-net merge,
  // graph-splitting delete). Applied/persisted in order; undone in reverse.
  // Comments. A reply is its own action (not a whole-comment upsert) so
  // undoing it can't clobber replies other users posted in the meantime.
  | { kind: "upsertComment"; comment: CommentAnnotation; prevComment: CommentAnnotation | null }
  | { kind: "removeComment"; comment: CommentAnnotation }
  | { kind: "addCommentReply"; commentId: string; reply: CommentReply }
  | { kind: "removeCommentReply"; commentId: string; reply: CommentReply }
  // Edit one reply's text in place; undo swaps `reply` and `prevReply`.
  | { kind: "updateCommentReply"; commentId: string; reply: CommentReply; prevReply: CommentReply }
  | { kind: "upsertFloorplan"; region: FloorplanRegion; prevRegion: FloorplanRegion | null }
  | { kind: "removeFloorplan"; region: FloorplanRegion }
  // Part of a gesture that lands on another die: a cell type shared through
  // the cell library lives in — and is written to — the die that owns it.
  // Applied, persisted and undone against that die.
  | { kind: "onDie"; dieId: string; action: AnnotationAction }
  | { kind: "batch"; actions: AnnotationAction[] }
  // Mirror the die image (display-only) and every annotation with it, on one
  // axis. Its own inverse. Carries the image size and the cell type sizes it
  // needs so applying it never depends on other dies' data.
  | { kind: "flipDie"; axis: FlipAxis; size: ImageSize; typeSizes: CellTypeSizes };

export function inverseOf(action: AnnotationAction): AnnotationAction {
  switch (action.kind) {
    case "upsertNet":
      return action.prevNet === null
        ? { kind: "removeNet", net: action.net }
        : { kind: "upsertNet", net: action.prevNet, prevNet: action.net };
    case "removeNet":
      return { kind: "upsertNet", net: action.net, prevNet: null };
    case "upsertCell":
      return action.prevCell === null
        ? { kind: "removeCell", cell: action.cell }
        : { kind: "upsertCell", cell: action.prevCell, prevCell: action.cell };
    case "removeCell":
      return { kind: "upsertCell", cell: action.cell, prevCell: null };
    case "upsertCellType":
      return action.prevCellType === null
        ? { kind: "removeCellType", cellType: action.cellType }
        : {
            kind: "upsertCellType",
            cellType: action.prevCellType,
            prevCellType: action.cellType
          };
    case "removeCellType":
      return { kind: "upsertCellType", cellType: action.cellType, prevCellType: null };
    case "addPin":
      return { kind: "removePin", pin: action.pin };
    case "removePin":
      return { kind: "addPin", pin: action.pin };
    case "upsertPin":
      return action.prevPin === null
        ? { kind: "removePin", pin: action.pin }
        : { kind: "upsertPin", pin: action.prevPin, prevPin: action.pin };
    case "upsertAnnotation":
      return action.prevAnnotation === null
        ? { kind: "removeAnnotation", annotation: action.annotation }
        : {
            kind: "upsertAnnotation",
            annotation: action.prevAnnotation,
            prevAnnotation: action.annotation
          };
    case "removeAnnotation":
      return {
        kind: "upsertAnnotation",
        annotation: action.annotation,
        prevAnnotation: null
      };
    case "upsertRoi":
      return action.prevRoi === null
        ? { kind: "removeRoi", roi: action.roi }
        : { kind: "upsertRoi", roi: action.prevRoi, prevRoi: action.roi };
    case "removeRoi":
      return { kind: "upsertRoi", roi: action.roi, prevRoi: null };
    case "upsertIgnore":
      return action.prevIgnore === null
        ? { kind: "removeIgnore", ignore: action.ignore }
        : {
            kind: "upsertIgnore",
            ignore: action.prevIgnore,
            prevIgnore: action.ignore
          };
    case "removeIgnore":
      return { kind: "upsertIgnore", ignore: action.ignore, prevIgnore: null };
    case "upsertTraceRegion":
      return action.prevRegion === null
        ? { kind: "removeTraceRegion", region: action.region }
        : {
            kind: "upsertTraceRegion",
            region: action.prevRegion,
            prevRegion: action.region
          };
    case "removeTraceRegion":
      return { kind: "upsertTraceRegion", region: action.region, prevRegion: null };
    case "upsertTraceBlockage":
      return action.prevBlockage === null
        ? { kind: "removeTraceBlockage", blockage: action.blockage }
        : {
            kind: "upsertTraceBlockage",
            blockage: action.prevBlockage,
            prevBlockage: action.blockage
          };
    case "removeTraceBlockage":
      return { kind: "upsertTraceBlockage", blockage: action.blockage, prevBlockage: null };
    case "upsertGuide":
      return action.prevGuide === null
        ? { kind: "removeGuide", guide: action.guide }
        : { kind: "upsertGuide", guide: action.prevGuide, prevGuide: action.guide };
    case "removeGuide":
      return { kind: "upsertGuide", guide: action.guide, prevGuide: null };
    case "setProcess":
      return { kind: "setProcess", process: action.prevProcess, prevProcess: action.process };
    case "setUmPerPx":
      return {
        kind: "setUmPerPx",
        umPerPx: action.prevUmPerPx ?? 0,
        prevUmPerPx: action.umPerPx
      };
    case "upsertRuler":
      return action.prevRuler === null
        ? { kind: "removeRuler", ruler: action.ruler }
        : { kind: "upsertRuler", ruler: action.prevRuler, prevRuler: action.ruler };
    case "removeRuler":
      return { kind: "upsertRuler", ruler: action.ruler, prevRuler: null };
    case "upsertComment":
      return action.prevComment === null
        ? { kind: "removeComment", comment: action.comment }
        : { kind: "upsertComment", comment: action.prevComment, prevComment: action.comment };
    case "removeComment":
      return { kind: "upsertComment", comment: action.comment, prevComment: null };
    case "addCommentReply":
      return { kind: "removeCommentReply", commentId: action.commentId, reply: action.reply };
    case "removeCommentReply":
      return { kind: "addCommentReply", commentId: action.commentId, reply: action.reply };
    case "updateCommentReply":
      return { kind: "updateCommentReply", commentId: action.commentId, reply: action.prevReply, prevReply: action.reply };
    case "upsertFloorplan":
      return action.prevRegion === null
        ? { kind: "removeFloorplan", region: action.region }
        : { kind: "upsertFloorplan", region: action.prevRegion, prevRegion: action.region };
    case "removeFloorplan":
      return { kind: "upsertFloorplan", region: action.region, prevRegion: null };
    case "batch":
      return { kind: "batch", actions: [...action.actions].reverse().map(inverseOf) };
    case "onDie":
      return { kind: "onDie", dieId: action.dieId, action: inverseOf(action.action) };
    case "upsertAnalogLayers":
      return { kind: "upsertAnalogLayers", layers: action.prevLayers!, prevLayers: action.layers };
    case "flipDie":
      return action;
  }
}

/**
 * Map net-graph `{ prev, next }` diffs to an action. Returns a single action
 * for one change, a `batch` for several (one undo step), or null for none.
 */
export function netChangesToAction(changes: NetChange[]): AnnotationAction | null {
  const actions: AnnotationAction[] = [];
  for (const c of changes) {
    if (c.next) actions.push({ kind: "upsertNet", net: c.next, prevNet: c.prev });
    else if (c.prev) actions.push({ kind: "removeNet", net: c.prev });
  }
  if (actions.length === 0) return null;
  if (actions.length === 1) return actions[0];
  return { kind: "batch", actions };
}

/** Pure transform: apply an action to a snapshot of the annotations. */
export function applyAction(annotations: DieAnnotations, action: AnnotationAction): DieAnnotations {
  switch (action.kind) {
    case "upsertNet":
      return { ...annotations, nets: upsertById(annotations.nets, action.net) };
    case "removeNet":
      return { ...annotations, nets: removeById(annotations.nets, action.net.id) };
    case "upsertCell":
      return { ...annotations, cells: upsertById(annotations.cells, action.cell) };
    case "removeCell":
      return { ...annotations, cells: removeById(annotations.cells, action.cell.id) };
    case "upsertCellType":
      return {
        ...annotations,
        cellTypes: upsertById(annotations.cellTypes, action.cellType)
      };
    case "removeCellType":
      return {
        ...annotations,
        cellTypes: removeById(annotations.cellTypes, action.cellType.id)
      };
    case "addPin":
      return {
        ...annotations,
        pins: upsertById(annotations.pins ?? [], action.pin)
      };
    case "removePin":
      return {
        ...annotations,
        pins: removeById(annotations.pins ?? [], action.pin.id)
      };
    case "upsertPin":
      return {
        ...annotations,
        pins: upsertById(annotations.pins ?? [], action.pin)
      };
    case "upsertAnnotation":
      return {
        ...annotations,
        annotations: upsertById(annotations.annotations ?? [], action.annotation)
      };
    case "removeAnnotation":
      return {
        ...annotations,
        annotations: removeById(
          annotations.annotations ?? [],
          action.annotation.id
        )
      };
    case "upsertRoi":
      return { ...annotations, rois: upsertById(annotations.rois ?? [], action.roi) };
    case "removeRoi":
      return { ...annotations, rois: removeById(annotations.rois ?? [], action.roi.id) };
    case "upsertIgnore":
      return {
        ...annotations,
        ignores: upsertById(annotations.ignores ?? [], action.ignore)
      };
    case "removeIgnore":
      return {
        ...annotations,
        ignores: removeById(annotations.ignores ?? [], action.ignore.id)
      };
    case "upsertTraceRegion":
      return {
        ...annotations,
        traceRegions: upsertById(annotations.traceRegions ?? [], action.region)
      };
    case "removeTraceRegion":
      return {
        ...annotations,
        traceRegions: removeById(annotations.traceRegions ?? [], action.region.id)
      };
    case "upsertTraceBlockage":
      return {
        ...annotations,
        traceBlockages: upsertById(annotations.traceBlockages ?? [], action.blockage)
      };
    case "removeTraceBlockage":
      return {
        ...annotations,
        traceBlockages: removeById(annotations.traceBlockages ?? [], action.blockage.id)
      };
    case "upsertGuide":
      return {
        ...annotations,
        guides: upsertById(annotations.guides ?? [], action.guide)
      };
    case "removeGuide":
      return {
        ...annotations,
        guides: removeById(annotations.guides ?? [], action.guide.id)
      };
    case "setUmPerPx":
      return { ...annotations, umPerPx: action.umPerPx };
    case "setProcess": {
      if (action.process) return { ...annotations, process: action.process };
      const { process: _process, ...rest } = annotations;
      return rest;
    }
    case "upsertRuler":
      return {
        ...annotations,
        rulers: upsertById(annotations.rulers ?? [], action.ruler)
      };
    case "removeRuler":
      return {
        ...annotations,
        rulers: removeById(annotations.rulers ?? [], action.ruler.id)
      };
    case "upsertComment":
      return {
        ...annotations,
        comments: upsertById(annotations.comments ?? [], action.comment)
      };
    case "removeComment":
      return {
        ...annotations,
        comments: removeById(annotations.comments ?? [], action.comment.id)
      };
    case "addCommentReply":
    case "removeCommentReply":
    case "updateCommentReply":
      return {
        ...annotations,
        comments: (annotations.comments ?? []).map((c) =>
          c.id === action.commentId ? applyReplyAction(c, action) : c
        )
      };
    case "upsertFloorplan":
      return {
        ...annotations,
        floorplanRegions: upsertById(annotations.floorplanRegions ?? [], action.region)
      };
    case "removeFloorplan":
      return {
        ...annotations,
        floorplanRegions: removeById(annotations.floorplanRegions ?? [], action.region.id)
      };
    case "batch":
      return action.actions.reduce(applyAction, annotations);
    case "onDie":
      // Another die's share of the gesture — not part of this snapshot.
      return annotations;
    case "upsertAnalogLayers":
      return { ...annotations, analogLayers: action.layers };
    case "flipDie":
      return flipAnnotations(annotations, action.axis, action.size, action.typeSizes);
  }
}

/**
 * Add / remove / edit one reply. Adding keeps replies in `createdAt` order (an
 * undone reply that is redone goes back to its original place) and is
 * idempotent. Editing replaces the reply in place; a reply that is gone
 * (deleted meanwhile) stays gone.
 */
export function applyReplyAction(
  comment: CommentAnnotation,
  action: Extract<AnnotationAction, { kind: "addCommentReply" | "removeCommentReply" | "updateCommentReply" }>
): CommentAnnotation {
  if (action.kind === "updateCommentReply") {
    return {
      ...comment,
      replies: (comment.replies ?? []).map((r) => (r.id === action.reply.id ? action.reply : r))
    };
  }
  const replies = (comment.replies ?? []).filter((r) => r.id !== action.reply.id);
  if (action.kind === "removeCommentReply") return { ...comment, replies };
  replies.push(action.reply);
  replies.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { ...comment, replies };
}

/** Persist the action against the backend. Returns the new revision. */
export async function requestAction(
  dieId: string,
  action: AnnotationAction
): Promise<{ ok: true; rev: number }> {
  switch (action.kind) {
    case "upsertNet":
      return apiPut(`/api/dies/${dieId}/nets/${action.net.id}`, action.net);
    case "removeNet":
      return apiDelete(`/api/dies/${dieId}/nets/${action.net.id}`);
    case "upsertCell":
      return apiPut(`/api/dies/${dieId}/cells/${action.cell.id}`, action.cell);
    case "removeCell":
      return apiDelete(`/api/dies/${dieId}/cells/${action.cell.id}`);
    case "upsertCellType":
      return apiPut(
        `/api/dies/${dieId}/cell-types/${action.cellType.id}`,
        action.cellType
      );
    case "removeCellType":
      return apiDelete(`/api/dies/${dieId}/cell-types/${action.cellType.id}`);
    case "addPin":
      return apiPut(`/api/dies/${dieId}/pins/${action.pin.id}`, action.pin);
    case "removePin":
      return apiDelete(`/api/dies/${dieId}/pins/${action.pin.id}`);
    case "upsertPin":
      return apiPut(`/api/dies/${dieId}/pins/${action.pin.id}`, action.pin);
    case "upsertAnnotation":
      return apiPut(
        `/api/dies/${dieId}/annotations/${action.annotation.id}`,
        action.annotation
      );
    case "removeAnnotation":
      return apiDelete(
        `/api/dies/${dieId}/annotations/${action.annotation.id}`
      );
    case "upsertRoi":
      return apiPut(`/api/dies/${dieId}/rois/${action.roi.id}`, action.roi);
    case "removeRoi":
      return apiDelete(`/api/dies/${dieId}/rois/${action.roi.id}`);
    case "upsertIgnore":
      return apiPut(
        `/api/dies/${dieId}/ignores/${action.ignore.id}`,
        action.ignore
      );
    case "removeIgnore":
      return apiDelete(`/api/dies/${dieId}/ignores/${action.ignore.id}`);
    case "upsertTraceRegion":
      return apiPut(
        `/api/dies/${dieId}/trace-regions/${action.region.id}`,
        action.region
      );
    case "removeTraceRegion":
      return apiDelete(`/api/dies/${dieId}/trace-regions/${action.region.id}`);
    case "upsertTraceBlockage":
      return apiPut(
        `/api/dies/${dieId}/trace-blockages/${action.blockage.id}`,
        action.blockage
      );
    case "removeTraceBlockage":
      return apiDelete(`/api/dies/${dieId}/trace-blockages/${action.blockage.id}`);
    case "upsertGuide":
      return apiPut(`/api/dies/${dieId}/guides/${action.guide.id}`, action.guide);
    case "removeGuide":
      return apiDelete(`/api/dies/${dieId}/guides/${action.guide.id}`);
    case "setUmPerPx":
      return apiPut(`/api/dies/${dieId}/config`, { umPerPx: action.umPerPx });
    case "setProcess":
      return apiPut(`/api/dies/${dieId}/config`, { process: action.process });
    case "upsertRuler":
      return apiPut(`/api/dies/${dieId}/rulers/${action.ruler.id}`, action.ruler);
    case "removeRuler":
      return apiDelete(`/api/dies/${dieId}/rulers/${action.ruler.id}`);
    case "upsertComment":
      return apiPut(`/api/dies/${dieId}/comments/${action.comment.id}`, action.comment);
    case "removeComment":
      return apiDelete(`/api/dies/${dieId}/comments/${action.comment.id}`);
    case "addCommentReply":
    case "removeCommentReply":
    case "updateCommentReply": {
      // The server stores whole comments: read the current one (with any
      // replies other users added since) and write it back with this change.
      const current = await apiGet<DieAnnotations>(`/api/dies/${dieId}/annotations`);
      const comment = (current.comments ?? []).find((c) => c.id === action.commentId);
      if (!comment) throw new Error("Comment no longer exists");
      return apiPut(`/api/dies/${dieId}/comments/${comment.id}`, applyReplyAction(comment, action));
    }
    case "upsertFloorplan":
      return apiPut(`/api/dies/${dieId}/floorplan/${action.region.id}`, action.region);
    case "removeFloorplan":
      return apiDelete(`/api/dies/${dieId}/floorplan/${action.region.id}`);
    case "flipDie":
    case "batch": {
      // Single read → apply all mutations locally → single write.
      // Avoids N individual HTTP requests (each with its own disk read/write).
      const current = await apiGet<DieAnnotations>(`/api/dies/${dieId}/annotations`);
      const patched = applyAction(current, action);
      return apiPut(`/api/dies/${dieId}/annotations`, patched);
    }
    case "upsertAnalogLayers":
      return apiPut(`/api/dies/${dieId}/analog-layers`, action.layers);
    case "onDie":
      return requestAction(action.dieId, action.action);
  }
}

/**
 * A gesture's edits grouped by the die they land on — `home` for everything
 * not wrapped in `onDie` — each die's share one action (a batch when it has
 * several), in application order.
 */
export function splitByDie(home: string, action: AnnotationAction): Map<string, AnnotationAction> {
  const parts = new Map<string, AnnotationAction[]>();
  const visit = (a: AnnotationAction, dieId: string): void => {
    if (a.kind === "batch") {
      for (const sub of a.actions) visit(sub, dieId);
      return;
    }
    if (a.kind === "onDie") {
      visit(a.action, a.dieId);
      return;
    }
    const list = parts.get(dieId);
    if (list) list.push(a);
    else parts.set(dieId, [a]);
  };
  visit(action, home);
  const out = new Map<string, AnnotationAction>();
  for (const [dieId, list] of parts) {
    out.set(dieId, list.length === 1 ? list[0] : { kind: "batch", actions: list });
  }
  return out;
}

// ── Dispatcher ───────────────────────────────────────────────────────

export interface ActionDispatcher {
  /** Apply an action as the user's intent — pushes onto the undo stack.
   *  Resolves false if the server rejected it (the optimistic update is
   *  rolled back and nothing is pushed). */
  dispatch: (action: AnnotationAction) => Promise<boolean>;
  /** Pop the most recent action and apply its inverse. Best-effort: if the
   *  inverse can't be applied (e.g. a remote client already removed the
   *  entity), the entry is dropped from history. */
  undo: () => Promise<void>;
  /** Re-apply the last undone action. */
  redo: () => Promise<void>;
  canUndo: boolean;
  canRedo: boolean;
}

export interface ActionDispatcherOptions {
  /** Rewrites each dispatched action before it's applied and recorded (the
   *  cell library sends edits of another die's type to that die). Null drops
   *  the action. */
  route?: (action: AnnotationAction) => AnnotationAction | null;
}

/**
 * One dispatcher per die. Dispatching is the only way to mutate annotations;
 * persistence happens automatically (optimistic cache update → server call
 * → rollback on error → invalidate on settled). Parts wrapped in `onDie` go
 * to their own die the same way.
 */
export function useActionDispatcher(
  dieId: string,
  options: ActionDispatcherOptions = {}
): ActionDispatcher {
  const qc = useQueryClient();
  const routeRef = useRef(options.route);
  routeRef.current = options.route;

  const undoStack = useDieViewerStore((s) => s.undoStack);
  const redoStack = useDieViewerStore((s) => s.redoStack);
  const pushUndo = useDieViewerStore((s) => s.pushUndo);
  const popUndo = useDieViewerStore((s) => s.popUndo);
  const pushRedo = useDieViewerStore((s) => s.pushRedo);
  const popRedo = useDieViewerStore((s) => s.popRedo);
  const clearRedo = useDieViewerStore((s) => s.clearRedo);
  const ensureHistoryFor = useDieViewerStore((s) => s.ensureHistoryFor);
  const historyDieId = useDieViewerStore((s) => s.historyDieId);
  // One history per die, shared by every page of that die.
  useEffect(() => {
    ensureHistoryFor(dieId);
  }, [dieId, ensureHistoryFor]);
  const ownsHistory = historyDieId === dieId;

  const apply = useCallback(
    async (action: AnnotationAction): Promise<boolean> => {
      const parts = splitByDie(dieId, action);
      const snaps: Array<{ key: readonly unknown[]; previous: DieAnnotations | undefined }> = [];
      for (const [partDie, part] of parts) {
        const key = annotationKeys.forDie(partDie);
        await qc.cancelQueries({ queryKey: key });
        const previous = qc.getQueryData<DieAnnotations>(key);
        snaps.push({ key, previous });
        if (previous) qc.setQueryData<DieAnnotations>(key, applyAction(previous, part));
      }
      try {
        // Each die's share is one request (its own persistence).
        await Promise.all([...parts].map(([partDie, part]) => requestAction(partDie, part)));
        return true;
      } catch (error) {
        // Rollback the optimistic update.
        for (const { key, previous } of snaps) {
          if (previous) qc.setQueryData(key, previous);
        }
        console.warn(`[action] ${action.kind} failed`, error);
        return false;
      } finally {
        // Safety net: the server is authoritative.
        for (const { key } of snaps) void qc.invalidateQueries({ queryKey: key });
      }
    },
    [qc, dieId]
  );

  const dispatch = useCallback<ActionDispatcher["dispatch"]>(
    async (action) => {
      const route = routeRef.current;
      const routed = route ? route(action) : action;
      if (!routed) return false;
      const ok = await apply(routed);
      if (!ok) return false;
      ensureHistoryFor(dieId);
      pushUndo(routed);
      clearRedo();
      return true;
    },
    [apply, pushUndo, clearRedo, ensureHistoryFor, dieId]
  );

  const undo = useCallback<ActionDispatcher["undo"]>(async () => {
    // Never replay another die's history on this one.
    if (useDieViewerStore.getState().historyDieId !== dieId) return;
    const action = popUndo();
    if (!action) return;
    const ok = await apply(inverseOf(action));
    if (ok) pushRedo(action);
    // best-effort: on failure the action is already off the stack.
  }, [apply, popUndo, pushRedo, dieId]);

  const redo = useCallback<ActionDispatcher["redo"]>(async () => {
    if (useDieViewerStore.getState().historyDieId !== dieId) return;
    const action = popRedo();
    if (!action) return;
    const ok = await apply(action);
    if (ok) pushUndo(action);
  }, [apply, popRedo, pushUndo, dieId]);

  return {
    dispatch,
    undo,
    redo,
    canUndo: ownsHistory && undoStack.length > 0,
    canRedo: ownsHistory && redoStack.length > 0
  };
}
