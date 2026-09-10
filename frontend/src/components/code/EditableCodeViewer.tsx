import { forwardRef, useImperativeHandle, useMemo, useRef } from "react";

/**
 * EditableCodeViewer — a plain textarea editor for hand-sketching a netlist,
 * styled to match `CodeViewer`'s gutter/line look. No syntax highlighting or
 * search (the read-only `CodeViewer` covers that); this exists purely so a
 * generated netlist can be edited and re-parsed by `parseNetlistToDevices`.
 */

export interface EditableCodeViewerHandle {
  goToLine: (line: number) => void;
}

interface EditableCodeViewerProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

const LINE_HEIGHT = 18;

export const EditableCodeViewer = forwardRef<EditableCodeViewerHandle, EditableCodeViewerProps>(
  function EditableCodeViewer({ value, onChange, placeholder }, ref) {
    const gutterRef = useRef<HTMLDivElement | null>(null);
    const taRef = useRef<HTMLTextAreaElement | null>(null);

    const lineCount = useMemo(() => value.split("\n").length, [value]);

    useImperativeHandle(
      ref,
      () => ({
        goToLine: (line: number) => {
          const ta = taRef.current;
          if (!ta) return;
          const lines = value.split("\n");
          const idx = Math.max(0, Math.min(line - 1, lines.length - 1));
          let start = 0;
          for (let i = 0; i < idx; i++) start += lines[i].length + 1;
          const end = start + lines[idx].length;
          ta.focus();
          ta.setSelectionRange(start, end);
          const top = idx * LINE_HEIGHT;
          const view = ta.clientHeight;
          if (top < ta.scrollTop || top > ta.scrollTop + view - LINE_HEIGHT * 2) {
            ta.scrollTop = Math.max(0, top - view / 2);
          }
        },
      }),
      [value],
    );

    const syncScroll = () => {
      if (gutterRef.current && taRef.current) {
        gutterRef.current.scrollTop = taRef.current.scrollTop;
      }
    };

    return (
      <div
        className="cv"
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          display: "flex",
          overflow: "hidden",
          background: "var(--card)",
        }}
      >
        <div
          ref={gutterRef}
          style={{
            width: 44,
            flex: "0 0 auto",
            overflow: "hidden",
            background: "var(--cv-gutter, var(--panel))",
            borderRight: "1px solid var(--l1)",
          }}
        >
          {Array.from({ length: lineCount }, (_, i) => (
            <div
              key={i}
              style={{
                height: LINE_HEIGHT,
                lineHeight: `${LINE_HEIGHT}px`,
                textAlign: "right",
                paddingRight: 8,
                color: "var(--ink3)",
                font: "10.5px/18px var(--mono)",
              }}
            >
              {i + 1}
            </div>
          ))}
        </div>
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onScroll={syncScroll}
          spellCheck={false}
          placeholder={placeholder}
          onKeyDown={(e) => {
            if (e.key === "Tab") {
              e.preventDefault();
              const ta = e.currentTarget;
              const { selectionStart, selectionEnd } = ta;
              const next = value.slice(0, selectionStart) + "  " + value.slice(selectionEnd);
              onChange(next);
              requestAnimationFrame(() => {
                ta.selectionStart = ta.selectionEnd = selectionStart + 2;
              });
            }
          }}
          style={{
            flex: "1 1 auto",
            resize: "none",
            border: "none",
            outline: "none",
            padding: "0 12px",
            font: "11.5px/18px var(--mono)",
            color: "var(--fg)",
            background: "transparent",
            whiteSpace: "pre",
            overflow: "auto",
          }}
        />
      </div>
    );
  },
);
