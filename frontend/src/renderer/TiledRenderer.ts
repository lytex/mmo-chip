import type { Rect } from "../lib/geometry";
import type { Layer, RenderFrame, Viewport } from "./types";
import { PngStreamEncoder } from "../lib/pngStream";

const DEFAULT_TILE_SIZE = 256;
/** Output px per side of the tiles (and height of the bands) a snapshot is
 *  rendered in. */
const SNAPSHOT_TILE = 512;

export interface SnapshotProgress {
  /** Bands finished so far, of `bands`. */
  band: number;
  bands: number;
  /** Image tiles the current band still waits for. */
  pendingTiles: number;
}
const MAX_CACHED_TILES = 256;

type TileKey = string; // "i,j"

interface CachedTile {
  i: number;
  j: number;
  canvas: HTMLCanvasElement;
  /** Zoom level the tile was rendered at — when zoom changes, all tiles must be re-rendered. */
  zoom: number;
  /** Monotonic counter for LRU eviction. */
  lastUsed: number;
}

export interface TiledRendererOptions {
  tileSize?: number;
  /** Canvas background color (drawn before any layer). */
  background?: string;
  /** Called whenever the viewport changes via setViewport (useful for status bar coords). */
  onViewportChange?: (viewport: Viewport) => void;
}

/**
 * Imperative tiled 2D canvas renderer. Owns a single visible <canvas> and a
 * cache of offscreen tile canvases, each TILE_SIZE × dpr pixels. Tiles are
 * anchored to world coordinates: tile (i, j) covers world rect
 * `[i·tw, j·tw]` to `[(i+1)·tw, (j+1)·tw]` where `tw = TILE_SIZE / zoom`.
 *
 * Lifecycle:
 *   const r = new TiledRenderer(canvas, { tileSize: 256 });
 *   r.setLayers(layers);
 *   r.resize();
 *   r.setViewport({ originX, originY, zoom });
 *   // ... user interactions ...
 *   r.destroy();
 */
export class TiledRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly tileSize: number;
  private readonly background: string;
  private readonly onViewportChange?: (v: Viewport) => void;

  private dpr = 1;
  private cssWidth = 0;
  private cssHeight = 0;

  private viewport: Viewport = { originX: 0, originY: 0, zoom: 1 };
  private layers: Layer[] = [];
  private layerUnsubs: Array<() => void> = [];

  private tiles = new Map<TileKey, CachedTile>();
  private dirty = new Set<TileKey>();
  private useCounter = 0;
  private frameCounter = 0;
  private rafId: number | null = null;
  private destroyed = false;
  /** A snapshot is rendering: live frames pause so image layers keep the
   *  snapshot's tile requests instead of cancelling them as off-screen. */
  private snapshotting = false;
  /** Per-frame layer draw accounting for the slow-frame log (below). */
  private frameLayerMs = new Map<string, { ms: number; calls: number }>();
  private lastSlowLog = 0;
  /** Where the pending render came from — the slow-frame log names it, so
   *  CONTINUOUS re-render spam (the same tiles redrawn every frame without
   *  any user input) has a visible owner instead of being a mystery. */
  private lastRenderReason = "(none)";

  constructor(canvas: HTMLCanvasElement, options: TiledRendererOptions = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas context not available");
    this.ctx = ctx;
    this.tileSize = options.tileSize ?? DEFAULT_TILE_SIZE;
    this.background = options.background ?? "transparent";
    this.onViewportChange = options.onViewportChange;
  }

  setLayers(layers: Layer[]) {
    for (const unsub of this.layerUnsubs) unsub();
    this.layerUnsubs = [];
    this.layers = layers;
    for (const layer of layers) {
      if (layer.subscribe) {
        const unsub = layer.subscribe((worldRect) => this.invalidate(worldRect));
        this.layerUnsubs.push(unsub);
      }
    }
    this.invalidate();
  }

  setViewport(v: Viewport) {
    const zoomChanged = v.zoom !== this.viewport.zoom;
    this.viewport = v;
    if (zoomChanged) {
      // Tile→world mapping depends on zoom; all cached tiles are stale.
      this.tiles.clear();
      this.dirty.clear();
    }
    this.onViewportChange?.(v);
    this.requestRender();
  }

  getViewport(): Viewport {
    return this.viewport;
  }

  /** Sync the canvas's backing-store size to its CSS size × dpr. Call on resize. */
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;
    this.cssWidth = rect.width;
    this.cssHeight = rect.height;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.requestRender();
  }

  /** Mark all (or a world rect's) tiles dirty. Pass nothing to invalidate everything. */
  invalidate(worldRect?: Rect) {
    if (!worldRect) {
      for (const key of this.tiles.keys()) this.dirty.add(key);
      // Also include not-yet-cached tiles in the visible region (handled on render).
      this.requestRender();
      return;
    }
    const tw = this.tileSize / this.viewport.zoom;
    if (!isFinite(tw) || tw <= 0) return;
    const minI = Math.floor(worldRect.x / tw);
    const maxI = Math.floor((worldRect.x + worldRect.width) / tw);
    const minJ = Math.floor(worldRect.y / tw);
    const maxJ = Math.floor((worldRect.y + worldRect.height) / tw);
    for (let i = minI; i <= maxI; i++) {
      for (let j = minJ; j <= maxJ; j++) {
        this.dirty.add(`${i},${j}`);
      }
    }
    this.requestRender();
  }

  /** Convert CSS-pixel canvas coords → world coords. */
  cssToWorld(x: number, y: number): { x: number; y: number } {
    return {
      x: this.viewport.originX + x / this.viewport.zoom,
      y: this.viewport.originY + y / this.viewport.zoom
    };
  }

  /** Convert world coords → CSS-pixel canvas coords. */
  worldToCss(x: number, y: number): { x: number; y: number } {
    return {
      x: (x - this.viewport.originX) * this.viewport.zoom,
      y: (y - this.viewport.originY) * this.viewport.zoom
    };
  }

  destroy() {
    this.destroyed = true;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    for (const unsub of this.layerUnsubs) unsub();
    this.layerUnsubs = [];
    this.tiles.clear();
    this.dirty.clear();
  }

  private requestRender() {
    // Record the LAST caller that asked for a render this frame: the
    // slow-frame log surfaces it. `new Error().stack` per call is worth it
    // here — renders are frame-coalesced (dozens/sec at worst), and
    // pinpointing a pathological invalidator is otherwise guesswork.
    const stack = new Error().stack ?? "";
    const frames = stack
      .split("\n")
      .slice(2, 6)
      .map((s) => s.trim().replace(/^at\s+/, ""))
      .filter(Boolean);
    this.lastRenderReason = frames.join(" <- ") || "(unknown)";
    // Short HUD label: first stack frame past the TiledRenderer internals,
    // URLs stripped.
    for (const f of frames) {
      const stripped = f
        .replace(/\((?:https?|file):[^)]*\)/g, "")
        .replace(/(?:https?|file):\S*/g, "")
        .trim();
      if (stripped && !stripped.startsWith("TiledRenderer.")) {
        rendererPerfStats.lastReason = stripped;
        break;
      }
    }
    if (this.rafId !== null || this.destroyed) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.render();
    });
  }

  /**
   * The current view rendered at `scale` × the on-screen device resolution
   * and encoded as a PNG — same framing, same line widths relative to the
   * picture, but image layers draw from the pyramid level that output size
   * needs. Rendered in horizontal bands of SNAPSHOT_TILE px streamed into
   * the encoder, so the image may be far larger than any one canvas, and
   * image tiles are only held for the band being drawn. Each band waits for
   * its image tiles (or `timeoutMs` per band). `overlays` (screen-sized
   * canvases) are stretched on top. Null when cancelled via `signal`.
   */
  async renderSnapshotPng(
    scale: number,
    options: {
      overlays?: HTMLCanvasElement[];
      /** Vector overlays drawn on top of every output tile in world
       *  coordinates (ctx is already transformed), so DOM / SVG overlays such
       *  as floorplans stay sharp at any scale. `pxPerWorld` = output px per
       *  world unit, `pxPerCss` = output px per CSS px (line widths, fonts). */
      drawWorld?: (ctx: CanvasRenderingContext2D, info: { pxPerWorld: number; pxPerCss: number }) => void;
      onProgress?: (p: SnapshotProgress) => void;
      signal?: AbortSignal;
      timeoutMs?: number;
    } = {}
  ): Promise<Blob | null> {
    const { viewport: vp } = this;
    const dpr = this.dpr * scale; // output px per CSS px
    const W = Math.max(1, Math.round(this.cssWidth * dpr));
    const H = Math.max(1, Math.round(this.cssHeight * dpr));
    const T = SNAPSHOT_TILE;
    const k = vp.zoom * dpr; // output px per world unit
    const tWorld = T / k;
    const tile = document.createElement("canvas");
    tile.width = T;
    tile.height = T;
    const tctx = tile.getContext("2d", { willReadFrequently: true });
    if (!tctx || vp.zoom <= 0) return null;
    const cols = Math.ceil(W / T);
    const bands = Math.ceil(H / T);
    const overlays = options.overlays ?? [];
    const pending = () => this.layers.reduce((n, l) => n + (l.pendingLoads?.() ?? 0), 0);
    const cancelled = () => this.destroyed || options.signal?.aborted === true;
    const encoder = new PngStreamEncoder(W, H);
    const band = new Uint8ClampedArray(W * 4 * T);

    /** Draw band `b` (all its tiles) into `band`. */
    const pass = (b: number, bandH: number) => {
      const frame: RenderFrame = {
        id: ++this.frameCounter,
        world: { x: vp.originX, y: vp.originY + b * tWorld, width: W / k, height: bandH / k },
        viewport: vp,
        detail: dpr
      };
      for (const layer of this.layers) {
        try {
          layer.beginFrame?.(frame);
        } catch (error) {
          console.error(`[renderer] layer "${layer.id}" beginFrame failed`, error);
        }
      }
      for (let c = 0; c < cols; c++) {
        const wx = vp.originX + c * tWorld;
        const wy = vp.originY + b * tWorld;
        tctx.setTransform(1, 0, 0, 1, 0, 0);
        tctx.fillStyle = this.background === "transparent" ? "#000" : this.background;
        tctx.fillRect(0, 0, T, T);
        tctx.setTransform(k, 0, 0, k, -wx * k, -wy * k);
        const bounds = {
          size: T / dpr,
          i: c,
          j: b,
          world: { x: wx, y: wy, width: tWorld, height: tWorld },
          dpr,
          zoom: vp.zoom,
          detail: dpr
        };
        for (const layer of this.layers) {
          tctx.save();
          try {
            layer.draw(tctx, bounds);
          } catch (error) {
            console.error(`[renderer] layer "${layer.id}" draw failed`, error);
          }
          tctx.restore();
        }
        tctx.setTransform(1, 0, 0, 1, 0, 0);
        tctx.imageSmoothingEnabled = true;
        tctx.imageSmoothingQuality = "high";
        for (const o of overlays) {
          const fx = o.width / W;
          const fy = o.height / H;
          tctx.drawImage(o, c * T * fx, b * T * fy, T * fx, T * fy, 0, 0, T, T);
        }
        if (options.drawWorld) {
          tctx.save();
          tctx.setTransform(k, 0, 0, k, -wx * k, -wy * k);
          try {
            options.drawWorld(tctx, { pxPerWorld: k, pxPerCss: dpr });
          } catch (error) {
            console.error("[renderer] snapshot drawWorld failed", error);
          }
          tctx.restore();
          tctx.setTransform(1, 0, 0, 1, 0, 0);
        }
        const w = Math.min(T, W - c * T);
        const rows = tctx.getImageData(0, 0, w, bandH).data;
        for (let r = 0; r < bandH; r++) {
          band.set(rows.subarray(r * w * 4, (r + 1) * w * 4), (r * W + c * T) * 4);
        }
      }
    };

    this.snapshotting = true;
    try {
      for (let b = 0; b < bands; b++) {
        const bandH = Math.min(T, H - b * T);
        for (const layer of this.layers) layer.holdCache?.(true);
        try {
          const deadline = performance.now() + (options.timeoutMs ?? 120_000);
          // Drawing requests the missing tiles; wait for them and draw again,
          // until a pass finds everything already there.
          for (let round = 0; round < 50; round++) {
            pass(b, bandH);
            let left = pending();
            if (left === 0) break;
            while (left > 0 && performance.now() < deadline && !cancelled()) {
              options.onProgress?.({ band: b, bands, pendingTiles: left });
              await new Promise((r) => setTimeout(r, 100));
              left = pending();
            }
            if (cancelled()) break;
            if (performance.now() >= deadline) {
              pass(b, bandH);
              break;
            }
          }
        } finally {
          for (const layer of this.layers) layer.holdCache?.(false);
        }
        if (cancelled()) {
          encoder.abort();
          return null;
        }
        options.onProgress?.({ band: b + 1, bands, pendingTiles: 0 });
        await encoder.addRows(band, bandH);
      }
      return await encoder.finish();
    } finally {
      this.snapshotting = false;
      this.invalidate();
    }
  }

  private render() {
    if (this.destroyed || this.snapshotting) return;
    const { tileSize, dpr, viewport: vp, ctx } = this;
    if (vp.zoom <= 0) return;
    const frameT0 = performance.now();
    this.frameLayerMs.clear();

    const tw = tileSize / vp.zoom;
    const visW = this.cssWidth;
    const visH = this.cssHeight;
    const minI = Math.floor(vp.originX / tw);
    const maxI = Math.floor((vp.originX + visW / vp.zoom) / tw);
    const minJ = Math.floor(vp.originY / tw);
    const maxJ = Math.floor((vp.originY + visH / vp.zoom) / tw);
    const frame: RenderFrame = {
      id: ++this.frameCounter,
      world: {
        x: vp.originX,
        y: vp.originY,
        width: visW / vp.zoom,
        height: visH / vp.zoom
      },
      viewport: vp
    };

    // Give layers the complete current viewport before any individual canvas
    // tile is painted. Image layers use this to prioritise and cancel stale
    // asynchronous work at viewport granularity instead of per canvas tile.
    for (const layer of this.layers) {
      try {
        layer.beginFrame?.(frame);
      } catch (error) {
        console.error(`[renderer] layer "${layer.id}" beginFrame failed`, error);
      }
    }

    // Render any missing or dirty tiles in the visible window.
    for (let i = minI; i <= maxI; i++) {
      for (let j = minJ; j <= maxJ; j++) {
        const key = `${i},${j}`;
        const existing = this.tiles.get(key);
        if (!existing || existing.zoom !== vp.zoom || this.dirty.has(key)) {
          this.renderTile(i, j);
          this.dirty.delete(key);
        }
      }
    }

    // Composite.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.background === "transparent") {
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    } else {
      ctx.fillStyle = this.background;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }

    for (let i = minI; i <= maxI; i++) {
      for (let j = minJ; j <= maxJ; j++) {
        const t = this.tiles.get(`${i},${j}`);
        if (!t) continue;
        // Tile world origin → CSS pixel coords → device pixel coords for drawImage.
        const cssX = (i * tw - vp.originX) * vp.zoom;
        const cssY = (j * tw - vp.originY) * vp.zoom;
        ctx.drawImage(
          t.canvas,
          Math.round(cssX * dpr),
          Math.round(cssY * dpr),
          tileSize * dpr,
          tileSize * dpr
        );
        t.lastUsed = ++this.useCounter;
      }
    }

    this.evictIfNeeded();

    // Slow-frame diagnostics — the "floating performance" class of bugs is
    // invisible in a busy UI but trivial when each offending frame names its
    // layer, tile count and zoom. Fires only when a frame consumed ~2 fps
    // budgets, and at most once per 2 s, so real gestures never spam.
    const frameMs = performance.now() - frameT0;
    rendererPerfStats.lastFrameMs = frameMs;
    if (frameMs > 32 && performance.now() - this.lastSlowLog > 2000) {
      this.lastSlowLog = performance.now();
      const parts = [...this.frameLayerMs.entries()]
        .sort((a, b) => b[1].ms - a[1].ms)
        .map(([id, { ms, calls }]) => `${id} ${ms.toFixed(0)}ms×${calls} tiles`);
      console.info(
        `[perf] slow frame ${frameMs.toFixed(0)}ms @zoom ${vp.zoom.toFixed(3)} — reason: ${this.lastRenderReason}: ${
          parts.join(", ") || "compositing only"
        }`
      );
    }
  }

  private renderTile(i: number, j: number) {
    const { tileSize, dpr, viewport: vp } = this;
    const tw = tileSize / vp.zoom;
    const key = `${i},${j}`;
    let entry = this.tiles.get(key);
    const desiredSize = tileSize * dpr;
    if (!entry || entry.canvas.width !== desiredSize) {
      const canvas = document.createElement("canvas");
      canvas.width = desiredSize;
      canvas.height = desiredSize;
      entry = { i, j, canvas, zoom: vp.zoom, lastUsed: ++this.useCounter };
      this.tiles.set(key, entry);
    } else {
      entry.zoom = vp.zoom;
    }
    const tileCtx = entry.canvas.getContext("2d");
    if (!tileCtx) return;

    // Pre-transform: drawing in world coordinates lands in the right tile pixels.
    tileCtx.setTransform(1, 0, 0, 1, 0, 0);
    tileCtx.clearRect(0, 0, entry.canvas.width, entry.canvas.height);
    tileCtx.scale(dpr * vp.zoom, dpr * vp.zoom);
    tileCtx.translate(-i * tw, -j * tw);

    const bounds = {
      size: tileSize,
      i,
      j,
      world: { x: i * tw, y: j * tw, width: tw, height: tw },
      dpr,
      zoom: vp.zoom
    };

    for (const layer of this.layers) {
      tileCtx.save();
      // Slow-frame accounting: when the whole frame overshoots a couple of
      // 60fps budgets, the composite log names which layer ate the time.
      const t0 = performance.now();
      try {
        layer.draw(tileCtx, bounds);
      } catch (error) {
        console.error(`[renderer] layer "${layer.id}" draw failed`, error);
      } finally {
        const ms = performance.now() - t0;
        if (ms > 0) {
          const acc = this.frameLayerMs.get(layer.id);
          this.frameLayerMs.set(layer.id, { ms: (acc?.ms ?? 0) + ms, calls: (acc?.calls ?? 0) + 1 });
        }
      }
      tileCtx.restore();
    }
  }

  private evictIfNeeded() {
    if (this.tiles.size <= MAX_CACHED_TILES) return;
    const entries = [...this.tiles.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const dropCount = this.tiles.size - MAX_CACHED_TILES;
    for (let i = 0; i < dropCount; i++) {
      this.tiles.delete(entries[i][0]);
    }
  }
}

/** Live renderer stats for the optional on-screen HUD (PerfHud) — a tiny
 *  mutable module store; the HUD polls it, the renderer pushes into it. */
export const rendererPerfStats = {
  /** Wall time of the last completed render pass (tile draws + composite), ms. */
  lastFrameMs: 0,
  /** Short label of who asked for the last render ("setViewport" gesture,
   *  "VectorizeLayer.setSavedLayers", …). */
  lastReason: "(idle)" as string,
};
