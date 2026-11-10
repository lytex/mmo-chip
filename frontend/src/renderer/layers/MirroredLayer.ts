import type { ImageFlip } from "shared";
import type { Rect } from "../../lib/geometry";
import { flipRect, isFlipped, type ImageSize } from "../../lib/imageFlip";
import type { Layer, RenderFrame, TileBounds } from "../types";

/**
 * Shows a raw-image-space layer (die image, overlay images, wire map)
 * mirrored about the image centre (`DieAnnotations.imageFlip`). The inner
 * layer draws the mirrored source rect of each tile, unchanged, into a
 * scratch tile; that tile is then blitted flipped. Works whatever the inner
 * layer does with the context transform (opacity scratch canvases reset it),
 * and a mirror maps a tile exactly onto a tile, so there are no seams.
 */
export class MirroredLayer implements Layer {
  readonly id: string;
  private scratch: HTMLCanvasElement | null = null;

  constructor(
    private readonly inner: Layer,
    private readonly getFlip: () => ImageFlip | undefined,
    private readonly size: ImageSize
  ) {
    this.id = inner.id;
  }

  beginFrame(frame: RenderFrame): void {
    this.inner.beginFrame?.({ ...frame, world: flipRect(frame.world, this.getFlip(), this.size) });
  }

  draw(ctx: CanvasRenderingContext2D, bounds: TileBounds): void {
    const flip = this.getFlip();
    if (!isFlipped(flip)) {
      this.inner.draw(ctx, bounds);
      return;
    }
    const px = Math.max(1, Math.round(bounds.size * bounds.dpr));
    let scratch = this.scratch;
    if (!scratch) scratch = this.scratch = document.createElement("canvas");
    if (scratch.width !== px || scratch.height !== px) {
      scratch.width = px;
      scratch.height = px;
    }
    const sctx = scratch.getContext("2d");
    if (!sctx) return;
    const world = flipRect(bounds.world, flip, this.size);
    const k = px / bounds.world.width;
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, px, px);
    sctx.setTransform(k, 0, 0, k, -world.x * k, -world.y * k);
    sctx.save();
    this.inner.draw(sctx, { ...bounds, world });
    sctx.restore();

    ctx.save();
    ctx.setTransform(flip?.h ? -1 : 1, 0, 0, flip?.v ? -1 : 1, flip?.h ? px : 0, flip?.v ? px : 0);
    ctx.drawImage(scratch, 0, 0);
    ctx.restore();
  }

  subscribe(invalidate: (worldRect?: Rect) => void): () => void {
    return (
      this.inner.subscribe?.((rect) =>
        invalidate(rect && flipRect(rect, this.getFlip(), this.size))
      ) ?? (() => {})
    );
  }

  pendingLoads(): number {
    return this.inner.pendingLoads?.() ?? 0;
  }

  holdCache(hold: boolean): void {
    this.inner.holdCache?.(hold);
  }
}
