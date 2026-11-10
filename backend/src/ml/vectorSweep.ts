import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  Agent as UndiciAgent,
  fetch as undiciFetch,
  FormData as UndiciFormData
} from "undici";
import sharp from "sharp";
import type {
  VectorBlockPayload,
  VectorLayerInfo,
  VectorSweepDecodeProgress,
  VectorSweepStatus,
  VectorizeParams,
  VectorizePreprocess
} from "shared";
import { NEUTRAL_VECTOR_PREPROCESS } from "shared";
import type { PredictBox } from "./predict.js";
import type { RunVectorizeResult } from "./vectorize.js";

/** Whole-die vectorize sweep: assemble ONE seamless die-sized binary mask
 *  from block crops (each block's mask is pixel-exact inside its core — the
 *  sidecar pads every crop by the morphology/adaptive radius), then decode
 *  traces ONCE over the full mask. Tile seams are impossible by
 *  construction: a wire is always decoded whole. The decoded payload is
 *  cached on disk keyed by the params hash ("the vector inference").
 */

export const VECTOR_BLOCK_PX = 2048;
/** Whole-die mask cap (px): 160 Mpx ≈ 160 MB Uint8 — guards memory. */
const MAX_MASK_PX = 160_000_000;

/** Sanitize an untrusted `preprocess` blob (query string or POST body) into
 *  a VectorizePreprocess with every knob clamped to its range — anything
 *  missing/invalid falls back to the neutral value so the sidecar can apply
 *  it verbatim. Used by the blocks/live routes (query) and the sweep start
 *  (POST body merge). */
export function parsePreprocess(raw: unknown): VectorizePreprocess {
  const src = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const num = (key: string, fallback: number, min: number, max: number) => {
    const n = Number(src[key]);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return {
    brightness: num("brightness", NEUTRAL_VECTOR_PREPROCESS.brightness, -100, 100),
    contrast: num("contrast", NEUTRAL_VECTOR_PREPROCESS.contrast, 0, 2),
    gamma: num("gamma", NEUTRAL_VECTOR_PREPROCESS.gamma, 0.2, 5),
    shadows: num("shadows", NEUTRAL_VECTOR_PREPROCESS.shadows, 0, 100),
    highlights: num("highlights", NEUTRAL_VECTOR_PREPROCESS.highlights, 0, 100),
    claheClip: num("claheClip", NEUTRAL_VECTOR_PREPROCESS.claheClip, 0, 10),
    claheTiles: Math.round(num("claheTiles", NEUTRAL_VECTOR_PREPROCESS.claheTiles, 1, 16)),
    sharpenAmount: num("sharpenAmount", NEUTRAL_VECTOR_PREPROCESS.sharpenAmount, 0, 200),
    sharpenRadius: num("sharpenRadius", NEUTRAL_VECTOR_PREPROCESS.sharpenRadius, 0.5, 5),
    denoiseMedian: Math.round(num("denoiseMedian", NEUTRAL_VECTOR_PREPROCESS.denoiseMedian, 0, 5))
  };
}

/** Stable cache key for a params set + image source. The preprocess sub-
 *  object is included SCALAR-FORM in a fixed order (P2-3) — a different
 *  tone/local setting must hash differently or the sweep would silently
 *  reuse the previous run's full.json. */
export function vectorParamsHash(
  params: VectorizeParams,
  overlaySource: string | undefined
): string {
  const pp = params.preprocess ?? NEUTRAL_VECTOR_PREPROCESS;
  const canonical =
    JSON.stringify([
      params.channel,
      params.invert,
      params.threshLow,
      params.threshHigh,
      params.adaptive,
      params.adaptiveBlock,
      params.adaptiveC,
      params.openPx,
      params.bridgePx,
      params.minLength,
      params.widthMin,
      params.widthMax,
      params.decoder,
      params.octDeltaPx,
      params.octStrict,
      pp.brightness,
      pp.contrast,
      pp.gamma,
      pp.shadows,
      pp.highlights,
      pp.claheClip,
      pp.claheTiles,
      pp.sharpenAmount,
      pp.sharpenRadius,
      pp.denoiseMedian
    ]) + `|${overlaySource ?? ""}`;
  return `v1-${createHash("sha1").update(canonical).digest("hex").slice(0, 12)}`;
}

interface SweepJob extends VectorSweepStatus {
  cancel: boolean;
  /** Current sweep phase: assembling block masks, or waiting out the one
   *  whole-die decode (minutes — the UI says "keep the app open"). */
  phase: "masks" | "decoding";
  /** Decode-phase progress (read from the worker's progress.json while
   *  phase === "decoding" and the job is still running). */
  decode?: VectorSweepDecodeProgress;
}

/** Deterministic sidecar job id of the global decode — Stop uses it to
 *  cancel the decode subprocess (a cancelled sweep must not leave the
 *  sidecar burning CPU on a dead client's skeletonize for 10+ min). */
function decodeJobId(dieId: string, hash: string): string {
  return `sweep-${dieId}-${hash}`;
}

export function createVectorSweep(config: {
  dataRoot: string;
  mlSidecarUrl: string;
  /** The live endpoint's runner — reuse its crop/sidecar/translate logic. */
  runVectorize: (args: {
    originalPath: string;
    dieWidth: number;
    dieHeight: number;
    keep: PredictBox;
    vecParams: VectorizeParams;
    overlayPath?: string;
  }) => Promise<RunVectorizeResult>;
}) {
  /** One active sweep per die (the die id is the job key, like ML jobs). */
  const jobs = new Map<string, SweepJob>();
  /** Parsed full-die decode cache: keyed dieId|hash. Blocks responses read
   *  this instead of re-parsing a multi-MB JSON every viewport fetch. */
  const fullCache = new Map<string, { traces: VectorBlockPayload["traces"]; outlines: VectorBlockPayload["outlines"] }>();

  function sweepDir(dieId: string, hash: string): string {
    return path.join(config.dataRoot, "vectorize", dieId, hash);
  }

  /** Sidecar request helper (multipart with an image part + JSON body).
   *  undici (Node's fetch) drops a response body idle >300 s by default —
   *  the whole-die decode POST streams nothing for minutes, so every sweep
   *  attempt died at 5 min and postWithRetry spawned ANOTHER worker while
   *  the previous grind went on: old decodes kept stacking (the "100% CPU
   *  forever" incident).
   *  NB: the Agent comes from the NPM undici, which is a different module
   *  instance than Node's bundled one — global fetch rejects it
   *  ("invalid onRequestStart method"), so the long-poll request goes
   *  through undici's OWN fetch with matching classes (fetch/FormData).
   *  Short calls (block masks etc.) stay on global fetch — nothing to
   *  hold past 5 min. */
  const decodeAgent = new UndiciAgent({ bodyTimeout: 0, headersTimeout: 0 });
  async function postSidecar(
    endpoint: string,
    file: { name: string; blob: Blob },
    json: Record<string, unknown>,
    timeoutMs = 300_000
  ): Promise<Record<string, unknown>> {
    const fd = new FormData();
    fd.append("image", file.blob, file.name);
    fd.append("body", JSON.stringify(json));
    // The sidecar reads `job_id` as its own Form field (subprocess registry
    // for Stop/cancel) — send it outside the body JSON too.
    if (typeof json.job_id === "string" && json.job_id) {
      fd.append("job_id", json.job_id);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = `${config.mlSidecarUrl}${endpoint}`;
      if (timeoutMs > 900_000) {
        // Minutes-long whole-die decode: no idle-body limits at all.
        const ufd = new UndiciFormData();
        ufd.append("image", file.blob, file.name);
        ufd.append("body", JSON.stringify(json));
        if (typeof json.job_id === "string" && json.job_id) {
          ufd.append("job_id", json.job_id);
        }
        const res = await undiciFetch(url, {
          method: "POST",
          body: ufd,
          signal: controller.signal,
          dispatcher: decodeAgent
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`sidecar ${endpoint} ${res.status}: ${text.slice(0, 200)}`);
        }
        return (await res.json()) as Record<string, unknown>;
      }
      const res = await fetch(url, {
        method: "POST",
        body: fd,
        signal: controller.signal
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`sidecar ${endpoint} ${res.status}: ${text.slice(0, 200)}`);
      }
      return (await res.json()) as Record<string, unknown>;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Mask params subset (what /vectorize/mask needs) + the preprocess
   *  sub-object (P2-3) — the mask must be computed from the SAME
   *  preprocessed crop the live decode sees. */
  function maskParams(p: VectorizeParams) {
    return {
      channel: p.channel,
      invert: p.invert,
      thresh_low: Math.round(p.threshLow),
      thresh_high: Math.round(p.threshHigh),
      adaptive: p.adaptive,
      adaptive_block: Math.round(p.adaptiveBlock),
      adaptive_c: Math.round(p.adaptiveC),
      open_px: Math.round(p.openPx),
      bridge_px: Math.round(p.bridgePx),
      preprocess: p.preprocess ?? NEUTRAL_VECTOR_PREPROCESS
    };
  }

  function publicStatus(job: SweepJob | undefined): VectorSweepStatus {
    if (!job) {
      return { dieId: "", status: "idle", done: 0, total: 0, error: null, warning: null, overlayFilename: null };
    }
    return {
      dieId: job.dieId,
      status: job.status,
      done: job.done,
      total: job.total,
      phase: job.phase,
      decode:
        job.status === "running" && job.phase === "decoding"
          ? job.decode ?? null
          : null,
      error: job.error ?? null,
      warning: job.warning ?? null,
      paramsHash: job.paramsHash,
      overlayFilename: job.overlayFilename ?? null
    };
  }

  async function start(dieId: string, args: {
    originalPath: string;
    dieWidth: number;
    dieHeight: number;
    params: VectorizeParams;
    overlayPath?: string;
    overlaySource?: string;
  }): Promise<VectorSweepStatus> {
    const existing = jobs.get(dieId);
    if (existing && existing.status === "running") {
      throw new Error("vectorize sweep already running");
    }
    const hash = vectorParamsHash(args.params, args.overlaySource);
    const totalCols = Math.ceil(args.dieWidth / VECTOR_BLOCK_PX);
    const totalRows = Math.ceil(args.dieHeight / VECTOR_BLOCK_PX);
    // Fast path: a full.json for THESE params already exists (a previous
    // sweep completed — or its decode worker finished after the app was
    // closed). Nothing to decode; report completion and warm the mem cache.
    const cached = await readFullPayload(dieId, hash, args.dieWidth, args.dieHeight);
    const job: SweepJob = {
      dieId,
      status: cached ? "completed" : "running",
      done: cached ? totalCols * totalRows : 0,
      total: totalCols * totalRows,
      error: null,
      warning: null,
      paramsHash: hash,
      overlayFilename: args.overlaySource ?? null,
      cancel: false,
      phase: cached ? "decoding" : "masks"
    };
    jobs.set(dieId, job);
    if (cached) {
      return publicStatus(job);
    }

    const dir = sweepDir(dieId, hash);
    await fs.mkdir(dir, { recursive: true });

    // Sequential: the sidecar serializes CV work anyway; a queue just adds
    // memory pressure. Retry transient "busy" (CV-gate 429) a few times.
    void (async () => {
      try {
        if (args.dieWidth * args.dieHeight > MAX_MASK_PX) {
          throw new Error(
            `die too large for whole-die decode (${args.dieWidth}×${args.dieHeight} > ${MAX_MASK_PX} px)`
          );
        }
        const pad = maskPad(args.params);
        const maskW = args.dieWidth;
        const maskH = args.dieHeight;
        const mask = Buffer.alloc(maskW * maskH, 0); // binary 0/255
        const sourcePath = args.overlayPath ?? args.originalPath;
        // Early bail-out: a threshold that captures the background makes the
        // mask mostly white — abort after a few blocks with a clear message
        // instead of decoding garbage for minutes and crashing the sidecar.
        let nzTotal = 0;
        let pxTotal = 0;

        for (let row = 0; row < totalRows; row++) {
          for (let col = 0; col < totalCols; col++) {
            if (job.cancel) {
              job.status = "stopped";
              return;
            }
            const x0 = col * VECTOR_BLOCK_PX;
            const y0 = row * VECTOR_BLOCK_PX;
            const x1 = Math.min(args.dieWidth, x0 + VECTOR_BLOCK_PX);
            const y1 = Math.min(args.dieHeight, y0 + VECTOR_BLOCK_PX);
            // Padded crop: the mask is pixel-exact inside the core because
            // every mask op (morph kernels, adaptive block) sees its full
            // neighbourhood.
            const cx0 = Math.max(0, x0 - pad);
            const cy0 = Math.max(0, y0 - pad);
            const cx1 = Math.min(args.dieWidth, x1 + pad);
            const cy1 = Math.min(args.dieHeight, y1 + pad);
            const crop = await sharp(sourcePath, { limitInputPixels: false })
              .extract({ left: cx0, top: cy0, width: cx1 - cx0, height: cy1 - cy0 })
              .png()
              .toBuffer();
            const resp = await postWithRetry("/vectorize/mask", crop, maskParams(args.params), 300_000, () => job.cancel);
            const maskB64 = String(resp.mask_png_b64 ?? "");
            const respPad = Number(resp.pad ?? pad);
            const maskPng = Buffer.from(maskB64, "base64");
            const { data, info } = await sharp(maskPng)
              .greyscale()
              .raw()
              .toBuffer({ resolveWithObject: true });
            if (info.width !== cx1 - cx0 || info.height !== cy1 - cy0) {
              throw new Error(
                `block mask size mismatch: got ${info.width}×${info.height}, want ${cx1 - cx0}×${cy1 - cy0}`
              );
            }
            let nzMask = 0;
            for (let i = 0; i < data.length; i++) if (data[i] > 127) nzMask++;
            console.log(`[vectorSweep] block ${col}_${row}: crop ${cx1 - cx0}x${cy1 - cy0} mask nz=${nzMask}`);
            // Paste the CORE (the block rect) into the die-sized mask. The
            // crop I sent was already padded by `pad`, so the block core
            // sits at exactly (x0-cx0, y0-cy0) inside the returned mask —
            // no extra offset (the sidecar's `pad` documents the unreliable
            // ring for UNPADDED crops; mine is pre-padded). At die edges the
            // ring is absent but the mask there is still exact (outside the
            // die there is no metal, same as a whole-die decode).
            const coreX = x0 - cx0;
            const coreY = y0 - cy0;
            for (let y = y0; y < y1; y++) {
              const srcRow = (coreY + (y - y0)) * info.width + coreX;
              const dstRow = y * maskW + x0;
              for (let x = 0; x < x1 - x0; x++) {
                // 255, not 1: the assembled buffer is encoded as an 8-bit
                // grayscale PNG and decoded with a >127 threshold.
                mask[dstRow + x] = data[srcRow + x] > 127 ? 255 : 0;
              }
            }
            job.done += 1;
            nzTotal += nzMask;
            pxTotal += info.width * info.height;
            if (job.done >= 3 && nzTotal / pxTotal > 0.85) {
              throw new Error(
                `threshold captures ~${Math.round((100 * nzTotal) / pxTotal)}% of the image — that is ` +
                  `background, not metal. Narrow the band (Thresh low/high) or use the pipette, ` +
                  `then re-run the whole-die decode.`
              );
            }
          }
        }
        if (job.cancel) {
          job.status = "stopped";
          return;
        }

        // ── One global decode over the seamless mask ──────────────────
        // Debug artifact: the assembled die mask next to the payload.
        const fullPng = await sharp(mask, { raw: { width: maskW, height: maskH, channels: 1 } })
          .png()
          .toBuffer();
        await fs.writeFile(path.join(dir, "mask.png"), fullPng);
        if (pxTotal > 0 && nzTotal / pxTotal > 0.45) {
          job.warning =
            `threshold captures ~${Math.round((100 * nzTotal) / pxTotal)}% of the die — ` +
            "neighbouring wires likely merged (band too wide / Min gap too high). " +
            "If nets come out merged, narrow the band or lower Min gap.";
        }
        // Phase marker for the UI: masks are done, now the one long decode.
        job.phase = "decoding";
        // Progress poller: the decode worker writes progress.json (stage,
        // pct, elapsed, eta) next to the payload; surface it while the
        // sidecar grinds. Self-terminates once the job leaves "running".
        const progressPath = path.join(dir, "progress.json");
        const progressPoll = setInterval(() => {
          if (job.status !== "running") {
            clearInterval(progressPoll);
            return;
          }
          void fs
            .readFile(progressPath, "utf8")
            .then((raw) => {
              if (job.status !== "running") return;
              const p = JSON.parse(raw) as {
                stage?: unknown;
                pct?: unknown;
                elapsed_ms?: unknown;
                eta_ms?: unknown;
              };
              job.decode = {
                stage: String(p.stage ?? ""),
                pct: Math.max(0, Math.min(100, Number(p.pct) || 0)),
                elapsedMs: Number(p.elapsed_ms) || 0,
                etaMs: p.eta_ms == null || !Number.isFinite(Number(p.eta_ms)) ? null : Number(p.eta_ms)
              };
            })
            .catch(() => {
              // No progress file yet (legacy worker / first seconds) —
              // keep whatever we had, the UI falls back to elapsed-only.
            });
        }, 2000);
        const decoded = (await postWithRetry(
          "/vectorize/decode",
          fullPng,
          {
            min_len: Math.round(args.params.minLength),
            width_min: args.params.widthMin,
            width_max: args.params.widthMax,
            decoder: args.params.decoder,
            oct_delta_px: args.params.octDeltaPx,
            oct_strict: args.params.octStrict,
            // Subprocess registry key on the sidecar — Stop cancels via it.
            job_id: decodeJobId(dieId, hash),
            // The worker writes the payload itself too: if the backend dies
            // mid-decode, the cache still lands and the next start reuses it.
            save_to: path.join(dir, "full.json"),
            // Live decode progress (stage/pct/eta) the status endpoint reads.
            progress_path: path.join(dir, "progress.json")
          },
          // The global decode skeletonizes the whole die (tens of millions
          // of px - minutes of CV-gated work). 60 min: die-sized "graph"
          // stages measured ~25 min alone; the old 30-min pair (this + the
          // sidecar's own deadline) beheaded healthy runs.
          3_600_000,
          () => job.cancel,
          (attempt, err) => {
            // Surfaces silent retries in the UI (the whole-die decode is
            // one long request — a hiccup WITHOUT this is invisible and
            // the user reads a stuck bar for the retried twin's runtime).
            const msg = err instanceof Error ? err.message : String(err);
            job.warning =
              `sidecar glitch (attempt ${attempt}, ${msg.slice(0, 160)}) — ` +
              "decode is being retried; progress restarts from the mask phase";
            console.warn(`[vectorSweep] ${dieId}: retry #${attempt}: ${msg}`);
          }
        )) as unknown as {
          traces: VectorBlockPayload["traces"];
          outlines: VectorBlockPayload["outlines"];
        };
        // Post-decode cancel check: the 30-min decode is not abortable
        // mid-flight, but its result must NOT be written after a Stop.
        if (job.cancel) {
          job.status = "stopped";
          return;
        }
        job.warning = null; // retries recovered — drop the stale notice
        const payload = {
          bbox: [0, 0, maskW, maskH] as [number, number, number, number],
          traces: decoded.traces ?? [],
          outlines: decoded.outlines ?? []
        };
        const tmp = `${path.join(dir, "full.json")}.${process.pid}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(payload));
        await fs.rename(tmp, path.join(dir, "full.json"));
        fullCache.set(`${dieId}|${hash}`, { traces: payload.traces, outlines: payload.outlines });
        // Persist the params next to the payload — the Vector layers list
        // reads them to describe each saved result.
        await fs.writeFile(
          path.join(dir, "params.json"),
          JSON.stringify(
            { params: args.params, overlaySource: args.overlaySource ?? null, completedAt: new Date().toISOString() },
            null,
            2
          )
        );
        job.status = "completed";
      } catch (e) {
        // A cancelled sweep must never surface as "failed".
        if (job.cancel) {
          job.status = "stopped";
          return;
        }
        job.status = "failed";
        job.error = e instanceof Error ? e.message : "sweep failed";
      }
    })();

    return publicStatus(job);
  }

  /** Morphology/adaptive/preprocess padding baked into block masks (mirrors
   *  the sidecar's mask_pad_px — the response's `pad` field confirms it).
   *  The preprocess reaches beyond a pixel (median radius, unsharp ~3σ)
   *  BEFORE the mask exists, so it pads too. */
  function maskPad(p: VectorizeParams): number {
    const pp = p.preprocess ?? NEUTRAL_VECTOR_PREPROCESS;
    return (
      Math.max(
        Math.round(p.openPx),
        Math.round(p.bridgePx),
        Math.ceil(Math.round(p.adaptiveBlock) / 2),
        pp.denoiseMedian,
        Math.ceil(pp.sharpenRadius * 3)
      ) + 2
    );
  }

  async function postWithRetry(
    endpoint: string,
    buf: Buffer,
    json: Record<string, unknown>,
    timeoutMs = 300_000,
    shouldStop?: () => boolean,
    onRetry?: (attempt: number, err: unknown) => void
  ): Promise<Record<string, unknown>> {
    let lastErr: unknown = null;
    // The sidecar's CV gate answers 429 when ANY other CV request is in
    // flight (e.g. the user's live viewport decode running mid-sweep) —
    // wait it out generously instead of failing the whole sweep.
    for (let attempt = 0; attempt < 20; attempt++) {
      if (shouldStop?.()) throw new Error("stopped");
      try {
        return await postSidecar(
          endpoint,
          { name: "crop.png", blob: new Blob([new Uint8Array(buf)], { type: "image/png" }) },
          json,
          timeoutMs
        );
      } catch (e) {
        lastErr = e;
        if (shouldStop?.()) throw new Error("stopped");
        onRetry?.(attempt + 1, e);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("sidecar request failed");
  }

  function get(dieId: string): VectorSweepStatus {
    return publicStatus(jobs.get(dieId));
  }

  function stop(dieId: string): VectorSweepStatus {
    const job = jobs.get(dieId);
    if (job && job.status === "running") {
      job.cancel = true;
      // Flip the status immediately: the UI Stop button must not hang while
      // an in-flight sidecar request grinds out (cancel is checked at the
      // post-block / post-decode checkpoints; a finished decode is then
      // discarded, not written).
      job.status = "stopped";
      // The whole-die decode runs as a sidecar SUBPROCESS: terminate it for
      // real — otherwise it keeps skeletonizing a dead client's mask for
      // 10+ minutes, starving everything else on CPU. Fire-and-forget: the
      // in-flight decode POST will come back (499/500) and be discarded.
      if (job.phase === "decoding" && job.paramsHash) {
        const fd = new FormData();
        fd.append("job_id", decodeJobId(dieId, job.paramsHash));
        fetch(`${config.mlSidecarUrl}/vectorize/decode/cancel`, {
          method: "POST",
          body: fd
        })
          .then(() => undefined)
          .catch(() => undefined);
      }
    }
    return publicStatus(job);
  }

  /** Cached blocks for a bbox + params. The sweep writes ONE full-die
   *  decode (seamless by construction) — if it exists, it is the answer
   *  regardless of the bbox. Missing → the sweep hasn't run for these
   *  params (client falls back to live decode) — never decoded here.
   *  `hash` override: the Vector layers list pins SAVED payloads (from other
   *  params sets) — they bypass the params-hash lookup. */
    /** Read + mem-cache the full.json payload for a params hash, if present.
   *  Returns the parsed entry or null (no cache file / unreadable). */
  async function readFullPayload(
    dieId: string,
    hash: string,
    dieWidth: number,
    dieHeight: number
  ): Promise<{ traces: VectorBlockPayload["traces"]; outlines: VectorBlockPayload["outlines"] } | null> {
    const cacheKey = `${dieId}|${hash}`;
    const cached = fullCache.get(cacheKey);
    if (cached) return cached;
    try {
      const raw = await fs.readFile(path.join(sweepDir(dieId, hash), "full.json"), "utf8");
      const parsed = JSON.parse(raw) as {
        traces: (VectorBlockPayload["traces"][number] & { width?: number })[];
        outlines: VectorBlockPayload["outlines"];
      };
      // Normalize the raw sidecar trace shape (decoder writes `width`) into
      // the client's `widthPx` — the live path does the same translation,
      // and cached payloads (written by the decode worker) must match, or
      // e.g. the width-aware contact snap silently loses its width input.
      const entry = {
        traces: (parsed.traces ?? []).map((t) =>
          typeof t.width === "number" && !("widthPx" in t)
            ? { ...t, widthPx: t.width }
            : t
        ),
        outlines: parsed.outlines ?? []
      };
      // All-empty payloads are poison (they'd blank the overlay forever) —
      // treat as a miss; the sweep will re-decode.
      if (entry.traces.length === 0 && entry.outlines.length === 0) return null;
      void dieWidth;
      void dieHeight;
      fullCache.set(cacheKey, entry);
      return entry;
    } catch {
      return null;
    }
  }

  async function readBlocks(dieId: string, args: {
    dieWidth: number;
    dieHeight: number;
    bbox: PredictBox;
    params: VectorizeParams;
    overlaySource?: string;
    hash?: string;
  }): Promise<{ hash: string; blocks: VectorBlockPayload[]; missing: number }> {
    const hash = /^v1-[0-9a-f]{12}$/.test(args.hash ?? "")
      ? (args.hash as string)
      : vectorParamsHash(args.params, args.overlaySource);
    const cached = await readFullPayload(dieId, hash, args.dieWidth, args.dieHeight);
    if (cached) {
      return {
        hash,
        blocks: [
          {
            col: 0,
            row: 0,
            bbox: [0, 0, args.dieWidth, args.dieHeight],
            traces: cached.traces,
            outlines: cached.outlines
          }
        ],
        missing: 0
      };
    }
    return { hash, blocks: [], missing: 1 };
  }

  /** The Vector layers list: every SAVED whole-die payload for the die,
   *  newest first. Reads params.json (written at completion) for the layer
   *  description; legacy payloads (mask.png only, no full.json) are skipped
   *  — there is nothing to draw yet. */
  /** Rename a saved whole-die layer: writes name.json next to the payload
   *  (listLayers reads it back). */
  async function renameLayer(dieId: string, hash: string, name: string): Promise<void> {
    if (!/^v1-[0-9a-f]{12}$/.test(hash)) throw new Error("bad layer hash");
    const clean = name.trim().slice(0, 80);
    if (!clean) throw new Error("empty name");
    const dir = sweepDir(dieId, hash);
    // Only rename layers that actually exist (a finished payload on disk).
    await fs.access(path.join(dir, "full.json"));
    const tmp = path.join(dir, `name.json.${process.pid}.tmp`);
    await fs.writeFile(
      tmp,
      JSON.stringify({ name: clean, renamedAt: new Date().toISOString() })
    );
    await fs.rename(tmp, path.join(dir, "name.json"));
  }

  /** Delete a saved whole-die layer (the whole params dir: payload, mask,
   *  params/name json). Derived cache data only — the source image and the
   *  die record are untouched. Also evicts the in-memory full payload. */
  async function deleteLayer(dieId: string, hash: string): Promise<void> {
    if (!/^v1-[0-9a-f]{12}$/.test(hash)) throw new Error("bad layer hash");
    fullCache.delete(`${dieId}|${hash}`);
    await fs.rm(sweepDir(dieId, hash), { recursive: true, force: true });
  }

  async function listLayers(dieId: string): Promise<VectorLayerInfo[]> {
    const root = path.join(config.dataRoot, "vectorize", dieId);
    let names: string[] = [];
    try {
      names = (await fs.readdir(root, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
    const out: VectorLayerInfo[] = [];
    for (const hash of names) {
      let raw: string;
      try {
        raw = await fs.readFile(path.join(sweepDir(dieId, hash), "full.json"), "utf8");
      } catch {
        continue; // no finished payload for this params set
      }
      let traces = 0;
      let outlines = 0;
      try {
        const parsed = JSON.parse(raw) as { traces?: unknown[]; outlines?: unknown[] };
        traces = parsed.traces?.length ?? 0;
        outlines = parsed.outlines?.length ?? 0;
      } catch {
        continue;
      }
      let params: VectorizeParams | null = null;
      let completedAt: string | null = null;
      let name: string | null = null;
      try {
        const pj = JSON.parse(
          await fs.readFile(path.join(sweepDir(dieId, hash), "params.json"), "utf8")
        ) as { params: VectorizeParams; completedAt?: string };
        params = pj.params;
        completedAt = pj.completedAt ?? null;
      } catch {
        // legacy result: describe by hash only
      }
      try {
        const nj = JSON.parse(
          await fs.readFile(path.join(sweepDir(dieId, hash), "name.json"), "utf8")
        ) as { name?: string };
        name = nj.name ?? null;
      } catch {
        // unnamed layer
      }
      let modified = "";
      try {
        modified = (await fs.stat(path.join(sweepDir(dieId, hash), "full.json"))).mtime.toISOString();
      } catch {
        modified = new Date(0).toISOString();
      }
      out.push({ hash, name, traces, outlines, params, completedAt, modified });
    }
    out.sort((a, b) => b.modified.localeCompare(a.modified));
    return out;
  }

  return { start, get, stop, readBlocks, listLayers, renameLayer, deleteLayer };

}
