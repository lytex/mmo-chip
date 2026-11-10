/**
 * SpiceSimulationPage — SPICE simulation tab.
 *
 * Left panel  — subcircuit picker (incl. AI findings) + model file + directives + LLM chat
 * Right panel — DUT header + waveform/schematic/netlist tabs + collapsible output
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AppShell } from "../components/shell/AppShell";
import { SubBar } from "../components/shell/SubBar";
import { PanelToggle, usePanelCollapsed } from "../components/shell/PanelToggle";
import { WaveformViewer, type WaveformViewerHandle } from "../components/simulation/WaveformViewer";
import { SchematicViewPanel } from "../components/netlist/SchematicViewPanel";
import { SubcircuitPicker, parseSubcircuits, filterTopLevel, type SubcircuitEntry } from "../components/simulation/SubcircuitPicker";
import { DirectiveEditor, DEFAULT_DIRECTIVES } from "../components/simulation/DirectiveEditor";
import { CollapsibleSection } from "../components/simulation/CollapsibleSection";
import { SpiceChatPanel } from "../components/simulation/SpiceChatPanel";
import { ModelEditorPopup } from "../components/simulation/ModelEditorPopup";
import { TestbenchSchematic } from "../components/simulation/TestbenchSchematic";
import { detectDutName } from "../lib/schematic/testbench";
import { SettingsPanel } from "../components/dieViewer/SettingsPanel";
import { initSpice, runWithStepSupport, terminateSpice } from "../lib/simulation/spiceService";
import { spectreToNgspice } from "../lib/simulation/spectreToNgspice";
import { findingsToSubcircuits } from "../lib/simulation/findingsToSubcircuits";
import { useModelFile, useDirectives, useModelSelection } from "../lib/simulation/useSpicePersistence";
import { composeSimulationNetlist, extractModelCards } from "shared/spiceModels";
import { buildTestbenchViewNetlist, splitSimulationSections } from "shared/spiceNetlist";
import { useAssistantSession } from "../state/assistantSession";
import { useSpiceHandoff, type SpiceHandoff } from "../state/spiceHandoff";
import { fetchLatestSpiceHandoff } from "../api/spiceHandoff";
import { collectDieWideAnalogDevices } from "../api/dieWideAnalog";
import type { SpiceSimulationOutput } from "../lib/simulation/types";
import { useDie } from "../api/dies";
import { useAnnotations } from "../api/annotations";
import { useAnnotationsWebSocket } from "../api/annotationsWebSocket";
import { useSession } from "../state/session";
import { usePreferences } from "../state/preferences";
import { DEFAULT_CAP_DENSITY } from "../lib/export/capacitorDefaults";
import { useAnalogNetlist, loadSpiceConfig } from "../api/analogNetlist";
import type { SpiceConfig, SpiceDialect } from "shared";

const DEFAULT_MODEL_FILE = `* ── Custom Models ──
* .MODEL myNPN NPN (BF=200 IS=1e-16 VAF=50)
`;

const TEXTAREA_STYLE: React.CSSProperties = {
  width: "100%", minHeight: 60, padding: "6px 8px",
  fontSize: 10, fontFamily: "var(--font-mono, monospace)", lineHeight: 1.4,
  background: "var(--bg)", color: "var(--ink2)",
  border: "1px solid var(--l2)", borderRadius: 3, resize: "vertical", outline: "none",
};
// ── Page entry ────────────────────────────────────────────────────

export function SpiceSimulationPage() {
  const [params] = useSearchParams();
  const sessionDieId = useSession((s) => s.dieId);
  const setSessionDieId = useSession((s) => s.setDieId);
  const dieId = params.get("die") ?? sessionDieId ?? null;

  useEffect(() => {
    if (dieId && dieId !== sessionDieId) setSessionDieId(dieId);
  }, [dieId, sessionDieId, setSessionDieId]);

  if (!dieId) {
    return (
      <AppShell breadcrumb="SPICE Simulation">
        <Centered>Open a die from the Library to run SPICE simulations.</Centered>
      </AppShell>
    );
  }
  return <SpiceSimulator key={dieId} dieId={dieId} />;
}

// ── Inner page ────────────────────────────────────────────────────

function SpiceSimulator({ dieId }: { dieId: string }) {
  const die = useDie(dieId).data;
  const annotationsQ = useAnnotations(dieId);
  useAnnotationsWebSocket(dieId);
  const annotations = annotationsQ.data;
  const sheetRPrefs = usePreferences((s) => (s as any).sheetR ?? {});
  // Specific capacitance per unit area [fF/μm²] for capacitors.
  const capDensityPref = usePreferences(
    (s) => (s as any).capDensity ?? DEFAULT_CAP_DENSITY,
  );
  const analogOverrides = usePreferences((s) => (s as any).analogOverrides ?? {});

  const [spiceConfig, setSpiceConfig] = useState<SpiceConfig>({});
  useEffect(() => {
    let cancelled = false;
    loadSpiceConfig(dieId).then((cfg) => { if (!cancelled) setSpiceConfig(cfg); });
    return () => { cancelled = true; };
  }, [dieId]);

  const mergedConfig: SpiceConfig = useMemo(
    () => ({
      ...spiceConfig,
      sheetR_ohms: { ...(spiceConfig.sheetR_ohms ?? {}), ...sheetRPrefs },
      capDensity_fF_um2: capDensityPref,
    }),
    [spiceConfig, sheetRPrefs, capDensityPref],
  );

  const moduleName = useMemo(() => (die?.name ?? dieId).replace(/[^A-Za-z0-9_]/g, "_"), [die?.name, dieId]);

  const netlistResult = useAnalogNetlist(annotations, moduleName, "spectre" as SpiceDialect, mergedConfig, true, analogOverrides);
  const fullNetlistSpectre = netlistResult.data?.source ?? "";
  const fullNetlist = useMemo(() => spectreToNgspice(fullNetlistSpectre), [fullNetlistSpectre]);

  // ── LLM findings as subcircuits ──
  const assistantSession = useAssistantSession((s) => s.byDieId[dieId]);
  const findings = assistantSession?.result?.findings ?? [];

  // Collect all devices + named nets for findings-to-subcircuits conversion
  const { devices: allDevices, namedNets } = useMemo(() => {
    if (!annotations) return { devices: [], namedNets: new Map<number, string>() };
    return collectDieWideAnalogDevices(
      annotations,
      spiceConfig.umPerPx ?? annotations.umPerPx ?? 1.0,
      mergedConfig,
    );
  }, [annotations, spiceConfig, mergedConfig]);

  const aiSubcircuits = useMemo(
    () => findingsToSubcircuits(findings, allDevices, namedNets, mergedConfig),
    [findings, allDevices, namedNets, mergedConfig],
  );

  // Merge: .subckt from netlist + AI findings
  const allSubcircuits = useMemo(() => {
    const fromNetlist = filterTopLevel(parseSubcircuits(fullNetlist));
    return [...aiSubcircuits, ...fromNetlist];
  }, [aiSubcircuits, fullNetlist]);

  // ── State ──
  const [selectedSubcircuit, setSelectedSubcircuit] = useState<string | null>(null);
  const [engineReady, setEngineReady] = useState(false);
  const [running, setRunning] = useState(false);
  const [leftCollapsed, toggleLeft] = usePanelCollapsed("spice.left");
  const [output, setOutput] = useState<SpiceSimulationOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rightView, setRightView] = useState<"waveforms" | "testbench" | "schematic" | "netlist">("waveforms");
  /** Show every vector of the run instead of only the ones `.print` asked for. */
  const [showAllTraces, setShowAllTraces] = useState(false);

  // .step progress state
  const [stepProgress, setStepProgress] = useState<{ current: number; total: number; params: Record<string, string> } | null>(null);

  // Ref for waveform viewer imperative handle
  const waveformRef = useRef<WaveformViewerHandle | null>(null);

  // Persistent model file + directives
  const [customModels, setCustomModels] = useModelFile(dieId, DEFAULT_MODEL_FILE);
  const { selection: modelSelection, setSelection: setModelSelection, select: selectModel } = useModelSelection(dieId);
  const [directives, setDirectives] = useDirectives(dieId, selectedSubcircuit, DEFAULT_DIRECTIVES);

  // The user may edit the generated netlist by hand; the override wins.
  const [netlistOverride, setNetlistOverride] = useState<string | null>(null);
  /**
   * The DUT of a run handed over from the assistant: models + the circuit as
   * it was actually simulated. It replaces the page's own DUT so the composed
   * netlist is the one the agent ran — and stays composed from the page's own
   * fields, so editing the testbench or the models changes what Run simulates.
   */
  const [handedDut, setHandedDut] = useState<{ netlist: string; name: string | null } | null>(null);
  const [modelPopupOpen, setModelPopupOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);

  const ngspiceMode = usePreferences((s) => s.ngspiceMode);
  const setNgspiceMode = usePreferences((s) => s.setNgspiceMode);
  const ngspicePath = usePreferences((s) => s.ngspicePath);
  const setNgspicePath = usePreferences((s) => s.setNgspicePath);
  const llmProvider = usePreferences((s) => s.llmProvider);
  const setLlmProvider = usePreferences((s) => s.setLlmProvider);
  const assistantDataFlags = usePreferences((s) => s.assistantDataFlags);
  const setAssistantDataFlags = usePreferences((s) => s.setAssistantDataFlags);
  const assistantMaxHypotheses = usePreferences((s) => s.assistantMaxHypotheses);
  const setAssistantMaxHypotheses = usePreferences((s) => s.setAssistantMaxHypotheses);

  // Settings panel state
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Init ngspice WASM (only needed in wasm mode)
  useEffect(() => {
    if (ngspiceMode !== "wasm") {
      setEngineReady(true);
      return;
    }
    let cancelled = false;
    initSpice().then(() => { if (!cancelled) setEngineReady(true); })
      .catch((err) => { if (!cancelled) setError(`ngspice init: ${err instanceof Error ? err.message : String(err)}`); });
    return () => { cancelled = true; };
  }, [ngspiceMode]);
  useEffect(() => () => terminateSpice(), []);

  const selectedSubckt = useMemo(() => {
    if (!selectedSubcircuit) return null;
    return allSubcircuits.find((s) => s.name === selectedSubcircuit) ?? null;
  }, [selectedSubcircuit, allSubcircuits]);

  // Device instance names for the selected subcircuit — used by SchematicViewPanel
  // to filter devices when the subcircuit name doesn't match a floorplan region.
  const selectedDeviceNames = selectedSubckt?.deviceNames;

  /**
   * The DUT section: AI findings are written in Spectre, subcircuits in ngspice.
   *
   * A handed-over run supplies its own DUT — the exact models and circuit the
   * agent simulated — but only until the user picks another subcircuit, which
   * means they want the page's own again.
   */
  const dutNetlist = useMemo(() => {
    if (handedDut && (!selectedSubckt || selectedSubckt.name === handedDut.name)) {
      return handedDut.netlist;
    }
    const raw = selectedSubckt ? selectedSubckt.netlist : fullNetlist;
    return selectedSubckt?.source === "ai" ? spectreToNgspice(raw) : raw;
  }, [handedDut, selectedSubckt, fullNetlist]);

  const simulationNetlist = useMemo(() => {
    return composeSimulationNetlist({
      dutNetlist,
      directives,
      selection: modelSelection,
      customModels,
      dutLabel: selectedSubckt ? `DUT: ${selectedSubckt.name}` : "Full Netlist",
      // A flat DUT is wrapped into a .subckt of this name, so the testbench
      // always has a block to connect the sources to.
      dutName: selectedSubckt?.name ?? "chip",
    });
  }, [dutNetlist, directives, modelSelection, customModels, selectedSubckt]);

  /** How many model cards the composed netlist carries. */
  const modelCardCount = useMemo(() => Object.keys(extractModelCards(simulationNetlist)).length, [simulationNetlist]);

  /** What actually gets simulated: the hand-edited netlist when there is one. */
  const effectiveNetlist = netlistOverride ?? simulationNetlist;

  /**
   * What the Testbench tab draws: the testbench elements plus ONE rectangle
   * for the DUT. It is built from the two sections rather than from the raw
   * netlist — a flat netlist handed in as a whole would otherwise be drawn as
   * a picture of the entire chip, which says nothing about the testbench.
   */
  const testbenchView = useMemo(() => {
    const sections = splitSimulationSections(effectiveNetlist, { dut: dutNetlist, testbench: directives });
    return buildTestbenchViewNetlist({
      dutNetlist: sections.dut,
      directives: sections.testbench,
      dutName: selectedSubckt?.name ?? "chip",
    });
  }, [effectiveNetlist, dutNetlist, directives, selectedSubckt]);

  // A run handed over from the assistant thread. The page is rebuilt from it —
  // models, testbench, DUT — so Run reproduces what the agent got, and so the
  // fields stay live instead of hiding behind a frozen copy of the netlist.
  const handoff = useSpiceHandoff((state) => state.handoff);
  const clearHandoff = useSpiceHandoff((state) => state.clear);
  const setHandoff = useSpiceHandoff((state) => state.setHandoff);
  const [agentRun, setAgentRun] = useState<SpiceHandoff | null>(null);
  const appliedHandoffRef = useRef<string | null>(null);
  const runRef = useRef<(() => void) | null>(null);
  /** Pieces of the handed-over run that still have to reach page state. */
  const [pendingHandoff, setPendingHandoff] = useState<SpiceHandoff | null>(null);
  /** Bumped once the handed-over netlist is in place, to run it exactly once. */
  const [handoffRunNonce, setHandoffRunNonce] = useState(0);

  // An MCP agent can publish a finished block run; offer it here. The user
  // clicks Open, which feeds the normal handoff path (models + testbench +
  // auto-run), so what they see is reproducible instead of a frozen snapshot.
  useEffect(() => {
    let cancelled = false;
    fetchLatestSpiceHandoff(dieId)
      .then((record) => {
        if (!cancelled && record?.netlist) setAgentRun(record);
      })
      .catch(() => {
        // 404 = no agent run for this die; nothing to show.
      });
    return () => {
      cancelled = true;
    };
  }, [dieId]);

  useEffect(() => {
    if (!handoff || handoff.dieId !== dieId) return;
    if (appliedHandoffRef.current === String(handoff.at)) return;
    appliedHandoffRef.current = String(handoff.at);
    setNetlistOverride(null);
    setAgentOpen(false);
    setRightView("waveforms");
    // Select the DUT the assistant simulated, so the picker, the schematic and
    // the netlist agree instead of falling back to "the whole chip".
    const dut = detectDutName(handoff.netlist);
    if (dut && allSubcircuits.some((s) => s.name === dut)) setSelectedSubcircuit(dut);
    // The agent's DUT and models take over — but only until the user picks a
    // different subcircuit, which means they want the page's own back.
    setHandedDut(handoff.dut !== null ? { netlist: handoff.dut, name: dut } : null);
    setPendingHandoff(handoff);
  }, [handoff, dieId, allSubcircuits]);

  /**
   * Land the handed-over pieces in page state.
   *
   * A render has to happen in between: the directives hook reloads itself from
   * storage whenever the subcircuit changes, and this effect is declared after
   * it — so the agent's testbench is written after that reload instead of being
   * wiped by the stored default a moment later.
   */
  useEffect(() => {
    if (!pendingHandoff) return;
    setDirectives(pendingHandoff.directives);
    setCustomModels(pendingHandoff.customModels);
    setModelSelection(pendingHandoff.modelSelection);
    setPendingHandoff(null);
    setHandoffRunNonce((n) => n + 1);
  }, [pendingHandoff, setDirectives, setCustomModels, setModelSelection]);

  // Run the handed-over netlist once. By now the handoff has been recomposed
  // through the page's own fields, so `runRef` holds the fresh netlist.
  useEffect(() => {
    if (handoffRunNonce === 0) return;
    void runRef.current?.();
  }, [handoffRunNonce]);

  const runSimulation = useCallback(async () => {
    if (!engineReady || running) return;
    setRunning(true); setError(null); setOutput(null); setStepProgress(null);
    try {
      const result = await runWithStepSupport(effectiveNetlist, ngspiceMode, ngspicePath, (index, total, params) => {
        setStepProgress({ current: index + 1, total, params });
      });
      setOutput(result);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setRunning(false); setStepProgress(null); }
  }, [engineReady, running, effectiveNetlist, ngspiceMode, ngspicePath]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); runSimulation(); }
      if ((e.metaKey || e.ctrlKey) && e.key === ",") { e.preventDefault(); setSettingsOpen((v) => !v); }
    };
    const onToggleSettings = () => setSettingsOpen((v) => !v);
    window.addEventListener("keydown", onKey);
    window.addEventListener("toggle-settings", onToggleSettings);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("toggle-settings", onToggleSettings);
    };
  }, [runSimulation]);

  runRef.current = runSimulation;

  // A new run starts back on the signals it asked for.
  useEffect(() => { setShowAllTraces(false); }, [output]);

  /** What the viewer plots: only what `.print`/`.save` asked for, unless expanded. */
  const shownTraces = useMemo(() => {
    if (!output) return [];
    if (showAllTraces && output.allWaveforms) return output.allWaveforms;
    return output.waveforms;
  }, [output, showAllTraces]);

  const dutInfo = useMemo(() => {
    if (!selectedSubckt) return { name: moduleName, devices: netlistResult.data?.totalDevices ?? 0, kind: "Full netlist" };
    return { name: selectedSubckt.name, devices: selectedSubckt.deviceCount, kind: selectedSubckt.source === "ai" ? "AI Finding" : "Subcircuit" };
  }, [selectedSubckt, moduleName, netlistResult.data?.totalDevices]);

  return (
    <AppShell breadcrumb="SPICE Simulation" meta={die?.name}>
      <SubBar
        right={<PanelToggle side="right" collapsed={!agentOpen} onClick={() => setAgentOpen((v) => !v)} />}
      >
        <PanelToggle side="left" collapsed={leftCollapsed} onClick={toggleLeft} />
        <div style={{ width: 1, height: 16, background: "var(--l2)", margin: "0 4px" }} />
        <span style={{ fontSize: 11, color: "var(--ink3)" }}>
          {ngspiceMode === "server"
            ? (engineReady ? "ngspice server-side ready" : "Connecting to server...")
            : (engineReady ? "ngspice WASM ready" : "Loading ngspice...")}
        </span>
        <div style={{ width: 1, height: 16, background: "var(--l2)", margin: "0 4px" }} />
        {(["waveforms", "testbench", "schematic", "netlist"] as const).map((v) => (
          <button key={v} className={`btn ghost${rightView === v ? " on" : ""}`} style={{ fontSize: 10 }}
            onClick={() => setRightView(v)}>
            {v === "waveforms" ? "Waveforms" : v === "testbench" ? "Testbench" : v === "schematic" ? "Schematic" : "Netlist"}
          </button>
        ))}
        <div style={{ width: 1, height: 16, background: "var(--l2)", margin: "0 4px" }} />
        <button
          className={`btn ghost${agentOpen ? " on" : ""}`}
          style={{ fontSize: 11 }}
          onClick={() => setAgentOpen((v) => !v)}
          title="Ask the assistant to build a testbench"
        >
          {agentOpen ? "✕ Agent" : "⚡ Ask agent"}
        </button>
        <button className="btn ghost" style={{ fontSize: 11 }} onClick={runSimulation} disabled={!engineReady || running} title="Ctrl+Enter">
          {running ? "Running..." : "Run"}
        </button>
      </SubBar>

      {/* An MCP agent published a block run; open it through the normal
          handoff path so the testbench and models become editable. */}
      {agentRun && !handoff && (
        <div
          style={{
            display: "flex", alignItems: "center", gap: 10, padding: "5px 12px",
            borderBottom: "1px solid var(--l2)", background: "rgba(32,201,151,0.08)",
            fontSize: 10, color: "var(--ink2)",
          }}
        >
          <span style={{ color: "#20c997", fontWeight: 600 }}>⚡ MCP agent run</span>
          <span>{agentRun.summary ?? "block simulation"}</span>
          {agentRun.measurements && Object.keys(agentRun.measurements).length > 0 && (
            <span style={{ color: "var(--ink3)" }}>
              {Object.entries(agentRun.measurements)
                .map(([k, v]) => `${k} = ${typeof v === "number" ? v.toPrecision(5) : v}`)
                .join(", ")}
            </span>
          )}
          <div style={{ flex: 1 }} />
          <button
            className="btn"
            style={{ fontSize: 9 }}
            onClick={() => { setHandoff(agentRun); setAgentRun(null); }}
          >
            Open run →
          </button>
          <button className="btn ghost" style={{ fontSize: 9 }} onClick={() => setAgentRun(null)}>
            dismiss
          </button>
        </div>
      )}

      {/* Handoff banner: the testbench came from the assistant thread */}
      {handoff && handoff.dieId === dieId && (
        <div
          style={{
            display: "flex", alignItems: "center", gap: 10, padding: "5px 12px",
            borderBottom: "1px solid var(--l2)", background: "rgba(96,165,250,0.08)", fontSize: 10, color: "var(--ink2)",
          }}
        >
          <span style={{ color: "var(--accent, #60a5fa)", fontWeight: 600 }}>⚡ from the assistant</span>
          <span>{handoff.summary ?? "testbench"}</span>
          {handoff.measurements && Object.keys(handoff.measurements).length > 0 && (
            <span style={{ color: "var(--ink3)" }}>
              {Object.entries(handoff.measurements).map(([k, v]) => `${k} = ${typeof v === "number" ? v.toPrecision(5) : v}`).join(", ")}
            </span>
          )}
          <div style={{ flex: 1 }} />
          <button className="btn ghost" style={{ fontSize: 9 }} onClick={() => clearHandoff()}>
            dismiss
          </button>
        </div>
      )}

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* ── Left panel ── */}        {!leftCollapsed && (
        <div style={{ width: 300, minWidth: 240, borderRight: "1px solid var(--l2)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {/* Subcircuit list */}
          <div style={{ flex: "0 0 auto", maxHeight: "30%", overflow: "auto", borderBottom: "1px solid var(--l2)" }}>
            <SubcircuitPicker subcircuits={allSubcircuits} selected={selectedSubcircuit} onSelect={setSelectedSubcircuit} />
          </div>

          {/* Model file — opens the editor popup with the standard library */}
          <div style={{ flex: "0 0 auto", padding: 8, borderBottom: "1px solid var(--l2)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ fontSize: 10, fontWeight: 600, color: "var(--ink3)", textTransform: "uppercase", letterSpacing: 0.5 }}>Models</span>
              <button className="btn ghost" style={{ fontSize: 9 }} onClick={() => setModelPopupOpen(true)}>edit…</button>
            </div>
            <div style={{ fontSize: 9, color: "var(--ink3)", lineHeight: 1.4 }}>
              {modelCardCount} model card{modelCardCount === 1 ? "" : "s"} in the netlist
              {" · "}<button className="btn ghost" style={{ fontSize: 9, padding: "0 4px" }} onClick={() => setModelPopupOpen(true)}>choose per device type</button>
            </div>
          </div>

          {/* Directive editor */}
          <div style={{ flex: "1 1 0", overflow: "auto", padding: 8 }}>
            <DirectiveEditor value={directives} onChange={setDirectives} />
          </div>

          {/* Status */}
          <div style={{ padding: "6px 10px", fontSize: 10, color: "var(--ink3)", borderTop: "1px solid var(--l2)" }}>
            {stepProgress && (
              <div style={{ color: "var(--accent, #60a5fa)", marginBottom: 2 }}>
                Step {stepProgress.current}/{stepProgress.total}
                {Object.keys(stepProgress.params).length > 0 && (
                  <span> ({Object.entries(stepProgress.params).map(([k, v]) => `${k}=${v}`).join(", ")})</span>
                )}
              </div>
            )}
            {output && <span>{output.durationMs.toFixed(0)}ms / {output.raw.numVariables}v / {output.raw.numPoints}pts</span>}
            {error && <span style={{ color: "var(--bad)" }}> {error}</span>}
          </div>
        </div>
        )}

        {/* ── Right panel ── */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {/* DUT header */}
          <div style={{ padding: "8px 14px", borderBottom: "1px solid var(--l2)", display: "flex", alignItems: "center", gap: 12, background: "var(--card)" }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>{dutInfo.name}</div>
              <div style={{ fontSize: 10, color: "var(--ink3)" }}>
                {dutInfo.kind} / {dutInfo.devices} devices
                {modelCardCount > 0 && ` / ${modelCardCount} models`}
              </div>
            </div>
            <div style={{ flex: 1 }} />
            {rightView === "waveforms" && output && (
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <button
                  onClick={() => waveformRef.current?.fitToData()}
                  style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, padding: 0, borderRadius: 3, border: "1px solid var(--l2)", background: "var(--l1)", color: "var(--ink2)", cursor: "pointer" }}
                  title="Zoom to fit"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>
                  </svg>
                </button>
                <button
                  onClick={() => waveformRef.current?.exportPng()}
                  style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, padding: 0, borderRadius: 3, border: "1px solid var(--l2)", background: "var(--l1)", color: "var(--ink2)", cursor: "pointer" }}
                  title="Export PNG (white background)"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>
                  </svg>
                </button>
              </div>
            )}
            {output && (
              <div style={{ fontSize: 10, color: "var(--ink3)", textAlign: "right" }}>
                <div>{output.durationMs.toFixed(0)}ms / {output.raw.numPoints}pts</div>
              </div>
            )}
          </div>

          {/* View content */}
          {rightView === "waveforms" ? (
            <>
              <div style={{ flex: 1, padding: 12, overflow: "auto" }}>
                {output ? (
                  shownTraces.length > 0 ? (
                    <>
                      {output.measurements && Object.keys(output.measurements).length > 0 && (
                        <div style={{ marginBottom: 8 }}>
                          <ValueTable title="Measurements" values={output.measurements} highlight />
                        </div>
                      )}
                      {output.allWaveforms && (
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, fontSize: 10, color: "var(--ink3)" }}>
                          <span>
                            showing {shownTraces.length} of {output.allWaveforms.length} traces
                            {output.requestedSignals && output.requestedSignals.length > 0
                              ? ` · .print asks for ${output.requestedSignals.slice(0, 4).join(", ")}${output.requestedSignals.length > 4 ? ", …" : ""}`
                              : ""}
                          </span>
                          <button className="btn ghost" style={{ fontSize: 9 }} onClick={() => setShowAllTraces((v) => !v)}>
                            {showAllTraces ? "only what .print asked for" : "show all"}
                          </button>
                        </div>
                      )}
                      <WaveformViewer ref={waveformRef} traces={shownTraces} height={360} />
                    </>
                  ) : (
                    /* No sweep to plot: an `.op` run's numbers are the result. */
                    <RunResultTables output={output} />
                  )
                ) : (
                  <div style={{ height: 360, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, color: "var(--ink3)", fontSize: 12 }}>
                    <div style={{ fontSize: 28, opacity: 0.3 }}>&#9654;</div>
                    <div>Select a subcircuit and click Run (Ctrl+Enter)</div>
                    <div style={{ fontSize: 10, opacity: 0.6 }}>{allSubcircuits.length} subcircuits ({aiSubcircuits.length} AI) / {modelCardCount} models</div>
                  </div>
                )}
              </div>
              {output?.errors && output.errors.length > 0 && (
                <CollapsibleSection title="ngspice Output" defaultOpen badge={output.errors.length}>
                  <pre style={{ fontSize: 10, fontFamily: "var(--font-mono, monospace)", color: "var(--bad)", margin: 0, whiteSpace: "pre-wrap", lineHeight: 1.4, maxHeight: 200, overflow: "auto" }}>
                    {output.errors.join("\n")}
                  </pre>
                </CollapsibleSection>
              )}
            </>
          ) : rightView === "testbench" ? (
            /* Testbench: the DUT block + its sources and loads — never the DUT's contents */
            <div style={{ flex: 1, overflow: "hidden" }}>
              <TestbenchSchematic
                netlist={testbenchView.netlist}
                dieId={dieId}
                moduleName={moduleName}
                vdd={mergedConfig.vdd}
                gnd={mergedConfig.gnd ?? "0"}
              />
            </div>
          ) : rightView === "schematic" ? (
            <div style={{ flex: 1, overflow: "hidden" }}>
              {annotations ? (
                <SchematicViewPanel annotations={annotations} moduleName={moduleName} hierarchical={true} spiceConfig={mergedConfig}
                  floorplanRegions={annotations.floorplanRegions} selectedRegion={selectedSubcircuit} onSelectRegion={setSelectedSubcircuit}
                  selectedDeviceNames={selectedDeviceNames} />
              ) : (
                <Centered>Loading schematic data...</Centered>
              )}
            </div>
          ) : (
            /* Netlist view — editable, this is what gets simulated */
            <div style={{ flex: 1, overflow: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 8, minHeight: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 10, fontWeight: 600, color: "var(--ink3)", textTransform: "uppercase", letterSpacing: 0.5 }}>
                  Simulation Netlist (ngspice format) — editable
                </span>
                <div style={{ flex: 1 }} />
                {(netlistOverride !== null || handedDut !== null) && (
                  <button
                    className="btn ghost"
                    style={{ fontSize: 9 }}
                    onClick={() => { setNetlistOverride(null); setHandedDut(null); }}
                  >
                    reset to generated
                  </button>
                )}
                {handedDut !== null && (
                  <span style={{ fontSize: 9, color: "var(--ink3)" }}>
                    DUT from the assistant's run
                  </span>
                )}
                {netlistOverride !== null && (
                  <span style={{ fontSize: 9, color: "var(--ink3)" }}>edited</span>
                )}
              </div>
              <textarea
                value={effectiveNetlist}
                onChange={(e) => setNetlistOverride(e.target.value)}
                spellCheck={false}
                style={{
                  flex: 1, minHeight: 320, resize: "vertical", fontSize: 11, lineHeight: 1.5,
                  fontFamily: "var(--font-mono, monospace)", color: "var(--ink2)", background: "var(--bg)",
                  border: "1px solid var(--l2)", borderRadius: 4, padding: 8,
                }}
              />
            </div>
          )}
        </div>

        {/* ── Agent panel (right, collapsible) ── */}
        {agentOpen && (
          <div
            style={{
              width: 430, minWidth: 320, maxWidth: "46%", borderLeft: "1px solid var(--l2)",
              background: "var(--card)", display: "flex", flexDirection: "column", overflow: "hidden",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 10px", borderBottom: "1px solid var(--l2)" }}>
              <span style={{ fontSize: 10, fontWeight: 600, color: "var(--ink3)", textTransform: "uppercase", letterSpacing: 0.5 }}>
                Ask agent
              </span>
              <div style={{ flex: 1 }} />
              <span style={{ fontSize: 9, color: "var(--ink3)" }}>
                writes the testbench; the DUT netlist stays untouched
              </span>
              <button className="btn ghost" style={{ fontSize: 10 }} onClick={() => setAgentOpen(false)}>close</button>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 8 }}>
              <SpiceChatPanel dieId={dieId} netlist={effectiveNetlist} onApplyDirectives={setDirectives} />
            </div>
          </div>
        )}
      </div>

      {modelPopupOpen && (
        <ModelEditorPopup
          selection={modelSelection}
          onSelect={selectModel}
          customModels={customModels}
          onCustomModelsChange={setCustomModels}
          onClose={() => setModelPopupOpen(false)}
        />
      )}

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        deviceOverlayOn={false}
        setDeviceOverlayOn={() => {}}
        perfHudOn={false}
        setPerfHudOn={() => {}}
        cellsLocked={false}
        setCellsLocked={() => {}}
        showTermNetIds={false}
        setShowTermNetIds={() => {}}
        showCellRelations={false}
        setShowCellRelations={() => {}}
        viaLabelsVisible={false}
        setViaLabelsVisible={() => {}}
        floorplanOverlayOn={false}
        setFloorplanOverlayOn={() => {}}
        showFloorplanIO={false}
        setShowFloorplanIO={() => {}}
        llmProvider={llmProvider}
        setLlmProvider={setLlmProvider}
        assistantDataFlags={assistantDataFlags}
        setAssistantDataFlags={setAssistantDataFlags}
        assistantMaxHypotheses={assistantMaxHypotheses}
        setAssistantMaxHypotheses={setAssistantMaxHypotheses}
        ngspiceMode={ngspiceMode}
        setNgspiceMode={setNgspiceMode}
        ngspicePath={ngspicePath}
        setNgspicePath={setNgspicePath}
      />
    </AppShell>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink3)", fontSize: 12 }}>{children}</div>;
}

/** Format a measured / operating-point number for the results table. */
function formatValue(v: number | string): string {
  if (typeof v === "string") return v;
  if (!Number.isFinite(v)) return String(v);
  if (v === 0) return "0";
  const magnitude = Math.abs(v);
  if (magnitude >= 1e-3 && magnitude < 1e5) return v.toPrecision(6).replace(/\.?0+$/, "");
  return v.toExponential(4);
}

/** name → value table used for `.measure` results and the operating point. */
function ValueTable({ title, values, highlight = false }: {
  title: string;
  values: Record<string, number | string>;
  highlight?: boolean;
}) {
  const rows = Object.entries(values);
  if (rows.length === 0) return null;
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 600, color: "var(--ink3)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>
        {title} ({rows.length})
      </div>
      <div
        style={{
          display: "grid", gridTemplateColumns: "minmax(120px, 1fr) minmax(80px, auto)",
          gap: "1px 14px", fontSize: 11, fontFamily: "var(--font-mono, monospace)",
          maxWidth: 640,
        }}
      >
        {rows.slice(0, 400).map(([name, value]) => (
          <Fragment key={name}>
            <span style={{ color: "var(--ink2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={name}>{name}</span>
            <span style={{ color: highlight ? "var(--accent, #60a5fa)" : "var(--ink)", textAlign: "right" }}>{formatValue(value)}</span>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

/**
 * What a run with no sweep axis produced: the `.measure` results and the
 * single-point operating point. Without this an `.op` run — the most common
 * first testbench an assistant writes — looks like a simulation that did
 * nothing.
 */
function RunResultTables({ output }: { output: SpiceSimulationOutput }) {
  const op = output.dcOp ?? {};
  const measurements = output.measurements ?? {};
  const hasAnything = Object.keys(op).length > 0 || Object.keys(measurements).length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <ValueTable title="Measurements" values={measurements} highlight />
      <ValueTable title="Operating point" values={op} />
      {!hasAnything && (
        <div style={{ fontSize: 11, color: "var(--ink3)", lineHeight: 1.6 }}>
          The simulation finished but produced nothing to show.
          Add an analysis directive (<code>.op</code>, <code>.dc</code>, <code>.tran</code>, <code>.ac</code>)
          and a <code>.print</code> / <code>.measure</code> line to the netlist.
        </div>
      )}
      {hasAnything && (
        <div style={{ fontSize: 10, color: "var(--ink3)", lineHeight: 1.6 }}>
          This netlist sweeps nothing, so there is no curve to draw — the numbers are the result.
          Add <code>.dc</code> / <code>.tran</code> / <code>.ac</code> for waveforms.
        </div>
      )}
    </div>
  );
}
