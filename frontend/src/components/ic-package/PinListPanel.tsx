import { useState } from "react";
import type { IOPin } from "shared";
import { useIcPackageStore } from "../../state/icPackage";

/** Right-panel list of package pins with inline name editing. */
export function PinListPanel({ pads }: { pads: IOPin[] }) {
  const pins = useIcPackageStore((s) => s.pins);
  const bonds = useIcPackageStore((s) => s.bonds);
  const tool = useIcPackageStore((s) => s.tool);
  const selectedPinNumber = useIcPackageStore((s) => s.selectedPinNumber);
  const namePin = useIcPackageStore((s) => s.namePin);
  const removePinName = useIcPackageStore((s) => s.removePinName);
  const selectPin = useIcPackageStore((s) => s.selectPin);
  const removeBond = useIcPackageStore((s) => s.removeBond);

  // Die viewer-style numbering: pad id → "#<pin>".
  const padNumber = new Map(pads.map((p) => [p.id, p.pin]));

  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");

  return (
    <div className="panel" style={{ padding: "8px 10px", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 600, flex: 1 }}>Pins</span>
        <span style={{ fontSize: 10, color: "var(--ink3)" }}>
          {tool === "name" ? "click pin → type" : tool === "bond" ? "click pin → click pad" : "pan/zoom"}
        </span>
      </div>
      <div style={{ overflowY: "auto", maxHeight: "calc(100vh - 280px)", border: "1px solid var(--rule)", borderRadius: 4 }}>
        <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
          <thead style={{ position: "sticky", top: 0, background: "var(--bg2)", zIndex: 1 }}>
            <tr style={{ color: "var(--ink3)" }}>
              <th style={{ textAlign: "left", padding: "4px 6px", width: 32 }}>#</th>
              <th style={{ textAlign: "left", padding: "4px 6px" }}>Name</th>
              <th style={{ textAlign: "left", padding: "4px 6px", width: 80 }}>Pad</th>
            </tr>
          </thead>
          <tbody>
            {pins.map((p) => {
              const bondsForPin = bonds.filter((b) => b.pinNumber === p.number);
              const isSel = tool === "bond" && selectedPinNumber === p.number;
              return (
                <tr
                  key={p.number}
                  onClick={() => {
                    if (tool === "bond") selectPin(p.number);
                  }}
                  style={{
                    cursor: tool === "bond" ? "pointer" : "default",
                    background: isSel ? "rgba(0, 200, 100, 0.15)" : undefined,
                  }}
                >
                  <td style={{ padding: "2px 6px", color: "var(--ink2)" }}>{p.number}</td>
                  <td style={{ padding: "2px 6px" }}>
                    {editing === p.number ? (
                      <input
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => {
                          if (draft.trim()) namePin(p.number, draft.trim());
                          else removePinName(p.number);
                          setEditing(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                          if (e.key === "Escape") {
                            setEditing(null);
                            setDraft("");
                          }
                        }}
                        style={{ width: "100%", fontSize: 11 }}
                      />
                    ) : (
                      <span
                        onClick={(e) => {
                          if (tool !== "name") return;
                          e.stopPropagation();
                          setEditing(p.number);
                          setDraft(p.name);
                        }}
                        style={{
                          cursor: tool === "name" ? "text" : "default",
                          color: p.name ? "var(--ink)" : "var(--ink3)",
                          fontStyle: p.name ? "normal" : "italic",
                        }}
                        title={tool === "name" ? "Click to edit" : ""}
                      >
                        {p.name || (tool === "name" ? "click to name" : "—")}
                      </span>
                    )}
                  </td>
                  <td style={{ padding: "2px 6px", color: "var(--ink3)", fontFamily: "ui-monospace, monospace", fontSize: 10 }}>
                    {bondsForPin.length > 0 ? (
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        {bondsForPin.map((b) => (
                          <span
                            key={b.id}
                            title="Remove bond"
                            onClick={(e) => {
                              e.stopPropagation();
                              removeBond(b.id);
                            }}
                            style={{ cursor: "pointer", color: "var(--accent)" }}
                          >
                            #{padNumber.get(b.diePadId) ?? b.diePadId.slice(0, 8)} ✕
                          </span>
                        ))}
                      </div>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
