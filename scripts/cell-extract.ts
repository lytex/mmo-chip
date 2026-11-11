/**
 * cell-extract.ts — server-side per-cell structural extraction (one-shot CLI).
 *
 * Same pattern as netlist-export.ts: the RE-cell extractor lives in
 * `frontend/src/lib/extraction` (pure TS + Clipper2 WASM), which the backend
 * cannot import (tsconfig rootDir), so the MCP `get_cell_extraction` tool
 * spawns this script.
 *
 * USAGE
 *   node --import tsx scripts/cell-extract.ts <projectDir> <cellTypeId>
 *
 * Reads <projectDir>/annotations.json and emits one `__RESULT__{json}` line:
 *   { ok, cellType, kind, ports, nets, transistors, transmissionGates,
 *     domains, logic, cellName, analogDevices, warnings }
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadClipperWithBinary } from "../frontend/src/lib/extraction/clipper.js";
import { extractCell, formatBoolExpr } from "../frontend/src/lib/extraction/index.js";
import { extractAnalogDevicesFromCellType } from "../frontend/src/api/dieWideAnalog.js";

const SENTINEL = "__RESULT__";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function emit(payload: unknown): void {
  process.stdout.write(`\n${SENTINEL}${JSON.stringify(payload)}\n`);
}

async function main(): Promise<void> {
  const [, , projectDir, cellTypeId] = process.argv;
  if (!projectDir || !cellTypeId) {
    emit({ ok: false, error: "usage: cell-extract.ts <projectDir> <cellTypeId>" });
    process.exitCode = 2;
    return;
  }
  const wasmPath = path.join(REPO_ROOT, "node_modules", "clipper2-wasm", "dist", "umd", "clipper2z.wasm");
  await loadClipperWithBinary(readFileSync(wasmPath));

  const annotations = JSON.parse(readFileSync(path.join(projectDir, "annotations.json"), "utf8"));
  const cellType = (annotations.cellTypes ?? []).find((t: { id: string }) => t.id === cellTypeId);
  if (!cellType) {
    emit({ ok: false, error: `no cell type ${cellTypeId}` });
    process.exitCode = 2;
    return;
  }

  const ex: any = extractCell(cellType);
  const expr = (e: unknown) => {
    if (!e) return undefined;
    try {
      return formatBoolExpr(e as never);
    } catch {
      return undefined;
    }
  };
  const base = {
    ok: true,
    cellType: { id: cellType.id, name: cellType.name },
    kind: ex.kind,
    cellName: ex.cellName,
    ports: (ex.ports ?? []).map((p: any) => ({
      name: p.name,
      layer: p.layer,
      direction: p.direction,
      netId: p.netId
    })),
    warnings: ex.warnings ?? []
  };
  if (ex.kind !== "inferred") {
    emit(base);
    return;
  }

  let analogDevices = ex.analogDevices;
  try {
    analogDevices = extractAnalogDevicesFromCellType(cellType, annotations.umPerPx ?? 1.0);
  } catch {
    // keep whatever extractCell produced
  }
  emit({
    ...base,
    logic: expr(ex.logic),
    diffusions: (ex.diffusions ?? []).map((d: any) => ({ shapeId: d.shapeId, type: d.type, forced: d.forced })),
    transistors: (ex.transistors ?? []).map((t: any) => ({
      id: t.id,
      type: t.type,
      role: t.role,
      gateNet: t.gate.netId,
      sourceNet: t.source.netId,
      drainNet: t.drain.netId,
      gateShape: t.gate.shapeId,
      region: t.region
    })),
    transmissionGates: ex.transmissionGates ?? [],
    domains: (ex.domains ?? []).map((d: any) => ({
      id: d.id,
      outputNetIds: d.outputNetIds,
      inputNetIds: d.inputNetIds,
      internalNetIds: d.internalNetIds,
      pmosTransistorIds: d.pmosTransistorIds,
      nmosTransistorIds: d.nmosTransistorIds,
      logic: expr(d.logic),
      gate: d.gate
    })),
    nets: (ex.nets ?? []).map((n: any) => ({
      id: n.id,
      role: n.role,
      label: n.label,
      customName: n.customName,
      shapeCount: n.shapeIds?.length ?? 0,
      shapeIds: n.shapeIds
    })),
    analogDevices
  });
}

main().catch((error) => {
  emit({ ok: false, error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
