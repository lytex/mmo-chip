import type { ReactNode, DragEventHandler } from "react";
import { Ic } from "../../icons";

export type ExpandState = "open" | "closed" | "leaf";

export type TreeRowProps = {
  depth?: number;
  expand?: ExpandState;
  swatch?: string;
  icon?: ReactNode;
  label: ReactNode;
  meta?: ReactNode;
  selected?: boolean;
  dimmed?: boolean;
  monoLabel?: boolean;
  onToggleExpand?: () => void;
  /** Click on the row body. Receives the mouse event so callers that support
   *  multi-select (e.g. the net list) can branch on shift/ctrl/cmd. */
  onSelect?: (e: React.MouseEvent) => void;
  /** Double-click the row (e.g. to frame this entity in the viewport). */
  onDoubleClick?: () => void;
  /** Triple-click the row (e.g. to solo layer selectability). */
  onTripleClick?: () => void;
  /** Optional native drag/drop hooks for reorderable rows. */
  draggable?: boolean;
  onDragStart?: DragEventHandler<HTMLDivElement>;
  onDragOver?: DragEventHandler<HTMLDivElement>;
  onDrop?: DragEventHandler<HTMLDivElement>;
  onDragEnd?: DragEventHandler<HTMLDivElement>;
  /** Render an eye / eye-off button at the right end; click toggles visibility. */
  visibility?: { visible: boolean; onToggle: () => void };
  /** Render a lock / unlock button next to the eye; click toggles selectability. */
  selectable?: { selectable: boolean; onToggle: () => void };
  /** Extra controls (small action buttons) rendered before the visibility eye. */
  controls?: ReactNode;
};

/**
 * One row of the outline tree, matching the hifi `.trow` design.
 * Caret area handles expand/collapse; the rest of the row handles selection.
 */
export function TreeRow({
  depth = 0,
  expand = "leaf",
  swatch,
  icon,
  label,
  meta,
  selected,
  dimmed,
  monoLabel,
  onToggleExpand,
  onSelect,
  onDoubleClick,
  onTripleClick,
  draggable,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  visibility,
  selectable,
  controls
}: TreeRowProps) {
  return (
    <div
      className={"trow" + (selected ? " sel" : "")}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      style={{
        paddingLeft: 4 + depth * 12,
        opacity: dimmed ? 0.58 : 1,
        cursor: onSelect || onTripleClick ? "pointer" : "default"
      }}
      onClick={
        onSelect || onTripleClick
          ? (e) => {
              e.stopPropagation();
              // Triple-click fires on the 3rd click's onClick event.
              if (onTripleClick && e.detail === 3) onTripleClick();
              else if (onSelect) onSelect(e);
            }
          : undefined
      }
      onDoubleClick={onDoubleClick ? (e) => { e.stopPropagation(); onDoubleClick(); } : undefined}
    >
      <span
        onClick={
          expand === "leaf" || !onToggleExpand
            ? undefined
            : (e) => {
                e.stopPropagation();
                onToggleExpand();
              }
        }
        style={{
          width: 10,
          color: "var(--ink3)",
          display: "inline-flex",
          cursor: expand === "leaf" || !onToggleExpand ? "default" : "pointer"
        }}
      >
        {expand === "open" ? Ic.caretD : expand === "closed" ? Ic.caretR : null}
      </span>
      {swatch && (
        <span
          style={{
            width: 8,
            height: 8,
            background: swatch,
            border: "1px solid rgba(0,0,0,0.15)",
            borderRadius: 1,
            flex: "0 0 auto"
          }}
        />
      )}
      {icon && (
        <span
          style={{
            display: "inline-flex",
            color: selected ? "var(--accent)" : "var(--ink3)"
          }}
        >
          {icon}
        </span>
      )}
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontFamily: monoLabel ? "var(--mono)" : "var(--font)",
          fontSize: monoLabel ? 10.5 : 11
        }}
      >
        {label}
      </span>
      {meta != null && <span className="meta">{meta}</span>}
      {controls && (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            marginLeft: meta == null ? "auto" : 4
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {controls}
        </span>
      )}
      {(selectable || visibility) && (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 2, marginLeft: meta == null && !controls ? "auto" : 4 }}>
          {selectable && (
            <button
              type="button"
              className="trow-eye"
              aria-label={selectable.selectable ? "lock" : "unlock"}
              aria-pressed={!selectable.selectable}
              onClick={(e) => {
                e.stopPropagation();
                selectable.onToggle();
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                background: "transparent",
                border: 0,
                padding: 0,
                color: selectable.selectable ? "var(--muted)" : "var(--ink)",
                cursor: "pointer"
              }}
            >
              {selectable.selectable ? Ic.unlock : Ic.lock}
            </button>
          )}
          {visibility && (
            <button
              type="button"
              className="trow-eye"
              aria-label={visibility.visible ? "hide" : "show"}
              aria-pressed={!visibility.visible}
              onClick={(e) => {
                e.stopPropagation();
                visibility.onToggle();
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                background: "transparent",
                border: 0,
                padding: 0,
                color: visibility.visible ? "var(--ink3)" : "var(--muted)",
                cursor: "pointer"
              }}
            >
              {visibility.visible ? Ic.eye : Ic.eyeOff}
            </button>
          )}
        </span>
      )}
    </div>
  );
}

/** Section separator between outline groups. */
export function TreeSep() {
  return <div style={{ borderTop: "1px solid var(--l1)", margin: "4px 0" }} />;
}
