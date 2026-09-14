/**
 * DirectiveEditor — textarea for ngspice directives.
 *
 * Provides the DUT subcircuit header, source definitions, analysis commands,
 * and allows free-form editing.
 */

import { useCallback, useRef, useEffect } from "react";

type Props = {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
};

const DEFAULT_DIRECTIVES = `* ── Sources ──
VDD VDD GND 1.8
VIN in GND AC 1 PULSE(0 1.8 1n 100p 100p 5n 10n)

* ── Load ──
CL out GND 1p

* ── Analysis ──
.tran 10p 20n

* ── Output ──
.control
run
plot v(out)
.endc
`;

export function DirectiveEditor({ value, onChange, readOnly = false }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-resize
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.max(120, ta.scrollHeight)}px`;
  }, [value]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onChange(e.target.value);
    },
    [onChange],
  );

  // Tab key inserts spaces instead of moving focus
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Tab") {
        e.preventDefault();
        const ta = e.currentTarget;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const next = value.substring(0, start) + "  " + value.substring(end);
        onChange(next);
        // Restore cursor
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = start + 2;
        });
      }
    },
    [value, onChange],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 2px",
        }}
      >
        <span style={{ fontSize: 10, fontWeight: 600, color: "var(--ink3, #666)", textTransform: "uppercase", letterSpacing: 0.5 }}>
          ngspice Directives
        </span>
        <button
          className="btn ghost"
          style={{ fontSize: 10 }}
          onClick={() => onChange(DEFAULT_DIRECTIVES)}
          title="Reset to default directives"
        >
          Reset
        </button>
      </div>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        readOnly={readOnly}
        spellCheck={false}
        style={{
          width: "100%",
          minHeight: 120,
          padding: "8px 10px",
          fontSize: 11,
          fontFamily: "var(--font-mono, 'Consolas', monospace)",
          lineHeight: 1.5,
          background: "var(--bg, #15140f)",
          color: "var(--ink, #ece8de)",
          border: "1px solid var(--l2, #333)",
          borderRadius: 4,
          resize: "vertical",
          outline: "none",
          tabSize: 2,
        }}
      />
    </div>
  );
}

export { DEFAULT_DIRECTIVES };
