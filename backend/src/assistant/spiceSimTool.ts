/**
 * spiceSimTool — Backend tool for AI agent to run ngspice simulations.
 *
 * The tool accepts a netlist (or subcircuit + directives), normalises it into
 * something ngspice actually accepts, runs ngspice in batch mode, parses the
 * raw output, and returns key measurements to the LLM.
 *
 * Requires ngspice to be installed on the server (ngspice -b).
 * Falls back gracefully if not available.
 *
 * Why the normalisation step exists (these were the failure modes that made
 * the agent "unable to launch a testbench"):
 *
 *  1. Spectre/CDL netlists use parenthesised node lists. ngspice mis-parses
 *     those for BJTs ("could not find a valid modelname") — the tool converts
 *     them to positional form.
 *  2. A netlist without an analysis directive (.op/.dc/.tran/.ac) makes
 *     ngspice write its "Constant values" plot (boltz, e, planck, …) instead
 *     of circuit results. The tool adds `.op` when none is present.
 *  3. An analysis written inside a `.control` block never runs in batch mode,
 *     and a `quit` inside such a block stops the run before the raw file is
 *     written. The tool flattens control blocks.
 *  4. Without a raw file the tool used to report success with zero variables —
 *     now it reports the failure.
 *  5. ngspice runs only one analysis per plot and silently drops the others
 *     when a netlist mixes `.op` with `.dc`/`.tran`. The tool runs every
 *     analysis separately and reports each result.
 *  6. A `save` list whose vectors do not exist in the circuit (a node inside
 *     a .subckt written without its instance prefix, a typo, a renamed net)
 *     makes ngspice abort with "no data saved for Transient analysis;
 *     analysis not run" — and the raw file then holds only ngspice's built-in
 *     constants, which used to be reported as "no analysis directive found".
 *     The tool validates every signal against the circuit (rewriting internal
 *     nodes to `x1.node`) and re-runs without the save filter as a fallback.
 */

import { writeFile, unlink, readFile, mkdir, access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import {
  autoInstantiateDut,
  autoTestbench,
  convertNetlistToNgspice,
  dedupeDeviceLines,
  ensureAnalysis,
  evaluateOpMeasurement,
  findMeasureDirectives,
  flattenControlBlocks,
  parseNgspiceMeasurements,
  requestedSignals,
  resolveSignals,
  sanitizeSignalDirectives,
  stripOpMeasurementDirectives,
} from "shared/spiceNetlist";
import { applyModelCards, cardsForOptionIds } from "shared/spiceModels";
import type { AssistantSpiceRun } from "shared";

const execFileAsync = promisify(execFile);

const SPICE_BIN = process.env.NGSPICE_BIN ?? "ngspice";
const TIMEOUT_MS = 30_000;

export interface SpiceSimToolArgs {
  /** Full SPICE netlist (takes priority over subcircuit + directives). */
  netlist?: string;
  /**
   * The testbench only: supply sources, loads and an analysis directive.
   * The DUT netlist is added by the caller (the model never has to copy the
   * extracted netlist — that is where it used to go wrong).
   */
  testbench?: string;
  /** DUT netlist used together with `testbench` (supplied by the backend). */
  dutNetlist?: string;
  /** Subcircuit block to simulate (will be prepended to directives). */
  subcircuit?: string;
  /** User directives (.tran, .dc, .ac, sources, etc.). */
  directives?: string;
  /** Analysis type hint for output parsing. */
  analysis?: "tran" | "dc" | "ac";
  /** Path to ngspice binary (overrides env NGSPICE_BIN). */
  binPath?: string;
  /** Standard model options to use (option ids from the standard model library). */
  models?: string[];
}

export interface SpiceSimToolResult {
  success: boolean;
  /** Parsed output variables (v(out), i(Vdd), etc.) */
  variables?: string[];
  /** Number of data points per variable */
  numPoints?: number;
  /** Key measurements extracted from .measure/.meas or evaluated op points */
  measurements?: Record<string, number>;
  /** ngspice stdout/stderr combined */
  output?: string;
  /** Error message if simulation failed */
  error?: string;
  /** The netlist that was actually simulated */
  simulatedNetlist?: string;
  /** What the tool changed / auto-added before running */
  notes?: string[];
  /** Name of the ngspice plot the numbers came from */
  plot?: string;
  /** One entry per analysis the tool ran */
  analyses?: SpiceSimAnalysis[];
  /** Everything the UI needs to show this run (netlist, numbers, notes). */
  run?: AssistantSpiceRun;
}

/** Result of one analysis run. */
export interface SpiceSimAnalysis {
  /** The analysis directive that was run (".op", ".dc V1 0 5 0.1", …). */
  analysis: string;
  /** ngspice plot name ("Operating Point", "DC transfer characteristic", …). */
  plot?: string;
  numPoints: number;
  variables: string[];
  measurements: Record<string, number>;
  /** ngspice output for this run */
  output: string;
  error?: string;
}

/**
 * Build the full netlist from tool arguments.
 *
 * `testbench` + `dutNetlist` is the preferred path: the model writes only the
 * testbench, the DUT netlist comes from the extracted circuit.
 */
function buildNetlist(args: SpiceSimToolArgs): string {
  if (args.netlist) return args.netlist;

  const parts: string[] = [];
  if (args.dutNetlist) {
    parts.push(args.dutNetlist);
    parts.push("");
  }
  if (args.testbench) {
    parts.push("* ── Testbench ──");
    parts.push(args.testbench);
  }
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
 * ngspice ships two Windows binaries: ngspice.exe (GUI subsystem — its stdout
 * is never attached to the parent process, so the model gets no diagnostics)
 * and ngspice_con.exe (console). Prefer the console build.
 */
async function resolveBinary(binPath?: string): Promise<string> {
  const requested = binPath ?? SPICE_BIN;
  // The MCP endpoint does not pass the frontend preference (ngspicePath), so
  // a Windows installation is otherwise invisible unless its directory is on
  // PATH.  Prefer the console build, which exposes stdout/stderr to Node.
  const candidates = [requested];
  if (process.platform === "win32" && !/[/\\]/.test(requested)) {
    candidates.push(
      join(process.env.ProgramFiles ?? "C:\\Program Files", "Spice64", "bin", "ngspice_con.exe"),
      join(process.env.ProgramFiles ?? "C:\\Program Files", "Spice64", "bin", "ngspice.exe")
    );
  }

  for (const candidate of candidates) {
    if (!/\.exe$/i.test(candidate)) continue;
    if (!/ngspice(?:_con)?\.exe$/i.test(candidate)) return candidate;
    const consoleBin = join(dirname(candidate), "ngspice_con.exe");
    try {
      await access(consoleBin);
      return consoleBin;
    } catch {
      try {
        await access(candidate);
        return candidate;
      } catch {
        // Try the next configured/default location.
      }
    }
  }

  return requested;
}

/** Lines from ngspice's output that look like a real problem. */
function extractDiagnostics(output: string): string[] {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.filter((l) =>
    /^(error|warning|fatal|cannot|could not|unknown|singular|doAnalyses|\*\*\*)[: ]/i.test(l) ||
    /simulation interrupted|failed!|not found|no such/i.test(l));
}

const ANALYSIS_LINE_RE = /^\s*\.(op|dc|tran|ac|noise|tf|disto|pz|sens)\b/i;
const MEASURE_LINE_RE = /^\s*\.(meas|measure)\b/i;

/** Analysis type of a directive line ("op", "dc", "tran", …). */
function analysisType(line: string): string {
  return ANALYSIS_LINE_RE.exec(line)?.[1]?.toLowerCase() ?? "";
}

/** Measurement type of a .measure line ("dc", "tran", "ac", "op"). */
function measureType(line: string): string {
  const body = line.trim().replace(/^\.(meas|measure)\b/i, "").trim();
  return body.split(/\s+/)[0]?.toLowerCase() ?? "";
}

interface NetlistPlan {
  /** Circuit lines (devices, models, sources) without analyses/measures. */
  circuit: string[];
  /** Analysis directives, in file order. */
  analyses: string[];
  /** Measurement directives with their analysis type. */
  measures: Array<{ line: string; type: string }>;
  /**
   * Signals `.print`/`.save`/`.measure` ask for. When the testbench names
   * them, the raw file keeps only those vectors instead of every internal
   * node of the chip.
   */
  signals: string[];
  notes: string[];
}

/**
 * Split a netlist into circuit / analyses / measurements and normalise it.
 */
function planNetlist(netlist: string, modelOptionIds: string[] = []): NetlistPlan {
  const notes: string[] = [];

  // Chosen library models first: they replace the generic placeholder cards,
  // so each model name is defined exactly once.
  let source = netlist;
  if (modelOptionIds.length > 0) {
    const { cards, applied, unknown } = cardsForOptionIds(modelOptionIds);
    if (applied.length > 0) {
      const appliedCards = applyModelCards(source, cards);
      source = appliedCards.netlist;
      notes.push(`used the standard model(s): ${applied.join(", ")}`);
      if (appliedCards.overridden.length > 0) {
        notes.push(`replaced the netlist's own card(s) for: ${appliedCards.overridden.join(", ")}`);
      }
    }
    if (unknown.length > 0) notes.push(`ignored unknown model id(s): ${unknown.join(", ")}`);
  }

  // A testbench that forgot the supply or the ground tie simulates to all
  // zeros while looking successful — complete it and report what was assumed.
  const completed = autoTestbench(source);
  source = completed.netlist;
  notes.push(...completed.notes);

  // A subcircuit that is never instantiated is not simulated at all.
  const instantiated = autoInstantiateDut(source);
  source = instantiated.netlist;
  notes.push(...instantiated.notes);

  // A model that writes the same testbench twice (or pastes the DUT twice)
  // would make ngspice bail out with "device already exists".
  const deduped = dedupeDeviceLines(source);
  if (deduped.dropped.length > 0) {
    notes.push(`dropped ${deduped.dropped.length} repeated device line(s): ${deduped.dropped.slice(0, 8).join(", ")}`);
    source = deduped.netlist;
  }

  const converted = convertNetlistToNgspice(source);
  notes.push(...converted.notes);

  // Read the signal list BEFORE the .control block is flattened away: a model
  // that writes `save v(ref)` inside .control still means "plot only this".
  const requested = requestedSignals(converted.netlist);

  const flattened = flattenControlBlocks(converted.netlist);
  if (flattened.hoisted.length > 0) {
    notes.push(`lifted ${flattened.hoisted.length} command(s) out of the .control block: ${flattened.hoisted.join(" | ")}`);
  }
  if (flattened.dropped.length > 0) {
    notes.push(`dropped ${flattened.dropped.length} .control command(s): ${flattened.dropped.join(" | ")}`);
  }

  // ngspice has no `.measure op` — the tool evaluates those itself.
  const stripped = stripOpMeasurementDirectives(flattened.netlist);
  if (stripped.stripped.length > 0) {
    notes.push(`evaluated .measure op directive(s) in the tool (ngspice rejects the 'op' measurement type): ${stripped.stripped.join(" | ")}`);
  }

  // A `.save`/`.print` naming a node the circuit does not have is cleaned
  // here, and the signal list is validated against the deck: an all-unknown
  // `save` list makes ngspice abort the analysis entirely ("no data saved for
  // Transient analysis; analysis not run").
  const sanitized = sanitizeSignalDirectives(stripped.netlist);
  notes.push(...sanitized.notes);
  const signalResolution = resolveSignals(sanitized.netlist, requested);
  notes.push(...signalResolution.notes);
  const signals = signalResolution.resolved;

  const circuit: string[] = [];
  const analyses: string[] = [];
  const measures: Array<{ line: string; type: string }> = [];
  for (const raw of sanitized.netlist.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (ANALYSIS_LINE_RE.test(trimmed)) { analyses.push(trimmed); continue; }
    if (MEASURE_LINE_RE.test(trimmed)) { measures.push({ line: trimmed, type: measureType(trimmed) }); continue; }
    circuit.push(raw);
  }

  // Guarantee an analysis — otherwise ngspice returns its constants plot.
  if (analyses.length === 0) {
    const withAnalysis = ensureAnalysis(circuit.join("\n"));
    notes.push("no analysis directive found (.op/.dc/.tran/.ac) — added .op (DC operating point)");
    for (const line of withAnalysis.netlist.split(/\r?\n/)) {
      if (ANALYSIS_LINE_RE.test(line.trim())) { analyses.push(line.trim()); break; }
    }
  }

  // A model that writes the testbench into BOTH `testbench` and `directives`
  // repeats the analysis (and the measurements). Repeating an analysis never
  // changes the result — drop the copies instead of simulating twice.
  const uniqueAnalyses: string[] = [];
  const duplicateAnalyses: string[] = [];
  for (const analysis of analyses) {
    const key = analysis.toLowerCase().replace(/\s+/g, " ");
    if (uniqueAnalyses.some((u) => u.toLowerCase().replace(/\s+/g, " ") === key)) {
      duplicateAnalyses.push(analysis);
      continue;
    }
    uniqueAnalyses.push(analysis);
  }
  if (duplicateAnalyses.length > 0) {
    notes.push(`dropped ${duplicateAnalyses.length} duplicate analysis directive(s) (${duplicateAnalyses.join(", ")}) — a repeated .op/.dc/.tran/.ac does not change the result, it only runs the same analysis again`);
  }

  const uniqueMeasures: Array<{ line: string; type: string }> = [];
  const duplicateMeasures: string[] = [];
  for (const measure of measures) {
    const key = measure.line.toLowerCase().replace(/\s+/g, " ");
    if (uniqueMeasures.some((m) => m.line.toLowerCase().replace(/\s+/g, " ") === key)) {
      duplicateMeasures.push(measure.line);
      continue;
    }
    uniqueMeasures.push(measure);
  }
  if (duplicateMeasures.length > 0) {
    notes.push(`dropped ${duplicateMeasures.length} duplicate measurement directive(s): ${duplicateMeasures.join(" | ")}`);
  }

  if (uniqueAnalyses.length > 1) {
    notes.push(`the netlist requests ${uniqueAnalyses.length} analyses (${uniqueAnalyses.join(", ")}) — ngspice keeps one plot per run, so each analysis was run separately`);
  }

  return { circuit, analyses: uniqueAnalyses, measures: uniqueMeasures, signals, notes };
}

/** Assemble the netlist for one analysis run. */
function assembleNetlist(plan: NetlistPlan, analysis: string): string {
  const type = analysisType(analysis);
  const measures = plan.measures.filter((m) => m.type === type).map((m) => m.line);
  // `save` runs before `run`, so ngspice writes only the vectors the testbench
  // asked for (`.print`/`.save`/`.measure`) instead of every internal node of
  // the chip. The list is already validated against the circuit — an unknown
  // name here would abort the analysis, not just be ignored.
  const save = plan.signals.length > 0 ? `save ${plan.signals.join(" ")}` : "";
  const controlBlock = [".control", save, "run", "set filetype=ascii", "write sim.raw", "quit", ".endc"]
    .filter((line) => line !== "")
    .join("\n");
  const body = [
    ...plan.circuit,
    analysis,
    ...measures,
    controlBlock,
    ".end",
  ].join("\n");
  return body;
}

interface RawRun {
  plot: string;
  variables: string[];
  varTypes: string[];
  numPoints: number;
  dataMap: Map<string, number[]>;
  measurements: Record<string, number>;
  output: string;
  error?: string;
}

/**
 * Run one netlist through ngspice and parse the raw file it produces.
 */
async function runNgspice(netlist: string, bin: string, runDir: string): Promise<RawRun> {
  // Each run gets its own directory: ngspice writes "sim.raw" relative to its
  // working directory, and the analyses are run one after another.
  const id = randomBytes(6).toString("hex");
  const workDir = join(runDir, id);
  await mkdir(workDir, { recursive: true });
  const cirFile = join(workDir, "sim.cir");
  const rawFile = join(workDir, "sim.raw");

  try {
    await writeFile(cirFile, netlist, "utf-8");
    const { stdout, stderr } = await execFileAsync(
      bin,
      ["-b", "sim.cir"],
      { timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024, cwd: workDir },
    );
    const combined = [stdout, stderr].filter(Boolean).join("\n");

    let rawData = "";
    try {
      rawData = await readFile(rawFile, "utf-8");
    } catch {
      rawData = "";
    }

    const variables: string[] = [];
    const varTypes: string[] = [];
    const dataMap = new Map<string, number[]>();
    let numPoints = 0;
    let plot = "";

    if (rawData.trim()) {
      const rawLines = rawData.split("\n");
      let section: "variables" | "values" | null = null;
      let dataStartIdx = 0;
      for (let i = 0; i < rawLines.length; i++) {
        const trimmed = rawLines[i].trim();
        if (/^plotname:/i.test(trimmed)) {
          plot = trimmed.slice("plotname:".length).trim();
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
      // Data lines come in groups of numVars lines per point.
      const dataLines = rawLines.slice(dataStartIdx).filter((l: string) => l.trim());
      const numVars = variables.length;
      if (numVars > 0) {
        const numPts = Math.floor(dataLines.length / numVars);
        for (const v of variables) dataMap.set(v, []);
        for (let pt = 0; pt < numPts; pt++) {
          for (let v = 0; v < numVars; v++) {
            const line = dataLines[pt * numVars + v]?.trim() ?? "";
            const parts = line.split(/\s+/).filter(Boolean);
            const value = parseFloat(parts[parts.length - 1] ?? "0");
            dataMap.get(variables[v])!.push(value);
          }
        }
        numPoints = numPts;
      }
    }

    const measurements = parseNgspiceMeasurements(combined);
    // ngspice aborts the analysis when the `save` list contains nothing it can
    // find; the raw file then holds only the built-in constants, which would
    // look like "no analysis directive was present". Say what actually happened.
    const saveAborted = /no data saved for/i.test(combined);
    const saveAbortError =
      "ngspice aborted the run because a .save/.print/.measure directive names vectors that do not exist in the circuit: the analysis never produced data. Use node names that exist in the netlist — a node inside a .subckt must be written with the instance prefix, e.g. v(x1.net_122).";

    if (!rawData.trim()) {
      const diagnostics = extractDiagnostics(combined);
      const detail = diagnostics.length > 0
        ? diagnostics.slice(0, 12).join(" | ")
        : combined.split(/\r?\n/).filter((l) => l.trim()).slice(-8).join(" | ");
      return {
        plot, variables, varTypes, numPoints, dataMap, measurements, output: combined,
        error: saveAborted
          ? `${saveAbortError} (ngspice: ${detail})`
          : `ngspice produced no raw output. ${detail || "The simulation produced no data — check the netlist, the analysis directive and the sources."}`,
      };
    }
    if (/^constants$/i.test(plot)) {
      return {
        plot, variables, varTypes, numPoints, dataMap, measurements, output: combined,
        error: saveAborted
          ? saveAbortError
          : "ngspice ran no analysis: the netlist has no .op/.dc/.tran/.ac directive, so only ngspice's built-in constants were returned.",
      };
    }
    if (variables.length === 0) {
      return {
        plot, variables, varTypes, numPoints, dataMap, measurements, output: combined,
        error: "ngspice returned no variables. The circuit was parsed but produced no results — check the device models and the sources.",
      };
    }

    return { plot, variables, varTypes, numPoints, dataMap, measurements, output: combined };
  } catch (err: any) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const detail = err.stdout ?? err.stderr ?? "";
    const combined = [detail].filter(Boolean).join("\n");
    return {
      plot: "", variables: [], varTypes: [], numPoints: 0, dataMap: new Map(),
      measurements: {}, output: combined,
      error: `${errMsg}${combined ? `\n${combined}` : ""}`,
    };
  } finally {
    try { await unlink(cirFile); } catch { /* ok */ }
    try { await unlink(rawFile); } catch { /* ok */ }
    try { const { rmdir } = await import("node:fs/promises"); await rmdir(workDir); } catch { /* ok */ }
  }
}

/**
 * Execute a SPICE simulation via ngspice subprocess.
 */
export async function executeSpiceSimTool(args: SpiceSimToolArgs): Promise<{ text: string; result: SpiceSimToolResult; rawData?: string; rawColumns?: number; varTypes?: string[]; dataColumns?: Record<string, number[]> }> {
  const sourceNetlist = buildNetlist(args);

  if (!sourceNetlist.trim()) {
    return {
      text: JSON.stringify({ error: "No netlist provided. Supply a full netlist, or subcircuit + directives." }),
      result: { success: false, error: "Empty netlist" },
    };
  }

  const plan = planNetlist(sourceNetlist, args.models ?? []);
  const notes = plan.notes;

  const runDir = join(tmpdir(), `mmochip_spice_${randomBytes(8).toString("hex")}`);
  await mkdir(runDir, { recursive: true });

  try {
    const bin = await resolveBinary(args.binPath);
    const runs: SpiceSimAnalysis[] = [];
    const rawRuns: RawRun[] = [];

    for (const analysis of plan.analyses) {
      const netlist = assembleNetlist(plan, analysis);
      let run = await runNgspice(netlist, bin, runDir);
      // Safety net: the save list is validated up front, but ngspice aborts
      // the whole analysis when not one of its vectors exists — the run must
      // not fail because of a filter. Retry once without it.
      if (run.error && /no data saved for/i.test(run.output) && plan.signals.length > 0) {
        const withoutSave = await runNgspice(assembleNetlist({ ...plan, signals: [] }, analysis), bin, runDir);
        if (!withoutSave.error) {
          run = withoutSave;
          notes.push(`ngspice aborted the first attempt because the requested save list had no vector the circuit provides — reran keeping every vector of the ${analysis} analysis`);
        }
      }
      rawRuns.push(run);
      runs.push({
        analysis,
        plot: run.plot || undefined,
        numPoints: run.numPoints,
        variables: run.variables,
        measurements: run.measurements,
        output: run.output,
        error: run.error,
      });
    }

    // The primary result is the last analysis — the one ngspice would keep.
    const primary = rawRuns[rawRuns.length - 1];
    const failed = rawRuns.filter((r) => r.error);

    if (!primary || primary.error) {
      const error = primary?.error ?? "ngspice produced no result.";
      const failedRun: AssistantSpiceRun = {
        ok: false,
        summary: `failed — ${error.split("\n")[0]}`,
        netlist: plan.analyses.length > 0 ? assembleNetlist(plan, plan.analyses[plan.analyses.length - 1]) : sourceNetlist,
        error,
        notes: notes.length > 0 ? notes : undefined,
        analyses: runs.map((r) => ({ analysis: r.analysis, plot: r.plot, numPoints: r.numPoints, error: r.error })),
        at: Date.now(),
      };
      return {
        text: JSON.stringify({ success: false, error, notes, ngspiceOutput: (primary?.output ?? "").slice(0, 2000) }),
        result: { success: false, error, notes, analyses: runs, run: failedRun, output: (primary?.output ?? "").slice(0, 2000) },
      };
    }

    // `.measure op` — ngspice has no op measurement type, so evaluate it here.
    const measurements: Record<string, number> = { ...primary.measurements };
    const opMeasures = findMeasureDirectives(sourceNetlist);
    if (opMeasures.length > 0) {
      const opRun = rawRuns.find((r) => /operating point/i.test(r.plot)) ?? primary;
      const opValues: Record<string, number> = {};
      for (const [name, values] of opRun.dataMap) {
        if (values.length > 0) opValues[name.toLowerCase()] = values[values.length - 1];
      }
      for (const measure of opMeasures) {
        const value = evaluateOpMeasurement(measure.expression, opValues);
        if (value !== null && Number.isFinite(value)) measurements[measure.name] = value;
      }
    }

    // Sample data for the LLM: first/last/min/max per variable.
    const sampleData: Record<string, { first: number; last: number; min: number; max: number }> = {};
    for (const [name, values] of primary.dataMap) {
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

    if (failed.length > 0) {
      notes.push(`ngspice failed for ${failed.length} of ${rawRuns.length} analysis run(s): ${failed.map((r) => r.error?.split("\n")[0]).join(" | ")}`);
    }

    // All-zero result: the DUT is floating — the supply is not connected to
    // its power pins, or the ground node is not "0". Say so, because a run of
    // zeros looks like a valid (but meaningless) answer.
    const warnings: string[] = [];
    const nodeValues = [...primary.dataMap.entries()]
      .filter(([name]) => name.toLowerCase().startsWith("v("))
      .map(([, values]) => values[values.length - 1]);
    if (nodeValues.length > 0 && nodeValues.every((v) => Math.abs(v) < 1e-9)) {
      warnings.push("every node voltage is 0 — the circuit is floating: connect the supply source to the DUT's power pins (e.g. VDD VCC 0 DC 5), make node 0 the ground, and check that the load connects to the output node");
    }

    const simulatedNetlist = assembleNetlist(plan, plan.analyses[plan.analyses.length - 1]);

    // A capped subset of node voltages for the UI (the full list stays in the
    // raw file / dataColumns).
    const keyValues: Record<string, number> = {};
    for (const [name, values] of primary.dataMap) {
      if (values.length === 0) continue;
      if (!/^(v|i)\(/i.test(name)) continue;
      keyValues[name] = values[values.length - 1];
      if (Object.keys(keyValues).length >= 24) break;
    }

    const run: AssistantSpiceRun = {
      ok: true,
      summary: `${primary.plot || "result"} — ${primary.variables.length} variables, ${primary.numPoints} point${primary.numPoints === 1 ? "" : "s"}`,
      // The netlist travels to the browser (and into localStorage): cap it.
      netlist: simulatedNetlist.length > 20_000
        ? `${simulatedNetlist.slice(0, 20_000)}\n* … (netlist truncated)`
        : simulatedNetlist,
      plot: primary.plot || undefined,
      measurements: Object.keys(measurements).length > 0 ? measurements : undefined,
      keyValues,
      notes: [...(warnings.length > 0 ? warnings : []), ...notes],
      analyses: runs.map((r) => ({ analysis: r.analysis, plot: r.plot, numPoints: r.numPoints, error: r.error })),
      at: Date.now(),
    };

    const result: SpiceSimToolResult = {
      success: true,
      variables: primary.variables,
      numPoints: primary.numPoints,
      measurements,
      notes,
      plot: primary.plot || undefined,
      analyses: runs,
      run,
      output: primary.output.slice(0, 2000),
      simulatedNetlist: simulatedNetlist.slice(0, 2000),
    };

    const textForLlm = JSON.stringify({
      success: true,
      summary: `${primary.plot || "result"} — ${primary.variables.length} variables, ${primary.numPoints} point${primary.numPoints === 1 ? "" : "s"}`,
      warning: warnings.length > 0 ? warnings.join(" | ") : undefined,
      // The headline numbers first: the model reads the beginning of the answer.
      measurements: Object.keys(measurements).length > 0 ? measurements : undefined,
      keyValues: Object.keys(keyValues).length > 0 ? keyValues : undefined,
      plot: primary.plot || undefined,
      variables: primary.variables,
      numPoints: primary.numPoints,
      notes: notes.length > 0 ? notes : undefined,
      analyses: runs.map((r) => ({
        analysis: r.analysis,
        plot: r.plot,
        numPoints: r.numPoints,
        measurements: Object.keys(r.measurements).length > 0 ? r.measurements : undefined,
        error: r.error,
      })),
      sampleData,
      ngspiceOutput: primary.output.slice(0, 1000),
    });

    return {
      text: textForLlm,
      result,
      rawData: "",
      rawColumns: primary.variables.length,
      varTypes: primary.varTypes,
      dataColumns: Object.fromEntries(primary.dataMap),
    };
  } catch (err: any) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const error = `${errMsg}`;
    return {
      text: JSON.stringify({ success: false, error, notes }),
      result: { success: false, error, notes },
    };
  } finally {
    try { const { rmdir } = await import("node:fs/promises"); await rmdir(runDir); } catch { /* ok */ }
  }
}

/**
 * OpenAI-compatible tool definition for the LLM.
 */
export const SPICE_SIM_TOOL = {
  type: "function",
  function: {
    name: "mmochip_spice_sim",
    description:
      "Run an ngspice simulation of the extracted circuit with a testbench you write, and return the measured results. You write ONLY the testbench: supply source(s), load(s), exactly one analysis directive and optional .measure lines. The tool adds the DUT netlist itself, converts the extracted Spectre syntax to ngspice, and returns every node voltage / source current plus any `.measure` results (e.g. `.measure dc vout find v(out) at=2.5` — note the `at=` form).\n" +
      "Testbench rules:\n" +
      "- ONE analysis directive only (.op = DC operating point, .dc = sweep, .tran = transient, .ac = AC). Write it in `testbench` OR in `directives`, never in both — a repeated directive is dropped by the tool, it never changes the result.\n" +
      "- The supply MUST be connected to the DUT's power net (a floating supply gives zeros, which is not a result).\n" +
      "- Name only nets that exist in the netlist you were given. A node inside a .subckt is a vector only as v(<instance>.<node>) — the tool rewrites a bare internal node to that form; a node that does not exist at all is dropped and reported in the notes.\n" +
      "- No .control blocks, no .model cards, no DUT devices, no .save/.print lists of guessed node names.\n" +
      "- Example testbench:\nVDD VCC 0 DC 5\nVIN in 0 PULSE(0 5 0 100p 100p 49n 100n)\nRLOAD out 0 10k\n.tran 1ns 500ns uic\n.measure tran vout_max MAX v(out)\n" +
      "Use this to verify circuit behavior — e.g. compute gain, bandwidth, PSRR, transient response, DC operating point. The simulation runs server-side with ngspice in batch mode. If a run fails, read the returned error and the notes, fix the testbench and retry.",
    parameters: {
      type: "object",
      properties: {
        testbench: {
          type: "string",
          description:
            "The testbench only: supply sources ('VDD VCC 0 DC 5'), stimulus ('VIN in 0 PULSE(0 5 0 100p 100p 49n 100n)'), loads ('RLOAD out 0 10k'), ONE analysis directive (.op / .dc V1 0 5 0.01 / .tran 1ns 500ns uic / .ac dec 10 1 1meg) and optional .measure lines. Net names must come from the extracted netlist; the DUT netlist is supplied by the tool.",
        },
        netlist: {
          type: "string",
          description: "Optional: a full netlist instead of a testbench (DUT + testbench in one piece). Only when the circuit under test is not the extracted one.",
        },
        subcircuit: {
          type: "string",
          description: ".subckt block to simulate. Will be combined with the directives field.",
        },
        directives: {
          type: "string",
          description:
            "ngspice directives appended AFTER the testbench: source definitions (VDD, VIN), load caps, .measure commands. Only put the analysis directive (.op, .dc, .tran, .ac) here when `testbench` does not already contain one.",
        },
        analysis: {
          type: "string",
          enum: ["tran", "dc", "ac"],
          description: "Hint for the type of analysis being performed (for output parsing guidance).",
        },
        binPath: {
          type: "string",
          description: "Path to ngspice binary (e.g. 'C:\\Program Files\\Spice64\\bin\\ngspice_con.exe' on Windows, or 'ngspice' if in PATH).",
        },
        models: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional: standard device models to use instead of the generic placeholders, one per device type. Available ids: nmos-level1, nmos-ekv, nmos-bsim4, pmos-level1, pmos-ekv, pmos-bsim4, npn-gp, npn-em, pnp-gp, pnp-em, diode-generic, zener-5v6, zener-12v, schottky-generic. A model already defined in the netlist is replaced by the chosen one.",
        },
      },
    },
  },
} as const;
