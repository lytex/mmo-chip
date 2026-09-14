import type { DieMetadata, DieTransform } from "shared";
import type { Rect } from "../../lib/geometry";
import type { Layer, TileBounds } from "../types";

const MAX_IMAGE_TILES_CACHED = 256;

interface CachedImageTile {
  z: number;
  x: number;
  y: number;
  image: HTMLImageElement;
  loaded: boolean;
  failed: boolean;
  lastUsed: number;
}

/**
 * Renders the backend-tiled die image into the tiled renderer's offscreen
 * canvases. World coordinates == source image pixel coordinates.
 *
 * Backend `levels[z].scale` is **source pixels per level pixel** — level 0 is
 * the coarsest (largest scale, one tile covering the whole die), and
 * `levels[maxZoomLevel]` is full resolution (scale = 1). So:
 *
 *   sourceCoord = levelCoord * scale
 *   levelCoord  = sourceCoord / scale
 *
 * One level pixel rendered at display zoom Z spans `scale * Z` CSS pixels.
 * We pick the coarsest level whose `scale ≤ 1/Z` so each level pixel is at
 * most one CSS pixel (no upsampling), keeping tile count small.
 */
/** Live display controls for the base image (read fresh each draw so pref
 *  changes take effect on the next invalidate without rebuilding the layer). */
export interface DieImageDisplay {
  /** True → don't paint the image at all. */
  getHidden?: () => boolean;
  /** 0..1 multiplier applied to the painted image. */
  getOpacity?: () => number;
  /** Rotation+mirror applied to the entire image (die-image-pixel space).
   *  Image is treated as anchored at its center. Return null/undefined to skip. */
  getTransform?: () => DieTransform | null;
}

export class DieImageLayer implements Layer {
  readonly id = "die-image";
  private readonly metadata: DieMetadata;
  private readonly cache = new Map<string, CachedImageTile>();
  private useCounter = 0;
  private invalidateCb: ((rect?: Rect) => void) | null = null;
  private readonly display: DieImageDisplay;
  /** Reused scratch canvas for opacity compositing (tiles render serially, so
   *  one is safe). Lazily created / resized to the tile's device size. */
  private scratch: HTMLCanvasElement | null = null;
  /** Scratch canvas for rotated image rendering — full source image drawn
   *  once, then blitted with rotation. Avoids per-tile clipping artifacts. */
  private scratchRotated: HTMLCanvasElement | null = null;

  constructor(metadata: DieMetadata, display: DieImageDisplay = {}) {
    this.metadata = metadata;
    this.display = display;
  }

  subscribe(invalidate: (worldRect?: Rect) => void): () => void {
    this.invalidateCb = invalidate;
    return () => {
      this.invalidateCb = null;
    };
  }

  draw(ctx: CanvasRenderingContext2D, bounds: TileBounds): void {
    if (this.display.getHidden?.()) return;
    const opacity = this.display.getOpacity?.() ?? 1;
    if (opacity <= 0) return;
    const transform = this.display.getTransform?.() ?? null;
    const isRotated = !!transform && (transform.rotationDeg !== 0 || transform.mirrorX || transform.mirrorY);

    // When the image is rotated, per-tile rendering clips the rotated content
    // because each tile canvas is only 256×256 CSS pixels.  Render the full
    // source image into a scratch canvas first, then blit it with the rotation
    // transform applied — avoids tile-boundary artifacts entirely.
    if (isRotated) {
      this.drawRotated(ctx, bounds, transform, opacity);
      return;
    }

    const { world, zoom } = bounds;
    const targetLevel = this.pickLevel(zoom);

    const drawPyramid = (g: CanvasRenderingContext2D) => {
      for (let level = 0; level < targetLevel; level++) {
        this.drawLevel(g, level, world, false);
      }
      this.drawLevel(g, targetLevel, world, true);
    };

    if (opacity >= 1) {
      drawPyramid(ctx);
      this.evictIfNeeded();
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
    if (!sctx) {
      ctx.save();
      ctx.globalAlpha = opacity;
      drawPyramid(ctx);
      ctx.restore();
      this.evictIfNeeded();
      return;
    }

    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, px, px);
    sctx.scale(bounds.dpr * zoom, bounds.dpr * zoom);
    sctx.translate(-world.x, -world.y);
    drawPyramid(sctx);

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = opacity;
    ctx.drawImage(scratch, 0, 0);
    ctx.restore();

    this.evictIfNeeded();
  }

  /** Axis-aligned bbox of a point rotated with the given transform. */
  private static rotateCorner(
    px: number, py: number,
    cx: number, cy: number,
    t: DieTransform
  ): { x: number; y: number } {
    let x = px - cx;
    let y = py - cy;
    if (t.mirrorX) x = -x;
    if (t.mirrorY) y = -y;
    const rad = (t.rotationDeg * Math.PI) / 180;
    const rx = x * Math.cos(rad) - y * Math.sin(rad);
    const ry = x * Math.sin(rad) + y * Math.cos(rad);
    return { x: rx + cx, y: ry + cy };
  }

  /**
   * Renders the full source image with rotation into a scratch canvas, then
   * blits it to the main canvas.  This avoids the per-tile clipping artifact
   * where rotated content extends beyond the 256×256 tile canvas bounds.
   */
  private drawRotated(
    ctx: CanvasRenderingContext2D,
    bounds: TileBounds,
    transform: DieTransform,
    opacity: number
  ): void {
    const meta = this.metadata;
    const { world, zoom, dpr } = bounds;
    const imgW = meta.width;
    const imgH = meta.height;
    const cx = imgW / 2;
    const cy = imgH / 2;

    // Compute the axis-aligned bbox of the rotated image in world coords.
    const c0 = DieImageLayer.rotateCorner(0, 0, cx, cy, transform);
    const c1 = DieImageLayer.rotateCorner(imgW, 0, cx, cy, transform);
    const c2 = DieImageLayer.rotateCorner(0, imgH, cx, cy, transform);
    const c3 = DieImageLayer.rotateCorner(imgW, imgH, cx, cy, transform);
    const bboxMinX = Math.min(c0.x, c1.x, c2.x, c3.x);
    const bboxMinY = Math.min(c0.y, c1.y, c2.y, c3.y);
    const bboxMaxX = Math.max(c0.x, c1.x, c2.x, c3.x);
    const bboxMaxY = Math.max(c0.y, c1.y, c2.y, c3.y);

    const scratchW = Math.max(1, Math.ceil((bboxMaxX - bboxMinX) * dpr * zoom));
    const scratchH = Math.max(1, Math.ceil((bboxMaxY - bboxMinY) * dpr * zoom));

    let scratch = this.scratchRotated;
    if (!scratch) scratch = this.scratchRotated = document.createElement("canvas");
    if (scratch.width !== scratchW || scratch.height !== scratchH) {
      scratch.width = scratchW;
      scratch.height = scratchH;
    }
    const sctx = scratch.getContext("2d");
    if (!sctx) return;

    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, scratchW, scratchH);

    // Draw the full source pyramid into the scratch canvas at original
    // (unrotated) positions, offset by (-bboxMinX, -bboxMinY) so the rotated
    // bbox origin aligns with (0,0).
    sctx.scale(dpr * zoom, dpr * zoom);
    sctx.translate(-bboxMinX, -bboxMinY);
    for (let level = 0; level < meta.levels.length; level++) {
      this.drawLevel(sctx, level, { x: 0, y: 0, width: imgW, height: imgH }, level < meta.levels.length - 1);
    }

    // Blit the scratch canvas to the main canvas.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (opacity < 1) ctx.globalAlpha = opacity;
    const devX = (bboxMinX - world.x) * dpr * zoom;
    const devY = (bboxMinY - world.y) * dpr * zoom;
    ctx.drawImage(scratch, Math.round(devX), Math.round(devY));
    ctx.restore();

    this.evictIfNeeded();
  }

  private drawLevel(
    ctx: CanvasRenderingContext2D,
    level: number,
    world: Rect,
    fetchMissing: boolean
  ): void {
    const meta = this.metadata;
    const levelMeta = meta.levels[level];
    if (!levelMeta) return;

    const ts = meta.tileSize;
    const scale = levelMeta.scale;
    const tileWorldSize = ts * scale;

    const minTx = Math.max(0, Math.floor(world.x / tileWorldSize));
    const minTy = Math.max(0, Math.floor(world.y / tileWorldSize));
    const maxTx = Math.min(
      levelMeta.columns - 1,
      Math.floor((world.x + world.width - 1e-6) / tileWorldSize)
    );
    const maxTy = Math.min(
      levelMeta.rows - 1,
      Math.floor((world.y + world.height - 1e-6) / tileWorldSize)
    );
    if (minTx > maxTx || minTy > maxTy) return;

    for (let tx = minTx; tx <= maxTx; tx++) {
      for (let ty = minTy; ty <= maxTy; ty++) {
        const key = `${level}/${tx}/${ty}`;
        let tile = this.cache.get(key);
        if (!tile) {
          if (!fetchMissing) continue;
          tile = this.getOrLoadTile(level, tx, ty);
        }
        if (!tile.loaded || tile.failed) continue;
        const worldX = tx * tileWorldSize;
        const worldY = ty * tileWorldSize;
        const worldW = tile.image.naturalWidth * scale;
        const worldH = tile.image.naturalHeight * scale;
        ctx.drawImage(tile.image, worldX, worldY, worldW, worldH);
        tile.lastUsed = ++this.useCounter;
      }
    }
  }

  /** Coarsest level whose scale is ≤ 1/zoom (so each level pixel is ≤ 1 CSS pixel). */
  private pickLevel(zoom: number): number {
    const levels = this.metadata.levels;
    const maxScale = 1 / Math.max(zoom, 1e-6);
    for (let z = 0; z < levels.length; z++) {
      if (levels[z].scale <= maxScale) return z;
    }
    return levels.length - 1;
  }

  private getOrLoadTile(z: number, x: number, y: number): CachedImageTile {
    const key = `${z}/${x}/${y}`;
    const existing = this.cache.get(key);
    if (existing) return existing;

    const image = new Image();
    image.decoding = "async";
    const entry: CachedImageTile = {
      z,
      x,
      y,
      image,
      loaded: false,
      failed: false,
      lastUsed: ++this.useCounter
    };
    this.cache.set(key, entry);

    const levelMeta = this.metadata.levels[z];
    const tileWorldSize = this.metadata.tileSize * levelMeta.scale;
    const worldX = x * tileWorldSize;
    const worldY = y * tileWorldSize;

    image.addEventListener("load", () => {
      entry.loaded = true;
      // We can't know natural dimensions until load, so invalidate using
      // the worst-case full tile rect — slightly conservative is fine.
      this.invalidateCb?.({
        x: worldX,
        y: worldY,
        width: tileWorldSize,
        height: tileWorldSize
      });
    });
    image.addEventListener("error", () => {
      entry.failed = true;
    });

    image.src = `/api/dies/${this.metadata.id}/tiles/${z}/${x}/${y}`;
    return entry;
  }

  private evictIfNeeded() {
    if (this.cache.size <= MAX_IMAGE_TILES_CACHED) return;
    const entries = [...this.cache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const drop = this.cache.size - MAX_IMAGE_TILES_CACHED;
    for (let i = 0; i < drop; i++) this.cache.delete(entries[i][0]);
  }
}
