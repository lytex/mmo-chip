/**
 * netlistExtraction.ts — server-side analog netlist extraction.
 *
 * The extraction pipeline (device detection + SPICE generation) is written for
 * the frontend but is pure data-in/data-out TypeScript that also runs in Node
 * (see backend/src/analog-extraction.test.ts). It cannot be imported directly
 * from a backend module because backend/tsconfig.json pins `"rootDir": "src"`,
 * which would break `npm run build -w backend`. Instead the backend spawns
 * `scripts/netlist-export.ts` as its own process — the same pattern already
 * used for ngspice and the vyges-lvs CLI.
 *
 * The child reads the project's persisted JSON (annotations.json,
 * spice_config.json, analog-devices.json), re-runs the pipeline and reports a
 * single `__RESULT__`-prefixed JSON line, which this module parses out.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = process.env.CHIPTOOL_APP_ROOT
  ? path.resolve(process.env.CHIPTOOL_APP_ROOT)
  // Repo layout in dev; mirrored under resources/app in the desktop build.
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "netlist-export.ts");

/** Generous: WASM load + full-die extraction. */
const DEFAULT_TIMEOUT_MS = 120_000;

export interface VirtualConnect {
  name: string;
  spiceNetIds: number[];
  physicalNets: string[];
}

export interface NetlistExtractionResult {
  ok: boolean;
  dieId?: string;
  umPerPx?: number;
  deviceCount?: number;
  namedNetCount?: number;
  byKind?: Record<string, number>;
  totalDevices?: number;
  warnings?: string[];
  virtualConnects?: VirtualConnect[];
  text?: string;
  error?: string;
}

function parseResultLine(stdout: string): NetlistExtractionResult | null {
  // The child may print diagnostics; the payload is the LAST __RESULT__ line.
  const idx = stdout.lastIndexOf("__RESULT__");
  if (idx === -1) return null;
  const rest = stdout.slice(idx + "__RESULT__".length);
  const end = rest.indexOf("\n");
  const jsonText = end === -1 ? rest : rest.slice(0, end);
  try {
    return JSON.parse(jsonText) as NetlistExtractionResult;
  } catch {
    return null;
  }
}

export async function extractNetlist(options: {
  dieId: string;
  projectDir: string;
  moduleName?: string;
  dialect?: "cdl" | "spectre" | "hspice";
  timeoutMs?: number;
}): Promise<NetlistExtractionResult> {
  const { dieId, projectDir, moduleName, dialect, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  return await new Promise<NetlistExtractionResult>((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "--import", "tsx",
        SCRIPT,
        dieId,
        projectDir,
        (moduleName ?? "netlist").replace(/[^A-Za-z0-9_-]/g, "_"),
        dialect ?? "cdl",
      ],
      { cwd: REPO_ROOT, windowsHide: true },
    );

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ ok: false, error: `netlist extraction timed out after ${timeoutMs} ms` });
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: `failed to spawn extraction: ${error.message}` });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const parsed = parseResultLine(stdout);
      if (parsed) {
        resolve(parsed);
        return;
      }
      const detail = stderr.trim() || stdout.trim() || `exit code ${code}`;
      resolve({ ok: false, error: `netlist extraction failed: ${detail.slice(0, 2000)}` });
    });
  });
}
