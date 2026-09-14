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
import { buildLevels } from "../dieImport/importer.js";

const DEFAULT_TILE_SIZE = 512;
const SUPPORTED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp"
]);
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
}

interface OverlayImageListItem extends Omit<OverlayImageManifest, "originalPath"> {
  legacy?: boolean;
}

function assertSafeId(value: string): void {
  if (!SAFE_ID.test(value)) throw new Error("Invalid overlay image id");
}

function dieOverlayDir(dataRoot: string, dieId: string): string {
  assertSafeId(dieId);
  return path.join(dataRoot, "overlay-images", dieId);
}

function sourceDir(dataRoot: string, dieId: string, id: string): string {
  assertSafeId(id);
  return path.join(dieOverlayDir(dataRoot, dieId), id);
}

function manifestPath(dataRoot: string, dieId: string, id: string): string {
  return path.join(sourceDir(dataRoot, dieId, id), "manifest.json");
}

export async function readManifest(
  dataRoot: string,
  dieId: string,
  id: string
): Promise<OverlayImageManifest | null> {
  try {
    const raw = await fs.readFile(manifestPath(dataRoot, dieId, id), "utf8");
    const value = JSON.parse(raw) as OverlayImageManifest;
    if (!value || value.id !== id || !value.originalPath) return null;
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function toListItem(manifest: OverlayImageManifest): OverlayImageListItem {
  const { originalPath: _originalPath, ...item } = manifest;
  return item;
}

async function listFullManifests(
  dataRoot: string,
  dieId: string
): Promise<OverlayImageManifest[]> {
  const dir = dieOverlayDir(dataRoot, dieId);
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

async function listManifests(
  dataRoot: string,
  dieId: string
): Promise<OverlayImageListItem[]> {
  return (await listFullManifests(dataRoot, dieId)).map(toListItem);
}

async function listLegacyFiles(dataRoot: string, dieId: string): Promise<OverlayImageListItem[]> {
  try {
    const dir = dieOverlayDir(dataRoot, dieId);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const images = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && /\.(png|jpe?g|webp)$/i.test(entry.name))
        .map(async (entry) => {
          const filePath = path.join(dir, entry.name);
          const stat = await fs.stat(filePath);
          return {
            id: entry.name,
            name: entry.name.replace(/\.[^.]+$/, ""),
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

async function writeManifest(manifest: OverlayImageManifest): Promise<void> {
  const target = path.join(path.dirname(manifest.originalPath), "manifest.json");
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
    sourceDir(params.dataRoot, params.dieId, params.manifest.id),
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

  const task = scheduleTileGeneration(
    params.priority,
    params.manifest.width * params.manifest.height >= HUGE_OVERLAY_PIXELS,
    params.priority < 0,
    async () => {
      const generationStartedAt = Date.now();
      const tilePath = await ensureTileImpl(params);
      return { tilePath, generationMs: Date.now() - generationStartedAt };
    }
  )
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
    sourceDir(params.dataRoot, params.dieId, manifest.id),
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
    const pipeline = sharp(manifest.originalPath, {
      limitInputPixels: false,
      sequentialRead: true
    })
      .extract({ left: sourceLeft, top: sourceTop, width: sourceWidth, height: sourceHeight })
      .resize({ width, height, fit: "fill", kernel: sharp.kernel.lanczos2 });
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

/** Resolve a tiled overlay original in the shared namespace. */
export async function resolveOverlayOriginalPath(params: {
  dataRoot: string;
  dieId: string;
  sourceId: string;
}): Promise<string | null> {
  if (!SAFE_ID.test(params.sourceId)) return null;
  const manifest = await readManifest(
    params.dataRoot,
    params.dieId,
    params.sourceId
  );
  if (!manifest) return null;
  try {
    await fs.access(manifest.originalPath);
    return manifest.originalPath;
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

  const isHuge = params.manifest.width * params.manifest.height >= HUGE_OVERLAY_PIXELS;
  const task = scheduleTileGeneration(
    -1_000_000_000,
    isHuge,
    true,
    async () => {
      const root = sourceDir(params.dataRoot, params.dieId, params.manifest.id);
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
    () => !pausedOverlayDieIds.has(params.dieId)
  )
    .then(() => undefined)
    .finally(() => pendingPyramidPrebuilds.delete(key));
  pendingPyramidPrebuilds.set(key, task);
  return task;
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
        await countTileFiles(path.join(sourceDir(dataRoot, dieId, manifest.id), "tiles"), manifest.tileFormat)
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
        if (!SUPPORTED_MIME_TYPES.has(tempFile.mimetype)) {
          response.status(400).json({ error: "Only PNG, JPEG and WebP images are supported" });
          return;
        }
        const dieId = String(request.params.dieId);
        const metadata = await sharp(tempFile.path, { limitInputPixels: false }).metadata();
        if (!metadata.width || !metadata.height) {
          response.status(400).json({ error: "Unable to read image dimensions" });
          return;
        }
        const id = crypto.randomUUID().replace(/-/g, "");
        const dir = sourceDir(config.dataRoot, dieId, id);
        await fs.mkdir(dir, { recursive: true });
        const extension = path.extname(tempFile.originalname).toLowerCase() || ".img";
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
        await writeManifest(manifest);
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
      const previewPath = await ensurePreviewImage({
        sourcePath: originalPath,
        cachePath: path.join(
          config.dataRoot,
          "dies",
          request.params.dieId,
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
      const filePath = path.join(dieOverlayDir(config.dataRoot, dieId), safeName);
      await fs.access(filePath);
      response.sendFile(filePath);
    } catch (error) {
      next(error);
    }
  });

  return router;
}