/**
 * cellExtraction.ts — server-side per-cell-type structural extraction.
 *
 * Mirrors netlistExtraction.ts: the extractor is frontend TypeScript, so the
 * backend runs `scripts/cell-extract.ts` as a child process and parses the
 * single `__RESULT__` line it prints.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = process.env.CHIPTOOL_APP_ROOT
  ? path.resolve(process.env.CHIPTOOL_APP_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "cell-extract.ts");
const DEFAULT_TIMEOUT_MS = 60_000;

export interface CellExtractionResult {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export async function extractCellType(options: {
  projectDir: string;
  cellTypeId: string;
  timeoutMs?: number;
}): Promise<CellExtractionResult> {
  const { projectDir, cellTypeId, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  return await new Promise<CellExtractionResult>((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", SCRIPT, projectDir, cellTypeId], {
      cwd: REPO_ROOT,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: CellExtractionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, error: `cell extraction timed out after ${timeoutMs} ms` });
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (error) => finish({ ok: false, error: `failed to spawn extraction: ${error.message}` }));
    child.on("close", (code) => {
      const idx = stdout.lastIndexOf("__RESULT__");
      if (idx !== -1) {
        const rest = stdout.slice(idx + "__RESULT__".length);
        const end = rest.indexOf("\n");
        try {
          finish(JSON.parse(end === -1 ? rest : rest.slice(0, end)) as CellExtractionResult);
          return;
        } catch {
          // fall through
        }
      }
      finish({
        ok: false,
        error: `cell extraction failed: ${(stderr.trim() || stdout.trim() || `exit code ${code}`).slice(0, 2000)}`
      });
    });
  });
}
