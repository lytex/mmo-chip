/**
 * useOverlayHotkeys — Shared keyboard shortcuts for overlay layer control.
 *
 * Works across Die Viewer, Merge Cells, and RE Cell.
 *
 *   Space+B         — toggle base image visibility
 *   ]               — show only the NEXT overlay layer (N+1), hide others
 *   [               — show only the PREVIOUS overlay layer (N-1), hide others
 *   Space+1..8      — show only overlay layer #1..#8, hide others; repeat to hide it
 */

import { useEffect } from "react";
import { useOverlayLayers } from "../state/overlayLayers";

export function useOverlayHotkeys(onToggleBaseImage?: () => void): void {
  useEffect(() => {
    let spaceHeld = false;
    const onKeyDown = (e: KeyboardEvent) => {
      // Don't fire when the user is typing in an input.
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.code === "Space") {
        spaceHeld = true;
        return;
      }

      const layers = useOverlayLayers.getState().layers;
      const ctrl = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;
      const space = spaceHeld;

      // Space+B → toggle base image
      if (space && !ctrl && !shift && !e.altKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        if (onToggleBaseImage) onToggleBaseImage();
        else useOverlayLayers.getState().toggleBaseImage();
        return;
      }

      // Space+1..8 → show only layer N, hide all others; repeat when it is the
      // only visible layer to hide it.
      if (space && !ctrl && !shift && !e.altKey && e.code >= "Digit1" && e.code <= "Digit8") {
        e.preventDefault();
        const digits = ["Digit1","Digit2","Digit3","Digit4","Digit5","Digit6","Digit7","Digit8"];
        const idx = digits.indexOf(e.code);
        const { layers } = useOverlayLayers.getState();
        if (idx >= layers.length) return;
        const targetAlreadySolo = !layers[idx].hidden &&
          layers.every((layer, layerIdx) => layerIdx === idx || layer.hidden);
        for (let i = 0; i < layers.length; i++) {
          const hidden = targetAlreadySolo ? true : i !== idx;
          if (layers[i].hidden !== hidden) {
            useOverlayLayers.getState().setLayerHidden(layers[i].id, hidden);
          }
        }
        return;
      }

      // ] → show only the next overlay (N+1), hide all others
      if (e.key === "]" && !ctrl && !space && !shift && !e.altKey) {
        e.preventDefault();
        const { layers } = useOverlayLayers.getState();
        if (layers.length === 0) return;
        // Find current visible layer index
        const currentIdx = layers.findIndex((l) => !l.hidden);
        const nextIdx = currentIdx < 0
          ? 0                          // none visible → show first
          : (currentIdx + 1) % layers.length;  // next, wrapping
        for (let i = 0; i < layers.length; i++) {
          const hidden = i !== nextIdx;
          if (layers[i].hidden !== hidden) {
            useOverlayLayers.getState().setLayerHidden(layers[i].id, hidden);
          }
        }
        return;
      }

      // [ → show only the previous overlay (N-1), hide all others
      if (e.key === "[" && !ctrl && !space && !shift && !e.altKey) {
        e.preventDefault();
        const { layers } = useOverlayLayers.getState();
        if (layers.length === 0) return;
        const currentIdx = layers.findIndex((l) => !l.hidden);
        const prevIdx = currentIdx <= 0
          ? layers.length - 1          // none or first → show last
          : currentIdx - 1;            // previous
        for (let i = 0; i < layers.length; i++) {
          const hidden = i !== prevIdx;
          if (layers[i].hidden !== hidden) {
            useOverlayLayers.getState().setLayerHidden(layers[i].id, hidden);
          }
        }
        return;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceHeld = false;
    };
    const onBlur = () => { spaceHeld = false; };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [onToggleBaseImage]);
}
