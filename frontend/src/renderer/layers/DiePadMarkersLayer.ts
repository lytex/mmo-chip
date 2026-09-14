import type { DieTransform, IOPin } from "shared";
import type { Layer, TileBounds } from "../types";
import { transformDiePoint } from "../../lib/ic-package/transform";

export interface DiePadLayerInputs {
  getPads: () => IOPin[];
  getTransform: () => DieTransform;
  getImgSize: () => { width: number; height: number };
  /** IDs that have at least one bond — render in bond colour. */
  getBondedPadIds: () => Set<string>;
  /** Pad id currently under cursor (snap preview). */
  getHoveredPadId: () => string | null;
  /** Optional IDs that should flash to indicate they're the current target. */
  getHighlightPadIds?: () => Set<string>;
}

export class DiePadMarkersLayer implements Layer {
  readonly id = "ic-package-pad-markers";
  private readonly inputs: DiePadLayerInputs;

  constructor(inputs: DiePadLayerInputs) {
    this.inputs = inputs;
  }

  draw(ctx: CanvasRenderingContext2D, _bounds: TileBounds): void {
    const pads = this.inputs.getPads();
    if (pads.length === 0) return;
    const transform = this.inputs.getTransform();
    const { width, height } = this.inputs.getImgSize();
    const bonded = this.inputs.getBondedPadIds();
    const hovered = this.inputs.getHoveredPadId();
    const highlights = this.inputs.getHighlightPadIds?.() ?? new Set<string>();

    const scale = ctx.getTransform().a || 1;
    // Marker radius in world units. Adjusted by zoom so it stays readable.
    const rPx = 4 / scale;
    const strokePx = 1.5 / scale;

    ctx.save();
    ctx.lineWidth = strokePx;
    for (const pad of pads) {
      const p = transformDiePoint(pad.x, pad.y, width, height, transform);
      const isBonded = bonded.has(pad.id);
      const isHover = hovered === pad.id;
      const isHi = highlights.has(pad.id);

      ctx.beginPath();
      ctx.arc(p.x, p.y, rPx, 0, Math.PI * 2);
      if (isBonded) {
        ctx.fillStyle = "rgba(0, 200, 100, 0.85)";
        ctx.strokeStyle = "rgba(0, 60, 30, 1)";
      } else if (isHover) {
        ctx.fillStyle = "rgba(255, 220, 80, 0.85)";
        ctx.strokeStyle = "rgba(120, 80, 0, 1)";
      } else if (isHi) {
        ctx.fillStyle = "rgba(80, 180, 255, 0.85)";
        ctx.strokeStyle = "rgba(20, 60, 120, 1)";
      } else {
        ctx.fillStyle = "rgba(255, 80, 80, 0.7)";
        ctx.strokeStyle = "rgba(120, 30, 30, 1)";
      }
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }
}
