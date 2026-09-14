/**
 * SpiceSimulationPage — SPICE simulation tab.
 *
 * Left panel  — subcircuit picker (incl. AI findings) + model file + directives + LLM chat
 * Right panel — DUT header + waveform/schematic/netlist tabs + collapsible output
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AppShell } from "../components/shell/AppShell";
import { SubBar } from "../components/shell/SubBar";
import { WaveformViewer, type WaveformViewerHandle } from "../components/simulation/WaveformViewer";
import { SchematicViewPanel } from "../components/netlist/SchematicViewPanel";
import { SubcircuitPicker, parseSubcircuits, filterTopLevel, type SubcircuitEntry } from "../components/simulation/SubcircuitPicker";
import { DirectiveEditor, DEFAULT_DIRECTIVES } from "../components/simulation/DirectiveEditor";
import { CollapsibleSection } from "../components/simulation/CollapsibleSection";
import { SpiceChatPanel } from "../components/simulation/SpiceChatPanel";
import { SettingsPanel } from "../components/dieViewer/SettingsPanel";
import { initSpice, runWithStepSupport, terminateSpice } from "../lib/simulation/spiceService";
import { spectreToNgspice, extractModelCards } from "../lib/simulation/spectreToNgspice";
import { findingsToSubcircuits } from "../lib/simulation/findingsToSubcircuits";
import { useModelFile, useDirectives } from "../lib/simulation/useSpicePersistence";
import { useAssistantSession } from "../state/assistantSession";
import { collectDieWideAnalogDevices } from "../api/dieWideAnalog";
import type { SpiceSimulationOutput } from "../lib/simulation/types";
import { useDie } from "../api/dies";
import { useAnnotations } from "../api/annotations";
import { useAnnotationsWebSocket } from "../api/annotationsWebSocket";
import { useSession } from "../state/session";
import { usePreferences } from "../state/preferences";
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
  const analogOverrides = usePreferences((s) => (s as any).analogOverrides ?? {});

  const [spiceConfig, setSpiceConfig] = useState<SpiceConfig>({});
  useEffect(() => {
    let cancelled = false;
    loadSpiceConfig(dieId).then((cfg) => { if (!cancelled) setSpiceConfig(cfg); });
    return () => { cancelled = true; };
  }, [dieId]);

  const mergedConfig: SpiceConfig = useMemo(
    () => ({ ...spiceConfig, sheetR_ohms: { ...(spiceConfig.sheetR_ohms ?? {}), ...sheetRPrefs } }),
    [spiceConfig, sheetRPrefs],
  );

  const moduleName = useMemo(() => (die?.name ?? dieId).replace(/[^A-Za-z0-9_]/g, "_"), [die?.name, dieId]);

  const netlistResult = useAnalogNetlist(annotations, moduleName, "spectre" as SpiceDialect, mergedConfig, true, analogOverrides);
  const fullNetlistSpectre = netlistResult.data?.source ?? "";
  const fullNetlist = useMemo(() => spectreToNgspice(fullNetlistSpectre), [fullNetlistSpectre]);
  const autoModelCards = useMemo(() => extractModelCards(fullNetlist), [fullNetlist]);

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
  const [output, setOutput] = useState<SpiceSimulationOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rightView, setRightView] = useState<"waveforms" | "schematic" | "netlist">("waveforms");

  // .step progress state
  const [stepProgress, setStepProgress] = useState<{ current: number; total: number; params: Record<string, string> } | null>(null);

  // Ref for waveform viewer imperative handle
  const waveformRef = useRef<WaveformViewerHandle | null>(null);

  // Persistent model file + directives
  const [modelFile, setModelFile] = useModelFile(dieId, DEFAULT_MODEL_FILE);
  const [directives, setDirectives] = useDirectives(dieId, selectedSubcircuit, DEFAULT_DIRECTIVES);

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

  const simulationNetlist = useMemo(() => {
    const parts: string[] = [];
    if (autoModelCards.length > 0) { parts.push(...autoModelCards); parts.push(""); }
    const userModels = modelFile.split("\n").filter((l) => l.trim().startsWith(".model") || l.trim().startsWith(".MODEL"));
    if (userModels.length > 0) { parts.push("* ── User Models ──"); parts.push(...userModels); parts.push(""); }
    if (selectedSubckt) { parts.push(`* ── DUT: ${selectedSubckt.name} ──`); parts.push(selectedSubckt.netlist); }
    else if (fullNetlist) { parts.push(`* ── Full Netlist ──`); parts.push(fullNetlist); }
    parts.push(""); parts.push(`* ── Directives ──`); parts.push(directives);
    return parts.join("\n");
  }, [autoModelCards, modelFile, selectedSubckt, fullNetlist, directives]);

  const runSimulation = useCallback(async () => {
    if (!engineReady || running) return;
    setRunning(true); setError(null); setOutput(null); setStepProgress(null);
    try {
      const result = await runWithStepSupport(simulationNetlist, ngspiceMode, ngspicePath, (index, total, params) => {
        setStepProgress({ current: index + 1, total, params });
      });
      setOutput(result);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setRunning(false); setStepProgress(null); }
  }, [engineReady, running, simulationNetlist, ngspiceMode, ngspicePath]);

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

  const dutInfo = useMemo(() => {
    if (!selectedSubckt) return { name: moduleName, devices: netlistResult.data?.totalDevices ?? 0, kind: "Full netlist" };
    return { name: selectedSubckt.name, devices: selectedSubckt.deviceCount, kind: selectedSubckt.source === "ai" ? "AI Finding" : "Subcircuit" };
  }, [selectedSubckt, moduleName, netlistResult.data?.totalDevices]);

  return (
    <AppShell breadcrumb="SPICE Simulation" meta={die?.name}>
      <SubBar>
        <span style={{ fontSize: 11, color: "var(--ink3)" }}>
          {ngspiceMode === "server"
            ? (engineReady ? "ngspice server-side ready" : "Connecting to server...")
            : (engineReady ? "ngspice WASM ready" : "Loading ngspice...")}
        </span>
        <div style={{ flex: 1 }} />
        {(["waveforms", "schematic", "netlist"] as const).map((v) => (
          <button key={v} className={`btn ghost${rightView === v ? " on" : ""}`} style={{ fontSize: 10 }}
            onClick={() => setRightView(v)}>
            {v === "waveforms" ? "Waveforms" : v === "schematic" ? "Schematic" : "Netlist"}
          </button>
        ))}
        <div style={{ width: 1, height: 16, background: "var(--l2)", margin: "0 4px" }} />
        <button className="btn ghost" style={{ fontSize: 11 }} onClick={runSimulation} disabled={!engineReady || running} title="Ctrl+Enter">
          {running ? "Running..." : "Run"}
        </button>
      </SubBar>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* ── Left panel ── */}
        <div style={{ width: 300, minWidth: 240, borderRight: "1px solid var(--l2)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {/* Subcircuit list */}
          <div style={{ flex: "0 0 auto", maxHeight: "30%", overflow: "auto", borderBottom: "1px solid var(--l2)" }}>
            <SubcircuitPicker subcircuits={allSubcircuits} selected={selectedSubcircuit} onSelect={setSelectedSubcircuit} />
          </div>

          {/* Model file */}
          <div style={{ flex: "0 0 auto", padding: 8, borderBottom: "1px solid var(--l2)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ fontSize: 10, fontWeight: 600, color: "var(--ink3)", textTransform: "uppercase", letterSpacing: 0.5 }}>Model File</span>
              <button className="btn ghost" style={{ fontSize: 9 }} onClick={() => setModelFile(DEFAULT_MODEL_FILE)}>Reset</button>
            </div>
            <textarea value={modelFile} onChange={(e) => setModelFile(e.target.value)} spellCheck={false} style={TEXTAREA_STYLE} />
          </div>

          {/* Directive editor */}
          <div style={{ flex: "1 1 0", overflow: "auto", padding: 8 }}>
            <DirectiveEditor value={directives} onChange={setDirectives} />
          </div>

          {/* LLM Chat */}
          <div style={{ flex: "0 0 auto", padding: 8, borderTop: "1px solid var(--l2)" }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: "var(--ink3)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Ask Agent</div>
            <SpiceChatPanel dieId={dieId} netlist={simulationNetlist} onApplyDirectives={setDirectives} />
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

        {/* ── Right panel ── */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {/* DUT header */}
          <div style={{ padding: "8px 14px", borderBottom: "1px solid var(--l2)", display: "flex", alignItems: "center", gap: 12, background: "var(--card)" }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>{dutInfo.name}</div>
              <div style={{ fontSize: 10, color: "var(--ink3)" }}>
                {dutInfo.kind} / {dutInfo.devices} devices
                {autoModelCards.length > 0 && ` / ${autoModelCards.length} models`}
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
                  <WaveformViewer ref={waveformRef} traces={output.waveforms} height={360} />
                ) : (
                  <div style={{ height: 360, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, color: "var(--ink3)", fontSize: 12 }}>
                    <div style={{ fontSize: 28, opacity: 0.3 }}>&#9654;</div>
                    <div>Select a subcircuit and click Run (Ctrl+Enter)</div>
                    <div style={{ fontSize: 10, opacity: 0.6 }}>{allSubcircuits.length} subcircuits ({aiSubcircuits.length} AI) / {autoModelCards.length} models</div>
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
            /* Netlist view */
            <div style={{ flex: 1, overflow: "auto", padding: 12 }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: "var(--ink3)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
                Simulation Netlist (ngspice format)
              </div>
              <pre style={{ fontSize: 11, fontFamily: "var(--font-mono, monospace)", color: "var(--ink2)", margin: 0, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
                {simulationNetlist || "(no netlist)"}
              </pre>
            </div>
          )}
        </div>
      </div>

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        deviceOverlayOn={false}
        setDeviceOverlayOn={() => {}}
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
