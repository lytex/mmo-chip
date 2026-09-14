import { useEffect, useRef } from "react";

/**
 * What the canvas right-click handler resolved at the cursor: the world point
 * to anchor "start wire from here" at, plus an optional `DrawAnchor` when the
 * cursor landed on an existing net vertex (so the new wire extends that net
 * instead of starting a fresh one), plus how many *selected* points the
 * "start multi-wire" entry should fan out across (0–N — the menu disables the
 * item when there's nothing usable).
 */
export interface DieContextMenuState {
  /** Viewport-relative screen coords for menu placement. */
  screenX: number;
  screenY: number;
  /** World point used by "Start wire from here". */
  hitPoint: { x: number; y: number };
  /** Existing net vertex the cursor landed on, or null. */
  hitAnchor: { netId: string; nodeId: string } | null;
  /** Human-readable label for the "from here" item (e.g. "from ML via",
   *  "from net vertex", "from this point"). */
  hitLabel: string;
  /** How many points the current selection contributes to multi-wire. */
  multiPointCount: number;
  /** If the right-click landed on a cell instance, its id. */
  hitCellId?: string;
  /** Annotation part id under the cursor, e.g. `net:id/edge:edgeId`. */
  hitPartId?: string;
  /** If the right-click landed on a ruler, its id. */
  hitRulerId?: string;
}

interface Props {
  menu: DieContextMenuState;
  onClose: () => void;
  onStartWire: () => void;
  onStartMultiWire: () => void;
  onCopyCell?: () => void;
  onPasteCell?: () => void;
  onCopyNet?: () => void;
  onPasteNet?: () => void;
  hasWireClipboard?: boolean;
  hasCellClipboard?: boolean;
  onMakeUnique?: () => void;
  onDeleteRuler?: () => void;
  onSetScaleFromRuler?: () => void;
}

/** Right-click menu on the die-viewer canvas. Items today: start a single
 *  wire from the cursor (always available), and start a multi-wire bus from
 *  the current selection's via/vertex points (enabled with ≥2 sources). */
export function DieContextMenu({
  menu,
  onClose,
  onStartWire,
  onStartMultiWire,
  onCopyCell,
  onPasteCell,
  onCopyNet,
  onPasteNet,
  hasWireClipboard,
  hasCellClipboard,
  onMakeUnique,
  onDeleteRuler,
  onSetScaleFromRuler
}: Props) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Clamp inside the viewport — same simple guard the other context menus use.
  const x = Math.min(menu.screenX, window.innerWidth - 240);
  const y = Math.min(menu.screenY, window.innerHeight - 120);

  const canMulti = menu.multiPointCount >= 2;

  return (
    <div
      ref={ref}
      className="menu"
      style={{ position: "fixed", left: x, top: y, zIndex: 1000, minWidth: 220 }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button
        className="menu-item"
        onClick={() => {
          onStartWire();
          onClose();
        }}
      >
        Start wire {menu.hitLabel}
      </button>
      <button
        className="menu-item"
        disabled={!canMulti}
        title={
          canMulti
            ? undefined
            : "Select two or more vias or net vertices first"
        }
        onClick={() => {
          if (!canMulti) return;
          onStartMultiWire();
          onClose();
        }}
      >
        {canMulti
          ? `Start multi-wire from ${menu.multiPointCount} points`
          : "Start multi-wire from selection"}
      </button>
      {menu.hitRulerId && (
        <>
          <div className="menu-sep" />
          <button className="menu-item" onClick={() => { onSetScaleFromRuler?.(); onClose(); }}>
            Set scale from ruler
          </button>
          <button className="menu-item" onClick={() => { onDeleteRuler?.(); onClose(); }}>
            Delete ruler <span style={{ marginLeft: "auto", color: "var(--ink3)" }}>Del</span>
          </button>
        </>
      )}
      {menu.hitCellId && onCopyCell && (
        <>
          <div className="menu-sep" />
          <button className="menu-item" onClick={() => { onCopyCell(); onClose(); }}>
            Copy Cell  <span style={{ marginLeft: "auto", color: "var(--ink3)" }}>⌘C</span>
          </button>
          <button className="menu-item" onClick={() => { onMakeUnique?.(); onClose(); }}>
            Make Unique  <span style={{ marginLeft: "auto", color: "var(--ink3)" }}>⇧U</span>
          </button>
        </>
      )}
      {!menu.hitCellId && onCopyNet && menu.hitPartId?.startsWith("net:") && (
        <>
          <div className="menu-sep" />
          <button className="menu-item" onClick={() => { onCopyNet(); onClose(); }}>
            Copy Wire <span style={{ marginLeft: "auto", color: "var(--ink3)" }}>Ctrl+C</span>
          </button>
        </>
      )}
      {!menu.hitCellId && onPasteCell && (hasCellClipboard || hasWireClipboard) && (
        <>
          <div className="menu-sep" />
          <button className="menu-item" onClick={() => { onPasteCell(); onClose(); }}>
            {hasCellClipboard && hasWireClipboard ? "Paste Selection" : "Paste Cell"}
            <span style={{ marginLeft: "auto", color: "var(--ink3)" }}>Ctrl+V</span>
          </button>
        </>
      )}
      {!menu.hitCellId && onPasteNet && hasWireClipboard && !hasCellClipboard && (
        <>
          <div className="menu-sep" />
          <button className="menu-item" onClick={() => { onPasteNet(); onClose(); }}>
            Paste Wire <span style={{ marginLeft: "auto", color: "var(--ink3)" }}>Ctrl+V</span>
          </button>
        </>
      )}
    </div>
  );
}
