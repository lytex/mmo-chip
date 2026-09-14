import { useEffect, useRef } from "react";

type Props = {
  open: boolean;
  onClose: () => void;
};

type ShortcutGroup = {
  title: string;
  items: { key: string; label: string }[];
};

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Navigation",
    items: [
      { key: "Shift+1", label: "Die Viewer" },
      { key: "Shift+2", label: "Merge Cells" },
      { key: "Shift+3", label: "RE Cell" },
      { key: "Shift+4", label: "Code" },
      { key: "Shift+5", label: "Netlist (Analog)" },
    ],
  },
  {
    title: "Die Viewer — Tools",
    items: [
      { key: "S", label: "Select" },
      { key: "W", label: "Wire (repeat: cycle metal)" },
      { key: "B", label: "Multi-Wire / Bus" },
      { key: "O", label: "Via (repeat: cycle type)" },
      { key: "K", label: "Measure / Ruler" },
      { key: "Shift+K", label: "Delete all rulers" },
      { key: "Delete", label: "Delete selected ruler(s)" },
      { key: "R", label: "Add Cell" },
      { key: "P", label: "I/O Point" },
      { key: "H", label: "Floorplan" },
      { key: "C", label: "Comment" },
      { key: "F", label: "Fit to Screen" },
      { key: "Space (hold)", label: "Pan" },
    ],
  },
  {
    title: "Die Viewer — Layers",
    items: [
      { key: "1–6", label: "Select metal ME1–ME6" },
      { key: "Alt+1–5", label: "Select via VIA12–VIA56" },
      { key: "E", label: "Via up (wire-end preview)" },
      { key: "Q", label: "Via down (wire-end preview)" },
    ],
  },
  {
    title: "Die Viewer — Overlays",
    items: [
      { key: "Space+B", label: "Toggle base image" },
      { key: "]", label: "Next overlay layer" },
      { key: "[", label: "Previous overlay layer" },
      { key: "Space+1–8", label: "Toggle overlay #1–#8" },
    ],
  },
  {
    title: "Die Viewer — Editing",
    items: [
      { key: "Ctrl+C", label: "Copy cell" },
      { key: "Ctrl+V", label: "Paste cell" },
      { key: "Shift+U", label: "Make unique" },
      { key: "Delete", label: "Delete selection" },
      { key: "Ctrl+Z", label: "Undo" },
      { key: "Ctrl+Shift+Z", label: "Redo" },
    ],
  },
  {
    title: "Die Viewer — General",
    items: [
      { key: "Ctrl+F", label: "Search nets / cells" },
      { key: "Ctrl+Shift+S", label: "Screenshot (PNG)" },
      { key: "+ / −", label: "Zoom in / out" },
      { key: "Ctrl+,", label: "Project settings" },
      { key: "Ctrl+/", label: "This help panel" },
    ],
  },
  {
    title: "RE Cell",
    items: [
      { key: "R", label: "Rect tool" },
      { key: "P", label: "Polygon tool" },
      { key: "O", label: "Point / via tool" },
      { key: "L", label: "Polyline (resistor)" },
      { key: "Ctrl+C / V", label: "Copy / Paste shapes" },
    ],
  },
  {
    title: "Merge Cells",
    items: [
      { key: "Alt+1", label: "Overlay mode" },
      { key: "Alt+2", label: "Side-by-side" },
      { key: "Alt+3", label: "Difference" },
      { key: "Alt+4", label: "Specimen only" },
      { key: "Alt+5", label: "Candidate only" },
      { key: "← →", label: "Navigate candidates" },
      { key: "F / G / H", label: "Flip H / Flip V / Rotate" },
      { key: "J", label: "Auto-align" },
      { key: "Y", label: "Accept & merge" },
    ],
  },
  {
    title: "Analog Netlist",
    items: [
      { key: "G", label: "Toggle Code / Graph" },
      { key: "H", label: "Toggle hierarchy" },
      { key: "R", label: "Resistor format toggle" },
      { key: "M", label: "Device matching toggle" },
      { key: "Alt+1–4", label: "View: Code / Graph / Schematic / LVS" },
    ],
  },
  {
    title: "Pin Planner",
    items: [
      { key: "S", label: "Pan / zoom" },
      { key: "T", label: "Text — name a package pin" },
      { key: "W", label: "Bond — pin, then die pad" },
    ],
  },
];

function Kbd({ children }: { children: string }) {
  return (
    <kbd
      style={{
        display: "inline-block",
        padding: "1px 5px",
        fontSize: 10,
        fontFamily: "var(--mono, monospace)",
        lineHeight: "16px",
        color: "var(--ink2)",
        background: "var(--bg)",
        border: "1px solid var(--l2)",
        borderRadius: 3,
        minWidth: 18,
        textAlign: "center",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </kbd>
  );
}

export function ShortcutsPanel({ open, onClose }: Props) {
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
          maxWidth: 680,
          width: "90%",
          maxHeight: "80vh",
          overflow: "auto",
          padding: "16px 20px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>
            Keyboard Shortcuts
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

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
            gap: 16,
          }}
        >
          {SHORTCUT_GROUPS.map((group) => (
            <div key={group.title}>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  color: "var(--ink3)",
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                  marginBottom: 6,
                }}
              >
                {group.title}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {group.items.map((item) => (
                  <div
                    key={item.key}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "2px 0",
                    }}
                  >
                    <Kbd>{item.key}</Kbd>
                    <span style={{ fontSize: 11, color: "var(--ink2)" }}>
                      {item.label}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
