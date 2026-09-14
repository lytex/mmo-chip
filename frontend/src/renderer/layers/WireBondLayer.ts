import type { DieTransform, IOPin, PackagePin, WireBond } from "shared";
import type { Layer, TileBounds } from "../types";
import { transformDiePoint } from "../../lib/ic-package/transform";

export interface WireBondLayerInputs {
  getBonds: () => WireBond[];
  getPins: () => PackagePin[];
  getPads: () => IOPin[];
  getTransform: () => DieTransform;
  getImgSize: () => { width: number; height: number };
  getPxPerMm: () => number;
  getOriginPx: () => { x: number; y: number };
  /** When set, draws a preview line from this package pin to the cursor pad. */
  getBondPreview?: () => { pinNumber: number; padId: string } | null;
}

/** Convert package pin (mm, package-local) → die world px (source pixels). */
function pinToWorldPx(
  pin: PackagePin,
  pxPerMm: number,
  origin: { x: number; y: number }
): { x: number; y: number } {
  return { x: origin.x + pin.x * pxPerMm, y: origin.y + pin.y * pxPerMm };
}

/** Convert die pad (source px) → display px under current transform. */
function padToDisplay(
  pad: IOPin,
  img: { width: number; height: number },
  t: DieTransform
): { x: number; y: number } {
  return transformDiePoint(pad.x, pad.y, img.width, img.height, t);
}

export class WireBondLayer implements Layer {
  readonly id = "ic-package-bonds";
  private readonly inputs: WireBondLayerInputs;

  constructor(inputs: WireBondLayerInputs) {
    this.inputs = inputs;
  }

  draw(ctx: CanvasRenderingContext2D, _bounds: TileBounds): void {
    const bonds = this.inputs.getBonds();
    const pins = this.inputs.getPins();
    const pads = this.inputs.getPads();
    const transform = this.inputs.getTransform();
    const img = this.inputs.getImgSize();
    const pxPerMm = this.inputs.getPxPerMm();
    const origin = this.inputs.getOriginPx();
    const preview = this.inputs.getBondPreview?.() ?? null;

    const scale = ctx.getTransform().a || 1;
    const linePx = 1.5 / scale;

    const pinByNum = new Map(pins.map((p) => [p.number, p]));
    const padById = new Map(pads.map((p) => [p.id, p]));

    const drawBond = (b: WireBond, opts: { dashed?: boolean; alpha?: number }) => {
      const pin = pinByNum.get(b.pinNumber);
      const pad = padById.get(b.diePadId);
      if (!pin || !pad) return;
      const a = pinToWorldPx(pin, pxPerMm, origin);
      const z = padToDisplay(pad, img, transform);
      ctx.save();
      ctx.strokeStyle = `rgba(0, 180, 220, ${opts.alpha ?? 0.9})`;
      ctx.lineWidth = linePx;
      if (opts.dashed) ctx.setLineDash([6 / scale, 4 / scale]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(z.x, z.y);
      ctx.stroke();
      ctx.restore();
    };

    for (const b of bonds) drawBond(b, {});

    if (preview) drawBond(
      { id: "_preview", pinNumber: preview.pinNumber, diePadId: preview.padId },
      { dashed: true, alpha: 0.7 }
    );
  }
}
