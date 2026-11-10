import sharp from "sharp";
import type { VectorizeParams, VectorizeResponse } from "shared";
import type { PredictBox } from "./predict.js";

const VECT_TIMEOUT_MS = 120000;
/** In-memory LRU of vectorize responses — panning back to a region with the
 *  same params is instant instead of a round-trip through the sidecar.
 *  Nothing here hits disk on purpose: params change every few hundred ms
 *  while tuning, so cached-on-disk results would be garbage after a slide. */
const MEM_CACHE_MAX = 64;

export interface RunVectorizeResult {
  traces: VectorizeResponse["traces"];
  outlines: VectorizeResponse["outlines"];
  /** Width-filter drop stats from the sidecar (kept / droppedWidth). */
  stats?: {
    kept: number;
    droppedWidth: number;
    droppedShort?: number;
    merged?: number;
    /** Octilinear decoder: chains kept raw with irregular=true. */
    irregular?: number;
  };
}

/**
 * Stateless classical vectorization: crops the source image (base or an
 * overlay) and asks the sidecar's /vectorize/region to threshold + decode
 * it. Unlike the ML predictor this never touches the checkpoint cache — no
 * model needs to be loaded — and results are keyed by the full param set.
 */
export function createVectorizer(config: { mlSidecarUrl: string }) {
  const memCache = new Map<string, RunVectorizeResult>();

  function memKey(
    sourcePath: string,
    keep: PredictBox,
    params: VectorizeParams
  ): string {
    return `${sourcePath}|${keep.join(",")}|${JSON.stringify(params)}`;
  }

  function memGet(key: string): RunVectorizeResult | undefined {
    const v = memCache.get(key);
    if (v !== undefined) {
      memCache.delete(key);
      memCache.set(key, v);
    }
    return v;
  }

  function memSet(key: string, value: RunVectorizeResult): void {
    memCache.delete(key);
    memCache.set(key, value);
    if (memCache.size > MEM_CACHE_MAX) {
      const oldest = memCache.keys().next().value;
      if (oldest !== undefined) memCache.delete(oldest);
    }
  }

  async function runVectorize(params: {
    originalPath: string;
    dieWidth: number;
    dieHeight: number;
    keep: PredictBox;
    vecParams: VectorizeParams;
    overlayPath?: string;
  }): Promise<RunVectorizeResult> {
    const [kx0, ky0, kx1, ky1] = params.keep;
    const key = memKey(params.overlayPath ?? params.originalPath, params.keep, params.vecParams);
    const cached = memGet(key);
    if (cached) return cached;

    const px0 = Math.max(0, Math.floor(kx0));
    const py0 = Math.max(0, Math.floor(ky0));
    const px1 = Math.min(params.dieWidth, Math.ceil(kx1));
    const py1 = Math.min(params.dieHeight, Math.ceil(ky1));
    const cropW = px1 - px0;
    const cropH = py1 - py0;
    if (cropW <= 0 || cropH <= 0) {
      return { traces: [], outlines: [] };
    }

    const sourcePath = params.overlayPath ?? params.originalPath;
    const buf = await sharp(sourcePath, { limitInputPixels: false })
      .extract({ left: px0, top: py0, width: cropW, height: cropH })
      .png()
      .toBuffer();

    const fd = new FormData();
    fd.append(
      "image",
      new Blob([new Uint8Array(buf)], { type: "image/png" }),
      "crop.png"
    );
    const p = params.vecParams;
    fd.append("channel", p.channel);
    fd.append("invert", p.invert ? "true" : "false");
    fd.append("thresh_low", String(Math.round(p.threshLow)));
    fd.append("thresh_high", String(Math.round(p.threshHigh)));
    fd.append("adaptive", p.adaptive ? "true" : "false");
    fd.append("adaptive_block", String(Math.round(p.adaptiveBlock)));
    fd.append("adaptive_c", String(Math.round(p.adaptiveC)));
    fd.append("open_px", String(Math.round(p.openPx)));
    fd.append("bridge_px", String(Math.round(p.bridgePx)));
    fd.append("min_len", String(Math.round(p.minLength)));
    fd.append("width_min", String(p.widthMin));
    fd.append("width_max", String(p.widthMax));
    fd.append("decoder", p.decoder);
    fd.append("oct_delta_px", String(p.octDeltaPx));
    fd.append("oct_strict", p.octStrict ? "true" : "false");
    // P2-3: pre-processing knobs ride along as one JSON field — the sidecar
    // applies them to the crop right after imdecode, before the channel.
    fd.append("preprocess", JSON.stringify(p.preprocess ?? {}));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VECT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${config.mlSidecarUrl}/vectorize/region`, {
        method: "POST",
        body: fd,
        signal: controller.signal
      });
    } catch {
      throw new Error("sidecar unreachable");
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429) {
      throw new Error("sidecar busy — retry in a moment");
    }
    if (!res.ok) throw new Error(`sidecar /vectorize ${res.status}`);

    const body = (await res.json()) as {
      traces: { points: number[][]; score?: number; width?: number; group?: number; irregular?: boolean }[];
      outlines: number[][][];
      stats?: { kept: number; dropped_width?: number; dropped_short?: number; merged?: number; irregular?: number };
    };

    const inKeep = (x: number, y: number) =>
      x >= kx0 && x < kx1 && y >= ky0 && y < ky1;

    const traces = [];
    for (const t of body.traces ?? []) {
      const raw = t.points ?? [];
      if (raw.length < 2) continue;
      const pts = raw.map(([x, y]) => [x + px0, y + py0] as [number, number]);
      // Overlap filter (mirrors the ML trace path): keep a trace when its
      // bbox overlaps the keep-box, so border-crossing wires survive.
      let minx = Infinity;
      let miny = Infinity;
      let maxx = -Infinity;
      let maxy = -Infinity;
      for (const [x, y] of pts) {
        if (x < minx) minx = x;
        if (y < miny) miny = y;
        if (x > maxx) maxx = x;
        if (y > maxy) maxy = y;
      }
      if (maxx <= kx0 || minx >= kx1 || maxy <= ky0 || miny >= ky1) continue;
      traces.push({
        points: pts,
        ...(typeof t.score === "number" && Number.isFinite(t.score) ? { score: t.score } : {}),
        ...(typeof t.width === "number" && Number.isFinite(t.width) ? { widthPx: t.width } : {}),
        ...(typeof t.group === "number" && Number.isFinite(t.group) ? { group: t.group } : {}),
        ...(t.irregular === true ? { irregular: true } : {})
      });
    }

    const outlines = (body.outlines ?? [])
      .map((raw) => (raw ?? []).map(([x, y]) => [x + px0, y + py0] as [number, number]))
      .filter((pts) => pts.length >= 3);

    const result: RunVectorizeResult = {
      traces,
      outlines,
      ...(body.stats
        ? {
            stats: {
              kept: body.stats.kept,
              droppedWidth: body.stats.dropped_width ?? 0,
              ...(typeof body.stats.dropped_short === "number"
                ? { droppedShort: body.stats.dropped_short }
                : {}),
              ...(typeof body.stats.merged === "number" ? { merged: body.stats.merged } : {}),
              ...(typeof body.stats.irregular === "number" ? { irregular: body.stats.irregular } : {})
            }
          }
        : {})
    };
    memSet(key, result);
    return result;
  }

  return { runVectorize };
}
