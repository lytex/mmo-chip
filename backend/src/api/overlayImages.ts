/**
 * Shared tiled overlay image storage.
 *
 * All users see the same overlay images.  Uploads are stored as an image
 * manifest plus a lazy-generated tile pyramid under a shared directory.
 * Per-user render settings (visibility, opacity, offset) live in each
 * browser's localStorage.
 *
 * Legacy flat files remain readable through the original-file route.
 */
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import sharp from "sharp";
import { ensurePreviewImage } from "../imagePreview.js";
import type { OverlayTileProgress, OverlayTileSourceProgress } from "shared";
import { resolveLayerPurpose } from "shared/layerPurpose";
import { buildLevels } from "../dieImport/importer.js";
import { resolveProjectDir } from "../projectLayout.js";
import type { PyramidSource } from "../tileCrop.js";
import { extractForScale, isPyramidalTiff } from "../dieImport/tiffPyramid.js";

const DEFAULT_TILE_SIZE = 512;
const SUPPORTED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/tiff",
  "image/x-tiff"
]);
// Browsers report the MIME type from the extension and some leave TIFF blank.
const SUPPORTED_EXTENSIONS = /\.(?:png|jpe?g|webp|tiff?)$/i;
const EXTENSION_BY_FORMAT: Record<string, string> = {
  png: ".png",
  jpeg: ".jpg",
  webp: ".webp",
  tiff: ".tif"
};
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

type TileFormat = "jpg" | "png";

export interface OverlayImageManifest {
  id: string;
  name: string;
  originalFilename: string;
  originalPath: string;
  size: number;
  width: number;
  height: number;
  tileSize: number;
  tileFormat: TileFormat;
  hasAlpha: boolean;
  maxZoomLevel: number;
  levels: ReturnType<typeof buildLevels>;
  ready: boolean;
  createdAt: string;
  updatedAt: string;
  /** Explicit user choice; null/absent means "auto-detect from the name". */
  purpose?: string | null;
}

interface OverlayImageListItem extends Omit<OverlayImageManifest, "originalPath" | "purpose"> {
  /** Effective purpose: explicit user value, or the name-based suggestion. */
  purpose: string | null;
  explicitPurpose: string | null;
  purposeSource: "user" | "auto" | "none";
  suggestedPurpose: string | null;
  /** Legacy flat files have no manifest to persist a purpose in. */
  purposeEditable: boolean;
  legacy?: boolean;
}

function assertSafeId(value: string): void {
  if (!SAFE_ID.test(value)) throw new Error("Invalid overlay image id");
}

async function dieOverlayDir(dataRoot: string, dieId: string): Promise<string> {
  assertSafeId(dieId);
  return (await resolveProjectDir(dataRoot, dieId)).overlayDir;
}

async function sourceDir(dataRoot: string, dieId: string, id: string): Promise<string> {
  assertSafeId(id);
  return path.join(await dieOverlayDir(dataRoot, dieId), id);
}

async function manifestPath(dataRoot: string, dieId: string, id: string): Promise<string> {
  return path.join(await sourceDir(dataRoot, dieId, id), "manifest.json");
}

export async function readManifest(
  dataRoot: string,
  dieId: string,
  id: string
): Promise<OverlayImageManifest | null> {
  try {
    const raw = await fs.readFile(await manifestPath(dataRoot, dieId, id), "utf8");
    const value = JSON.parse(raw) as OverlayImageManifest;
    if (!value || value.id !== id || !value.originalPath) return null;
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function toListItem(manifest: OverlayImageManifest): OverlayImageListItem {
  const { originalPath: _originalPath, purpose, ...item } = manifest;
  const resolved = resolveLayerPurpose(purpose ?? null, manifest.name);
  return {
    ...item,
    purpose: resolved.purpose,
    explicitPurpose: resolved.explicit,
    purposeSource: resolved.source,
    suggestedPurpose: resolved.suggested,
    purposeEditable: true
  };
}

async function listFullManifests(
  dataRoot: string,
  dieId: string
): Promise<OverlayImageManifest[]> {
  const dir = await dieOverlayDir(dataRoot, dieId);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const manifests = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && SAFE_ID.test(entry.name))
        .map((entry) => readManifest(dataRoot, dieId, entry.name))
    );
    return manifests
      .filter((item): item is OverlayImageManifest => item !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function listManifests(
  dataRoot: string,
  dieId: string
): Promise<OverlayImageListItem[]> {
  return (await listFullManifests(dataRoot, dieId)).map(toListItem);
}

async function listLegacyFiles(dataRoot: string, dieId: string): Promise<OverlayImageListItem[]> {
  try {
    const dir = await dieOverlayDir(dataRoot, dieId);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const images = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && /\.(png|jpe?g|webp)$/i.test(entry.name))
        .map(async (entry) => {
          const filePath = path.join(dir, entry.name);
          const stat = await fs.stat(filePath);
          const name = entry.name.replace(/\.[^.]+$/, "");
          const resolved = resolveLayerPurpose(null, name);
          return {
            id: entry.name,
            name,
            originalFilename: entry.name,
            size: stat.size,
            width: 0,
            height: 0,
            tileSize: DEFAULT_TILE_SIZE,
            tileFormat: "jpg" as TileFormat,
            hasAlpha: false,
            maxZoomLevel: 0,
            levels: [],
            ready: true,
            createdAt: stat.birthtime.toISOString(),
            updatedAt: stat.mtime.toISOString(),
            purpose: resolved.purpose,
            explicitPurpose: null,
            purposeSource: resolved.source,
            suggestedPurpose: resolved.suggested,
            purposeEditable: false,
            legacy: true
          } satisfies OverlayImageListItem;
        })
    );
    return images.sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeManifest(
  dataRoot: string,
  dieId: string,
  manifest: OverlayImageManifest
): Promise<void> {
  // Never derive the manifest location from `originalPath`: a folder project
  // that was copied or moved between machines keeps a stale absolute original
  // path, which made purpose saves fail with ENOENT (surfaced as 404 "Not
  // found"). The source directory is authoritative.
  const target = await manifestPath(dataRoot, dieId, manifest.id);
  const dir = path.dirname(target);
  const localOriginal = path.join(dir, path.basename(manifest.originalPath));
  if (manifest.originalPath !== localOriginal) {
    try {
      await fs.access(localOriginal);
      // Repair the stale path while we are here so tiles/CV readers need no
      // fallback lookup.
      manifest.originalPath = localOriginal;
    } catch {
      // The original really lives elsewhere; keep the recorded path.
    }
  }
  const temp = `${target}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(manifest, null, 2), "utf8");
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

// A compact interactive pool gets the currently visible viewport onto the
// screen sooner. A cold JPEG crop is not random-access: libvips must decode the
// large source image before it can extract a native-resolution 512px tile.
const MAX_CONCURRENT_TILE_GENERATIONS = Math.max(
  2,
  Math.min(8, Number(process.env.TILE_GENERATION_CONCURRENCY ?? 0) ||
    Math.min(4, Math.max(2, os.availableParallelism?.() ?? 4)))
);
// One 31,774 × 15,355 RGB image expands to roughly 1.36 GiB during decode.
// Never run several such decodes together on a 16 GiB workstation; normal
// smaller overlays can still use the shared pool in parallel.
const HUGE_OVERLAY_PIXELS = 100_000_000;
const MAX_CONCURRENT_HUGE_OVERLAY_GENERATIONS = 2;
// Reserve one huge-decode slot for a freshly visible tile. Full-pyramid work
// consumes at most the other slot, so it cannot make a viewport wait behind it.
const MAX_CONCURRENT_HUGE_OVERLAY_BACKGROUND_GENERATIONS = 1;

/**
 * Whether cutting a tile means decoding a huge image. A pyramidal TIFF never
 * does: every tile comes from a small region of its closest stored level.
 */
async function isHugeOverlay(manifest: OverlayImageManifest): Promise<boolean> {
  return (
    manifest.width * manifest.height >= HUGE_OVERLAY_PIXELS &&
    !(await isPyramidalTiff(manifest.originalPath))
  );
}

interface TileGenerationResult {
  tilePath: string;
  cache: "disk" | "generated";
  queueMs: number;
  generationMs: number;
}

interface QueuedTileGeneration {
  priority: number;
  sequence: number;
  isHuge: boolean;
  background: boolean;
  canRun: () => boolean;
  run: () => void;
}

interface OverlayPrebuildState {
  status: "queued" | "generating" | "completed";
  completedTiles: number;
  totalTiles: number;
  stagingRoot: string | null;
  diskScanned: boolean;
}

const pendingTileGenerations = new Map<string, Promise<TileGenerationResult>>();
const tileGenerationQueue: QueuedTileGeneration[] = [];
let activeTileGenerations = 0;
let activeHugeOverlayGenerations = 0;
let activeHugeOverlayBackgroundGenerations = 0;
let tileGenerationSequence = 0;
const pendingPyramidPrebuilds = new Map<string, Promise<void>>();
const overlayPrebuildStates = new Map<string, OverlayPrebuildState>();
const pausedOverlayDieIds = new Set<string>();
/** Prebuild keys of sources deleted while a prebuild may still be running. */
const deletedOverlaySources = new Set<string>();

function drainTileGenerationQueue(): void {
  while (
    activeTileGenerations < MAX_CONCURRENT_TILE_GENERATIONS &&
    tileGenerationQueue.length > 0
  ) {
    const nextIndex = tileGenerationQueue.findIndex((candidate) => {
      if (!candidate.canRun()) return false;
      if (!candidate.isHuge) return true;
      if (activeHugeOverlayGenerations >= MAX_CONCURRENT_HUGE_OVERLAY_GENERATIONS) return false;
      return !candidate.background ||
        activeHugeOverlayBackgroundGenerations < MAX_CONCURRENT_HUGE_OVERLAY_BACKGROUND_GENERATIONS;
    });
    if (nextIndex < 0) return;
    const [next] = tileGenerationQueue.splice(nextIndex, 1);
    if (!next) return;
    activeTileGenerations += 1;
    if (next.isHuge) {
      activeHugeOverlayGenerations += 1;
      if (next.background) activeHugeOverlayBackgroundGenerations += 1;
    }
    next.run();
  }
}

function scheduleTileGeneration<T>(
  priority: number,
  isHuge: boolean,
  background: boolean,
  work: () => Promise<T>,
  canRun: () => boolean = () => true
): Promise<{ value: T; queueMs: number }> {
  const enqueuedAt = Date.now();
  return new Promise((resolve, reject) => {
    tileGenerationQueue.push({
      priority,
      sequence: tileGenerationSequence++,
      isHuge,
      background,
      canRun,
      run: () => {
        const startedAt = Date.now();
        void work()
          .then((value) => resolve({ value, queueMs: startedAt - enqueuedAt }), reject)
          .finally(() => {
            activeTileGenerations -= 1;
            if (isHuge) {
              activeHugeOverlayGenerations -= 1;
              if (background) activeHugeOverlayBackgroundGenerations -= 1;
            }
            drainTileGenerationQueue();
          });
      }
    });
    // Stable priority ordering: higher priority first, FIFO for equal priority.
    tileGenerationQueue.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
    drainTileGenerationQueue();
  });
}

async function ensureTile(params: {
  manifest: OverlayImageManifest;
  dataRoot: string;
  dieId: string;
  z: number;
  x: number;
  y: number;
  priority: number;
}): Promise<TileGenerationResult> {
  const target = path.join(
    await sourceDir(params.dataRoot, params.dieId, params.manifest.id),
    "tiles",
    String(params.z),
    `${params.x}_${params.y}.${params.manifest.tileFormat}`
  );
  try {
    await fs.access(target);
    return { tilePath: target, cache: "disk", queueMs: 0, generationMs: 0 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const key = `${params.dieId}/${params.manifest.id}/${params.z}/${params.x}/${params.y}`;
  const existing = pendingTileGenerations.get(key);
  if (existing) return existing;

  const task = isHugeOverlay(params.manifest).then((isHuge) => scheduleTileGeneration(
    params.priority,
    isHuge,
    params.priority < 0,
    async () => {
      const generationStartedAt = Date.now();
      const tilePath = await ensureTileImpl(params);
      return { tilePath, generationMs: Date.now() - generationStartedAt };
    }
  ))
    .then(({ value, queueMs }) => ({
      tilePath: value.tilePath,
      cache: "generated" as const,
      queueMs,
      generationMs: value.generationMs
    }))
    .finally(() => pendingTileGenerations.delete(key));
  pendingTileGenerations.set(key, task);
  return task;
}

async function ensureTileImpl(params: {
  manifest: OverlayImageManifest;
  dataRoot: string;
  dieId: string;
  z: number;
  x: number;
  y: number;
}): Promise<string> {
  const { manifest, z, x, y } = params;
  const level = manifest.levels[z];
  if (!level || x < 0 || y < 0 || x >= level.columns || y >= level.rows) {
    throw new Error("Tile coordinates out of range");
  }
  const ext = manifest.tileFormat;
  const target = path.join(
    await sourceDir(params.dataRoot, params.dieId, manifest.id),
    "tiles",
    String(z),
    `${x}_${y}.${ext}`
  );
  try {
    await fs.access(target);
    return target;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const left = x * manifest.tileSize;
  const top = y * manifest.tileSize;
  const width = Math.min(manifest.tileSize, level.width - left);
  const height = Math.min(manifest.tileSize, level.height - top);
  const sourceLeft = left * level.scale;
  const sourceTop = top * level.scale;
  const sourceWidth = Math.min(manifest.width - sourceLeft, width * level.scale);
  const sourceHeight = Math.min(manifest.height - sourceTop, height * level.scale);
  if (sourceWidth <= 0 || sourceHeight <= 0) throw new Error("Tile outside image");

  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    const source = await extractForScale(
      manifest.originalPath,
      level.scale,
      { left: sourceLeft, top: sourceTop, width: sourceWidth, height: sourceHeight },
      { limitInputPixels: false, sequentialRead: true }
    );
    const pipeline = source.resize({ width, height, fit: "fill", kernel: sharp.kernel.lanczos2 });
    if (manifest.tileFormat === "png") {
      await pipeline.png({ compressionLevel: 6 }).toFile(temp);
    } else {
      await pipeline.jpeg({ quality: 85, chromaSubsampling: "4:2:0" }).toFile(temp);
    }
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  return target;
}

/**
 * Tile pyramid (already-built tiles only) and original of an overlay, for
 * cell crop assembly (tileCrop.ts).
 */
export async function getOverlayCropSource(params: {
  dataRoot: string;
  dieId: string;
  sourceId: string;
}): Promise<{ pyramid: PyramidSource; originalPath: string } | null> {
  if (!SAFE_ID.test(params.sourceId)) return null;
  const manifest = await readManifest(params.dataRoot, params.dieId, params.sourceId);
  if (!manifest || manifest.levels.length === 0) return null;
  const tilesDir = path.join(await sourceDir(params.dataRoot, params.dieId, manifest.id), "tiles");
  return {
    originalPath: manifest.originalPath,
    pyramid: {
      levels: manifest.levels,
      tileSize: manifest.tileSize,
      peekTile: async (z, x, y) => {
        const tilePath = path.join(tilesDir, String(z), `${x}_${y}.${manifest.tileFormat}`);
        try {
          await fs.access(tilePath);
          return tilePath;
        } catch {
          return null;
        }
      }
    }
  };
}

/**
 * Resolve a tiled source's original, or a legacy flat file in the same overlay
 * directory.  CV/ML pass the top visible layer's `serverFilename`, which is a
 * manifest id for tiled sources but the bare filename (with extension) for
 * legacy ones; both must resolve or the module reports a missing source.
 */
export async function resolveOverlayOriginalPath(params: {
  dataRoot: string;
  dieId: string;
  sourceId: string;
}): Promise<string | null> {
  if (SAFE_ID.test(params.sourceId)) {
    const manifest = await readManifest(
      params.dataRoot,
      params.dieId,
      params.sourceId
    );
    if (manifest) {
      try {
        await fs.access(manifest.originalPath);
        return manifest.originalPath;
      } catch {
        // Folder projects can be moved/copied between machines, leaving the
        // absolute path stale; the original still sits beside the manifest.
        try {
          const besideManifest = path.join(
            await sourceDir(params.dataRoot, params.dieId, params.sourceId),
            path.basename(manifest.originalPath)
          );
          await fs.access(besideManifest);
          return besideManifest;
        } catch {
          return null;
        }
      }
    }
  }
  const safeName = path.basename(params.sourceId);
  if (safeName !== params.sourceId || !/\.(png|jpe?g|webp|tiff?)$/i.test(safeName)) {
    return null;
  }
  try {
    const legacyPath = path.join(await dieOverlayDir(params.dataRoot, params.dieId), safeName);
    await fs.access(legacyPath);
    return legacyPath;
  } catch {
    return null;
  }
}

export async function preGenerateCoarseLevels(params: {
  manifest: OverlayImageManifest;
  dataRoot: string;
  dieId: string;
}): Promise<void> {
  // Level 0 is normally one tile; level 1 is still tiny.  Run this as idle
  // work only: every interactive viewport request has a newer positive epoch.
  const levels = params.manifest.levels.slice(0, 2);
  await Promise.all(
    levels.flatMap((level) => {
      const jobs: Array<Promise<TileGenerationResult>> = [];
      for (let x = 0; x < level.columns; x += 1) {
        for (let y = 0; y < level.rows; y += 1) {
          jobs.push(
            ensureTile({
              ...params,
              z: level.z,
              x,
              y,
              priority: -1_000_000_000
            })
          );
        }
      }
      return jobs;
    })
  );
}

/**
 * Generate every level of one overlay pyramid in a single libvips pipeline.
 * This decodes the huge original once, unlike the former per-tile fallback
 * which reopened it for each native-resolution 512px crop.  Output is staged
 * beside the source, then only missing tiles are moved into the live cache.
 */
export function preGenerateFullPyramid(params: {
  manifest: OverlayImageManifest;
  dataRoot: string;
  dieId: string;
}): Promise<void> {
  const key = overlayPrebuildKey(params.dieId, params.manifest.id);
  const running = pendingPyramidPrebuilds.get(key);
  if (running) return running;

  const totalTiles = totalTilesForManifest(params.manifest);
  const state = overlayPrebuildStates.get(key) ?? {
    status: "queued" as const,
    completedTiles: 0,
    totalTiles,
    stagingRoot: null,
    diskScanned: false
  };
  state.totalTiles = totalTiles;
  state.status = state.completedTiles >= totalTiles ? "completed" : "queued";
  overlayPrebuildStates.set(key, state);

  const task = isPyramidalTiff(params.manifest.originalPath).then((pyramidal) =>
    pyramidal ? prebuildFromStoredLevels(params, state) : prebuildInOnePass(params, state)
  )
    .finally(() => pendingPyramidPrebuilds.delete(key));
  pendingPyramidPrebuilds.set(key, task);
  return task;
}

/** Number of tiles cut concurrently by a stored-levels prebuild. */
const STORED_LEVEL_PREBUILD_CONCURRENCY = 2;

/**
 * Full prebuild of a pyramidal TIFF: each tile is a cheap cut from a stored
 * level, so go tile by tile (coarse levels first) through the shared queue at
 * background priority instead of decoding the full-resolution image at once.
 * A pause stops after the current batch; a later prebuild skips tiles on disk.
 */
async function prebuildFromStoredLevels(
  params: { manifest: OverlayImageManifest; dataRoot: string; dieId: string },
  state: OverlayPrebuildState
): Promise<void> {
  const { manifest } = params;
  const totalTiles = totalTilesForManifest(manifest);
  const root = await sourceDir(params.dataRoot, params.dieId, manifest.id);
  const tilesOnDisk = Math.min(
    totalTiles,
    await countTileFiles(path.join(root, "tiles"), manifest.tileFormat)
  );
  state.completedTiles = tilesOnDisk;
  state.diskScanned = true;
  if (state.completedTiles >= totalTiles) {
    state.status = "completed";
    return;
  }

  const label = `${params.dieId}/${manifest.id}`;
  console.log(`[overlay-prebuild:${label}] started from stored TIFF levels`);
  state.status = "generating";
  const coords = manifest.levels.flatMap((level) =>
    Array.from({ length: level.columns * level.rows }, (_, i) => ({
      z: level.z,
      x: i % level.columns,
      y: Math.floor(i / level.columns)
    }))
  );
  for (let i = 0; i < coords.length; i += STORED_LEVEL_PREBUILD_CONCURRENCY) {
    if (deletedOverlaySources.has(overlayPrebuildKey(params.dieId, manifest.id))) return;
    if (pausedOverlayDieIds.has(params.dieId)) {
      state.status = "queued";
      console.log(`[overlay-prebuild:${label}] paused`);
      return;
    }
    const batch = coords.slice(i, i + STORED_LEVEL_PREBUILD_CONCURRENCY);
    await Promise.all(
      batch.map((coord) => ensureTile({ ...params, ...coord, priority: -1_000_000_000 }))
    );
    // Both the startup scan and the tiles walked so far are lower bounds of
    // what is on disk. Counting each "generated" result on top of the scan
    // could count a viewport tile twice and report completion too early.
    state.completedTiles = Math.max(tilesOnDisk, i + batch.length);
  }
  state.completedTiles = totalTiles;
  state.status = "completed";
  console.log(`[overlay-prebuild:${label}] completed from stored TIFF levels`);
}

function prebuildInOnePass(
  params: { manifest: OverlayImageManifest; dataRoot: string; dieId: string },
  state: OverlayPrebuildState
): Promise<void> {
  const totalTiles = totalTilesForManifest(params.manifest);
  const isHuge = params.manifest.width * params.manifest.height >= HUGE_OVERLAY_PIXELS;
  return scheduleTileGeneration(
    -1_000_000_000,
    isHuge,
    true,
    async () => {
      const root = await sourceDir(params.dataRoot, params.dieId, params.manifest.id);
      const targetTiles = path.join(root, "tiles");
      const existingTiles = await countTileFiles(targetTiles, params.manifest.tileFormat);
      state.completedTiles = Math.min(totalTiles, existingTiles);
      state.diskScanned = true;
      if (state.completedTiles >= totalTiles) {
        state.status = "completed";
        return;
      }

      const stagingRoot = path.join(root, `tiles-prebuild-${crypto.randomUUID()}`);
      const outputBase = path.join(stagingRoot, "pyramid.dz");
      const generatedTiles = path.join(stagingRoot, "pyramid_files");
      const label = `${params.dieId}/${params.manifest.id}`;
      state.status = "generating";
      state.stagingRoot = stagingRoot;
      try {
        await fs.mkdir(stagingRoot, { recursive: true });
        console.log(`[overlay-prebuild:${label}] started full pyramid`);
        const image = sharp(params.manifest.originalPath, {
          limitInputPixels: false,
          sequentialRead: true
        });
        if (params.manifest.tileFormat === "png") {
          image.png({ compressionLevel: 6 });
        } else {
          image.jpeg({ quality: 85, chromaSubsampling: "4:2:0" });
        }
        await image
          .tile({ size: params.manifest.tileSize, layout: "dz", depth: "onetile" })
          .toFile(outputBase);
        state.completedTiles = totalTiles;
        await mergePrebuiltTiles(generatedTiles, targetTiles, params.manifest.tileFormat);
        state.status = "completed";
        console.log(`[overlay-prebuild:${label}] completed full pyramid`);
      } finally {
        state.stagingRoot = null;
        await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
      }
    },
    () =>
      !pausedOverlayDieIds.has(params.dieId) &&
      !deletedOverlaySources.has(overlayPrebuildKey(params.dieId, params.manifest.id))
  ).then(() => undefined);
}

/** Queue full overlay prebuild for every source of one project. */
export async function enqueueOverlayPrebuilds(dataRoot: string, dieId: string): Promise<void> {
  const manifests = await listFullManifests(dataRoot, dieId);
  for (const manifest of manifests) {
    void preGenerateFullPyramid({ dataRoot, dieId, manifest }).catch((error) => {
      console.warn(`[overlay-prebuild:${dieId}/${manifest.id}] failed`, error);
    });
  }
}

export function pauseOverlayPrebuilds(dieId: string): void {
  pausedOverlayDieIds.add(dieId);
}

export async function resumeOverlayPrebuilds(dataRoot: string, dieId: string): Promise<void> {
  pausedOverlayDieIds.delete(dieId);
  await enqueueOverlayPrebuilds(dataRoot, dieId);
  drainTileGenerationQueue();
}

export async function getOverlayTileProgress(
  dataRoot: string,
  dieId: string
): Promise<OverlayTileProgress> {
  const manifests = await listFullManifests(dataRoot, dieId);
  const isPaused = pausedOverlayDieIds.has(dieId);
  const sources: OverlayTileSourceProgress[] = await Promise.all(manifests.map(async (manifest) => {
    const key = overlayPrebuildKey(dieId, manifest.id);
    const totalTiles = totalTilesForManifest(manifest);
    let state = overlayPrebuildStates.get(key);
    if (!state) {
      state = {
        status: "queued",
        completedTiles: 0,
        totalTiles,
        stagingRoot: null,
        diskScanned: false
      };
      overlayPrebuildStates.set(key, state);
    }
    if (!state.diskScanned) {
      state.completedTiles = Math.min(
        totalTiles,
        await countTileFiles(path.join(await sourceDir(dataRoot, dieId, manifest.id), "tiles"), manifest.tileFormat)
      );
      state.diskScanned = true;
      if (state.completedTiles >= totalTiles) state.status = "completed";
    }
    let completedTiles = state.completedTiles;
    if (state.stagingRoot) {
      const stagedTiles = await countTileFiles(
        path.join(state.stagingRoot, "pyramid_files"),
        manifest.tileFormat === "jpg" ? "jpeg" : "png"
      );
      completedTiles = Math.max(completedTiles, Math.min(totalTiles, stagedTiles));
    }
    const status = completedTiles >= totalTiles
      ? "completed"
      : isPaused
      ? "paused"
      : state.status;
    return {
      id: manifest.id,
      name: manifest.name,
      completedTiles,
      totalTiles,
      percentage: totalTiles === 0 ? 100 : (completedTiles / totalTiles) * 100,
      status
    };
  }));
  const completedTiles = sources.reduce((sum, source) => sum + source.completedTiles, 0);
  const totalTiles = sources.reduce((sum, source) => sum + source.totalTiles, 0);
  return {
    completedTiles,
    totalTiles,
    percentage: totalTiles === 0 ? 100 : (completedTiles / totalTiles) * 100,
    isPaused,
    sources
  };
}

function overlayPrebuildKey(dieId: string, sourceId: string): string {
  return `${dieId}/${sourceId}`;
}

function totalTilesForManifest(manifest: OverlayImageManifest): number {
  return manifest.levels.reduce((sum, level) => sum + level.columns * level.rows, 0);
}

async function countTileFiles(root: string, extension: string): Promise<number> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let count = 0;
  const expected = `.${extension.toLowerCase()}`;
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) count += await countTileFiles(entryPath, extension);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(expected)) count += 1;
  }
  return count;
}

async function mergePrebuiltTiles(
  generatedRoot: string,
  targetRoot: string,
  tileFormat: TileFormat
): Promise<void> {
  const files = await collectFiles(generatedRoot);
  for (const sourcePath of files) {
    let relative = path.relative(generatedRoot, sourcePath);
    // Skip libvips metadata. Live cache contains only files addressable by the
    // existing /tiles/:z/:x/:y URL contract.
    if (!/^[0-9]+[\\/][0-9]+_[0-9]+\.(?:jpeg|png)$/i.test(relative)) continue;
    // libvips names JPEG tiles .jpeg, while the existing MMO cache contract
    // uses .jpg. Keep every current URL and manifest compatible.
    if (tileFormat === "jpg" && relative.toLowerCase().endsWith(".jpeg")) {
      relative = `${relative.slice(0, -4)}jpg`;
    }
    const targetPath = path.join(targetRoot, relative);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    try {
      await fs.access(targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await fs.rename(sourcePath, targetPath);
    }
  }
}

async function collectFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

/**
 * Delete one overlay source for everyone: a tiled source's folder (original,
 * manifest, tiles) or a legacy flat file, plus its cached preview. A prebuild
 * still running for it is stopped, and its folder removed again once it
 * settles (tile writes may recreate it). Returns false when nothing matched.
 */
export async function deleteOverlaySource(dataRoot: string, dieId: string, id: string): Promise<boolean> {
  assertSafeId(dieId);
  const { dir: projectDir } = await resolveProjectDir(dataRoot, dieId);
  const preview = path.join(projectDir, "previews", `overlay-${path.basename(id)}.4096.jpg`);
  if (SAFE_ID.test(id)) {
    const dir = await sourceDir(dataRoot, dieId, id);
    if (!(await readManifest(dataRoot, dieId, id))) return false;
    const key = overlayPrebuildKey(dieId, id);
    deletedOverlaySources.add(key);
    overlayPrebuildStates.delete(key);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(preview, { force: true });
    const running = pendingPyramidPrebuilds.get(key);
    if (running) {
      void running
        .catch(() => {})
        .then(() => fs.rm(dir, { recursive: true, force: true }))
        .catch(() => {});
    }
    return true;
  }
  const safeName = path.basename(id);
  if (safeName !== id || !/\.(png|jpe?g|webp)$/i.test(safeName)) return false;
  try {
    await fs.rm(path.join(await dieOverlayDir(dataRoot, dieId), safeName));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  await fs.rm(preview, { force: true });
  return true;
}

export function createOverlayImagesRouter(config: { dataRoot: string }) {
  const router = Router();
  const upload = multer({ dest: path.join(config.dataRoot, "tmp") });

  router.get("/api/dies/:dieId/overlay-images/list", async (request, response, next) => {
    try {
      const dieId = String(request.params.dieId);
      const personal = await listManifests(config.dataRoot, dieId);
      const legacy = await listLegacyFiles(config.dataRoot, dieId);
      response.json({ images: [...legacy, ...personal] });
    } catch (error) {
      next(error);
    }
  });

  // Rebuild/resume the complete disk cache for imported projects created before
  // full overlay prebuild was enabled. Requests return immediately; the shared
  // background pool performs sources one at a time for huge originals.
  router.post("/api/dies/:dieId/overlay-images/prebuild", async (request, response, next) => {
    try {
      const dieId = String(request.params.dieId);
      const manifests = await listFullManifests(config.dataRoot, dieId);
      for (const manifest of manifests) {
        void preGenerateFullPyramid({ dataRoot: config.dataRoot, dieId, manifest }).catch((error) => {
          console.warn(`[overlay-prebuild:${dieId}/${manifest.id}] failed`, error);
        });
      }
      response.status(202).json({ ok: true, sources: manifests.length });
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/api/dies/:dieId/overlay-images/upload",
    upload.single("file"),
    async (request, response, next) => {
      const tempFile = request.file;
      try {
        if (!tempFile) {
          response.status(400).json({ error: "No file uploaded" });
          return;
        }
        const unsupported = { error: "Only PNG, JPEG, WebP and TIFF images are supported" };
        if (
          !SUPPORTED_MIME_TYPES.has(tempFile.mimetype) &&
          !SUPPORTED_EXTENSIONS.test(tempFile.originalname)
        ) {
          response.status(400).json(unsupported);
          return;
        }
        const dieId = String(request.params.dieId);
        const metadata = await sharp(tempFile.path, { limitInputPixels: false }).metadata();
        // Trust the decoded format over the client-supplied MIME type; the
        // stored extension also decides whether TIFF levels are looked for.
        const extension = metadata.format ? EXTENSION_BY_FORMAT[metadata.format] : undefined;
        if (!extension) {
          await fs.rm(tempFile.path, { force: true }).catch(() => {});
          response.status(400).json(unsupported);
          return;
        }
        if (!metadata.width || !metadata.height) {
          response.status(400).json({ error: "Unable to read image dimensions" });
          return;
        }
        const id = crypto.randomUUID().replace(/-/g, "");
        const dir = await sourceDir(config.dataRoot, dieId, id);
        await fs.mkdir(dir, { recursive: true });
        const originalPath = path.join(dir, `original${extension}`);
        await fs.rename(tempFile.path, originalPath);
        const maxDimension = Math.max(metadata.width, metadata.height);
        const maxZoomLevel = Math.max(0, Math.ceil(Math.log2(maxDimension / DEFAULT_TILE_SIZE)));
        const now = new Date().toISOString();
        const manifest: OverlayImageManifest = {
          id,
          name: tempFile.originalname.replace(/\.[^.]+$/, "") || "image",
          originalFilename: tempFile.originalname,
          originalPath,
          size: tempFile.size,
          width: metadata.width,
          height: metadata.height,
          tileSize: DEFAULT_TILE_SIZE,
          tileFormat: metadata.hasAlpha ? "png" : "jpg",
          hasAlpha: Boolean(metadata.hasAlpha),
          maxZoomLevel,
          levels: buildLevels(metadata.width, metadata.height, DEFAULT_TILE_SIZE, maxZoomLevel),
          ready: true,
          createdAt: now,
          updatedAt: now
        };
        await writeManifest(config.dataRoot, dieId, manifest);
        // Start preview preparation only after an idle grace period. This gives
        // the UI time to issue its first interactive requests, which must always
        // obtain the worker slots ahead of background coarse generation.
        setTimeout(() => {
          void preGenerateFullPyramid({
            manifest,
            dataRoot: config.dataRoot,
            dieId
          }).catch((error) => {
            console.warn("Failed to pre-generate overlay tile pyramid", error);
          });
        }, 750);
        response.status(201).json({ image: toListItem(manifest) });
      } catch (error) {
        if (tempFile) await fs.rm(tempFile.path, { force: true }).catch(() => {});
        next(error);
      }
    }
  );

  router.patch("/api/dies/:dieId/overlay-images/:id", async (request, response, next) => {
    try {
      const { dieId, id } = request.params;
      if (!SAFE_ID.test(dieId) || !SAFE_ID.test(id)) {
        response.status(400).json({ error: "Invalid id" });
        return;
      }
      const manifest = await readManifest(config.dataRoot, dieId, id);
      if (!manifest) {
        response.status(404).json({ error: "Overlay image not found or not editable" });
        return;
      }
      const body = (request.body ?? {}) as { purpose?: unknown };
      if (body.purpose !== undefined && body.purpose !== null && typeof body.purpose !== "string") {
        response.status(400).json({ error: "purpose must be a string or null" });
        return;
      }
      const raw = typeof body.purpose === "string" ? body.purpose.trim() : "";
      // An empty string / "auto" clears the explicit value; "none" is kept as
      // an explicit suppression of the name heuristic.
      manifest.purpose = raw && raw.toLowerCase() !== "auto" ? raw.slice(0, 80) : null;
      manifest.updatedAt = new Date().toISOString();
      await writeManifest(config.dataRoot, dieId, manifest);
      response.json({ image: toListItem(manifest) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/dies/:dieId/overlay-images/:id/tiles/:z/:x/:y", async (request, response, next) => {
    try {
      const { dieId, id, z, x, y } = request.params;
      if (!SAFE_ID.test(id) || ![z, x, y].every((part) => /^\d+$/.test(part))) {
        response.status(400).json({ error: "Invalid tile coordinates" });
        return;
      }
      const manifest = await readManifest(config.dataRoot, dieId, id);
      if (!manifest) {
        response.status(404).json({ error: "Overlay image not found" });
        return;
      }
      const requestStartedAt = Date.now();
      const requestedPriority = Number(request.query.p ?? 0);
      // Browser priority includes a monotonically increasing viewport epoch.
      // Do not clamp it: a fresh viewport must outrank stale queued work.
      const priority = Number.isFinite(requestedPriority)
        ? Math.round(requestedPriority)
        : 0;
      const tile = await ensureTile({
        manifest,
        dataRoot: config.dataRoot,
        dieId,
        z: Number(z),
        x: Number(x),
        y: Number(y),
        priority
      });
      const requestMs = Date.now() - requestStartedAt;
      response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      response.setHeader("X-Tile-Cache", tile.cache);
      response.setHeader("X-Tile-Queue-Ms", String(tile.queueMs));
      response.setHeader("X-Tile-Generation-Ms", String(tile.generationMs));
      response.setHeader(
        "Server-Timing",
        `tile;dur=${requestMs}, queue;dur=${tile.queueMs}, generate;dur=${tile.generationMs}`
      );
      response.sendFile(tile.tilePath);
    } catch (error) {
      if (error instanceof Error && /Tile (coordinates|outside)/.test(error.message)) {
        response.status(404).json({ error: "Tile not found" });
        return;
      }
      next(error);
    }
  });

  router.get("/api/dies/:dieId/overlay-images/:id/original", async (request, response, next) => {
    try {
      const originalPath = await resolveOverlayOriginalPath({
        dataRoot: config.dataRoot,
        dieId: request.params.dieId,
        sourceId: request.params.id
      });
      if (!originalPath) {
        response.status(404).json({ error: "Overlay image not found" });
        return;
      }
      // Serve a downscaled cached JPEG; the IC Package view only ever shows
      // the overlay as a ≤4096px background, so the full original (which can
      // be tens of thousands of pixels) never has to reach the browser.
      const { dir: projectDir } = await resolveProjectDir(config.dataRoot, request.params.dieId);
      const previewPath = await ensurePreviewImage({
        sourcePath: originalPath,
        cachePath: path.join(
          projectDir,
          "previews",
          `overlay-${request.params.id}.4096.jpg`
        )
      });
      response.setHeader("Cache-Control", "public, max-age=86400");
      response.type("image/jpeg");
      response.sendFile(previewPath);
    } catch (error) {
      next(error);
    }
  });

  router.delete("/api/dies/:dieId/overlay-images/:id", async (request, response, next) => {
    try {
      const deleted = await deleteOverlaySource(config.dataRoot, request.params.dieId, request.params.id);
      if (!deleted) {
        response.status(404).json({ error: "Overlay image not found" });
        return;
      }
      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  // Backward-compatible legacy original route.  New tiled sources must use
  // `/:id/original`; do not let arbitrary filenames escape this directory.
  router.get("/api/dies/:dieId/overlay-images/:filename", async (request, response, next) => {
    try {
      const { dieId, filename } = request.params;
      const safeName = path.basename(filename);
      if (safeName !== filename || !/\.(png|jpe?g|webp)$/i.test(safeName)) {
        response.status(400).json({ error: "Invalid filename" });
        return;
      }
      const filePath = path.join(await dieOverlayDir(config.dataRoot, dieId), safeName);
      await fs.access(filePath);
      response.sendFile(filePath);
    } catch (error) {
      next(error);
    }
  });

  return router;
}