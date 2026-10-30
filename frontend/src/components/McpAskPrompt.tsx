import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import type {
  McpPromptField,
  McpPromptOption,
  McpPromptResult,
  McpUserPrompt,
  McpUserPromptEntry
} from "shared";
import { answerMcpPrompt, cancelMcpPrompt, mcpKeys, useMcpPrompts } from "../api/mcp";

/**
 * App-wide modal for `ask_user`: an MCP client hit a decision it cannot make
 * on its own and sent the question (with its evidence) here. The client's tool
 * call is blocked until the user answers, dismisses, or the countdown runs out,
 * so this is deliberately louder than the access prompt: a full overlay, one
 * question at a time, and the queue position when several are waiting.
 */
export function McpAskPrompt() {
  const { data } = useMcpPrompts();
  const pending = data?.prompts ?? [];
  if (pending.length === 0) return null;
  const [current] = pending;
  return createPortal(
    <PromptModal key={current.prompt.id} entry={current} position={1} total={pending.length} />,
    document.body
  );
}

const ROLE_TONE: Record<string, "primary" | "danger" | "neutral"> = {
  approve: "primary",
  reject: "danger",
  cancel: "neutral",
  neutral: "neutral"
};

function initialFields(prompt: McpUserPrompt): Record<string, string | number | boolean> {
  const values: Record<string, string | number | boolean> = {};
  for (const field of prompt.fields ?? []) {
    if (field.default !== undefined) values[field.id] = field.default;
    else if (field.type === "boolean") values[field.id] = false;
    else values[field.id] = "";
  }
  return values;
}

function PromptModal({
  entry,
  position,
  total
}: {
  entry: McpUserPromptEntry;
  position: number;
  total: number;
}) {
  const { prompt, dieName } = entry;
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [fields, setFields] = useState(() => initialFields(prompt));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<McpPromptResult | null>(null);
  const [remaining, setRemaining] = useState(() => remainingMs(prompt.expiresAt));

  useEffect(() => {
    const timer = setInterval(() => setRemaining(remainingMs(prompt.expiresAt)), 1000);
    return () => clearInterval(timer);
  }, [prompt.expiresAt]);

  const options = prompt.options;
  const singleClickSubmits =
    !prompt.multiSelect && !prompt.allowFreeText && (prompt.fields?.length ?? 0) === 0;
  const missingField = (prompt.fields ?? []).find(
    (field) => field.required && (fields[field.id] === undefined || fields[field.id] === "")
  );
  // Fields alone are not an answer when there are buttons to pick: without
  // this, a confirm could be "answered" without approving or rejecting it.
  const hasChoosable = options.length > 0;
  const canSubmit =
    !busy &&
    !result &&
    remaining > 0 &&
    !missingField &&
    (selected.length > 0 || text.trim().length > 0 || (!hasChoosable && (prompt.fields?.length ?? 0) > 0));

  const submit = async (payload?: { optionIds?: string[]; text?: string }) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { result: answered } = await answerMcpPrompt(prompt.id, {
        optionIds: payload?.optionIds ?? selected,
        text: payload?.text ?? (text.trim() ? text : null),
        fields
      });
      setResult(answered);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: mcpKeys.prompts });
    }
  };

  const dismiss = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await cancelMcpPrompt(prompt.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    } finally {
      void qc.invalidateQueries({ queryKey: mcpKeys.prompts });
    }
  };

  const toggle = (option: McpPromptOption) => {
    if (prompt.multiSelect) {
      setSelected((prev) =>
        prev.includes(option.id) ? prev.filter((id) => id !== option.id) : [...prev, option.id]
      );
      return;
    }
    if (singleClickSubmits) {
      setSelected([option.id]);
      void submit({ optionIds: [option.id] });
      return;
    }
    setSelected([option.id]);
  };

  const submitLabel =
    selected.length === 1
      ? options.find((option) => option.id === selected[0])?.label ?? "Answer"
      : selected.length > 1
        ? `Answer with ${selected.length}`
        : "Answer";

  const expired = remaining <= 0 || result?.reason === "timeout";

  return (
    <div
      className="dark dialog-overlay"
      style={{ zIndex: 1200, padding: 24 }}
      onPointerDown={(event) => {
        // The overlay does not dismiss: the calling agent must not take a
        // stray click as an answer. Use "Dismiss" for that.
        event.stopPropagation();
      }}
    >
      <div
        className="popover"
        role="dialog"
        aria-modal="true"
        aria-label="Question from an MCP client"
        style={{
          width: "min(860px, calc(100vw - 48px))",
          maxHeight: "calc(100vh - 48px)",
          display: "flex",
          flexDirection: "column",
          padding: 0,
          overflow: "hidden",
          // Portaled to <body>, which carries the light theme's text colour;
          // the .dark overlay re-scopes the variables but not inherited colour.
          color: "var(--ink)"
        }}
      >
        <header
          style={{
            padding: "12px 16px",
            borderBottom: "1px solid var(--l2)",
            display: "flex",
            alignItems: "baseline",
            gap: 10
          }}
        >
          <span className="u" style={{ fontSize: 10 }}>
            MCP asks
          </span>
          <span style={{ fontSize: 11, color: "var(--ink2)" }}>
            {prompt.clientName ?? "An MCP client"} · die <b>{dieName}</b>
          </span>
          {total > 1 && (
            <span className="m" style={{ fontSize: 10, color: "var(--ink2)" }}>
              {position} of {total} waiting
            </span>
          )}
          <span
            className="m"
            style={{
              marginLeft: "auto",
              fontSize: 10,
              color: expired ? "var(--danger, #e36854)" : remaining < 30_000 ? "#e8b45a" : "var(--ink2)"
            }}
            title="The MCP call gives up when this reaches zero"
          >
            {expired ? "expired" : `expires in ${formatDuration(remaining)}`}
          </span>
        </header>

        <div style={{ padding: 16, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.4 }}>{prompt.question}</div>
          {prompt.detail && (
            <div style={{ fontSize: 12, color: "var(--ink2)", lineHeight: 1.55, whiteSpace: "pre-line" }}>
              {prompt.detail}
            </div>
          )}

          {prompt.evidence?.notes && prompt.evidence.notes.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11.5, color: "var(--ink2)", lineHeight: 1.6 }}>
              {prompt.evidence.notes.map((note, index) => (
                <li key={index}>{note}</li>
              ))}
            </ul>
          )}

          {prompt.evidence?.images && prompt.evidence.images.length > 0 && (
            <EvidenceImages images={prompt.evidence.images} />
          )}

          {prompt.evidence?.stats && <EvidenceStats stats={prompt.evidence.stats} />}

          {prompt.evidence?.netlist && (
            <section>
              <SectionTitle>{prompt.evidence.netlist.title ?? "Netlist"}</SectionTitle>
              <pre
                style={{
                  margin: 0,
                  padding: "8px 10px",
                  maxHeight: 240,
                  overflow: "auto",
                  background: "var(--bg)",
                  border: "1px solid var(--l2)",
                  borderRadius: 3,
                  font: "400 10.5px/1.45 var(--mono)",
                  whiteSpace: "pre",
                  color: "var(--ink)"
                }}
              >
                {prompt.evidence.netlist.text}
              </pre>
            </section>
          )}

          {prompt.fields && prompt.fields.length > 0 && (
            <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {prompt.fields.map((field) => (
                <FieldInput
                  key={field.id}
                  field={field}
                  value={fields[field.id]}
                  disabled={busy || !!result || expired}
                  onChange={(value) => setFields((prev) => ({ ...prev, [field.id]: value }))}
                />
              ))}
            </section>
          )}

          {options.length > 0 && (
            <section style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <SectionTitle>{prompt.multiSelect ? "Choose one or more" : "Choose"}</SectionTitle>
              {options.map((option) => {
                const active = selected.includes(option.id);
                const tone = option.tone ?? ROLE_TONE[option.role ?? "neutral"] ?? "neutral";
                return (
                  <button
                    key={option.id}
                    type="button"
                    className={`btn${active ? " accent" : ""}`}
                    disabled={busy || !!result || expired}
                    onClick={() => toggle(option)}
                    style={{
                      textAlign: "left",
                      padding: "8px 10px",
                      height: "auto",
                      borderColor:
                        tone === "danger" && !active ? "color-mix(in srgb, var(--danger, #e36854) 55%, var(--l2))" : undefined,
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-start",
                      gap: 2
                    }}
                  >
                    <span style={{ fontSize: 12, fontWeight: 600 }}>
                      {active ? "● " : ""}
                      {option.label}
                    </span>
                    {option.description && (
                      <span style={{ font: "400 10.5px/1.4 var(--font)", color: "var(--ink2)" }}>
                        {option.description}
                      </span>
                    )}
                  </button>
                );
              })}
            </section>
          )}

          {prompt.allowFreeText && (
            <section>
              <SectionTitle>{options.length > 0 ? "Or answer in your own words" : "Your answer"}</SectionTitle>
              <textarea
                value={text}
                disabled={busy || !!result || expired}
                onChange={(event) => setText(event.target.value)}
                rows={3}
                placeholder="Type here…"
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  resize: "vertical",
                  padding: "6px 8px",
                  font: "400 12px/1.45 var(--font)",
                  color: "var(--ink)",
                  background: "var(--bg)",
                  border: "1px solid var(--l2)",
                  borderRadius: 3,
                  outline: "none"
                }}
              />
            </section>
          )}

          {prompt.proposal !== undefined && (
            <details>
              <summary style={{ cursor: "pointer", font: "400 10.5px/1.4 var(--font)", color: "var(--ink2)" }}>
                What the client will do with an approval
              </summary>
              <pre
                style={{
                  margin: "6px 0 0",
                  padding: "8px 10px",
                  maxHeight: 180,
                  overflow: "auto",
                  background: "var(--bg)",
                  border: "1px solid var(--l2)",
                  borderRadius: 3,
                  font: "400 10.5px/1.45 var(--mono)",
                  whiteSpace: "pre-wrap"
                }}
              >
                {safeJson(prompt.proposal)}
              </pre>
            </details>
          )}

          {error && (
            <div className="m" style={{ fontSize: 11, color: "var(--danger, #e36854)" }}>
              {error}
            </div>
          )}
          {result && (
            <div className="m" style={{ fontSize: 11, color: "var(--ink2)" }}>
              {result.answered
                ? `Answered${result.labels.length ? `: ${result.labels.join(", ")}` : ""} — the client is continuing.`
                : "Dismissed — the client will not treat this as approval."}
            </div>
          )}
        </div>

        <footer
          style={{
            padding: "10px 16px",
            borderTop: "1px solid var(--l2)",
            display: "flex",
            gap: 8,
            alignItems: "center"
          }}
        >
          <span className="m" style={{ fontSize: 10, color: "var(--ink2)" }}>
            {kindHint(prompt)}
          </span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button type="button" className="btn" disabled={busy || !!result} onClick={() => void dismiss()}>
              Dismiss
            </button>
            <button
              type="button"
              className="btn accent"
              disabled={!canSubmit}
              onClick={() => void submit()}
              title={missingField ? `"${missingField.label}" is required` : undefined}
            >
              {busy ? "Sending…" : result ? "Sent" : submitLabel}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function EvidenceImages({ images }: { images: NonNullable<McpUserPrompt["evidence"]>["images"] }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  if (!images) return null;
  return (
    <section style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {images.map((image) => (
        <figure
          key={image.index}
          style={{
            margin: 0,
            flex: expanded === image.index ? "1 1 100%" : "1 1 240px",
            maxWidth: expanded === image.index ? "100%" : "calc(50% - 4px)",
            minWidth: 180
          }}
        >
          <img
            src={image.dataUrl}
            alt={image.label}
            onClick={() => setExpanded(expanded === image.index ? null : image.index)}
            style={{
              display: "block",
              width: "100%",
              maxHeight: expanded === image.index ? "none" : 260,
              objectFit: "contain",
              background: "#000",
              border: "1px solid var(--l2)",
              borderRadius: 3,
              cursor: "zoom-in"
            }}
          />
          <figcaption style={{ font: "400 10.5px/1.4 var(--font)", color: "var(--ink2)", marginTop: 3 }}>
            {image.label} <span className="m">({image.width}×{image.height})</span>
            {image.caption ? ` — ${image.caption}` : ""}
          </figcaption>
        </figure>
      ))}
    </section>
  );
}

function EvidenceStats({ stats }: { stats: NonNullable<McpUserPrompt["evidence"]>["stats"] }) {
  if (!stats) return null;
  return (
    <section>
      <SectionTitle>{stats.title ?? "Statistics"}</SectionTitle>
      {stats.metrics && stats.metrics.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
            gap: 4,
            marginBottom: stats.columns ? 8 : 0
          }}
        >
          {stats.metrics.map((metric, index) => (
            <div
              key={index}
              title={metric.hint}
              style={{
                background: "var(--bg)",
                border: "1px solid var(--l2)",
                borderRadius: 3,
                padding: "5px 8px",
                display: "flex",
                justifyContent: "space-between",
                gap: 8
              }}
            >
              <span style={{ font: "400 10.5px/1.3 var(--font)", color: "var(--ink2)" }}>{metric.label}</span>
              <span style={{ font: "600 11px/1.3 var(--mono)" }}>{metric.value}</span>
            </div>
          ))}
        </div>
      )}
      {stats.columns && stats.rows && (
        <div style={{ maxHeight: 220, overflow: "auto", border: "1px solid var(--l2)", borderRadius: 3 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", font: "400 10.5px/1.4 var(--mono)" }}>
            <thead>
              <tr>
                {stats.columns.map((column, index) => (
                  <th
                    key={index}
                    style={{
                      position: "sticky",
                      top: 0,
                      background: "var(--panel)",
                      textAlign: "left",
                      padding: "4px 8px",
                      borderBottom: "1px solid var(--l2)",
                      font: "600 10px/1.3 var(--font)"
                    }}
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stats.rows.map((row, rowIndex) => (
                <tr key={rowIndex} style={{ background: rowIndex % 2 ? "var(--bg)" : "transparent" }}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} style={{ padding: "3px 8px", whiteSpace: "nowrap" }}>
                      {cell === null ? <span style={{ color: "var(--ink2)" }}>—</span> : String(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function FieldInput({
  field,
  value,
  disabled,
  onChange
}: {
  field: McpPromptField;
  value: string | number | boolean | undefined;
  disabled: boolean;
  onChange: (value: string | number | boolean) => void;
}) {
  const label = (
    <span style={{ font: "400 10.5px/1.4 var(--font)", color: "var(--ink2)" }}>
      {field.label}
      {field.required ? " *" : ""}
      {field.hint ? ` — ${field.hint}` : ""}
    </span>
  );
  if (field.type === "boolean") {
    return (
      <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <input
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        {label}
      </label>
    );
  }
  const shared = {
    disabled,
    style: {
      width: "100%",
      boxSizing: "border-box" as const,
      padding: "5px 8px",
      font: "400 11.5px/1.4 var(--mono)",
      color: "var(--ink)",
      background: "var(--bg)",
      border: "1px solid var(--l2)",
      borderRadius: 3
    }
  };
  if (field.type === "select") {
    return (
      <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {label}
        <select
          {...shared}
          value={String(value ?? "")}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">—</option>
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      {label}
      <input
        {...shared}
        type={field.type === "number" ? "number" : "text"}
        value={value === undefined ? "" : String(value)}
        placeholder={field.placeholder}
        onChange={(event) => {
          const raw = event.target.value;
          if (field.type === "number") onChange(raw === "" ? "" : Number(raw));
          else onChange(raw);
        }}
      />
    </label>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="u" style={{ fontSize: 10, marginBottom: 4 }}>
      {children}
    </div>
  );
}

function remainingMs(expiresAt: string): number {
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) ? Math.max(0, parsed - Date.now()) : 0;
}

function formatDuration(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function kindHint(prompt: McpUserPrompt): string {
  switch (prompt.kind) {
    case "confirm":
      return "This is a yes/no approval. The client only acts if you approve.";
    case "choose":
      return "Pick the option that matches the evidence.";
    case "review":
      return "Review the evidence and answer in your own words.";
    default:
      return "Your answer goes straight back to the client.";
  }
}
