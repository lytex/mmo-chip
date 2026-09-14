/**
 * useSpiceAgent — orchestrates the spice simulation agent loop.
 *
 * Flow:
 *   1. User types prompt
 *   2. Send prompt + netlist to LLM → get directives
 *   3. Run simulation with those directives
 *   4. If error → send error back to LLM → get fixed directives → retry
 *   5. If .meas results → send to LLM for analysis
 *   6. Loop until success or max iterations (5)
 *   7. Never modify DUT netlist — only testbench directives
 */

import { useCallback, useRef, useState } from "react";
import { apiPost } from "../../api/client";
import { runFullSimulation } from "./spiceService";
import type { SpiceAgentTurn, SpiceSimulationOutput } from "./types";
import type { AssistantLlmConfig } from "shared";

const MAX_ITERATIONS = 5;

type Props = {
  dieId: string;
  netlist: string;
  llmConfig?: AssistantLlmConfig;
  onDirectivesUpdate: (directives: string) => void;
};

export function useSpiceAgent({ dieId, netlist, llmConfig, onDirectivesUpdate }: Props) {
  const [turns, setTurns] = useState<SpiceAgentTurn[]>([]);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");
  const abortRef = useRef(false);

  const runAgentLoop = useCallback(async (userPrompt: string) => {
    if (running) return;
    setRunning(true);
    abortRef.current = false;
    setStatus("thinking...");

    const allTurns: SpiceAgentTurn[] = [{ role: "user", content: userPrompt }];
    setTurns([...allTurns]);

    let currentDirectives = "";
    let lastErrors: string[] = [];
    let lastMeasurements: Record<string, number> | undefined;

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      if (abortRef.current) break;

      // Build history for LLM
      const history = allTurns.map((t) => ({
        role: t.role === "user" ? "user" : "assistant",
        content: t.content,
        directives: t.directives,
        simResult: t.simResult,
      }));

      // Build prompt with error context
      let prompt = userPrompt;
      if (iter > 0 && lastErrors.length > 0) {
        prompt = `Previous attempt failed with errors:\n${lastErrors.join("\n")}\n\nFix the directives and retry. Keep the same DUT netlist, only fix the testbench (sources, loads, analysis settings).`;
        if (lastMeasurements && Object.keys(lastMeasurements).length > 0) {
          prompt += `\n\nPrevious measurements: ${JSON.stringify(lastMeasurements)}`;
        }
      }

      setStatus(`iteration ${iter + 1}/${MAX_ITERATIONS}: asking LLM...`);

      // Call LLM
      let llmResponse: { ok: boolean; content?: string; directives?: string; error?: string };
      try {
        llmResponse = await apiPost(`/api/dies/${dieId}/assistant/spice-chat`, {
          netlist,
          prompt,
          history,
          llmConfig,
        }) as { ok: boolean; content?: string; directives?: string; error?: string };
      } catch (err) {
        allTurns.push({ role: "agent", content: `Error calling LLM: ${err instanceof Error ? err.message : String(err)}` });
        setTurns([...allTurns]);
        break;
      }

      if (!llmResponse.ok || !llmResponse.content) {
        allTurns.push({ role: "agent", content: `LLM error: ${llmResponse.error ?? "unknown"}` });
        setTurns([...allTurns]);
        break;
      }

      const directives = llmResponse.directives ?? "";
      currentDirectives = directives;

      if (!directives) {
        // LLM didn't generate directives — just a text response
        allTurns.push({ role: "agent", content: llmResponse.content });
        setTurns([...allTurns]);
        break;
      }

      // Update the directive editor
      onDirectivesUpdate(directives);

      // Run simulation
      setStatus(`iteration ${iter + 1}/${MAX_ITERATIONS}: running simulation...`);

      // Build full simulation netlist
      const simNetlist = buildSimNetlist(netlist, directives);

      let simOutput: SpiceSimulationOutput;
      try {
        simOutput = await runFullSimulation(simNetlist);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        lastErrors = [errMsg];
        allTurns.push({
          role: "agent",
          content: llmResponse.content,
          directives,
          simResult: { ok: false, errors: [errMsg] },
        });
        setTurns([...allTurns]);
        continue; // retry
      }

      const hasErrors = simOutput.errors.length > 0 ||
        simOutput.raw.numPoints === 0 ||
        simOutput.waveforms.length === 0;

      if (hasErrors) {
        lastErrors = simOutput.errors.length > 0
          ? simOutput.errors
          : ["No output data (0 points or 0 waveforms)"];
        lastMeasurements = undefined;

        allTurns.push({
          role: "agent",
          content: llmResponse.content,
          directives,
          simResult: { ok: false, errors: lastErrors, numPoints: simOutput.raw.numPoints },
        });
        setTurns([...allTurns]);
        continue; // retry with error feedback
      }

      // Success — extract measurements and analyze
      const measurements: Record<string, number> = {};
      for (const v of simOutput.raw.data) {
        if (v.values.length > 0) {
          const last = v.values[v.values.length - 1];
          measurements[v.name] = typeof last === "number" ? last : (last as any).real ?? 0;
        }
      }
      lastMeasurements = measurements;

      allTurns.push({
        role: "agent",
        content: llmResponse.content,
        directives,
        simResult: {
          ok: true,
          errors: [],
          measurements,
          variableNames: simOutput.raw.variableNames,
          numPoints: simOutput.raw.numPoints,
        },
      });
      setTurns([...allTurns]);

      // Ask LLM to analyze the results
      setStatus(`iteration ${iter + 1}/${MAX_ITERATIONS}: analyzing results...`);

      const analysisPrompt = `Simulation completed successfully. Results:\n- Variables: ${simOutput.raw.variableNames.join(", ")}\n- Points: ${simOutput.raw.numPoints}\n- Measurements: ${JSON.stringify(measurements, null, 2)}\n\nAnalyze these results and answer the user's original question: "${userPrompt}"`;

      try {
        const analysisHistory = [...history, { role: "assistant", content: llmResponse.content, directives, simResult: allTurns[allTurns.length - 1].simResult }];
        const analysisRes = await apiPost(`/api/dies/${dieId}/assistant/spice-chat`, {
          netlist,
          prompt: analysisPrompt,
          history: analysisHistory,
          llmConfig,
        }) as { ok: boolean; content?: string };

        if (analysisRes.ok && analysisRes.content) {
          allTurns.push({ role: "agent", content: analysisRes.content });
          setTurns([...allTurns]);
        }
      } catch {
        // Analysis failed, but simulation succeeded — that's OK
      }

      break; // done
    }

    setRunning(false);
    setStatus("");
  }, [running, dieId, netlist, llmConfig, onDirectivesUpdate]);

  const abort = useCallback(() => { abortRef.current = true; }, []);

  return { turns, running, status, runAgentLoop, abort };
}

/**
 * Build full simulation netlist: models + DUT + LLM directives.
 * Strips any existing directives from the DUT netlist to avoid duplication.
 */
function buildSimNetlist(dutNetlist: string, directives: string): string {
  const parts: string[] = [];

  // Extract ONLY models + DUT (strip existing directives section)
  const dutOnly = extractDutOnly(dutNetlist);

  // Auto-generated models from the DUT netlist
  const modelLines = dutOnly.split("\n").filter((l) => /^\.\s*model\b/i.test(l.trim()));
  if (modelLines.length > 0) {
    parts.push(...modelLines);
    parts.push("");
  }

  // DUT netlist (no directives)
  parts.push(dutOnly);
  parts.push("");

  // Clean LLM directives (strip any accidental DUT content)
  const cleanDirectives = stripDutContent(directives);
  parts.push(cleanDirectives);

  return parts.join("\n");
}

/**
 * Extract only model cards and DUT from a full netlist.
 * Strips everything after "* ── Directives ──" or similar markers.
 */
function extractDutOnly(netlist: string): string {
  const lines = netlist.split("\n");
  const result: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    // Stop at directives markers
    if (/^\*\s*─+\s*Directives?\s*─+/i.test(t)) break;
    if (/^\*\s*─+\s*User\s+Directives/i.test(t)) break;
    result.push(line);
  }
  return result.join("\n").trimEnd();
}

/**
 * Remove DUT-internal content from LLM-generated directives.
 * Keeps only testbench lines: V/I sources, X1 instantiation, R/C loads,
 * analysis directives, output directives.
 */
function stripDutContent(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let inSubckt = false;

  for (const line of lines) {
    const t = line.trim();

    // Skip .subckt/.ends blocks (DUT)
    if (/^\.subckt\b/i.test(t)) { inSubckt = true; continue; }
    if (/^\.ends\b/i.test(t)) { inSubckt = false; continue; }
    if (inSubckt) continue;

    // Skip .model cards (auto-generated)
    if (/^\.\s*model\b/i.test(t)) continue;

    // Skip DUT-internal device instances (inside .subckt was already caught above,
    // but if LLM puts them outside .subckt, skip known DUT device names)
    // Keep everything else: V*, I*, R*, X*, .dc, .tran, .ac, .op, .print, .control, etc.
    result.push(line);
  }

  return result.join("\n");
}
