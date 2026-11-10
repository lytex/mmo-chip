import { PROCESS_LAYERS, type LayerType, type ShapeLabel } from "shared";

/**
 * Visual tokens + sizing math for die annotations. Pure constants/functions —
 * shared by the per-kind annotation builders and a few UI surfaces (color
 * pickers, the wire-draft overlay).
 */

// ── Cell-layer palette ───────────────────────────────────────────────
//
// Two sources of truth: the opaque base color (used for outline strokes and
// as the colour reference everywhere — chip swatches, the layer-visibility
// list, live tool previews) and the per-layer fill opacity (alpha applied on
// top of the base when the shape body is painted). Keeping them split lets
// fills stay translucent (so stacked layers composite legibly) while strokes
// stay crisp (so shape boundaries don't blur into the imagery underneath).

/** Opaque base colour per layer. Saturated by design so the layer reads at a
 *  glance both on the canvas and in the side-panel swatch. */
export const COLOR_LAYER: Record<LayerType, string> = {
  diffusion: "#e0a030",
  polysilicon: "#a0d030",
  metal1: "#00e0e0",
  metal2: "#e060e0",
  contact: "#c0a000",
  via1: "#a030a0",
  via2: "#b040b0",
  via3: "#c050c0",
  via4: "#d060d0",
  via5: "#e070e0",
  wire_hitbox: "#f3b351",
  // Analog / BiCMOS layers
  nwell: "#ff8844",
  pwell: "#66aaff",
  deep_nwell: "#dd7744",
  buried_layer: "#aa66dd",
  base: "#44ff88",
  emitter: "#ff6688",
  collector_sinker: "#88ccff",
  jfet_gate: "#ff88aa",
  jfet_channel: "#88ffaa",
  resistor_body: "#ffaa44",
  capacitor_bottom: "#44aaff",
  capacitor_top: "#ff44aa",
  hsr: "#cc8844",
  film: "#88aacc",
  metal3: "#44ffaa",
  metal4: "#aa44ff",
  metal5: "#ffaa44",
  metal6: "#44aaff",
  device_box: "#ffffff",
  // Marker layers
  npn_id: "#44ff66",
  pnp_id: "#66ff88",
  lpnp_id: "#88ffaa",
  vpnp: "#ff88cc",
  res_id: "#ffaa44",
  cap_id: "#44ddff",
  diode_id: "#ff6666",
  // BJT terminal
  collector: "#88ccff",
  // Bulk/well
  bulk: "#ffaa44",
};

/** Alpha multiplier applied to the layer's fill (stroke is always full
 *  alpha). Diffusion sits lowest so the imagery underneath stays visible
 *  through the large active-area regions; hitbox is barely-there because
 *  it's a click target, not a visible artefact. */
export const LAYER_FILL_OPACITY: Record<LayerType, number> = {
  diffusion: 0.2,
  polysilicon: 0.4,
  metal1: 0.4,
  metal2: 0.4,
  contact: 0.4,
  via1: 0.4,
  via2: 0.4,
  via3: 0.4,
  via4: 0.4,
  via5: 0.4,
  wire_hitbox: 0.15,
  // Analog layers: well layers are large, use low opacity
  nwell: 0.18,
  pwell: 0.18,
  deep_nwell: 0.18,
  buried_layer: 0.25,
  base: 0.35,
  emitter: 0.35,
  collector_sinker: 0.3,
  jfet_gate: 0.35,
  jfet_channel: 0.3,
  resistor_body: 0.35,
  capacitor_bottom: 0.3,
  capacitor_top: 0.3,
  hsr: 0.35,
  film: 0.35,
  metal3: 0.4,
  metal4: 0.4,
  metal5: 0.4,
  metal6: 0.4,
  device_box: 0.1,
  // Marker layers (visible but transparent)
  npn_id: 0.25,
  pnp_id: 0.25,
  lpnp_id: 0.25,
  vpnp: 0.2,
  res_id: 0.25,
  cap_id: 0.25,
  diode_id: 0.25,
  // BJT terminal
  collector: 0.3,
  // Bulk/well
  bulk: 0.3,
};

/** Per-label override colour: `shape.label` overrides the layer's base colour
 *  for shapes the user has tagged with a role. The tagged shape still gets
 *  the layer's fill alpha. `input` / `output` are forced-net overrides for
 *  cells whose structural classification needs a manual hint. */
export const COLOR_LABEL: Record<ShapeLabel, string> = {
  vcc: "#ff4040",
  gnd: "#4080ff",
  io: "#f1c40f",
  input: "#22d3ee",   // cyan — clearly distinct from gnd blue
  output: "#34d399"   // green — matches --ok in the dark palette
};

// ── Cells ────────────────────────────────────────────────────────────

/** Preset colors offered for cell outline + block fill (chosen in the cell
 *  settings popover). Deliberately warm/neutral so cells (large translucent
 *  containers) contrast the cool, saturated wire palette and stay clear of the
 *  amber selection accent. First entry is the default (neutral white). */
export const CELL_COLOR_OPTIONS: ReadonlyArray<{ label: string; value: string }> = [
  { label: "White", value: "#ffffff" },
  { label: "Slate", value: "#94a3b8" },
  { label: "Rose", value: "#fb7185" },
  { label: "Orange", value: "#f97316" },
  { label: "Red", value: "#ef4444" }
];

/** Default cell color (neutral white — current look). */
export const CELL_COLOR = CELL_COLOR_OPTIONS[0].value;
/** Alpha applied to the chosen cell color for the outline / block fill. */
export const CELL_OUTLINE_ALPHA = 0.8;
export const CELL_FILL_ALPHA = 0.16;
/** Cell outline width in screen px (constant regardless of zoom). */
export const CELL_OUTLINE_PX = 2;

// ── Nets ─────────────────────────────────────────────────────────────

/** Preset colors offered for unselected wires + vertices (chosen in the net
 *  settings popover). All are bright/opaque and distinct from the amber
 *  selection accent. First entry is the default (legacy viewer blue).
 *  16 colors = 8 cool + 8 warm. */
export const NET_COLOR_OPTIONS: ReadonlyArray<{ label: string; value: string }> = [
  // Row 1 — cool
  { label: "Blue", value: "#2e97ff" },
  { label: "Cyan", value: "#22d3ee" },
  { label: "Teal", value: "#2dd4bf" },
  { label: "Green", value: "#34d399" },
  { label: "Lime", value: "#a3e635" },
  { label: "Sky", value: "#38bdf8" },
  { label: "Indigo", value: "#818cf8" },
  { label: "Violet", value: "#a78bfa" },
  // Row 2 — warm
  { label: "Magenta", value: "#e879f9" },
  { label: "Hot Pink", value: "#ec4899" },
  { label: "Rose", value: "#fb7185" },
  { label: "Red", value: "#ef4444" },
  { label: "Orange", value: "#fb923c" },
  { label: "Amber", value: "#f59e0b" },
  { label: "Yellow", value: "#facc15" },
  { label: "Slate Gray", value: "#94a3b8" },
];

/** Default base color for unselected wires + vertices (legacy viewer blue). */
export const NET_COLOR = NET_COLOR_OPTIONS[0].value;

/** Per-conductor-layer wire color. "unknown" (absent layer) is intentionally
 *  not here — it falls back to the user-configurable base net color. Chosen
 *  bright/opaque and mutually distinct (orange / teal / violet). */
export const WIRE_LAYER_COLOR: Record<string, string> = {
  ...Object.fromEntries(Object.entries(PROCESS_LAYERS).map(([layer, def]) => [layer, def.color])),
  poly: "#fb923c",
  metal1: "#2dd4bf",
  metal2: "#a78bfa",
  metal3: "#4ade80",
  metal4: "#f472b6",
  metal5: "#fb923c",
  metal6: "#60a5fa"
};

// Net wires scale geometrically with zoom (so they thicken as you zoom in,
// matching the imagery), but clamped so they're never invisible at very low
// zoom and never absurdly fat at very high zoom. The base world width is
// user-tunable via a slider in the outline tree.
export const NET_DEFAULT_WIDTH = 10;
export const NET_MIN_WIDTH = 0.5;
export const NET_MAX_WIDTH = 20;
export const NET_MIN_SCREEN_PX = 0.5;
export const NET_MAX_SCREEN_PX = 32;
export const NET_NODE_RADIUS_MULT = 1.6;

export function netScreenWidth(zoom: number, worldWidth: number): number {
  return Math.min(NET_MAX_SCREEN_PX, Math.max(NET_MIN_SCREEN_PX, worldWidth * zoom));
}

/**
 * Largest radius (screen px) a net vertex is ever drawn at for the given zoom
 * and base width — including the selected-node multiplier. The wire-draft
 * snap halo uses this so it always sits *outside* the rendered vertex
 * (vertices scale with zoom and would otherwise swallow a fixed-size halo).
 */
export function netNodeScreenRadius(zoom: number, netWidth: number): number {
  return netScreenWidth(zoom, netWidth) * NET_NODE_RADIUS_MULT * SELECT_NODE_MULT;
}

/** World-unit radius a net vertex dot is actually painted at for the given
 *  zoom, base width and node-size multiplier. Mirrors
 *  `buildNetAnnotation.draw` exactly (screen-clamped wire width -> world
 *  radius), so hit-testing can match the visible disc instead of a
 *  zoom-independent guess. `mlMode` paints vertices flush with the stroke
 *  (radius = half the width). */
export function netNodeWorldRadius(
  zoom: number,
  worldWidth: number,
  nodeMult: number,
  mlMode = false
): number {
  if (mlMode) return worldWidth / 2;
  if (nodeMult <= 0) return 0;
  return (netScreenWidth(zoom, worldWidth) * nodeMult) / zoom;
}

// ── Via / ML annotations ─────────────────────────────────────────────

export const COLOR_VIA = "rgba(130, 214, 166, 0.85)"; // green-power
export const COLOR_VIA_FILL = "rgba(130, 214, 166, 0.25)";

/** Preset colors offered for via dot/outline (chosen in the via settings
 *  settings popover). All bright/opaque colours; first entry is the default.
 *  16 colors = 8 cool + 8 warm. Every swatch is visually distinct — full
 *  spectrum coverage with no two adjacent hues looking alike. */
export const VIA_COLOR_OPTIONS: ReadonlyArray<{ label: string; value: string }> = [
  // Row 1 — cool to neutral
  { label: "Green (default)", value: "rgba(130, 214, 166, 0.85)" },
  { label: "Teal", value: "rgba(45, 212, 191, 0.85)" },
  { label: "Cyan", value: "rgba(52, 211, 235, 0.85)" },
  { label: "Sky Blue", value: "rgba(56, 189, 248, 0.85)" },
  { label: "Blue", value: "rgba(96, 165, 250, 0.85)" },
  { label: "Indigo", value: "rgba(129, 140, 248, 0.85)" },
  { label: "Violet", value: "rgba(167, 139, 250, 0.85)" },
  { label: "Purple", value: "rgba(192, 132, 252, 0.85)" },
  // Row 2 — warm to bright
  { label: "Magenta", value: "rgba(232, 121, 249, 0.85)" },
  { label: "Hot Pink", value: "rgba(236, 72, 153, 0.85)" },
  { label: "Pink", value: "rgba(251, 113, 133, 0.85)" },
  { label: "Red", value: "rgba(239, 68, 68, 0.85)" },
  { label: "Bright Orange", value: "rgba(251, 146, 60, 0.85)" },
  { label: "Orange", value: "rgba(249, 115, 22, 0.85)" },
  { label: "Amber", value: "rgba(245, 194, 66, 0.85)" },
  { label: "Yellow", value: "rgba(250, 204, 21, 0.85)" },
];
/** Default via color (green-power — current look). */
export const VIA_DEFAULT_COLOR = VIA_COLOR_OPTIONS[0].value;

/** Opaque (no alpha) variant for outline swatch — strips any alpha channel
 *  so the swatch reads solid in the UI. */
export function viaColorOpaque(color: string): string {
  // If it's an rgba string, drop the alpha; if hex, return as-is.
  if (color.startsWith("rgba")) {
    const m = color.match(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m) return `rgb(${m[1]}, ${m[2]}, ${m[3]})`;
  }
  return color;
}

/** Extract R,G,B from an rgba / rgb / #rgb / #rrggbb string and return a new
 *  rgba with a custom alpha (0..1). Other inputs are returned unchanged. */
export function viaColorWithAlpha(color: string, alpha: number): string {
  const m = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})`;
  const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, "$&$&") : hex[1];
    const n = parseInt(h, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  return color;
}

/** Default render radius for point vias (world / source-pixel units). Single
 *  source of truth for both manual and ML vias, and the snap-to-via
 *  tolerance for the wire / multi-wire tools. */
export const VIA_DEFAULT_SIZE = 6;
export const VIA_MIN_SIZE = 1;
export const VIA_MAX_SIZE = 40;
/** Floor / ceiling on the rendered radius in CSS px so vias don't disappear
 *  when zoomed way out and don't dominate the view when zoomed way in. The
 *  snap tolerance applies the same floor so click-areas stay usable at any
 *  zoom. (Net widths follow the same pattern — see `netScreenWidth`.) */
export const VIA_MIN_SCREEN_PX = 2;
export const VIA_MAX_SCREEN_PX = 48;

/** Map a world-unit via radius to the CSS-px radius actually drawn at the
 *  current zoom, clamped so the dot stays visible without ballooning. */
export function viaScreenRadius(zoom: number, worldR: number): number {
  return Math.min(
    VIA_MAX_SCREEN_PX,
    Math.max(VIA_MIN_SCREEN_PX, worldR * zoom)
  );
}

/** Default I/O pin marker half-size (world / source-pixel units). Per-die
 *  override in `pinSizeByDie`, like the net wire width — each die has its
 *  own magnification, so one size doesn't fit every chip. */
export const PIN_DEFAULT_SIZE = 6;
export const PIN_MIN_SIZE = 1;
export const PIN_MAX_SIZE = 60;
/** Screen clamp for the pin marker, same idea as `VIA_MIN/MAX_SCREEN_PX`. */
export const PIN_MIN_SCREEN_PX = 3;
export const PIN_MAX_SCREEN_PX = 48;

/** Map a world-unit pin half-size to the CSS-px half-size drawn at `zoom`. */
export function pinScreenHalf(zoom: number, worldHalf: number): number {
  return Math.min(
    PIN_MAX_SCREEN_PX,
    Math.max(PIN_MIN_SCREEN_PX, worldHalf * zoom)
  );
}

/** World-unit snap tolerance for "click on a via" — matches the rendered
 *  radius (click inside the visible dot = snap). Floored at the same CSS-px
 *  minimum used by the render so the snap area stays usable when zoomed
 *  out enough that the world radius would shrink below a pixel on screen. */
export function viaSnapTolerance(zoom: number, worldR: number): number {
  return Math.max(worldR, VIA_MIN_SCREEN_PX / zoom);
}
export const COLOR_IGNORE = "rgba(227, 104, 84, 0.8)";
export const COLOR_IGNORE_FILL = "rgba(227, 104, 84, 0.12)";
/** Vectorize trace regions (rect/poly contours) — the same cyan-blue the
 *  region draft overlays use, so tool feedback and committed shapes match. */
export const COLOR_TRACE_REGION = "rgba(126, 200, 240, 0.9)";
export const COLOR_TRACE_REGION_FILL = "rgba(126, 200, 240, 0.07)";
/** Vectorize trace blockages — the ignore-red styling plus an X cross. */
export const COLOR_TRACE_BLOCKAGE = COLOR_IGNORE;
export const COLOR_TRACE_BLOCKAGE_FILL = COLOR_IGNORE_FILL;
export const COLOR_ROI = "rgba(245, 214, 138, 0.9)";
export const COLOR_PIN = "rgba(127, 178, 255, 0.95)";
export const COLOR_PIN_FILL = "rgba(127, 178, 255, 0.18)";

// ── Selection accent ─────────────────────────────────────────────────

// Amber/gold selection accent — deliberately contrasts the blue net base so
// selected geometry reads at a glance (matches the legacy viewer convention).
export const SELECT_COLOR = "#f3b351";
export const SELECT_FILL = "rgba(243, 179, 81, 0.22)";
/** White ring around selected point/vertex handles, for pop against imagery. */
export const SELECT_RING = "#ffffff";
export const SELECT_OUTLINE_PX = 1.5;
/** Selected nets render thicker / larger so the selection is obvious. */
export const SELECT_WIDTH_MULT = 1.5;
export const SELECT_NODE_MULT = 1.4;

// ── Misc sizing + pick precedence ────────────────────────────────────

// Constant-screen-pixel sizes (in CSS pixels). Divide by zoom for world size.
export const VIA_RADIUS_PX = 2.5;
export const OUTLINE_WIDTH_PX = 1;

// Click precedence (higher wins). Foreground geometry (vias, wires/vertices,
// pins) must beat cells, which are large background containers — otherwise
// clicking a wire that runs through a cell selects the cell.
export const PICK = {
  via: 3,
  pin: 3,
  net: 2,
  roi: 1,
  ignore: 1,
  traceRegion: 1,
  traceBlockage: 1,
  cell: 0
} as const;

/** Parse #rgb / #rrggbb / rgb() / rgba() into 0-255 channels. */
function parseRgb(color: string): { r: number; g: number; b: number } | null {
  const c = color.trim();
  if (c.startsWith("#")) {
    let hex = c.slice(1);
    if (hex.length === 3) hex = hex.replace(/./g, (ch) => ch + ch);
    if (hex.length !== 6) return null;
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16)
    };
  }
  const m = c.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  return m ? { r: +m[1], g: +m[2], b: +m[3] } : null;
}

/** Best-contrast black/white ink for a given colour, chosen by relative
 *  luminance. Keeps the junction cross legible on any dot colour. */
export function contrastColor(color: string): string {
  const rgb = parseRgb(color);
  if (!rgb) return "#000000";
  const lum = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return lum > 0.5 ? "#000000" : "#ffffff";
}
