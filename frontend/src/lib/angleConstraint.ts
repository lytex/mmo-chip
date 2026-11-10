/**
 * angleConstraint.ts — angle modes for placing the next point of a ruler,
 * wire / bus segment or polygon edge (floorplan, via polygon), relative to
 * the previous point:
 *
 *   free  — anywhere
 *   ortho — horizontal or vertical, whichever is closer
 *   h / v — horizontal only / vertical only
 *   diag  — nearest multiple of 45° (length kept)
 *
 * Each drawing tool keeps its own mode per die (preferences.angleModesByDie,
 * see state/angleMode). Holding Shift places freely in the wire, bus and
 * polygon tools.
 */

import type { Point } from "./geometry";

export type AngleMode = "free" | "ortho" | "h" | "v" | "diag";

/** Tools that place points under an angle mode. The bus shares "wire". */
export type AngleTool = "measure" | "wire" | "floorplan" | "viaPoly" | "traceRegionPoly";

export const ANGLE_MODES: { mode: AngleMode; label: string }[] = [
  { mode: "free", label: "free" },
  { mode: "ortho", label: "orthogonal" },
  { mode: "h", label: "horizontal" },
  { mode: "v", label: "vertical" },
  { mode: "diag", label: "diagonal" }
];

/** Defaults keep each tool's behavior from before modes existed. */
export const DEFAULT_ANGLE_MODES: Record<AngleTool, AngleMode> = {
  measure: "ortho",
  wire: "diag",
  floorplan: "free",
  viaPoly: "free",
  traceRegionPoly: "free"
};

export const isAngleMode = (v: unknown): v is AngleMode =>
  v === "free" || v === "ortho" || v === "h" || v === "v" || v === "diag";

/** `p` constrained to `mode` relative to `anchor`. */
export function constrainPoint(anchor: Point, p: Point, mode: AngleMode): Point {
  const dx = p.x - anchor.x;
  const dy = p.y - anchor.y;
  switch (mode) {
    case "h":
      return { x: p.x, y: anchor.y };
    case "v":
      return { x: anchor.x, y: p.y };
    case "ortho":
      return Math.abs(dx) >= Math.abs(dy) ? { x: p.x, y: anchor.y } : { x: anchor.x, y: p.y };
    case "diag": {
      const dist = Math.hypot(dx, dy);
      if (dist === 0) return { x: anchor.x, y: anchor.y };
      const step = Math.PI / 4;
      const a = Math.round(Math.atan2(dy, dx) / step) * step;
      return { x: anchor.x + dist * Math.cos(a), y: anchor.y + dist * Math.sin(a) };
    }
    default:
      return { x: p.x, y: p.y };
  }
}
