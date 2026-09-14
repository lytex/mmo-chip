import { Router } from "express";
import type { AssistantAnalysisRequest, AssistantDiscussRequest, AssistantLvsCheckRequest, AssistantLvsCheckResponse } from "shared";
import { readAnnotations, readDieRecord } from "../store.js";
import { prepareAssistantSnapshot } from "../assistant/assistantSnapshot.js";
import { analyseFullGraphWithLlm, discussFindingWithLlm } from "../assistant/llmGraphAnalysis.js";
import { emitSubcircuitSpice } from "../assistant/subcircuitExtract.js";
import { loadLibrary, listLibraries, addSpiceCell, DEFAULT_LIBRARY_ID, type LvsLibrary, type LvsLibraryCell } from "../assistant/lvsLibrary.js";
import { matchSubcircuit } from "../assistant/lvsMatch.js";
import { dedupeCells } from "../assistant/lvsDedup.js";
import { pendingVisionRequests } from "../assistant/visionTool.js";
import { executeSpiceSimTool, type SpiceSimToolArgs } from "../assistant/spiceSimTool.js";

/**
 * The assistant router is intentionally read-only. It validates the current
 * annotation revision, analyses the browser extraction snapshot, and never
 * calls writeAnnotations or a mutation endpoint.
 */
export function createAssistantRouter(config: { dataRoot: string }) {
  const router = Router();

  router.post("/api/dies/:dieId/assistant/analyze", async (request, response) => {
    try {
      const { dieId } = request.params;
      await readDieRecord(config.dataRoot, dieId);
      const annotations = await readAnnotations(config.dataRoot, dieId);
      const body = (request.body ?? {}) as AssistantAnalysisRequest;

      if (!body.circuit || !Array.isArray(body.circuit.devices) || !Array.isArray(body.circuit.namedNets)) {
        response.status(400).json({ ok: false, error: "A serialised circuit snapshot with devices and namedNets is required." });
        return;
      }
      if (body.expectedRev != null && body.expectedRev !== annotations.rev) {
        response.status(409).json({
          ok: false,
          error: "The annotations changed before analysis could start.",
          detail: `Expected revision ${body.expectedRev}, current revision ${annotations.rev}. Refresh the extracted circuit and retry.`,
        });
        return;
      }

      const prepared = prepareAssistantSnapshot(dieId, annotations.rev, body);
      const data = await analyseFullGraphWithLlm(prepared, body.circuit, body.llmConfig, body.assistantDataFlags, undefined, {
        mode: body.clarificationMode,
        answers: body.clarificationAnswers,
      });
      response.json({ ok: true, data });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown LLM error";
      if (/required|exceeds/.test(reason)) {
        response.status(400).json({ ok: false, error: reason });
        return;
      }
      console.error(`[assistant/analyze] failed for ${request.params.dieId}: ${reason}`);
      response.status(502).json({ ok: false, error: `Assistant analysis failed: ${reason}` });
    }
  });

  router.post("/api/dies/:dieId/assistant/analyze/stream", async (request, response) => {
    const { dieId } = request.params;
    try {
      await readDieRecord(config.dataRoot, dieId);
      const annotations = await readAnnotations(config.dataRoot, dieId);
      const body = (request.body ?? {}) as AssistantAnalysisRequest;
      if (!body.circuit || !Array.isArray(body.circuit.devices) || !Array.isArray(body.circuit.namedNets)) {
        response.status(400).json({ ok: false, error: "A serialised circuit snapshot with devices and namedNets is required." });
        return;
      }
      if (body.expectedRev != null && body.expectedRev !== annotations.rev) {
        response.status(409).json({
          ok: false,
          error: "The annotations changed before analysis could start.",
          detail: `Expected revision ${body.expectedRev}, current revision ${annotations.rev}. Refresh the extracted circuit and retry.`,
        });
        return;
      }

      const prepared = prepareAssistantSnapshot(dieId, annotations.rev, body);

      response.setHeader("Content-Type", "text/event-stream");
      response.setHeader("Cache-Control", "no-cache");
      response.setHeader("Connection", "keep-alive");
      response.setHeader("X-Accel-Buffering", "no");
      response.flushHeaders?.();
      const sendEvent = (event: string, payload: unknown) => {
        try { response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`); } catch { /* client gone */ }
      };
      // Keep the SSE connection visibly alive while the LLM streams slowly:
      // reasoning models can pause for tens of seconds between token bursts.
      const heartbeat = setInterval(() => sendEvent("heartbeat", {}), 10_000);

      const data = await analyseFullGraphWithLlm(
        prepared,
        body.circuit,
        body.llmConfig,
        body.assistantDataFlags,
        (ev) => {
          if (ev.type === "token") sendEvent("token", { content: ev.content });
          else if (ev.type === "thinking") sendEvent("thinking", { content: ev.content });
          else if (ev.type === "questions") sendEvent("questions", { questions: ev.questions });
        },
        { mode: body.clarificationMode, answers: body.clarificationAnswers },
      );
      clearInterval(heartbeat);
      sendEvent("done", { ok: true, data });
      response.end();
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown LLM error";
      console.error(`[assistant/analyze/stream] failed for ${request.params.dieId}: ${reason}`);
      if (response.headersSent) {
        try {
          response.write(`event: error\ndata: ${JSON.stringify({ ok: false, error: `Assistant analysis failed: ${reason}` })}\n\n`);
          response.end();
        } catch { /* ignore */ }
      } else if (/required|exceeds/.test(reason)) {
        response.status(400).json({ ok: false, error: reason });
      } else {
        response.status(502).json({ ok: false, error: `Assistant analysis failed: ${reason}` });
      }
    }
  });

  router.post("/api/dies/:dieId/assistant/discuss", async (request, response, next) => {
    try {
      const { dieId } = request.params;
      await readDieRecord(config.dataRoot, dieId);
      const annotations = await readAnnotations(config.dataRoot, dieId);
      const body = (request.body ?? {}) as AssistantDiscussRequest;
      if (!body.finding || !Array.isArray(body.finding.deviceUuids) || !body.circuit || !Array.isArray(body.circuit.devices)) {
        response.status(400).json({ ok: false, error: "A finding and a serialised circuit snapshot are required." });
        return;
      }
      if (body.expectedRev != null && body.expectedRev !== annotations.rev) {
        response.status(409).json({
          ok: false,
          error: "The annotations changed before discussion could start.",
          detail: `Expected revision ${body.expectedRev}, current revision ${annotations.rev}. Refresh the extracted circuit and retry.`,
        });
        return;
      }
      const { reply, durationMs, cardUpdate, lvsResults } = await discussFindingWithLlm(
        body.finding,
        Array.isArray(body.messages) ? body.messages : [],
        body.circuit,
        body.llmConfig,
        body.brief ?? {},
        body.mode ?? "functional_blocks",
        config.dataRoot,
        body.toolFlags,
        dieId,
        body.assistantDataFlags,
      );
      response.json({ ok: true, reply, durationMs, cardUpdate: cardUpdate ?? null, lvsResults: lvsResults ?? [] });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown LLM error";
      console.error(`[assistant/discuss] failed for ${request.params.dieId}: ${reason}`);
      response.status(502).json({ ok: false, error: `Assistant discussion failed: ${reason}` });
    }
  });

  router.post("/api/dies/:dieId/assistant/discuss/stream", async (request, response) => {
    const { dieId } = request.params;
    try {
      await readDieRecord(config.dataRoot, dieId);
      const annotations = await readAnnotations(config.dataRoot, dieId);
      const body = (request.body ?? {}) as AssistantDiscussRequest;
      if (!body.finding || !Array.isArray(body.finding.deviceUuids) || !body.circuit || !Array.isArray(body.circuit.devices)) {
        response.status(400).json({ ok: false, error: "A finding and a serialised circuit snapshot are required." });
        return;
      }
      if (body.expectedRev != null && body.expectedRev !== annotations.rev) {
        response.status(409).json({
          ok: false,
          error: "The annotations changed before discussion could start.",
          detail: `Expected revision ${body.expectedRev}, current revision ${annotations.rev}. Refresh the extracted circuit and retry.`,
        });
        return;
      }

      response.setHeader("Content-Type", "text/event-stream");
      response.setHeader("Cache-Control", "no-cache");
      response.setHeader("Connection", "keep-alive");
      response.setHeader("X-Accel-Buffering", "no");
      response.flushHeaders?.();
      const sendEvent = (event: string, payload: unknown) => {
        try { response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`); } catch { /* client gone */ }
      };
      // Keep the SSE connection visibly alive while the LLM streams slowly:
      // reasoning models can pause for tens of seconds between token bursts.
      const heartbeat = setInterval(() => sendEvent("heartbeat", {}), 10_000);

      const { reply, durationMs, cardUpdate, lvsResults } = await discussFindingWithLlm(
        body.finding,
        Array.isArray(body.messages) ? body.messages : [],
        body.circuit,
        body.llmConfig,
        body.brief ?? {},
        body.mode ?? "functional_blocks",
        config.dataRoot,
        body.toolFlags,
        dieId,
        body.assistantDataFlags,
        (ev) => {
          if (ev.type === "token") sendEvent("token", { content: ev.content });
          else if (ev.type === "thinking") sendEvent("thinking", { content: ev.content });
          else if (ev.type === "tool_start") sendEvent("tool_start", { tool: ev.tool, args: ev.args });
          else if (ev.type === "tool_result") sendEvent("tool_result", { tool: ev.tool, ok: ev.ok, images: ev.images });
        },
      );
      clearInterval(heartbeat);
      sendEvent("done", { ok: true, reply, durationMs, cardUpdate: cardUpdate ?? null, lvsResults: lvsResults ?? [] });
      response.end();
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown LLM error";
      console.error(`[assistant/discuss/stream] failed for ${request.params.dieId}: ${reason}`);
      if (response.headersSent) {
        try {
          response.write(`event: error\ndata: ${JSON.stringify({ ok: false, error: `Assistant discussion failed: ${reason}` })}\n\n`);
          response.end();
        } catch { /* ignore */ }
      } else {
        response.status(502).json({ ok: false, error: `Assistant discussion failed: ${reason}` });
      }
    }
  });

  // ── LVS reference-library check (standalone, used by the manual card button) ──

  router.get("/api/dies/:dieId/assistant/lvs-libraries", async (_request, response) => {
    try {
      const libs = await listLibraries(config.dataRoot);
      response.json({ ok: true, data: libs });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown error";
      response.status(500).json({ ok: false, error: reason });
    }
  });

  router.post("/api/dies/:dieId/assistant/lvs-check", async (request, response) => {
    try {
      const body = (request.body ?? {}) as AssistantLvsCheckRequest;
      if (!body.circuit || !Array.isArray(body.circuit.devices) || !Array.isArray(body.deviceUuids)) {
        response.status(400).json({ ok: false, error: "A circuit snapshot and deviceUuids are required." });
        return;
      }
      const candidate = emitSubcircuitSpice(body.circuit.devices, body.circuit.namedNets, body.deviceUuids);
      const topologies = Array.isArray(body.topologies) && body.topologies.length > 0 ? body.topologies : null;

      let library: LvsLibrary | null = null;
      if (topologies) {
        // Search the selected topology groups across every available library.
        const libs = await listLibraries(config.dataRoot);
        const cells: LvsLibraryCell[] = [];
        for (const lib of libs) {
          const full = await loadLibrary(config.dataRoot, lib.libId);
          if (full) cells.push(...full.cells.filter((cell) => topologies.includes(cell.topology ?? "")));
        }
        library = cells.length > 0 ? { libId: "filtered", cells } : null;
      } else {
        const libId = body.libraryId || DEFAULT_LIBRARY_ID;
        library = await loadLibrary(config.dataRoot, libId);
        if (!library) {
          response.status(404).json({
            ok: false,
            error: `Reference library '${libId}' not found. Import it (scripts/import-analog-circuits) or add a user library.`,
          });
          return;
        }
      }

      if (!library || library.cells.length === 0) {
        response.status(404).json({
          ok: false,
          error: topologies
            ? `No reference cells found for topologies: ${topologies.join(", ")}.`
            : `Reference library '${body.libraryId || DEFAULT_LIBRARY_ID}' is empty.`,
        });
        return;
      }

      // Collapse topologically-identical reference cells so vyges-lvs runs once
      // per unique topology+connectivity rather than once per parameter variant.
      const dedup = dedupeCells(library.cells);
      const dedupedLibrary: LvsLibrary = { libId: library.libId, cells: dedup.representatives };
      const totalCells = dedup.originalCount;

      // When the user explicitly narrowed to topology groups, the structural
      // prefilter (signature distance ≤ tolerance) would otherwise drop the
      // entire group for a small candidate (e.g. 2 NMOS vs 3,506 bandgaps) and
      // report "0 cells compared". Relax it so the selected group is actually
      // checked (capped by budget), and stream progress so long checks stay
      // visible in the UI.
      const tolerance = topologies ? Number.MAX_SAFE_INTEGER : (body.tolerance ?? 3);

      // Stream progress via Server-Sent Events so large group checks don't hit
      // the request timeout and the UI can show a live count.
      response.setHeader("Content-Type", "text/event-stream");
      response.setHeader("Cache-Control", "no-cache");
      response.setHeader("Connection", "keep-alive");
      response.flushHeaders?.();
      const sendEvent = (event: string, payload: unknown) => {
        response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      };

      const summary = await matchSubcircuit(candidate, dedupedLibrary, {
        tolerance,
        budget: body.budget ?? 50,
        onProgress: (checked, total) => sendEvent("progress", { checked, total }),
      });

      const data: AssistantLvsCheckResponse["data"] = {
        candidateSignature: summary.candidateSignature,
        candidateNetlist: summary.candidateNetlist,
        checkedCount: summary.checkedCount,
        totalCells,
        uniqueCells: dedupedLibrary.cells.length,
        matches: summary.matches,
        best: summary.best,
        topologyCounts: summary.topologyCounts,
      };
      sendEvent("result", { ok: true, data });
      response.end();
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown error";
      console.error(`[assistant/lvs-check] failed: ${reason}`);
      try {
        response.write(`event: error\ndata: ${JSON.stringify({ ok: false, error: `LVS check failed: ${reason}` })}\n\n`);
      } catch {
        /* ignore */
      }
      response.end();
    }
  });

  router.post("/api/dies/:dieId/assistant/lvs-library/:libId/cell", async (request, response) => {
    try {
      const { libId } = request.params;
      const { cellId, spice } = (request.body ?? {}) as { cellId?: string; spice?: string };
      if (!cellId || !spice) {
        response.status(400).json({ ok: false, error: "cellId and spice are required." });
        return;
      }
      const library = await addSpiceCell(config.dataRoot, libId, cellId, spice);
      response.json({ ok: true, data: { libId: library.libId, cellCount: library.cells.length } });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown error";
      response.status(502).json({ ok: false, error: `Add cell failed: ${reason}` });
    }
  });

  // ── Vision tool: pending requests and result delivery ──

  router.get("/api/dies/:dieId/assistant/pending-vision", (request, response) => {
    const { dieId } = request.params;
    const pending = [...pendingVisionRequests.values()]
      .filter((r) => r.dieId === dieId)
      .map((r) => ({ requestId: r.requestId, deviceUuids: r.deviceUuids, devices: r.devices, layerName: r.layerName }));
    response.json({ ok: true, requests: pending });
  });

  router.post("/api/dies/:dieId/assistant/vision-result/:requestId", (request, response) => {
    const { requestId } = request.params;
    const body = (request.body ?? {}) as { images?: string[]; layerName?: string };
    const req = pendingVisionRequests.get(requestId);
    if (!req) {
      response.status(404).json({ ok: false, error: `Vision request ${requestId} not found or already consumed.` });
      return;
    }
    pendingVisionRequests.delete(requestId);
    req.resolve(body.images ?? [], body.layerName);
    response.json({ ok: true });
  });

  // ── SPICE simulation chat ────────────────────────────────────────
  // Simple LLM chat for generating ngspice testbench directives.
  // The LLM receives the netlist + user prompt and returns directives.

  router.post("/api/dies/:dieId/assistant/spice-chat", async (request, response) => {
    try {
      const body = (request.body ?? {}) as { netlist?: string; prompt?: string; history?: Array<{ role: string; content: string }>; llmConfig?: { provider?: string; apiKey?: string; baseUrl?: string; model?: string } };
      if (!body.prompt) {
        response.status(400).json({ ok: false, error: "prompt is required" });
        return;
      }

      // Use client-provided llmConfig (from SettingsPanel) with env fallback
      const usingOpenRouter = Boolean(body.llmConfig?.apiKey || process.env.OPENROUTER_API_KEY);
      const apiKey = body.llmConfig?.apiKey || process.env.ASSISTANT_LLM_API_KEY || process.env.OPENROUTER_API_KEY;
      const baseUrl = body.llmConfig?.baseUrl || process.env.ASSISTANT_LLM_BASE_URL || (usingOpenRouter ? "https://openrouter.ai/api/v1" : undefined);
      const model = body.llmConfig?.model || process.env.ASSISTANT_LLM_MODEL || (usingOpenRouter ? "minimax/minimax-m3:free" : undefined);

      if (!apiKey || !baseUrl || !model) {
        response.status(400).json({ ok: false, error: "LLM not configured. Set provider settings in Settings panel or environment variables." });
        return;
      }

      const systemPrompt = `You are an expert SPICE simulation engineer. You generate testbench directives for ngspice.

CRITICAL RULES:
- The DUT (device under test) is ALREADY connected in the netlist as X1. DO NOT include the .subckt definition, .model cards, or any DUT-internal components.
- Your output should contain ONLY the testbench: voltage/current sources, loads, analysis commands, and output commands.
- The subcircuit port order is: X1 GND_1 net230 ref VDD GND bandgap (match the .subckt definition)

YOUR OUTPUT MUST INCLUDE (in this order):
1. Voltage/current sources (VDD, input sources, ground references)
2. Subcircuit instantiation (X1 ports subcktname)
3. Load components (resistors, capacitors)
4. Analysis directives (.dc, .tran, .ac, .op)
5. Output directives (.print, .control/.endc if needed)
6. .end

DO NOT output:
- .model cards (already included automatically)
- .subckt/.ends blocks (DUT is provided separately)
- Any device inside the DUT

Example of CORRECT output:
VDD VDD 0 DC 3.3
X1 GND_1 net230 ref VDD GND bandgap
Rload ref 0 10k
.dc VDD 0 5 0.01
.print dc V(ref) V(net230) I(VDD)
.end

Example of WRONG output (DO NOT DO THIS):
.subckt bandgap ...
Q10 ...
.model npn NPN ...
... (all DUT internals)
VDD VDD 0 DC 3.3
.end`;

      const messages: unknown[] = [
        { role: "system", content: systemPrompt },
      ];

      // Add conversation history
      if (Array.isArray(body.history)) {
        for (const msg of body.history.slice(-10)) {
          messages.push({ role: msg.role, content: msg.content });
        }
      }

      // Add current prompt with netlist context
      let userMessage = body.prompt;
      if (body.netlist) {
        userMessage = `Current netlist:\n\`\`\`spice\n${body.netlist}\n\`\`\`\n\nRequest: ${body.prompt}`;
      }
      messages.push({ role: "user", content: userMessage });

      const { streamChatCompletion } = await import("../assistant/llmStream.js");
      const result = await streamChatCompletion({
        baseUrl, apiKey, model,
        messages,
        maxTokens: 4000,
        timeoutMs: 60_000,
      });

      // Extract directives from response (same logic as frontend)
      const directives = extractSpiceDirectives(result.content);

      response.json({ ok: true, content: result.content, directives });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown LLM error";
      console.error(`[assistant/spice-chat] failed: ${reason}`);
      response.status(502).json({ ok: false, error: `Spice chat failed: ${reason}` });
    }
  });

  // ── Server-side ngspice run endpoint ───────────────────────
  router.post("/api/ngspice/run", async (request, response) => {
    try {
      const body = (request.body ?? {}) as SpiceSimToolArgs;
      if (!body.netlist && !body.subcircuit && !body.directives) {
        response.status(400).json({ ok: false, error: "Provide netlist, or subcircuit + directives." });
        return;
      }
      const { result, rawData, varTypes, dataColumns } = await executeSpiceSimTool(body);
      response.json({ ok: result.success, ...result, rawData, varTypes, dataColumns });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown error";
      console.error(`[ngspice/run] failed: ${reason}`);
      response.status(500).json({ ok: false, error: reason });
    }
  });

  return router;
}

/**
 * Extract SPICE directives from LLM response text.
 * Matches: code blocks, device instances (.model, V*, I*, R*, X*, etc.)
 */
function extractSpiceDirectives(text: string): string | null {
  const codeBlock = text.match(/```(?:spice|ngspice)?\s*\n([\s\S]*?)```/i);
  if (codeBlock) return codeBlock[1].trim();

  const lines = text.split("\n");
  const spiceLines: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("*") || t.startsWith("//")) { spiceLines.push(t); continue; }
    if (/^\.[a-zA-Z]/.test(t)) { spiceLines.push(t); continue; }
    if (/^[A-Za-z][A-Za-z0-9_]*\s/.test(t)) { spiceLines.push(t); continue; }
  }
  return spiceLines.length > 0 ? spiceLines.join("\n") : null;
}
