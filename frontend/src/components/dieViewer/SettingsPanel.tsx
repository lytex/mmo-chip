/**
 * SettingsPanel.tsx — Project settings modal (similar to ShortcutsPanel).
 *
 * Three sections:
 *   1. Die Viewer Settings — overlay toggles
 *   2. RE Cell Settings — sheet resistance values
 *   3. AI Assistant — LLM provider configuration
 */

import { useEffect, useRef } from "react";
import type { AssistantDataFlags, AssistantLlmConfig } from "shared";
import { SheetRConfigPanel } from "../config/SheetRConfigPanel";

type Props = {
  open: boolean;
  onClose: () => void;
  // Die viewer toggles
  deviceOverlayOn: boolean;
  setDeviceOverlayOn: (v: boolean) => void;
  cellsLocked: boolean;
  setCellsLocked: (v: boolean) => void;
  showTermNetIds: boolean;
  setShowTermNetIds: (v: boolean) => void;
  showCellRelations: boolean;
  setShowCellRelations: (v: boolean) => void;
  viaLabelsVisible: boolean;
  setViaLabelsVisible: (v: boolean) => void;
  floorplanOverlayOn: boolean;
  setFloorplanOverlayOn: (v: boolean) => void;
  showFloorplanIO: boolean;
  setShowFloorplanIO: (v: boolean) => void;
  // LLM provider
  llmProvider: AssistantLlmConfig;
  setLlmProvider: (config: AssistantLlmConfig) => void;
  // LLM data representation flags
  assistantDataFlags: AssistantDataFlags;
  setAssistantDataFlags: (flags: AssistantDataFlags) => void;
  // Full-graph hypothesis count limit
  assistantMaxHypotheses: number;
  setAssistantMaxHypotheses: (count: number) => void;
  // ngspice settings
  ngspiceMode: "wasm" | "server";
  setNgspiceMode: (v: "wasm" | "server") => void;
  ngspicePath: string;
  setNgspicePath: (v: string) => void;
};

const LLM_PRESETS: Record<string, { baseUrl: string; model: string }> = {
  "openrouter": { baseUrl: "https://openrouter.ai/api/v1", model: "minimax/minimax-m3:free" },
  "opencode-go": { baseUrl: "https://opencode.ai/zen/go/v1", model: "mimo-v2.5" },
  "openai": { baseUrl: "https://api.openai.com/v1", model: "gpt-4o" },
  "custom": { baseUrl: "", model: "" },
};

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label
      style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "4px 0", cursor: "pointer",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ margin: 0 }}
      />
      <span style={{ fontSize: 11, color: "var(--ink2)" }}>{label}</span>
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "5px 8px", fontSize: 11,
  background: "var(--l1)", border: "1px solid var(--l2)",
  borderRadius: 4, color: "#fff", outline: "none",
  boxSizing: "border-box",
};

const labelStyle: React.CSSProperties = {
  fontSize: 10, color: "var(--ink3)", marginBottom: 3, display: "block",
};

export function SettingsPanel({
  open,
  onClose,
  deviceOverlayOn, setDeviceOverlayOn,
  cellsLocked, setCellsLocked,
  showTermNetIds, setShowTermNetIds,
  showCellRelations, setShowCellRelations,
  viaLabelsVisible, setViaLabelsVisible,
  floorplanOverlayOn, setFloorplanOverlayOn,
  showFloorplanIO, setShowFloorplanIO,
  llmProvider, setLlmProvider,
  assistantDataFlags, setAssistantDataFlags,
  assistantMaxHypotheses, setAssistantMaxHypotheses,
  ngspiceMode, setNgspiceMode,
  ngspicePath, setNgspicePath,
}: Props) {
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const currentProvider = llmProvider.provider ?? "openrouter";
  const currentBaseUrl = llmProvider.baseUrl ?? "";
  const currentModel = llmProvider.model ?? "";
  const currentApiKey = llmProvider.apiKey ?? "";

  return (
    <div
      ref={backdropRef}
      onClick={(e) => {
        if (e.target === backdropRef.current) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1100,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        className="dark"
        style={{
          background: "var(--card)",
          border: "1px solid var(--l2)",
          borderRadius: 8,
          boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
          maxWidth: 520,
          width: "90%",
          maxHeight: "80vh",
          overflow: "auto",
          padding: "16px 20px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", marginBottom: 14 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>
            Project Settings
          </span>
          <div style={{ flex: 1 }} />
          <button
            className="btn ghost"
            onClick={onClose}
            style={{ fontSize: 11, color: "var(--ink3)" }}
          >
            Esc to close
          </button>
        </div>

        {/* Die Viewer Settings */}
        <div style={{ marginBottom: 16 }}>
          <div
            style={{
              fontSize: 10, fontWeight: 600, color: "var(--ink3)",
              textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8,
            }}
          >
            Die Viewer Settings
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 24px" }}>
            <Toggle label="Analog devices overlay" checked={deviceOverlayOn} onChange={setDeviceOverlayOn} />
            <Toggle label="Cells locked" checked={cellsLocked} onChange={setCellsLocked} />
            <Toggle label="Net ID overlay" checked={showTermNetIds} onChange={setShowTermNetIds} />
            <Toggle label="Cell relations overlay" checked={showCellRelations} onChange={setShowCellRelations} />
            <Toggle label="Via labels" checked={viaLabelsVisible} onChange={setViaLabelsVisible} />
            <Toggle label="Floorplan overlay" checked={floorplanOverlayOn} onChange={setFloorplanOverlayOn} />
            <Toggle label="Floorplan I/O" checked={showFloorplanIO} onChange={setShowFloorplanIO} />
          </div>
        </div>

        {/* RE Cell Settings */}
        <div style={{ marginBottom: 16 }}>
          <div
            style={{
              fontSize: 10, fontWeight: 600, color: "var(--ink3)",
              textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8,
            }}
          >
            RE Cell Settings
          </div>
          <SheetRConfigPanel compact />
        </div>

        {/* AI Assistant — LLM Provider */}
        <div>
          <div
            style={{
              fontSize: 10, fontWeight: 600, color: "var(--ink3)",
              textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8,
            }}
          >
            AI Assistant — LLM Provider
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {/* Provider */}
            <div>
              <label style={labelStyle}>Provider</label>
              <select
                value={currentProvider}
                onChange={(e) => {
                  const provider = e.target.value as AssistantLlmConfig["provider"];
                  const preset = LLM_PRESETS[provider ?? "custom"];
                  setLlmProvider({
                    ...llmProvider,
                    provider,
                    baseUrl: preset?.baseUrl ?? llmProvider.baseUrl ?? "",
                    model: preset?.model ?? llmProvider.model ?? "",
                  });
                }}
                style={{ ...inputStyle, cursor: "pointer" }}
              >
                <option value="openrouter">OpenRouter</option>
                <option value="opencode-go">OpenCode Go</option>
                <option value="openai">OpenAI</option>
                <option value="custom">Custom</option>
              </select>
            </div>

            {/* API Key */}
            <div>
              <label style={labelStyle}>API Key</label>
              <input
                type="password"
                placeholder="sk-..."
                value={currentApiKey}
                onChange={(e) => setLlmProvider({ ...llmProvider, apiKey: e.target.value || undefined })}
                style={inputStyle}
              />
            </div>

            {/* Base URL */}
            <div>
              <label style={labelStyle}>Base URL</label>
              <input
                type="text"
                placeholder="https://..."
                value={currentBaseUrl}
                onChange={(e) => setLlmProvider({ ...llmProvider, baseUrl: e.target.value || undefined })}
                style={inputStyle}
              />
            </div>

            {/* Model */}
            <div>
              <label style={labelStyle}>Model</label>
              <input
                type="text"
                placeholder="model-id"
                value={currentModel}
                onChange={(e) => setLlmProvider({ ...llmProvider, model: e.target.value || undefined })}
                style={inputStyle}
              />
            </div>
          </div>
        </div>

        {/* AI Assistant — LLM Data */}
        <div>
          <div
            style={{
              fontSize: 10, fontWeight: 600, color: "var(--ink3)",
              textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8,
            }}
          >
            AI Assistant — LLM Data
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <Toggle
              label="Full project JSON"
              checked={assistantDataFlags.projectJson !== false}
              onChange={(v) => setAssistantDataFlags({ ...assistantDataFlags, projectJson: v })}
            />
            <Toggle
              label="Text netlist"
              checked={assistantDataFlags.textNetlist === true}
              onChange={(v) => setAssistantDataFlags({ ...assistantDataFlags, textNetlist: v })}
            />
            <div style={{ fontSize: 9, color: "var(--ink3)", lineHeight: 1.4, marginTop: 4 }}>
              Full project JSON (device geometry, bbox, all nets) works reliably on OpenRouter but is large and can hang opencode-go.
              Text netlist is a compact Spectre-like representation that works on opencode-go. Enable both for OpenRouter to get maximum detail.
            </div>
            <div style={{ marginTop: 8 }}>
              <label style={labelStyle}>Max hypotheses</label>
              <input
                type="number"
                min={1}
                max={20}
                value={Number.isFinite(assistantMaxHypotheses) ? assistantMaxHypotheses : 5}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (Number.isFinite(v)) setAssistantMaxHypotheses(Math.max(1, Math.min(20, v)));
                }}
                style={inputStyle}
              />
              <div style={{ fontSize: 9, color: "var(--ink3)", lineHeight: 1.4, marginTop: 4 }}>
                Limit on the number of hypothesis cards returned by full-graph analysis (reduces output tokens and cost).
              </div>
            </div>
          </div>
        </div>

        {/* ngspice Settings */}
        <div>
          <div
            style={{
              fontSize: 10, fontWeight: 600, color: "var(--ink3)",
              textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8,
            }}
          >
            ngspice Simulation
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <label style={{ ...labelStyle, flex: 1 }}>Mode</label>
              <select
                value={ngspiceMode}
                onChange={(e) => setNgspiceMode(e.target.value as "wasm" | "server")}
                style={{ ...inputStyle, width: 120, flex: "none" }}
              >
                <option value="wasm">WASM (in-browser)</option>
                <option value="server">Server-side</option>
              </select>
            </div>
            {ngspiceMode === "server" && (
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <label style={{ ...labelStyle, flex: 1 }}>ngspice path</label>
                <input
                  type="text"
                  value={ngspicePath}
                  onChange={(e) => setNgspicePath(e.target.value)}
                  placeholder="ngspice"
                  style={{ ...inputStyle, flex: 1 }}
                />
              </div>
            )}
            <div style={{ fontSize: 9, color: "var(--ink3)", lineHeight: 1.4 }}>
              {ngspiceMode === "wasm"
                ? "Runs ngspice in-browser via WebAssembly (eecircuit-engine). Fast, no server needed, but some directives like .step may not be supported."
                : "Runs native ngspice on the server. Full feature support including .step, .param, .measure. Requires ngspice installed on the server."}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
