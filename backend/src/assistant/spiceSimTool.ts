/**
 * spiceSimTool — Backend tool for AI agent to run ngspice simulations.
 *
 * The tool accepts a netlist (or subcircuit + directives), writes them to a
 * temp file, runs ngspice in batch mode, parses the raw output, and returns
 * key measurements to the LLM.
 *
 * Requires ngspice to be installed on the server (ngspice -b).
 * Falls back gracefully if not available.
 */

import { writeFile, unlink, readFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const execFileAsync = promisify(execFile);

const SPICE_BIN = process.env.NGSPICE_BIN ?? "ngspice";
const TIMEOUT_MS = 30_000;

export interface SpiceSimToolArgs {
  /** Full SPICE netlist (takes priority over subcircuit + directives). */
  netlist?: string;
  /** Subcircuit block to simulate (will be prepended to directives). */
  subcircuit?: string;
  /** User directives (.tran, .dc, .ac, sources, etc.). */
  directives?: string;
  /** Analysis type hint for output parsing. */
  analysis?: "tran" | "dc" | "ac";
  /** Path to ngspice binary (overrides env NGSPICE_BIN). */
  binPath?: string;
}

export interface SpiceSimToolResult {
  success: boolean;
  /** Parsed output variables (v(out), i(Vdd), etc.) */
  variables?: string[];
  /** Number of data points per variable */
  numPoints?: number;
  /** Key measurements extracted from .measure or .print */
  measurements?: Record<string, number>;
  /** ngspice stdout/stderr combined */
  output?: string;
  /** Error message if simulation failed */
  error?: string;
  /** The netlist that was actually simulated */
  simulatedNetlist?: string;
}

/**
 * Build the full netlist from tool arguments.
 */
function buildNetlist(args: SpiceSimToolArgs): string {
  if (args.netlist) return args.netlist;

  const parts: string[] = [];
  if (args.subcircuit) {
    parts.push(args.subcircuit);
    parts.push("");
  }
  if (args.directives) {
    parts.push(args.directives);
  }
  return parts.join("\n");
}

/**
 * Parse ngspice raw ASCII output to extract variable names and data.
 * For the tool response we only need a summary, not full data.
 */
function parseRawOutput(raw: string): { variables: string[]; numPoints: number; measurements: Record<string, number> } {
  const variables: string[] = [];
  let numPoints = 0;
  const measurements: Record<string, number> = {};

  const lines = raw.split("\n");
  let inHeader = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("No. Variables:")) {
      const m = trimmed.match(/No\. Variables:\s+(\d+)/);
      if (m) { /* already captured from header */ }
    }
    if (trimmed.startsWith("No. Points:")) {
      const m = trimmed.match(/No\. Points:\s+(\d+)/);
      if (m) numPoints = parseInt(m[1], 10);
    }
    if (trimmed.startsWith("Variables:")) {
      inHeader = true;
      continue;
    }
    if (inHeader && trimmed.match(/^\d+\s+/)) {
      const varName = trimmed.split(/\s+/)[1];
      if (varName) variables.push(varName);
    }
    if (trimmed === "Values:" || trimmed === "Binary:") {
      inHeader = false;
    }

    // Parse .measure results from stdout
    const measureMatch = trimmed.match(/^(\w[\w.]*)\s*=\s*([+-]?[\d.eE+]+)/i);
    if (measureMatch) {
      measurements[measureMatch[1]] = parseFloat(measureMatch[2]);
    }
  }

  return { variables, numPoints, measurements };
}

/**
 * Execute a SPICE simulation via ngspice subprocess.
 */
export async function executeSpiceSimTool(args: SpiceSimToolArgs): Promise<{ text: string; result: SpiceSimToolResult; rawData?: string; rawColumns?: number; varTypes?: string[]; dataColumns?: Record<string, number[]> }> {
  const netlist = buildNetlist(args);

  if (!netlist.trim()) {
    return {
      text: JSON.stringify({ error: "No netlist provided. Supply a full netlist, or subcircuit + directives." }),
      result: { success: false, error: "Empty netlist" },
    };
  }

  // Extract variable names from .print directives before modifying the netlist
  const printVars = extractPrintVariables(netlist);

  const id = randomBytes(8).toString("hex");
  const runDir = join(tmpdir(), `mmochip_spice_${id}`);
  await mkdir(runDir, { recursive: true });
  const cirFile = join(runDir, "sim.cir");
  const rawFile = join(runDir, "sim.raw");

  // Insert .control block BEFORE .end
  // Use "set filetype=ascii" + "write" to output rawfile format with headers
  let fullNetlist = netlist;
  const endIdx = fullNetlist.toLowerCase().lastIndexOf(".end");
  const controlBlock = `.control\nrun\nset filetype=ascii\nwrite sim.raw\nquit\n.endc`;

  if (endIdx >= 0) {
    fullNetlist = fullNetlist.slice(0, endIdx) + controlBlock + "\n" + fullNetlist.slice(endIdx);
  } else {
    fullNetlist += "\n" + controlBlock + "\n.end";
  }

  try {
    await writeFile(cirFile, fullNetlist, "utf-8");

    const { stdout, stderr } = await execFileAsync(
      args.binPath ?? SPICE_BIN,
      ["-b", "sim.cir"],
      { timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024, cwd: runDir },
    );

    const combined = [stdout, stderr].filter(Boolean).join("\n");

    // Read and parse rawfile ASCII format
    let rawData = "";
    let variables: string[] = [];
    let varTypes: string[] = [];
    let numPoints = 0;
    const dataMap = new Map<string, number[]>();

    try {
      rawData = await readFile(rawFile, "utf-8");
      const rawLines = rawData.split("\n");

      // Log structure for debugging
      console.log("[ngspice] raw lines:", rawLines.length);
      console.log("[ngspice] first 15 lines:");
      for (let i = 0; i < Math.min(15, rawLines.length); i++) {
        console.log(`  [${i}] "${rawLines[i]?.slice(0, 120)}"`);
      }

      // Parse rawfile ASCII format
      let section: "variables" | "values" | null = null;
      let dataStartIdx = 0;

      for (let i = 0; i < rawLines.length; i++) {
        const trimmed = rawLines[i].trim();
        if (trimmed.toLowerCase().startsWith("no. points:")) {
          numPoints = parseInt(trimmed.split(":")[1]?.trim() ?? "0", 10);
        } else if (trimmed.toLowerCase() === "variables:") {
          section = "variables";
        } else if (trimmed.toLowerCase() === "values:" || trimmed.toLowerCase() === "binary:") {
          section = "values";
          dataStartIdx = i + 1;
        } else if (section === "variables" && trimmed.match(/^\d+\s+/)) {
          const parts = trimmed.split(/\s+/);
          if (parts.length >= 3) {
            variables.push(parts[1]);
            varTypes.push(parts[2]);
          }
        }
      }

      // Parse data lines
      // Format: groups of numVars lines per point
      // First line of group: " 0  0.000e+00" (pointIndex + value)
      // Remaining lines: "    1.000e+00" (just value, no index)
      const dataLines = rawLines.slice(dataStartIdx).filter((l: string) => l.trim());
      const numVars = variables.length;
      const numPts = Math.floor(dataLines.length / numVars);

      console.log("[ngspice] data lines:", dataLines.length, "vars:", numVars, "points:", numPts);
      console.log("[ngspice] first data line:", JSON.stringify(dataLines[0]?.trim()));
      console.log("[ngspice] second data line:", JSON.stringify(dataLines[1]?.trim()));

      // Initialize data arrays
      for (const v of variables) {
        dataMap.set(v, []);
      }

      // Parse: each group of numVars lines = one data point
      for (let pt = 0; pt < numPts; pt++) {
        for (let v = 0; v < numVars; v++) {
          const lineIdx = pt * numVars + v;
          const line = dataLines[lineIdx]?.trim() ?? "";
          // Split by whitespace and get the last number (the value)
          const parts = line.split(/\s+/).filter(Boolean);
          const value = parseFloat(parts[parts.length - 1] ?? "0");
          dataMap.get(variables[v])!.push(value);
        }
      }
    } catch (e) {
      console.log("[ngspice] raw file error:", e);
    }

    const numPointsActual = dataMap.size > 0 ? (dataMap.values().next().value?.length ?? 0) : 0;

    // Build a summary with sample data for the LLM
    const sampleData: Record<string, { first: number; last: number; min: number; max: number }> = {};
    for (const [name, values] of dataMap) {
      if (values.length === 0) continue;
      let min = Infinity, max = -Infinity;
      for (const v of values) {
        if (Number.isFinite(v)) {
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      sampleData[name] = {
        first: values[0],
        last: values[values.length - 1],
        min: Number.isFinite(min) ? min : 0,
        max: Number.isFinite(max) ? max : 0,
      };
    }

    const result: SpiceSimToolResult = {
      success: true,
      variables,
      numPoints: numPointsActual,
      output: combined.slice(0, 2000),
      simulatedNetlist: netlist.slice(0, 1000),
    };

    // Rich text for LLM: includes variable names, point count, and sample data
    const textForLlm = JSON.stringify({
      success: true,
      variables,
      numPoints: numPointsActual,
      sampleData,
      ngspiceOutput: combined.slice(0, 1000),
    });

    return {
      text: textForLlm,
      result,
      rawData,
      rawColumns: variables.length,
      varTypes,
      dataColumns: Object.fromEntries(dataMap),
    };
  } catch (err: any) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      text: JSON.stringify({ success: false, error: errMsg }),
      result: { success: false, error: errMsg, output: err.stdout ?? err.stderr ?? "" },
    };
  } finally {
    try { await unlink(cirFile); } catch { /* ok */ }
    try { await unlink(rawFile); } catch { /* ok */ }
    try { const { rmdir } = await import("node:fs/promises"); await rmdir(runDir); } catch { /* ok */ }
  }
}

/**
 * Extract variable names from .print directives.
 * ".print dc V(OUT)" → ["v(out)"]
 */
function extractPrintVariables(netlist: string): string[] {
  const vars: string[] = [];
  for (const line of netlist.split("\n")) {
    const m = line.trim().match(/^\.print\s+\w+\s+(.+)/i);
    if (m) {
      for (const p of m[1].split(/\s+/).filter(Boolean)) {
        vars.push(p.toLowerCase());
      }
    }
  }
  return vars;
}

/**
 * Parse ngspice stdout/stderr output for variable names, point counts, and measurements.
 */
function parseNgspiceOutput(output: string): { variables: string[]; numPoints: number; measurements: Record<string, number> } {
  const variables: string[] = [];
  let numPoints = 0;
  const measurements: Record<string, number> = {};
  const lines = output.split("\n");
  let inVariables = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.toLowerCase().startsWith("no. points:")) {
      const m = trimmed.match(/No\. Points:\s+(\d+)/i);
      if (m) numPoints = parseInt(m[1], 10);
    }
    if (trimmed.toLowerCase() === "variables:") { inVariables = true; continue; }
    if (trimmed.toLowerCase() === "values:" || trimmed.toLowerCase() === "binary:") { inVariables = false; continue; }
    if (inVariables && trimmed.match(/^\d+\s+/)) {
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 2) variables.push(parts[1]);
    }
    const measureMatch = trimmed.match(/^(\w[\w.]*)\s*=\s*([+-]?[\d.eE+]+)/i);
    if (measureMatch && !trimmed.toLowerCase().startsWith("no.")) {
      measurements[measureMatch[1]] = parseFloat(measureMatch[2]);
    }
  }
  return { variables, numPoints, measurements };
}

/**
 * OpenAI-compatible tool definition for the LLM.
 */
export const SPICE_SIM_TOOL = {
  type: "function",
  function: {
    name: "mmochip_spice_sim",
      description:
        "Run an ngspice simulation on a circuit netlist. Supply either a full netlist, or a subcircuit block plus analysis directives (.tran, .dc, .ac, sources, loads, etc.). The netlist MUST be in standard SPICE/CDL format (NOT Spectre syntax). Example formats: R1 n1 n2 4858 (resistor), Q1 c b e npn_model (BJT), D1 anode cathode d_model (diode). Returns simulation status, variable names, data point count, and any measurements. Use this to verify circuit behavior — e.g. compute gain, bandwidth, PSRR, transient response, DC operating point. The simulation runs server-side with ngspice in batch mode.",
    parameters: {
      type: "object",
      properties: {
        netlist: {
          type: "string",
          description: "Full SPICE netlist to simulate. Takes priority over subcircuit + directives.",
        },
        subcircuit: {
          type: "string",
          description: ".subckt block to simulate. Will be combined with the directives field.",
        },
        directives: {
          type: "string",
          description: "ngspice directives: source definitions (VDD, VIN), analysis commands (.tran, .dc, .ac), load caps, .control blocks, .meas commands, etc.",
        },
        analysis: {
          type: "string",
          enum: ["tran", "dc", "ac"],
          description: "Hint for the type of analysis being performed (for output parsing guidance).",
        },
        binPath: {
          type: "string",
          description: "Path to ngspice binary (e.g. 'C:\\Program Files\\Spice64\\bin\\ngspice.exe' on Windows, or 'ngspice' if in PATH).",
        },
      },
    },
  },
} as const;
