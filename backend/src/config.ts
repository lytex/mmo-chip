import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultTileConcurrency } from "./dieImport/jobs.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDirectory, "../..");
const repoDataRoot = path.join(repoRoot, "data");
// The desktop app's portable data is where imported dies actually live in
// day-to-day use. When the backend is started by hand WITHOUT
// CHIPTOOL_DATA_ROOT (easy to forget in a fresh shell), silently falling
// back to the repo `data/` used to produce a half-empty world: the die was
// found there by an old import, but sweeps/layers were written to and read
// from a different tree than the user expected.
const portableDataRoot = path.join(
  repoRoot,
  "desktop",
  "build",
  "dist",
  "win-unpacked",
  "portable-data",
  "data"
);
const defaultDataRoot = fs.existsSync(portableDataRoot)
  ? portableDataRoot
  : repoDataRoot;
const parsedLimitInputPixels = process.env.CHIPTOOL_LIMIT_INPUT_PIXELS;

export const config: {
  port: number;
  dataRoot: string;
  tileSize: number;
  limitInputPixels: number | false;
  tileConcurrency: number;
  mlSidecarUrl: string;
  mlPredictPad: number;
  /** Absolute path to the built frontend (`frontend/dist`) served by Express.
   *  Empty in dev (Vite dev server owns the UI); set by the desktop shell. */
  frontendDist: string;
} = {
  port: Number(process.env.PORT ?? 3001),
  dataRoot: process.env.CHIPTOOL_DATA_ROOT ?? defaultDataRoot,
  tileSize: Number(process.env.CHIPTOOL_TILE_SIZE ?? 512),
  limitInputPixels:
    parsedLimitInputPixels === undefined ? false : Number(parsedLimitInputPixels),
  tileConcurrency: Number(process.env.CHIPTOOL_TILE_CONCURRENCY ?? defaultTileConcurrency()),
  mlSidecarUrl: process.env.CHIPTOOL_ML_SIDECAR_URL ?? "http://127.0.0.1:8001",
  mlPredictPad: Number(process.env.CHIPTOOL_ML_PREDICT_PAD ?? 128),
  frontendDist: process.env.CHIPTOOL_FRONTEND_DIST ?? ""
};
