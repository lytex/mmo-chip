import { create } from "zustand";
import type {
  DieAnnotations,
  DieTransform,
  IcPackageConfig,
  PackagePin,
  WireBond,
} from "shared";
import { loadPackageGeom, PACKAGE_PRESETS, getAllPackagePresets } from "../lib/ic-package/footprinter";
import { DEFAULT_DIE_TRANSFORM } from "../lib/ic-package/transform";

/** Editor tool modes in the IC Package view. */
export type IcPackageTool = "name" | "bond" | "pan";

interface IcPackageState {
  /** Footprinter descriptor, e.g. "soic8". */
  footprint: string;
  pins: PackagePin[];
  bonds: WireBond[];
  transform: DieTransform;

  /** Bond wire thickness in µm (0.03 mm = 30 µm default). */
  bondWireWidthUm: number;

  /** Active editor tool. */
  tool: IcPackageTool;

  /** When tool="bond": which package pin is the first endpoint. */
  selectedPinNumber: number | null;
  /** Pad id currently under the cursor (for snap preview). */
  hoveredPadId: string | null;

  /** Available footprint descriptors for the dropdown. */
  presets: readonly { value: string; label: string }[];

  // ── Actions ────────────────────────────────────────────────────
  loadFromAnnotations: (ann: DieAnnotations | undefined) => void;
  setFootprint: (fp: string) => void;
  namePin: (num: number, name: string) => void;
  removePinName: (num: number) => void;
  addBond: (pinNumber: number, diePadId: string) => void;
  removeBond: (id: string) => void;
  setTool: (t: IcPackageTool) => void;
  selectPin: (n: number | null) => void;
  setHoveredPad: (id: string | null) => void;

  setRotation: (deg: number) => void;
  toggleMirrorX: () => void;
  toggleMirrorY: () => void;
  resetTransform: () => void;
  setBondWireWidthUm: (um: number) => void;

  /** Serialise to persist in DieAnnotations.icPackage. */
  toConfig: () => IcPackageConfig;
}

const DEFAULT_FOOTPRINT = PACKAGE_PRESETS[0].value;

export const useIcPackageStore = create<IcPackageState>((set, get) => {
  const initialGeom = loadPackageGeom(DEFAULT_FOOTPRINT);
  return {
    footprint: DEFAULT_FOOTPRINT,
    pins: initialGeom.pins,
    bonds: [],
    transform: { ...DEFAULT_DIE_TRANSFORM },
    tool: "pan",
    selectedPinNumber: null,
    hoveredPadId: null,
    presets: getAllPackagePresets(),
    bondWireWidthUm: 15,

    loadFromAnnotations: (ann) => {
      const cfg = ann?.icPackage;
      if (!cfg) {
        const geom = loadPackageGeom(DEFAULT_FOOTPRINT);
        set({
          footprint: DEFAULT_FOOTPRINT,
          pins: geom.pins,
          bonds: [],
          transform: { ...DEFAULT_DIE_TRANSFORM },
          bondWireWidthUm: 15,
        });
        return;
      }
      // Re-derive geometry from descriptor so we always have fresh w/h
      // and pin positions even if the saved version was stale.
      let pins: PackagePin[] = cfg.pins;
      try {
        const geom = loadPackageGeom(cfg.footprint);
        const nameByNum = new Map(cfg.pins.map((p) => [p.number, p.name]));
        pins = geom.pins.map((p) => ({ ...p, name: nameByNum.get(p.number) ?? "" }));
      } catch {
        pins = cfg.pins;
      }
      set({
        footprint: cfg.footprint,
        pins,
        bonds: cfg.bonds,
        transform: cfg.transform,
        bondWireWidthUm: cfg.bondWireWidthUm ?? 15,
      });
    },

    setFootprint: (fp) => {
      if (fp === get().footprint) return;
      const geom = loadPackageGeom(fp);
      // Preserve any user-entered names by number.
      const oldNames = new Map(get().pins.map((p) => [p.number, p.name]));
      const pins = geom.pins.map((p) => ({ ...p, name: oldNames.get(p.number) ?? "" }));
      set({ footprint: fp, pins, selectedPinNumber: null, hoveredPadId: null });
    },

    namePin: (num, name) => {
      set((s) => ({
        pins: s.pins.map((p) => (p.number === num ? { ...p, name } : p)),
      }));
    },

    removePinName: (num) => {
      set((s) => ({
        pins: s.pins.map((p) => (p.number === num ? { ...p, name: "" } : p)),
      }));
    },

    addBond: (pinNumber, diePadId) => {
      // A die pad can only bond to one pin, but a package pin may carry many
      // parallel bonds (e.g. power pads). Replace any existing bond at the
      // pad, then append the new one.
      const id = `b${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const bonds = get().bonds.filter(
        (b) => b.diePadId !== diePadId
      );
      bonds.push({ id, pinNumber, diePadId });
      set({ bonds, selectedPinNumber: null, hoveredPadId: null });
    },

    removeBond: (id) => {
      set((s) => ({ bonds: s.bonds.filter((b) => b.id !== id) }));
    },

    setTool: (t) => set({ tool: t, selectedPinNumber: null, hoveredPadId: null }),

    selectPin: (n) => set({ selectedPinNumber: n }),

    setHoveredPad: (id) => set({ hoveredPadId: id }),

    setRotation: (deg) => {
      const normalized = ((deg % 360) + 360) % 360;
      set((s) => ({ transform: { ...s.transform, rotationDeg: normalized } }));
    },

    toggleMirrorX: () =>
      set((s) => ({ transform: { ...s.transform, mirrorX: !s.transform.mirrorX } })),
    toggleMirrorY: () =>
      set((s) => ({ transform: { ...s.transform, mirrorY: !s.transform.mirrorY } })),

    resetTransform: () => set({ transform: { ...DEFAULT_DIE_TRANSFORM } }),

    setBondWireWidthUm: (um) => {
      set({ bondWireWidthUm: Number.isFinite(um) && um >= 1 ? Math.round(um) : 15 });
    },

    toConfig: () => {
      const { footprint, pins, bonds, transform, bondWireWidthUm } = get();
      return { footprint, pins, bonds, transform, bondWireWidthUm };
    },
  };
});
