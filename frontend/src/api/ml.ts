import { useEffect } from "react";
import {
  useQuery,
  useQueryClient,
  type UseQueryOptions,
  type UseQueryResult
} from "@tanstack/react-query";
import type {
  AKAZEReverifyRequest,
  AKAZEReverifyResponse,
  AKAZEDebugResponse,
  CVDebugData,
  CVMatchRequest,
  CVMatchResponse,
  MLExportRequest,
  MLInferenceJob,
  MLModelsResponse,
  MLPrediction,
  MLSelectModelRequest,
  MLServiceStatus,
  VectorBlocksResponse,
  VectorLayerInfo,
  VectorizeParams,
  VectorizeResponse,
  VectorSweepStatus
} from "shared";
import { subscribeToDie } from "./annotationsWebSocket";
import { ApiError, apiDelete, apiGet, apiPost, authHeaders } from "./client";

/**
 * Kick off the backend ML training-data export for a die. The backend crops
 * every ROI and writes its per-ROI image + label JSON (sized by the die's
 * `mlConfig`, falling back to `approxViaRadiusPx`).
 *
 * The job is fire-and-forget server-side: this resolves once it's *scheduled*
 * (HTTP 202), not when the files are written — progress shows in server logs.
 */
export function exportMlData(
  dieId: string,
  approxViaRadiusPx: number,
  overlayFilename?: string
): Promise<{ ok: true }> {
  const body: MLExportRequest = { approxViaRadiusPx, overlayFilename };
  return apiPost<{ ok: true }>(`/api/dies/${dieId}/ml-export`, body);
}

// ── ML via predictions ───────────────────────────────────────────────

export type DieViasBbox = readonly [number, number, number, number];

export interface UseDieViasOptions {
  /** Peak heatmap probability above which a point counts as a via. Server
   *  default is 0.5; raise to suppress weak detections. */
  threshold?: number;
  /** Min spacing (px) between accepted peaks (server default 4). */
  minDistance?: number;
  /** Skip the fetch (useful when the user has the overlay turned off). */
  enabled?: boolean;
  /** Overlay filename to run inference on, instead of base image. */
  overlaySource?: string;
}

/**
 * ML via predictions for a die bbox in source-image (px) coords. Hits the
 * **uncached** `GET /api/dies/:dieId/vias?bbox=…` endpoint — every server
 * call triggers a fresh inference run — so the client caches aggressively:
 * results are keyed by `(dieId, bbox, threshold, minDistance, overlaySource)` and reused
 * across the session. Pass `enabled: false` to silence the request entirely
 * while the user has the overlay toggled off.
 *
 * Returns `null` data when disabled or when the inputs aren't ready. The
 * server returns 503 if the ML sidecar is unreachable — let callers surface
 * that themselves rather than retrying to death.
 */
export function useDieVias(
  dieId: string | null,
  bbox: DieViasBbox | null,
  options: UseDieViasOptions = {}
): UseQueryResult<MLPrediction | null, ApiError> {
  const { threshold, minDistance, enabled = true, overlaySource } = options;
  return useQuery<MLPrediction | null, ApiError>({
    queryKey: [
      "dieVias",
      dieId,
      bbox,
      threshold ?? null,
      minDistance ?? null,
      overlaySource ?? null
    ] as const,
    queryFn: async ({ signal }) => {
      if (!dieId || !bbox) return null;
      const params = new URLSearchParams();
      params.set("bbox", bbox.join(","));
      if (threshold != null) params.set("threshold", String(threshold));
      if (minDistance != null) params.set("min_distance", String(minDistance));
      if (overlaySource) params.set("overlaySource", overlaySource);
      return apiGet<MLPrediction>(
        `/api/dies/${dieId}/vias?${params.toString()}`,
        signal
      );
    },
    enabled: enabled && !!dieId && !!bbox,
    staleTime: 5 * 60_000,
    retry: 1
  });
}

// ── ML service status & models ───────────────────────────────────────

/**
 * Classical (no-model) metal vectorization of a die bbox in source-image
 * (px) coords: `GET /api/dies/:dieId/vectorize`. The backend memory-caches
 * per (source, bbox, params), so panning back with unchanged sliders is
 * free. Plain function (no react-query) — the overlay layer drives fetching
 * with its own viewport debounce.
 */
export async function vectorizeRegion(
  dieId: string,
  bbox: readonly [number, number, number, number],
  params: VectorizeParams,
  overlaySource?: string,
  signal?: AbortSignal
): Promise<VectorizeResponse> {
  const q = new URLSearchParams();
  q.set("bbox", bbox.join(","));
  q.set("channel", params.channel);
  q.set("invert", params.invert ? "1" : "0");
  q.set("threshLow", String(params.threshLow));
  q.set("threshHigh", String(params.threshHigh));
  q.set("adaptive", params.adaptive ? "1" : "0");
  q.set("adaptiveBlock", String(params.adaptiveBlock));
  q.set("adaptiveC", String(params.adaptiveC));
  q.set("openPx", String(params.openPx));
  q.set("bridgePx", String(params.bridgePx));
  q.set("minLength", String(params.minLength));
  q.set("widthMin", String(params.widthMin));
  q.set("widthMax", String(params.widthMax));
  q.set("decoder", params.decoder);
  q.set("octDeltaPx", String(params.octDeltaPx));
  q.set("octStrict", params.octStrict ? "1" : "0");
  if (params.preprocess) q.set("preprocess", JSON.stringify(params.preprocess));
  if (overlaySource) q.set("overlaySource", overlaySource);
  return apiGet<VectorizeResponse>(
    `/api/dies/${dieId}/vectorize?${q.toString()}`,
    signal
  );
}

/** P2-3 preview: the preprocessed crop (usually the live viewport) as a
 *  PNG blob — the VectorizeLayer blits it under traces/outlines so tuning
 *  brightness/CLAHE/etc. happens while SEEING the processed pixels. */
export async function fetchPreprocessPreview(
  dieId: string,
  bbox: [number, number, number, number],
  params: VectorizeParams,
  overlaySource?: string,
  signal?: AbortSignal
): Promise<Blob> {
  // Client-side deadline: during a stack restart the backend accepts the
  // request and then sits dead-silent — without this the preview would
  // hang forever with NO console output (the "clean console, dead
  // preview" report).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    const response = await fetch(`/api/dies/${dieId}/vectorize/preprocess-preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        bbox,
        preprocess: params.preprocess ?? {},
        ...(overlaySource ? { overlaySource } : {})
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      let detail = `preprocess preview failed (${response.status})`;
      try {
        const j = (await response.json()) as { error?: string };
        if (j?.error) detail = j.error;
      } catch {
        /* not JSON */
      }
      throw new Error(detail);
    }
    return response.blob();
  } finally {
    clearTimeout(timer);
  }
}

/** Pipette readout: mean RGB of a small source region (the same image the
 *  vectorize endpoint decodes — base or overlay). */
export interface DiePixelSample {
  r: number;
  g: number;
  b: number;
  /** How many source pixels the mean covers. */
  samples: number;
}

/** Mean colour of a die region in source-image (px) coords. Tiny regions
 *  only (backend caps at 4096 px) — this is the vector pipette's eyedrop. */
export async function sampleDieRegion(
  dieId: string,
  bbox: readonly [number, number, number, number],
  overlaySource?: string,
  signal?: AbortSignal
): Promise<DiePixelSample> {
  const q = new URLSearchParams();
  q.set("bbox", bbox.join(","));
  if (overlaySource) q.set("overlaySource", overlaySource);
  return apiGet<DiePixelSample>(`/api/dies/${dieId}/sample?${q.toString()}`, signal);
}

// ── Whole-die vectorize sweep (block jobs + disk cache) ──────────────

/** Start a whole-die vectorize sweep (decodes every 2048-px block, caches
 *  each under dataRoot/vectorize/<dieId>/<paramsHash>/). */
export function startVectorSweep(
  dieId: string,
  params: VectorizeParams,
  overlaySource?: string
): Promise<VectorSweepStatus> {
  return apiPost<VectorSweepStatus>(`/api/dies/${dieId}/vectorize/job/start`, {
    params,
    overlaySource
  });
}

export function getVectorSweep(dieId: string): Promise<VectorSweepStatus> {
  return apiGet<VectorSweepStatus>(`/api/dies/${dieId}/vectorize/job`);
}

export function stopVectorSweep(dieId: string): Promise<VectorSweepStatus> {
  return apiPost<VectorSweepStatus>(`/api/dies/${dieId}/vectorize/job/stop`, {});
}

/** Cached sweep blocks for a bbox + params. `missing > 0` → the sweep hasn't
 *  covered the region (or params differ) — caller falls back to live decode.
 *  NB: decoder/oct params MUST be forwarded — the cache key (paramsHash)
 *  includes them, and a mismatch turns every cached payload into a miss. */
export async function fetchVectorBlocks(
  dieId: string,
  bbox: readonly [number, number, number, number],
  params: VectorizeParams,
  overlaySource?: string,
  signal?: AbortSignal
): Promise<VectorBlocksResponse> {
  const q = new URLSearchParams();
  q.set("bbox", bbox.join(","));
  q.set("channel", params.channel);
  q.set("invert", params.invert ? "1" : "0");
  q.set("threshLow", String(params.threshLow));
  q.set("threshHigh", String(params.threshHigh));
  q.set("adaptive", params.adaptive ? "1" : "0");
  q.set("adaptiveBlock", String(params.adaptiveBlock));
  q.set("adaptiveC", String(params.adaptiveC));
  q.set("openPx", String(params.openPx));
  q.set("bridgePx", String(params.bridgePx));
  q.set("minLength", String(params.minLength));
  q.set("widthMin", String(params.widthMin));
  q.set("widthMax", String(params.widthMax));
  q.set("decoder", params.decoder);
  q.set("octDeltaPx", String(params.octDeltaPx));
  q.set("octStrict", params.octStrict ? "1" : "0");
  if (params.preprocess) q.set("preprocess", JSON.stringify(params.preprocess));
  if (overlaySource) q.set("overlaySource", overlaySource);
  return apiGet<VectorBlocksResponse>(
    `/api/dies/${dieId}/vectorize/blocks?${q.toString()}`,
    signal
  );
}

/** A pinned SAVED whole-die payload: fetched BY hash (any params set that
 *  completed once), one VectorBlockPayload with the whole die. */
export async function fetchVectorLayerBlocks(
  dieId: string,
  hash: string,
  dieBox: readonly [number, number, number, number],
  signal?: AbortSignal
): Promise<VectorBlocksResponse> {
  const q = new URLSearchParams();
  q.set("bbox", dieBox.join(","));
  q.set("hash", hash);
  return apiGet<VectorBlocksResponse>(
    `/api/dies/${dieId}/vectorize/blocks?${q.toString()}`,
    signal
  );
}

/** The Vector layers list for the left panel (saved whole-die payloads). */
export function getVectorLayers(dieId: string, signal?: AbortSignal): Promise<VectorLayerInfo[]> {
  return apiGet<VectorLayerInfo[]>(`/api/dies/${dieId}/vectorize/layers`, signal);
}

/** Rename a saved whole-die layer (Vector Layers tree ✎). */
export function renameVectorLayer(dieId: string, hash: string, name: string): Promise<{ ok: boolean }> {
  return apiPost(`/api/dies/${dieId}/vectorize/layers/${hash}/rename`, { name });
}

/** Delete a saved whole-die layer (payload + mask + params/name json). */
export function deleteVectorLayer(dieId: string, hash: string): Promise<{ ok: boolean }> {
  return apiDelete(`/api/dies/${dieId}/vectorize/layers/${hash}`);
}

/** Sidecar health — checkpoint name, device, training flag. */
export function useMLStatus(): UseQueryResult<MLServiceStatus, ApiError> {
  return useQuery<MLServiceStatus, ApiError>({
    queryKey: ["mlStatus"],
    queryFn: ({ signal }) => apiGet<MLServiceStatus>("/api/ml/status", signal),
    staleTime: 10_000,
    refetchInterval: 20_000,
    retry: 1
  });
}

/** Checkpoint files the sidecar can load (the model dropdown). */
export function useMLModels(): UseQueryResult<MLModelsResponse, ApiError> {
  return useQuery<MLModelsResponse, ApiError>({
    queryKey: ["mlModels"],
    queryFn: ({ signal }) => apiGet<MLModelsResponse>("/api/ml/models", signal),
    staleTime: 30_000,
    retry: 1
  });
}

export interface MLSelectModelResult {
  checkpoint: string | null;
  checkpointHash: string | null;
  modelLoaded: boolean;
}

/**
 * Switch the sidecar's resident checkpoint. The backend wipes the prediction
 * cache + ML jobs (they belonged to the old model), so callers must warn the
 * user first and refresh ML-related queries afterwards.
 */
export function selectMLModel(name: string): Promise<MLSelectModelResult> {
  const body: MLSelectModelRequest = { name };
  return apiPost<MLSelectModelResult>("/api/ml/model", body);
}

// ── Die-wide inference job ────────────────────────────────────────────

export const mlJobKey = (dieId: string) => ["mlJob", dieId] as const;

export function getMLJob(
  dieId: string,
  signal?: AbortSignal
): Promise<MLInferenceJob> {
  return apiGet<MLInferenceJob>(`/api/dies/${dieId}/ml/job`, signal);
}

export function startMLJob(dieId: string, overlayFilename?: string): Promise<MLInferenceJob> {
  return apiPost<MLInferenceJob>(`/api/dies/${dieId}/ml/job/start`, { overlayFilename });
}

export function stopMLJob(dieId: string): Promise<MLInferenceJob> {
  return apiPost<MLInferenceJob>(`/api/dies/${dieId}/ml/job/stop`, {});
}

/**
 * Live inference-job state for a die. Seeded by `GET …/ml/job`, then kept in
 * sync by WS `mlJob` broadcasts — so a job another user started shows up here
 * too. A slow polling fallback covers a dropped WS while a job is running.
 */
export function useMLJob(
  dieId: string | null
): UseQueryResult<MLInferenceJob | null, ApiError> {
  const qc = useQueryClient();
  const query = useQuery<MLInferenceJob | null, ApiError>({
    queryKey: ["mlJob", dieId],
    queryFn: ({ signal }) =>
      dieId ? getMLJob(dieId, signal) : Promise.resolve(null),
    enabled: !!dieId,
    refetchInterval: (q) =>
      q.state.data?.status === "running" ? 4000 : false,
    retry: 1
  });

  useEffect(() => {
    if (!dieId) return;
    return subscribeToDie(dieId, (msg) => {
      if (msg.type === "mlJob" && msg.dieId === dieId) {
        qc.setQueryData(mlJobKey(dieId), msg.job);
      }
    });
  }, [dieId, qc]);

  return query;
}

/** Every die's inference job — for the library page's status badges. */
export function listMLInferenceJobs(
  signal?: AbortSignal
): Promise<MLInferenceJob[]> {
  return apiGet<MLInferenceJob[]>("/api/ml/inference-jobs", signal);
}

type MLInferenceJobsQueryOptions = Omit<
  UseQueryOptions<MLInferenceJob[], ApiError, MLInferenceJob[], string[]>,
  "queryKey" | "queryFn"
>;

// ── CV cell detection ─────────────────────────────────────────────

export function cvMatch(params: CVMatchRequest): Promise<CVMatchResponse> {
  return apiPost<CVMatchResponse>("/api/ml/cv/match", params);
}

export function cvDebug(params: CVMatchRequest): Promise<CVDebugData> {
  return apiPost<CVDebugData>("/api/ml/cv/debug", params);
}

export function cvDebugDump(params: CVMatchRequest): Promise<CVDebugData & { dump_path: string }> {
  return apiPost<CVDebugData & { dump_path: string }>("/api/ml/cv/debug-dump", params);
}

export function cvTemplateMatch(params: CVMatchRequest): Promise<CVMatchResponse> {
  return apiPost<CVMatchResponse>("/api/ml/cv/template-match", params);
}

export function cvTemplateDebug(params: CVMatchRequest): Promise<CVDebugData> {
  return apiPost<CVDebugData>("/api/ml/cv/template-debug", params);
}

export interface CVTemplateMatchJob {
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
  result?: CVMatchResponse;
}

export function startCVTemplateMatchJob(params: CVMatchRequest): Promise<CVTemplateMatchJob> {
  return apiPost<CVTemplateMatchJob>("/api/ml/cv/template-match-jobs", params);
}

export function getCVTemplateMatchJob(jobId: string): Promise<CVTemplateMatchJob> {
  return apiGet<CVTemplateMatchJob>(`/api/ml/cv/template-match-jobs/${jobId}`);
}

export function cancelCVTemplateMatchJob(jobId: string): Promise<CVTemplateMatchJob> {
  return apiPost<CVTemplateMatchJob>(`/api/ml/cv/template-match-jobs/${jobId}/cancel`, {});
}

export interface CVTemplateDebugJob {
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
  result?: CVDebugData;
}

export function startCVTemplateDebugJob(params: CVMatchRequest): Promise<CVTemplateDebugJob> {
  return apiPost<CVTemplateDebugJob>("/api/ml/cv/template-debug-jobs", params);
}

export function getCVTemplateDebugJob(jobId: string): Promise<CVTemplateDebugJob> {
  return apiGet<CVTemplateDebugJob>(`/api/ml/cv/template-debug-jobs/${jobId}`);
}

export function cancelCVTemplateDebugJob(jobId: string): Promise<CVTemplateDebugJob> {
  return apiPost<CVTemplateDebugJob>(`/api/ml/cv/template-debug-jobs/${jobId}/cancel`, {});
}

export function cvAkazeVerify(params: AKAZEReverifyRequest): Promise<AKAZEReverifyResponse> {
  return apiPost<AKAZEReverifyResponse>("/api/ml/cv/akaze-verify", params);
}

export function cvAkazeDebug(params: AKAZEReverifyRequest & { max_pairs?: number }): Promise<AKAZEDebugResponse> {
  return apiPost<AKAZEDebugResponse>("/api/ml/cv/akaze-debug", params);
}

export function useMLInferenceJobs(
  options?: MLInferenceJobsQueryOptions
): UseQueryResult<MLInferenceJob[], ApiError> {
  return useQuery<MLInferenceJob[], ApiError, MLInferenceJob[], string[]>({
    queryKey: ["mlInferenceJobs"],
    queryFn: ({ signal }) => listMLInferenceJobs(signal),
    retry: 1,
    ...options
  });
}
