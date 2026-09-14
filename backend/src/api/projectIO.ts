/**
 * projectIO.ts — Export / Import project bundles (ZIP).
 *
 * Export:  POST /api/dies/:dieId/export-project
 * Import:  POST /api/dies/import-project
 *
 * Export modes:
 *   light — annotations + metadata + SPICE config + netlists only
 *   full  — light + original die image(s) + overlay images
 *
 * Import: accepts a ZIP (produced by export) and reconstructs the die.
 *         On conflict (existing dieId) returns 409 with die info.
 *         Use ?name=XXX to import under a new name/ID.
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { ZipArchive } from "archiver";
import type { Archiver } from "archiver";
import { MAX_PROJECT_ARCHIVE_BYTES, ZipStreamError, ZipStreamReader, type ZipEntry } from "./zipStream.js";
import {
  preGenerateFullPyramid,
  type OverlayImageManifest
} from "./overlayImages.js";
import { listDieRecords, readDieRecord, writeDieRecord } from "../store.js";
import type { createTileScheduler } from "../tileScheduler.js";
import type { DieRecord } from "../types.js";

// ═════════════════════════════════════════════════════════════════════
// Helpers
// ═════════════════════════════════════════════════════════════════════

function sanitizeName(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function deriveId(name: string): string {
  const hash = createHash("sha256")
    .update(name + Date.now())
    .digest("hex")
    .slice(0, 12);
  return `import-${hash}`;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function readJsonSafe<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

const SAFE_OVERLAY_SOURCE_ID = /^[a-zA-Z0-9_-]+$/;
const OVERLAY_ORIGINAL_NAME = /^original\.(?:png|jpe?g|webp)$/i;

/** Reject archive traversal and keep all imported paths within their assigned root. */
function archiveRelativePath(entryName: string, prefix: string): string | null {
  if (!entryName.startsWith(prefix)) return null;
  const relative = entryName.slice(prefix.length);
  if (
    !relative ||
    relative.startsWith("/") ||
    relative.includes("\\") ||
    path.posix.isAbsolute(relative) ||
    relative.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new ProjectIOError(400, `Unsafe archive path: ${entryName}`);
  }
  return relative;
}

function archiveTarget(root: string, relative: string): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...relative.split("/"));
  if (!target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new ProjectIOError(400, `Unsafe archive path: ${relative}`);
  }
  return target;
}

async function appendCompactOverlayImages(
  archive: Archiver,
  dataRoot: string,
  dieId: string
): Promise<void> {
  const overlayDir = path.join(dataRoot, "overlay-images", dieId);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(overlayDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_OVERLAY_SOURCE_ID.test(entry.name)) continue;
    const sourceDir = path.join(overlayDir, entry.name);
    const manifestFile = path.join(sourceDir, "manifest.json");
    let manifest: OverlayImageManifest;
    try {
      manifest = JSON.parse(await fs.readFile(manifestFile, "utf8")) as OverlayImageManifest;
    } catch {
      continue;
    }
    if (!manifest || manifest.id !== entry.name) continue;
    const originalName = path.basename(manifest.originalPath);
    if (!OVERLAY_ORIGINAL_NAME.test(originalName)) continue;
    const originalFile = path.join(sourceDir, originalName);
    if (!(await fileExists(originalFile))) continue;
    // Do not leak a host-specific originalPath in the portable archive.
    archive.append(
      JSON.stringify({ ...manifest, originalPath: originalName }, null, 2),
      { name: `overlay-images/${entry.name}/manifest.json` }
    );
    archive.file(originalFile, {
      name: `overlay-images/${entry.name}/${originalName}`
    });
  }
}

// ═════════════════════════════════════════════════════════════════════
// Error
// ═════════════════════════════════════════════════════════════════════

class ProjectIOError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ProjectIOError";
    this.status = status;
  }
}

// ═════════════════════════════════════════════════════════════════════
// Export — queues files into an archive (does NOT finalize)
// ═════════════════════════════════════════════════════════════════════

async function queueExport(
  dataRoot: string,
  dieId: string,
  body: { mode?: string; preferences?: string | null; deviceRegistry?: string | null; analogNames?: string | null }
): Promise<{ archive: Archiver; filename: string }> {
  const record = await readDieRecord(dataRoot, dieId);
  const mode = body.mode === "full" ? "full" : "light";

  const archive: Archiver = new ZipArchive({ zlib: { level: 0 } }); // store — images already compressed
  const dieDir = path.join(dataRoot, "dies", dieId);
  const dieName = sanitizeName(record.name) || "project";
  const filename = `mmochip-${dieName}-${mode}.zip`;

  async function measure(label: string, fn: () => Promise<void>) {
    await fn();
  }

  // 1. metadata.json
  await measure("metadata.json", async () => {
    const p = path.join(dieDir, "metadata.json");
    if (await fileExists(p)) archive.file(p, { name: "metadata.json" });
  });

  // 2. annotations.json
  await measure("annotations.json", async () => {
    const p = path.join(dieDir, "annotations.json");
    if (await fileExists(p)) archive.file(p, { name: "annotations.json" });
  });

  // 3. spice_config.json (optional)
  await measure("spice_config.json", async () => {
    const p = path.join(dieDir, "spice_config.json");
    if (await fileExists(p)) archive.file(p, { name: "spice_config.json" });
  });

  // 4. export/ netlists (optional)
  await measure("export/ netlists", async () => {
    const d = path.join(dieDir, "export");
    if (await fileExists(d)) archive.directory(d, "export");
  });

  // 5. preferences.json (optional, from frontend)
  await measure("preferences.json", async () => {
    if (body.preferences) archive.append(body.preferences, { name: "preferences.json" });
  });

  // 6. device-registry.json (optional) — analog device names, overrides, UUID identity
  await measure("device-registry.json", async () => {
    if (body.deviceRegistry) archive.append(body.deviceRegistry, { name: "device-registry.json" });
  });

  // 7. analog-names.json (optional) — legacy name map
  await measure("analog-names.json", async () => {
    if (body.analogNames) archive.append(body.analogNames, { name: "analog-names.json" });
  });

  // 8. Full mode extras — iterate manually for size logging
  if (mode === "full") {
    await measure("original/ die image", async () => {
      const d = path.join(dieDir, "original");
      if (await fileExists(d)) {
        for (const f of await fs.readdir(d)) {
          const fp = path.join(d, f);
          archive.file(fp, { name: `original/${f}` });
        }
      }
    });

    await measure("overlay-images/", async () => {
      await appendCompactOverlayImages(archive, dataRoot, dieId);
    });
  }

  return { archive, filename };
}

// ═════════════════════════════════════════════════════════════════════
// Import
// ═════════════════════════════════════════════════════════════════════

const MAX_TEXT_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_PROJECT_ENTRY_COUNT = 100_000;

function singleEntry(entries: ZipEntry[], name: string): ZipEntry | null {
  const matches = entries.filter((entry) => !entry.isDirectory && entry.entryName === name);
  if (matches.length > 1) throw new ProjectIOError(400, `Duplicate ZIP entry: ${name}`);
  return matches[0] ?? null;
}

async function readStagedText(file: string): Promise<string | null> {
  try {
    const stat = await fs.stat(file);
    if (stat.size > MAX_TEXT_ENTRY_BYTES) throw new ProjectIOError(400, "Project settings entry is too large");
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function handleImport(
  dataRoot: string,
  tileScheduler: ReturnType<typeof createTileScheduler>,
  zipPath: string,
  renameTo?: string
): Promise<{ dieId: string; preferences: string | null; deviceRegistry: string | null; analogNames: string | null }> {
  const archive = await ZipStreamReader.open(zipPath);
  const stagingRoot = path.join(dataRoot, "tmp", `project-import-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const stagedDieDir = path.join(stagingRoot, "die");
  const stagedOverlayDir = path.join(stagingRoot, "overlay-images");
  const stagedExtrasDir = path.join(stagingRoot, "extras");
  let targetDieId = "";
  let dieDir = "";
  let overlayDir = "";
  let dieMoved = false;
  let overlayMoved = false;

  try {
    if (archive.entries.length > MAX_PROJECT_ENTRY_COUNT) {
      throw new ProjectIOError(400, "ZIP contains too many entries");
    }

    const metadataEntry = singleEntry(archive.entries, "metadata.json");
    if (!metadataEntry) throw new ProjectIOError(400, "ZIP must contain metadata.json");
    const metaRaw = await archive.readEntryText(metadataEntry, MAX_TEXT_ENTRY_BYTES);
    const meta = readJsonSafe<DieRecord>(metaRaw, null as unknown as DieRecord);
    if (!meta || !meta.id) throw new ProjectIOError(400, "Invalid metadata.json");

    targetDieId = meta.id;
    let targetName = meta.name;
    if (renameTo) {
      targetDieId = deriveId(renameTo);
      targetName = renameTo;
    }

    dieDir = path.join(dataRoot, "dies", targetDieId);
    overlayDir = path.join(dataRoot, "overlay-images", targetDieId);
    if (await fileExists(dieDir)) {
      throw new ProjectIOError(
        409,
        JSON.stringify({
          error: "die_already_exists",
          dieId: targetDieId,
          name: targetName,
          originalDieId: meta.id
        })
      );
    }
    if (await fileExists(overlayDir)) {
      throw new ProjectIOError(409, `Project resources already exist for ${targetName}`);
    }

    const allDies = await listDieRecords(dataRoot);
    const namesInUse = new Set(allDies.filter((d) => d.id !== targetDieId).map((d) => d.name));
    if (namesInUse.has(targetName)) {
      let suffix = 2;
      let candidate = `${targetName} (${suffix})`;
      while (namesInUse.has(candidate)) {
        suffix += 1;
        candidate = `${targetName} (${suffix})`;
      }
      targetName = candidate;
    }

    await ensureDir(path.join(stagedDieDir, "original"));
    await ensureDir(path.join(stagedDieDir, "tiles"));
    await ensureDir(stagedOverlayDir);
    await ensureDir(stagedExtrasDir);

    const seenSingleEntries = new Set<string>(["metadata.json"]);
    const importedOverlays = new Map<string, { manifest?: string; original?: { name: string; path: string } }>();
    let restoredOriginalRelative: string | null = null;

    for (const entry of archive.entries) {
      if (entry.isDirectory || entry.entryName === "metadata.json") continue;

      if (
        entry.entryName === "annotations.json" ||
        entry.entryName === "spice_config.json" ||
        entry.entryName === "preferences.json" ||
        entry.entryName === "device-registry.json" ||
        entry.entryName === "analog-names.json"
      ) {
        if (seenSingleEntries.has(entry.entryName)) {
          throw new ProjectIOError(400, `Duplicate ZIP entry: ${entry.entryName}`);
        }
        seenSingleEntries.add(entry.entryName);
        const target =
          entry.entryName === "annotations.json" || entry.entryName === "spice_config.json"
            ? path.join(stagedDieDir, entry.entryName)
            : path.join(stagedExtrasDir, entry.entryName);
        await archive.extractEntry(entry, target);
        continue;
      }

      if (entry.entryName.startsWith("export/")) {
        const relative = archiveRelativePath(entry.entryName, "export/");
        if (relative) await archive.extractEntry(entry, archiveTarget(path.join(stagedDieDir, "export"), relative));
        continue;
      }

      if (entry.entryName.startsWith("original/")) {
        const relative = archiveRelativePath(entry.entryName, "original/");
        if (!relative) continue;
        await archive.extractEntry(entry, archiveTarget(path.join(stagedDieDir, "original"), relative));
        restoredOriginalRelative ??= relative;
        continue;
      }

      if (entry.entryName.startsWith("overlay-images/")) {
        const relative = archiveRelativePath(entry.entryName, "overlay-images/");
        if (!relative) continue;
        const parts = relative.split("/");
        if (parts.length !== 2 || !SAFE_OVERLAY_SOURCE_ID.test(parts[0])) {
          throw new ProjectIOError(400, `Invalid overlay archive entry: ${entry.entryName}`);
        }
        const [sourceId, fileName] = parts;
        const item = importedOverlays.get(sourceId) ?? {};
        const sourceDir = archiveTarget(stagedOverlayDir, sourceId);
        if (fileName === "manifest.json") {
          if (item.manifest) throw new ProjectIOError(400, `Duplicate overlay manifest: ${sourceId}`);
          item.manifest = path.join(sourceDir, "manifest.json");
          await archive.extractEntry(entry, item.manifest);
        } else if (OVERLAY_ORIGINAL_NAME.test(fileName)) {
          if (item.original) throw new ProjectIOError(400, `Duplicate overlay original: ${sourceId}`);
          const originalPath = path.join(sourceDir, fileName);
          item.original = { name: fileName, path: originalPath };
          await archive.extractEntry(entry, originalPath);
        } else {
          throw new ProjectIOError(400, `Unsupported overlay archive entry: ${entry.entryName}`);
        }
        importedOverlays.set(sourceId, item);
      }
      // Unknown top-level files are intentionally ignored to preserve compatibility
      // with project bundles created by newer versions of the application.
    }

    let resolvedOriginalPath: string | null = restoredOriginalRelative
      ? archiveTarget(path.join(dieDir, "original"), restoredOriginalRelative)
      : null;
    if (!resolvedOriginalPath && meta.originalPath && (await fileExists(meta.originalPath))) {
      resolvedOriginalPath = meta.originalPath;
    }

    const updatedMeta: DieRecord = {
      ...meta,
      id: targetDieId,
      name: targetName,
      originalPath: resolvedOriginalPath ?? meta.originalPath,
      updatedAt: new Date().toISOString()
    };
    await fs.writeFile(path.join(stagedDieDir, "metadata.json"), `${JSON.stringify(updatedMeta, null, 2)}\n`, "utf8");

    const reboundManifests: OverlayImageManifest[] = [];
    for (const [sourceId, item] of importedOverlays) {
      if (!item.manifest || !item.original) {
        throw new ProjectIOError(400, `Overlay ${sourceId} must contain manifest.json and original image`);
      }
      const manifestRaw = await readStagedText(item.manifest);
      const manifest = readJsonSafe<OverlayImageManifest>(manifestRaw ?? "", null as unknown as OverlayImageManifest);
      if (!manifest || manifest.id !== sourceId) {
        throw new ProjectIOError(400, `Invalid overlay manifest: ${sourceId}`);
      }
      const originalStat = await fs.stat(item.original.path);
      const reboundManifest: OverlayImageManifest = {
        ...manifest,
        id: sourceId,
        originalPath: path.join(overlayDir, sourceId, item.original.name),
        originalFilename: manifest.originalFilename || item.original.name,
        size: originalStat.size,
        ready: true,
        updatedAt: new Date().toISOString()
      };
      await fs.writeFile(item.manifest, JSON.stringify(reboundManifest, null, 2), "utf8");
      reboundManifests.push(reboundManifest);
    }

    const preferences = await readStagedText(path.join(stagedExtrasDir, "preferences.json"));
    const deviceRegistry = await readStagedText(path.join(stagedExtrasDir, "device-registry.json"));
    const analogNames = await readStagedText(path.join(stagedExtrasDir, "analog-names.json"));

    await fs.rename(stagedDieDir, dieDir);
    dieMoved = true;
    if (importedOverlays.size > 0) {
      await ensureDir(path.join(dataRoot, "overlay-images"));
      await fs.rename(stagedOverlayDir, overlayDir);
      overlayMoved = true;
    }
    await writeDieRecord(dataRoot, updatedMeta);
    // A project ZIP creates the same base-image record as an ordinary import.
    // Enqueue its complete base pyramid only after both data directories and metadata
    // have been atomically moved into their final locations.
    tileScheduler.enqueueBackground(updatedMeta);

    for (const manifest of reboundManifests) {
      const timer = setTimeout(() => {
        void preGenerateFullPyramid({ dataRoot, dieId: targetDieId, manifest }).catch((error) => {
          console.warn("Failed to pre-generate imported overlay tile pyramid", error);
        });
      }, 750);
      timer.unref?.();
    }

    return { dieId: targetDieId, preferences, deviceRegistry, analogNames };
  } catch (error) {
    if (dieMoved && dieDir) await fs.rm(dieDir, { recursive: true, force: true }).catch(() => {});
    if (overlayMoved && overlayDir) await fs.rm(overlayDir, { recursive: true, force: true }).catch(() => {});
    if (error instanceof ZipStreamError) throw new ProjectIOError(400, error.message);
    throw error;
  } finally {
    await archive.close().catch(() => {});
    await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
  }
}

// ═════════════════════════════════════════════════════════════════════
// Express router
// ═════════════════════════════════════════════════════════════════════

export function createProjectIORouter(config: {
  dataRoot: string;
  tileScheduler: ReturnType<typeof createTileScheduler>;
}) {
  const router = Router();
  const upload = multer({
    dest: path.join(config.dataRoot, "tmp"),
    // Store multipart data on disk. The extractor processes the ZIP sequentially,
    // so full exports with multi-gigabyte images do not have to fit in memory.
    limits: { fileSize: MAX_PROJECT_ARCHIVE_BYTES }
  });

  // ─── Export ─────────────────────────────────────────────────────
  // Write ZIP to a temp file, then serve via response.download.
  // This avoids issues with Express v5 streaming + archiver piping.

  router.post(
    "/api/dies/:dieId/export-project",
    async (request, response, next) => {
      const dieId = request.params.dieId;
      const tempDir = path.join(config.dataRoot, "tmp");
      const tempPath = path.join(tempDir, `export-${dieId}-${Date.now()}.zip`);
      try {
        const { archive, filename } = await queueExport(
          config.dataRoot,
          dieId,
          request.body ?? {}
        );

        await fs.mkdir(tempDir, { recursive: true });
        const writeStream = createWriteStream(tempPath);

        archive.pipe(writeStream);

        await new Promise<void>((resolve, reject) => {
          archive.on("error", reject);
          writeStream.on("finish", resolve);
          writeStream.on("error", reject);
          archive.finalize();
        });

        // Serve file with explicit streaming (avoid download/attachment issues)
        const stat = await fs.stat(tempPath);
        response.writeHead(200, {
          "Content-Type": "application/zip",
          "Content-Length": stat.size,
          "Access-Control-Allow-Origin": "*",
          "X-Filename": filename
        });

        const readStream = createReadStream(tempPath);
        await new Promise<void>((resolve, reject) => {
          readStream.pipe(response);
          readStream.on("end", resolve);
          readStream.on("error", reject);
        });

        await fs.rm(tempPath, { force: true }).catch(() => {});
      } catch (error) {
        await fs.rm(tempPath, { force: true }).catch(() => {});
        console.error(`[export:${dieId}] failed:`, error);
        if (!response.headersSent) next(error);
      }
    }
  );

  // ─── Rename ─────────────────────────────────────────────────────

  router.put(
    "/api/dies/:dieId/rename",
    async (request, response, next) => {
      try {
        const { dieId } = request.params;
        const newName: string | undefined = request.body?.name;
        if (!newName || !newName.trim()) {
          response.status(400).json({ error: "Name is required" });
          return;
        }

        const record = await readDieRecord(config.dataRoot, dieId);
        const updated: DieRecord = {
          ...record,
          name: newName.trim(),
          updatedAt: new Date().toISOString()
        };
        await writeDieRecord(config.dataRoot, updated);
        response.json({ ok: true, name: updated.name });
      } catch (error) {
        next(error);
      }
    }
  );

  // ─── Import ─────────────────────────────────────────────────────

  router.post(
    "/api/dies/import-project",
    upload.single("file"),
    async (request, response, next) => {
      const filePath = request.file?.path;
      try {
        if (!request.file) {
          response.status(400).json({ error: "No ZIP file provided" });
          return;
        }

        const renameTo =
          typeof request.query.name === "string"
            ? request.query.name.trim() || undefined
            : undefined;

        const result = await handleImport(
          config.dataRoot,
          config.tileScheduler,
          request.file.path,
          renameTo
        );
        await fs.rm(request.file.path, { force: true });

        response.json({
          ok: true,
          dieId: result.dieId,
          preferences: result.preferences,
          deviceRegistry: result.deviceRegistry,
          analogNames: result.analogNames
        });
      } catch (error) {
        if (filePath) await fs.rm(filePath, { force: true }).catch(() => {});

        if (error instanceof ProjectIOError) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(error.message);
          } catch {
            parsed = { error: error.message };
          }
          response.status(error.status).json(parsed);
          return;
        }
        next(error);
      }
    }
  );

  return router;
}
