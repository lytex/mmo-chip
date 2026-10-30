import { useEffect, useRef } from "react";
import { applyOverlaySettingsFromPrefs, useOverlayLayers } from "../state/overlayLayers";

/** Loads project overlays for pages that can be opened without the die viewer. */
export function useAutoLoadOverlayLayers(dieId: string | null): void {
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!dieId || loadedFor.current === dieId) return;
    loadedFor.current = dieId;
    useOverlayLayers.getState().clearLayers();
    void import("../api/overlayImages").then(async (mod) => {
      const list = await mod.fetchOverlayImageList(dieId);
      for (const source of list.images) {
        if (source.legacy) {
          try {
            const legacy = await mod.loadOverlayImageFromServer(dieId, source.originalFilename);
            useOverlayLayers.getState().addLayer(legacy.name, legacy.image, true, legacy.serverFilename);
          } catch (error) {
            console.warn("Failed to load legacy overlay", source.name, error);
          }
        } else {
          useOverlayLayers.getState().addTiledLayer(source, true);
        }
      }
      applyOverlaySettingsFromPrefs(dieId);
    }).catch((error) => console.warn("Failed to load overlay layers", error));
  }, [dieId]);
}
