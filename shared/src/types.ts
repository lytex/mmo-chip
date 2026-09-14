// ── Die metadata ──────────────────────────────────────────────────

export interface DieLevelMetadata {
  z: number;
  width: number;
  height: number;
  columns: number;
  rows: number;
  scale: number;
}

export interface DieTileProgress {
  /** Tiles whose canonical files are now available, including cached files found on disk. */
  completedTiles: number;
  totalTiles: number;
  percentage: number;
  /** Tiles rendered in this backend session; used for ETA without cache-scan distortion. */
  generatedTiles: number;
  /** True when background prebuild is paused; viewport tile requests still remain available. */
  isPaused: boolean;
  /** Rolling speed of actual tile renders measured by the backend, or null while warming up. */
  tilesPerSecond: number | null;
  /** Estimated seconds until the complete pyramid is available, or null while measuring. */
  etaSeconds: number | null;
}

export interface OverlayTileSourceProgress {
  id: string;
  name: string;
  completedTiles: number;
  totalTiles: number;
  percentage: number;
  /** Present in the on-demand Info endpoint; omitted from frequent Library polling. */
  originalBytes?: number;
  tileBytes?: number;
  /** queued = waiting for the shared background worker; generating = active. */
  status: "queued" | "generating" | "completed" | "paused";
}

export interface OverlayTileProgress {
  completedTiles: number;
  totalTiles: number;
  percentage: number;
  isPaused: boolean;
  /** Per-image state; returned in the Info endpoint and, while active, in Library. */
  sources: OverlayTileSourceProgress[];
}

export interface ProjectStorageUsage {
  totalBytes: number;
  dieBytes: number;
  baseTileBytes: number;
  overlayOriginalBytes: number;
  overlayTileBytes: number;
  otherProjectBytes: number;
}

export interface DieTileInfo {
  dieId: string;
  baseTileProgress: DieTileProgress | null;
  overlayTileProgress: OverlayTileProgress;
  storage: ProjectStorageUsage;
}

export interface DieSummary {
  id: string;
  name: string;
  originalFilename: string;
  width: number;
  height: number;
  tileSize: number;
  maxZoomLevel: number;
  createdAt: string;
  updatedAt: string;
  tileProgress?: DieTileProgress;
  overlayTileProgress?: OverlayTileProgress;
}

export interface DieMetadata extends DieSummary {
  tileFormat: "jpg" | "png";
  levels: DieLevelMetadata[];
}

// ── Annotations ───────────────────────────────────────────────────

export interface AnnotationPoint {
  x: number;
  y: number;
}

export interface AnnotationNetNode {
  id: string;
  x: number;
  y: number;
}

/** Conductor layer of a wire segment. Absent ⇒ "unknown" (the default).
 *  RE/verilog metadata only - ML trace derivation ignores material. */
export type WireLayer =
  | "poly"
  | "metal1" | "metal2" | "metal3" | "metal4" | "metal5" | "metal6";

// ── Metal stack configuration ─────────────────────────────────

export interface MetalLevel {
  id: string;             // "ME1", "ME2", ...
  layer: WireLayer;       // "metal1", "metal2", ...
  z: number;              // 1, 2, 3, ...
  name: string;           // "Metal 1"
  color: string;
  width?: number;
}

export interface ViaLevel {
  id: string;             // "VIA12", "VIA23", ...
  from: string;           // MetalLevel.id (нижний)
  to: string;             // MetalLevel.id (верхний)
  layer: string;          // "via1", "via2", ...
  color: string;
  size?: number;
}

export interface MetalStack {
  metals: MetalLevel[];
  vias: ViaLevel[];
  defaultMetalId: string;
  defaultViaId: string;
}

export interface DieConfig {
  metalStack?: MetalStack;
  umPerPx?: number;
}

export interface AnnotationNetEdge {
  id: string;
  from: string;
  to: string;
  /** Absent ⇒ unknown layer. Stamped per-segment at draw time; editable
   *  later from the inspector. Persisted verbatim inside the net. */
  layer?: WireLayer;
}

export interface AnnotationNet {
  id: string;
  name: string;
  nodes: AnnotationNetNode[];
  edges: AnnotationNetEdge[];
}

export interface AnnotationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ── Cell layer annotations ────────────────────────────────────────

export type LayerType =
  | "diffusion"
  | "polysilicon"
  | "metal1"
  | "metal2"
  | "metal3"
  | "metal4"
  | "metal5"
  | "metal6"
  | "contact"
  | "via1" | "via2" | "via3" | "via4" | "via5"
  | "wire_hitbox"
  // ── Analog/BiCMOS extension layers ────────
  | "nwell"
  | "pwell"
  | "deep_nwell"
  | "buried_layer"
  | "base"
  | "emitter"
  | "collector_sinker"
  | "jfet_gate"
  | "jfet_channel"
  | "resistor_body"
  | "capacitor_bottom"
  | "capacitor_top"
  // Compound: user-drawn device boundary box
  | "device_box"
  // Resistor body: material-specific layers for type detection
  | "hsr"
  | "film"
  // Analog marker layers (simple RE mode)
  | "npn_id"
  | "pnp_id"
  | "lpnp_id"
  | "vpnp"
  | "res_id"
  | "cap_id"
  | "diode_id"
  // BJT terminal layers
  | "collector"
  // Bulk/well marker (used in BJT + MOS terminal defs)
  | "bulk";

/**
 * User-set role tag on a layer shape, scoped to interconnect (metals, polys,
 * contacts, vias). Propagates through extraction so the whole electrical net
 * the shape sits in gets this role (vcc / gnd / io / input / output) instead
 * of whatever the structural inference would have picked. `input` / `output`
 * exist as a manual escape hatch for cells the bridge-rule classifies wrong
 * (pass-transistor logic, transmission gates, unusual cells).
 *
 * NOT used on diffusion. Diffusion uses `forcedType` instead - historically
 * we conflated the two by reading `label === "vcc" / "gnd"` on diffusion as
 * a P/N override, but that confused the net-propagation step into shorting
 * the diffusion's whole sub-region net to a power rail.
 */
export type ShapeLabel = "vcc" | "gnd" | "io" | "input" | "output";

/**
 * Diffusion-only manual override for the body type. Bypasses the auto-
 * inference in step 3 of the cell extractor (which looks at which rail each
 * sub-region's contacts touch). Independent of `label` so a forced type
 * doesn't accidentally propagate as a net role.
 */
export type ForcedDiffusionType = "p" | "n";

/**
 * Arbitrary user-supplied name for the net this shape participates in
 * (e.g. "CLK", "Qbar", "STORAGE_NODE"). Lives on the shape so it
 * persists in the cellType document; propagates to the net at
 * extraction time exactly like `label` does. Distinct from `label` so
 * a custom name can coexist with a role assignment (e.g. label "vcc"
 * tags the net as a power rail for inference, customName "VDD_int"
 * controls how it's displayed in the schematic).
 */

export interface LayerRect {
  id: string;
  kind: "rect";
  x: number;
  y: number;
  width: number;
  height: number;
  label?: ShapeLabel;
  forcedType?: ForcedDiffusionType;
  customName?: string;
}

export interface LayerLine {
  id: string;
  kind: "line";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  label?: ShapeLabel;
  forcedType?: ForcedDiffusionType;
  customName?: string;
}

export interface LayerPoint {
  id: string;
  kind: "point";
  x: number;
  y: number;
  size: number;
  label?: ShapeLabel;
  forcedType?: ForcedDiffusionType;
  customName?: string;
}

export interface LayerCircle {
  id: string;
  kind: "circle";
  x: number;
  y: number;
  radius: number;
  label?: ShapeLabel;
  forcedType?: ForcedDiffusionType;
  customName?: string;
}

export interface LayerPolygon {
  id: string;
  kind: "polygon";
  points: { x: number; y: number }[];
  label?: ShapeLabel;
  forcedType?: ForcedDiffusionType;
  customName?: string;
}

export type LayerShape = LayerRect | LayerLine | LayerPoint | LayerCircle | LayerPolygon;

export type CellLayers = Partial<Record<LayerType, LayerShape[]>>;

export interface CellType {
  id: string;
  name: string;
  cropRect: AnnotationRect;
  layers?: CellLayers;
  /** True once promoted to a real, human-confirmed type via the merge-cells
   *  tool. Absent/false ⇒ an auto-created singleton placeholder (a cell that
   *  has only been labelled, not yet classified) - grouped under "Unmatched". */
  matched?: boolean;
  /** Contact shape IDs explicitly forced to be SOURCE terminals.
   *  When a MOS device's D terminal touches one of these contacts,
   *  D and S are swapped so the forced contact shows "S".
   *  Empty/absent = no overrides. */
  forcedSourceContacts?: string[];
}

export interface Cell {
  id: string;
  cellTypeId: string;
  x: number;
  y: number;
  /** Vertical mirror (existing). */
  flippedV?: boolean;
  /** Horizontal mirror, applied for display + ML export. Set while aligning
   *  a candidate in the merge-cells tool. */
  flippedH?: boolean;
  /** Orientation in degrees clockwise. Absent ⇒ 0. */
  rotation?: 0 | 90 | 180 | 270;
  /** Set true once this instance has been classified & confirmed by the user
   *  via the merge-cells tool (drives the candidate "done" checkmark). */
  merged?: boolean;
  /** True when placed by CV detection. */
  mlDetected?: boolean;
  /** Confidence score from CV matching (0..1). */
  mlConfidence?: number;
}

// ── Grid definitions ──────────────────────────────────────────────

export interface GridColumn {
  x: number;
  width: number;
}

export interface GridDefinition {
  id: string;
  name: string;
  columns: GridColumn[];
  rowHeight: number;
  columnOffsets: number[];
}

/**
 * Cell-placement guides. RE/layout aid only (not ML): the cell-rectangle
 * tool can snap its edges to these. A `line` is infinite (axis = the fixed
 * coordinate: "x" ⇒ vertical line at x=`pos`, "y" ⇒ horizontal at y=`pos`);
 * a `segment` is a finite axis-aligned span that only snaps when near.
 */
export type Guide =
  | { id: string; kind: "line"; axis: "x" | "y"; pos: number }
  | {
      id: string;
      kind: "segment";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
    };

export interface IOPin {
  id: string;
  x: number;
  y: number;
  pin: number;
  name: string;
}

// ── ML annotations  ───────

export type GeometryKind = "point" | "polyline" | "rectangle" | "polygon";

export interface PointGeometry {
  kind: "point";
  x: number;
  y: number;
}
/** Trace width is chip-global (DieMLConfig.traceWidth), never per-segment. */
export interface PolylineGeometry {
  kind: "polyline";
  points: { x: number; y: number }[];
}
export interface RectangleGeometry {
  kind: "rectangle";
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface PolygonGeometry {
  kind: "polygon";
  points: { x: number; y: number }[];
}
export type Geometry =
  | PointGeometry
  | PolylineGeometry
  | RectangleGeometry
  | PolygonGeometry;

export type AnnotationClass = "point_via" | "irregular_via" | "trace";
export type DecoderKind = "peak" | "region" | "skeleton";

export interface ClassDef {
  id: AnnotationClass;
  decoderKind: DecoderKind;
  /** Model output channel index. */
  channel: number;
  allowedGeometry: GeometryKind[];
  sizeSource: "pointViaSize" | "traceWidth" | null;
}

/** The shared contract. Both ends import this - never hardcode channel
 *  indices or class→geometry rules anywhere else. */
export const CLASS_REGISTRY: Record<AnnotationClass, ClassDef> = {
  point_via: {
    id: "point_via",
    decoderKind: "peak",
    channel: 0,
    allowedGeometry: ["point"],
    sizeSource: "pointViaSize"
  },
  irregular_via: {
    id: "irregular_via",
    decoderKind: "region",
    channel: 1,
    allowedGeometry: ["rectangle", "polygon"],
    sizeSource: null
  },
  trace: {
    id: "trace",
    decoderKind: "skeleton",
    channel: 2,
    allowedGeometry: ["polyline"],
    sizeSource: "traceWidth"
  }
};
export const NUM_CLASSES = 3;

/** Persisted classes are point_via | irregular_via only; `trace` is
 *  materialized from `nets` by the exporter, never stored here. */
export interface HumanAnnotation {
  id: string;
  class: AnnotationClass;
  geometry: Geometry;
  /** "approved" = a model prediction the user verified; default "human". */
  source?: "human" | "approved";
  /** Via layer id (VIA12, VIA23, …) for via annotations. Absent = legacy. */
  layer?: string;
}

export interface ROIRectangle {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Which classes this ROI fully labels (absent ⇒ all). Drives the
   *  per-channel loss mask so net-derived traces can't poison via-only ROIs. */
  classes?: AnnotationClass[];
}

/** Region the model must not score (any class) during training. */
export interface IgnoreRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DieMLConfig {
  /** Via radius in source px → Gaussian sigma = radius * 0.5. Chip-global. */
  pointViaSize: number;
  /** Default trace stroke width in source px. Chip-global. */
  traceWidth: number;
}

/** A ruler/measurement line drawn on the die image. Stores raw pixel start/end
 *  plus the μm length computed at draw time (cached so it survives zoom). */
// ── Floorplan Regions (Phase 2.1) ────────────────────────────────

export interface FloorplanRegion {
  id: string;
  /** User-assigned name, e.g. "VCC_UVLO" */
  name: string;
  kind: "rect" | "polygon";
  /** 2 points for rect, N points for polygon */
  geometry: { x: number; y: number }[];
  /** Stroke color */
  color: string;
  /** Who created this region (userId) */
  createdBy: string | null;
  /** Human-readable name of the creator */
  createdByName: string | null;
  createdAt: string | null;
  /** Optional: who reserved this region (userId) */
  reservedBy: string | null;
  /** Human-readable name of who reserved it */
  reservedByName: string | null;
  reservedAt: string | null;
  /** User-visible port name overrides: netId → alias */
  portAliases?: Record<number, string>;
}

// ── Comments (Phase 2.2) ────────────────────────────────────────

export interface CommentReply {
  id: string;
  text: string;
  authorId: string;
  authorName: string;
  createdAt: string;
}

export interface CommentAnnotation {
  id: string;
  x: number;
  y: number;
  text: string;
  authorId: string;
  authorName: string;
  createdAt: string;
  replies: CommentReply[];
}

export interface RulerMeasurement {
  id: string;
  name?: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Pixel length at the time of drawing (cached). */
  lengthPx: number;
  /** μm length computed from umPerPx at draw time (cached). */
  lengthUm: number;
}

export interface DieAnnotations {
  version: 2;
  /** Monotonically incremented every time the annotations are written.
   *  Clients use it to spot stale caches when a WS notification arrives. */
  rev: number;
  nets: AnnotationNet[];
  cellTypes: CellType[];
  cells: Cell[];
  grids: GridDefinition[];
  pins?: IOPin[];
  mlConfig?: DieMLConfig;
  annotations?: HumanAnnotation[];
  rois?: ROIRectangle[];
  ignores?: IgnoreRect[];
  /** Cell-placement guides (RE aid, not ML). Absent ⇒ none. */
  guides?: Guide[];
  /** Die-level analog/mixed-signal layer annotations (Phase 1).
   *  Shapes drawn directly on the die image (not inside a cell type) for
   *  analog device detection. Same LayerType keys as CellType.layers:
   *  nwell, pwell, base, emitter, resistor_body, etc. */
  analogLayers?: CellLayers;
  /** Scale factor: micrometres per source-image pixel. Populated by the ruler
   *  tool's "Set scale" workflow. When set, measurements and device geometry
   *  calculations can report physical (μm) dimensions. */
  umPerPx?: number;
  /** Ruler measurements - persistent lines with annotated pixel length. */
  rulers?: RulerMeasurement[];
  /** User comments pinned to locations on the die (Phase 2.2). */
  comments?: CommentAnnotation[];
  /** Floorplan regions — functional block outlines (Phase 2.1). */
  floorplanRegions?: FloorplanRegion[];
  /** IC Package bond mapping — die pad to package pin wirebond connections. */
  icPackage?: IcPackageConfig;
}

export interface MLExportRequest {
  approxViaRadiusPx: number;
  /** Optional: export ROIs from an overlay image instead of the base image. */
  overlayFilename?: string;
}

export interface MLExportResponse {
  exportDir: string;
  totalRois: number;
  /** Name of the source image used for export (base image or overlay). */
  sourceImage: string;
}

export interface MLVia {
  /** Source-image pixel coordinates (Node translates from crop-local). */
  x: number;
  y: number;
  /** Heatmap probability at the peak, in (threshold, 1]. */
  score: number;
  /** Via layer id (VIA12, VIA23, …). Derived from the checkpoint filename. */
  viaLayer?: string;
}

/** irregular_via instance (ch1 connected component), source-image coords. */
export interface MLRegion {
  bbox: [number, number, number, number]; // x, y, w, h
  centroid: [number, number];
  area: number;
  score: number;
}

/** trace decode (ch2). Source-image coords. v1 = contour polyline; a true
 *  skeleton→graph is the later assisted-tracing phase. */
export interface MLTracePolyline {
  points: [number, number][];
}

export interface MLPrediction {
  pointVias: MLVia[];
  irregularVias: MLRegion[];
  traces: MLTracePolyline[];
  /** [x0, y0, x1, y1] in source-image pixels - the region this covers. */
  bbox: [number, number, number, number];
  /** Checkpoint the prediction came from; changes invalidate caches. */
  checkpointHash: string | null;
  /** Overlay filename used as source, or null for base image. */
  overlayFilename?: string | null;
}

/** One native tile's cached prediction inside a batched range response. */
export interface MLViasTileResult {
  /** Native-level tile column / row. */
  x: number;
  y: number;
  prediction: MLPrediction;
}

/**
 * Batched ML-vias response: every *cached* tile in a native-tile range, in
 * one round-trip. Tiles with no cached prediction are simply omitted (the
 * client treats them as not-yet-computed). Replaces N per-tile requests.
 */
export interface MLViasTilesResponse {
  z: number;
  checkpointHash: string | null;
  tiles: MLViasTileResult[];
}

export interface MLTrainRequest {
  /** Dir containing rois/ (recursively). Relative paths resolve under the data root. */
  dataDir: string;
  epochs?: number;
  encoder?: string;
  lr?: number;
  cropSize?: number;
  stepsPerEpoch?: number;
  batchSize?: number;
  /** Checkpoint output path; defaults to the sidecar's resident checkpoint. */
  output?: string;
}

export interface MLTrainResponse {
  jobId: string;
}

export interface MLJobStatus {
  jobId: string;
  kind: "train" | "predict_die";
  status: "running" | "done" | "error";
  epoch?: number;
  epochs?: number;
  loss?: number | null;
  checkpointPath?: string | null;
  error?: string | null;
  startedAt?: string;
  updatedAt?: string;
}

/** Mirror of the Python sidecar's GET /health, surfaced via Node /api/ml/status. */
export interface MLServiceStatus {
  /** false when the sidecar is unreachable; the rest of the fields are then absent. */
  reachable: boolean;
  status?: string;
  device?: string;
  checkpoint?: string | null;
  checkpointHash?: string | null;
  encoder?: string;
  modelLoaded?: boolean;
  trainingActive?: boolean;
}

// ── ML inference jobs (Node-managed, per-die tile sweep) ──────────

export type MLInferenceJobStatus =
  | "running"
  | "stopped"
  | "completed"
  | "failed";

/**
 * A die-wide inference sweep. Node walks every native-zoom tile, runs the
 * sidecar, and caches each prediction. There is at most one job per die, so
 * the die id doubles as the job key. Stopping leaves the cache intact, so a
 * later start resumes from where it left off.
 */
export interface MLInferenceJob {
  dieId: string;
  status: MLInferenceJobStatus;
  /** Native-zoom tile grid total (columns × rows). */
  totalTiles: number;
  /** Tiles whose prediction JSON is cached on disk for `checkpointHash`. */
  completedTiles: number;
  /** 0-100, completedTiles / totalTiles. */
  percentage: number;
  /** Checkpoint hash the cached predictions belong to. */
  checkpointHash: string | null;
  /** Sidecar checkpoint filename in use when the job last ran. */
  model: string | null;
  /** Overlay filename used as source, or null for base image. */
  overlayFilename: string | null;
  error: string | null;
  startedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
}

/** A checkpoint file the sidecar can load. */
export interface MLModelInfo {
  /** Checkpoint filename, relative to the sidecar's checkpoints dir. */
  name: string;
  /** 12-char checkpoint hash, or null if unreadable. */
  hash: string | null;
  /** File size in bytes. */
  sizeBytes: number;
  /** True for the model currently resident in the sidecar. */
  resident: boolean;
}

export interface MLModelsResponse {
  models: MLModelInfo[];
}

export interface MLSelectModelRequest {
  /** Checkpoint name from MLModelInfo.name. */
  name: string;
}

// ── Import jobs ───────────────────────────────────────────────────

export type ImportJobStatus = "queued" | "running" | "completed" | "failed";

export type ImportJobPhase =
  | "queued"
  | "analyzing"
  | "tiling"
  | "persisting"
  | "completed"
  | "failed";

export interface ImportJob {
  id: string;
  type: "import-die";
  status: ImportJobStatus;
  originalFilename: string;
  mimeType: string;
  dieId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  progress: ImportJobProgress;
}

export interface ImportJobProgress {
  phase: ImportJobPhase;
  message: string;
  totalLevels: number;
  completedLevels: number;
  currentLevel: number | null;
  currentLevelTiles: number;
  currentLevelProcessedTiles: number;
  totalTiles: number;
  processedTiles: number;
  percentage: number;
}

// ════════════════════════════════════════════════════════════════
// Analog / Mixed-Signal Extension (Phase 1 - MM0-CHIP fork)
// ════════════════════════════════════════════════════════════════

// ── Device kind ─────────────────────────────────────────────────

export type DeviceKind =
  | "mos"
  | "bjt_npn"
  | "bjt_pnp"
  | "jfet_n"
  | "jfet_p"
  | "resistor"
  | "capacitor"
  | "diode"
  | "zener"
  | "schottky"
  | "inductor"
  | "unknown";

// ── Device geometry parameters ──────────────────────────────────

export interface DeviceGeometryMOS {
  /** Physical gate length (poly width crossing diffusion) [μm] */
  L_um: number;
  /** Physical gate width (diffusion edge along poly) [μm] */
  W_um: number;
  /** Number of parallel gate fingers */
  fingers: number;
  /** Multiplier - number of cell repeats */
  multiplier: number;
  /** Effective total width = W × fingers × multiplier [μm] */
  totalW_um: number;
  /** Transistor type */
  mosType: "pmos" | "nmos" | "unknown";
}

export interface DeviceGeometryBJT {
  /** Emitter area [μm2] */
  AE_um2: number;
  /** Emitter perimeter [μm] */
  PE_um: number;
  /** Multiplier */
  multiplier: number;
  /** Total AE = AE × multiplier [μm2] */
  totalAE_um2: number;
  /** Number of emitter stripes */
  emitterFingers: number;
  /** Transistor type */
  bjtType: "npn" | "pnp" | "unknown";
}

export interface DeviceGeometryJFET {
  /** Channel width [μm] */
  W_um: number;
  /** Channel length [μm] */
  L_um: number;
  /** Fingers */
  fingers: number;
  /** Multiplier */
  multiplier: number;
  /** JFET type */
  jfetType: "njf" | "pjf" | "unknown";
}

/** Resistor material type - determines default sheetR. */
export type ResistorType = "poly" | "hsr" | "pb" | "npl" | "film";

export interface DeviceGeometryResistor {
  /** Physical body length [μm] */
  L_um: number;
  /** Physical body width [μm] */
  W_um: number;
  /** Number of squares = L / W */
  squares: number;
  /** User-supplied sheet resistance [Ω/□] */
  sheetR_ohms?: number;
  /** Resistance = squares × sheetR [Ω] */
  resistance_ohms?: number;
  /** Fingers (parallel segments) */
  fingers: number;
  /** Multiplier */
  multiplier: number;
  /** Body shape */
  shape?: "straight" | "meander" | "serpentine" | "unknown";
  /** Resistor material type. Defaults to "poly" (polysilicon). */
  resistorType?: ResistorType;
}

export interface DeviceGeometryCapacitor {
  /** Plate overlap area [μm2] */
  area_um2: number;
  /** Perimeter of bottom plate [μm] */
  perimeter_um: number;
  /** User-supplied capacitance density [fF/μm2] */
  capDensity_fF?: number;
  /** Capacitance = area × capDensity [fF] */
  capacitance_fF?: number;
  /** Multiplier */
  multiplier: number;
  /** Capacitor type */
  capType?: "mim" | "pip" | "mos" | "metal_metal" | "unknown";
}

export interface DeviceGeometryDiode {
  /** Junction area [μm2] */
  area_um2: number;
  /** Junction perimeter [μm] */
  perimeter_um: number;
  /** Multiplier */
  multiplier: number;
  /** Diode type */
  diodeType?: "pn" | "schottky" | "zener" | "unknown";
}

export type DeviceGeometry =
  | DeviceGeometryMOS
  | DeviceGeometryBJT
  | DeviceGeometryJFET
  | DeviceGeometryResistor
  | DeviceGeometryCapacitor
  | DeviceGeometryDiode;

// ── Terminal connection ─────────────────────────────────────────

export interface DeviceTerminal {
  /** Terminal name (e.g. "D", "G", "S", "B" for MOS) */
  name: string;
  /** Die-level net id this terminal connects to */
  netId: number;
  /**
   * IDs of cell-type layer shapes that belong to this terminal.
   * Used by resolveDeviceContacts to only match contacts that physically
   * sit inside this device's shapes, not another device's shapes in the
   * same cell type.
   */
  shapeIds?: string[];
}

// ── Analog device ───────────────────────────────────────────────

export interface AnalogDevice {
  id: string;
  /** Type of device */
  kind: DeviceKind;
  /** Extracted geometry parameters */
  geometry: DeviceGeometry;
  /** Cell-type this device belongs to (empty string = die-level) */
  cellTypeId: string;
  /** Instance name for SPICE netlist (e.g. M1, Q12, R34) */
  instanceName?: string;
  /** SPICE model name */
  modelName?: string;
  /** Terminal connections */
  terminals: DeviceTerminal[];
  /** Outline polygon in cell-local coordinates */
  outline?: { x: number; y: number }[];
  /** Bounding box */
  bbox?: AnnotationRect;
  /** User comment */
  comment?: string;
}

// ── SPICE configuration ─────────────────────────────────────────

export interface SpiceConfig {
  /** Technology name for .MODEL cards */
  technology?: string;
  /** Sheet resistance per layer [Ω/□] */
  sheetR_ohms?: Record<string, number>;
  /** Capacitance density per layer pair [fF/μm2] */
  capDensity_fF?: Record<string, number>;
  /** SPICE model definitions (modelName → .MODEL card) */
  models?: Record<string, string>;
  /** Default VDD net name */
  vdd?: string;
  /** Default GND net name */
  gnd?: string;
  /** Scale factor - μm per pixel */
  umPerPx?: number;
  /** Resistor value format.
   *  - "ohms":  r=2500       (resolved resistance)
   *  - "sqRs":  r=10*250     (squares × sheetR, as expression)
   *  Default: "ohms". */
  resistorFormat?: "ohms" | "sqRs";
  /**
   * Device geometry matching tolerance in percent.
   * Devices with similar W/L/AE/PE within this tolerance get their
   * geometry averaged to produce consistent instance parameters.
   * 0 = disabled (default).
   */
  matchTolerancePercent?: number;
}

// ── Export request / response ───────────────────────────────────

export type SpiceDialect = "cdl" | "spectre" | "hspice";

export interface AnalogExportRequest {
  /** SPICE dialect */
  dialect: SpiceDialect;
  /** Generate hierarchical subcircuits */
  hierarchical: boolean;
  /** Override SPICE config */
  spiceConfig?: SpiceConfig;
}

export interface AnalogExportResponse {
  /** Path to the generated netlist file */
  netlistPath: string;
  /** Number of devices extracted */
  deviceCount: number;
  /** Count per device kind */
  byKind: Record<string, number>;
  /** Extraction/export warnings */
  warnings: string[];
}

// ── LVS comparison ──────────────────────────────────────────────

export type LvsEngine = "vyges-lvs" | "name-based";

export interface LvsCompareRequest {
  layoutNetlist: string;
  schematicNetlist: string;
  dialect?: SpiceDialect;
  moduleName?: string;
  engine?: LvsEngine;
}

/** Unbalanced class — device or net count differs */
export interface LvsUnbalancedClass {
  what: "device" | "net";
  a_count: number;
  b_count: number;
  a: string[];
  b: string[];
}

/** Property diff — parameter value differs */
export interface LvsPropertyDiff {
  kind: string;
  a_device: string;
  b_device: string;
  param: string;
  a_value: number;
  b_value: number;
}

/** A structured event emitted by vyges-lvs on stderr */
export interface VygesEvent {
  schema: string;
  ts_ms: number;
  tool: string;
  severity: "info" | "warn" | "error";
  code: string;
  raw_msg: string;
  objects?: string[];
}

/** Top-level result from any LVS engine */
export interface LvsRawResult {
  matched: boolean;
  verified: boolean;
  note?: string;
  a_devices: number;
  b_devices: number;
  a_nets: number;
  b_nets: number;
  iterations: number;
  only_in_a_ports: string[];
  only_in_b_ports: string[];
  unbalanced: LvsUnbalancedClass[];
  property_diffs: LvsPropertyDiff[];
}

/** Per-engine result */
export interface LvsEngineResult {
  engine: LvsEngine;
  matched: boolean;
  json: LvsRawResult;
  report: string;
  stderr?: string;
  events?: VygesEvent[];
}

/** Combined response */
export interface LvsCombinedResult {
  engine: LvsEngine;
  matched: boolean;
  json: LvsRawResult;
  report: string;
  events?: VygesEvent[];
}

export interface LvsResponse {
  ok: true;
  data: LvsCombinedResult;
}

export interface LvsErrorResponse {
  ok: false;
  error: string;
  detail?: string;
}

// ── CV cell detection ───────────────────────────────────────────

export interface CVMatchResult {
  /** Centroid x in search-image pixel coords. */
  x: number;
  /** Centroid y in search-image pixel coords. */
  y: number;
  /** Best-fit rotation in degrees (0, 90, 180, 270). */
  rotation: 0 | 90 | 180 | 270;
  /** Confidence score 0..1 (higher = more similar). */
  confidence: number;
  /** Bounding box [x, y, w, h] in search-image pixel coords. */
  bbox: [number, number, number, number];
  /** Tree-match struct score (contour only). */
  tree_match_score?: number;
  /** Number of ref-tree children (contour only). */
  n_children_ref?: number;
  /** Number of matched children in candidate (contour only). */
  n_children_matched?: number;
  /** sqrt(cand_pocket_area / ref_pocket_area), isotropic (contour only). */
  scale?: number;
  /** How rotation was determined: tree (matched children), inertia (fallback). */
  orientation_source?: "tree" | "inertia" | "bbox";
  /** AKAZE pairwise similarity score (added by akaze_verify_matches). */
  akaze_similarity?: number;
}

export interface CVMatchRequest {
  dieId: string;
  cellTypeId: string;
  /** Position of the selected cell instance on the die (die coords). */
  cellX?: number;
  cellY?: number;
  /** Overlay filename to search on, or undefined for base image. */
  overlayFilename?: string;
  /** Confidence threshold (0..1). Default 0.5 (template only). */
  threshold?: number;
  /** Number of rotation steps (1, 2, or 4). Default 4 (template only). */
  rotationSteps?: number;
  /** Max matches to return. Default 100. */
  maxMatches?: number;
  /** Sobel kernel size (template only). Default 3. */
  sobelKsize?: number;
  /** NMS IoU threshold (template only). Default 0.3. */
  nmsIou?: number;
  /** NMS centroid distance threshold in px (template only). Default 30. */
  nmsDist?: number;
  detectionMode?: "canny" | "threshold" | "gradient";
  /** Morphological gradient kernel size (gradient mode only). Default 5. */
  gradientKernel?: number;
  /** Minimum contour area in px². Contour default 200. */
  minArea?: number;
  /** NMS center distance threshold in px. Default 10. */
  minDistance?: number;
  /** Min area ratio (cand_pocket / ref_pocket). Contour default 0.6. */
  areaLo?: number;
  /** Max area ratio. Contour default 1.8. */
  areaHi?: number;
  /** Max aspect error. Contour default 0.5. */
  aspectThresh?: number;
  /** Merge sibling contours within this many px. Contour default 6. */
  mergeDistPx?: number;
  /** Merge siblings if |log(area_a/area_b)| < ln(1+r). Default 0.4. */
  mergeAreaRatio?: number;
  /** EFD harmonics. Default 10. */
  efdHarmonics?: number;
  /** Max fuzzy distance to count a child as matched. Default 1.2. */
  fuzzyThresh?: number;
  /** Min matched ref children to accept. Slider 1-4, default 2. */
  minRefChildren?: number;
  /** Min struct score to accept. Default 0.3. */
  structThresh?: number;
  /** Min matched children for tree-based rotation. Default 2. */
  rotationMinMatches?: number;
  /** Fuzzy distance weight: EFD. Default 1.0. */
  wShape?: number;
  /** Fuzzy distance weight: log area. Default 1.0. */
  wArea?: number;
  /** Fuzzy distance weight: 1-IoU. Default 1.0. */
  wBbox?: number;
  /** Fuzzy distance weight: position. Default 0.5. */
  wPos?: number;
  /** AKAZE verify threshold (0..1). Cells with pairwise similarity below this are removed. Default 0.5. */
  sift_threshold?: number;
}

export interface AKAZEReverifyRequest {
  dieId: string;
  cellTypeId: string;
  /** Matches from the previous template run. */
  matches: CVMatchResult[];
  /** Overlay filename to search on, or undefined for base image. */
  overlayFilename?: string;
  /** Reference cell X position (for extracting the ref patch). */
  cellX?: number;
  /** Reference cell Y position. */
  cellY?: number;
  /** AKAZE verify threshold (0..1). Default 0.5. */
  sift_threshold?: number;
  /** Gaussian blur kernel size (0 = disabled, must be odd). */
  blur_ksize?: number;
  /** Apply Sobel edge detection before AKAZE. */
  use_sobel?: boolean;
}

export interface AKAZEReverifyResponse {
  /** Matches that passed verification. */
  kept: CVMatchResult[];
  /** Matches removed by AKAZE verify. */
  removed: CVMatchResult[];
  /** Per-match similarity to reference (same order as input matches). */
  ref_similarities?: number[];
}

export interface AKAZEDebugPairImage {
  cell_i: number;
  cell_j: number;
  similarity: number;
  n_good_matches: number;
  n_kp_i: number;
  n_kp_j: number;
  image_png_b64: string;
}

export interface AKAZEDebugCellStat {
  match_index: number;
  confidence: number;
  n_keypoints: number;
  ref_sim: number;
  has_descriptors: boolean;
}

export interface AKAZEDebugResponse {
  pair_images: AKAZEDebugPairImage[];
  cell_stats: AKAZEDebugCellStat[];
}

export interface CVMatchResponse {
  matches: CVMatchResult[];
  /** Bounding box of the reference cell in die coords. */
  referenceBbox: [number, number, number, number];
  /** Bounding box of the searched region in die coords. */
  searchRegion: [number, number, number, number];
  total: number;
}

/** Cell type changes for CV detection. */
export interface CellMLFlags {
  /** True when placed by CV detection. */
  mlDetected?: boolean;
  /** Confidence score from CV matching. */
  mlConfidence?: number;
}

/** A single node in the reference contour tree. */
export interface CVTreeNode {
  depth: number;
  area: number;
  centroid: [number, number];
  bbox: [number, number, number, number];
  inertia_angle: number;
  children: CVTreeNode[];
}

/** Debug info returned by the CV debug endpoint. */
export interface CVDebugData {
  /** Reference crop image as base64 PNG. */
  ref_crop_png_b64: string;
  /** Reference contour tree (contour detection only). */
  ref_tree: CVTreeNode | null;
  /** Total number of nodes in ref_tree (root + all descendants). */
  ref_contour_count: number;
  /** Reference tree visualisation as base64 PNG. */
  ref_contour_png_b64: string | null;
  /** Search image preview (resized) with matched bboxes drawn, as base64 JPG. */
  search_preview_png_b64: string | null;
  /** Top matches (same shape as CVMatchResult.matches). */
  top_matches: CVMatchResult[];
  /** Number of accepted candidates. */
  total_candidates: number;
  /** Template debug: how many matchTemplate peaks before NMS. */
  pre_nms_peaks?: number;
  /** Template debug: Sobel edges of search image as base64 JPG. */
  search_edges_png_b64?: string;
  /** Template debug: Sobel reference template as base64 PNG. */
  ref_template_png_b64?: string;
  /** Stage 1: how many raw contours found on the search image. */
  stage1_raw_count: number;
  /** Stage 1: how many passed aspect-ratio filter. */
  stage1_after_aspect: number;
  /** Stage 1: how many passed NMS. */
  stage1_after_nms: number;
  /** Stage 1: how many after clustering (1 per physical location). */
  stage1_clustered_count: number;
  /** Stage 2: candidates where no tree was extracted. */
  stage2_no_tree: number;
  /** Stage 2: candidates rejected because too few children matched. */
  stage2_low_children: number;
  /** Stage 2: candidates rejected because struct score < thresh. */
  stage2_low_struct: number;
  /** Stage 2: total matches after tree-matching (before final NMS). */
  stage2_matches: number;
  /** The actual detection parameters used. */
  params_used: Record<string, unknown>;
}

// ── Analog device detection job ─────────────────────────────────

export interface AnalogDetectionJob {
  dieId: string;
  status: "running" | "completed" | "failed";
  progress: number; // 0-100
  deviceCount: number;
  warnings: string[];
  startedAt: string | null;
  finishedAt: string | null;
}


// ── Read-only circuit assistant ────────────────────────────────────

/** User-supplied, non-authoritative context for one analysis request. */
export interface AssistantAnalysisBrief {
  /** Part number, die name, or family supplied by the user. */
  chipName?: string;
  /** For example: "high-voltage gate driver". */
  chipDescription?: string;
  /** For example: "BiCDMOS 0.35 µm". This is context, never proof. */
  technology?: string;
  /** Functional block or floorplan region being investigated. */
  focus?: string;
  /** Free-text engineering question, for example a request to find hysteresis. */
  prompt?: string;
  /** Optional user-known net names; they narrow ranking but do not rename nets. */
  knownNetNames?: string[];
/** Language for structured card comments. Defaults to Russian. */
  language?: "ru" | "en";
  /** Max number of hypothesis cards the full-graph model may return. Default 5. */
  maxHypotheses?: number;
}

export type AssistantAnalysisScope = "selected" | "die";
export type AssistantAnalysisMode = "functional_blocks" | "netlist_problems";
/** Free-form functional-block label the model can set on a card (e.g.
 *  "vco", "bandgap_reference", "wilson_mirror"). Known values are kept for
 *  backward compatibility/colors, but the model may use any snake_case name. */
export type AssistantFindingKind = string;
export type AssistantFindingStatus =
  | "verified_topology"
  | "candidate"
  | "needs_verification";
export type AssistantConfidenceLevel = "high" | "medium" | "low";

/** All IDs refer to the current extraction snapshot and are preview-only. */
export interface AssistantEvidenceItem {
  code: string;
  text: string;
  deviceUuids: string[];
  netIds: number[];
}

export interface AssistantFinding {
  id: string;
  kind: AssistantFindingKind;
  label: string;
  status: AssistantFindingStatus;
  confidence: number;
  confidenceLevel: AssistantConfidenceLevel;
  /** Stable IDs from the die-wide extracted device records where available. */
  deviceUuids: string[];
  /** Presentation/Netlist names paired with deviceUuids by position. */
  instanceNames: string[];
  netIds: number[];
  evidence: AssistantEvidenceItem[];
  limitations: string[];
  suggestedChecks: string[];
  /** Provenance makes heuristic rule seeds distinguishable from LLM-created hypotheses. */
  origin: "rule" | "llm";
  /** Optional explanation generated from the current read-only circuit snapshot. */
  assistantComment?: string;
  /** Set when the user corrected the card (e.g. after a discussion). */
  userCorrected?: boolean;
}

export interface AssistantCircuitDeviceInput {
  /** Canonical browser-side identity from the device registry. */
  uuid: string;
  instanceName: string;
  kind: DeviceKind;
  modelName?: string;
  terminals: DeviceTerminal[];
  geometry: DeviceGeometry;
  bbox?: AnnotationRect;
  cellId?: string;
}

/** A serialisable, read-only projection of the currently extracted circuit. */
export interface AssistantCircuitSnapshot {
  devices: AssistantCircuitDeviceInput[];
  /** Numeric IDs are the same IDs referenced by device terminals. */
  namedNets: Array<{ id: number; name: string }>;
  warnings?: string[];
  /** Available overlay layers for this die (e.g. "Si", "polysilicon", "me1"). */
  overlayLayers?: Array<{ id: string; name: string }>;
}

export interface AssistantLlmConfig {
  provider?: "openrouter" | "opencode-go" | "openai" | "custom";
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export interface AssistantAnalysisRequest {
  /** Rejects stale user actions when the annotation snapshot has changed. */
  expectedRev?: number;
  scope?: AssistantAnalysisScope;
  /** Functional-block discovery or open-ended netlist anomaly review. */
  mode?: AssistantAnalysisMode;
  /** Extracted device UUIDs selected by the user. Never changes annotations. */
  selectedDeviceUuids?: string[];
  /** Numeric net IDs from the current die-wide extraction. */
  selectedNetIds?: number[];
  /** Projection supplied from the current extraction so UUIDs/bboxes match UI exactly. */
  circuit: AssistantCircuitSnapshot;
  brief?: AssistantAnalysisBrief;
  /** Optional and disabled by default; LLM receives full normalised circuit data and produces read-only hypotheses. */
  requestLlmExplanation?: boolean;
  /** Frontend-provided LLM credentials; backend env vars are used as fallback. */
  llmConfig?: AssistantLlmConfig;
  /** Which circuit representations to include in the LLM prompt.
   *  - projectJson: rich device+nets JSON (geometry/bbox) — large, reliable on OpenRouter.
   *  - textNetlist: compact Spectre-like text with uuid comments — small, works on opencode-go.
   *  Default (undefined) behaves like projectJson=true; forward-compatible. */
  assistantDataFlags?: AssistantDataFlags;
  /** Controls whether the model may ask the user clarifying questions before
   *  producing the final hypotheses (off | auto | always). */
  clarificationMode?: AssistantClarificationMode;
  /** User replies to the model's {@link AssistantLlmState.questionSet}, supplied
   *  on the SECOND analyze call after the user answered the questions. */
  clarificationAnswers?: string[];
}

export interface AssistantLlmState {
  requested: boolean;
  used: boolean;
  /** Free Russian-language analysis from the model; shown even if no candidate can be safely mapped to a subgraph. */
  narrative?: string;
  /** Raw chain-of-thought (reasoning_content) from reasoning models, shown
   *  collapsed in the UI — the thinking behind the structured JSON answer. */
  thinking?: string;
  /** Number of structured LLM hypotheses shown as cards; no local validation gate is applied. */
  hypothesesShown?: number;
  /** End-to-end upstream request time measured on the backend. */
  durationMs?: number;
  unavailableReason?: string;
  /** When the model decided it needs user input before answering: the questions
   *  it wants answered (each a short string). Present only on the FIRST call. */
  questionSet?: string[];
  /** True when this result is "give me answers" — the UI must collect the user's
   *  replies and re-run analysis with {@link AssistantAnalysisRequest.clarificationAnswers}. */
  needClarification?: boolean;
}

export interface AssistantAnalysisResult {
  schemaVersion: 1;
  readOnly: true;
  dieId: string;
  annotationsRev: number;
  scope: AssistantAnalysisScope;
  mode: AssistantAnalysisMode;
  brief: AssistantAnalysisBrief;
  devicesAnalyzed: number;
  netlistPreview: string[];
  findings: AssistantFinding[];
  /** Read-only diagnostics describing snapshot coverage and unmatched search criteria. */
  diagnostics: string[];
  llm: AssistantLlmState;
  summary: string;
}

export interface AssistantAnalysisResponse {
  ok: true;
  data: AssistantAnalysisResult;
}

export interface AssistantAnalysisErrorResponse {
  ok: false;
  error: string;
  detail?: string;
}

/** One turn of a per-finding discussion thread. */
export interface AssistantChatMessage {
  role: "user" | "assistant";
  content: string;
  /** Present when this message represents a tool-use event (e.g. vision crop). */
  toolUse?: AssistantToolUseEvent;
  /** Present when this message carries LVS reference-library check results produced during this turn. */
  lvsResults?: Array<AssistantLvsCheckResponse["data"]>;
}

/** A tool-use event displayed as a card in the discussion thread. */
export interface AssistantToolUseEvent {
  type: "vision";
  deviceUuids: string[];
  deviceNames: string[];
  /** Base64-encoded PNG images rendered by the frontend. */
  images: string[];
  /** Human-readable name of the visible layer shown in the crops (e.g. "Si", "polysilicon", "me1"). */
  layerName?: string;
}

/** The finding context the backend needs to scope the discussion subgraph. */
export interface AssistantDiscussFinding {
  id: string;
  label: string;
  assistantComment?: string;
  deviceUuids: string[];
  netIds: number[];
  /** Current card state, surfaced to the model so it can propose accurate updates. */
  kind?: AssistantFindingKind;
  status?: AssistantFindingStatus;
  confidenceLevel?: AssistantConfidenceLevel;
  instanceNames?: string[];
  limitations?: string[];
  suggestedChecks?: string[];
}

export interface AssistantDiscussRequest {
  /** Rejects stale user actions when the annotation snapshot has changed. */
  expectedRev?: number;
  /** Finding being discussed; its deviceUuids/netIds scope the subgraph. */
  finding: AssistantDiscussFinding;
  /** Existing conversation turns (oldest first). */
  messages: AssistantChatMessage[];
  /** Projection supplied from the current extraction so UUIDs/bboxes match UI exactly. */
  circuit: AssistantCircuitSnapshot;
  /** Same user context as the analysis run, so the model reasons with the same brief. */
  brief?: AssistantAnalysisBrief;
  /** Analysis mode of the run that produced the finding. */
  mode?: AssistantAnalysisMode;
  /** Which assistant LLM tools are enabled for this run (M3 surfaces). */
  toolFlags?: AssistantToolFlags;
  /** Frontend-provided LLM credentials; backend env vars are used as fallback. */
  llmConfig?: AssistantLlmConfig;
  /** Which circuit representations to include in the prompt (projectJson / textNetlist). */
  assistantDataFlags?: AssistantDataFlags;
}

/**
 * A structured correction the model may propose at the end of a discussion.
 * Only fields the model wants to change are provided; `addDeviceUuids` /
 * `addNetIds` are merged (unioned) with the existing finding, and
 * `removeDeviceUuids` / `removeNetIds` are subtracted from it by the frontend.
 */
export interface AssistantFindingPatch {
  label?: string;
  kind?: AssistantFindingKind;
  status?: AssistantFindingStatus;
  confidenceLevel?: AssistantConfidenceLevel;
  addDeviceUuids?: string[];
  removeDeviceUuids?: string[];
  addNetIds?: number[];
  removeNetIds?: number[];
  assistantComment?: string;
  limitations?: string[];
  suggestedChecks?: string[];
}

export interface AssistantDiscussResponse {
  ok: true;
  reply: string;
  durationMs?: number;
  /** Present when the model decided the finding card should be corrected/extended. */
  cardUpdate?: AssistantFindingPatch | null;
  /** Raw LVS reference-library check results produced via mmochip_lvs_check during this turn. */
  lvsResults?: Array<AssistantLvsCheckResponse["data"]>;
}

export interface AssistantDiscussErrorResponse {
  ok: false;
  error: string;
}

// ── LVS reference-library check ───────────────────────────────

/** Which circuit data representations to include in the LLM prompt. */
export interface AssistantDataFlags {
  /** Rich device+nets JSON (geometry/bbox/center). Default true. */
  projectJson?: boolean;
  /** Compact Spectre-like text netlist with uuid comments. Default false. */
  textNetlist?: boolean;
}

/** May the model ask the user clarifying questions before analysis hypotheses?
 *  - off: never; model must produce cards (or a prose narrative) straight away.
 *  - auto: model decides — asks only when genuinely stuck on ambiguous data.
 *  - always: force one clarification round before the card-producing pass. */
export type AssistantClarificationMode = "off" | "auto" | "always";

/** Which assistant LLM tools are enabled for a run. M3 surfaces. */
export interface AssistantToolFlags {
  /** Allow the model to call mmochip_lvs_check (verify a subcircuit against the reference library). */
  lvs?: boolean;
  /** Allow the model to call mmochip_vision (crop/inspect a device image). */
  vision?: boolean;
  /** Allow the model to call mmochip_spice_sim (run ngspice simulation). */
  spice?: boolean;
  /** Path to ngspice binary (used by spice tool). */
  ngspicePath?: string;
}

export interface AssistantLvsCheckRequest {
  /** Rejects stale user actions when the annotation snapshot has changed. */
  expectedRev?: number;
  /** Extracted circuit projection (same as analysis/discuss). */
  circuit: AssistantCircuitSnapshot;
  /** Device UUIDs of the candidate subcircuit. */
  deviceUuids: string[];
  /** Reference library id (defaults to the built-in analog-circuits-sky130). */
  libraryId?: string;
  /** Max per-device-type count delta allowed when prefiltering candidates. */
  tolerance?: number;
  /** Max number of candidate cells sent to vyges-lvs. */
  budget?: number;
  /** Restrict the check to these topology groups (e.g. ["bandgap"]). When set, the backend searches across all libraries. */
  topologies?: string[];
}

export interface AssistantLvsMatch {
  cellId: string;
  topology?: string;
  matched: boolean;
  /** Structural distance (extra/missing devices) used for ranking. */
  distance: number;
  engine: "vyges-lvs";
  report: string;
  /** Devices present in the selection but absent from the reference cell (near-miss diagnostics). */
  extraDevices?: string[];
  /** Devices present in the reference cell but absent from the selection (near-miss diagnostics). */
  missingDevices?: string[];
  /** Normalized reference netlist (CDL) of the matched/near-miss cell — for display + SVG rendering. */
  referenceNetlist?: string;
}

export interface AssistantLvsCheckResponse {
  ok: true;
  data: {
    candidateSignature: Record<string, number>;
    /** Normalized candidate netlist (CDL) — the user's selection, for display + SVG rendering. */
    candidateNetlist?: string;
    /** Number of reference cells actually sent to vyges-lvs (after dedup). */
    checkedCount: number;
    /** Total reference cells in the searched group (before dedup) — for honest "checked X of Y" UI. */
    totalCells?: number;
    /** Unique topology+connectivity representatives after dedup (≤ totalCells). */
    uniqueCells?: number;
    matches: AssistantLvsMatch[];
    best: AssistantLvsMatch | null;
    /** Checked reference cells per topology (before collapsing near-misses). */
    topologyCounts?: Record<string, number>;
  };
}

export interface AssistantLvsCheckErrorResponse {
  ok: false;
  error: string;
}

/** Summary returned by GET /assistant/lvs-libraries. */
export interface AssistantLvsLibrarySummary {
  libId: string;
  cellCount: number;
  /** Topology groups available in this library, with the number of cells in each. */
  groups?: Array<{ topology: string; count: number }>;
}

// ── IC Package bond mapping ─────────────────────────────────────

/** Die transform (rotation + mirror) for aligning die image to package. */
export interface DieTransform {
  rotationDeg: number;
  mirrorX: boolean;
  mirrorY: boolean;
}

/** A single package pin with user-assigned name from datasheet. */
export interface PackagePin {
  number: number;
  name: string;
  /** X position from footprinter (mm, package-local coords). */
  x: number;
  /** Y position from footprinter (mm, package-local coords). */
  y: number;
  /** Pad width (mm) — from footprinter output. */
  w: number;
  /** Pad height (mm) — from footprinter output. */
  h: number;
}

/** A wirebond connection between a package pin and a die pad. */
export interface WireBond {
  id: string;
  pinNumber: number;
  /** IOPin.id on the die. */
  diePadId: string;
  /** Optional routed path (polyline points in world coords). */
  path?: { x: number; y: number }[];
}

/** Full IC Package configuration for bond mapping reverse engineering. */
export interface IcPackageConfig {
  /** Footprinter descriptor string, e.g. "soic8_p1.27mm". */
  footprint: string;
  pins: PackagePin[];
  bonds: WireBond[];
  transform: DieTransform;
  /** Bond wire thickness in micrometres (0.03 mm = 30 µm default). */
  bondWireWidthUm?: number;
}
