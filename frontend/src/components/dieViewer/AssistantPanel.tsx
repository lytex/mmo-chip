import { useEffect, useMemo, useRef, useState, useCallback, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { AnalogDevice, AssistantAnalysisBrief, AssistantAnalysisMode, AssistantChatMessage, AssistantClarificationMode, AssistantConfidenceLevel, AssistantFinding, AssistantFindingKind, AssistantFindingPatch, AssistantFindingStatus, AssistantLlmConfig, AssistantLvsCheckResponse, AssistantLvsLibrarySummary, AssistantLvsMatch, AssistantToolUseEvent, DieAnnotations, FloorplanRegion } from "shared";
import { addLvsCell, analyseAssistantCircuitStream, checkAssistantLvsStream, discussFindingStream, listAssistantLvsLibraries } from "../../api/assistantAnalysis";
import { ApiError } from "../../api/client";
import { LvsMatchCard } from "./LvsMatchCard";
import { formatDevicesAsNetlist2Svg } from "../../lib/schematic/netlist2svgFormat";
import { Netlist2SvgView } from "../netlist/Netlist2SvgView";
import { InteractiveAnalogSchematic } from "../netlist/InteractiveAnalogSchematic";
import { scopeKey as interactiveScopeKey } from "../../state/interactiveSchematic";
import { useAssistantSession } from "../../state/assistantSession";
import { usePreferences } from "../../state/preferences";
import { renderDeviceCrop, getTopVisibleLayerName, resolveLayerNameToSourceId } from "../../lib/vision/renderDeviceCrop";
import { topVisibleOverlaySourceId, useOverlayLayers } from "../../state/overlayLayers";

interface Props {
  dieId: string;
  annotations: DieAnnotations | undefined;
  devices: AnalogDevice[];
  netNames: Map<number, string>;
  warnings: string[];
  floorplanRegions: FloorplanRegion[];
  onActivateFinding: (finding: AssistantFinding | null) => void;
  onOpenNetlist: (finding: AssistantFinding, view: "code" | "graph" | "schematic") => void;
}

const COLOR: Record<string, string> = {
  diode_connected_device: "#9aa7bd",
  current_mirror: "#ffaa44",
  bjt_current_mirror: "#f59e42",
  bjt_current_source: "#eab676",
  widlar_current_source: "#db9a44",
  differential_pair: "#b56cff",
  bjt_differential_pair: "#bc72f5",
  ldo_error_amplifier_feedback: "#57b6ff",
  resistor_divider: "#f2cf4a",
  protection_clamp: "#ff6f91",
  llm_hypothesis: "#67c5ff",
  netlist_problem: "#ff5f56",
  positive_feedback_loop: "#ff6f91",
  bandgap_precursor: "#44ddff",
};

const FALLBACK_COLOR = "#8aa0c0";
const colorFor = (kind: string): string => COLOR[kind] ?? FALLBACK_COLOR;

const emptyBrief: AssistantAnalysisBrief = {};

const CONFIDENCE_VALUE: Record<AssistantConfidenceLevel, number> = { high: 0.70, medium: 0.58, low: 0.44 };

const VALID_STATUSES = new Set<AssistantFindingStatus>(["verified_topology", "candidate", "needs_verification"]);
const VALID_CONFIDENCE = new Set<AssistantConfidenceLevel>(["high", "medium", "low"]);

function findingStatus(finding: AssistantFinding): string {
  return `CONF: ${finding.confidenceLevel}`;
}

/** Read-only assistant surface. No action in this component mutates annotations. */
export function AssistantPanel({ dieId, annotations, devices, netNames, warnings, floorplanRegions, onActivateFinding, onOpenNetlist }: Props) {
  const session = useAssistantSession((state) => state.byDieId[dieId]);
  const setBriefForDie = useAssistantSession((state) => state.setBrief);
  const setModeForDie = useAssistantSession((state) => state.setMode);
  const setResultForDie = useAssistantSession((state) => state.setResult);
  const setActiveFindingIdForDie = useAssistantSession((state) => state.setActiveFindingId);
  const appendMessage = useAssistantSession((state) => state.appendFindingMessage);
  const llmProvider = usePreferences((state) => state.llmProvider);
  const assistantDataFlags = usePreferences((state) => state.assistantDataFlags);
  const assistantMaxHypotheses = usePreferences((state) => state.assistantMaxHypotheses);
  const assistantClarificationMode = usePreferences((state) => state.assistantClarificationMode);
  const setAssistantClarificationMode = usePreferences((state) => state.setAssistantClarificationMode);
  const brief = session?.brief ?? emptyBrief;
  const result = session?.result ?? null;
  const mode: AssistantAnalysisMode = session?.mode ?? result?.mode ?? "functional_blocks";
  const activeId = session?.activeFindingId ?? null;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamThinking, setStreamThinking] = useState<string | null>(null);
  const [streamTokens, setStreamTokens] = useState(0);
  const lastRunScope = useRef<"selected" | "die">("die");
  const [streamActivityAt, setStreamActivityAt] = useState<number>(0);
  const [nowTick, setNowTick] = useState(0);
  const [pendingQuestions, setPendingQuestions] = useState<string[] | null>(null);
  const [clarificationAnswersText, setClarificationAnswersText] = useState("");
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null);
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const [lvsEnabled, setLvsEnabled] = useState(true);
  const [visionEnabled, setVisionEnabled] = useState(true);
  const [spiceEnabled, setSpiceEnabled] = useState(true);
  const ngspicePath = usePreferences((state) => state.ngspicePath);
  const ngspiceMode = usePreferences((state) => state.ngspiceMode);
  const [lvsOpen, setLvsOpen] = useState(false);
  const [lvsResult, setLvsResult] = useState<AssistantLvsCheckResponse["data"] | null>(null);
  const [lvsError, setLvsError] = useState<string | null>(null);
  const [lvsChecking, setLvsChecking] = useState(false);
  const [lvsProgress, setLvsProgress] = useState<{ checked: number; total: number } | null>(null);
  const [schematicPopup, setSchematicPopup] = useState<{
    title: string;
    json: unknown;
    /** Devices of the finding fragment — enables the interactive engine. */
    devices?: import("shared").AnalogDevice[];
    netNames?: Map<number, string>;
    vdd?: string;
    gnd?: string;
    scopeKey?: string;
  } | null>(null);
  const [lvsFinding, setLvsFinding] = useState<AssistantFinding | null>(null);
  const [libraries, setLibraries] = useState<AssistantLvsLibrarySummary[]>([]);
  const [activeLib, setActiveLib] = useState<string>("analog-circuits-sky130");
  const [customCellId, setCustomCellId] = useState("");
  const [customSpice, setCustomSpice] = useState("");
  const [addingCell, setAddingCell] = useState(false);

  const overlayLayersRaw = useOverlayLayers((s) => s.layers);
  const overlayLayers = useMemo(
    () => [
      { id: "__base__", name: "base image" },
      ...overlayLayersRaw
        .filter((l) => !l.hidden && l.opacity > 0 && l.loaded)
        .map((l) => ({ id: l.serverFilename ?? l.id, name: l.name })),
    ],
    [overlayLayersRaw],
  );

  const selectedRegion = useMemo(
    () => floorplanRegions.find((r) => r.id === selectedRegionId) ?? null,
    [floorplanRegions, selectedRegionId],
  );

  const regionDevices = useMemo(() => {
    if (!selectedRegion) return [];
    const { geometry, kind } = selectedRegion;
    if (kind === "rect" && geometry.length >= 2) {
      const [p1, p2] = geometry;
      const rx = Math.min(p1.x, p2.x);
      const ry = Math.min(p1.y, p2.y);
      const rw = Math.abs(p2.x - p1.x);
      const rh = Math.abs(p2.y - p1.y);
      return devices.filter((d) => {
        if (!d.bbox) return false;
        return !(d.bbox.x + d.bbox.width < rx || d.bbox.x > rx + rw || d.bbox.y + d.bbox.height < ry || d.bbox.y > ry + rh);
      });
    }
    if (kind === "polygon" && geometry.length >= 3) {
      return devices.filter((d) => {
        if (!d.bbox) return false;
        const cx = d.bbox.x + d.bbox.width / 2;
        const cy = d.bbox.y + d.bbox.height / 2;
        return pointInPolygon(cx, cy, geometry);
      });
    }
    return [];
  }, [devices, selectedRegion]);

  const regionUuids = useMemo(
    () => regionDevices.map((d) => String((d as any)._uuid ?? d.id)),
    [regionDevices],
  );

  const regionNetIds = useMemo(() => {
    const ids = new Set<number>();
    for (const d of regionDevices) {
      for (const t of d.terminals) {
        if (typeof t.netId === "number") ids.add(t.netId);
      }
    }
    return [...ids];
  }, [regionDevices]);

  const canAnalyse = Boolean(annotations && devices.length > 0 && !loading);
  const canAnalyseSelected = canAnalyse && regionDevices.length > 0;
  const sortedFindings = useMemo(
    () => [...(result?.findings ?? [])].sort((a, b) => b.confidence - a.confidence),
    [result],
  );
  const activeFinding = useMemo(
    () => result?.findings.find((finding) => finding.id === activeId) ?? null,
    [result, activeId],
  );

  // Available topology groups across all libraries, with total cell counts.
  const allGroups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const lib of libraries) {
      for (const g of lib.groups ?? []) {
        counts.set(g.topology, (counts.get(g.topology) ?? 0) + g.count);
      }
    }
    return [...counts.entries()].map(([topology, count]) => ({ topology, count })).sort((a, b) => b.count - a.count);
  }, [libraries]);

  const discussFindingObj = useMemo(
    () => result?.findings.find((finding) => finding.id === openThreadId) ?? null,
    [result, openThreadId],
  );

  // ── Vision tool polling: render device crops when the backend has a pending request ──
  // Track processed request IDs to avoid duplicate tool-use cards.
  const processedVisionIds = useRef(new Set<string>());

  const pollVision = useCallback(async () => {
    try {
      const res = await fetch(`/api/dies/${encodeURIComponent(dieId)}/assistant/pending-vision`);
      if (!res.ok) return;
      const data = await res.json() as { ok: boolean; requests: Array<{ requestId: string; deviceUuids: string[]; devices: Array<{ uuid: string; instanceName: string; kind: string; cellId?: string; bbox?: { x: number; y: number; width: number; height: number } }>; layerName?: string }> };
      if (!data.ok || !data.requests?.length) return;

      for (const req of data.requests) {
        // Skip already-processed requests (e.g. from a previous poll cycle)
        if (processedVisionIds.current.has(req.requestId)) continue;

        const images: string[] = [];
        const deviceNames: string[] = [];
        // Resolve overlay: use requested layer name if provided, else top visible
        // __base__ / "base image" → undefined (no overlay, raw die photo)
        const requestedLayerSourceId = req.layerName ? resolveLayerNameToSourceId(req.layerName) : undefined;
        const isBaseRequest = req.layerName && !requestedLayerSourceId &&
          /^(__base__|base|base image|original)$/i.test(req.layerName);
        if (req.layerName && !requestedLayerSourceId && !isBaseRequest) {
          console.warn(`[vision] layerName "${req.layerName}" not resolved to any overlay. Available:`,
            overlayLayers.map((l) => `${l.name} (id: ${l.id})`).join(", ") || "none");
        }
        const overlaySourceId = isBaseRequest ? undefined : (requestedLayerSourceId ?? topVisibleOverlaySourceId());
        // The layer we will actually composite into the crop — reported back so the
        // backend can tell the model when its requested layer was unavailable.
        const resolvedLayerName = isBaseRequest
          ? "__base__"
          : requestedLayerSourceId
            ? (overlayLayersRaw.find((l) => (l.serverFilename ?? l.id) === requestedLayerSourceId)?.name ?? requestedLayerSourceId)
            : getTopVisibleLayerName();
        console.log(`[vision] request ${req.requestId}: layerName=${req.layerName ?? "(none)"}, overlaySourceId=${overlaySourceId ?? "(none)"}, resolvedLayer=${resolvedLayerName}, devices=${req.devices.length}`);
        const devicesWithPoints = devices as Array<AnalogDevice & { _termPoints?: Array<{ x: number; y: number; name: string }>; _cellId?: string }>;
        for (const devInfo of req.devices) {
          const dev = devicesWithPoints.find((d) => (d as any)._uuid === devInfo.uuid || d.id === devInfo.uuid);
          if (!dev) { console.warn(`[vision] device not found: uuid=${devInfo.uuid} name=${devInfo.instanceName}`); continue; }
          if (!(dev as any)._cellId) { console.warn(`[vision] device has no _cellId: ${devInfo.instanceName}`); continue; }
          if (!dev.bbox) { console.warn(`[vision] device has no bbox: ${devInfo.instanceName}`); continue; }
          const result = await renderDeviceCrop(dieId, dev, devicesWithPoints, overlaySourceId);
          if (!result) { console.warn(`[vision] renderDeviceCrop returned null for ${devInfo.instanceName} cellId=${(dev as any)._cellId}`); }
          if (result) {
            images.push(result.image);
            deviceNames.push(dev.instanceName ?? devInfo.instanceName);
          }
        }

        // Send rendered images + the layer actually shown back to the backend for the LLM
        await fetch(`/api/dies/${encodeURIComponent(dieId)}/assistant/vision-result/${encodeURIComponent(req.requestId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ images, layerName: resolvedLayerName }),
        });

        // Only now mark the request as processed — after images are sent so the backend
        // can continue the tool loop regardless of whether the UI card was added.
        processedVisionIds.current.add(req.requestId);

        // Add a tool-use card to the currently open discussion thread (if any)
        if (openThreadId && images.length > 0) {
          appendMessage(dieId, openThreadId, {
            role: "assistant",
            content: "",
            toolUse: {
              type: "vision",
              deviceUuids: req.deviceUuids,
              deviceNames,
              images,
              layerName: resolvedLayerName,
            },
          });
        }
      }
    } catch {
      // Silently ignore polling errors — the tool loop has its own timeout
    }
  }, [dieId, devices, openThreadId, appendMessage]);

  useEffect(() => {
    if (!visionEnabled) return;
    const interval = setInterval(pollVision, 2000);
    return () => clearInterval(interval);
  }, [visionEnabled, pollVision]);

  // Refresh the "last activity Xs ago" indicator while an analysis streams.
  useEffect(() => {
    if (!loading) return;
    const interval = setInterval(() => setNowTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [loading]);

  const updateBrief = (key: keyof AssistantAnalysisBrief, value: string) => {
    setBriefForDie(dieId, { ...brief, [key]: value || undefined });
  };

  const run = async (scope: "selected" | "die", nextMode: AssistantAnalysisMode = mode, clarificationAnswers?: string[]) => {
    if (!annotations || !canAnalyse) return;
    if (scope === "selected" && regionDevices.length === 0) {
      setError("Select a floorplan region first, then use Analyze selected.");
      return;
    }
    lastRunScope.current = scope;
    setLoading(true);
    setError(null);
    setStreamThinking(null);
    setStreamTokens(0);
    setStreamActivityAt(Date.now());
    setNowTick(0);
    setModeForDie(dieId, nextMode);
    try {
      const next = await analyseAssistantCircuitStream(dieId, {
        expectedRev: annotations.rev,
        scope,
        mode: nextMode,
        devices,
        netNames,
        warnings,
        selectedDeviceUuids: scope === "selected" ? regionUuids : [],
        selectedNetIds: scope === "selected" ? regionNetIds : [],
        brief: { ...brief, maxHypotheses: assistantMaxHypotheses },
        requestLlmExplanation: true,
        llmConfig: llmProvider,
        overlayLayers,
        assistantDataFlags,
        clarificationMode: assistantClarificationMode,
        clarificationAnswers,
      }, {
        onEvent: (ev) => {
          if (ev.type === "thinking") {
            setStreamThinking((prev) => (prev ?? "") + (ev.content ?? ""));
            setStreamActivityAt(Date.now());
          } else if (ev.type === "token") {
            setStreamTokens((prev) => prev + 1);
            setStreamActivityAt(Date.now());
          } else if (ev.type === "questions") {
            setPendingQuestions(ev.questions ?? []);
            setClarificationAnswersText("");
            setStreamActivityAt(Date.now());
          } else if (ev.type === "heartbeat") {
            // Keep liveness indicators fresh even when a reasoning model is
            // silent for tens of seconds between token bursts.
            setStreamActivityAt(Date.now());
          }
        },
      });
      // The model asked for input — the questions were streamed as an event and
      // shown above; do NOT surface an empty result or clear pendingQuestions
      // (run() is called again by the user after answering).
      if (next.llm.needClarification && next.llm.questionSet?.length) {
        setPendingQuestions(next.llm.questionSet);
        setClarificationAnswersText("");
        setResultForDie(dieId, next);
        return;
      }
      setPendingQuestions(null);
      setResultForDie(dieId, next);
      const first = [...next.findings].sort((a, b) => b.confidence - a.confidence)[0] ?? null;
      onActivateFinding(first);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Assistant analysis failed.";
      setError(message);
      setResultForDie(dieId, null);
      onActivateFinding(null);
    } finally {
      setLoading(false);
    }
  };

  const activate = (finding: AssistantFinding) => {
    setActiveFindingIdForDie(dieId, finding.id);
    onActivateFinding(finding);
  };

  const handleCheckLvs = (finding: AssistantFinding) => {
    setLvsFinding(finding);
    setLvsOpen(true);
    setLvsResult(null);
    setLvsError(null);
    setLvsChecking(false);
  };

  // Render a schematic fragment of the finding's devices inline (pop-up), without
  // leaving the assistant tab. Reuses the app's netlist2svg pipeline.
  const showSchematicPopup = (finding: AssistantFinding) => {
    const uuids = new Set(finding.deviceUuids);
    const names = new Set(finding.instanceNames);
    // Match against both the live device id and the snapshot uuid (device._uuid),
    // plus the SPICE instance name, since the finding's deviceUuids may use either.
    const fragDevices = devices.filter(
      (d) =>
        uuids.has(d.id) ||
        uuids.has((d as unknown as { _uuid?: string })._uuid ?? "") ||
        (d.instanceName != null && names.has(d.instanceName)),
    );
    if (fragDevices.length === 0) return;
    const allNames = [...netNames.values()];
    const vdd = allNames.find((n) => /^(VDD|VCC|AVDD)$/i.test(n)) ?? "VDD";
    const gnd = allNames.find((n) => /^(GND|VSS)$/i.test(n)) ?? "GND";
    const json = formatDevicesAsNetlist2Svg(fragDevices, netNames, `finding-${finding.id}`, { vdd, gnd, showNetLabels: true });
    setSchematicPopup({
      title: `${finding.label} · ${finding.instanceNames.join(", ")}`,
      json,
      devices: fragDevices,
      netNames,
      vdd,
      gnd,
      scopeKey: `fragment:${finding.id}`,
    });
  };

  const runLvs = async (params: { libraryId: string; topologies: string[]; budget: number }) => {
    if (!lvsFinding) return;
    setLvsResult(null);
    setLvsError(null);
    setLvsProgress(null);
    setLvsChecking(true);
    try {
      const data = await checkAssistantLvsStream(
        dieId,
        {
          devices,
          netNames,
          warnings,
          deviceUuids: lvsFinding.deviceUuids,
          libraryId: params.libraryId,
          topologies: params.topologies,
          budget: params.budget,
        },
        { onProgress: (p) => setLvsProgress(p) },
      );
      setLvsResult(data);
    } catch (cause) {
      const base = formatApiError(cause);
      setLvsError(
        /404/.test(base)
          ? `${base}\nThe reference library is probably not imported yet (run the import script) or the backend needs a restart.`
          : base,
      );
    } finally {
      setLvsChecking(false);
    }
  };

  const handleAddCell = async () => {
    const cellId = customCellId.trim();
    const spice = customSpice.trim();
    if (!cellId || !spice) return;
    setAddingCell(true);
    try {
      await addLvsCell(dieId, activeLib, cellId, spice);
      setCustomCellId("");
      setCustomSpice("");
      setLibraries(await listAssistantLvsLibraries(dieId));
    } catch (cause) {
      setLvsError(formatApiError(cause));
    } finally {
      setAddingCell(false);
    }
  };

  useEffect(() => {
    let alive = true;
    listAssistantLvsLibraries(dieId)
      .then((libs) => { if (alive) setLibraries(libs); })
      .catch(() => { /* library listing is best-effort */ });
    return () => { alive = false; };
  }, [dieId]);

  // Restore the temporary die overlay when returning from Net Graph/Schematic
  // or after a browser refresh. The persisted result itself stays read-only.
  useEffect(() => {
    onActivateFinding(activeFinding);
  }, [activeFinding?.id]);

  return (
    <>
    <div style={{ padding: "10px 10px 12px", fontSize: 11, display: "flex", flexDirection: "column", gap: 9 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span className="u">AI ANALYSIS</span>
        <span className="chip" style={{ marginLeft: "auto", fontSize: 9 }}>read-only</span>
      </div>
      <details style={{ border: "1px solid var(--l2)", borderRadius: 5, padding: "6px 8px", color: "var(--ink3)" }}>
        <summary style={{ cursor: "pointer", color: "var(--ink2)" }}>Prompt & settings (optional)</summary>
        <fieldset style={{ border: 0, margin: "7px 0 0", padding: 0, display: "grid", gap: 6 }}>
          <legend style={{ color: "var(--ink3)", padding: 0, fontSize: 10 }}>Unknown unless supplied by user</legend>
        <Field label="IC / family" value={brief.chipName ?? ""} placeholder="No info from user" onChange={(value) => updateBrief("chipName", value)} />
        <Field label="Function" value={brief.chipDescription ?? ""} placeholder="No info from user" onChange={(value) => updateBrief("chipDescription", value)} />
        <label style={{ display: "grid", gap: 3 }}>
          <span style={{ color: "var(--ink3)", fontSize: 10 }}>LLM response language</span>
          <select value={brief.language ?? "ru"} onChange={(event) => updateBrief("language", event.target.value)} style={{ font: "inherit", background: "var(--l1)", color: "#fff", border: "1px solid var(--l2)", borderRadius: 4, padding: "4px 6px" }}>
            <option value="ru">Русский</option>
            <option value="en">English</option>
          </select>
        </label>
        <label style={{ display: "flex", gap: 6, alignItems: "center", color: "var(--ink2)", fontSize: 10 }}>
          <input type="checkbox" checked={lvsEnabled} onChange={(event) => setLvsEnabled(event.target.checked)} />
          <span>Let the model verify hypotheses via LVS reference library (mmochip_lvs_check)</span>
        </label>
        <label style={{ display: "flex", gap: 6, alignItems: "center", color: "var(--ink2)", fontSize: 10 }}>
          <input type="checkbox" checked={visionEnabled} onChange={(event) => setVisionEnabled(event.target.checked)} />
          <span>Allow the model to visually inspect device crops (mmochip_vision)</span>
        </label>
        <label style={{ display: "flex", gap: 6, alignItems: "center", color: "var(--ink2)", fontSize: 10 }}>
          <input type="checkbox" checked={spiceEnabled} onChange={(event) => setSpiceEnabled(event.target.checked)} />
          <span>Allow the model to run ngspice simulations (mmochip_spice_sim)</span>
        </label>
        <label style={{ display: "grid", gap: 3 }}>
          <span style={{ color: "var(--ink3)", fontSize: 10 }}>Clarifying questions before analysis</span>
          <select
            value={assistantClarificationMode}
            onChange={(event) => setAssistantClarificationMode(event.target.value as AssistantClarificationMode)}
            style={{ font: "inherit", background: "var(--l1)", color: "#fff", border: "1px solid var(--l2)", borderRadius: 4, padding: "4px 6px" }}
          >
            <option value="off">Off — model answers directly</option>
            <option value="auto">Auto — model may ask when unsure</option>
            <option value="always">Always — model must ask first</option>
          </select>
        </label>
        <label style={{ display: "grid", gap: 3 }}>
          <span style={{ color: "var(--ink3)", fontSize: 10 }}>LVS reference library (for "Check by LVS" and the model tool)</span>
          <select value={activeLib} onChange={(event) => setActiveLib(event.target.value)} style={{ font: "inherit", background: "var(--l1)", color: "#fff", border: "1px solid var(--l2)", borderRadius: 4, padding: "4px 6px" }}>
            {libraries.length === 0 && <option value={activeLib}>{activeLib} (not imported yet)</option>}
            {libraries.map((lib) => <option key={lib.libId} value={lib.libId}>{lib.libId} · {lib.cellCount} cells</option>)}
          </select>
        </label>
        <details style={{ border: "1px solid var(--l2)", borderRadius: 4, padding: "5px 7px", color: "var(--ink3)" }}>
          <summary style={{ cursor: "pointer", color: "var(--ink2)", fontSize: 10 }}>Add custom reference SPICE cell</summary>
          <div style={{ display: "grid", gap: 4, marginTop: 5 }}>
            <input value={customCellId} onChange={(event) => setCustomCellId(event.target.value)} placeholder="cell id (e.g. my_ota)" style={{ font: "inherit", background: "var(--l1)", color: "#fff", border: "1px solid var(--l2)", borderRadius: 4, padding: "4px 6px" }} />
            <textarea value={customSpice} onChange={(event) => setCustomSpice(event.target.value)} placeholder=".SUBCKT … / Spectre subckt text" rows={4} style={{ resize: "vertical", font: "inherit", minHeight: 54, background: "var(--l1)", color: "#fff", border: "1px solid var(--l2)", borderRadius: 4, padding: "5px 6px" }} />
            <button className="btn ghost" type="button" disabled={addingCell || !customCellId.trim() || !customSpice.trim()} onClick={() => void handleAddCell()}>Add to {activeLib}</button>
          </div>
        </details>
        <Field label="Technology" value={brief.technology ?? ""} placeholder="No info from user" onChange={(value) => updateBrief("technology", value)} />
        <Field label="Block / region" value={brief.focus ?? ""} placeholder="No info from user" onChange={(value) => updateBrief("focus", value)} />
        <label style={{ display: "grid", gap: 3 }}>
          <span style={{ color: "var(--ink3)", fontSize: 10 }}>Engineering question</span>
          <textarea
            value={brief.prompt ?? ""}
            onChange={(event) => updateBrief("prompt", event.target.value.slice(0, 1200))}
            placeholder="Optional question for the LLM"
            rows={4}
            style={{ resize: "vertical", font: "inherit", minHeight: 54, background: "var(--l1)", color: "#fff", border: "1px solid var(--l2)", borderRadius: 4, padding: "5px 6px" }}
          />
        </label>
        </fieldset>
      </details>

      {floorplanRegions.length > 0 && (
        <label style={{ display: "grid", gap: 3 }}>
          <span style={{ color: "var(--ink3)", fontSize: 10 }}>Floorplan region (for "Analyze selected")</span>
          <select
            value={selectedRegionId ?? ""}
            onChange={(e) => setSelectedRegionId(e.target.value || null)}
            style={{ font: "inherit", background: "var(--l1)", color: "#fff", border: "1px solid var(--l2)", borderRadius: 4, padding: "4px 6px" }}
          >
            <option value="">Whole die</option>
            {floorplanRegions.map((r) => <option key={r.id} value={r.id}>{r.name || r.id}</option>)}
          </select>
        </label>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        <button className="btn" type="button" disabled={!canAnalyseSelected} title={selectedRegion ? `Region: ${selectedRegion.name} (${regionDevices.length} devices)` : "Select a floorplan region first"} onClick={() => void run("selected", mode)}>
          {loading ? "Analysing…" : "Analyze selected"}
        </button>
        <button className="btn" type="button" disabled={!canAnalyse} onClick={() => void run("die", "functional_blocks")}>
          {loading ? "Analysing…" : "Find functional blocks"}
        </button>
        <button className="btn" type="button" disabled={!canAnalyse} onClick={() => void run("die", "netlist_problems")}>
          {loading ? "Analysing…" : "Find netlist problems"}
        </button>
        {result && (
          <button className="btn ghost" type="button" onClick={() => { setResultForDie(dieId, null); onActivateFinding(null); }}>
            Clear results
          </button>
        )}
      </div>
      {selectedRegion && <div style={{ color: "var(--ink3)", fontFamily: "var(--mono)", fontSize: 10 }}>Region: {selectedRegion.name} · {regionDevices.length} device{regionDevices.length === 1 ? "" : "s"}</div>}
      {!devices.length && <div style={{ color: "var(--warn, #e6b05b)" }}>No extracted analog devices are available yet.</div>}
      {error && <div style={{ color: "var(--danger, #ed6a5e)", lineHeight: 1.35 }}>{error}</div>}
      {loading && (
        <div style={{ color: "var(--ink3)", fontSize: 10, lineHeight: 1.35, border: "1px solid var(--l2)", borderRadius: 4, padding: "5px 7px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {(() => {
                const idleSecs = streamActivityAt ? Math.max(0, Math.round((Date.now() - streamActivityAt) / 1000)) : 0;
                return (
                  <>
                    <span
                      key={nowTick}
                      style={{
                        display: "inline-block", width: 7, height: 7, borderRadius: "50%",
                        background: idleSecs > 60 ? "var(--danger, #ed6a5e)" : "var(--warn, #e6b05b)",
                        boxShadow: idleSecs <= 60 ? "0 0 0 0 rgba(230,176,91,.5)" : "none",
                        animation: idleSecs <= 60 ? "mmpulse 1.6s infinite" : undefined,
                      }}
                    />
                    LLM is responding… {streamTokens} token{streamTokens === 1 ? "" : "s"}
                  </>
                );
              })()}
            </span>
            <span>{streamActivityAt ? `${Math.max(0, Math.round((Date.now() - streamActivityAt) / 1000))}s ago` : "…"}</span>
          </div>
          {streamThinking && (
            <details open style={{ marginTop: 4 }}>
              <summary style={{ cursor: "pointer", color: "var(--ink2)" }}>LLM thinking (live)</summary>
              <div style={{ marginTop: 4, maxHeight: 140, overflowY: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word", overflowWrap: "anywhere", fontFamily: "var(--mono)", fontSize: 9 }}>{streamThinking}</div>
            </details>
          )}
        </div>
      )}

      {pendingQuestions && pendingQuestions.length > 0 && !loading && (
        <div style={{ border: "1px solid var(--warn, #e6b05b)", borderRadius: 4, padding: "7px 9px", color: "var(--ink2)", lineHeight: 1.4, fontSize: 10 }}>
          <div style={{ color: "var(--ink2)", marginBottom: 5 }}>The model needs a few clarifications before proposing cards. Please answer (by number):</div>
          {pendingQuestions.map((q, i) => (
            <div key={i} style={{ margin: "2px 0" }}>{i + 1}. {q}</div>
          ))}
          <textarea
            value={clarificationAnswersText}
            onChange={(event) => setClarificationAnswersText(event.target.value)}
            placeholder={"1. …\n2. …\nor briefly describe the answers."}
            rows={4}
            style={{ resize: "vertical", font: "inherit", minHeight: 64, width: "100%", boxSizing: "border-box", background: "var(--l1)", color: "#fff", border: "1px solid var(--l2)", borderRadius: 4, padding: "5px 6px", marginTop: 5 }}
          />
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <button
              className="btn"
              type="button"
              onClick={() => {
                const answers = clarificationAnswersText.trim()
                  ? clarificationAnswersText.split(/[\n;]/).map((a) => a.trim()).filter(Boolean).map((a) => a.replace(/^(\d+)[.:)]\s*/, ""))
                  : [];
                void run(lastRunScope.current, mode, answers);
              }}
            >
              {clarificationAnswersText.trim() ? "Send answers & continue" : "Send (blank) & continue"}
            </button>
            <button className="btn ghost" type="button" onClick={() => void run(lastRunScope.current, mode, [])}>
              Continue without answering
            </button>
          </div>
        </div>
      )}

      {result && (
        <>
          <div style={{ borderTop: "1px solid var(--l2)", paddingTop: 8, color: "var(--ink2)", lineHeight: 1.4 }}>
            <span>{result.llm.used ? `${result.findings.length} findings` : "LLM analysis unavailable"}</span>
            {result.llm.requested && !result.llm.used && result.llm.unavailableReason && (
              <div style={{ marginTop: 5, color: "var(--ink3)" }}>{result.llm.unavailableReason}</div>
            )}
            {result.llm.requested && result.llm.used && (
              <div style={{ marginTop: 5, color: "var(--ink3)" }}>LLM full-graph analysis complete in {((result.llm.durationMs ?? 0) / 1000).toFixed(1)}s. Cards are sorted by confidence.</div>
            )}
            {result.llm.requested && result.llm.used && result.llm.unavailableReason && (
              <div style={{ marginTop: 5, color: "var(--warn, #e6b05b)" }}>{result.llm.unavailableReason}</div>
            )}
          </div>
          {result.llm.thinking && (
            <details style={{ border: "1px solid var(--l2)", borderRadius: 4, padding: "5px 7px", color: "var(--ink3)", lineHeight: 1.35 }}>
              <summary style={{ cursor: "pointer", color: "var(--ink2)" }}>LLM thinking</summary>
              <div style={{ marginTop: 6, whiteSpace: "pre-wrap", wordBreak: "break-word", overflowWrap: "anywhere" }}>{result.llm.thinking}</div>
            </details>
          )}
          {result.llm.narrative && !result.llm.thinking && (
            <details style={{ border: "1px solid var(--l2)", borderRadius: 4, padding: "5px 7px", color: "var(--ink3)", lineHeight: 1.35 }}>
              <summary style={{ cursor: "pointer", color: "var(--ink2)" }}>LLM narrative</summary>
              <div style={{ marginTop: 6, whiteSpace: "pre-wrap", wordBreak: "break-word", overflowWrap: "anywhere" }}>{result.llm.narrative}</div>
            </details>
          )}
          {result.diagnostics.filter((note) => !note.startsWith("LLM analysis snapshot:") && !note.includes("No hard-coded functional-block")).length > 0 && (
            <details style={{ border: "1px solid var(--l2)", borderRadius: 4, padding: "5px 7px", color: "var(--ink3)", lineHeight: 1.35 }}>
              <summary style={{ cursor: "pointer", color: "var(--ink2)" }}>Extraction diagnostics</summary>
              <ul style={{ margin: "6px 0 0", paddingLeft: 15 }}>
                {result.diagnostics
                  .filter((note) => !note.startsWith("LLM analysis snapshot:") && !note.includes("No hard-coded functional-block"))
                  .map((note, index) => <li key={index}>{note}</li>)}
              </ul>
            </details>
          )}
          {result.findings.length === 0 ? (
            <div style={{ color: "var(--ink3)", lineHeight: 1.4 }}>
              The LLM returned no hypotheses for this scope.
            </div>
          ) : sortedFindings.map((finding) => (
            <FindingCard
              key={finding.id}
              finding={finding}
              active={finding.id === activeId}
              discussOpen={openThreadId === finding.id}
              onToggleDiscuss={() => setOpenThreadId(openThreadId === finding.id ? null : finding.id)}
              onActivate={() => activate(finding)}
              onOpen={(view) => { activate(finding); onOpenNetlist(finding, view); }}
              onSchematicPopup={showSchematicPopup}
              onCheckLvs={() => void handleCheckLvs(finding)}
            />
          ))}
          {activeFinding && <div style={{ fontSize: 10, color: "var(--ink3)" }}>Overlay is a temporary read-only preview of the active result. The active finding is restored when returning from graph/schematic or after reload.</div>}
          <div style={{ fontSize: 10, color: "var(--ink3)", lineHeight: 1.4, borderTop: "1px solid var(--l2)", paddingTop: 8, marginTop: 4 }}>
            LLM is a probabilistic model and does not currently use a verified knowledge base. Results should be used only as an independent perspective for error-checking. Each hypothesis requires independent verification regardless of confidence level.
          </div>
        </>
      )}

      {openThreadId && discussFindingObj && createPortal(
        <DiscussPopup
          key={discussFindingObj.id}
          dieId={dieId}
          finding={discussFindingObj}
          devices={devices}
          netNames={netNames}
          warnings={warnings}
          expectedRev={annotations?.rev}
          llmProvider={llmProvider}
          lvsEnabled={lvsEnabled}
          visionEnabled={visionEnabled}
          spiceEnabled={spiceEnabled}
          overlayLayers={overlayLayers}
          onClose={() => setOpenThreadId(null)}
        />,
        document.body,
      )}

      {lvsOpen && createPortal(
        <LvsResultPopup
          libraries={libraries}
          activeLib={activeLib}
          onActiveLibChange={setActiveLib}
          groups={allGroups}
          onRun={runLvs}
          data={lvsResult}
          checking={lvsChecking}
          progress={lvsProgress}
          error={lvsError}
          onClose={() => { setLvsOpen(false); setLvsResult(null); setLvsError(null); }}
        />,
        document.body,
      )}

      {schematicPopup && createPortal(
        <SchematicFragmentPopup
          popup={schematicPopup}
          dieId={dieId}
          onClose={() => setSchematicPopup(null)}
        />,
        document.body,
      )}
    </div>
    </>
  );
}

function SchematicFragmentPopup({ popup, dieId, onClose }: {
  popup: { title: string; json: unknown; devices?: AnalogDevice[]; netNames?: Map<number, string>; vdd?: string; gnd?: string; scopeKey?: string };
  dieId: string;
  onClose: () => void;
}) {
  // Static (netlist2svg, default) vs interactive engine. Interactive only
  // when we have the live device data — otherwise stay on the SVG path.
  const canInteractive = !!popup.devices && popup.devices.length > 0;
  const [engine, setEngine] = useState<"static" | "interactive">("static");
  const moduleName = popup.scopeKey ?? "fragment";
  const sk = interactiveScopeKey(dieId, moduleName, popup.scopeKey ?? "fragment");

  return (
    <div
      className="dark"
      onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{ display: "grid", gridTemplateRows: "auto 1fr", width: "min(760px, 92vw)", height: "min(80vh, 820px)", background: "var(--card)", border: "1px solid var(--l2)", borderRadius: 8, boxShadow: "0 8px 32px rgba(0,0,0,0.5)", overflow: "hidden" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--l2)" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ color: "var(--ink3)", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.4 }}>Schematic fragment</div>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{popup.title}</div>
          </div>
          {canInteractive && (
            <div className="row" style={{ gap: 2, background: "var(--l2)", borderRadius: 4, padding: 2 }}>
              <button type="button" className={"btn sm" + (engine === "static" ? " on" : "")} onClick={() => setEngine("static")}>Static</button>
              <button type="button" className={"btn sm" + (engine === "interactive" ? " on" : "")} onClick={() => setEngine("interactive")}>Interactive</button>
            </div>
          )}
          <button className="btn ghost" type="button" style={{ marginLeft: "auto", fontSize: 10, padding: "3px 8px" }} onClick={onClose}>Close</button>
        </div>
        <div style={{ position: "relative", minHeight: 0 }}>
          {engine === "interactive" && canInteractive && popup.devices && popup.netNames ? (
            <InteractiveAnalogSchematic
              devices={popup.devices}
              namedNets={popup.netNames}
              vdd={popup.vdd}
              gnd={popup.gnd}
              scopeKey={sk}
            />
          ) : (
            <Netlist2SvgView netlistJson={popup.json} height="100%" />
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, placeholder, onChange }: { label: string; value: string; placeholder: string; onChange: (value: string) => void }) {
  return (
    <label style={{ display: "grid", gap: 3 }}>
      <span style={{ color: "var(--ink3)", fontSize: 10 }}>{label}</span>
      <input value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} style={{ font: "inherit", minWidth: 0, background: "var(--l1)", color: "#fff", border: "1px solid var(--l2)", borderRadius: 4, padding: "4px 6px" }} />
    </label>
  );
}

function FindingCard({ finding, active, discussOpen, onToggleDiscuss, onActivate, onOpen, onSchematicPopup, onCheckLvs }: { finding: AssistantFinding; active: boolean; discussOpen: boolean; onToggleDiscuss: () => void; onActivate: () => void; onOpen: (view: "code" | "graph" | "schematic") => void; onSchematicPopup: (finding: AssistantFinding) => void; onCheckLvs: () => void }) {
  const color = colorFor(finding.kind);
  return (
    <article
      onClick={onActivate}
      style={{ border: `1px solid ${active ? color : "var(--l2)"}`, borderLeft: `4px solid ${color}`, borderRadius: 5, padding: "8px 8px 7px", display: "grid", gap: 6, cursor: "pointer", background: active ? color + "12" : "transparent" }}
    >
      <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
        <strong style={{ fontSize: 11 }}>{finding.label}</strong>
        {finding.userCorrected && <span style={{ color: "var(--ink3)", fontSize: 8, border: "1px solid var(--l2)", borderRadius: 3, padding: "0 3px" }}>edited</span>}
        <span style={{ marginLeft: finding.userCorrected ? 0 : "auto", color, fontSize: 9, textTransform: "uppercase" }}>{findingStatus(finding)}</span>
      </div>
      <div style={{ fontFamily: "var(--mono)", color: "var(--ink2)", fontSize: 10 }}>{finding.instanceNames.join(" · ")}</div>
      {finding.assistantComment && <div style={{ color: "var(--ink2)", lineHeight: 1.35 }}>{finding.assistantComment}</div>}
      <ul style={{ margin: 0, paddingLeft: 15, color: "var(--ink3)", lineHeight: 1.35 }}>
        {finding.evidence
          .filter((item) => item.code !== "llm_hypothesis_from_model")
          .slice(0, 2)
          .map((item) => <li key={item.code}>{item.text}</li>)}
      </ul>
      <div style={{ color: "var(--ink3)", lineHeight: 1.35 }}><b>Check:</b> {finding.suggestedChecks[0]}</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }} onClick={(event) => event.stopPropagation()}>
        <button className="btn ghost" type="button" onClick={() => onOpen("graph")}>Net Graph</button>
        <button className="btn ghost" type="button" onClick={() => onOpen("code")}>Netlist</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }} onClick={(event) => event.stopPropagation()}>
        <button className="btn ghost" type="button" onClick={(event) => { event.stopPropagation(); onSchematicPopup(finding); }}>Schematic (Pop-up)</button>
        <button className="btn ghost" type="button" onClick={(event) => { event.stopPropagation(); onOpen("schematic"); }}>Schematic (Link)</button>
      </div>
      <button className="btn ghost" type="button" onClick={(event) => { event.stopPropagation(); onCheckLvs(); }}>Check by LVS</button>
      <button className="btn ghost" type="button" onClick={(event) => { event.stopPropagation(); onToggleDiscuss(); }}>{discussOpen ? "Hide discussion" : "Discuss"}</button>
    </article>
  );
}

function ToolUseCard({ toolUse }: { toolUse: AssistantToolUseEvent }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div style={{
      border: "1px solid var(--l2)", borderRadius: 6, background: "var(--l1)",
      padding: "6px 8px", maxWidth: "100%", minWidth: 0,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }} onClick={() => setExpanded(!expanded)}>
        <span style={{ fontSize: 10, fontWeight: 600, color: "var(--ink2)" }}>Tool use: Vision</span>
        {toolUse.layerName && (
          <span style={{ fontSize: 9, color: "#44ddff", fontWeight: 600 }}>
            {toolUse.layerName}
          </span>
        )}
        <span style={{ fontSize: 9, color: "var(--ink3)" }}>
          {toolUse.deviceNames.join(", ")}
        </span>
        <span style={{ marginLeft: "auto", fontSize: 9, color: "var(--ink3)" }}>{expanded ? "▲" : "▼"}</span>
      </div>
      {expanded && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
          {toolUse.images.map((img, i) => (
            <div key={i} style={{ border: "1px solid var(--l2)", borderRadius: 4, overflow: "hidden", background: "#1a1a18" }}>
              <img
                src={`data:image/png;base64,${img}`}
                alt={toolUse.deviceNames[i] ?? "device crop"}
                style={{ display: "block", maxWidth: 240, maxHeight: 180, objectFit: "contain" }}
              />
              <div style={{ fontSize: 8, color: "var(--ink3)", padding: "2px 4px", textAlign: "center" }}>
                {toolUse.deviceNames[i]}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function pointInPolygon(x: number, y: number, polygon: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Per-finding discussion thread. Each turn is sent to the backend, which scopes
 * the model to the finding's subgraph. The conversation history is stored in the
 * assistant session so it survives panel collapse / tab switches.
 */
/**
 * Per-finding discussion, shown as a floating popup (same placement as the
 * DeviceInspector). The conversation history is stored in the assistant session,
 * so it survives panel collapse / tab switches and is never lost on re-render.
 * The popup is mounted while a discussion is open; it only remounts when the
 * user switches to a different finding (keyed by finding id at the call site).
 */
function DiscussPopup({
  dieId,
  finding,
  devices,
  netNames,
  warnings,
  expectedRev,
  llmProvider,
  lvsEnabled,
  visionEnabled,
  spiceEnabled,
  overlayLayers,
  onClose,
}: {
  dieId: string;
  finding: AssistantFinding;
  devices: AnalogDevice[];
  netNames: Map<number, string>;
  warnings: string[];
  expectedRev?: number;
  llmProvider: AssistantLlmConfig;
  lvsEnabled: boolean;
  visionEnabled: boolean;
  spiceEnabled: boolean;
  overlayLayers: Array<{ id: string; name: string }>;
  onClose: () => void;
}) {
  const thread = useAssistantSession((state) => state.byDieId[dieId]?.findingThreads?.[finding.id] ?? EMPTY_THREAD);
  const session = useAssistantSession((state) => state.byDieId[dieId]);
  const assistantDataFlags = usePreferences((state) => state.assistantDataFlags);
  const ngspicePath = usePreferences((state) => state.ngspicePath);
  const ngspiceMode = usePreferences((state) => state.ngspiceMode);
  const appendMessage = useAssistantSession((state) => state.appendFindingMessage);
  const resetThread = useAssistantSession((state) => state.resetFindingThread);
  const updateFinding = useAssistantSession((state) => state.updateFinding);
  const [pendingCardUpdate, setPendingCardUpdate] = useState<AssistantFindingPatch | null>(null);
  const firstAssistantIndex = thread.findIndex((message) => message.role === "assistant");

  // Apply a structured card correction proposed by the model once the user confirms it:
  // merge new elements (union) and overwrite the chosen fields.
  const confirmCardUpdate = (patch: AssistantFindingPatch) => {
    const base = finding;
    const addDevices = new Set(patch.addDeviceUuids ?? []);
    const removeDevices = new Set(patch.removeDeviceUuids ?? []);
    const deviceUuids = [...new Set([...base.deviceUuids, ...addDevices])].filter((uuid) => !removeDevices.has(uuid));
    const addNets = new Set(patch.addNetIds ?? []);
    const removeNets = new Set(patch.removeNetIds ?? []);
    const netIds = [...new Set([...base.netIds, ...addNets])].filter((id) => !removeNets.has(id));
    const instanceNames = deviceUuids.map((uuid) => {
      const dev = devices.find((device) => String((device as any)._uuid ?? device.id) === uuid);
      return dev?.instanceName ?? base.instanceNames[base.deviceUuids.indexOf(uuid)] ?? uuid;
    });
    updateFinding(dieId, finding.id, {
      label: patch.label ?? base.label,
      kind: patch.kind ?? base.kind,
      status: patch.status && VALID_STATUSES.has(patch.status) ? patch.status : base.status,
      confidenceLevel: patch.confidenceLevel && VALID_CONFIDENCE.has(patch.confidenceLevel) ? patch.confidenceLevel : base.confidenceLevel,
      confidence: patch.confidenceLevel && VALID_CONFIDENCE.has(patch.confidenceLevel) ? CONFIDENCE_VALUE[patch.confidenceLevel] : base.confidence,
      deviceUuids,
      instanceNames,
      netIds,
      assistantComment: patch.assistantComment ?? base.assistantComment,
      limitations: patch.limitations ?? base.limitations,
      suggestedChecks: patch.suggestedChecks ?? base.suggestedChecks,
    });
    const added = [...(patch.addDeviceUuids ?? []), ...(patch.addNetIds ?? []).map((id) => `net ${id}`)];
    const removed = [...(patch.removeDeviceUuids ?? []), ...(patch.removeNetIds ?? []).map((id) => `net ${id}`)];
    const note = [];
    if (added.length) note.push(`добавлены ${added.join(", ")}`);
    if (removed.length) note.push(`удалены ${removed.join(", ")}`);
    appendMessage(dieId, finding.id, { role: "user", content: `Карточка обновлена моделью.${note.length ? ` ${note.join("; ")}.` : ""}` });
    setPendingCardUpdate(null);
  };
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [streamingReply, setStreamingReply] = useState<string | null>(null);
  const [streamingTool, setStreamingTool] = useState<string | null>(null);
  const [streamingThinking, setStreamingThinking] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const cancelledRef = useRef(false);
  const streamingReplyRef = useRef("");
  const streamingThinkingRef = useRef("");
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [thread.length, busy, streamingReply, streamingThinking]);

  useEffect(() => {
    if (!busy) return;
    const startedAt = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  const cancel = () => {
    cancelledRef.current = true;
    controllerRef.current?.abort();
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    setStreamingReply(null);
    setStreamingTool(null);
    setStreamingThinking(null);
    streamingReplyRef.current = "";
    streamingThinkingRef.current = "";
    cancelledRef.current = false;
    const userTurn: AssistantChatMessage = { role: "user", content: text };
    const history: AssistantChatMessage[] = [...thread, userTurn];
    appendMessage(dieId, finding.id, userTurn);
    setInput("");
    const controller = new AbortController();
    controllerRef.current = controller;
    // Idle safety-net only — with streaming the connection stays alive while
    // tokens flow, so the client aborts only when the stream is silent for the
    // full window (a long reasoning model that keeps streaming is never cut).
    // The backend applies the same idle semantics (base ASSISTANT_LLM_TIMEOUT_MS).
    let hardTimeout: ReturnType<typeof setTimeout> | null = null;
    const armHardTimeout = () => {
      if (hardTimeout) clearTimeout(hardTimeout);
      hardTimeout = setTimeout(() => controller.abort(), 1_800_000);
    };
    armHardTimeout();
    try {
        const { reply, cardUpdate, lvsResults } = await discussFindingStream(dieId, {
        expectedRev,
        finding: {
          id: finding.id,
          label: finding.label,
          assistantComment: finding.assistantComment,
          deviceUuids: finding.deviceUuids,
          netIds: finding.netIds,
          kind: finding.kind,
          status: finding.status,
          confidenceLevel: finding.confidenceLevel,
          instanceNames: finding.instanceNames,
          limitations: finding.limitations,
          suggestedChecks: finding.suggestedChecks,
        },
        messages: history,
        devices,
        netNames,
        warnings,
        brief: session?.brief,
        mode: session?.mode,
        llmConfig: llmProvider,
        toolFlags: {
          lvs: lvsEnabled,
          vision: visionEnabled,
          spice: spiceEnabled,
          ngspicePath: ngspiceMode === "server" ? ngspicePath : undefined,
        },
        overlayLayers,
        assistantDataFlags,
      }, {
        signal: controller.signal,
        onEvent: (ev) => {
          // Any activity re-arms the idle safety net.
          armHardTimeout();
          if (ev.type === "token") {
            streamingReplyRef.current += ev.content ?? "";
            setStreamingReply(displayableReply(streamingReplyRef.current));
          } else if (ev.type === "thinking") {
            streamingThinkingRef.current += ev.content ?? "";
            setStreamingThinking(streamingThinkingRef.current);
          } else if (ev.type === "tool_start") {
            // A tool call means the model is pausing to inspect something;
            // clear any preamble so the bubble shows the actual reply.
            streamingReplyRef.current = "";
            setStreamingReply("");
            if (ev.tool === "mmochip_vision") setStreamingTool("🔍 mmochip_vision — inspecting device crops…");
            else if (ev.tool === "mmochip_lvs_check") setStreamingTool("🔬 mmochip_lvs_check — verifying against reference library…");
            else if (ev.tool === "mmochip_card_update") setStreamingTool("📋 mmochip_card_update — preparing card update…");
          } else if (ev.type === "tool_result") {
            setStreamingTool(null);
          }
        },
      });
       setStreamingReply(null);
       setStreamingTool(null);
       appendMessage(dieId, finding.id, { role: "assistant", content: reply });
       if (cardUpdate) setPendingCardUpdate(cardUpdate);
       // LVS results are committed to the thread history (not a separate sticky
       // panel) so they scroll up as a message when new replies arrive.
       if (lvsResults.length) appendMessage(dieId, finding.id, { role: "assistant", content: "", lvsResults });
    } catch (cause) {
      // Keep whatever partial reply already streamed so the user isn't left empty-handed.
      if (streamingReplyRef.current) {
        appendMessage(dieId, finding.id, { role: "assistant", content: displayableReply(streamingReplyRef.current) });
      }
      if (!cancelledRef.current) {
        console.debug("[assistant/discuss] request failed", cause);
        setError(formatApiError(cause));
      }
    } finally {
      if (hardTimeout) clearTimeout(hardTimeout);
      hardTimeout = null;
      controllerRef.current = null;
      setStreamingReply(null);
      setStreamingTool(null);
      setStreamingThinking(null);
      setBusy(false);
    }
  };

  return (
    <div
      className="dark"
      onClick={(event) => event.stopPropagation()}
      style={{
        position: "fixed", right: 330, bottom: 40,
        width: "fit-content", minWidth: 320,
        maxWidth: "min(560px, calc(100vw - 360px))", maxHeight: "50vh", zIndex: 100,
        overflowY: "auto", overflowX: "hidden", background: "var(--card)", border: "1px solid var(--l2)",
        borderRadius: 6, boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
        display: "grid", gap: 6, padding: 8, cursor: "default",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: "var(--ink3)", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.4 }}>Discussion</div>
          <div style={{ fontSize: 11, fontWeight: 600, overflowWrap: "anywhere", wordBreak: "break-word" }}>{finding.label}</div>
        </div>
        <button className="btn ghost" type="button" style={{ marginLeft: "auto", fontSize: 9, padding: "2px 6px" }} onClick={onClose}>Close</button>
      </div>
      <details open style={{ border: `1px solid ${colorFor(finding.kind)}`, borderRadius: 5, padding: "6px 8px", background: colorFor(finding.kind) + "10" }}>
        <summary style={{ cursor: "pointer", color: "var(--ink2)", fontSize: 10 }}>Карточка · {finding.label}</summary>
        <div style={{ display: "grid", gap: 4, marginTop: 5, minWidth: 0 }}>
          <div style={{ display: "flex", gap: 6, fontSize: 9, flexWrap: "wrap" }}>
            <span style={{ color: colorFor(finding.kind) }}>{finding.kind}</span>
            <span style={{ color: "var(--ink3)" }}>{finding.confidenceLevel} · {finding.status}</span>
            {finding.userCorrected && <span style={{ color: "var(--ink3)", border: "1px solid var(--l2)", borderRadius: 3, padding: "0 3px" }}>edited</span>}
          </div>
          <div style={{ fontFamily: "var(--mono)", color: "var(--ink2)", fontSize: 9, overflowWrap: "anywhere", wordBreak: "break-word" }}>{finding.instanceNames.join(" · ")}</div>
          {finding.assistantComment && <div style={{ color: "var(--ink2)", fontSize: 10, lineHeight: 1.35, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{finding.assistantComment}</div>}
          {finding.evidence.filter((item) => item.code !== "llm_hypothesis_from_model").length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 14, color: "var(--ink3)", fontSize: 9, lineHeight: 1.3 }}>
              {finding.evidence.filter((item) => item.code !== "llm_hypothesis_from_model").map((item, index) => <li key={index}>{item.text}</li>)}
            </ul>
          )}
          {finding.limitations.length > 0 && <div style={{ color: "var(--ink3)", fontSize: 9, lineHeight: 1.3, overflowWrap: "anywhere", wordBreak: "break-word" }}><b>Ограничения:</b> {finding.limitations.join("; ")}</div>}
          {finding.suggestedChecks.length > 0 && <div style={{ color: "var(--ink3)", fontSize: 9, lineHeight: 1.3, overflowWrap: "anywhere", wordBreak: "break-word" }}><b>Проверить:</b> {finding.suggestedChecks.join("; ")}</div>}
        </div>
      </details>
      <div style={{ fontSize: 9, color: "var(--ink3)", textTransform: "uppercase", letterSpacing: 0.4 }}>Обсуждение</div>
      <div style={{ display: "grid", gap: 5, overflowY: "auto", minHeight: 60, minWidth: 0 }}>
        {thread.length === 0 && <div style={{ color: "var(--ink3)", fontSize: 10, lineHeight: 1.4 }}>Ask a follow-up about this hypothesis — the model sees the full netlist to reason about adjacent parts.</div>}
        {thread.map((message, index) => (
          <div key={index} style={{ display: "flex", flexDirection: "column", alignItems: message.role === "user" ? "flex-end" : "flex-start", minWidth: 0 }}>
            {index === firstAssistantIndex && message.role === "assistant" && (
              <div style={{ fontSize: 8, color: "var(--ink3)", marginBottom: 2 }}>Первичный ответ</div>
            )}
            {message.toolUse ? (
              <ToolUseCard toolUse={message.toolUse} />
            ) : message.lvsResults?.length ? (
              <div style={{ display: "grid", gap: 5, border: "1px solid var(--l2)", borderRadius: 5, padding: "6px 8px", background: "var(--l1)" }}>
                <div style={{ fontSize: 9, color: "var(--ink2)", textTransform: "uppercase", letterSpacing: 0.4 }}>LVS reference check</div>
                {message.lvsResults.map((res, i) => (
                  <div key={i} style={{ display: "grid", gap: 5 }}>
                    <div style={{ fontSize: 9, color: "var(--ink3)" }}>
                      {res.checkedCount} candidate(s) compared{res.totalCells ? ` (of ${res.totalCells} in group)` : ""} against the reference library.
                    </div>
                    {res.matches.length > 0 ? (
                      res.matches.map((m) => <LvsMatchCard key={m.cellId + (m.topology ?? "")} match={m} candidateNetlist={res.candidateNetlist} />)
                    ) : (
                      <div style={{ color: "var(--ink3)", fontSize: 9 }}>No reference match found{res.checkedCount > 0 ? ` — ${res.checkedCount} checked.` : "."}</div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div
                style={{
                  display: "block",
                  maxWidth: "100%",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  overflowWrap: "anywhere",
                  lineHeight: 1.4,
                  fontSize: 10,
                  padding: "5px 7px",
                  borderRadius: 6,
                  background: message.role === "user" ? "var(--accent, #2b4a6b)" : "var(--l2)",
                  color: "#fff",
                }}
              >
                {message.content}
              </div>
            )}
          </div>
        ))}
        {busy && streamingThinking && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", minWidth: 0 }}>
            <details open style={{ width: "100%", border: "1px solid var(--l2)", borderRadius: 4, padding: "4px 6px", background: "var(--l1)" }}>
              <summary style={{ cursor: "pointer", color: "var(--ink2)", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.4 }}>LLM thinking (live)</summary>
              <div style={{ marginTop: 4, maxHeight: 120, overflowY: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word", overflowWrap: "anywhere", fontFamily: "var(--mono)", fontSize: 9, color: "var(--ink3)" }}>{streamingThinking}</div>
            </details>
          </div>
        )}
        {busy && (streamingReply || streamingTool) && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", minWidth: 0 }}>
            {streamingTool && (
              <div style={{ fontSize: 9, color: "var(--ink3)", border: "1px dashed var(--l2)", borderRadius: 4, padding: "3px 6px", marginBottom: 2 }}>{streamingTool}</div>
            )}
            {streamingReply && (
              <div
                style={{
                  display: "block",
                  maxWidth: "100%",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  overflowWrap: "anywhere",
                  lineHeight: 1.4,
                  fontSize: 10,
                  padding: "5px 7px",
                  borderRadius: 6,
                  background: "var(--l2)",
                  color: "#fff",
                }}
              >
                {streamingReply}
                <span style={{ opacity: 0.55 }}>▋</span>
              </div>
            )}
          </div>
        )}
        {busy && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--ink3)", fontSize: 10 }}>
            <span>Model is thinking… {elapsed}s</span>
            <button className="btn ghost" type="button" style={{ marginLeft: "auto", fontSize: 9, padding: "2px 6px" }} onClick={cancel}>Cancel</button>
          </div>
        )}
        {pendingCardUpdate && (
          <div style={{ display: "grid", gap: 5, border: `1px solid ${colorFor(finding.kind)}`, borderRadius: 5, padding: "6px 8px", background: colorFor(finding.kind) + "10" }}>
            <div style={{ fontSize: 9, color: "var(--ink2)" }}>Модель предлагает обновить карточку</div>
            {pendingCardUpdate.assistantComment && <div style={{ color: "var(--ink2)", fontSize: 10, lineHeight: 1.35, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{pendingCardUpdate.assistantComment}</div>}
            {(((pendingCardUpdate.addDeviceUuids?.length) ?? 0) || ((pendingCardUpdate.addNetIds?.length) ?? 0)) > 0 && (
              <div style={{ color: "var(--ink3)", fontSize: 9, lineHeight: 1.3, overflowWrap: "anywhere", wordBreak: "break-word" }}>Добавляемые элементы: {[...(pendingCardUpdate.addDeviceUuids ?? []), ...(pendingCardUpdate.addNetIds ?? []).map((id) => `net ${id}`)].join(", ")}</div>
            )}
            {(((pendingCardUpdate.removeDeviceUuids?.length) ?? 0) || ((pendingCardUpdate.removeNetIds?.length) ?? 0)) > 0 && (
              <div style={{ color: "var(--danger, #ed6a5e)", fontSize: 9, lineHeight: 1.3, overflowWrap: "anywhere", wordBreak: "break-word" }}>Удаляемые элементы: {[...(pendingCardUpdate.removeDeviceUuids ?? []), ...(pendingCardUpdate.removeNetIds ?? []).map((id) => `net ${id}`)].join(", ")}</div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
              <button className="btn" type="button" onClick={() => pendingCardUpdate && confirmCardUpdate(pendingCardUpdate)}>Применить</button>
              <button className="btn ghost" type="button" onClick={() => { appendMessage(dieId, finding.id, { role: "user", content: "Обновление карточки отклонено пользователем." }); setPendingCardUpdate(null); }}>Отклонить</button>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>
      {error && (
        <div style={{ color: "var(--danger, #ed6a5e)", fontSize: 10, lineHeight: 1.35, whiteSpace: "pre-wrap", borderTop: "1px solid var(--l2)", paddingTop: 5 }}>
          {error}
        </div>
      )}
      <textarea
        value={input}
        disabled={busy}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void send();
          }
        }}
        placeholder="Follow-up question… (Enter to send)"
        rows={2}
        style={{ resize: "vertical", font: "inherit", minHeight: 36, background: "var(--l1)", color: "#fff", border: "1px solid var(--l2)", borderRadius: 4, padding: "5px 6px" }}
      />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
        <button className="btn" type="button" disabled={busy || !input.trim()} onClick={() => void send()}>Send</button>
        <button className="btn ghost" type="button" onClick={() => resetThread(dieId, finding.id)}>Clear</button>
      </div>
    </div>
  );
}

/**
 * The discuss model replies as a single JSON object {"reply": "...", "cardUpdate": ...}.
 * While that JSON streams in, extract the reply field so the chat bubble shows
 * clean text instead of raw JSON. Falls back to the raw text for prose replies.
 */
function displayableReply(partial: string): string {
  const m = /"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(partial);
  if (m) {
    return m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  const trimmed = partial.trim();
  if (trimmed.startsWith("{")) return "";
  return trimmed;
}

function formatApiError(cause: unknown): string {
  if (cause instanceof DOMException && cause.name === "AbortError") {
    return "Request timed out after 300s — the model or backend did not respond. Check the LLM provider configuration and backend logs.";
  }
  if (cause instanceof ApiError) {
    let detail = "";
    if (cause.body && typeof cause.body === "object") {
      const body = cause.body as Record<string, unknown>;
      if (typeof body.detail === "string") detail = `\n${body.detail}`;
      else if (typeof body.error === "string" && body.error !== cause.message) detail = `\n${body.error}`;
    }
    return `HTTP ${cause.status}: ${cause.message}${detail}`;
  }
  return cause instanceof Error ? cause.message : "Discussion failed.";
}

const EMPTY_THREAD: AssistantChatMessage[] = [];

/**
 * Standalone LVS reference-library check (the "Check by LVS" card button).
 * Lets the user pick a library (with its cell count), filter by topology group(s),
 * set the comparison budget, then shows the best reference match and near-miss
 * diagnostics (extra / missing devices).
 */
function LvsResultPopup({ libraries, activeLib, onActiveLibChange, groups, onRun, data, checking, progress, error, onClose }: {
  libraries: AssistantLvsLibrarySummary[];
  activeLib: string;
  onActiveLibChange: (libId: string) => void;
  groups: Array<{ topology: string; count: number }>;
  onRun: (params: { libraryId: string; topologies: string[]; budget: number }) => void;
  data: AssistantLvsCheckResponse["data"] | null;
  checking: boolean;
  progress: { checked: number; total: number } | null;
  error: string | null;
  onClose: () => void;
}) {
  const [selectedLib, setSelectedLib] = useState(activeLib);
  const [topologies, setTopologies] = useState<string[]>([]);
  const [budget, setBudget] = useState(50);

  const toggleTopology = (t: string) =>
    setTopologies((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  const selectStyle: CSSProperties = {
    font: "inherit", background: "var(--l1)", color: "#fff", border: "1px solid var(--l2)", borderRadius: 4, padding: "4px 6px",
  };

  return (
    <div
      className="dark"
      onClick={(event) => event.stopPropagation()}
      style={{
        position: "fixed", right: 330, bottom: 40, width: 380,
        maxWidth: "min(380px, calc(100vw - 360px))", maxHeight: "85vh", zIndex: 100,
        overflowY: "auto", overflowX: "hidden", background: "var(--card)", border: "1px solid var(--l2)",
        borderRadius: 6, boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
        display: "grid", gap: 8, padding: 10, cursor: "default", minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: "var(--ink3)", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.4 }}>LVS reference check</div>
          <div style={{ fontSize: 11, fontWeight: 600 }}>Reference library comparison</div>
        </div>
        <button className="btn ghost" type="button" style={{ marginLeft: "auto", fontSize: 9, padding: "2px 6px" }} onClick={onClose}>Close</button>
      </div>

      <div style={{ display: "grid", gap: 6, border: "1px solid var(--l2)", borderRadius: 5, padding: "7px 8px", background: "var(--l1)" }}>
        <label style={{ display: "grid", gap: 3 }}>
          <span style={{ color: "var(--ink3)", fontSize: 10 }}>
            Библиотека (всего схем: {libraries.reduce((n, l) => n + l.cellCount, 0)})
          </span>
          <select
            value={selectedLib}
            disabled={topologies.length > 0}
            onChange={(e) => { const v = e.target.value; setSelectedLib(v); onActiveLibChange(v); }}
            style={{ ...selectStyle, opacity: topologies.length > 0 ? 0.5 : 1 }}
          >
            {libraries.length === 0 && <option value={selectedLib}>{selectedLib} (not imported)</option>}
            {libraries.map((lib) => <option key={lib.libId} value={lib.libId}>{lib.libId} · {lib.cellCount} cells</option>)}
          </select>
          {topologies.length > 0 && <span style={{ color: "var(--ink3)", fontSize: 9 }}>Группы выбраны → поиск по всем библиотекам</span>}
        </label>

        <div style={{ display: "grid", gap: 3 }}>
          <span style={{ color: "var(--ink3)", fontSize: 10 }}>Топологические группы (фильтр проверки)</span>
          <div style={{ maxHeight: 150, overflowY: "auto", border: "1px solid var(--l2)", borderRadius: 4, padding: 5, display: "grid", gap: 3, background: "var(--card)" }}>
            {groups.length === 0 && <span style={{ color: "var(--ink3)", fontSize: 9 }}>Нет доступных групп</span>}
            {groups.map((g) => (
              <label key={g.topology} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 10, color: "var(--ink2)" }}>
                <input type="checkbox" checked={topologies.includes(g.topology)} onChange={() => toggleTopology(g.topology)} />
                <span style={{ overflowWrap: "anywhere" }}>{g.topology}</span>
                <span style={{ marginLeft: "auto", color: "var(--ink3)" }}>{g.count}</span>
              </label>
            ))}
          </div>
        </div>

        <label style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ color: "var(--ink3)", fontSize: 10 }}>Budget — кол-во проверок</span>
          <input
            type="number"
            min={1}
            max={5000}
            value={budget}
            onChange={(e) => setBudget(Math.min(5000, Math.max(1, Number(e.target.value) || 1)))}
            style={{ width: 84, ...selectStyle }}
          />
        </label>

        <button className="btn" type="button" onClick={() => onRun({ libraryId: selectedLib, topologies, budget })} disabled={checking}>
          {checking ? "Проверка…" : "Run LVS check"}
        </button>
      </div>

      {checking && (
        <div style={{ display: "grid", gap: 4 }}>
          <div style={{ color: "var(--ink3)", fontSize: 10 }}>
            {progress ? `Сравнение: ${progress.checked} / ${progress.total}…` : "Сравнение с эталонной библиотекой…"}
          </div>
          {progress && progress.total > 0 && (
            <div style={{ height: 4, background: "var(--l2)", borderRadius: 2, overflow: "hidden" }}>
              <div
                style={{
                  height: "100%",
                  width: `${Math.min(100, (progress.checked / progress.total) * 100)}%`,
                  background: "var(--accent, #2b4a6b)",
                  transition: "width 0.2s ease",
                }}
              />
            </div>
          )}
        </div>
      )}
      {error && <div style={{ color: "var(--danger, #ed6a5e)", fontSize: 10, lineHeight: 1.35, whiteSpace: "pre-wrap" }}>{error}</div>}
      {!checking && !error && data && (
        <div style={{ display: "grid", gap: 6 }}>
          <div style={{ display: "grid", gap: 3 }}>
            <div style={{ fontSize: 9, color: "var(--ink3)" }}>
              {data.checkedCount} из {data.totalCells ?? data.checkedCount} эталонных ячеек сравнено
              {data.uniqueCells != null && data.totalCells != null && data.uniqueCells < data.totalCells
                ? ` (${data.uniqueCells} уникальных топологий после дедупликации)`
                : ""}
              {topologies.length ? ` · группы: ${topologies.join(", ")}` : ""} · топологий: {Object.keys(data.topologyCounts ?? {}).length}
            </div>
            {data.topologyCounts && Object.keys(data.topologyCounts).length > 0 && (
              <details style={{ color: "var(--ink3)", fontSize: 9 }}>
                <summary style={{ cursor: "pointer" }}>распределение по топологиям</summary>
                <div style={{ marginTop: 3, lineHeight: 1.5 }}>
                  {Object.entries(data.topologyCounts).sort((a, b) => b[1] - a[1]).map(([t, c]) => `${t}: ${c}`).join(" · ")}
                </div>
              </details>
            )}
          </div>
          {data.matches.length > 0 ? (
            data.matches.map((m: AssistantLvsMatch) => <LvsMatchCard key={m.cellId + (m.topology ?? "")} match={m} candidateNetlist={data.candidateNetlist} />)
          ) : (
            <div style={{ color: "var(--ink3)", fontSize: 10, lineHeight: 1.4 }}>
              Совпадений не найдено{data.checkedCount > 0 ? ` — проверено ${data.checkedCount} ячеек группы.` : "."}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
