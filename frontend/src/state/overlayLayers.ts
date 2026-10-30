import { create } from "zustand";
import { uuid } from "../lib/uuid";
import type { OverlayImageSource } from "../api/overlayImages";
import { usePreferences } from "./preferences";
import type { OverlayLayerPersistedSettings } from "./preferences";

export interface OverlayLayerEntry {
  id: string;
  name: string;
  /** Stable source id for tiled images; filename for legacy images. */
  serverFilename?: string;
  src: string;
  image: HTMLImageElement | null;
  source: OverlayImageSource | null;
  loaded: boolean;
  hidden: boolean;
  opacity: number;
  offsetX: number;
  offsetY: number;
  /** Effective purpose, explicit or auto-detected from the name. */
  purpose: string | null;
  explicitPurpose: string | null;
  purposeSource: "user" | "auto" | "none";
  suggestedPurpose: string | null;
  purposeEditable: boolean;
}

interface OverlayLayersState {
  layers: OverlayLayerEntry[];
  baseImageVisible: boolean;
  addLayer: (name: string, image: HTMLImageElement, hidden?: boolean, serverFilename?: string) => string;
  addTiledLayer: (source: OverlayImageSource, hidden?: boolean) => string;
  removeLayer: (id: string) => void;
  setLayerHidden: (id: string, hidden: boolean) => void;
  setLayerOpacity: (id: string, opacity: number) => void;
  renameLayer: (id: string, name: string) => void;
  applyLayerSource: (id: string, source: OverlayImageSource) => void;
  moveLayer: (fromIndex: number, toIndex: number) => void;
  setLayerOffset: (id: string, offsetX: number, offsetY: number) => void;
  toggleBaseImage: () => void;
  clearLayers: () => void;
}

export const useOverlayLayers = create<OverlayLayersState>()((set, get) => ({
  layers: [],
  baseImageVisible: true,
  addLayer: (name, image, hidden = false, serverFilename) => {
    const id = uuid();
    set((state) => ({ layers: [...state.layers, {
      id, name, serverFilename, src: image.src, image, source: null, loaded: true,
      hidden, opacity: 1, offsetX: 0, offsetY: 0,
      purpose: null, explicitPurpose: null, purposeSource: "none",
      suggestedPurpose: null, purposeEditable: false
    }] }));
    return id;
  },
  addTiledLayer: (source, hidden = false) => {
    const existing = get().layers.find((layer) => layer.source?.id === source.id);
    if (existing) return existing.id;
    const id = uuid();
    set((state) => ({ layers: [...state.layers, {
      id, name: source.name, serverFilename: source.id, src: "", image: null, source,
      loaded: source.ready, hidden, opacity: 1, offsetX: 0, offsetY: 0,
      purpose: source.purpose ?? null,
      explicitPurpose: source.explicitPurpose ?? null,
      purposeSource: source.purposeSource ?? "none",
      suggestedPurpose: source.suggestedPurpose ?? null,
      purposeEditable: source.purposeEditable ?? !source.legacy
    }] }));
    return id;
  },
  removeLayer: (id) => {
    const entry = get().layers.find((layer) => layer.id === id);
    if (entry?.src.startsWith("blob:")) URL.revokeObjectURL(entry.src);
    set((state) => ({ layers: state.layers.filter((layer) => layer.id !== id) }));
  },
  setLayerHidden: (id, hidden) => set((state) => ({ layers: state.layers.map((layer) => layer.id === id ? { ...layer, hidden } : layer) })),
  setLayerOpacity: (id, opacity) => set((state) => ({ layers: state.layers.map((layer) => layer.id === id ? { ...layer, opacity: Math.min(1, Math.max(0, opacity)) } : layer) })),
  renameLayer: (id, name) => set((state) => ({ layers: state.layers.map((layer) => layer.id === id ? { ...layer, name } : layer) })),
  applyLayerSource: (id, source) => set((state) => ({
    layers: state.layers.map((layer) => layer.id === id ? {
      ...layer,
      source,
      name: layer.name,
      purpose: source.purpose ?? null,
      explicitPurpose: source.explicitPurpose ?? null,
      purposeSource: source.purposeSource ?? "none",
      suggestedPurpose: source.suggestedPurpose ?? null,
      purposeEditable: source.purposeEditable ?? !source.legacy
    } : layer)
  })),
  moveLayer: (fromIndex, toIndex) => set((state) => {
    if (fromIndex < 0 || toIndex < 0 || fromIndex >= state.layers.length || toIndex >= state.layers.length) return state;
    const layers = [...state.layers];
    const [entry] = layers.splice(fromIndex, 1);
    layers.splice(toIndex, 0, entry);
    return { layers };
  }),
  setLayerOffset: (id, offsetX, offsetY) => set((state) => ({ layers: state.layers.map((layer) => layer.id === id ? { ...layer, offsetX, offsetY } : layer) })),
  toggleBaseImage: () => set((state) => ({ baseImageVisible: !state.baseImageVisible })),
  clearLayers: () => {
    for (const entry of get().layers) if (entry.src.startsWith("blob:")) URL.revokeObjectURL(entry.src);
    set({ layers: [] });
  }
}));

/** The last array item paints on top, therefore search from the end. */
export function topVisibleOverlaySourceId(): string | undefined {
  const layers = useOverlayLayers.getState().layers;
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index];
    // A manifest-backed source can be selected before its tile pyramid is
    // ready. Crop endpoints can still render from the original image, and the
    // selector should not silently fall back to another layer in that case.
    if (!layer.hidden && layer.opacity > 0 && layer.serverFilename) return layer.serverFilename;
  }
  return undefined;
}

export function saveOverlaySettingsToPrefs(dieId: string): void {
  const settings: Record<string, OverlayLayerPersistedSettings> = {};
  for (const layer of useOverlayLayers.getState().layers) {
    if (!layer.serverFilename) continue;
    settings[layer.serverFilename] = {
      hidden: layer.hidden,
      opacity: layer.opacity,
      offsetX: layer.offsetX,
      offsetY: layer.offsetY,
      name: layer.name,
      order: useOverlayLayers.getState().layers.indexOf(layer)
    };
  }
  usePreferences.getState().saveOverlayLayerSettings(dieId, settings);
}

export function applyOverlaySettingsFromPrefs(dieId: string): void {
  const saved = usePreferences.getState().overlayLayerSettings[dieId];
  if (!saved) return;
  const state = useOverlayLayers.getState();
  for (const layer of state.layers) {
    const settings = layer.serverFilename ? saved[layer.serverFilename] : undefined;
    if (!settings) continue;
    if (typeof settings.name === "string" && settings.name.trim()) {
      state.renameLayer(layer.id, settings.name);
    }
    state.setLayerHidden(layer.id, settings.hidden);
    state.setLayerOpacity(layer.id, settings.opacity);
    state.setLayerOffset(layer.id, settings.offsetX, settings.offsetY);
  }
  const current = useOverlayLayers.getState().layers;
  const ordered = [...current].sort((a, b) => {
    const ao = a.serverFilename ? saved[a.serverFilename]?.order : undefined;
    const bo = b.serverFilename ? saved[b.serverFilename]?.order : undefined;
    return (ao ?? Number.MAX_SAFE_INTEGER) - (bo ?? Number.MAX_SAFE_INTEGER);
  });
  if (ordered.some((layer, index) => layer.id !== current[index]?.id)) {
    useOverlayLayers.setState({ layers: ordered });
  }
}

