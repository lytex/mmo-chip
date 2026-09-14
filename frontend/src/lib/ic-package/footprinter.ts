import { fp as fpFn } from "@tscircuit/footprinter";
import type { PackagePin } from "shared";

interface RawPad {
  type?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  rect_pad_width?: number;
  rect_pad_height?: number;
  port_hints?: string[];
}

function isRawPad(e: unknown): e is RawPad {
  if (!e || typeof e !== "object") return false;
  const t = (e as { type?: string }).type;
  return (
    (t === "pcb_smtpad" || t === "pcb_plated_hole") &&
    typeof (e as RawPad).x === "number" &&
    typeof (e as RawPad).y === "number"
  );
}

/** Curated footprint descriptors shown in the package selector. */
export const PACKAGE_PRESETS = [
  { value: "soic8", label: "SOIC-8" },
  { value: "soic16", label: "SOIC-16" },
  { value: "sot23", label: "SOT-23 (3)" },
  { value: "sot25", label: "SOT-23-5" },
  { value: "sot89", label: "SOT-89" },
  { value: "sot223", label: "SOT-223" },
  { value: "dip8", label: "DIP-8" },
  { value: "dip14", label: "DIP-14" },
  { value: "dip16", label: "DIP-16" },
  { value: "tssop20", label: "TSSOP-20" },
  { value: "msop10", label: "MSOP-10" },
  { value: "qfn16", label: "QFN-16" },
  { value: "qfn32", label: "QFN-32" },
  { value: "qfp32", label: "QFP-32" },
  { value: "qfp64", label: "QFP-64" },
  { value: "qfp128", label: "QFP-128" },
] as const;

/**
 * Common pin counts for IC-style families in @tscircuit/footprinter.  Combined
 * with the family name these become descriptors like "soic8", "qfn32",
 * "bga256".  Generated once (and validated against the real geometry) into
 * the full selector list.
 */
const IC_FAMILY_PIN_COUNTS: Record<string, number[]> = {
  soic: [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 28, 32],
  sop8: [8], sop16: [16], sop20: [20], sop28: [28], sop32: [32],
  ssop: [14, 16, 20, 24, 28, 48, 56],
  tssop: [8, 14, 16, 20, 24, 28, 38, 48, 56],
  msop: [8, 10, 12, 16],
  vssop: [8],
  qfp: [32, 44, 48, 52, 64, 80, 100, 128, 144, 160, 176, 208],
  lqfp: [32, 44, 48, 64, 80, 100, 128, 144, 160, 176],
  tqfp: [32, 44, 48, 64, 80, 100, 128, 144],
  qfn: [8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 64],
  mlp: [20, 32],
  vson: [4, 6, 8],
  wson: [6, 8, 12],
  son: [4, 6, 8],
  dfn: [2, 3, 4, 6, 8, 10, 12],
  lga: [4, 6, 8, 12, 16, 24],
  bga: [16, 25, 36, 49, 64, 100, 121, 144, 169, 196, 225, 256, 289, 324, 361, 400],
  dip: [6, 8, 14, 16, 18, 20, 24, 28, 32, 40, 48],
  quad: [16, 24, 32, 48, 64],
  sot: [3, 4, 5, 6, 8],
  sot23: [3], sot23w: [3], sot25: [5], sot89: [4], sot143: [4],
  sot223: [4], sot323: [3], sot343: [4], sot363: [6], sot457: [5],
  sot563: [6], sot723: [3], sot886: [8], sot963: [8],
  ms012: [8], ms013: [16],
};

/** Turn "soic8" → "SOIC-8", "bga256" → "BGA-256". */
function autoLabel(descriptor: string): string {
  const m = descriptor.match(/^([a-z0-9]+?)(\d+)$/);
  if (m) return `${m[1].toUpperCase()}-${m[2]}`;
  return descriptor.toUpperCase();
}

let fullPresetsCache: { value: string; label: string }[] | null = null;

/**
 * Full selector list: the curated common footprints first, then every
 * IC-family × pin-count combination that @tscircuit/footprinter can actually
 * generate (validated against the real geometry).  Cached after first call.
 */
export function getAllPackagePresets(): { value: string; label: string }[] {
  if (fullPresetsCache) return fullPresetsCache;
  const seen = new Set<string>(PACKAGE_PRESETS.map((p) => p.value));
  const rest: { value: string; label: string }[] = [];
  for (const [family, counts] of Object.entries(IC_FAMILY_PIN_COUNTS)) {
    for (const n of counts) {
      const value = `${family}${n}`;
      if (seen.has(value)) continue;
      try {
        const geom = loadPackageGeom(value);
        if (geom.pins.length >= 2) {
          seen.add(value);
          rest.push({ value, label: autoLabel(value) });
        }
      } catch {
        // Not a valid descriptor for this pin count — skip.
      }
    }
  }
  rest.sort((a, b) => a.label.localeCompare(b.label));
  fullPresetsCache = [...PACKAGE_PRESETS, ...rest];
  return fullPresetsCache;
}

export interface PackageGeom {
  pins: PackagePin[];
  /** Bounding box of the package in mm (min/max x/y around pin positions,
   *  excluding pin extents — used to draw the body outline). */
  body: { minX: number; minY: number; maxX: number; maxY: number };
}

/** Parse a footprinter descriptor (e.g. "soic8", "sot25") into normalized
 *  pins in mm. Accepts any valid descriptor; throws on unknown. */
export function loadPackageGeom(descriptor: string): PackageGeom {
  const elements = fpFn.string(descriptor).circuitJson() as unknown[];
  const pads: RawPad[] = elements.filter(isRawPad);

  const pins: PackagePin[] = pads.map((p, i) => {
    const num = Number(p.port_hints?.[0]) || i + 1;
    return {
      number: num,
      name: "",
      x: p.x,
      y: p.y,
      w: p.width ?? p.rect_pad_width ?? 0.5,
      h: p.height ?? p.rect_pad_height ?? 0.25,
    };
  });
  pins.sort((a, b) => a.number - b.number);

  // Body outline: expand the pin bounding box by a margin. Footprinter's
  // courtyard gives the true outline but varies by package; a simple
  // expansion of the pin extents is good enough for the bond-mapper view.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pins) {
    const hw = (p.w ?? 0.5) / 2, hh = (p.h ?? 0.25) / 2;
    minX = Math.min(minX, p.x - hw); maxX = Math.max(maxX, p.x + hw);
    minY = Math.min(minY, p.y - hh); maxY = Math.max(maxY, p.y + hh);
  }
  const margin = 0.6;
  return {
    pins,
    body: { minX: minX - margin, minY: minY - margin, maxX: maxX + margin, maxY: maxY + margin },
  };
}
