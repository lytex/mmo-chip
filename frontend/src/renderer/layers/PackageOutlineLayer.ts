import type { PackagePin } from "shared";
import type { Layer, TileBounds } from "../types";
import type { PackageGeom } from "../../lib/ic-package/footprinter";

/** Live inputs read fresh each draw so store changes show without rebuild. */
export interface PackageLayerInputs {
  /** Physical bounds (mm) from footprinter — does NOT carry user names. */
  getGeom: () => PackageGeom | null;
  /** Current pins from the store (with user-edited names). */
  getPins: () => PackagePin[];
  /** Pixels per millimetre — drives how big the package renders on the die. */
  getPxPerMm: () => number;
  /** Pin number of the user-selected package pin (for highlight), or null. */
  getSelectedPin: () => number | null;
  /** Pin number under the cursor (hover), or null. */
  getHoveredPin: () => number | null;
}

/** Where in the die's source-pixel space to place the package's origin.
 *  Default: (0, 0) — top-left corner. The caller can offset this via
 *  `getOriginPx` if they want to center the package on the die. */
export interface PackageLayerOptions {
  getOriginPx?: () => { x: number; y: number };
}

export class PackageOutlineLayer implements Layer {
  readonly id = "ic-package-outline";
  private readonly inputs: PackageLayerInputs;
  private readonly opts: PackageLayerOptions;

  constructor(inputs: PackageLayerInputs, opts: PackageLayerOptions = {}) {
    this.inputs = inputs;
    this.opts = opts;
  }

  draw(ctx: CanvasRenderingContext2D, _bounds: TileBounds): void {
    const geom = this.inputs.getGeom();
    const pins = this.inputs.getPins();
    if (!geom || pins.length === 0) return;
    const px = this.inputs.getPxPerMm();
    const origin = this.opts.getOriginPx?.() ?? { x: 0, y: 0 };
    const sel = this.inputs.getSelectedPin();
    const hov = this.inputs.getHoveredPin();

    // Body outline — light grey rectangle around the pin extents.
    const { minX, minY, maxX, maxY } = geom.body;
    const bodyScale = ctx.getTransform().a || 1;
    ctx.save();
    ctx.fillStyle = "rgba(200, 200, 200, 0.06)";
    ctx.strokeStyle = "rgba(160, 160, 160, 0.7)";
    ctx.lineWidth = 2 / bodyScale;
    ctx.beginPath();
    ctx.rect(
      origin.x + minX * px,
      origin.y + minY * px,
      (maxX - minX) * px,
      (maxY - minY) * px
    );
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // Pin pads + labels.
    const scale = ctx.getTransform().a || 1;
    const numFontPx = Math.max(8, Math.min(13, scale * 1.3));
    // Pin name text is intentionally large so datasheet labels read at a
    // glance, even when many pins are in view.
    const nameFontPx = Math.max(11, Math.min(22, scale * 2.4));
    for (const pin of pins) {
      const cx = origin.x + pin.x * px;
      const cy = origin.y + pin.y * px;
      const w = pin.w * px;
      const h = pin.h * px;
      const isSel = pin.number === sel;
      const isHov = pin.number === hov;

      ctx.save();
      ctx.fillStyle = isSel
        ? "rgba(0, 200, 100, 0.6)"
        : isHov
          ? "rgba(255, 220, 80, 0.6)"
          : "rgba(160, 130, 60, 0.5)";
      ctx.strokeStyle = isSel
        ? "rgba(0, 200, 100, 1)"
        : isHov
          ? "rgba(255, 220, 80, 1)"
          : "rgba(120, 100, 50, 1)";
      ctx.lineWidth = 1.5 / scale;
      ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
      ctx.strokeRect(cx - w / 2, cy - h / 2, w, h);
      ctx.restore();

      // Pin number: small white-bordered text floating to the package-outside
      // (away from die center). Always shown so the user can identify pins
      // without hovering. Name (when present) is drawn a bit further out.
      const offsetX = w / 2 + 5 / scale;
      const tx = origin.x + pin.x * px + offsetX;
      const ty = origin.y + pin.y * px + numFontPx * 0.35;

      ctx.save();
      ctx.font = `bold ${numFontPx}px ui-monospace, monospace`;
      ctx.textBaseline = "alphabetic";
      // Filled rounded "chip" behind the number for legibility on any image.
      const numText = `${pin.number}`;
      const m = ctx.measureText(numText);
      const chipW = m.width + 6 / scale;
      const chipH = numFontPx + 2 / scale;
      const chipX = tx - 3 / scale;
      const chipY = ty - chipH + 2 / scale;
      ctx.fillStyle = "rgba(40, 30, 10, 0.92)";
      ctx.strokeStyle = "rgba(255, 200, 80, 0.95)";
      ctx.lineWidth = 1 / scale;
      // Rounded rect via path so we don't depend on roundRect (newer API).
      const r = 2 / scale;
      ctx.beginPath();
      ctx.moveTo(chipX + r, chipY);
      ctx.lineTo(chipX + chipW - r, chipY);
      ctx.arcTo(chipX + chipW, chipY, chipX + chipW, chipY + r, r);
      ctx.lineTo(chipX + chipW, chipY + chipH - r);
      ctx.arcTo(chipX + chipW, chipY + chipH, chipX + chipW - r, chipY + chipH, r);
      ctx.lineTo(chipX + r, chipY + chipH);
      ctx.arcTo(chipX, chipY + chipH, chipX, chipY + chipH - r, r);
      ctx.lineTo(chipX, chipY + r);
      ctx.arcTo(chipX, chipY, chipX + r, chipY, r);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "rgba(255, 230, 120, 1)";
      ctx.fillText(numText, tx, ty);
      ctx.restore();

      if (pin.name) {
        const ntx = tx;
        const nty = ty + nameFontPx + 2 / scale;
        ctx.save();
        ctx.font = `bold ${nameFontPx}px ui-monospace, monospace`;
        ctx.fillStyle = "rgba(0, 0, 0, 1)";
        ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
        ctx.lineWidth = 3.5 / scale;
        ctx.lineJoin = "round";
        ctx.strokeText(pin.name, ntx, nty);
        ctx.fillText(pin.name, ntx, nty);
        ctx.restore();
      }
    }
  }
}
