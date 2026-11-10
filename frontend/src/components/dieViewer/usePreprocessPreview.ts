import { useCallback, useEffect, useRef } from "react";
import { fetchPreprocessPreview } from "../../api/ml";
import { usePreferences } from "../../state/preferences";
import { useOverlayLayers } from "../../state/overlayLayers";
import type { Rect } from "../../lib/geometry";
import type { VectorizeLayer } from "../../renderer/layers/VectorizeLayer";

/**
 * P2-3 preprocess preview orchestrator. Lives on the PAGE, not the render
 * layer — deliberately rAF-independent:
 *
 * - the fetch chain runs from React effects and setTimeout, which keep
 *   working in background tabs (rAF-driven scheduling froze the preview
 *   whenever the app tab lost focus — the "works once after F12" report);
 * - viewport changes arrive as a DIRECT callback from the pan/zoom path,
 *   not through any animation-frame-coalesced store;
 * - the VectorizeLayer stays a dumb drawable: it only receives the decoded
 *   crop (`setPreviewData`) and the lifecycle (`setPreviewStatus`).
 */

const PREVIEW_DEBOUNCE_MS = 150;
const RETRY_BACKOFF_CAP_MS = 3000;

export function usePreprocessPreview(opts: {
  dieId: string | null;
  dieWidth: number;
  dieHeight: number;
  enabled: boolean;
  /** JSON of `vectorParams.preprocess` — any slider move re-runs the chain. */
  preprocessSignature: string;
  vectorLayer: VectorizeLayer | null;
  /** Canvas handle's world rect (the current visible viewport). */
  getWorldRect: () => Rect | null;
}): () => void {
  // Destructured ONLY for effect dependency arrays (per-render values);
  // callbacks read the fresh set through optsRef.
  const { enabled, preprocessSignature, dieId, vectorLayer } = opts;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const debounceRef = useRef<number | null>(null);
  const retryRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const failuresRef = useRef(0);
  /** Key of the last SUCCESSFUL fetch — identical viewport+params+source
   *  don't need a re-fetch; failures never set it, so failures always
   *  re-fetch (self-healing), unlike the old layer-side key pinning. */
  const successKeyRef = useRef<string | null>(null);
  /** Bitmap ownership lives here: the layer only references it. */
  const bitmapRef = useRef<ImageBitmap | null>(null);

  const closeBitmap = useCallback(() => {
    bitmapRef.current?.close();
    bitmapRef.current = null;
  }, []);

  const fetchTick = useCallback(async () => {
    const { dieId, dieWidth, dieHeight, enabled, vectorLayer, getWorldRect } = optsRef.current;
    if (!enabled || !vectorLayer || !dieId) {
      vectorLayer?.setPreviewStatus("off", 0, null);
      return;
    }
    const rect = getWorldRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      vectorLayer.setPreviewStatus("off", 0, null);
      return;
    }
    // Clamp to the source image (the blink viewport can hang outside it).
    const x0 = Math.max(0, Math.floor(rect.x));
    const y0 = Math.max(0, Math.floor(rect.y));
    const x1 = Math.min(dieWidth, Math.ceil(rect.x + rect.width));
    const y1 = Math.min(dieHeight, Math.ceil(rect.y + rect.height));
    if (!(x1 > x0 && y1 > y0)) {
      vectorLayer.setPreviewStatus("off", 0, null);
      return;
    }
    const bbox: [number, number, number, number] = [x0, y0, x1, y1];
    const params = usePreferences.getState().vectorParams;
    const overlays = useOverlayLayers.getState().layers;
    const visible = overlays.find((l) => !l.hidden && l.loaded);
    const overlaySource = visible?.serverFilename ?? visible?.name ?? undefined;
    const key = `${bbox.join(",")}|${overlaySource ?? ""}|${JSON.stringify(params.preprocess ?? {})}`;
    if (successKeyRef.current === key) return; // already on screen

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    vectorLayer.setPreviewStatus("fetching", failuresRef.current, null);
    try {
      const blob = await fetchPreprocessPreview(dieId, bbox, params, overlaySource, controller.signal);
      if (controller.signal.aborted) return;
      const bitmap = await createImageBitmap(blob);
      if (controller.signal.aborted) {
        bitmap.close();
        return;
      }
      closeBitmap();
      bitmapRef.current = bitmap;
      successKeyRef.current = key;
      failuresRef.current = 0;
      vectorLayer.setPreviewData({ bitmap, bbox });
      vectorLayer.setPreviewStatus("ok", 0, null);
      vectorLayer.refresh();
    } catch (e) {
      if (controller.signal.aborted) return;
      failuresRef.current += 1;
      const message = e instanceof Error ? e.message : String(e);
      console.warn("[preprocess preview] failed — retrying:", message);
      vectorLayer.setPreviewData(null);
      const delay = Math.min(RETRY_BACKOFF_CAP_MS, 400 * 2 ** Math.min(4, failuresRef.current - 1));
      if (retryRef.current !== null) clearTimeout(retryRef.current);
      retryRef.current = window.setTimeout(() => {
        retryRef.current = null;
        void fetchTick();
      }, delay);
      vectorLayer.setPreviewStatus("fail", failuresRef.current, message);
    }
  }, [closeBitmap]);

  /** Debounced schedule — called on every toggle/param/viewport change. */
  const schedule = useCallback((immediate = false) => {
    if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    if (retryRef.current !== null) {
      clearTimeout(retryRef.current);
      retryRef.current = null;
    }
    if (immediate) {
      void fetchTick();
      return;
    }
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      void fetchTick();
    }, PREVIEW_DEBOUNCE_MS);
  }, [fetchTick]);

  // Toggle / params / die / layer changed → reschedule (or clear when off).
  useEffect(() => {
    const cur = optsRef.current;
    if (!cur.enabled) {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
      if (retryRef.current !== null) clearTimeout(retryRef.current);
      abortRef.current?.abort();
      debounceRef.current = null;
      retryRef.current = null;
      closeBitmap();
      successKeyRef.current = null;
      cur.vectorLayer?.setPreviewData(null);
      cur.vectorLayer?.setPreviewStatus("off", 0, null);
      return;
    }
    schedule(false);
  }, [enabled, preprocessSignature, dieId, vectorLayer, schedule]);

  // Die/layer switch → drop the old crop (a stale die's crop must not leak).
  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
      if (retryRef.current !== null) clearTimeout(retryRef.current);
      abortRef.current?.abort();
      closeBitmap();
    };
  }, [dieId, vectorLayer, closeBitmap]);

  /** Direct viewport signal — wired to the pan/zoom callback (synchronous,
   *  rAF-free). Called from the page on every viewport change. */
  const onViewport = useCallback(() => {
    if (!optsRef.current.enabled) return;
    schedule(false);
  }, [schedule]);

  return onViewport;
}
