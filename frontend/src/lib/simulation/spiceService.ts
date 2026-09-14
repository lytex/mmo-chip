/**
 * spiceService.ts — Main-thread Comlink wrapper for the SPICE simulation worker.
 *
 * Lazily creates a single Worker instance. All calls are forwarded via Comlink.
 */

import * as Comlink from "comlink";
import type {
  SimulationResult,
  SimulationStatus,
  SimulationWorkerAPI,
  SpiceSimulationOutput,
  WaveformTrace,
} from "./types";

let workerInstance: Worker | null = null;
let api: Comlink.Remote<SimulationWorkerAPI> | null = null;

function getApi(): Comlink.Remote<SimulationWorkerAPI> {
  if (!api) {
    workerInstance = new Worker(
      new URL("./spiceWorker.ts", import.meta.url),
      { type: "module" },
    );
    api = Comlink.wrap<SimulationWorkerAPI>(workerInstance);
  }
  return api;
}

/** Initialize the ngspice WASM engine (idempotent). */
export async function initSpice(): Promise<string> {
  return getApi().init();
}

/** Run a simulation via WASM worker. */
async function runSpiceSimulationWasm(netlist: string): Promise<SimulationResult> {
  return getApi().run(netlist);
}

/** Run a simulation via server-side ngspice API. */
async function runSpiceSimulationServer(
  netlist: string,
  binPath?: string,
): Promise<SimulationResult> {
  const resp = await fetch("/api/ngspice/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ netlist, binPath }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(err.error ?? `Server returned ${resp.status}`);
  }
  const data = await resp.json();
  if (!data.success) throw new Error(data.error ?? "Server-side simulation failed");

  // Use pre-parsed dataColumns if available (from print command)
  if (data.dataColumns && Object.keys(data.dataColumns).length > 0) {
    const varNames = Object.keys(data.dataColumns);
    const varTypes: string[] = data.varTypes ?? [];
    const numPoints = data.dataColumns[varNames[0]]?.length ?? 0;

    const getVarType = (type: string, name: string): "voltage" | "current" | "time" | "frequency" | "notype" => {
      const t = (type ?? "").toLowerCase();
      if (t === "voltage") return "voltage";
      if (t === "current") return "current";
      if (t === "time") return "time";
      if (t === "frequency") return "frequency";
      // Fallback: guess from name
      const n = name.toLowerCase();
      if (n.startsWith("v(")) return "voltage";
      if (n.startsWith("i(")) return "current";
      if (n === "time") return "time";
      return "notype";
    };

    return {
      header: "",
      numVariables: varNames.length,
      variableNames: varNames,
      numPoints,
      dataType: "real" as const,
      data: varNames.map((name, i) => ({
        name,
        type: getVarType(varTypes[i] ?? "", name),
        values: data.dataColumns[name],
      })),
    } as SimulationResult;
  }

  // Parse raw data from rawfile ASCII format (has headers with variable names and types)
  if (data.rawData && data.rawData.trim()) {
    const rawLines = data.rawData.trim().split("\n");
    const allVars: string[] = [];
    const allTypes: string[] = [];
    let dataStartIdx = 0;
    let section: "variables" | "values" | null = null;

    for (let i = 0; i < rawLines.length; i++) {
      const trimmed = rawLines[i].trim();
      if (trimmed.toLowerCase() === "variables:") {
        section = "variables";
      } else if (trimmed.toLowerCase() === "values:" || trimmed.toLowerCase() === "binary:") {
        section = "values";
        dataStartIdx = i + 1;
      } else if (section === "variables" && trimmed.match(/^\d+\s+/)) {
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 3) {
          allVars.push(parts[1]);
          allTypes.push(parts[2]);
        }
      }
    }

    // Fallback: no headers found, use server-provided variables
    if (allVars.length === 0 && data.variables?.length > 0) {
      for (let i = 0; i < data.variables.length; i++) {
        allVars.push(data.variables[i]);
        allTypes.push(data.varTypes?.[i] ?? "voltage");
      }
    }

    if (allVars.length > 0) {
      const dataLines = rawLines.slice(dataStartIdx).filter((l: string) => l.trim());
      const allColumns: number[][] = allVars.map(() => []);
      for (const line of dataLines) {
        const values = line.trim().split(/\s+/).map(Number);
        for (let i = 0; i < allVars.length; i++) {
          allColumns[i].push(values[i] ?? 0);
        }
      }

      const getVarType = (type: string): "voltage" | "current" | "time" | "frequency" | "notype" => {
        const t = type.toLowerCase();
        if (t === "voltage") return "voltage";
        if (t === "current") return "current";
        if (t === "time") return "time";
        if (t === "frequency") return "frequency";
        return "notype";
      };

      return {
        header: "",
        numVariables: allVars.length,
        variableNames: allVars,
        numPoints: dataLines.length,
        dataType: "real" as const,
        data: allVars.map((name, i) => ({
          name,
          type: getVarType(allTypes[i]),
          values: allColumns[i],
        })),
      } as SimulationResult;
    }
  }

  // Fallback: metadata only
  return {
    header: "",
    numVariables: data.variables?.length ?? 0,
    variableNames: data.variables ?? [],
    numPoints: data.numPoints ?? 0,
    dataType: "real" as const,
    data: (data.variables ?? []).map((name: string) => ({
      name,
      type: "voltage" as const,
      values: [] as number[],
    })),
  } as SimulationResult;
}

/**
 * Parse ngspice raw ASCII output format into SimulationResult.
 * Handles both raw file format and stdout output.
 */
function parseNgspiceRawAscii(raw: string): SimulationResult {
  const lines = raw.split("\n");
  let numVariables = 0;
  let numPoints = 0;
  const variables: Array<{ name: string; type: string }> = [];
  const dataValues: number[][] = [];

  let section: "header" | "variables" | "values" | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.toLowerCase().startsWith("no. variables:")) {
      numVariables = parseInt(trimmed.split(":")[1]?.trim() ?? "0", 10);
    } else if (trimmed.toLowerCase().startsWith("no. points:")) {
      numPoints = parseInt(trimmed.split(":")[1]?.trim() ?? "0", 10);
    } else if (trimmed.toLowerCase() === "variables:") {
      section = "variables";
    } else if (trimmed.toLowerCase() === "values:" || trimmed.toLowerCase() === "binary:") {
      section = "values";
    } else if (section === "variables" && trimmed.match(/^\d+\s+/)) {
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 2) {
        variables.push({ name: parts[1], type: parts[2] ?? "notype" });
      }
    } else if (section === "values" && trimmed && trimmed.match(/^[0-9.eE+\-]/)) {
      const parts = trimmed.split(/\s+/).filter(Boolean).map(Number);
      if (parts.length >= 2) {
        dataValues.push(parts.slice(1));
      }
    }
  }

  // If we found variables but no data, try parsing .print output from stdout
  if (variables.length > 0 && dataValues.length === 0) {
    // Look for .print output lines like: "0  v(out)=1.234567"
    for (const line of lines) {
      const trimmed = line.trim();
      const printMatch = trimmed.match(/^(\d+)\s+(\w[\w()]*)\s*=\s*([+-]?[\d.eE+]+)/i);
      if (printMatch) {
        const varName = printMatch[2].toLowerCase();
        const value = parseFloat(printMatch[3]);
        const existingVar = variables.find((v) => v.name.toLowerCase() === varName);
        if (existingVar) {
          const idx = variables.indexOf(existingVar);
          if (!dataValues[0]) dataValues[0] = [];
          dataValues[0][idx] = value;
        }
      }
    }
  }

  // If still no data but we have variables, create empty arrays
  if (dataValues.length === 0 && variables.length > 0) {
    numPoints = 0;
  }

  const result: SimulationResult = {
    header: "",
    numVariables: variables.length,
    variableNames: variables.map((v) => v.name),
    numPoints: dataValues.length > 0 ? dataValues.length : numPoints,
    dataType: "real" as const,
    data: variables.map((v, i) => ({
      name: v.name,
      type: (v.type === "voltage" ? "voltage" :
             v.type === "current" ? "current" :
             v.type === "time" ? "time" :
             v.type === "frequency" ? "frequency" : "notype") as "voltage" | "current" | "time" | "frequency" | "notype",
      values: dataValues.map((row) => row[i] ?? 0),
    })),
  };

  return result;
}

/** Run a simulation (auto-select WASM or server based on mode). */
export async function runSpiceSimulation(
  netlist: string,
  mode: "wasm" | "server" = "wasm",
  binPath?: string,
): Promise<SimulationResult> {
  if (mode === "server") {
    return runSpiceSimulationServer(netlist, binPath);
  }
  return runSpiceSimulationWasm(netlist);
}

/** Get current worker status. */
export async function getSpiceStatus(): Promise<SimulationStatus> {
  return getApi().getStatus();
}

/** Get errors from the last simulation. */
export async function getSpiceErrors(): Promise<string[]> {
  return getApi().getErrors();
}

/** Terminate the worker (cleanup). */
export function terminateSpice(): void {
  if (workerInstance) {
    workerInstance.terminate();
    workerInstance = null;
    api = null;
  }
}

// ── Waveform parsing helpers ────────────────────────────────────

/**
 * Convert raw SimulationResult into typed WaveformTrace array.
 *
 * IMPORTANT: eecircuit-engine's readOutput filters out "notype" variables
 * from the metadata but keeps all data[] arrays. So data[i] does NOT
 * necessarily correspond to variableNames[i]. We must match by name/type
 * to find the sweep axis (time/frequency/voltage) and signal traces.
 *
 * ngspice with multiple analyses (.op + .dc + .tran) concatenates results
 * into one raw file, producing a non-monotonic x-axis. We extract the
 * largest contiguous monotonic segment for clean plotting.
 */
export function parseWaveforms(result: SimulationResult): WaveformTrace[] {
  const traces: WaveformTrace[] = [];

  if (result.data.length < 2 || result.numPoints < 2) return traces;

  if (result.dataType === "real") {
    // Find the sweep axis: first variable of type time, frequency
    let sweepIdx = -1;
    for (let i = 0; i < result.data.length; i++) {
      const v = result.data[i];
      if (v.type === "time" || v.type === "frequency") {
        sweepIdx = i;
        break;
      }
    }
    // Fallback: check if first variable is monotonic
    if (sweepIdx < 0 && result.data.length > 0) {
      const first = result.data[0].values;
      let monotonic = true;
      for (let i = 1; i < Math.min(first.length, 10); i++) {
        if (first[i] <= first[i - 1]) { monotonic = false; break; }
      }
      if (monotonic) sweepIdx = 0;
    }
    if (sweepIdx < 0) {
      sweepIdx = 0;
    }

    console.log("[parseWaveforms] sweepIdx:", sweepIdx, "sweepName:", result.data[sweepIdx]?.name, "first5:", result.data[sweepIdx]?.values.slice(0, 5));

    const xAll = result.data[sweepIdx].values;

    // Find largest contiguous monotonic segment
    let bestStart = 0;
    let bestLen = 1;
    let curStart = 0;
    for (let i = 1; i < xAll.length; i++) {
      if (xAll[i] > xAll[i - 1]) {
        const len = i - curStart + 1;
        if (len > bestLen) { bestStart = curStart; bestLen = len; }
      } else {
        curStart = i;
      }
    }
    {
      const len = xAll.length - curStart;
      if (len > bestLen) { bestStart = curStart; bestLen = len; }
    }

    const xValues = xAll.slice(bestStart, bestStart + bestLen);

    for (let i = 0; i < result.data.length; i++) {
      if (i === sweepIdx) continue; // skip sweep axis itself

      const v = result.data[i];
      const yValues = v.values.slice(bestStart, bestStart + bestLen);

      // Skip constant/zero traces
      let min = Infinity, max = -Infinity;
      for (const y of yValues) {
        if (Number.isFinite(y)) {
          if (y < min) min = y;
          if (y > max) max = y;
        }
      }
      if (!Number.isFinite(min) || max - min < 1e-30) continue;

      traces.push({ name: v.name, type: v.type, xValues, yValues });
    }

    console.log("[parseWaveforms] traces created:", traces.length, traces.map((t) => `${t.name}(${t.type})[${t.yValues.length}]`));
  } else {
    // Complex — plot magnitude
    const sweepIdx = 0;
    const xValues = result.data[sweepIdx].values.map((pt) => pt.real);

    for (let i = 0; i < result.data.length; i++) {
      if (i === sweepIdx) continue;
      const v = result.data[i];
      const yValues = v.values.map((pt) => Math.sqrt(pt.real ** 2 + pt.img ** 2));
      traces.push({ name: v.name, type: v.type, xValues, yValues });
    }
  }

  return traces;
}

/**
 * Run a full simulation and return parsed output.
 */
export async function runFullSimulation(
  netlist: string,
  mode: "wasm" | "server" = "wasm",
  binPath?: string,
): Promise<SpiceSimulationOutput> {
  const t0 = performance.now();
  const raw = await runSpiceSimulation(netlist, mode, binPath);
  const durationMs = performance.now() - t0;
  const waveforms = parseWaveforms(raw);
  const errors = mode === "wasm" ? await getSpiceErrors() : [];

  console.log("[runFullSimulation] raw:", JSON.stringify({
    numVariables: raw.numVariables,
    numPoints: raw.numPoints,
    dataLength: raw.data.length,
    dataNames: raw.data.map((d) => d.name),
    dataTypes: raw.data.map((d) => d.type),
    dataValuesLengths: raw.data.map((d) => d.values.length),
  }));
  console.log("[runFullSimulation] waveforms:", waveforms.length, "traces");

  return { raw, waveforms, errors, durationMs };
}

// ── .step param support ───────────────────────────────────────

interface ParsedStep {
  paramName: string;
  values: string[];
}

/**
 * Parse `.step param NAME list V1 V2 V3` or `.step param NAME START END STEP` from netlist.
 * Returns parsed steps and the netlist with .step lines removed.
 */
export function parseStepDirectives(netlist: string): { steps: ParsedStep[]; netlist: string } {
  const lines = netlist.split("\n");
  const steps: ParsedStep[] = [];
  const remaining: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const upper = trimmed.toUpperCase();

    // Match: .step param NAME list V1 V2 V3 ...
    //        .step param NAME START END STEP
    const stepMatch = upper.match(/^\.STEP\s+PARAM\s+(\S+)\s+(LIST\s+(.+)|(\S+)\s+(\S+)\s+(\S+))$/);
    if (stepMatch) {
      const paramName = stepMatch[1];
      if (stepMatch[2]?.toUpperCase().startsWith("LIST")) {
        // List mode: .step param NAME list V1 V2 V3
        const valuesStr = stepMatch[3] ?? "";
        const values = valuesStr.split(/[\s,]+/).filter(Boolean);
        steps.push({ paramName, values });
      } else {
        // Range mode: .step param NAME START END STEP
        const start = parseFloat(stepMatch[4]);
        const end = parseFloat(stepMatch[5]);
        const step = parseFloat(stepMatch[6]);
        if (isFinite(start) && isFinite(end) && isFinite(step) && step !== 0) {
          const values: string[] = [];
          const isUp = end > start;
          let cur = start;
          const maxIter = 1000;
          let i = 0;
          while (i < maxIter) {
            values.push(String(cur));
            cur += isUp ? step : -step;
            if (isUp ? cur > end : cur < end) break;
            i++;
          }
          if (values.length === 0 || parseFloat(values[values.length - 1]) !== end) {
            values.push(String(end));
          }
          steps.push({ paramName, values });
        }
      }
      // Skip .step lines — don't pass to ngspice
    } else {
      remaining.push(line);
    }
  }

  return { steps, netlist: remaining.join("\n") };
}

/**
 * Substitute parameter values into a netlist.
 * Adds a .param line with all values.
 */
function substituteStepParams(netlist: string, values: Record<string, string>): string {
  const paramParts = Object.entries(values).map(([k, v]) => `${k}=${v}`);
  if (paramParts.length === 0) return netlist;

  // Find where to insert .param (before analysis directives like .dc, .tran, .ac)
  const lines = netlist.split("\n");
  let insertIdx = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim().toUpperCase();
    if (t.startsWith(".DC ") || t.startsWith(".TRAN ") || t.startsWith(".AC ") ||
        t.startsWith(".OP") || t.startsWith(".CONTROL")) {
      insertIdx = i;
      break;
    }
  }

  lines.splice(insertIdx, 0, `.param ${paramParts.join(" ")}`);
  return lines.join("\n");
}

/**
 * Run simulation with .step param support.
 *
 * If the netlist contains .step directives, runs separate simulations
 * for each parameter value and accumulates results.
 * Calls onStep after each iteration for live streaming to the viewer.
 */
export async function runWithStepSupport(
  netlist: string,
  mode: "wasm" | "server" = "wasm",
  binPath?: string,
  onStep?: (index: number, total: number, params: Record<string, string>, result: SpiceSimulationOutput) => void,
): Promise<SpiceSimulationOutput> {
  const { steps, netlist: cleanNetlist } = parseStepDirectives(netlist);

  if (steps.length === 0) {
    return runFullSimulation(cleanNetlist, mode, binPath);
  }

  const step = steps[0];
  const total = step.values.length;
  const allWaveforms: WaveformTrace[] = [];

  for (let i = 0; i < total; i++) {
    const params: Record<string, string> = { [step.paramName]: step.values[i] };
    const substituted = substituteStepParams(cleanNetlist, params);
    const result = await runFullSimulation(substituted, mode, binPath);

    for (const trace of result.waveforms) {
      allWaveforms.push({
        ...trace,
        name: `${trace.name} (${step.paramName}=${step.values[i]})`,
      });
    }

    onStep?.(i, total, params, result);

    if (i < total - 1) {
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }

  const lastResult = await runFullSimulation(
    substituteStepParams(cleanNetlist, { [step.paramName]: step.values[total - 1] }),
    mode,
    binPath,
  );

  return {
    raw: lastResult.raw,
    waveforms: allWaveforms,
    errors: lastResult.errors,
    durationMs: lastResult.durationMs,
  };
}
