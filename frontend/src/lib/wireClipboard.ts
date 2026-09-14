import type { AnnotationNet, AnnotationNetEdge, AnnotationNetNode } from "shared";
import { distancePointToSegment, closestPointOnSegment, type Point } from "./geometry";
import { uuid } from "./uuid";
import type { NetChange } from "./netGraph";

export interface WireClipboardNode {
  id: string;
  offsetX: number;
  offsetY: number;
}

export interface WireClipboardEdge {
  id: string;
  from: string;
  to: string;
  layer?: AnnotationNetEdge["layer"];
}

export interface WireClipboardGroup {
  name: string;
  nodes: WireClipboardNode[];
  edges: WireClipboardEdge[];
}

export interface WireClipboard {
  groups: WireClipboardGroup[];
}

const PASTE_CONNECT_TOLERANCE = 1;

/** Bounding origin of the selected wire nodes, used to align wires with cells. */
export function wireSelectionBounds(
  nets: AnnotationNet[],
  selectedIds: ReadonlySet<string>,
): { minX: number; minY: number } | null {
  const selected = snapshotWireSelection(nets, selectedIds);
  if (selected.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  for (const { net, edges } of selected) {
    const used = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
    for (const node of net.nodes) {
      if (!used.has(node.id)) continue;
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
    }
  }
  return { minX, minY };
}

function snapshotWireSelection(
  nets: AnnotationNet[],
  selectedIds: ReadonlySet<string>,
): Array<{ net: AnnotationNet; edges: AnnotationNetEdge[] }> {
  const selectedEdges = new Map<string, Set<string>>();
  for (const id of selectedIds) {
    if (!id.startsWith("net:")) continue;
    const body = id.slice(4);
    const edgeAt = body.indexOf("/edge:");
    if (body.includes("/node:")) continue;
    const netId = edgeAt >= 0 ? body.slice(0, edgeAt) : body;
    const edgeId = edgeAt >= 0 ? body.slice(edgeAt + 6) : null;
    const edgeSet = selectedEdges.get(netId) ?? new Set<string>();
    if (edgeId) edgeSet.add(edgeId);
    else edgeSet.add("*");
    selectedEdges.set(netId, edgeSet);
  }
  const selected: Array<{ net: AnnotationNet; edges: AnnotationNetEdge[] }> = [];
  for (const net of nets) {
    const edgeSet = selectedEdges.get(net.id);
    if (!edgeSet) continue;
    const edges = edgeSet.has("*")
      ? net.edges
      : net.edges.filter((edge) => edgeSet.has(edge.id));
    if (edges.length > 0) selected.push({ net, edges });
  }
  return selected;
}

/** Snapshot selected whole nets or edge sub-selections, without vias. */
export function snapshotWireClipboard(
  nets: AnnotationNet[],
  selectedIds: ReadonlySet<string>,
  origin?: { x: number; y: number },
): WireClipboard | null {
  const groups: WireClipboardGroup[] = [];
  let minX = origin?.x ?? Infinity;
  let minY = origin?.y ?? Infinity;
  const selectedGroups = snapshotWireSelection(nets, selectedIds);

  for (const { net, edges } of selectedGroups) {
    if (edges.length === 0) continue;
    const used = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
    const nodes = net.nodes.filter((node) => used.has(node.id));
    if (nodes.length === 0) continue;
    for (const node of nodes) {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
    }
  }

  if (selectedGroups.length === 0) return null;

  for (const { net, edges } of selectedGroups) {
    const used = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
    groups.push({
      name: net.name,
      nodes: net.nodes
        .filter((node) => used.has(node.id))
        .map((node) => ({ id: node.id, offsetX: node.x - minX, offsetY: node.y - minY })),
      edges: edges.map((edge) => ({
        id: edge.id,
        from: edge.from,
        to: edge.to,
        ...(edge.layer ? { layer: edge.layer } : {}),
      })),
    });
  }
  return { groups };
}

interface WorkingNet extends AnnotationNet {
  copied?: boolean;
}

function pointForNode(net: AnnotationNet, nodeId: string): Point | null {
  const node = net.nodes.find((candidate) => candidate.id === nodeId);
  return node ? { x: node.x, y: node.y } : null;
}

function endpointIds(net: AnnotationNet): string[] {
  const degree = new Map<string, number>();
  for (const edge of net.edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }
  return [...degree].filter(([, count]) => count === 1).map(([id]) => id);
}

function splitTargetEdge(net: WorkingNet, edgeId: string, point: Point): string {
  const edge = net.edges.find((candidate) => candidate.id === edgeId);
  if (!edge) return "";
  const existing = net.nodes.find(
    (node) => Math.hypot(node.x - point.x, node.y - point.y) <= PASTE_CONNECT_TOLERANCE,
  );
  if (existing) return existing.id;

  const node: AnnotationNetNode = { id: uuid(), x: point.x, y: point.y };
  const first: AnnotationNetEdge = {
    id: uuid(), from: edge.from, to: node.id, ...(edge.layer ? { layer: edge.layer } : {}),
  };
  const second: AnnotationNetEdge = {
    id: uuid(), from: node.id, to: edge.to, ...(edge.layer ? { layer: edge.layer } : {}),
  };
  net.nodes = [...net.nodes, node];
  net.edges = [first, second, ...net.edges.filter((candidate) => candidate.id !== edgeId)];
  return node.id;
}

function closestTarget(
  nets: WorkingNet[],
  point: Point,
): { net: WorkingNet; edgeId: string; point: Point; distance: number } | null {
  let best: { net: WorkingNet; edgeId: string; point: Point; distance: number } | null = null;
  for (const net of nets) {
    for (const node of net.nodes) {
      const distance = Math.hypot(node.x - point.x, node.y - point.y);
      if (distance <= PASTE_CONNECT_TOLERANCE && (!best || distance < best.distance)) {
        best = { net, edgeId: "", point: { x: node.x, y: node.y }, distance };
      }
    }
    for (const edge of net.edges) {
      const a = pointForNode(net, edge.from);
      const b = pointForNode(net, edge.to);
      if (!a || !b) continue;
      const projected = closestPointOnSegment(point, a, b);
      const distance = distancePointToSegment(point, a, b);
      if (distance <= PASTE_CONNECT_TOLERANCE && (!best || distance < best.distance)) {
        best = { net, edgeId: edge.id, point: projected, distance };
      }
    }
  }
  return best;
}

/** Build one undoable set of net changes for a pasted wire clipboard. */
export function pasteWireClipboard(
  originalNets: AnnotationNet[],
  clipboard: WireClipboard,
  base: Point,
): NetChange[] {
  const originalById = new Map(originalNets.map((net) => [net.id, net]));
  const working = new Map<string, WorkingNet>(
    originalNets.map((net) => [net.id, { ...net, nodes: [...net.nodes], edges: [...net.edges] }]),
  );
  const createdIds = new Set<string>();

  for (const group of clipboard.groups) {
    const nodeMap = new Map<string, string>();
    const nodes: AnnotationNetNode[] = group.nodes.map((node) => {
      const id = uuid();
      nodeMap.set(node.id, id);
      return { id, x: Math.round(base.x + node.offsetX), y: Math.round(base.y + node.offsetY) };
    });
    const netId = uuid();
    createdIds.add(netId);
    working.set(netId, {
      id: netId,
      name: `${group.name} copy`,
      nodes,
      edges: group.edges.map((edge) => ({
        id: uuid(),
        from: nodeMap.get(edge.from)!,
        to: nodeMap.get(edge.to)!,
        ...(edge.layer ? { layer: edge.layer } : {}),
      })),
      copied: true,
    });
  }

  for (const copiedId of [...createdIds]) {
    const copied = working.get(copiedId);
    if (!copied) continue;
    const endpoints = endpointIds(copied);
    const eligibleTargets = () => [...working.values()].filter(
      (net) => !net.copied && net.id !== copied.id,
    );
    type EndpointMatch = {
      nodeId: string;
      target: NonNullable<ReturnType<typeof closestTarget>>;
      targetNodeId?: string;
    };
    const matches: EndpointMatch[] = endpoints
      .map((nodeId) => {
        const point = pointForNode(copied, nodeId);
        if (!point) return null;
        const target = closestTarget(eligibleTargets(), point);
        return target ? { nodeId, target } : null;
      })
      .filter((match): match is EndpointMatch => match !== null);
    if (matches.length === 0) continue;

    const targetNets = new Map<string, WorkingNet>();
    for (const match of matches) {
      const target = match.target.net;
      if (match.target.edgeId) {
        const targetNodeId = splitTargetEdge(target, match.target.edgeId, match.target.point);
        match.targetNodeId = targetNodeId;
      }
      targetNets.set(target.id, target);
    }

    const firstTarget = targetNets.values().next().value as WorkingNet | undefined;
    if (!firstTarget) continue;
    const endpointMap = new Map<string, string>();
    for (const match of matches) {
      const targetNodeId = match.targetNodeId ?? match.target.net.nodes.find(
        (node) => Math.hypot(node.x - match.target.point.x, node.y - match.target.point.y) <= PASTE_CONNECT_TOLERANCE,
      )?.id;
      if (targetNodeId) endpointMap.set(match.nodeId, targetNodeId);
    }

    const mergedNodes = [...firstTarget.nodes];
    const mergedEdges = [...firstTarget.edges];
    for (const target of targetNets.values()) {
      if (target.id === firstTarget.id) continue;
      mergedNodes.push(...target.nodes);
      mergedEdges.push(...target.edges);
    }
    for (const node of copied.nodes) {
      if (!endpointMap.has(node.id)) mergedNodes.push(node);
    }
    for (const edge of copied.edges) {
      mergedEdges.push({
        ...edge,
        from: endpointMap.get(edge.from) ?? edge.from,
        to: endpointMap.get(edge.to) ?? edge.to,
      });
    }
    const merged: WorkingNet = { ...firstTarget, nodes: mergedNodes, edges: mergedEdges };
    working.set(firstTarget.id, merged);
    for (const target of targetNets.values()) {
      if (target.id !== firstTarget.id) working.delete(target.id);
    }
    working.delete(copiedId);
  }

  const changes: NetChange[] = [];
  for (const original of originalNets) {
    const next = working.get(original.id) ?? null;
    if (JSON.stringify(original) !== JSON.stringify(next)) changes.push({ prev: original, next });
  }
  for (const net of working.values()) {
    if (!originalById.has(net.id)) {
      const { copied: _copied, ...clean } = net;
      changes.push({ prev: null, next: clean });
    }
  }
  return changes;
}
