import { useState, useCallback, type ReactNode } from "react";

type Props = {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  badge?: string | number;
};

export function CollapsibleSection({ title, children, defaultOpen = false, badge }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const toggle = useCallback(() => setOpen((v) => !v), []);

  return (
    <div style={{ borderTop: "1px solid var(--l2)" }}>
      <button
        onClick={toggle}
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 6,
          padding: "6px 8px", background: "transparent", border: "none",
          cursor: "pointer", color: "var(--ink3)", fontSize: 10,
          fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5,
          fontFamily: "inherit",
        }}
      >
        <span style={{ fontSize: 8, transition: "transform 0.15s", transform: open ? "rotate(90deg)" : "rotate(0deg)" }}>&#9654;</span>
        {title}
        {badge != null && <span style={{ fontWeight: 400, opacity: 0.6 }}>({badge})</span>}
      </button>
      {open && <div style={{ padding: "0 8px 8px" }}>{children}</div>}
    </div>
  );
}
