import { promises as fs } from "node:fs";
import path from "node:path";
import { Router, type Request } from "express";
import sharp from "sharp";
import type {
  AKAZEReverifyRequest,
  CVMatchRequest,
  CVMatchResponse,
  CVMatchResult,
  MLJobStatus,
  MLModelsResponse,
  MLPrediction,
  MLSelectModelRequest,
  MLServiceStatus,
  MLTrainRequest,
  MLViasTileResult,
  MLViasTilesResponse,
  VectorizeParams,
  VectorizeResponse
} from "shared";
import { NEUTRAL_VECTOR_PREPROCESS } from "shared";
import { createMLJobManager } from "../ml/jobs.js";
import { resolveOverlayOriginalPath } from "./overlayImages.js";
import {
  createMLPredictor,
  INFERENCE_MIN_DISTANCE,
  INFERENCE_THRESHOLD,
  resolveTile,
  SidecarUnavailable,
  toPrediction,
  type MLPredictor
} from "../ml/predict.js";
import { createVectorizer } from "../ml/vectorize.js";
import { createVectorSweep, parsePreprocess } from "../ml/vectorSweep.js";
import { readAnnotations, readDieRecord } from "../store.js";
import type { AnnotationBroadcaster } from "../ws.js";

const HEALTH_TIMEOUT_MS = 3000;
const SIDECAR_RW_TIMEOUT_MS = 10000;
/** Hard cap on a single batched range request (the frontend fetches in
 *  blocks well under this; the cap just guards against a pathological URL). */
const MAX_RANGE_TILES = 4096;
/** Crop-pixel cap for a live vectorize request — the endpoint runs while the
 *  user drags sliders, so a gigapixel whole-die crop would pin the sidecar.
 *  The frontend skips fetching below the native detail level anyway. */
const MAX_VECT_AREA = 6_000_000;

async function fetchSidecar(
  url: string,
  timeoutMs: number,
  init?: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function resolveRequestedOverlayPath(params: {
  request: Request;
  dataRoot: string;
  dieId: string;
  sourceId: string | undefined;
}): Promise<string | undefined> {
  if (!params.sourceId) return undefined;
  return (await resolveOverlayOriginalPath({
    dataRoot: params.dataRoot,
    dieId: params.dieId,
    sourceId: params.sourceId
  })) ?? undefined;
}

export function createMLRouter(config: {
  mlSidecarUrl: string;
  dataRoot: string;
  mlPredictPad: number;
  broadcaster?: AnnotationBroadcaster;
  /** Share one predictor (and its memory cache) with other routers. */
  predictor?: MLPredictor;
}) {
  const router = Router();
  const predictor = config.predictor ?? createMLPredictor(config);
  const jobs = createMLJobManager({
    dataRoot: config.dataRoot,
    predictor,
    onJobChange: (job) => config.broadcaster?.emitMLJob(job)
  });

  function send503IfUnavailable(
    error: unknown,
    response: import("express").Response
  ): boolean {
    if (error instanceof SidecarUnavailable) {
      response.status(503).json({ error: error.message });
      return true;
    }
    return false;
  }

  // ── GET /api/ml/status ──────────────────────────────────────────────
  router.get("/api/ml/status", async (_request, response) => {
    try {
      const res = await fetchSidecar(
        `${config.mlSidecarUrl}/health`,
        HEALTH_TIMEOUT_MS
      );
      if (!res.ok) {
        response.json({ reachable: false } satisfies MLServiceStatus);
        return;
      }
      const body = (await res.json()) as Record<string, unknown>;
      response.json({
        reachable: true,
        status: body.status as string,
        device: body.device as string,
        checkpoint: (body.checkpoint as string | null) ?? null,
        checkpointHash: (body.checkpoint_hash as string | null) ?? null,
        encoder: body.encoder as string,
        modelLoaded: Boolean(body.model_loaded),
        trainingActive: Boolean(body.training_active)
      } satisfies MLServiceStatus);
    } catch {
      response.json({ reachable: false } satisfies MLServiceStatus);
    }
  });

  // ── GET /api/ml/models ──────────────────────────────────────────────
  router.get("/api/ml/models", async (_request, response, next) => {
    try {
      let res: Response;
      try {
        res = await fetchSidecar(
          `${config.mlSidecarUrl}/models`,
          HEALTH_TIMEOUT_MS
        );
      } catch {
        response.status(503).json({ error: "sidecar unreachable" });
        return;
      }
      if (!res.ok) {
        response.status(502).json({ error: `sidecar /models ${res.status}` });
        return;
      }
      const body = (await res.json()) as {
        models?: {
          name: string;
          hash: string | null;
          size_bytes: number;
          resident: boolean;
        }[];
      };
      response.json({
        models: (body.models ?? []).map((m) => ({
          name: m.name,
          hash: m.hash ?? null,
          sizeBytes: m.size_bytes,
          resident: m.resident
        }))
      } satisfies MLModelsResponse);
    } catch (error) {
      next(error);
    }
  });

  // ── POST /api/ml/model { name } ─────────────────────────────────────
  // Switches the sidecar's resident checkpoint. Every cached prediction is
  // tied to the old checkpoint, so we wipe the prediction cache + ML jobs.
  router.post("/api/ml/model", async (request, response, next) => {
    try {
      const body = (request.body ?? {}) as Partial<MLSelectModelRequest>;
      if (!body.name || typeof body.name !== "string") {
        response.status(400).json({ error: "name is required" });
        return;
      }
      // A running sweep files tiles under the checkpoint it started with;
      // switching underneath it would corrupt that cache and race the wipe
      // below (rm on a directory being written to fails with ENOTEMPTY).
      if (jobs.hasActiveJobs()) {
        response.status(409).json({
          error: "cannot switch model while an inference sweep is running — stop it first"
        });
        return;
      }
      let res: Response;
      try {
        res = await fetchSidecar(
          `${config.mlSidecarUrl}/model/reload`,
          SIDECAR_RW_TIMEOUT_MS,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ checkpoint_path: `checkpoints/${body.name}` })
          }
        );
      } catch {
        response.status(503).json({ error: "sidecar unreachable" });
        return;
      }
      if (res.status === 409) {
        response
          .status(409)
          .json({ error: "cannot switch model while training" });
        return;
      }
      if (!res.ok) {
        const detail = await res.text();
        response
          .status(502)
          .json({ error: `sidecar /model/reload ${res.status}`, detail });
        return;
      }
      // Caches (and the per-die job records that count them) are keyed by
      // checkpoint hash, so the previous model's predictions simply become
      // invisible until it's selected again — nothing is deleted. Only the
      // in-memory tile LRU is dropped, to free the old model's entries.
      predictor.clearMemCache();
      const data = (await res.json()) as {
        checkpoint: string | null;
        checkpoint_hash: string | null;
        model_loaded: boolean;
      };
      response.json({
        checkpoint: data.checkpoint,
        checkpointHash: data.checkpoint_hash,
        modelLoaded: data.model_loaded
      });
    } catch (error) {
      next(error);
    }
  });

  // ── GET /api/ml/inference-jobs ──────────────────────────────────────
  // All per-die inference jobs — drives the library page's status badges.
  router.get("/api/ml/inference-jobs", async (_request, response, next) => {
    try {
      response.json(await jobs.listJobs());
    } catch (error) {
      next(error);
    }
  });

  // ── GET /api/dies/:dieId/ml/job ─────────────────────────────────────
  router.get("/api/dies/:dieId/ml/job", async (request, response, next) => {
    try {
      response.json(await jobs.getJob(request.params.dieId));
    } catch (error) {
      next(error);
    }
  });

  // ── POST /api/dies/:dieId/ml/job/start ──────────────────────────────
  router.post(
    "/api/dies/:dieId/ml/job/start",
    async (request, response, next) => {
      try {
        const body = (request.body ?? {}) as { overlayFilename?: string };
        const overlayFilename = typeof body.overlayFilename === "string" && body.overlayFilename.length > 0
          ? body.overlayFilename
          : undefined;
        response.json(await jobs.startJob(request.params.dieId, overlayFilename));
      } catch (error) {
        if (send503IfUnavailable(error, response)) return;
        next(error);
      }
    }
  );

  // ── POST /api/dies/:dieId/ml/job/stop ───────────────────────────────
  router.post(
    "/api/dies/:dieId/ml/job/stop",
    async (request, response, next) => {
      try {
        response.json(await jobs.stopJob(request.params.dieId));
      } catch (error) {
        next(error);
      }
    }
  );

  function overlayKey(overlaySource: string | undefined): string | undefined {
    return overlaySource ? overlaySource.replace(/[^a-zA-Z0-9_\-.]/g, "_") : undefined;
  }

  // ── GET /api/dies/:dieId/vias/tile/:z/:x/:y (cached) ────────────────
  router.get(
    "/api/dies/:dieId/vias/tile/:z/:x/:y",
    async (request, response, next) => {
      try {
        const { dieId } = request.params;
        const z = Number(request.params.z);
        const tx = Number(request.params.x);
        const ty = Number(request.params.y);
        if (![z, tx, ty].every(Number.isInteger)) {
          response.status(400).json({ error: "Invalid tile coordinates" });
          return;
        }
        const overlaySource = typeof request.query.overlaySource === "string"
          ? request.query.overlaySource
          : undefined;
        const ovKey = overlayKey(overlaySource);
        const record = await readDieRecord(config.dataRoot, dieId);
        const resolved = resolveTile(record, z, tx, ty);
        if (resolved.kind === "non-native") {
          response.json({
            pointVias: [],
            irregularVias: [],
            traces: [],
            bbox: [0, 0, 0, 0],
            checkpointHash: null,
            overlayFilename: overlaySource ?? null
          } satisfies MLPrediction);
          return;
        }
        if (resolved.kind === "oob") {
          response.status(404).json({ error: "Tile out of range" });
          return;
        }
        const box = resolved.box;

        const cachedOnly =
          request.query.cachedOnly === "1" ||
          request.query.cachedOnly === "true";

        let checkpointHash: string | null;
        try {
          checkpointHash = await predictor.getCheckpointHash();
        } catch (error) {
          if (cachedOnly) {
            response.status(204).end();
            return;
          }
          if (send503IfUnavailable(error, response)) return;
          throw error;
        }

        const cachedTile = await predictor.readCachedTile(
          dieId,
          checkpointHash,
          z,
          tx,
          ty,
          ovKey
        );
        if (cachedTile) {
          response.json(cachedTile);
          return;
        }

        if (cachedOnly) {
          response.status(204).end();
          return;
        }

        const overlayPath = await resolveRequestedOverlayPath({
          request,
          dataRoot: config.dataRoot,
          dieId,
          sourceId: overlaySource
        });
        if (overlaySource && !overlayPath) {
          response.status(404).json({ error: "Visible image source not found" });
          return;
        }

        let result: Awaited<ReturnType<typeof predictor.runPrediction>>;
        try {
          result = await predictor.runPrediction({
            originalPath: record.originalPath,
            dieWidth: record.width,
            dieHeight: record.height,
            keep: box,
            threshold: INFERENCE_THRESHOLD,
            minDistance: INFERENCE_MIN_DISTANCE,
            wantHeatmap: false,
            overlayPath
          });
        } catch (error) {
          if (send503IfUnavailable(error, response)) return;
          throw error;
        }

        const prediction = toPrediction(result, box, checkpointHash, overlaySource);
        await predictor.writeCachedTile(dieId, checkpointHash, z, tx, ty, prediction, ovKey);
        response.json(prediction);
      } catch (error) {
        next(error);
      }
    }
  );

  // ── GET /api/dies/:dieId/vias/tiles?z&x0&y0&x1&y1 (cached, batched) ──
  // One request for a whole native-tile range — replaces N per-tile calls
  // when the overlay loads a zoomed-out view. Cached-only by nature: a tile
  // with no cached prediction is omitted from `tiles`.
  router.get("/api/dies/:dieId/vias/tiles", async (request, response, next) => {
    try {
      const { dieId } = request.params;
      const z = Number(request.query.z);
      const x0 = Number(request.query.x0);
      const y0 = Number(request.query.y0);
      const x1 = Number(request.query.x1);
      const y1 = Number(request.query.y1);
      if (![z, x0, y0, x1, y1].every(Number.isInteger)) {
        response
          .status(400)
          .json({ error: "z, x0, y0, x1, y1 (tile coords) required" });
        return;
      }
      const overlaySource = typeof request.query.overlaySource === "string"
        ? request.query.overlaySource
        : undefined;
      const ovKey = overlayKey(overlaySource);
      const record = await readDieRecord(config.dataRoot, dieId);
      if (z !== record.maxZoomLevel) {
        response.json({
          z,
          checkpointHash: null,
          tiles: []
        } satisfies MLViasTilesResponse);
        return;
      }
      const level = record.levels.find((l) => l.z === z);
      const cols = level?.columns ?? Math.ceil(record.width / record.tileSize);
      const rows = level?.rows ?? Math.ceil(record.height / record.tileSize);
      const minTx = Math.max(0, Math.min(x0, x1));
      const minTy = Math.max(0, Math.min(y0, y1));
      const maxTx = Math.min(cols - 1, Math.max(x0, x1));
      const maxTy = Math.min(rows - 1, Math.max(y0, y1));

      let checkpointHash: string | null;
      try {
        checkpointHash = await predictor.getCheckpointHash();
      } catch {
        response.json({
          z,
          checkpointHash: null,
          tiles: []
        } satisfies MLViasTilesResponse);
        return;
      }

      const coords: { tx: number; ty: number }[] = [];
      for (let ty = minTy; ty <= maxTy; ty += 1) {
        for (let tx = minTx; tx <= maxTx; tx += 1) coords.push({ tx, ty });
      }
      if (coords.length > MAX_RANGE_TILES) {
        response.status(400).json({
          error: `range too large (${coords.length} > ${MAX_RANGE_TILES})`
        });
        return;
      }

      const results = await Promise.all(
        coords.map(async ({ tx, ty }) => {
          const prediction = await predictor.readCachedTile(
            dieId,
            checkpointHash,
            z,
            tx,
            ty,
            ovKey
          );
          return prediction ? { x: tx, y: ty, prediction } : null;
        })
      );
      response.json({
        z,
        checkpointHash,
        tiles: results.filter((t): t is MLViasTileResult => t !== null)
      } satisfies MLViasTilesResponse);
    } catch (error) {
      next(error);
    }
  });

  // ── GET /api/dies/:dieId/vias?bbox=x0,y0,x1,y1 (uncached) ───────────
  router.get("/api/dies/:dieId/vias", async (request, response, next) => {
    try {
      const { dieId } = request.params;
      const parts = String(request.query.bbox ?? "")
        .split(",")
        .map(Number);
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
        response.status(400).json({ error: "bbox must be x0,y0,x1,y1" });
        return;
      }
      const overlaySource = typeof request.query.overlaySource === "string"
        ? request.query.overlaySource
        : undefined;
      const record = await readDieRecord(config.dataRoot, dieId);
      const x0 = Math.max(0, Math.min(parts[0], parts[2]));
      const y0 = Math.max(0, Math.min(parts[1], parts[3]));
      const x1 = Math.min(record.width, Math.max(parts[0], parts[2]));
      const y1 = Math.min(record.height, Math.max(parts[1], parts[3]));
      if (x1 <= x0 || y1 <= y0) {
        response.status(400).json({ error: "Empty or out-of-bounds bbox" });
        return;
      }

      let checkpointHash: string | null;
      try {
        checkpointHash = await predictor.getCheckpointHash();
      } catch (error) {
        if (send503IfUnavailable(error, response)) return;
        throw error;
      }

      const overlayPath = await resolveRequestedOverlayPath({
        request,
        dataRoot: config.dataRoot,
        dieId,
        sourceId: overlaySource
      });
      if (overlaySource && !overlayPath) {
        response.status(404).json({ error: "Visible image source not found" });
        return;
      }

      let result: Awaited<ReturnType<typeof predictor.runPrediction>>;
      try {
        result = await predictor.runPrediction({
          originalPath: record.originalPath,
          dieWidth: record.width,
          dieHeight: record.height,
          keep: [x0, y0, x1, y1],
          threshold: INFERENCE_THRESHOLD,
          minDistance: INFERENCE_MIN_DISTANCE,
          wantHeatmap: false,
          overlayPath
        });
      } catch (error) {
        if (send503IfUnavailable(error, response)) return;
        throw error;
      }

      response.json(
        toPrediction(result, [x0, y0, x1, y1], checkpointHash, overlaySource)
      );
    } catch (error) {
      next(error);
    }
  });

  // ── GET /api/dies/:dieId/vectorize?bbox=… (live, no disk cache) ──────
  // Classical (no-model) metal vectorization of a region: threshold a
  // brightness/colour channel → skeleton traces + mask outlines. Runs while
  // the user drags sliders, so results are memory-cached per (source, bbox,
  // params) in the vectorizer and never written to disk. No checkpoint needs
  // to be loaded — this works on a bare sidecar.
  const vectorizer = createVectorizer({ mlSidecarUrl: config.mlSidecarUrl });
  const vectorSweep = createVectorSweep({
    dataRoot: config.dataRoot,
    mlSidecarUrl: config.mlSidecarUrl,
    runVectorize: vectorizer.runVectorize
  });

  /** Vectorize params from query string (shared by the live + blocks routes). */
  function parseVectorParams(request: Request): VectorizeParams {
    const num = (key: string, fallback: number) => {
      const raw = request.query[key];
      const n = typeof raw === "string" ? Number(raw) : NaN;
      return Number.isFinite(n) ? n : fallback;
    };
    const channel = String(request.query.channel ?? "gray");
    return {
      channel: channel === "r" || channel === "g" || channel === "b" ? channel : "gray",
      invert: num("invert", 0) !== 0,
      threshLow: num("threshLow", 120),
      threshHigh: num("threshHigh", 255),
      adaptive: num("adaptive", 0) !== 0,
      adaptiveBlock: num("adaptiveBlock", 51),
      adaptiveC: num("adaptiveC", 8),
      openPx: num("openPx", 1),
      bridgePx: num("bridgePx", 2),
      minLength: num("minLength", 14),
      widthMin: num("widthMin", 1.5),
      widthMax: num("widthMax", 30),
      decoder: String(request.query.decoder) === "octilinear" ? "octilinear" : "runs",
      octDeltaPx: num("octDeltaPx", 0),
      octStrict: num("octStrict", 0) !== 0,
      preprocess: parsePreprocess(request.query.preprocess)
    };
  }

  function parseVectorBbox(request: Request, record: { width: number; height: number }) {
    const parts = String(request.query.bbox ?? "")
      .split(",")
      .map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
    const x0 = Math.max(0, Math.min(parts[0], parts[2]));
    const y0 = Math.max(0, Math.min(parts[1], parts[3]));
    const x1 = Math.min(record.width, Math.max(parts[0], parts[2]));
    const y1 = Math.min(record.height, Math.max(parts[1], parts[3]));
    if (x1 <= x0 || y1 <= y0) return null;
    return [x0, y0, x1, y1] as const;
  }

  router.get("/api/dies/:dieId/vectorize", async (request, response, next) => {
    try {
      const { dieId } = request.params;
      const record = await readDieRecord(config.dataRoot, dieId);
      const box = parseVectorBbox(request, record);
      if (!box) {
        response.status(400).json({ error: "Empty or out-of-bounds bbox" });
        return;
      }
      const [x0, y0, x1, y1] = box;
      if ((x1 - x0) * (y1 - y0) > MAX_VECT_AREA) {
        response.status(400).json({
          error: `bbox too large for live vectorize (> ${MAX_VECT_AREA} px) — zoom in`
        });
        return;
      }
      const overlaySource = typeof request.query.overlaySource === "string"
        ? request.query.overlaySource
        : undefined;
      const overlayPath = await resolveRequestedOverlayPath({
        request,
        dataRoot: config.dataRoot,
        dieId,
        sourceId: overlaySource
      });
      if (overlaySource && !overlayPath) {
        response.status(404).json({ error: "Visible image source not found" });
        return;
      }

      const vecParams = parseVectorParams(request);
      try {
        const result = await vectorizer.runVectorize({
          originalPath: record.originalPath,
          dieWidth: record.width,
          dieHeight: record.height,
          keep: [x0, y0, x1, y1],
          vecParams,
          overlayPath
        });
        response.json({
          traces: result.traces,
          outlines: result.outlines,
          bbox: [x0, y0, x1, y1],
          ...(result.stats ? { stats: result.stats } : {})
        } satisfies VectorizeResponse);
      } catch (error) {
        response.status(503).json({
          error: error instanceof Error ? error.message : "vectorize failed"
        });
      }
    } catch (error) {
      next(error);
    }
  });

  // ── Whole-die vectorize sweep: block jobs + disk-cached blocks ──────
  // POST /vectorize/job/start {params, overlaySource?} — decodes every
  // 2048-px block of the die and caches each under dataRoot/vectorize/
  // <dieId>/<paramsHash>/col_row.json. GET /vectorize/blocks reads the
  // cache for a bbox: complete coverage → the overlay draws blocks without
  // re-decoding; missing blocks → the client falls back to live decode.

  router.post("/api/dies/:dieId/vectorize/job/start", async (request, response, next) => {
    try {
      const { dieId } = request.params;
      const record = await readDieRecord(config.dataRoot, dieId);
      const body = (request.body ?? {}) as {
        params?: Partial<VectorizeParams>;
        overlaySource?: string;
      };
      const overlaySource = typeof body.overlaySource === "string" && body.overlaySource
        ? body.overlaySource
        : undefined;
      const overlayResolved = overlaySource
        ? await resolveOverlayOriginalPath({
            dataRoot: config.dataRoot,
            dieId,
            sourceId: overlaySource
          })
        : undefined;
      const overlayPath = overlayResolved ?? undefined;
      if (overlaySource && !overlayPath) {
        response.status(404).json({ error: "Visible image source not found" });
        return;
      }
      const defaults = parseVectorParams(request);
      const vecParams: VectorizeParams = { ...defaults, ...(body.params ?? {}) };
      try {
        const status = await vectorSweep.start(dieId, {
          originalPath: record.originalPath,
          dieWidth: record.width,
          dieHeight: record.height,
          params: vecParams,
          overlayPath,
          overlaySource
        });
        response.json(status);
      } catch (error) {
        response.status(409).json({
          error: error instanceof Error ? error.message : "sweep failed"
        });
      }
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/dies/:dieId/vectorize/job", async (request, response) => {
    response.json(vectorSweep.get(String(request.params.dieId)));
  });

  router.post("/api/dies/:dieId/vectorize/job/stop", async (request, response) => {
    response.json(vectorSweep.stop(String(request.params.dieId)));
  });

  router.get("/api/dies/:dieId/vectorize/blocks", async (request, response, next) => {
    try {
      const { dieId } = request.params;
      const record = await readDieRecord(config.dataRoot, dieId);
      const box = parseVectorBbox(request, record);
      if (!box) {
        response.status(400).json({ error: "Empty or out-of-bounds bbox" });
        return;
      }
      const overlaySource = typeof request.query.overlaySource === "string"
        ? request.query.overlaySource
        : undefined;
      const vecParams = parseVectorParams(request);
      const hash = typeof request.query.hash === "string" ? request.query.hash : undefined;
      const result = await vectorSweep.readBlocks(dieId, {
        dieWidth: record.width,
        dieHeight: record.height,
        bbox: [box[0], box[1], box[2], box[3]],
        params: vecParams,
        overlaySource,
        hash
      });
      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  // The Vector layers list: every SAVED whole-die payload for the die
  // (newest first) — the left panel's per-layer visibility toggles read it.
  router.get("/api/dies/:dieId/vectorize/layers", async (request, response, next) => {
    try {
      response.json(await vectorSweep.listLayers(String(request.params.dieId)));
    } catch (error) {
      next(error);
    }
  });

  // ── POST /api/dies/:dieId/vectorize/layers/:hash/rename {name} ────
  // Rename a saved whole-die layer (the Vector Layers tree's ✎).
  router.post("/api/dies/:dieId/vectorize/layers/:hash/rename", async (request, response, next) => {
    try {
      const name = String((request.body as { name?: unknown } | undefined)?.name ?? "");
      await vectorSweep.renameLayer(String(request.params.dieId), String(request.params.hash), name);
      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  // ── DELETE /api/dies/:dieId/vectorize/layers/:hash ────────────────
  // Delete a saved whole-die layer (derived cache only: payload + mask +
  // params/name json under dataRoot/vectorize/<die>/<hash>).
  router.delete("/api/dies/:dieId/vectorize/layers/:hash", async (request, response, next) => {
    try {
      await vectorSweep.deleteLayer(String(request.params.dieId), String(request.params.hash));
      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  // ── GET /api/dies/:dieId/sample?bbox=… — pipette colour readout ──────
  // Mean RGB of a small source region (the vector pipette samples the SAME
  // image the vectorize endpoint decodes — base or overlay). Tiny crops
  // only: this is an eyedropper, not a region statistic tool.
  router.get("/api/dies/:dieId/sample", async (request, response, next) => {
    try {
      const { dieId } = request.params;
      const parts = String(request.query.bbox ?? "")
        .split(",")
        .map(Number);
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
        response.status(400).json({ error: "bbox must be x0,y0,x1,y1" });
        return;
      }
      const record = await readDieRecord(config.dataRoot, dieId);
      const x0 = Math.max(0, Math.min(Math.floor(parts[0]), Math.floor(parts[2])));
      const y0 = Math.max(0, Math.min(Math.floor(parts[1]), Math.floor(parts[3])));
      const x1 = Math.min(record.width, Math.ceil(Math.max(parts[0], parts[2])));
      const y1 = Math.min(record.height, Math.ceil(Math.max(parts[1], parts[3])));
      const w = x1 - x0;
      const h = y1 - y0;
      if (w <= 0 || h <= 0) {
        response.status(400).json({ error: "Empty or out-of-bounds bbox" });
        return;
      }
      if (w * h > 4096) {
        response.status(400).json({ error: "sample region too large (≤ 4096 px)" });
        return;
      }
      const overlaySource = typeof request.query.overlaySource === "string"
        ? request.query.overlaySource
        : undefined;
      const overlayPath = await resolveRequestedOverlayPath({
        request,
        dataRoot: config.dataRoot,
        dieId,
        sourceId: overlaySource
      });
      if (overlaySource && !overlayPath) {
        response.status(404).json({ error: "Visible image source not found" });
        return;
      }
      const buf = await sharp(
        overlayPath ?? record.originalPath,
        { limitInputPixels: false }
      )
        .extract({ left: x0, top: y0, width: w, height: h })
        .png()
        .toBuffer();
      const stats = await sharp(buf).stats();
      response.json({
        r: Math.round(stats.channels[0]?.mean ?? 0),
        g: Math.round(stats.channels[1]?.mean ?? 0),
        b: Math.round(stats.channels[2]?.mean ?? 0),
        samples: w * h
      });
    } catch (error) {
      next(error);
    }
  });

  // ── POST /api/dies/:dieId/vectorize/preprocess-preview (PNG) ────────
  // P2-3 preview: the crop (usually the current viewport) sent through the
  // SAME sidecar preprocessor the decode uses, returned as an image so the
  // VectorizeLayer can blit the processed pixels under the overlay — the
  // user tunes brightness/CLAHE/unsharp while SEEING the effect.
  router.post("/api/dies/:dieId/vectorize/preprocess-preview", async (request, response, next) => {
    try {
      const { dieId } = request.params;
      const record = await readDieRecord(config.dataRoot, dieId);
      const body = (request.body ?? {}) as {
        bbox?: unknown;
        preprocess?: unknown;
        overlaySource?: unknown;
      };
      const parts = Array.isArray(body.bbox) ? (body.bbox as unknown[]).map(Number) : [];
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
        response.status(400).json({ error: "bbox must be [x0, y0, x1, y1]" });
        return;
      }
      const x0 = Math.max(0, Math.min(Math.floor(parts[0]), Math.floor(parts[2])));
      const y0 = Math.max(0, Math.min(Math.floor(parts[1]), Math.floor(parts[3])));
      const x1 = Math.min(record.width, Math.ceil(Math.max(parts[0], parts[2])));
      const y1 = Math.min(record.height, Math.ceil(Math.max(parts[1], parts[3])));
      const w = x1 - x0;
      const h = y1 - y0;
      if (w <= 0 || h <= 0) {
        response.status(400).json({ error: "Empty or out-of-bounds bbox" });
        return;
      }
      const overlaySource = typeof body.overlaySource === "string" ? body.overlaySource : undefined;
      const overlayPath = overlaySource
        ? await resolveOverlayOriginalPath({
            dataRoot: config.dataRoot,
            dieId,
            sourceId: overlaySource
          })
        : undefined;
      if (overlaySource && !overlayPath) {
        response.status(404).json({ error: "Visible image source not found" });
        return;
      }
      // Downscale the preview crop — preprocessing semantics are per-pixel
      // (tone LUT is resolution-independent; local ops approximate), the
      // real decode reads full resolution. Keeps the request well under a
      // megabyte so following the viewport stays snappy.
      const PREVIEW_MAX_SIDE = 1200;
      const scale = Math.min(1, PREVIEW_MAX_SIDE / Math.max(w, h));
      let pipe = sharp(overlayPath ?? record.originalPath, { limitInputPixels: false }).extract({
        left: x0,
        top: y0,
        width: w,
        height: h
      });
      if (scale < 1) pipe = pipe.resize(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
      const crop = await pipe.png().toBuffer();

      const fd = new FormData();
      fd.append("image", new Blob([new Uint8Array(crop)], { type: "image/png" }), "crop.png");
      fd.append("preprocess", JSON.stringify(parsePreprocess(body.preprocess)));
      // A bare Node fetch failure surfaces as the cryptic "fetch failed"
      // (the packaged app often runs WITHOUT the optional ML sidecar
      // plugin — say so instead of leaking transport noise).
      let res: Response;
      try {
        res = await fetchSidecar(`${config.mlSidecarUrl}/vectorize/preprocess`, SIDECAR_RW_TIMEOUT_MS, { method: "POST", body: fd });
      } catch {
        response.status(503).json({ error: "sidecar unreachable (ML plugin not installed in this build?)" });
        return;
      }
      if (!res.ok) {
        response.status(502).json({ error: `preprocess failed (sidecar ${res.status})` });
        return;
      }
      response.set("Content-Type", "image/png");
      response.send(Buffer.from(await res.arrayBuffer()));
    } catch (error) {
      next(error);
    }
  });

  // ── GET /api/dies/:dieId/heatmap/tile/:z/:x/:y (cached PNG) ──────────
  router.get(
    "/api/dies/:dieId/heatmap/tile/:z/:x/:y",
    async (request, response, next) => {
      try {
        const { dieId } = request.params;
        const z = Number(request.params.z);
        const tx = Number(request.params.x);
        const ty = Number(request.params.y);
        if (![z, tx, ty].every(Number.isInteger)) {
          response.status(400).json({ error: "Invalid tile coordinates" });
          return;
        }
        const record = await readDieRecord(config.dataRoot, dieId);
        const resolved = resolveTile(record, z, tx, ty);
        if (resolved.kind === "non-native") {
          response.status(204).end();
          return;
        }
        if (resolved.kind === "oob") {
          response.status(404).json({ error: "Tile out of range" });
          return;
        }
        const box = resolved.box;

        let checkpointHash: string | null;
        try {
          checkpointHash = await predictor.getCheckpointHash();
        } catch (error) {
          if (send503IfUnavailable(error, response)) return;
          throw error;
        }

        const pngPath = path.join(
          predictor.cacheDirFor(dieId, checkpointHash),
          `${z}_${tx}_${ty}.png`
        );
        try {
          const cached = await fs.readFile(pngPath);
          response.type("image/png").send(cached);
          return;
        } catch {
          /* miss */
        }

        let result: Awaited<ReturnType<typeof predictor.runPrediction>>;
        try {
          result = await predictor.runPrediction({
            originalPath: record.originalPath,
            dieWidth: record.width,
            dieHeight: record.height,
            keep: box,
            threshold: INFERENCE_THRESHOLD,
            minDistance: INFERENCE_MIN_DISTANCE,
            wantHeatmap: true
          });
        } catch (error) {
          if (send503IfUnavailable(error, response)) return;
          throw error;
        }
        if (!result.heatmapTilePng) {
          response.status(502).json({ error: "sidecar returned no heatmap" });
          return;
        }

        // One forward pass yielded both — write the prediction through the
        // predictor so the mem cache is warmed (an `fs.access` guard is
        // cheaper than re-encoding JSON, but `writeCachedTile` is idempotent
        // and the extra disk write is negligible vs. the inference itself).
        await predictor.writeCachedTile(
          dieId,
          checkpointHash,
          z,
          tx,
          ty,
          toPrediction(result, box, checkpointHash)
        );
        await predictor.atomicWrite(pngPath, result.heatmapTilePng);
        response.type("image/png").send(result.heatmapTilePng);
      } catch (error) {
        next(error);
      }
    }
  );

  // ── GET /api/dies/:dieId/heatmap?bbox=x0,y0,x1,y1 (uncached PNG) ────
  router.get("/api/dies/:dieId/heatmap", async (request, response, next) => {
    try {
      const { dieId } = request.params;
      const parts = String(request.query.bbox ?? "")
        .split(",")
        .map(Number);
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
        response.status(400).json({ error: "bbox must be x0,y0,x1,y1" });
        return;
      }
      const record = await readDieRecord(config.dataRoot, dieId);
      const x0 = Math.max(0, Math.min(parts[0], parts[2]));
      const y0 = Math.max(0, Math.min(parts[1], parts[3]));
      const x1 = Math.min(record.width, Math.max(parts[0], parts[2]));
      const y1 = Math.min(record.height, Math.max(parts[1], parts[3]));
      if (x1 <= x0 || y1 <= y0) {
        response.status(400).json({ error: "Empty or out-of-bounds bbox" });
        return;
      }

      try {
        await predictor.getCheckpointHash();
      } catch (error) {
        if (send503IfUnavailable(error, response)) return;
        throw error;
      }

      let result: { heatmapTilePng?: Buffer };
      try {
        result = await predictor.runPrediction({
          originalPath: record.originalPath,
          dieWidth: record.width,
          dieHeight: record.height,
          keep: [x0, y0, x1, y1],
          threshold: INFERENCE_THRESHOLD,
          minDistance: INFERENCE_MIN_DISTANCE,
          wantHeatmap: true
        });
      } catch (error) {
        if (send503IfUnavailable(error, response)) return;
        throw error;
      }
      if (!result.heatmapTilePng) {
        response.status(502).json({ error: "sidecar returned no heatmap" });
        return;
      }
      response.type("image/png").send(result.heatmapTilePng);
    } catch (error) {
      next(error);
    }
  });

  // ── POST /api/ml/train ──────────────────────────────────────────────
  router.post("/api/ml/train", async (request, response, next) => {
    try {
      const body = (request.body ?? {}) as Partial<MLTrainRequest>;
      if (!body.dataDir || typeof body.dataDir !== "string") {
        response.status(400).json({ error: "dataDir is required" });
        return;
      }
      const sidecarBody: Record<string, unknown> = { data_dir: body.dataDir };
      if (body.epochs != null) sidecarBody.epochs = body.epochs;
      if (body.encoder != null) sidecarBody.encoder = body.encoder;
      if (body.lr != null) sidecarBody.lr = body.lr;
      if (body.cropSize != null) sidecarBody.crop_size = body.cropSize;
      if (body.stepsPerEpoch != null)
        sidecarBody.steps_per_epoch = body.stepsPerEpoch;
      if (body.batchSize != null) sidecarBody.batch_size = body.batchSize;
      if (body.output != null) sidecarBody.output = body.output;

      let res: Response;
      try {
        res = await fetchSidecar(
          `${config.mlSidecarUrl}/train`,
          SIDECAR_RW_TIMEOUT_MS,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(sidecarBody)
          }
        );
      } catch {
        response.status(503).json({ error: "sidecar unreachable" });
        return;
      }
      if (res.status === 409) {
        response.status(409).json({ error: "training already in progress" });
        return;
      }
      if (!res.ok) {
        const detail = await res.text();
        response
          .status(502)
          .json({ error: `sidecar /train ${res.status}`, detail });
        return;
      }
      const data = (await res.json()) as { job_id: string };
      response.status(202).json({ jobId: data.job_id });
    } catch (error) {
      next(error);
    }
  });

  // ── GET /api/ml/jobs/:jobId ─────────────────────────────────────────
  router.get("/api/ml/jobs/:jobId", async (request, response, next) => {
    try {
      let res: Response;
      try {
        res = await fetchSidecar(
          `${config.mlSidecarUrl}/jobs/${encodeURIComponent(
            request.params.jobId
          )}`,
          HEALTH_TIMEOUT_MS
        );
      } catch {
        response.status(503).json({ error: "sidecar unreachable" });
        return;
      }
      if (res.status === 404) {
        response.status(404).json({ error: "job not found" });
        return;
      }
      if (!res.ok) {
        response.status(502).json({ error: `sidecar /jobs ${res.status}` });
        return;
      }
      const j = (await res.json()) as Record<string, unknown>;
      response.json({
        jobId: j.job_id as string,
        kind: j.kind as MLJobStatus["kind"],
        status: j.status as MLJobStatus["status"],
        epoch: j.epoch as number,
        epochs: j.epochs as number,
        loss: (j.loss as number | null) ?? null,
        checkpointPath: (j.checkpoint_path as string | null) ?? null,
        error: (j.error as string | null) ?? null,
        startedAt: j.started_at as string,
        updatedAt: j.updated_at as string
      } satisfies MLJobStatus);
    } catch (error) {
      next(error);
    }
  });

  // ── POST /api/ml/cv/match ────────────────────────────────────────────
  router.post("/api/ml/cv/match", async (request, response, next) => {
    try {
      const body = (request.body ?? {}) as Partial<CVMatchRequest>;
      if (!body.dieId || !body.cellTypeId) {
        response.status(400).json({ error: "dieId and cellTypeId are required" });
        return;
      }
      const { dieId, cellTypeId } = body;

      const record = await readDieRecord(config.dataRoot, dieId);
      const annotations = await readAnnotations(config.dataRoot, dieId);
      const cellType = annotations.cellTypes.find((ct) => ct.id === cellTypeId);
      if (!cellType) {
        response.status(404).json({ error: "cellType not found" });
        return;
      }

      // Cell position on die — cropRect is cell-local (x:0, y:0), so add cell's die position
      const cellX = body.cellX ?? 0;
      const cellY = body.cellY ?? 0;
      const cx0 = Math.round(cellX + cellType.cropRect.x);
      const cy0 = Math.round(cellY + cellType.cropRect.y);
      const cx1 = Math.round(cellX + cellType.cropRect.x + cellType.cropRect.width);
      const cy1 = Math.round(cellY + cellType.cropRect.y + cellType.cropRect.height);

      // Determine source image
      const overlayFilename = body.overlayFilename;
      const requestedSource = await resolveRequestedOverlayPath({
        request,
        dataRoot: config.dataRoot,
        dieId,
        sourceId: overlayFilename
      });
      if (overlayFilename && !requestedSource) {
        response.status(404).json({ error: "Visible image source not found" });
        return;
      }
      const sourcePath = requestedSource ?? record.originalPath;

      const sourceMeta = await sharp(sourcePath, { limitInputPixels: false }).metadata();
      const sW = sourceMeta.width ?? record.width;
      const sH = sourceMeta.height ?? record.height;

      // Clamp crop to image bounds
      const refLeft = Math.max(0, cx0);
      const refTop = Math.max(0, cy0);
      const refW = Math.min(cx1 - cx0, Math.max(0, sW - refLeft));
      const refH = Math.min(cy1 - cy0, Math.max(0, sH - refTop));
      if (refW <= 0 || refH <= 0) {
        response.status(400).json({ error: "reference crop outside image bounds" });
        return;
      }

      // Send search image + reference bbox to sidecar (single preprocessing)
      const searchBuf = await sharp(sourcePath, { limitInputPixels: false })
        .png()
        .toBuffer();

      const fd = new FormData();
      fd.append("search", new Blob([new Uint8Array(searchBuf)], { type: "image/png" }), "search.png");
      fd.append("ref_x", String(refLeft));
      fd.append("ref_y", String(refTop));
      fd.append("ref_w", String(refW));
      fd.append("ref_h", String(refH));
      const contourParams: [string, string | undefined][] = [
        ["threshold", body.threshold?.toFixed(4)],
        ["max_matches", body.maxMatches?.toFixed(0)],
        ["detection_mode", body.detectionMode],
        ["gradient_kernel", body.gradientKernel?.toFixed(0)],
        ["min_area", body.minArea?.toFixed(0)],
        ["min_distance", body.minDistance?.toFixed(0)],
        ["area_lo", body.areaLo?.toFixed(4)],
        ["area_hi", body.areaHi?.toFixed(4)],
        ["aspect_thresh", body.aspectThresh?.toFixed(4)],
        ["merge_dist_px", body.mergeDistPx?.toFixed(2)],
        ["merge_area_ratio", body.mergeAreaRatio?.toFixed(4)],
        ["efd_harmonics", body.efdHarmonics?.toFixed(0)],
        ["fuzzy_thresh", body.fuzzyThresh?.toFixed(4)],
        ["min_ref_children", body.minRefChildren?.toFixed(0)],
        ["struct_thresh", body.structThresh?.toFixed(4)],
        ["rotation_min_matches", body.rotationMinMatches?.toFixed(0)],
        ["w_shape", body.wShape?.toFixed(4)],
        ["w_area", body.wArea?.toFixed(4)],
        ["w_bbox", body.wBbox?.toFixed(4)],
        ["w_pos", body.wPos?.toFixed(4)],
      ];
      for (const [key, val] of contourParams) {
        if (val != null) fd.append(key, val);
      }

      let sidecarRes: Response;
      try {
        sidecarRes = await fetchSidecar(
          `${config.mlSidecarUrl}/cv/match`,
          120000, // 2 min timeout for full-die search
          { method: "POST", body: fd }
        );
      } catch {
        response.status(503).json({ error: "sidecar unreachable" });
        return;
      }
      if (!sidecarRes.ok) {
        const detail = await sidecarRes.text();
        response.status(502).json({ error: `sidecar /cv/match ${sidecarRes.status}`, detail });
        return;
      }

      const sidecarBody = (await sidecarRes.json()) as {
        matches: { x: number; y: number; rotation: number; confidence: number; bbox: [number, number, number, number] }[];
        total: number;
      };

      // Translate matches back to die-global coords.
      // The search image is the full source at its native coordinates, so the
      // sidecar returns coords in source-image pixel space — already die-global
      // when the overlay is at the same resolution as the base image.
      const scaleX = overlayFilename ? (cx1 - cx0) / (cx1 - cx0) : 1; // no scale
      const matches: CVMatchResult[] = sidecarBody.matches.map((m) => ({
        x: m.x,
        y: m.y,
        rotation: (m.rotation as 0 | 90 | 180 | 270) || 0,
        confidence: m.confidence,
        bbox: [m.bbox[0], m.bbox[1], m.bbox[2], m.bbox[3]],
      }));

      response.json({
        matches,
        referenceBbox: [cx0, cy0, cx1, cy1],
        searchRegion: [0, 0, sW, sH],
        total: sidecarBody.total,
      } satisfies CVMatchResponse);
    } catch (error) {
      next(error);
    }
  });

  // ── POST /api/ml/cv/debug ─────────────────────────────────────────
  router.post("/api/ml/cv/debug", async (request, response, next) => {
    try {
      const body = (request.body ?? {}) as Partial<CVMatchRequest>;
      if (!body.dieId || !body.cellTypeId) {
        response.status(400).json({ error: "dieId and cellTypeId are required" });
        return;
      }
      const { dieId, cellTypeId } = body;
      const record = await readDieRecord(config.dataRoot, dieId);
      const annotations = await readAnnotations(config.dataRoot, dieId);
      const cellType = annotations.cellTypes.find((ct) => ct.id === cellTypeId);
      if (!cellType) {
        response.status(404).json({ error: "cellType not found" });
        return;
      }

      const cellX = body.cellX ?? 0;
      const cellY = body.cellY ?? 0;
      const cx0 = Math.round(cellX + cellType.cropRect.x);
      const cy0 = Math.round(cellY + cellType.cropRect.y);
      const cx1 = Math.round(cellX + cellType.cropRect.x + cellType.cropRect.width);
      const cy1 = Math.round(cellY + cellType.cropRect.y + cellType.cropRect.height);

      const overlayFilename = body.overlayFilename;
      const requestedSource = await resolveRequestedOverlayPath({
        request,
        dataRoot: config.dataRoot,
        dieId,
        sourceId: overlayFilename
      });
      if (overlayFilename && !requestedSource) {
        response.status(404).json({ error: "Visible image source not found" });
        return;
      }
      const sourcePath = requestedSource ?? record.originalPath;

      const debugMeta = await sharp(sourcePath, { limitInputPixels: false }).metadata();
      const dW = debugMeta.width ?? record.width;
      const dH = debugMeta.height ?? record.height;
      const refLeftD = Math.max(0, cx0);
      const refTopD = Math.max(0, cy0);
      const refWD = Math.min(cx1 - cx0, Math.max(0, dW - refLeftD));
      const refHD = Math.min(cy1 - cy0, Math.max(0, dH - refTopD));
      if (refWD <= 0 || refHD <= 0) {
        response.status(400).json({ error: "reference crop outside image bounds" });
        return;
      }

      const searchBuf = await sharp(sourcePath, { limitInputPixels: false })
        .png()
        .toBuffer();

      const fd = new FormData();
      fd.append("search", new Blob([new Uint8Array(searchBuf)], { type: "image/png" }), "search.png");
      fd.append("ref_x", String(refLeftD));
      fd.append("ref_y", String(refTopD));
      fd.append("ref_w", String(refWD));
      fd.append("ref_h", String(refHD));
      const contourParams: [string, string | undefined][] = [
        ["threshold", body.threshold?.toFixed(4)],
        ["max_matches", body.maxMatches?.toFixed(0)],
        ["detection_mode", body.detectionMode],
        ["gradient_kernel", body.gradientKernel?.toFixed(0)],
        ["min_area", body.minArea?.toFixed(0)],
        ["min_distance", body.minDistance?.toFixed(0)],
        ["area_lo", body.areaLo?.toFixed(4)],
        ["area_hi", body.areaHi?.toFixed(4)],
        ["aspect_thresh", body.aspectThresh?.toFixed(4)],
        ["merge_dist_px", body.mergeDistPx?.toFixed(2)],
        ["merge_area_ratio", body.mergeAreaRatio?.toFixed(4)],
        ["efd_harmonics", body.efdHarmonics?.toFixed(0)],
        ["fuzzy_thresh", body.fuzzyThresh?.toFixed(4)],
        ["min_ref_children", body.minRefChildren?.toFixed(0)],
        ["struct_thresh", body.structThresh?.toFixed(4)],
        ["rotation_min_matches", body.rotationMinMatches?.toFixed(0)],
        ["w_shape", body.wShape?.toFixed(4)],
        ["w_area", body.wArea?.toFixed(4)],
        ["w_bbox", body.wBbox?.toFixed(4)],
        ["w_pos", body.wPos?.toFixed(4)],
      ];
      for (const [key, val] of contourParams) {
        if (val != null) fd.append(key, val);
      }

      let sidecarRes: Response;
      try {
        sidecarRes = await fetchSidecar(
          `${config.mlSidecarUrl}/cv/debug`,
          120000,
          { method: "POST", body: fd }
        );
      } catch {
        response.status(503).json({ error: "sidecar unreachable" });
        return;
      }
      if (!sidecarRes.ok) {
        response.status(502).json({ error: `sidecar /cv/debug ${sidecarRes.status}` });
        return;
      }

      const debugData = await sidecarRes.json();
      response.json(debugData);
    } catch (error) {
      next(error);
    }
  });

  // ── POST /api/ml/cv/debug-dump ──────────────────────────────────
  router.post("/api/ml/cv/debug-dump", async (request, response, next) => {
    try {
      const body = (request.body ?? {}) as Partial<CVMatchRequest>;
      if (!body.dieId || !body.cellTypeId) {
        response.status(400).json({ error: "dieId and cellTypeId are required" });
        return;
      }
      const { dieId, cellTypeId } = body;
      const record = await readDieRecord(config.dataRoot, dieId);
      const annotations = await readAnnotations(config.dataRoot, dieId);
      const cellType = annotations.cellTypes.find((ct) => ct.id === cellTypeId);
      if (!cellType) {
        response.status(404).json({ error: "cellType not found" });
        return;
      }
      const cellX = body.cellX ?? 0;
      const cellY = body.cellY ?? 0;
      const cx0 = Math.round(cellX + cellType.cropRect.x);
      const cy0 = Math.round(cellY + cellType.cropRect.y);
      const cx1 = Math.round(cellX + cellType.cropRect.x + cellType.cropRect.width);
      const cy1 = Math.round(cellY + cellType.cropRect.y + cellType.cropRect.height);
      const overlayFilename = body.overlayFilename;
      const requestedSource = await resolveRequestedOverlayPath({
        request,
        dataRoot: config.dataRoot,
        dieId,
        sourceId: overlayFilename
      });
      if (overlayFilename && !requestedSource) {
        response.status(404).json({ error: "Visible image source not found" });
        return;
      }
      const sourcePath = requestedSource ?? record.originalPath;
      const ddMeta = await sharp(sourcePath, { limitInputPixels: false }).metadata();
      const dW = ddMeta.width ?? record.width;
      const dH = ddMeta.height ?? record.height;
      const refLeftD = Math.max(0, cx0);
      const refTopD = Math.max(0, cy0);
      const refWD = Math.min(cx1 - cx0, Math.max(0, dW - refLeftD));
      const refHD = Math.min(cy1 - cy0, Math.max(0, dH - refTopD));
      if (refWD <= 0 || refHD <= 0) {
        response.status(400).json({ error: "reference crop outside image bounds" });
        return;
      }
      const searchBuf = await sharp(sourcePath, { limitInputPixels: false }).png().toBuffer();
      const fd = new FormData();
      fd.append("search", new Blob([new Uint8Array(searchBuf)], { type: "image/png" }), "search.png");
      fd.append("ref_x", String(refLeftD));
      fd.append("ref_y", String(refTopD));
      fd.append("ref_w", String(refWD));
      fd.append("ref_h", String(refHD));
      const contourParams: [string, string | undefined][] = [
        ["threshold", body.threshold?.toFixed(4)],
        ["max_matches", body.maxMatches?.toFixed(0)],
        ["detection_mode", body.detectionMode],
        ["gradient_kernel", body.gradientKernel?.toFixed(0)],
        ["min_area", body.minArea?.toFixed(0)],
        ["min_distance", body.minDistance?.toFixed(0)],
        ["area_lo", body.areaLo?.toFixed(4)],
        ["area_hi", body.areaHi?.toFixed(4)],
        ["aspect_thresh", body.aspectThresh?.toFixed(4)],
        ["merge_dist_px", body.mergeDistPx?.toFixed(2)],
        ["merge_area_ratio", body.mergeAreaRatio?.toFixed(4)],
        ["efd_harmonics", body.efdHarmonics?.toFixed(0)],
        ["fuzzy_thresh", body.fuzzyThresh?.toFixed(4)],
        ["min_ref_children", body.minRefChildren?.toFixed(0)],
        ["struct_thresh", body.structThresh?.toFixed(4)],
        ["rotation_min_matches", body.rotationMinMatches?.toFixed(0)],
        ["w_shape", body.wShape?.toFixed(4)],
        ["w_area", body.wArea?.toFixed(4)],
        ["w_bbox", body.wBbox?.toFixed(4)],
        ["w_pos", body.wPos?.toFixed(4)],
      ];
      for (const [key, val] of contourParams) {
        if (val != null) fd.append(key, val);
      }

      let sidecarRes: Response;
      try {
        sidecarRes = await fetchSidecar(
          `${config.mlSidecarUrl}/cv/debug-dump`,
          120000,
          { method: "POST", body: fd }
        );
      } catch {
        response.status(503).json({ error: "sidecar unreachable" });
        return;
      }
      if (!sidecarRes.ok) {
        response.status(502).json({ error: `sidecar /cv/debug-dump ${sidecarRes.status}` });
        return;
      }
      const result = await sidecarRes.json();
      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  type CVTemplateMatchJob = {
    id: string;
    status: "queued" | "running" | "completed" | "cancelled" | "failed";
    stage: string;
    percentage: number;
    startedAt: string;
    updatedAt: string;
    finishedAt: string | null;
    elapsedMs: number;
    cancelRequested: boolean;
    error: string | null;
    result?: unknown;
    controller: AbortController;
  };
  const cvTemplateMatchJobs = new Map<string, CVTemplateMatchJob>();

  const cvTemplateMatchSnapshot = (job: CVTemplateMatchJob) => {
    const { controller: _controller, ...snapshot } = job;
    return snapshot;
  };
  const updateCVTemplateMatchJob = (job: CVTemplateMatchJob, patch: Partial<CVTemplateMatchJob>) => {
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    job.elapsedMs = Date.now() - Date.parse(job.startedAt);
  };
  const runCVTemplateMatchJob = async (job: CVTemplateMatchJob, request: import("express").Request) => {
    while (cvTemplateActive) await cvTemplateActive.catch(() => undefined);
    if (job.cancelRequested) {
      updateCVTemplateMatchJob(job, { status: "cancelled", stage: "cancelled", percentage: 100, finishedAt: new Date().toISOString() });
      return;
    }
    const work = (async () => {
      updateCVTemplateMatchJob(job, { status: "running", stage: "preprocessing", percentage: 3 });
      try {
        const origin = `${request.protocol}://${request.get("host")}`;
        const headers: Record<string, string> = {
          "content-type": "application/json",
          "x-cv-job-id": job.id,
        };
        const authorization = request.header("authorization");
        if (authorization) headers.authorization = authorization;
        let progressEndpointUnavailable = false;
        const pollProgress = async () => {
          if (progressEndpointUnavailable) return;
          try {
            const progressResponse = await fetch(`${config.mlSidecarUrl}/cv/template-match-progress/${job.id}`);
            if (progressResponse.status === 404) {
              progressEndpointUnavailable = true;
              return;
            }
            if (!progressResponse.ok) return;
            const progress = await progressResponse.json() as { stage?: string; percentage?: number };
            updateCVTemplateMatchJob(job, {
              stage: progress.stage || "sidecar",
              percentage: Math.max(job.percentage, Number(progress.percentage) || 0),
            });
          } catch {
            // Progress is auxiliary; matching itself remains authoritative.
          }
        };
        const progressTimer = setInterval(() => { void pollProgress(); }, 400);
        await pollProgress();
        let response: Response;
        try {
          response = await fetch(`${origin}/api/ml/cv/template-match`, {
            method: "POST",
            headers,
            body: JSON.stringify(request.body),
            signal: job.controller.signal,
          });
        } finally {
          clearInterval(progressTimer);
        }
        if (!response.ok) throw new Error((await response.text()) || `template-match failed (${response.status})`);
        updateCVTemplateMatchJob(job, { stage: "finalizing", percentage: 99 });
        job.result = await response.json();
        updateCVTemplateMatchJob(job, { status: "completed", stage: "done", percentage: 100, finishedAt: new Date().toISOString() });
      } catch (error) {
        if (job.cancelRequested || (error instanceof Error && error.name === "AbortError")) {
          updateCVTemplateMatchJob(job, { status: "cancelled", stage: "cancelled", percentage: 100, finishedAt: new Date().toISOString(), error: null });
        } else {
          updateCVTemplateMatchJob(job, { status: "failed", stage: "error", percentage: 100, finishedAt: new Date().toISOString(), error: error instanceof Error ? error.message : "template matching failed" });
        }
      }
    })();
    cvTemplateActive = work;
    try { await work; } finally { if (cvTemplateActive === work) cvTemplateActive = null; }
  };

  router.post("/api/ml/cv/template-match-jobs", async (request, response) => {
    const now = new Date().toISOString();
    const job: CVTemplateMatchJob = {
      id: crypto.randomUUID(), status: "queued", stage: "queued", percentage: 0,
      startedAt: now, updatedAt: now, finishedAt: null, elapsedMs: 0,
      cancelRequested: false, error: null, controller: new AbortController(),
    };
    cvTemplateMatchJobs.set(job.id, job);
    void runCVTemplateMatchJob(job, request);
    response.status(202).json(cvTemplateMatchSnapshot(job));
  });
  router.get("/api/ml/cv/template-match-jobs/:jobId", (request, response) => {
    const job = cvTemplateMatchJobs.get(request.params.jobId);
    if (!job) { response.status(404).json({ error: "job not found" }); return; }
    response.json(cvTemplateMatchSnapshot(job));
  });
  router.post("/api/ml/cv/template-match-jobs/:jobId/cancel", (request, response) => {
    const job = cvTemplateMatchJobs.get(request.params.jobId);
    if (!job) { response.status(404).json({ error: "job not found" }); return; }
    job.cancelRequested = true;
    void fetch(`${config.mlSidecarUrl}/cv/template-match-cancel/${job.id}`, { method: "POST" }).catch(() => undefined);
    job.controller.abort();
    updateCVTemplateMatchJob(job, { stage: "cancelled", status: job.status === "queued" ? "cancelled" : job.status, percentage: job.status === "queued" ? 100 : job.percentage });
    response.json(cvTemplateMatchSnapshot(job));
  });

  // ── POST /api/ml/cv/template-match ──────────────────────────────
  router.post("/api/ml/cv/template-match", async (request, response, next) => {
    try {
      const body = (request.body ?? {}) as Partial<CVMatchRequest>;
      if (!body.dieId || !body.cellTypeId) {
        response.status(400).json({ error: "dieId and cellTypeId are required" });
        return;
      }
      const { dieId, cellTypeId } = body;
      const record = await readDieRecord(config.dataRoot, dieId);
      const annotations = await readAnnotations(config.dataRoot, dieId);
      const cellType = annotations.cellTypes.find((ct) => ct.id === cellTypeId);
      if (!cellType) { response.status(404).json({ error: "cellType not found" }); return; }
      const cellX = body.cellX ?? 0;
      const cellY = body.cellY ?? 0;
      const cx0 = Math.round(cellX + cellType.cropRect.x);
      const cy0 = Math.round(cellY + cellType.cropRect.y);
      const cx1 = Math.round(cellX + cellType.cropRect.x + cellType.cropRect.width);
      const cy1 = Math.round(cellY + cellType.cropRect.y + cellType.cropRect.height);
      const overlayFilename = body.overlayFilename;
      const requestedSource = await resolveRequestedOverlayPath({
        request,
        dataRoot: config.dataRoot,
        dieId,
        sourceId: overlayFilename
      });
      if (overlayFilename && !requestedSource) {
        response.status(404).json({ error: "Visible image source not found" });
        return;
      }
      const sourcePath = requestedSource ?? record.originalPath;
      const tmMeta = await sharp(sourcePath, { limitInputPixels: false }).metadata();
      const sW = tmMeta.width ?? record.width;
      const sH = tmMeta.height ?? record.height;
      const left = Math.max(0, cx0);
      const top = Math.max(0, cy0);
      const w = Math.min(cx1 - cx0, Math.max(0, sW - left));
      const h = Math.min(cy1 - cy0, Math.max(0, sH - top));
      if (w <= 0 || h <= 0) { response.status(400).json({ error: "crop outside bounds" }); return; }
      const searchBuf = await sharp(sourcePath, { limitInputPixels: false }).png().toBuffer();
      const fd = new FormData();
      fd.append("search", new Blob([new Uint8Array(searchBuf)], { type: "image/png" }), "search.png");
      fd.append("ref_x", String(left));
      fd.append("ref_y", String(top));
      fd.append("ref_w", String(w));
      fd.append("ref_h", String(h));
      if (body.threshold != null) fd.append("threshold", String(body.threshold));
      if (body.rotationSteps != null) fd.append("rotation_steps", String(body.rotationSteps));
      if (body.maxMatches != null) fd.append("max_matches", String(body.maxMatches));
      if (body.sobelKsize != null) fd.append("sobel_ksize", String(body.sobelKsize));
      if (body.nmsIou != null) fd.append("nms_iou", String(body.nmsIou));
      if (body.nmsDist != null) fd.append("nms_dist", String(body.nmsDist));

      let sidecarRes: Response;
      try {
        sidecarRes = await fetchSidecar(`${config.mlSidecarUrl}/cv/template-match`, 30 * 60 * 1000, { method: "POST", body: fd, headers: request.header("x-cv-job-id") ? { "x-cv-job-id": request.header("x-cv-job-id")! } : undefined });
      } catch { response.status(503).json({ error: "sidecar unreachable" }); return; }
      if (!sidecarRes.ok) { response.status(502).json({ error: `sidecar /cv/template-match ${sidecarRes.status}` }); return; }
      const data = await sidecarRes.json();
      response.json({
        matches: data.matches,
        referenceBbox: [cx0, cy0, cx1, cy1],
        searchRegion: [0, 0, sW, sH],
        total: data.total,
      } satisfies CVMatchResponse);
    } catch (error) { next(error); }
  });

  type CVTemplateJob = {
    id: string;
    status: "queued" | "running" | "completed" | "cancelled" | "failed";
    stage: string;
    percentage: number;
    startedAt: string;
    updatedAt: string;
    finishedAt: string | null;
    elapsedMs: number;
    cancelRequested: boolean;
    error: string | null;
    result?: unknown;
    controller: AbortController;
  };
  const cvTemplateJobs = new Map<string, CVTemplateJob>();
  let cvTemplateActive: Promise<void> | null = null;

  const cvJobSnapshot = (job: CVTemplateJob) => {
    const { controller: _controller, ...snapshot } = job;
    return snapshot;
  };
  const updateCVTemplateJob = (job: CVTemplateJob, patch: Partial<CVTemplateJob>) => {
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    job.elapsedMs = Date.now() - Date.parse(job.startedAt);
  };
  const runCVTemplateJob = async (job: CVTemplateJob, request: import("express").Request) => {
    while (cvTemplateActive) await cvTemplateActive.catch(() => undefined);
    if (job.cancelRequested) {
      updateCVTemplateJob(job, { status: "cancelled", stage: "cancelled", percentage: 100, finishedAt: new Date().toISOString() });
      return;
    }
    const work = (async () => {
      updateCVTemplateJob(job, { status: "running", stage: "sidecar", percentage: 15 });
      try {
        const origin = `${request.protocol}://${request.get("host")}`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-cv-job-id": job.id };
        const authorization = request.header("authorization");
        if (authorization) headers.authorization = authorization;
        const pollProgress = async () => {
          try {
            const progressResponse = await fetch(`${config.mlSidecarUrl}/cv/template-debug-progress/${job.id}`);
            if (!progressResponse.ok) return;
            const progress = await progressResponse.json() as { stage?: string; percentage?: number };
            updateCVTemplateJob(job, {
              stage: progress.stage || "sidecar",
              percentage: Math.max(job.percentage, Number(progress.percentage) || 0),
            });
          } catch {
            // Progress is diagnostic; the template job remains authoritative.
          }
        };
        const progressTimer = setInterval(() => { void pollProgress(); }, 400);
        await pollProgress();
        let response: Response;
        try {
          response = await fetch(`${origin}/api/ml/cv/template-debug`, {
            method: "POST",
            headers,
            body: JSON.stringify(request.body),
            signal: job.controller.signal,
          });
        } finally {
          clearInterval(progressTimer);
        }
        if (!response.ok) throw new Error((await response.text()) || `template-debug failed (${response.status})`);
        updateCVTemplateJob(job, { stage: "finalizing", percentage: 90 });
        job.result = await response.json();
        updateCVTemplateJob(job, { status: "completed", stage: "done", percentage: 100, finishedAt: new Date().toISOString() });
      } catch (error) {
        if (job.cancelRequested || (error instanceof Error && error.name === "AbortError")) {
          updateCVTemplateJob(job, { status: "cancelled", stage: "cancelled", percentage: 100, finishedAt: new Date().toISOString(), error: null });
        } else {
          updateCVTemplateJob(job, { status: "failed", stage: "error", percentage: 100, finishedAt: new Date().toISOString(), error: error instanceof Error ? error.message : "template-debug failed" });
        }
      }
    })();
    cvTemplateActive = work;
    try { await work; } finally { if (cvTemplateActive === work) cvTemplateActive = null; }
  };

  router.post("/api/ml/cv/template-debug-jobs", async (request, response) => {
    const now = new Date().toISOString();
    const job: CVTemplateJob = {
      id: crypto.randomUUID(), status: "queued", stage: "queued", percentage: 0,
      startedAt: now, updatedAt: now, finishedAt: null, elapsedMs: 0,
      cancelRequested: false, error: null, controller: new AbortController(),
    };
    cvTemplateJobs.set(job.id, job);
    void runCVTemplateJob(job, request);
    response.status(202).json(cvJobSnapshot(job));
  });
  router.get("/api/ml/cv/template-debug-jobs/:jobId", (request, response) => {
    const job = cvTemplateJobs.get(request.params.jobId);
    if (!job) { response.status(404).json({ error: "job not found" }); return; }
    response.json(cvJobSnapshot(job));
  });
  router.post("/api/ml/cv/template-debug-jobs/:jobId/cancel", (request, response) => {
    const job = cvTemplateJobs.get(request.params.jobId);
    if (!job) { response.status(404).json({ error: "job not found" }); return; }
    job.cancelRequested = true;
    void fetch(`${config.mlSidecarUrl}/cv/template-debug-cancel/${job.id}`, { method: "POST" }).catch(() => undefined);
    job.controller.abort();
    updateCVTemplateJob(job, { stage: "cancelled", status: job.status === "queued" ? "cancelled" : job.status, percentage: job.status === "queued" ? 100 : job.percentage });
    response.json(cvJobSnapshot(job));
  });

  // ── POST /api/ml/cv/template-debug ─────────────────────────────
  router.post("/api/ml/cv/template-debug", async (request, response, next) => {
    try {
      const body = (request.body ?? {}) as Partial<CVMatchRequest>;
      if (!body.dieId || !body.cellTypeId) {
        response.status(400).json({ error: "dieId and cellTypeId are required" }); return;
      }
      const { dieId, cellTypeId } = body;
      const record = await readDieRecord(config.dataRoot, dieId);
      const annotations = await readAnnotations(config.dataRoot, dieId);
      const cellType = annotations.cellTypes.find((ct) => ct.id === cellTypeId);
      if (!cellType) { response.status(404).json({ error: "cellType not found" }); return; }
      const cellX = body.cellX ?? 0;
      const cellY = body.cellY ?? 0;
      const cx0 = Math.round(cellX + cellType.cropRect.x);
      const cy0 = Math.round(cellY + cellType.cropRect.y);
      const cx1 = Math.round(cellX + cellType.cropRect.x + cellType.cropRect.width);
      const cy1 = Math.round(cellY + cellType.cropRect.y + cellType.cropRect.height);
      const overlayFilename = body.overlayFilename;
      const requestedSource = await resolveRequestedOverlayPath({
        request,
        dataRoot: config.dataRoot,
        dieId,
        sourceId: overlayFilename
      });
      if (overlayFilename && !requestedSource) {
        response.status(404).json({ error: "Visible image source not found" });
        return;
      }
      const sourcePath = requestedSource ?? record.originalPath;
      const tmMeta = await sharp(sourcePath, { limitInputPixels: false }).metadata();
      const sW = tmMeta.width ?? record.width;
      const sH = tmMeta.height ?? record.height;
      const left = Math.max(0, cx0); const top = Math.max(0, cy0);
      const w = Math.min(cx1 - cx0, Math.max(0, sW - left));
      const h = Math.min(cy1 - cy0, Math.max(0, sH - top));
      if (w <= 0 || h <= 0) { response.status(400).json({ error: "crop outside bounds" }); return; }
      const searchBuf = await sharp(sourcePath, { limitInputPixels: false }).png().toBuffer();
      const fd = new FormData();
      fd.append("search", new Blob([new Uint8Array(searchBuf)], { type: "image/png" }), "search.png");
      fd.append("ref_x", String(left)); fd.append("ref_y", String(top));
      fd.append("ref_w", String(w)); fd.append("ref_h", String(h));
      if (body.threshold != null) fd.append("threshold", String(body.threshold));
      if (body.rotationSteps != null) fd.append("rotation_steps", String(body.rotationSteps));
      if (body.maxMatches != null) fd.append("max_matches", String(body.maxMatches));
      if (body.sobelKsize != null) fd.append("sobel_ksize", String(body.sobelKsize));
      if (body.nmsIou != null) fd.append("nms_iou", String(body.nmsIou));
      if (body.nmsDist != null) fd.append("nms_dist", String(body.nmsDist));
      let sidecarRes: Response;
      try {
        sidecarRes = await fetchSidecar(`${config.mlSidecarUrl}/cv/template-debug`, 30 * 60 * 1000, { method: "POST", body: fd, headers: request.header("x-cv-job-id") ? { "x-cv-job-id": request.header("x-cv-job-id")! } : undefined });
      } catch { response.status(503).json({ error: "sidecar unreachable" }); return; }
      if (!sidecarRes.ok) { response.status(502).json({ error: `sidecar /cv/template-debug ${sidecarRes.status}` }); return; }
      const data = await sidecarRes.json();
      response.json(data);
    } catch (error) { next(error); }
  });

  // ── POST /api/ml/cv/akaze-verify ────────────────────────────────
  router.post("/api/ml/cv/akaze-verify", async (request, response, next) => {
    try {
      const body = (request.body ?? {}) as Partial<AKAZEReverifyRequest>;
      if (!body.dieId || !body.cellTypeId || !body.matches) {
        response.status(400).json({ error: "dieId, cellTypeId, and matches are required" }); return;
      }
      const { dieId, cellTypeId } = body;
      const record = await readDieRecord(config.dataRoot, dieId);
      const annotations = await readAnnotations(config.dataRoot, dieId);
      const cellType = annotations.cellTypes.find((ct) => ct.id === cellTypeId);
      if (!cellType) { response.status(404).json({ error: "cellType not found" }); return; }

      const overlayFilename = body.overlayFilename;
      const requestedSource = await resolveRequestedOverlayPath({
        request,
        dataRoot: config.dataRoot,
        dieId,
        sourceId: overlayFilename
      });
      if (overlayFilename && !requestedSource) {
        response.status(404).json({ error: "Visible image source not found" });
        return;
      }
      const sourcePath = requestedSource ?? record.originalPath;

      // Extract ref patch coords (same logic as template-match)
      const cellX = body.cellX ?? 0;
      const cellY = body.cellY ?? 0;
      const cx0 = Math.round(cellX + cellType.cropRect.x);
      const cy0 = Math.round(cellY + cellType.cropRect.y);
      const cx1 = Math.round(cellX + cellType.cropRect.x + cellType.cropRect.width);
      const cy1 = Math.round(cellY + cellType.cropRect.y + cellType.cropRect.height);
      const tmMeta = await sharp(sourcePath, { limitInputPixels: false }).metadata();
      const sW = tmMeta.width ?? record.width;
      const sH = tmMeta.height ?? record.height;
      const left = Math.max(0, cx0);
      const top = Math.max(0, cy0);
      const w = Math.min(cx1 - cx0, Math.max(0, sW - left));
      const h = Math.min(cy1 - cy0, Math.max(0, sH - top));

      const searchBuf = await sharp(sourcePath, { limitInputPixels: false }).png().toBuffer();
      const fd = new FormData();
      fd.append("search", new Blob([new Uint8Array(searchBuf)], { type: "image/png" }), "search.png");
      fd.append("matches_json", JSON.stringify(body.matches));
      fd.append("ref_x", String(left));
      fd.append("ref_y", String(top));
      fd.append("ref_w", String(w));
      fd.append("ref_h", String(h));
      if (body.sift_threshold != null) fd.append("sift_threshold", String(body.sift_threshold));
      if (body.blur_ksize != null) fd.append("blur_ksize", String(body.blur_ksize));
      if (body.use_sobel != null) fd.append("use_sobel", String(body.use_sobel));

      let sidecarRes: Response;
      try {
        sidecarRes = await fetchSidecar(`${config.mlSidecarUrl}/cv/akaze-verify`, 120000, { method: "POST", body: fd });
      } catch { response.status(503).json({ error: "sidecar unreachable" }); return; }
      if (!sidecarRes.ok) { response.status(502).json({ error: `sidecar /cv/akaze-verify ${sidecarRes.status}` }); return; }
      const data = await sidecarRes.json();
      response.json(data);
    } catch (error) { next(error); }
  });

  // ── POST /api/ml/cv/akaze-debug ──────────────────────────────────
  router.post("/api/ml/cv/akaze-debug", async (request, response, next) => {
    try {
      const body = (request.body ?? {}) as Partial<AKAZEReverifyRequest & { max_pairs?: number }>;
      if (!body.dieId || !body.cellTypeId || !body.matches) {
        response.status(400).json({ error: "dieId, cellTypeId, and matches are required" }); return;
      }
      const { dieId, cellTypeId } = body;
      const record = await readDieRecord(config.dataRoot, dieId);
      const annotations = await readAnnotations(config.dataRoot, dieId);
      const cellType = annotations.cellTypes.find((ct) => ct.id === cellTypeId);
      if (!cellType) { response.status(404).json({ error: "cellType not found" }); return; }

      const overlayFilename = body.overlayFilename;
      const requestedSource = await resolveRequestedOverlayPath({
        request,
        dataRoot: config.dataRoot,
        dieId,
        sourceId: overlayFilename
      });
      if (overlayFilename && !requestedSource) {
        response.status(404).json({ error: "Visible image source not found" });
        return;
      }
      const sourcePath = requestedSource ?? record.originalPath;

      const cellX = body.cellX ?? 0;
      const cellY = body.cellY ?? 0;
      const cx0 = Math.round(cellX + cellType.cropRect.x);
      const cy0 = Math.round(cellY + cellType.cropRect.y);
      const cx1 = Math.round(cellX + cellType.cropRect.x + cellType.cropRect.width);
      const cy1 = Math.round(cellY + cellType.cropRect.y + cellType.cropRect.height);
      const tmMeta = await sharp(sourcePath, { limitInputPixels: false }).metadata();
      const sW = tmMeta.width ?? record.width;
      const sH = tmMeta.height ?? record.height;
      const left = Math.max(0, cx0);
      const top = Math.max(0, cy0);
      const w = Math.min(cx1 - cx0, Math.max(0, sW - left));
      const h = Math.min(cy1 - cy0, Math.max(0, sH - top));

      const searchBuf = await sharp(sourcePath, { limitInputPixels: false }).png().toBuffer();
      const fd = new FormData();
      fd.append("search", new Blob([new Uint8Array(searchBuf)], { type: "image/png" }), "search.png");
      fd.append("matches_json", JSON.stringify(body.matches));
      fd.append("ref_x", String(left));
      fd.append("ref_y", String(top));
      fd.append("ref_w", String(w));
      fd.append("ref_h", String(h));
      if (body.max_pairs != null) fd.append("max_pairs", String(body.max_pairs));
      if (body.blur_ksize != null) fd.append("blur_ksize", String(body.blur_ksize));
      if (body.use_sobel != null) fd.append("use_sobel", String(body.use_sobel));

      let sidecarRes: Response;
      try {
        sidecarRes = await fetchSidecar(`${config.mlSidecarUrl}/cv/akaze-debug`, 120000, { method: "POST", body: fd });
      } catch { response.status(503).json({ error: "sidecar unreachable" }); return; }
      if (!sidecarRes.ok) { response.status(502).json({ error: `sidecar /cv/akaze-debug ${sidecarRes.status}` }); return; }
      const data = await sidecarRes.json();
      response.json(data);
    } catch (error) { next(error); }
  });

  return router;
}
