/**
 * Single-cell inference: one cell type's annotated layer geometry →
 * a structural circuit description (`CellExtraction`).
 *
 * `CellExtraction` is THE output data structure of this library. The die
 * netlister and the Verilog emitter consume it; nothing downstream should
 * reach back into raw geometry.
 *
 * A `CellExtraction` is one of two kinds:
 *   - "inferred"    — fully reverse-engineered: transistors, nets, Boolean
 *                     logic. Produced by `extractCell`.
 *   - "placeholder" — a cell too complex to infer automatically (flip-flops,
 *                     scan cells, …). Only its I/O ports are modelled; the
 *                     user supplies a hand-written Verilog module.
 * Both carry `ports` (the cell's I/O, derived from `wire_hitbox` shapes) and
 * `warnings`.
 *
 * Pipeline for "inferred" cells (implemented below):
 *
 *   1. Split each diffusion shape at every poly that crosses it. Each
 *      resulting sub-region remembers which polys carved its boundary, so
 *      step 4 can recover S/D pads without a separate adjacency heuristic.
 *   2. Build a union-find over metals + polys + diff sub-regions + contacts
 *      + vias. Same-layer overlap merges (positive-area only — shared edges
 *      stay split). Contacts/vias union across the layers they overlap.
 *      Pre-applied vcc/gnd/io labels propagate to the whole component.
 *   3. Infer each diffusion's P/N type from the rails its sub-regions touch.
 *      User-forced labels (`shape.label === "vcc" | "gnd"` on a diffusion)
 *      win; conflicting / unreachable cases warn.
 *   4. Emit transistors for every (poly, diffusion) overlap. The intersection
 *      may yield multiple disjoint regions (one transistor each). S/D pads
 *      come from the parent diffusion's sub-regions adjacent to that poly.
 *      `dummy` flags self-shorted transistors (gate + same net on both pads).
 *   5. Classify each net by what kind of terminals it touches: vcc/gnd/io,
 *      input (only gates), output (bridges PMOS↔NMOS S/D), internal, or
 *      unused. Cell-level checks flag missing rails / no output / etc.
 *
 * Out of scope (later passes): cell-name pattern matching, sequential
 * structure detection.
 *
 * Every Clipper op runs via `./clipper` so the algorithm stays unit-testable
 * once the WASM module is loaded (`loadClipper()`).
 */

import type { CellType, LayerShape, LayerType, ShapeLabel } from "shared";
import {
  polygonBounds,
  polygonsOverlap,
  shapeToPolygon,
  type Point,
  type Rect,
  UnionFind,
} from "./common";
import {
  polygonDifference,
  polygonInflate,
  polygonIntersection,
  polygonsIntersect,
  ringSignedArea,
  ringsAbsArea,
} from "./clipper";
import { chainCellLogic, extractDomainLogic } from "./logic";
import { recognizeGate, type GateMatch } from "./gates";

// ── Boolean expression AST ────────────────────────────────────────
//
// The Verilog emitter (`verilog.ts`) lowers this into named-leaf expressions.
// Leaves are cell-internal net ids. Populated only in later passes — Step 5
// of the current implementation does NOT derive `logic`.

export type BoolExpr =
  | { kind: "const"; value: 0 | 1 }
  | { kind: "net"; net: number }
  | { kind: "not"; arg: BoolExpr }
  | { kind: "and"; args: BoolExpr[] }
  | { kind: "or"; args: BoolExpr[] };

// ── Structural types ──────────────────────────────────────────────

export type DiffusionType = "p" | "n" | "unknown";

/** Compact reference to a layer-relative shape. Kept exported for downstream
 *  callers (e.g. UI) that prefer index lookups over string ids. */
export interface ShapeRef {
  layer: LayerType;
  index: number;
  label?: string;
}

/**
 * A shape after extraction processing. Includes:
 *   - User-drawn metal1/2, poly, contact, via1 shapes (`id` matches input).
 *   - Diffusion *sub-regions* produced by gate-splitting in step 1 (`id` is
 *     synthesised; `parentDiffId` points back to the original diffusion the
 *     UI drew). Original diffusion shapes are NOT in this list — they're
 *     accessed via `parentDiffId` against the input `CellType.layers`.
 *
 * `polygon` is a single outer ring in cell-local coordinates. Polygons with
 * holes (e.g. an annular sub-region) are currently not supported; the
 * splitter warns and skips the offending poly so this invariant holds.
 */
export interface ExtractedShape {
  id: string;
  layer: LayerType;
  polygon: Point[];
  /** Net id assigned in step 2. */
  netId: number;
  /** Diffusion sub-regions only: id of the original (user-drawn) diffusion
   *  this sub-region was cut from. */
  parentDiffId?: string;
  /** Pre-applied label on the user's shape (carries through to the net via
   *  step 2's propagation). On diffusion, a `vcc`/`gnd` label is the user's
   *  forced P/N override. */
  label?: ShapeLabel;
  /** Arbitrary user-supplied name for the net this shape lives on
   *  (e.g. "CLK", "Qbar"). Propagates to the net in step 2 the same
   *  way `label` does. */
  customName?: string;
  /** Diffusion sub-regions only: ids of the polys whose subtraction created
   *  this region's boundary. Drives transistor S/D-pad lookup in step 4. */
  adjacentPolys?: string[];
}

/** Diffusion type inference result, one per ORIGINAL (user-drawn) diffusion. */
export interface InferredDiffusion {
  /** Original diffusion shape id (i.e. `cellType.layers.diffusion[i].id`). */
  shapeId: string;
  type: DiffusionType;
  /** All `ExtractedShape.id`s with `parentDiffId === shapeId`. */
  subRegionIds: string[];
  /** True when the user pinned the type explicitly via `shape.label`. */
  forced: boolean;
}

/**
 * What this transistor is doing electrically. Assigned across the later
 * passes; mutually exclusive:
 *   - `dummy`   — source net == drain net (decap / antenna / well tap).
 *   - `unknown` — parent diffusion type couldn't be inferred.
 *   - `tg`      — paired with the opposite-type sibling into a TG (step 5).
 *   - `pun`     — PMOS member of a CMOS pull-up network (step 6).
 *   - `pdn`     — NMOS member of a pull-down network (step 6).
 *   - `pass`    — leftover: stand-alone switch (single-polarity pass,
 *                 orphan single-polarity cluster, etc.). Step 7.
 */
export type TransistorRole =
  | "dummy"
  | "unknown"
  | "tg"
  | "pun"
  | "pdn"
  | "pass";

/** One MOS transistor. Source/drain labelling is conventional — see step 4. */
export interface Transistor {
  id: string;
  type: "pmos" | "nmos" | "unknown";
  gate: { shapeId: string; netId: number };
  source: { shapeId: string; netId: number };
  drain: { shapeId: string; netId: number };
  /** Bounding box of the (poly ∩ diffusion) region in cell-local coords. */
  region: Rect;
  /** Assigned by steps 4-7. See `TransistorRole`. */
  role?: TransistorRole;
}

/**
 * One transmission gate — a PMOS+NMOS pair acting as a switch. Both halves
 * are still present in `transistors[]` (with `role: "tg"`); this entry
 * groups them and records the control wiring for downstream consumers.
 */
export interface TransmissionGate {
  id: string;
  pmosTransistorId: string;
  nmosTransistorId: string;
  /** The two nets at either end of the TG channel. When the TG is enabled
   *  these two nets carry the same logical signal — they are NOT
   *  complementary. The complementary pair is the two control gates below.
   *  Kept distinct here because the underlying transistors give us two
   *  separate net ids; downstream callers treat them as electrically
   *  equivalent during the on-state. Sorted ascending for determinism. */
  bridgedNetIds: [number, number];
  /** PMOS gate net. Active-low to open the TG. */
  controlPmosGateNetId: number;
  /** NMOS gate net. Active-high. Usually the inverted form of the PMOS
   *  gate net; we don't enforce that inside a single cell. */
  controlNmosGateNetId: number;
}

/**
 * One CMOS combinational gate — a coupled (pull-up, pull-down) pair. The
 * Boolean extraction pass (TODO) walks `pmosTransistorIds` from VCC to
 * `outputNetIds`, and `nmosTransistorIds` from GND to `outputNetIds`,
 * recovering the function from gate connectivity.
 */
export interface CmosDomain {
  id: string;
  /** Where PUN and PDN meet outside the rails. Normal cells: length 1.
   *  Length > 1 fires `MERGED_DOMAINS` — likely a layout or extraction bug. */
  outputNetIds: number[];
  pmosTransistorIds: string[];
  nmosTransistorIds: string[];
  /** Distinct gate nets driving any transistor in the domain. Some of these
   *  may be outputs of *other* domains in the cell (e.g. an internal inverter
   *  feeding a NAND); resolving that cross-domain wiring is a later pass. */
  inputNetIds: number[];
  /** Non-rail, non-output S/D nets inside either stack — the intermediate
   *  nodes of stacked transistors. Pre-computed so Boolean extraction
   *  doesn't have to rediscover them. */
  internalNetIds: number[];
  /** Boolean function of `outputNetIds[0]` in terms of the gate-net
   *  literals — populated by step 9 (`extractDomainLogic`). Undefined
   *  when the PUN/PDN couldn't be decomposed into a series-parallel
   *  tree (bridge / pass-transistor topologies). The expression is
   *  already simplified (constants folded, NOTs pushed to leaves, n-ary
   *  flattened, sorted+deduped children). */
  logic?: BoolExpr;
  /** Standard-cell label for `logic` — `inv` / `nand2` / `aoi21` / etc.
   *  Populated alongside `logic` by `recognizeGate`. `compound` means
   *  the boolean shape didn't fit a single library cell and would need
   *  to be drawn as a sub-tree of simpler gates. */
  gate?: GateMatch;
}

export type NetRole =
  | "vcc"
  | "gnd"
  | "input"
  | "output"
  | "internal"
  | "unused"
  | "io"
  /** Net sits on a TG/pass-transistor terminal and isn't an output of any
   *  domain in this cell. The cell routes the signal but doesn't drive it. */
  | "pass";

export interface ExtractedNet {
  id: number;
  /** Every `ExtractedShape.id` in this electrical component. */
  shapeIds: string[];
  /** Explicit label if any of this net's shapes carried one. */
  label?: ShapeLabel;
  /** Arbitrary user-supplied display name (e.g. "CLK", "Qbar"),
   *  inherited from any member shape's `customName`. Takes precedence
   *  over `label` for display purposes; doesn't affect classification. */
  customName?: string;
  role?: NetRole;
}

// ── Cell I/O ports ────────────────────────────────────────────────

/**
 * Physical layer a hitbox / wire connects on. `"unknown"` is a wildcard: it
 * matches any layer during hitbox↔wire resolution.
 */
export type ConnectingLayer = LayerType | "unknown";

/** Signal direction of a cell port. `"unknown"` is allowed and common for
 *  placeholder cells, or pins the user has not classified yet. */
export type PortDirection = "input" | "output" | "inout" | "unknown";

/**
 * One I/O port of a cell, derived from a `wire_hitbox` annotation. `netId`,
 * `layer`, and `direction` are populated by `resolvePorts` (step 8b) once net
 * roles are known; a port whose hitbox overlaps no connected geometry keeps
 * `netId` undefined. The Verilog emitter treats an undefined `netId` as
 * "not yet matched".
 */
export interface CellPort {
  name: string;
  layer: ConnectingLayer;
  shape: LayerShape;
  direction: PortDirection;
  netId?: number;
}

// ── Sequential structure ──────────────────────────────────────────

export interface SequentialAnalysis {
  netLabels: Map<number, string>;
  cellName?: string;
}

// ── Warnings ──────────────────────────────────────────────────────

export type WarningSeverity = "error" | "warning" | "info";

/**
 * A structured diagnostic. `code` is open-ended (see the SPEC_CODES list in
 * the module-level comment for the canonical set). `refs` gives the UI a
 * machine-readable way to highlight the offending shapes / nets / transistors;
 * `message` is the user-facing string.
 */
export interface ExtractionWarning {
  severity: WarningSeverity;
  code: string;
  message: string;
  refs?: {
    shapeIds?: string[];
    netIds?: number[];
    transistorIds?: string[];
  };
}

// ── Cell extraction (the output data structure) ───────────────────

interface CellExtractionBase {
  /** The `CellType.id` this extraction was produced from. Identifies the type
   *  uniquely, so the Verilog emitter can give each type its own module. */
  cellTypeId: string;
  /** The user-facing `CellType.name` (e.g. "DFF", "io_cell4"). Used as the
   *  base for the emitted module name; uniquified by the emitter. */
  cellTypeName: string;
  ports: CellPort[];
  warnings: ExtractionWarning[];
}

/** A fully reverse-engineered cell. */
export interface InferredCellExtraction extends CellExtractionBase {
  kind: "inferred";
  /** All non-hitbox shapes after splitting (originals + sub-regions). */
  shapes: ExtractedShape[];
  diffusions: InferredDiffusion[];
  transistors: Transistor[];
  nets: ExtractedNet[];
  /** PMOS+NMOS pairs acting as switches (step 5). */
  transmissionGates: TransmissionGate[];
  /** Standard CMOS combinational gates (step 6). */
  domains: CmosDomain[];
  /** Boolean function of the primary output, if combinational. (TODO.) */
  logic?: BoolExpr;
  /** Recognised standard-cell name (INV, NAND2, …). (TODO.) */
  cellName?: string;
  sequential?: SequentialAnalysis;
  // ── Analog extension (Phase 1) ──────────────────────────────
  /** Analog/mixed-signal devices in this cell (BJT, JFET, resistors, etc.) */
  analogDevices?: import("shared").AnalogDevice[];
}

/**
 * A cell the extractor could not (or should not) infer automatically. Only
 * the ports are modelled; the user implements the behaviour in a hand-written
 * Verilog module named `cellName`.
 */
export interface PlaceholderCellExtraction extends CellExtractionBase {
  kind: "placeholder";
  cellName: string;
}

export type CellExtraction = InferredCellExtraction | PlaceholderCellExtraction;

/** Narrowing helper: a combinational cell that can be inlined as an `assign`. */
export function isTrivialCell(
  ex: CellExtraction,
): ex is InferredCellExtraction {
  if (ex.kind !== "inferred") return false;
  if (!ex.logic) return false;
  if (ex.sequential?.cellName) return false;
  const outputs = ex.ports.filter((p) => p.direction === "output");
  return outputs.length === 1;
}

// ── Pipeline ──────────────────────────────────────────────────────

/** Areas below this (in cell-local units) are dismissed as numeric noise.
 *  Tuned to the precision Clipper rounds to (2 dp ⇒ sub-unit slivers). */
const MIN_AREA = 1.0;

/**
 * Run the structural extraction pipeline on one cell type. Requires Clipper2
 * to be loaded (`loadClipper()`); callers that batch many cells should load
 * it once first.
 *
 * Returns an `"inferred"` extraction even for empty/trivial cells — the
 * placeholder path is reserved for cells the caller has explicitly marked as
 * hand-written.
 */
export function extractCell(ct: CellType): CellExtraction {
  const warnings: ExtractionWarning[] = [];
  const ports = portsFromHitboxes(ct);

  const layers = ct.layers ?? {};
  const diffOrigs = layers.diffusion ?? [];
  const polys = layers.polysilicon ?? [];
  const metals1 = layers.metal1 ?? [];
  const metals2 = layers.metal2 ?? [];
  const contacts = layers.contact ?? [];
  const vias1 = layers.via1 ?? [];

  // ── Pre-flight: reject shapes that would poison Clipper ─────────
  const validate = (layer: LayerType, list: LayerShape[]) => {
    const out: LayerShape[] = [];
    for (const s of list) {
      const polygon = shapeToPolygon(s);
      if (polygon.length < 3) {
        warnings.push({
          severity: "error",
          code: "INVALID_SHAPE",
          message: `${layer} shape ${shortId(s.id)} has fewer than 3 vertices`,
          refs: { shapeIds: [s.id] },
        });
        continue;
      }
      const area = Math.abs(ringSignedArea(polygon));
      if (area < MIN_AREA) {
        warnings.push({
          severity: "error",
          code: "ZERO_AREA_SHAPE",
          message: `${layer} shape ${shortId(s.id)} has effectively zero area (${area.toFixed(3)})`,
          refs: { shapeIds: [s.id] },
        });
        continue;
      }
      out.push(s);
    }
    return out;
  };
  const dV = validate("diffusion", diffOrigs);
  const pV = validate("polysilicon", polys);
  const m1V = validate("metal1", metals1);
  const m2V = validate("metal2", metals2);
  const ctV = validate("contact", contacts);
  const v1V = validate("via1", vias1);

  // ── Step 1: split diffusion at poly crossings ───────────────────
  const split = splitDiffusionsAtGates(dV, pV, warnings);

  // ── Build the shape list that drives steps 2-5 ──────────────────
  //
  // Originals for everything except diffusion (which is represented by its
  // sub-regions). Order is stable: deterministic across runs given the same
  // input, so net ids and transistor ids are reproducible.
  const shapes: ExtractedShape[] = [];
  const pushOriginal = (layer: LayerType, list: LayerShape[]) => {
    for (const s of list) {
      shapes.push({
        id: s.id,
        layer,
        polygon: shapeToPolygon(s),
        netId: -1, // set in step 2
        label: s.label,
        customName: s.customName,
      });
    }
  };
  pushOriginal("metal1", m1V);
  pushOriginal("metal2", m2V);
  pushOriginal("polysilicon", pV);
  pushOriginal("contact", ctV);
  pushOriginal("via1", v1V);
  for (const sub of split.subRegions) shapes.push(sub); // diff sub-regions

  // Sort shapes by id for deterministic iteration in later steps.
  shapes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const shapeIndex = new Map<string, number>();
  shapes.forEach((s, i) => shapeIndex.set(s.id, i));

  // ── Step 2: connectivity → nets ─────────────────────────────────
  const nets = buildNets(shapes, shapeIndex, warnings);

  // ── Step 3: diffusion P/N type ──────────────────────────────────
  const diffusions = inferDiffusionTypes(
    dV,
    split.byParent,
    shapes,
    nets,
    warnings,
  );

  // ── Step 4: transistors ─────────────────────────────────────────
  const transistors = emitTransistors(
    dV,
    pV,
    split.byParent,
    diffusions,
    shapes,
    shapeIndex,
    nets,
    warnings,
  );

  // ── Step 5: detect transmission gates ───────────────────────────
  const transmissionGates = detectTransmissionGates(transistors, warnings);

  // ── Step 6: detect PUN/PDN domains ──────────────────────────────
  const domains = detectCmosDomains(transistors, nets, warnings);

  // ── Step 7: leftover live transistors → role: "pass" ────────────
  markPassTransistors(transistors);

  // ── Step 8: assign net roles (uses TG + domain info) ────────────
  classifyNets(nets, transistors, transmissionGates, domains, warnings);

  // ── Step 8b: resolve hitbox ports → nets + directions ───────────
  //
  // Needs the net roles step 8 just assigned (direction is derived from
  // role), so it runs here. After this, `ports[*].netId` / `.direction`
  // are populated, which is what lets the Verilog emitter inline trivial
  // cells and wire their inputs to the right die nets.
  resolvePorts(ports, shapes, nets, warnings);

  // ── Step 9: whole-cell sanity ───────────────────────────────────
  cellLevelChecks(nets, transistors, domains, warnings);

  // ── Step 10: per-domain boolean logic ───────────────────────────
  //
  // Walks each domain's PUN/PDN SP-trees into a `BoolExpr` and stores it
  // on `domain.logic`. We need rail nets (VCC/GND) identified, which
  // `classifyNets` above guarantees — so this runs after step 8.
  //
  // PUN vs ¬PDN dual-mismatch warnings get appended through to the
  // global list so the warnings section in the right panel surfaces
  // them next to MERGED_DOMAINS etc.
  const vccNet = nets.find((n) => n.role === "vcc" || n.label === "vcc");
  const gndNet = nets.find((n) => n.role === "gnd" || n.label === "gnd");
  if (vccNet && gndNet) {
    const tById = new Map(transistors.map((t) => [t.id, t]));
    for (const d of domains) {
      const r = extractDomainLogic(d, tById, vccNet.id, gndNet.id);
      d.logic = r.logic;
      // Map the boolean expression to a standard-cell label (NAND2,
      // AOI21, …) so the right panel + future logic schematic can read
      // it without re-running the matcher every render. Compound /
      // unrecognised shapes still get a `compound` entry so the UI can
      // distinguish "no logic" (undefined) from "logic but not in the
      // library" (compound).
      d.gate = d.logic ? recognizeGate(d.logic) : undefined;
      warnings.push(...r.warnings);
    }
  }

  // ── Step 11: chain per-domain logic → cell.logic ────────────────
  //
  // Substitutes inter-domain wires until the primary output's
  // expression is in terms of cell-input nets only. Bails on cycles
  // (sequential feedback) → leaves `logic` undefined, and
  // `isTrivialCell()` / the Verilog generator handle that by falling
  // back to module instantiation.
  //
  // We pick the primary output net via `role: "output"` (set in step 8)
  // rather than via `ports[*].netId`. Step 8b now resolves ports, but the
  // role-based path is independent of whether the user drew an output
  // hitbox, and works for any combinational cell whose output net got
  // classified — exactly the case we want to handle.
  let cellLogic: BoolExpr | undefined;
  const outputNets = nets.filter((n) => n.role === "output");
  if (outputNets.length === 1) {
    cellLogic = chainCellLogic(domains, outputNets[0].id) ?? undefined;
  }

  return {
    kind: "inferred",
    cellTypeId: ct.id,
    cellTypeName: ct.name,
    ports,
    shapes,
    diffusions,
    transistors,
    nets,
    transmissionGates,
    domains,
    logic: cellLogic,
    warnings,
  };
}

// ── Helpers (shared) ──────────────────────────────────────────────

/** First 6 chars of a UUID for log readability. Safe for IDs ≥ 6 chars; falls
 *  back to the whole string otherwise. */
function shortId(id: string): string {
  return id.length > 6 ? id.slice(0, 6) : id;
}

/** Build CellPort entries from wire_hitbox shapes. `netId`, `layer`, and
 *  `direction` are filled in later by `resolvePorts` (which needs the net
 *  roles from step 8); here they start as "not yet resolved". */
function portsFromHitboxes(ct: CellType): CellPort[] {
  const hitboxes = ct.layers?.wire_hitbox ?? [];
  return hitboxes.map((hitbox, i) => {
    const name = hitbox.label ?? `port_${i}`;
    return {
      name,
      layer: "unknown" as ConnectingLayer,
      shape: hitbox,
      direction: "unknown" as PortDirection,
    };
  });
}

/** Map a net's electrical role onto the I/O direction we expose for a port
 *  sitting on that net. Power rails come *into* the cell; `io` is a true
 *  bidirectional pad; anything we can't pin down (internal / pass / unused /
 *  unclassified) stays `"unknown"` so it is never mistaken for the cell's
 *  single driving output by `isTrivialCell`. */
function directionForRole(role: NetRole | undefined): PortDirection {
  switch (role) {
    case "output":
      return "output";
    case "input":
      return "input";
    case "io":
      return "inout";
    case "vcc":
    case "gnd":
      return "input";
    default:
      return "unknown";
  }
}

/**
 * Resolve each `wire_hitbox` port to the internal net it physically lands on,
 * then stamp `netId`, `layer`, and `direction`.
 *
 * A hitbox is a rectangle the user draws over the spot where the cell's I/O
 * touches a routing layer. We intersect it against every extracted shape
 * (metals / poly / contacts / vias / diffusion sub-regions — all carry a
 * `netId` after step 2) and accumulate the overlap *area* per net. The net
 * with the largest total overlap wins; its dominant shape's layer becomes the
 * port's connecting layer, and its role decides the port direction.
 *
 * Must run AFTER `classifyNets` (step 8): direction is derived from net role.
 *
 * Warnings:
 *   - `HITBOX_UNCONNECTED` — the hitbox covers no connected geometry (a port
 *     that will be left floating at the die level).
 *   - `HITBOX_MULTINET` — the hitbox straddles >1 net; we pick the
 *     largest-overlap net but flag the ambiguity.
 */
function resolvePorts(
  ports: CellPort[],
  shapes: ExtractedShape[],
  nets: ExtractedNet[],
  warnings: ExtractionWarning[],
): void {
  if (ports.length === 0) return;
  const netById = new Map(nets.map((n) => [n.id, n]));

  for (const port of ports) {
    const hitPoly = shapeToPolygon(port.shape);
    if (!polygonBounds(hitPoly)) continue; // degenerate hitbox

    // Total overlap area per net, plus the single largest contributing shape
    // per net (used to pick a representative connecting layer).
    const areaByNet = new Map<number, number>();
    const bestShape = new Map<number, { area: number; layer: LayerType }>();
    for (const shape of shapes) {
      if (shape.netId < 0) continue; // never assigned to a net
      // `polygonsOverlap` bounds-prunes before the Clipper boolean op.
      if (!polygonsOverlap(hitPoly, shape.polygon)) continue;
      const area = ringsAbsArea(polygonIntersection(hitPoly, shape.polygon));
      if (area <= 0) continue;
      areaByNet.set(shape.netId, (areaByNet.get(shape.netId) ?? 0) + area);
      const prev = bestShape.get(shape.netId);
      if (!prev || area > prev.area) {
        bestShape.set(shape.netId, { area, layer: shape.layer });
      }
    }

    if (areaByNet.size === 0) {
      warnings.push({
        severity: "warning",
        code: "HITBOX_UNCONNECTED",
        message: `port "${port.name}" hitbox does not overlap any connected shape — left unresolved`,
      });
      continue;
    }

    // Largest total overlap wins; tie-break on net id for determinism.
    const ranked = [...areaByNet.entries()].sort(
      (a, b) => b[1] - a[1] || a[0] - b[0],
    );
    const chosen = ranked[0][0];

    if (areaByNet.size > 1) {
      warnings.push({
        severity: "info",
        code: "HITBOX_MULTINET",
        message:
          `port "${port.name}" hitbox overlaps ${areaByNet.size} nets — ` +
          `assigned to net ${chosen} (largest overlap)`,
        refs: { netIds: ranked.map(([id]) => id) },
      });
    }

    port.netId = chosen;
    const layer = bestShape.get(chosen)?.layer;
    if (layer) port.layer = layer;
    port.direction = directionForRole(netById.get(chosen)?.role);
  }
}

// ── Step 1: split diffusion at poly crossings ─────────────────────

interface SplitResult {
  subRegions: ExtractedShape[];
  /** Original diffusion id → its sub-region ids (in deterministic order). */
  byParent: Map<string, string[]>;
}

/**
 * Iteratively subtract every poly that intersects each diffusion. Adjacency
 * between each resulting sub-region and the polys is computed AFTER the full
 * split is done — we deliberately don't track adjacency while cutting,
 * because the obvious "inherit the parent piece's polys plus the one that
 * just cut" rule is wrong: a piece born on the far side of the latest cut
 * has typically lost contact with the inherited polys. The post-pass uses a
 * geometric union test instead, which is exact for the rect-on-rect layouts
 * standard cells produce.
 *
 * Polys whose intersection with the diffusion would leave a hole (i.e. they
 * sit fully inside the diffusion, never touching its boundary) are skipped
 * with a warning. They're malformed in standard-cell layouts: a gate that
 * doesn't cut the diffusion isn't a transistor.
 */
function splitDiffusionsAtGates(
  diffOrigs: LayerShape[],
  polys: LayerShape[],
  warnings: ExtractionWarning[],
): SplitResult {
  const subRegions: ExtractedShape[] = [];
  const byParent = new Map<string, string[]>();

  // Pre-compute polygons / bounds so we don't re-shape them on every iter.
  const polyPolys = polys.map((p) => ({
    id: p.id,
    polygon: shapeToPolygon(p),
    bounds: polygonBounds(shapeToPolygon(p))!,
  }));

  for (const d of diffOrigs) {
    const dPoly = shapeToPolygon(d);
    const dBounds = polygonBounds(dPoly)!;
    let pieces: Point[][] = [dPoly];

    // Iterate polys in id order for deterministic sub-region ids.
    const candidates = polyPolys
      .filter((p) => rectsOverlap(p.bounds, dBounds))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    for (const p of candidates) {
      const next: Point[][] = [];
      for (const piece of pieces) {
        if (!polygonsOverlap(piece, p.polygon)) {
          next.push(piece);
          continue;
        }
        // Detect "poly fully inside this piece" — would create a hole.
        // Heuristic: if the difference returns a single ring with the *same*
        // bbox as the input piece, the subtraction left a hole instead of a
        // cut. Skip the poly with a warning so the algorithm's "no holes"
        // invariant holds downstream.
        const diff = polygonDifference(piece, [p.polygon]);
        if (looksLikeHoleSplit(diff, piece)) {
          warnings.push({
            severity: "warning",
            code: "POLY_INSIDE_DIFFUSION",
            message:
              `poly ${shortId(p.id)} sits fully inside diffusion ${shortId(d.id)} — ` +
              `would form a hole, skipped for splitting`,
            refs: { shapeIds: [p.id, d.id] },
          });
          next.push(piece);
          continue;
        }
        for (const ring of diff) {
          if (Math.abs(ringSignedArea(ring)) < MIN_AREA) continue;
          next.push(ring);
        }
      }
      pieces = next;
    }

    // Adjacency post-pass: a sub-region is adjacent to a poly iff they
    // share a boundary segment of nonzero length AND don't overlap in
    // area. We test by inflating the sub-region by `ADJ_EPSILON` units and
    // measuring the intersection area with the poly:
    //
    //   - Sharing a real edge of length L → intersection ≈ L × ε
    //     (>> ADJ_AREA_THRESHOLD even for short edges).
    //   - Truly disjoint (gap > ε) → intersection area = 0.
    //   - Overlapping in area → that's caught by the polygonsOverlap
    //     guard first (handles the rare POLY_INSIDE_DIFFUSION case where
    //     the cut was skipped, leaving the poly inside the piece).
    //
    // Why not a plain "union has 1 ring" test? Clipper rounds intermediate
    // vertices to `PRECISION` decimal places, so a sub-region carved by a
    // slanted poly edge can end up with vertices that differ from the
    // poly's by a tiny fraction of a unit — enough for the union to come
    // back as two separate rings even though the shapes should share an
    // edge. Inflating absorbs that mismatch.
    const ids: string[] = [];
    pieces.forEach((piece, i) => {
      const id = `${d.id}#${i}`;
      ids.push(id);
      const adjacent: string[] = [];
      const inflated = polygonInflate(piece, ADJ_EPSILON);
      for (const p of candidates) {
        // Skip polys that REALLY overlap this piece in area — that's
        // the POLY_INSIDE_DIFFUSION case where we deliberately didn't
        // cut, leaving the poly stuck inside; the piece's "adjacency"
        // to it isn't an edge but interior containment, and a
        // transistor wouldn't be well-defined.
        //
        // We use an area threshold (not the cheaper "any overlap" test)
        // because Clipper rounds difference results to PRECISION=2
        // (0.01-unit grid). When the original diffusion has non-axis-
        // aligned edges, the piece born from a cut can end up with a
        // sub-unit sliver poking into the cutting poly's area. A bare
        // "any overlap" guard would skip the adjacency check there and
        // silently lose every transistor on that cut. MIN_AREA cleanly
        // separates real interior containment (poly-area-sized) from
        // sub-precision slivers (<< 1 unit).
        const overlapArea = ringsAbsArea(
          polygonIntersection(piece, p.polygon),
        );
        if (overlapArea >= MIN_AREA) continue;
        if (inflated.length === 0) continue;
        const area = ringsAbsArea(polygonIntersection(inflated[0], p.polygon));
        if (area < ADJ_AREA_THRESHOLD) continue;
        adjacent.push(p.id);
      }
      subRegions.push({
        id,
        layer: "diffusion",
        polygon: piece,
        netId: -1,
        parentDiffId: d.id,
        label: d.label,
        customName: d.customName,
        adjacentPolys: adjacent.sort(),
      });
    });
    byParent.set(d.id, ids);
  }

  return { subRegions, byParent };
}

/** Half-unit offset for the adjacency inflate. Absorbs Clipper's sub-unit
 *  precision artefacts without bridging real gaps in the cell layout
 *  (standard cells keep features more than a couple of units apart). */
const ADJ_EPSILON = 1;
/** Minimum intersection-area for the inflated-piece-vs-poly test to count
 *  as adjacency. A shared edge of length L produces area ≈ L × ε, so any
 *  threshold smaller than ε itself accepts arbitrarily short edges (a
 *  single corner touch would still fall below since its area is 0). */
const ADJ_AREA_THRESHOLD = 0.5;

/** Cheap bbox-overlap (inclusive). Matches the convention used elsewhere. */
function rectsOverlap(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + b.width &&
    b.x <= a.x + a.width &&
    a.y <= b.y + b.height &&
    b.y <= a.y + a.height
  );
}

/**
 * Detect Clipper.Difference results that look like an annulus rather than a
 * clean cut. We don't have hole/outer-ring topology in `pathsDToRings`, so we
 * heuristically flag the case where the *single* outer-area ring's bounds
 * match the input piece's bounds and an inner negative-area ring exists.
 */
function looksLikeHoleSplit(rings: Point[][], piece: Point[]): boolean {
  if (rings.length < 2) return false;
  const pb = polygonBounds(piece);
  if (!pb) return false;
  let outers = 0;
  let inners = 0;
  let outerMatchesPiece = false;
  for (const r of rings) {
    const a = ringSignedArea(r);
    if (a > MIN_AREA) {
      outers++;
      const rb = polygonBounds(r);
      if (
        rb &&
        Math.abs(rb.x - pb.x) < 0.5 &&
        Math.abs(rb.y - pb.y) < 0.5 &&
        Math.abs(rb.width - pb.width) < 0.5 &&
        Math.abs(rb.height - pb.height) < 0.5
      ) {
        outerMatchesPiece = true;
      }
    } else if (a < -MIN_AREA) {
      inners++;
    }
  }
  return outers === 1 && inners >= 1 && outerMatchesPiece;
}

// ── Step 2: net connectivity ──────────────────────────────────────

/**
 * Union-find over every non-hitbox shape:
 *   - Same-layer: positive-area overlap (shared edges don't count, so the
 *     diffusion sub-regions stay split).
 *   - Contacts union every metal1 / poly / diffusion-sub-region they overlap.
 *   - via1 unions every metal1 / metal2 it overlaps.
 *   - Sub-regions of the same parent diffusion never merge directly.
 *
 * After grouping, each component becomes one `ExtractedNet`. Pre-applied
 * vcc/gnd/io labels on any shape propagate to the whole component; if two
 * incompatible labels collide we emit a SHORT error but still let the union
 * stand (so the user can see the offending connection in the UI).
 */
function buildNets(
  shapes: ExtractedShape[],
  shapeIndex: Map<string, number>,
  warnings: ExtractionWarning[],
): ExtractedNet[] {
  const n = shapes.length;
  const uf = new UnionFind(n);
  const bounds = shapes.map((s) => polygonBounds(s.polygon)!);

  // Same-layer merges. We bucket by layer for an O(B²) pass per bucket
  // instead of O(N²) overall — cell layers are small (tens of shapes), so a
  // bucketed sweep is fine and keeps the code obvious.
  const byLayer = new Map<LayerType, number[]>();
  shapes.forEach((s, i) => {
    let arr = byLayer.get(s.layer);
    if (!arr) {
      arr = [];
      byLayer.set(s.layer, arr);
    }
    arr.push(i);
  });

  for (const [, indices] of byLayer) {
    for (let i = 0; i < indices.length; i++) {
      for (let j = i + 1; j < indices.length; j++) {
        const ia = indices[i];
        const ib = indices[j];
        const a = shapes[ia];
        const b = shapes[ib];
        // Hard rule: two sub-regions of the same parent are NEVER merged,
        // even if Clipper somehow reports a positive intersection. Floating-
        // point edge cases shouldn't undo step 1's cuts.
        if (
          a.parentDiffId &&
          b.parentDiffId &&
          a.parentDiffId === b.parentDiffId
        ) {
          continue;
        }
        if (!rectsOverlap(bounds[ia], bounds[ib])) continue;
        if (!hasPositiveAreaOverlap(a.polygon, b.polygon)) continue;
        uf.union(ia, ib);
      }
    }
  }

  // Contacts bridge metal1 + poly + diffusion-sub-regions.
  const m1Indices = byLayer.get("metal1") ?? [];
  const polyIndices = byLayer.get("polysilicon") ?? [];
  const diffIndices = byLayer.get("diffusion") ?? [];
  const contactIndices = byLayer.get("contact") ?? [];
  for (const ci of contactIndices) {
    bridgeContact(
      ci,
      shapes,
      bounds,
      uf,
      m1Indices,
      polyIndices,
      diffIndices,
      warnings,
    );
  }
  // via1 bridges metal1 + metal2.
  const m2Indices = byLayer.get("metal2") ?? [];
  const via1Indices = byLayer.get("via1") ?? [];
  for (const vi of via1Indices) {
    bridgeVia(vi, shapes, bounds, uf, m1Indices, m2Indices, warnings);
  }

  // Component → net. Pick the lowest member index as the canonical "root"
  // for ID assignment; sort components so net ids are reproducible across
  // runs (UnionFind's `find` returns whichever root path-halving happened
  // to land on, which isn't stable across orderings).
  const componentsByRoot = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = uf.find(i);
    let arr = componentsByRoot.get(r);
    if (!arr) {
      arr = [];
      componentsByRoot.set(r, arr);
    }
    arr.push(i);
  }
  const components = Array.from(componentsByRoot.values()).sort(
    (a, b) => Math.min(...a) - Math.min(...b),
  );

  const nets: ExtractedNet[] = components.map((indices, netIdx) => {
    const shapeIds = indices.map((i) => shapes[i].id).sort();
    // Propagate label. SHORT on two incompatible labels in one component.
    //
    // Diffusion shapes are deliberately skipped here even if they carry a
    // legacy `label`. Diffusion uses the dedicated `forcedType` field for
    // P/N overrides — its `label` is only present on old data and would
    // otherwise be mis-propagated as a net role (the same bug that
    // motivated splitting the two concepts).
    let label: ShapeLabel | undefined;
    const seenLabels = new Set<ShapeLabel>();
    for (const i of indices) {
      if (shapes[i].layer === "diffusion") continue;
      const l = shapes[i].label;
      if (!l) continue;
      seenLabels.add(l);
      label ??= l;
    }
    if (seenLabels.size > 1) {
      warnings.push({
        severity: "error",
        code: "SHORT",
        message:
          `net contains conflicting rail labels: ${Array.from(seenLabels).join(", ")}`,
        refs: { netIds: [netIdx], shapeIds },
      });
    }
    // Custom name: first non-empty encountered (indices are already
    // sorted by the union-find traversal — see `componentsByRoot`
    // construction above — so the choice is deterministic). Diffusion
    // sub-regions DO contribute here (unlike `label`): a customName
    // on a diffusion expresses the user's intent for the net the
    // sub-region lives on, not a P/N override.
    let customName: string | undefined;
    for (const i of indices) {
      const c = shapes[i].customName;
      if (c && c.length > 0) {
        customName = c;
        break;
      }
    }
    return { id: netIdx, shapeIds, label, customName };
  });

  // Stamp netId on every shape and unused void shapeIndex (re-export to keep
  // the type-check happy — `shapeIndex` is consumed by caller).
  for (let netIdx = 0; netIdx < components.length; netIdx++) {
    for (const i of components[netIdx]) shapes[i].netId = netIdx;
  }
  void shapeIndex;

  // SPLIT_RAIL: a power rail (vcc/gnd) that lands on two disconnected
  // components is a real error — the rail should be a single net. We only
  // check the rails: the other label values legitimately appear on several
  // distinct nets. In particular `io` on two disconnected nets is the normal
  // shape of a bidirectional pad (separate in/out paths), and a cell can carry
  // several independent `input` / `output` signals — none of those are splits.
  const RAIL_LABELS: ReadonlySet<ShapeLabel> = new Set(["vcc", "gnd"]);
  const byLabel = new Map<ShapeLabel, number[]>();
  for (const net of nets) {
    if (!net.label || !RAIL_LABELS.has(net.label)) continue;
    let arr = byLabel.get(net.label);
    if (!arr) {
      arr = [];
      byLabel.set(net.label, arr);
    }
    arr.push(net.id);
  }
  for (const [label, netIds] of byLabel) {
    if (netIds.length > 1) {
      warnings.push({
        severity: "error",
        code: "SPLIT_RAIL",
        message: `rail "${label}" appears on ${netIds.length} disconnected nets`,
        refs: { netIds },
      });
    }
  }

  return nets;
}

/** Positive-area overlap test. `polygonsIntersect` already requires a
 *  result-paths-non-empty, which under FillRule.EvenOdd at PRECISION=2 is
 *  effectively the positive-area check we want — but we keep the wrapper
 *  named clearly because the *intent* matters at every call site. */
function hasPositiveAreaOverlap(a: Point[], b: Point[]): boolean {
  return polygonsIntersect(a, b);
}

/** Union a contact with every layer (m1 / poly / diff sub-region) it touches.
 *  Emits ORPHAN_CONTACT / INCOMPLETE_CONTACT / BUTTED_CONTACT diagnostics. */
function bridgeContact(
  ci: number,
  shapes: ExtractedShape[],
  bounds: Rect[],
  uf: UnionFind,
  m1: number[],
  poly: number[],
  diff: number[],
  warnings: ExtractionWarning[],
): void {
  const c = shapes[ci];
  // For each candidate layer, collect the indices we actually overlap.
  const overlap = (list: number[]) =>
    list.filter(
      (i) =>
        rectsOverlap(bounds[ci], bounds[i]) &&
        hasPositiveAreaOverlap(c.polygon, shapes[i].polygon),
    );
  const m1Hits = overlap(m1);
  const polyHits = overlap(poly);
  const diffHits = overlap(diff);

  // Detect "contact spans a gate cut" — covering two sub-regions of one
  // parent diffusion would short across a transistor we just split. Keep
  // only the larger-overlap sub-region and warn.
  if (diffHits.length > 1) {
    const sameParentBuckets = new Map<string, number[]>();
    for (const i of diffHits) {
      const pid = shapes[i].parentDiffId!;
      let arr = sameParentBuckets.get(pid);
      if (!arr) {
        arr = [];
        sameParentBuckets.set(pid, arr);
      }
      arr.push(i);
    }
    for (const [pid, idxs] of sameParentBuckets) {
      if (idxs.length < 2) continue;
      // Score by intersection area, keep the biggest.
      let bestIdx = idxs[0];
      let bestArea = -1;
      for (const i of idxs) {
        const area = ringsAbsArea(
          polygonIntersection(c.polygon, shapes[i].polygon),
        );
        if (area > bestArea) {
          bestArea = area;
          bestIdx = i;
        }
      }
      const dropped = idxs.filter((i) => i !== bestIdx);
      for (const d of dropped) {
        const at = diffHits.indexOf(d);
        if (at >= 0) diffHits.splice(at, 1);
      }
      warnings.push({
        severity: "warning",
        code: "CONTACT_SPANS_GATE",
        message:
          `contact ${shortId(c.id)} spans ${idxs.length} sub-regions of diffusion ${shortId(pid)} — ` +
          `keeping the largest-overlap pad`,
        refs: { shapeIds: [c.id, ...idxs.map((i) => shapes[i].id)] },
      });
    }
  }

  const total = m1Hits.length + polyHits.length + diffHits.length;
  if (total === 0) {
    warnings.push({
      severity: "warning",
      code: "ORPHAN_CONTACT",
      message: `contact ${shortId(c.id)} overlaps no metal1 / poly / diffusion`,
      refs: { shapeIds: [c.id] },
    });
    return;
  }
  if (total === 1) {
    warnings.push({
      severity: "warning",
      code: "INCOMPLETE_CONTACT",
      message: `contact ${shortId(c.id)} overlaps only one layer — makes no connection`,
      refs: { shapeIds: [c.id] },
    });
    // Still unify with itself (no-op) and return; nothing to bridge.
    return;
  }
  if (polyHits.length > 0 && diffHits.length > 0) {
    warnings.push({
      severity: "info",
      code: "BUTTED_CONTACT",
      message: `contact ${shortId(c.id)} bridges poly and diffusion directly`,
      refs: { shapeIds: [c.id] },
    });
  }
  for (const i of m1Hits) uf.union(ci, i);
  for (const i of polyHits) uf.union(ci, i);
  for (const i of diffHits) uf.union(ci, i);
}

/** Same shape as `bridgeContact`, but for via1 between metal layers. */
function bridgeVia(
  vi: number,
  shapes: ExtractedShape[],
  bounds: Rect[],
  uf: UnionFind,
  m1: number[],
  m2: number[],
  warnings: ExtractionWarning[],
): void {
  const v = shapes[vi];
  const overlap = (list: number[]) =>
    list.filter(
      (i) =>
        rectsOverlap(bounds[vi], bounds[i]) &&
        hasPositiveAreaOverlap(v.polygon, shapes[i].polygon),
    );
  const m1Hits = overlap(m1);
  const m2Hits = overlap(m2);
  const total = m1Hits.length + m2Hits.length;
  if (total === 0) {
    warnings.push({
      severity: "warning",
      code: "ORPHAN_CONTACT",
      message: `via1 ${shortId(v.id)} overlaps no metal layer`,
      refs: { shapeIds: [v.id] },
    });
    return;
  }
  if (total === 1) {
    warnings.push({
      severity: "warning",
      code: "INCOMPLETE_CONTACT",
      message: `via1 ${shortId(v.id)} overlaps only one metal layer`,
      refs: { shapeIds: [v.id] },
    });
    return;
  }
  for (const i of m1Hits) uf.union(vi, i);
  for (const i of m2Hits) uf.union(vi, i);
}

// ── Step 3: diffusion P/N type ────────────────────────────────────

/**
 * For each original diffusion, derive a P/N type from the rails its
 * sub-regions touch. Order:
 *   1. User-forced type via `shape.forcedType` (dedicated diffusion-only
 *      override) wins. Legacy `label === "vcc" / "gnd"` is accepted as a
 *      back-compat fallback — old data predates the dedicated field.
 *   2. Any sub-region in a `vcc` net → P; any in a `gnd` net → N.
 *   3. Both rails → conflict (CONFLICTING_DIFFUSION_TYPE), pick majority.
 *   4. Neither → UNKNOWN_DIFFUSION_TYPE.
 *
 * Junction sanity (P touching GND directly, N touching VCC) emits
 * WRONG_JUNCTION_* warnings.
 */
function inferDiffusionTypes(
  diffOrigs: LayerShape[],
  byParent: Map<string, string[]>,
  shapes: ExtractedShape[],
  nets: ExtractedNet[],
  warnings: ExtractionWarning[],
): InferredDiffusion[] {
  const shapeById = new Map(shapes.map((s) => [s.id, s]));
  const netById = new Map(nets.map((n) => [n.id, n]));
  const out: InferredDiffusion[] = [];

  for (const d of diffOrigs) {
    const subIds = byParent.get(d.id) ?? [];
    // User-forced? `forcedType` is the canonical field; legacy `label`
    // values stay supported so previously-saved cells don't regress until
    // the user touches them again (which migrates them to `forcedType`).
    let type: DiffusionType = "unknown";
    let forced = false;
    if (d.forcedType === "p") {
      type = "p";
      forced = true;
    } else if (d.forcedType === "n") {
      type = "n";
      forced = true;
    } else if (d.label === "vcc") {
      type = "p";
      forced = true;
    } else if (d.label === "gnd") {
      type = "n";
      forced = true;
    }

    if (!forced) {
      let vccHits = 0;
      let gndHits = 0;
      for (const sid of subIds) {
        const sub = shapeById.get(sid);
        if (!sub) continue;
        const net = netById.get(sub.netId);
        if (!net) continue;
        if (net.label === "vcc") vccHits++;
        else if (net.label === "gnd") gndHits++;
      }
      if (vccHits > 0 && gndHits > 0) {
        warnings.push({
          severity: "error",
          code: "CONFLICTING_DIFFUSION_TYPE",
          message:
            `diffusion ${shortId(d.id)} touches both VCC (${vccHits}) and GND (${gndHits}) — ` +
            `picking ${vccHits >= gndHits ? "P" : "N"}-type by majority`,
          refs: { shapeIds: [d.id, ...subIds] },
        });
        type = vccHits >= gndHits ? "p" : "n";
      } else if (vccHits > 0) {
        type = "p";
      } else if (gndHits > 0) {
        type = "n";
      }
      // No `UNKNOWN_DIFFUSION_TYPE` warning here — the island propagation
      // below may still resolve this diff's type by borrowing from an
      // overlapping sibling. The warning fires in the post-pass when a
      // diff really has no path to a type.
    }

    out.push({ shapeId: d.id, type, subRegionIds: subIds, forced });
  }

  // ── Island propagation ─────────────────────────────────────────
  //
  // Diffusion shapes that geometrically OVERLAP are physically one
  // continuous diffusion body — the user drew several rects to compose
  // an irregular shape. Net-level merging already handles the
  // connectivity (overlapping sub-regions union into one net in step 2),
  // but the per-diff type inference above is local: if member A's
  // sub-region happens to land in a rail-labelled net (so A → P/N) and
  // member B's sub-region only sees an internal/output net, B would be
  // tagged "unknown" even though A and B are the same body.
  //
  // Here we group diffs into "islands" via polygon overlap (union-find)
  // and propagate any known type across the island. Conflicting known
  // types in one island fire a hard error — the user has drawn rects
  // that overlap but want to be different doping types, which is
  // physically impossible.
  propagateIslandTypes(diffOrigs, out, warnings);

  // ── Final warnings (after island propagation) ──────────────────
  //
  // Junction sanity and "unknown type" both fire here so that island
  // propagation has had a chance to resolve the type first. A diff that
  // was unknown locally but inherited from a sibling shouldn't trigger
  // UNKNOWN_DIFFUSION_TYPE.
  for (const d of out) {
    if (d.type === "unknown") {
      warnings.push({
        severity: "warning",
        code: "UNKNOWN_DIFFUSION_TYPE",
        message: `diffusion ${shortId(d.shapeId)} has no rail connection — type unknown`,
        refs: { shapeIds: [d.shapeId, ...d.subRegionIds] },
      });
      continue;
    }
    // A diffusion no gate crosses (never split → a single sub-region)
    // can't be a transistor source/drain. Sitting on the "wrong" rail
    // it's a well / substrate tap (N+ on VDD, P+ on GND) — legitimate,
    // so the junction check doesn't apply.
    if (d.subRegionIds.length <= 1) continue;
    const wantRail = d.type === "p" ? "vcc" : "gnd";
    const wrongRail = d.type === "p" ? "gnd" : "vcc";
    for (const sid of d.subRegionIds) {
      const sub = shapeById.get(sid);
      if (!sub) continue;
      const net = netById.get(sub.netId);
      if (net?.label === wrongRail) {
        warnings.push({
          severity: "error",
          code: d.type === "p" ? "WRONG_JUNCTION_P_ON_GND" : "WRONG_JUNCTION_N_ON_VCC",
          message:
            `${d.type.toUpperCase()}-type diffusion ${shortId(d.shapeId)} ` +
            `(expected ${wantRail.toUpperCase()}) is connected to ${wrongRail.toUpperCase()}`,
          refs: { shapeIds: [d.shapeId, sid], netIds: [net.id] },
        });
      }
    }
  }
  return out;
}

/**
 * Union-find over `diffOrigs` based on polygon overlap, then for each
 * connected island, propagate the type from any known member to unknown
 * members. Single-member islands are no-ops. Conflicting types across an
 * island's known members fire a CONFLICTING_DIFFUSION_TYPE error and the
 * majority wins (ties: lexicographic shape-id of one of the conflicting
 * sources, deterministic).
 *
 * ── KNOWN LIMITATION (future work) ────────────────────────────────
 *
 * This is a POST-INFERENCE patch on top of the per-diff splitting; the
 * splitter still runs once per ORIGINAL user-drawn diffusion shape and
 * each transistor emission step iterates `(poly, originalDiff)` pairs.
 * That works correctly when the user composes a complex diffusion body
 * out of multiple overlapping rects and polys only cross ONE rect at a
 * time (the realistic case). It does NOT handle the case where a poly
 * crosses the *overlap region* shared by two diff rects:
 *
 *     ┌────────────┐
 *     │  diff A    │
 *     │       ┌────┼────────┐
 *     │       │ ▓▓ │ diff B │       ▓▓ = overlap region
 *     │       │ ▓▓ │        │       || = poly running vertically
 *     └───────┼─║──┘        │             through the overlap
 *             │ ║           │
 *             └─╫───────────┘
 *               ║
 *
 * Step 4 (`emitTransistors`) iterates `(poly, A)` AND `(poly, B)`. Both
 * pairs have positive-area intersection in the overlap → both emit a
 * transistor → ONE physical device becomes TWO transistors in the
 * netlist. PUN/PDN clustering still works (they end up in the same
 * cluster via shared S/D nets), but you'd see an extra parallel device
 * in the right panel and schematic.
 *
 * THE PROPER FIX is to pre-union overlapping diffs into geometric
 * "islands" BEFORE the splitter runs, so the splitter operates on the
 * island polygon (one shape, one set of sub-regions) rather than each
 * member independently. That refactor touches:
 *   - `splitDiffusionsAtGates` (input becomes islands, sub-regions point
 *     to island id)
 *   - `InferredDiffusion` shape (per-island, with `memberIds`)
 *   - `emitTransistors` (iterates `(poly, island)` pairs)
 *   - every UI consumer that does `sub.parentDiffId` → single user-shape
 *     fold (`SchematicCanvas`, `CellRECanvas`, `CellRERightPanel`'s
 *     `shapesToSelectionKeys`) — these would fold to ALL member shapes
 *     so hovering a sub-region lights up every member rectangle
 *
 * Deferred because: the duplicate-transistor case requires a poly to
 * specifically cross an overlap region, which doesn't show up in the
 * "compose a complex diffusion via overlapping rects" use pattern we've
 * seen so far. If a cell exhibits the bug, the symptom is visible (one
 * extra transistor per crossing) and that's the signal to do the
 * refactor.
 */
function propagateIslandTypes(
  diffOrigs: LayerShape[],
  diffusions: InferredDiffusion[],
  warnings: ExtractionWarning[],
): void {
  const n = diffOrigs.length;
  if (n < 2) return; // no possible islands of size 2+
  const polys = diffOrigs.map((d) => ({ id: d.id, polygon: shapeToPolygon(d) }));
  const uf = new UnionFind(n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (polygonsOverlap(polys[i].polygon, polys[j].polygon)) uf.union(i, j);
    }
  }
  const members = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = uf.find(i);
    let arr = members.get(r);
    if (!arr) {
      arr = [];
      members.set(r, arr);
    }
    arr.push(i);
  }
  const diffById = new Map(diffusions.map((d) => [d.shapeId, d]));
  for (const indices of members.values()) {
    if (indices.length < 2) continue;
    // Tally known types from members. Diffs forced by the user count
    // the same as inferred — both are "known".
    const votes = new Map<DiffusionType, number>();
    const knownMemberIds: string[] = [];
    for (const i of indices) {
      const d = diffById.get(diffOrigs[i].id);
      if (!d || d.type === "unknown") continue;
      votes.set(d.type, (votes.get(d.type) ?? 0) + 1);
      knownMemberIds.push(d.shapeId);
    }
    if (votes.size === 0) continue; // nobody in this island knows their type
    if (votes.size > 1) {
      const ids = indices.map((i) => diffOrigs[i].id);
      warnings.push({
        severity: "error",
        code: "CONFLICTING_DIFFUSION_TYPE",
        message:
          `overlapping diffusions [${ids.map((id) => shortId(id)).join(", ")}] have ` +
          `conflicting types — physical bodies can only be one of P or N`,
        refs: { shapeIds: ids },
      });
    }
    // Majority vote — ties resolved by sorted shape-id order so the
    // outcome is deterministic.
    const ranking = Array.from(votes.entries()).sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
    const winner = ranking[0][0];
    for (const i of indices) {
      const d = diffById.get(diffOrigs[i].id);
      if (!d || d.type !== "unknown") continue;
      d.type = winner;
      // `forced` stays false — the type is inferred via propagation, not
      // pinned by the user. Whoever opens the right panel will still see
      // a "propagated from sibling" view (no FORCED badge).
    }
  }
}

// ── Step 4: emit transistors ──────────────────────────────────────

/**
 * One transistor per intersection component of every (poly, diffusion) pair.
 * The intersection rings come from Clipper; we filter by `MIN_AREA` to drop
 * numerical slivers, and warn on MULTIPLE_INTERSECTIONS when a single poly
 * crosses a diffusion in more than one disjoint region.
 *
 * S/D pads are the parent diffusion's sub-regions that list this poly in
 * their `adjacentPolys`. With 0/1 we warn (MALFORMED_TRANSISTOR); with >2 we
 * warn (EXTRA_PADS) but still emit a transistor using the first two by id.
 */
function emitTransistors(
  diffOrigs: LayerShape[],
  polys: LayerShape[],
  byParent: Map<string, string[]>,
  diffusions: InferredDiffusion[],
  shapes: ExtractedShape[],
  shapeIndex: Map<string, number>,
  nets: ExtractedNet[],
  warnings: ExtractionWarning[],
): Transistor[] {
  void shapeIndex;
  const shapeById = new Map(shapes.map((s) => [s.id, s]));
  const netById = new Map(nets.map((n) => [n.id, n]));
  const diffType = new Map(diffusions.map((d) => [d.shapeId, d.type]));
  const polyById = new Map(polys.map((p) => [p.id, shapeToPolygon(p)]));
  const transistors: Transistor[] = [];

  // Deterministic order: diff id then poly id.
  const dSorted = diffOrigs.slice().sort((a, b) => (a.id < b.id ? -1 : 1));
  const pSorted = polys.slice().sort((a, b) => (a.id < b.id ? -1 : 1));

  for (const d of dSorted) {
    const dPoly = shapeToPolygon(d);
    const dBounds = polygonBounds(dPoly)!;
    const subIds = byParent.get(d.id) ?? [];
    for (const p of pSorted) {
      const pPoly = polyById.get(p.id)!;
      const pBounds = polygonBounds(pPoly)!;
      if (!rectsOverlap(dBounds, pBounds)) continue;
      const components = polygonIntersection(dPoly, pPoly).filter(
        (r) => Math.abs(ringSignedArea(r)) >= MIN_AREA,
      );
      if (components.length === 0) {
        // Bbox hit but zero geometric overlap (touching corners, etc.) — skip
        // silently; not a TINY_INTERSECTION because the area was literally 0.
        continue;
      }
      if (components.length > 1) {
        // Routine for non-rectangular diffusion shapes — a single
        // gate can legitimately cross an L / T / U-shaped body in
        // multiple places and we emit one transistor per channel. The
        // per-component pad adjacency below picks the right S/D pads
        // for each. We still surface it as info so the user can spot
        // unintended cases (e.g. an accidentally crossing routing
        // poly).
        warnings.push({
          severity: "info",
          code: "MULTIPLE_INTERSECTIONS",
          message:
            `poly ${shortId(p.id)} crosses diffusion ${shortId(d.id)} in ${components.length} disjoint regions — emitted as ${components.length} transistors`,
          refs: { shapeIds: [p.id, d.id] },
        });
      }
      // Per-poly candidate pad set: sub-regions of this diffusion that
      // are adjacent to this poly *somewhere* (step 1's invariant). For
      // a poly with a single channel, this IS the final pad list — two
      // pieces on either side of the gate. For a poly with multiple
      // channels (the MULTIPLE_INTERSECTIONS case), we narrow further
      // per-component below; otherwise every component would see all
      // pads of the diffusion and trip EXTRA_PADS.
      const candidatePads = subIds
        .map((sid) => shapeById.get(sid))
        .filter((s): s is ExtractedShape => !!s && (s.adjacentPolys ?? []).includes(p.id));

      for (const c of components) {
        const region = polygonBounds(c)!;
        const polyNet = shapes[shapeIndexBy(shapes, p.id)]?.netId ?? -1;
        if (polyNet < 0) {
          warnings.push({
            severity: "warning",
            code: "NO_GATE_NET",
            message: `poly ${shortId(p.id)} has no resolved net — gate floating`,
            refs: { shapeIds: [p.id] },
          });
        }

        // Narrow `candidatePads` to the pads adjacent to THIS specific
        // channel (component), using the same inflate-then-intersect
        // adjacency test step 1 uses for the per-poly list. For
        // single-component polys this is a no-op shortcut: all
        // candidates pass since each one was already verified adjacent
        // to the only channel.
        const pads = components.length === 1
          ? candidatePads.slice().sort((a, b) => (a.id < b.id ? -1 : 1))
          : padsAdjacentToComponent(candidatePads, c).sort((a, b) => (a.id < b.id ? -1 : 1));

        if (pads.length < 2) {
          warnings.push({
            severity: "warning",
            code: "MALFORMED_TRANSISTOR",
            message:
              `transistor at poly ${shortId(p.id)} / diffusion ${shortId(d.id)} ` +
              `has ${pads.length} S/D pads — skipped`,
            refs: { shapeIds: [p.id, d.id, ...pads.map((s) => s.id)] },
          });
          continue;
        }
        if (pads.length > 2) {
          warnings.push({
            severity: "warning",
            code: "EXTRA_PADS",
            message:
              `transistor at poly ${shortId(p.id)} / diffusion ${shortId(d.id)} ` +
              `has ${pads.length} S/D pads — using first two by id`,
            refs: { shapeIds: [p.id, d.id, ...pads.map((s) => s.id)] },
          });
        }

        const dType = diffType.get(d.id) ?? "unknown";
        const type: Transistor["type"] =
          dType === "p" ? "pmos" : dType === "n" ? "nmos" : "unknown";
        if (type === "unknown") {
          warnings.push({
            severity: "warning",
            code: "UNKNOWN_TYPE_TRANSISTOR",
            message:
              `transistor at poly ${shortId(p.id)} / diffusion ${shortId(d.id)} ` +
              `has unknown type (parent diffusion type couldn't be inferred)`,
            refs: { shapeIds: [p.id, d.id] },
          });
        }

        const [padA, padB] = pickSourceDrain(type, pads, netById);
        const tId = `t:${d.id}/${p.id}#${transistors.length}`;
        // Locked-in roles for transistors that are NOT candidates for the
        // later TG / PUN / PDN / pass classification: dummies are always
        // dummies, and "unknown" type means we couldn't decide P/N so we
        // can't reason further about its role either.
        let role: TransistorRole | undefined;
        if (type === "unknown") {
          role = "unknown";
        } else if (padA.netId === padB.netId) {
          role = "dummy";
          warnings.push({
            severity: "info",
            code: "DUMMY_TRANSISTOR",
            message: `transistor ${shortId(tId)} has source and drain on the same net`,
            refs: {
              shapeIds: [p.id, d.id, padA.id, padB.id],
              netIds: [padA.netId],
              transistorIds: [tId],
            },
          });
        }
        // Rail-to-rail (S=VCC, D=GND or vice versa) is essentially never
        // legitimate in a standard cell — ESD devices live in the I/O ring.
        // Detect once we know the pad net labels; emit even on dummies as a
        // belt-and-braces check.
        const aLabel = netById.get(padA.netId)?.label;
        const bLabel = netById.get(padB.netId)?.label;
        if (
          (aLabel === "vcc" && bLabel === "gnd") ||
          (aLabel === "gnd" && bLabel === "vcc")
        ) {
          warnings.push({
            severity: "warning",
            code: "RAIL_TO_RAIL_TRANSISTOR",
            message: `transistor ${shortId(tId)} bridges VCC and GND directly`,
            refs: {
              shapeIds: [p.id, d.id],
              netIds: [padA.netId, padB.netId],
              transistorIds: [tId],
            },
          });
        }
        transistors.push({
          id: tId,
          type,
          gate: { shapeId: p.id, netId: polyNet },
          source: { shapeId: padA.id, netId: padA.netId },
          drain: { shapeId: padB.id, netId: padB.netId },
          region,
          role,
        });
      }
    }
  }
  return transistors;
}

/**
 * Filter `candidates` to those S/D sub-regions that actually border the
 * given intersection component (the rectangular channel where the gate
 * crosses the diffusion). Same geometric trick step 1 uses for the
 * per-poly adjacency: inflate the channel by `ADJ_EPSILON`, intersect
 * with each candidate, keep those whose overlap area clears the
 * threshold. Picks exactly the two pieces touching this specific
 * channel even when other pieces of the same diffusion touch the same
 * gate elsewhere (the multi-component case).
 */
function padsAdjacentToComponent(
  candidates: ExtractedShape[],
  component: Point[],
): ExtractedShape[] {
  const inflated = polygonInflate(component, ADJ_EPSILON);
  if (inflated.length === 0) return [];
  const channel = inflated[0];
  const channelBounds = polygonBounds(channel);
  if (!channelBounds) return [];
  const out: ExtractedShape[] = [];
  for (const sub of candidates) {
    const padBounds = polygonBounds(sub.polygon);
    if (!padBounds || !rectsOverlap(channelBounds, padBounds)) continue;
    const area = ringsAbsArea(polygonIntersection(channel, sub.polygon));
    if (area < ADJ_AREA_THRESHOLD) continue;
    out.push(sub);
  }
  return out;
}

/** Pick which adjacent sub-region is `source` and which is `drain`. The rule
 *  is conventional — for inner-stack or pass transistors there's no ground
 *  truth and downstream consumers must treat the labels symmetrically. */
function pickSourceDrain(
  type: Transistor["type"],
  pads: ExtractedShape[],
  netById: Map<number, ExtractedNet>,
): [ExtractedShape, ExtractedShape] {
  // We only look at the first two by id when there are extras; the warning
  // is logged at the caller.
  const sorted = pads.slice(0, 2);
  const [a, b] = sorted;
  const rail = type === "pmos" ? "vcc" : type === "nmos" ? "gnd" : null;
  if (rail) {
    const aLabel = netById.get(a.netId)?.label;
    const bLabel = netById.get(b.netId)?.label;
    if (aLabel === rail && bLabel !== rail) return [a, b];
    if (bLabel === rail && aLabel !== rail) return [b, a];
  }
  // Tie-break: lower shape id is `source`. Deterministic and irrelevant for
  // electrical correctness.
  return a.id <= b.id ? [a, b] : [b, a];
}

/** Linear shape-id → index lookup. We avoid recomputing the full map per
 *  transistor by keeping the indexed shapes list in scope, but for the
 *  rare gate-net lookup the simple scan is fine and keeps the call site
 *  obvious. */
function shapeIndexBy(shapes: ExtractedShape[], id: string): number {
  for (let i = 0; i < shapes.length; i++) if (shapes[i].id === id) return i;
  return -1;
}

// ── Step 5: detect transmission gates ─────────────────────────────

/**
 * A TG is a PMOS+NMOS pair where:
 *   - The two transistors' (source, drain) net sets are equal (i.e. they
 *     bridge the same two nets), AND
 *   - Their gate nets differ (excludes "parallel P+N for drive strength"
 *     where both gates are tied to the same enable).
 *
 * Greedy first-match in (pmos.id, nmos.id) order — deterministic. Each
 * transistor can only belong to one TG.
 *
 * Near-misses (same S/D bridge but matching gates) get an `UNPAIRED_TG_HALF`
 * info — typically a hint that the user shorted what should be EN / EN_N.
 */
function detectTransmissionGates(
  transistors: Transistor[],
  warnings: ExtractionWarning[],
): TransmissionGate[] {
  const live = transistors.filter((t) => t.role === undefined && t.type !== "unknown");
  const pmos = live.filter((t) => t.type === "pmos").sort(byId);
  const nmos = live.filter((t) => t.type === "nmos").sort(byId);
  const tgs: TransmissionGate[] = [];
  const used = new Set<string>();

  for (const p of pmos) {
    if (used.has(p.id)) continue;
    const pPair = sortedPair(p.source.netId, p.drain.netId);
    for (const n of nmos) {
      if (used.has(n.id)) continue;
      const nPair = sortedPair(n.source.netId, n.drain.netId);
      if (pPair[0] !== nPair[0] || pPair[1] !== nPair[1]) continue;
      if (p.gate.netId === n.gate.netId) {
        // Same bridge, same control — drive strength, not a TG. Emit one
        // warning per near-miss pair, not per p × n.
        warnings.push({
          severity: "info",
          code: "UNPAIRED_TG_HALF",
          message:
            `PMOS ${shortId(p.id)} + NMOS ${shortId(n.id)} bridge the same nets ` +
            `but share a gate — looks like parallel drive, not a TG`,
          refs: { transistorIds: [p.id, n.id] },
        });
        continue;
      }
      const tgId = `tg:${p.id}+${n.id}`;
      tgs.push({
        id: tgId,
        pmosTransistorId: p.id,
        nmosTransistorId: n.id,
        bridgedNetIds: pPair,
        controlPmosGateNetId: p.gate.netId,
        controlNmosGateNetId: n.gate.netId,
      });
      p.role = "tg";
      n.role = "tg";
      used.add(p.id);
      used.add(n.id);
      break;
    }
  }
  return tgs;
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function sortedPair(a: number, b: number): [number, number] {
  return a <= b ? [a, b] : [b, a];
}

// ── Step 6: detect CMOS PUN/PDN domains ──────────────────────────

/**
 * Build pull-up / pull-down networks via union-find over same-polarity
 * transistors sharing a non-rail S/D net. A cluster anchored to VCC (any
 * member has S or D on a VCC-labelled net) is a PUN; anchored to GND is a
 * PDN. Each (PUN, PDN) pair whose net sets intersect outside the rails
 * becomes a `CmosDomain`.
 *
 * Transistors with role already set (dummy / unknown / tg) are excluded —
 * step 2's TG pass runs first by design so its members never get pulled
 * into PUN/PDN.
 */
function detectCmosDomains(
  transistors: Transistor[],
  nets: ExtractedNet[],
  warnings: ExtractionWarning[],
): CmosDomain[] {
  const vccNetIds = new Set(nets.filter((n) => n.label === "vcc").map((n) => n.id));
  const gndNetIds = new Set(nets.filter((n) => n.label === "gnd").map((n) => n.id));
  const isRail = (netId: number) => vccNetIds.has(netId) || gndNetIds.has(netId);

  const pmos = transistors.filter(
    (t) => t.role === undefined && t.type === "pmos",
  );
  const nmos = transistors.filter(
    (t) => t.role === undefined && t.type === "nmos",
  );

  // Union-find over same-polarity transistors connected via shared non-rail
  // S/D nets. Indexing-by-id keeps the iteration stable.
  const pmosClusters = clusterBySharedSD(pmos, isRail);
  const nmosClusters = clusterBySharedSD(nmos, isRail);

  // Anchor & non-rail S/D net inventory per cluster.
  const annotate = (
    cluster: Transistor[],
    railSet: Set<number>,
  ): {
    transistors: Transistor[];
    nets: Set<number>; // non-rail S/D nets the cluster touches
    anchored: boolean; // any member has S/D on the rail
  } => {
    const netsSet = new Set<number>();
    let anchored = false;
    for (const t of cluster) {
      for (const n of [t.source.netId, t.drain.netId]) {
        if (railSet.has(n)) anchored = true;
        else netsSet.add(n);
      }
    }
    return { transistors: cluster, nets: netsSet, anchored };
  };

  const puns = pmosClusters.map((c) => annotate(c, vccNetIds));
  const pdns = nmosClusters.map((c) => annotate(c, gndNetIds));

  // Orphan single-polarity clusters that fail the anchor test fall through
  // to step 7 as "pass" transistors. We only warn here for the case where
  // a cluster IS anchored but no PDN/PUN counterpart shares its outputs —
  // that's the "open-drain" / "open-source" shape and worth flagging.
  // Sets used below.

  const domains: CmosDomain[] = [];
  const claimedPmos = new Set<string>();
  const claimedNmos = new Set<string>();

  // Pair each anchored PUN with each anchored PDN it shares a non-rail
  // net with. A single PUN can spawn multiple domains (one per PDN
  // partner) and vice versa — uncommon in real cells but topologically
  // honest.
  for (const pun of puns) {
    if (!pun.anchored) continue;
    for (const pdn of pdns) {
      if (!pdn.anchored) continue;
      const shared: number[] = [];
      for (const n of pun.nets) if (pdn.nets.has(n)) shared.push(n);
      if (shared.length === 0) continue;

      const sharedSorted = shared.slice().sort((a, b) => a - b);
      if (sharedSorted.length > 1) {
        warnings.push({
          severity: "warning",
          code: "MERGED_DOMAINS",
          message:
            `PUN ${puns.indexOf(pun)} and PDN ${pdns.indexOf(pdn)} share ${shared.length} non-rail nets — ` +
            `expected exactly one output`,
          refs: { netIds: sharedSorted },
        });
      }

      // Inputs: distinct gate nets driving any transistor in the domain.
      const inputNetIds = new Set<number>();
      for (const t of [...pun.transistors, ...pdn.transistors]) {
        inputNetIds.add(t.gate.netId);
      }
      // Strip output nets from inputs (a transistor whose gate net is also
      // the domain's output is a self-feedback — uncommon but possible;
      // we keep it for the boolean pass to flag.)
      // We deliberately do NOT strip — keeping the literal "what gate
      // nets are present" makes downstream reasoning easier.

      // Internal stack nets = the non-shared S/D nets in either cluster.
      const internalNetIds = new Set<number>();
      for (const n of pun.nets) if (!sharedSorted.includes(n)) internalNetIds.add(n);
      for (const n of pdn.nets) if (!sharedSorted.includes(n)) internalNetIds.add(n);

      const pmosIds = pun.transistors.map((t) => t.id).sort();
      const nmosIds = pdn.transistors.map((t) => t.id).sort();
      const domain: CmosDomain = {
        id: `dom:${sharedSorted.join(",")}`,
        outputNetIds: sharedSorted,
        pmosTransistorIds: pmosIds,
        nmosTransistorIds: nmosIds,
        inputNetIds: Array.from(inputNetIds).sort((a, b) => a - b),
        internalNetIds: Array.from(internalNetIds).sort((a, b) => a - b),
      };
      domains.push(domain);
      for (const id of pmosIds) claimedPmos.add(id);
      for (const id of nmosIds) claimedNmos.add(id);
    }
  }

  // Assign role to claimed transistors. Anything else (anchored cluster
  // with no PDN/PUN partner, or unanchored cluster) is intentionally left
  // unset so step 7 can sweep them into "pass" with no special-casing.
  for (const t of pmos) if (claimedPmos.has(t.id)) t.role = "pun";
  for (const t of nmos) if (claimedNmos.has(t.id)) t.role = "pdn";

  // Orphan-cluster warnings. We only flag clusters that ARE anchored but
  // never found a counterpart — un-anchored clusters are just pass-network
  // material and don't warrant a structural warning.
  for (const pun of puns) {
    if (!pun.anchored) continue;
    if (pun.transistors.every((t) => claimedPmos.has(t.id))) continue;
    warnings.push({
      severity: "warning",
      code: "ISOLATED_PMOS_CLUSTER",
      message:
        `PMOS cluster anchored to VCC has no PDN counterpart sharing an output net ` +
        `(transistors: ${pun.transistors.map((t) => shortId(t.id)).join(", ")})`,
      refs: { transistorIds: pun.transistors.map((t) => t.id) },
    });
  }
  for (const pdn of pdns) {
    if (!pdn.anchored) continue;
    if (pdn.transistors.every((t) => claimedNmos.has(t.id))) continue;
    warnings.push({
      severity: "warning",
      code: "ISOLATED_NMOS_CLUSTER",
      message:
        `NMOS cluster anchored to GND has no PUN counterpart sharing an output net ` +
        `(transistors: ${pdn.transistors.map((t) => shortId(t.id)).join(", ")})`,
      refs: { transistorIds: pdn.transistors.map((t) => t.id) },
    });
  }

  return domains;
}

/**
 * Cluster a list of same-polarity transistors via union-find over their
 * non-rail S/D nets. Two transistors land in the same cluster iff they
 * share at least one non-rail S or D net. Rails (VCC/GND) are terminators
 * — never edges — so distinct gates with the same rail polarity don't
 * collapse into a single cluster through the rail.
 */
function clusterBySharedSD(
  list: Transistor[],
  isRail: (netId: number) => boolean,
): Transistor[][] {
  const n = list.length;
  if (n === 0) return [];
  const uf = new UnionFind(n);
  // For each non-rail net, union every transistor that touches it via S/D.
  const byNet = new Map<number, number[]>();
  list.forEach((t, i) => {
    for (const net of [t.source.netId, t.drain.netId]) {
      if (isRail(net)) continue;
      let arr = byNet.get(net);
      if (!arr) {
        arr = [];
        byNet.set(net, arr);
      }
      arr.push(i);
    }
  });
  for (const idxs of byNet.values()) {
    for (let i = 1; i < idxs.length; i++) uf.union(idxs[0], idxs[i]);
  }
  const componentsByRoot = new Map<number, Transistor[]>();
  for (let i = 0; i < n; i++) {
    const r = uf.find(i);
    let arr = componentsByRoot.get(r);
    if (!arr) {
      arr = [];
      componentsByRoot.set(r, arr);
    }
    arr.push(list[i]);
  }
  // Stable ordering: lowest-id member first within a cluster, clusters
  // sorted by their lowest member's id.
  return Array.from(componentsByRoot.values())
    .map((c) => c.slice().sort(byId))
    .sort((a, b) => byId(a[0], b[0]));
}

// ── Step 7: tag leftover transistors as `pass` ────────────────────

/**
 * Any transistor still without a role at this point is a single-polarity
 * stand-alone switch (or a member of an orphan single-polarity cluster).
 * Tag as `pass`. Dummies and unknowns were tagged in step 4; PUN/PDN/TG
 * members were tagged in steps 5/6 — leaving these as the only undecided
 * survivors.
 */
function markPassTransistors(transistors: Transistor[]): void {
  for (const t of transistors) {
    if (t.role === undefined) t.role = "pass";
  }
}

// ── Step 8: classify nets (uses TG + domain info) ─────────────────

/**
 * Assigns `role` on every net. Priority:
 *   1. Explicit label (`vcc` / `gnd` / `io`) — wins outright.
 *   2. Domain output that does NOT also drive any gate inside the cell
 *      → `output` (a primary output, externally visible).
 *   3. Domain output that DOES drive at least one gate elsewhere in the
 *      cell → `internal` (an intermediate pipeline net — e.g. the
 *      NOR2's output in a NOR2+INV = OR2 cell). Without this split,
 *      every multi-stage combinational cell would have N "output" nets
 *      instead of 1, and `chainCellLogic`'s "exactly one output" guard
 *      would never fire.
 *   4. Sits on a TG / pass-transistor S/D terminal (and not already an
 *      output) → `pass`.
 *   5. Only drives gates → `input`.
 *   6. Touches gates AND S/D but not as an output → `internal`.
 *   7. Nothing → `unused`.
 *
 * Orphan-rail diagnostics (`ORPHAN_VCC` / `ORPHAN_GND`) live here because
 * they need the per-net SD tally we're already computing.
 */
function classifyNets(
  nets: ExtractedNet[],
  transistors: Transistor[],
  transmissionGates: TransmissionGate[],
  domains: CmosDomain[],
  warnings: ExtractionWarning[],
): void {
  const tally = new Map<
    number,
    {
      /** Drives the gate of at least one REAL (non-dummy, typed)
       *  transistor. Dummies don't count — a poly that only gates a
       *  dummy carries no signal and the net is effectively unused. */
      gate: boolean;
      pmosSD: boolean;
      nmosSD: boolean;
    }
  >();
  for (const n of nets) {
    tally.set(n.id, { gate: false, pmosSD: false, nmosSD: false });
  }
  for (const t of transistors) {
    // Gate-tally excludes dummies + unknowns: their gate net isn't
    // really driving anything (dummies short S=D, unknowns have no
    // known type). Without this exclusion, a poly shape that only
    // gates a dummy would be classified as `input` even though it
    // does nothing — and the netlist view would show a useless
    // floating input pin.
    if (t.role !== "dummy" && t.role !== "unknown") {
      const g = tally.get(t.gate.netId);
      if (g) g.gate = true;
    }
    // S/D tally is unconditional — dummies still electrically tie
    // their S and D together (typically to VCC or GND) so those
    // connections matter for net classification (e.g. `ORPHAN_VCC`).
    if (t.type === "pmos") {
      const s = tally.get(t.source.netId);
      const d = tally.get(t.drain.netId);
      if (s) s.pmosSD = true;
      if (d) d.pmosSD = true;
    } else if (t.type === "nmos") {
      const s = tally.get(t.source.netId);
      const d = tally.get(t.drain.netId);
      if (s) s.nmosSD = true;
      if (d) d.nmosSD = true;
    }
  }

  // Pre-compute "is this net a domain output?" and "is this net a
  // TG/pass-transistor terminal?". Domain output trumps pass.
  const outputNets = new Set<number>();
  for (const d of domains) for (const n of d.outputNetIds) outputNets.add(n);
  const passNets = new Set<number>();
  for (const tg of transmissionGates) {
    passNets.add(tg.bridgedNetIds[0]);
    passNets.add(tg.bridgedNetIds[1]);
  }
  for (const t of transistors) {
    if (t.role !== "pass") continue;
    passNets.add(t.source.netId);
    passNets.add(t.drain.netId);
  }

  for (const net of nets) {
    // Explicit label always wins. The set of valid `ShapeLabel` values is
    // a strict subset of `NetRole`, so we can assign directly. This is how
    // the user forces a net to a specific role (vcc/gnd/io/input/output)
    // when the structural inference would otherwise mis-classify it.
    if (net.label) {
      net.role = net.label;
      continue;
    }
    const t = tally.get(net.id)!;
    if (outputNets.has(net.id)) {
      // A domain output is the cell's primary output only if it doesn't
      // also drive a gate further down the chain. NOR2 → INV's mid-net
      // hits this: it's the NOR2's output AND the INV's gate input, so
      // it's a pipeline node, not what the cell exposes to the world.
      net.role = t.gate ? "internal" : "output";
      continue;
    }
    if (passNets.has(net.id)) {
      net.role = "pass";
      continue;
    }
    if (t.gate && !t.pmosSD && !t.nmosSD) net.role = "input";
    else if (!t.gate && !t.pmosSD && !t.nmosSD) net.role = "unused";
    else net.role = "internal";
  }

  // A rail with no matching source/drain is only suspicious in a cell
  // that actually has rail-anchored logic. A pass-gate-only cell
  // (transmission gate, analog switch) has no CMOS domain at all — its
  // rails just feed the well/substrate taps — so there is nothing to
  // enforce there.
  if (domains.length === 0) return;
  for (const net of nets) {
    const t = tally.get(net.id)!;
    if (net.label === "vcc" && !t.pmosSD) {
      warnings.push({
        severity: "error",
        code: "ORPHAN_VCC",
        message: `VCC net ${net.id} has no PMOS source/drain attached`,
        refs: { netIds: [net.id] },
      });
    }
    if (net.label === "gnd" && !t.nmosSD) {
      warnings.push({
        severity: "error",
        code: "ORPHAN_GND",
        message: `GND net ${net.id} has no NMOS source/drain attached`,
        refs: { netIds: [net.id] },
      });
    }
  }
}

// ── Step 9: whole-cell sanity ─────────────────────────────────────

function cellLevelChecks(
  nets: ExtractedNet[],
  transistors: Transistor[],
  domains: CmosDomain[],
  warnings: ExtractionWarning[],
): void {
  // "Real" = not dummy / unknown. PUN/PDN/TG/pass all count.
  const realTransistors = transistors.filter(
    (t) => t.role !== "dummy" && t.role !== "unknown",
  );
  if (transistors.length === 0) {
    warnings.push({
      severity: "warning",
      code: "NO_TRANSISTORS",
      message: "cell has no transistors (likely filler or empty)",
    });
  }
  const hasVcc = nets.some((n) => n.label === "vcc");
  const hasGnd = nets.some((n) => n.label === "gnd");
  if (!hasVcc) {
    warnings.push({
      severity: "warning",
      code: "NO_VCC_RAIL",
      message: "no net labelled VCC",
    });
  }
  if (!hasGnd) {
    warnings.push({
      severity: "warning",
      code: "NO_GND_RAIL",
      message: "no net labelled GND",
    });
  }
  if (domains.length === 0 && realTransistors.length > 0) {
    // Pass-gate-only cells (transmission gate / analog switch) have no
    // rail-anchored pull-up/pull-down by design — that's a note, not a
    // defect. Anything else with transistors but no domain is suspicious.
    const passOnly = realTransistors.every(
      (t) => t.role === "tg" || t.role === "pass",
    );
    warnings.push({
      severity: passOnly ? "info" : "warning",
      code: "NO_OUTPUT",
      message: passOnly
        ? "no CMOS pull-up/pull-down pair — pass-gate-only cell (no rail-driven output)"
        : "no CMOS pull-up/pull-down pair found — output couldn't be identified",
    });
  } else {
    // Multi-DOMAIN is expected for chained combinational cells (AND2 =
    // NAND2+INV, OR2 = NOR2+INV, AO21 = AOI21+INV, etc.) — these are
    // single-OUTPUT cells with internal pipelining and `classifyNets`
    // already correctly labels the mid-stage net as `internal`. Only
    // raise an info-level note when the cell really does expose more
    // than one primary output (genuine multi-output cells like full
    // adders or decoders).
    const primaryOutputs = nets.filter((n) => n.role === "output");
    if (primaryOutputs.length > 1) {
      warnings.push({
        severity: "info",
        code: "MULTIPLE_OUTPUTS",
        message: `${primaryOutputs.length} primary output nets — likely a multi-output cell`,
        refs: { netIds: primaryOutputs.map((n) => n.id) },
      });
    }
  }
  const pmos = transistors.filter((t) => t.type === "pmos").length;
  const nmos = transistors.filter((t) => t.type === "nmos").length;
  if (pmos > 0 && nmos > 0 && Math.abs(pmos - nmos) > Math.max(pmos, nmos) / 2) {
    warnings.push({
      severity: "info",
      code: "TRANSISTOR_COUNT_MISMATCH",
      message: `PMOS=${pmos} vs NMOS=${nmos} — unusual ratio for a non-tristate cell`,
    });
  }
}
