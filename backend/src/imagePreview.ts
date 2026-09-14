import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";

export const PREVIEW_MAX_EDGE = 4096;

/**
 * Returns a downscaled JPEG of `sourcePath`, generating it once and caching
 * it at `cachePath` (invalidated when the source is modified).  Used to serve
 * small previews of huge die/overlay originals without the browser ever
 * having to download or decode the full-resolution image.
 */
export async function ensurePreviewImage(params: {
  sourcePath: string;
  cachePath: string;
  maxEdge?: number;
  quality?: number;
}): Promise<string> {
  const maxEdge = params.maxEdge ?? PREVIEW_MAX_EDGE;
  const sourceStat = await fs.stat(params.sourcePath);
  try {
    const cacheStat = await fs.stat(params.cachePath);
    if (cacheStat.mtimeMs >= sourceStat.mtimeMs) return params.cachePath;
  } catch {
    // Cache missing — regenerate.
  }

  await fs.mkdir(path.dirname(params.cachePath), { recursive: true });
  await pipelineToFileAtomic(
    sharp(params.sourcePath, { limitInputPixels: false, sequentialRead: true })
      .resize({
        width: maxEdge,
        height: maxEdge,
        fit: "inside",
        withoutEnlargement: true,
        kernel: sharp.kernel.lanczos3
      })
      .jpeg({ quality: params.quality ?? 88 }),
    params.cachePath
  );
  return params.cachePath;
}

// libvips writes JPEG bytes incrementally to disk, so a concurrent reader
// could serve an incomplete file.  Write to a temp path and rename atomically.
async function pipelineToFileAtomic(pipeline: sharp.Sharp, finalPath: string) {
  const tempPath = `${finalPath}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    await pipeline.toFile(tempPath);
    await fs.rename(tempPath, finalPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}