import type { Layer, TileBounds } from "../types";

export interface StaticImageLayerInputs {
  /** Image to draw, or null when the layer should no-op. */
  getImage: () => HTMLImageElement | null;
  /** Source-pixel rectangle the image occupies. Default: [0, 0, w, h] where w/h
   *  come from `naturalWidth` / `naturalHeight` of the image. */
  getBounds?: () => { x: number; y: number; width: number; height: number };
  /** Opacity multiplier 0..1. Default 1. */
  getOpacity?: () => number;
  /** "die transform" applied to the image (rotation+mirror around center). */
  getTransform?: () => { rotationDeg: number; mirrorX: boolean; mirrorY: boolean } | null;
}

/** Draws a single (non-tiled) image as the canvas background, optionally
 *  with rotation+mirror. Used by the IC Package view to render a user-selected
 *  overlay image in place of the base die photo. */
export class StaticImageLayer implements Layer {
  readonly id = "static-image";
  private readonly inputs: StaticImageLayerInputs;
  private readonly imgEl: HTMLImageElement | null;

  constructor(inputs: StaticImageLayerInputs) {
    this.inputs = inputs;
    this.imgEl = inputs.getImage();
  }

  draw(ctx: CanvasRenderingContext2D, _bounds: TileBounds): void {
    const img = this.inputs.getImage();
    if (!img || !img.complete || img.naturalWidth === 0) return;
    const opacity = this.inputs.getOpacity?.() ?? 1;
    if (opacity <= 0) return;

    let w: number, h: number;
    let x = 0, y = 0;
    const explicit = this.inputs.getBounds?.();
    if (explicit) {
      x = explicit.x; y = explicit.y;
      w = explicit.width; h = explicit.height;
    } else {
      w = img.naturalWidth;
      h = img.naturalHeight;
    }

    const t = this.inputs.getTransform?.() ?? null;
    ctx.save();
    if (opacity < 1) ctx.globalAlpha = opacity;
    if (t) {
      const cx = x + w / 2;
      const cy = y + h / 2;
      ctx.translate(cx, cy);
      ctx.rotate((t.rotationDeg * Math.PI) / 180);
      ctx.scale(t.mirrorX ? -1 : 1, t.mirrorY ? -1 : 1);
      ctx.translate(-cx, -cy);
    }
    ctx.drawImage(img, x, y, w, h);
    ctx.restore();
  }
}
