#!/usr/bin/env node
/**
 * stage-desktop.mjs — assemble the resources payload for the Electron build.
 *
 * The packaged backend must run exactly like the dev repo (it re-spawns
 * `node --import tsx scripts/netlist-export.ts` and imports TS-covered
 * "shared" sources through node_modules), so the payload mirrors the repo:
 *
 *   resources/app/
 *     backend/{package.json,dist}      compiled backend (ESM)
 *     shared/                          TS sources, also copied to node_modules/shared
 *     frontend/{package.json,dist,src} built SPA + the src tree the
 *                                      netlist-export child imports
 *     scripts/netlist-export.ts        the child script the backend re-spawns
 *     node_modules/                    prod deps + tsx + clipper2-wasm
 *
 * Output: desktop/build/staging/resources/{app,bin}
 *
 * Usage: node scripts/stage-desktop.mjs [--skip-install]
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stagingRoot = path.join(repoRoot, "desktop", "build", "staging");
const staging = path.join(stagingRoot, "resources");
const appRoot = path.join(staging, "app");
const binRoot = path.join(staging, "bin");

const skipInstall = process.argv.includes("--skip-install");

function copy(from, to) {
  if (!existsSync(from)) {
    console.error(`stage: missing ${from} — build the workspace first`);
    return false;
  }
  cpSync(from, to, { recursive: true });
  return true;
}

// Fresh staging (regenerable build output, removed unconditionally).
rmSync(staging, { recursive: true, force: true });
mkdirSync(appRoot, { recursive: true });
mkdirSync(binRoot, { recursive: true });

// Windows launcher (tiny Rust exe that sets ELECTRON_DISABLE_SANDBOX and
// spawns the app): needed because Chromium's sandbox init crashes Electron
// before main.js on some machines. Best-effort — cargo may be absent.
{
  const launcherDir = path.join(repoRoot, "desktop", "launcher");
  if (existsSync(path.join(launcherDir, "Cargo.toml"))) {
    const env = { ...process.env, CARGO_TARGET_DIR: path.join(repoRoot, "desktop", "build", "launcher-target") };
    const result = spawnSync("cargo", ["build", "--release"], {
      cwd: launcherDir,
      stdio: "inherit",
      env,
      shell: process.platform === "win32"
    });
    const built = path.join(env.CARGO_TARGET_DIR, "release", "mmo-chip-launcher.exe");
    if (result.status === 0 && existsSync(built)) {
      copyFileSync(built, path.join(repoRoot, "desktop", "build", "staging", "launcher.exe"));
      console.log("stage: launcher.exe built");
    } else {
      console.warn("stage: launcher build failed — the package keeps the plain Electron exe");
    }
  }
}

console.log("stage: backend…");
if (!copy(path.join(repoRoot, "backend", "package.json"), path.join(appRoot, "backend", "package.json")))
  process.exit(1);
if (!copy(path.join(repoRoot, "backend", "dist"), path.join(appRoot, "backend", "dist"))) process.exit(1);

console.log("stage: shared sources…");
if (!copy(path.join(repoRoot, "shared"), path.join(appRoot, "shared"))) process.exit(1);

console.log("stage: frontend…");
if (!copy(path.join(repoRoot, "frontend", "package.json"), path.join(appRoot, "frontend", "package.json")))
  process.exit(1);
if (!copy(path.join(repoRoot, "frontend", "dist"), path.join(appRoot, "frontend", "dist"))) process.exit(1);
if (!copy(path.join(repoRoot, "frontend", "tsconfig.json"), path.join(appRoot, "frontend", "tsconfig.json")))
  process.exit(1);
console.log("stage: frontend/src (netlist-export needs it)…");
if (!copy(path.join(repoRoot, "frontend", "src"), path.join(appRoot, "frontend", "src"))) process.exit(1);

console.log("stage: scripts/netlist-export.ts…");
{
  const scriptsDir = path.join(appRoot, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  if (!copy(path.join(repoRoot, "scripts", "netlist-export.ts"), path.join(scriptsDir, "netlist-export.ts")))
    process.exit(1);
}

// ML sidecar sources: shipped in every bundle so the optional plugin
// (scripts/setup_ml_desktop.*) has something to install into. Only the
// .py sources + requirements.txt — the venv and checkpoints are created
// on the user's machine by the plugin installer.
console.log("stage: ml sidecar sources…");
{
  const mlSrc = path.join(repoRoot, "ml");
  const mlDst = path.join(appRoot, "ml");
  mkdirSync(mlDst, { recursive: true });
  for (const entry of readdirSync(mlSrc)) {
    const full = path.join(mlSrc, entry);
    if (!statSync(full).isFile()) continue;
    if (entry.endsWith(".py") || entry === "requirements.txt") {
      copyFileSync(full, path.join(mlDst, entry));
    }
  }
}

// The plugin installers land at the packaged app root (extraFiles in
// electron-builder.yml), next to mmo-chip.exe — a zip user can install ML
// without a repo checkout. Windows users get a .bat shim because Explorer
// blocks .ps1 double-clicks by default.
console.log("stage: ml plugin installers…");
copyFileSync(path.join(repoRoot, "scripts", "setup_ml_desktop.ps1"), path.join(stagingRoot, "setup_ml.ps1"));
copyFileSync(path.join(repoRoot, "scripts", "setup_ml_desktop.sh"), path.join(stagingRoot, "setup_ml.sh"));
copyFileSync(path.join(repoRoot, "scripts", "setup_ml_desktop.bat"), path.join(stagingRoot, "setup_ml.bat"));

// Node runtime packages: backend prod deps + tsx (netlist child) + clipper2-wasm.
if (!skipInstall) {
  console.log("stage: npm install of runtime node_modules…");
  const manifest = {
    name: "mmo-chip-resources",
    private: true,
    dependencies: {
      // Backend prod deps
      archiver: "^8.0.0",
      bcryptjs: "^2.4.3",
      cors: "^2.8.5",
      express: "^5.1.0",
      jsonwebtoken: "^9.0.3",
      multer: "^2.0.1",
      sharp: "^0.34.2",
      ws: "^8.18.0",
      // The netlist-export child imports frontend/src TS at runtime, and that
      // module graph may touch any of the frontend's prod deps (rbush, elk …).
      // Ship them instead of computing the transitive closure by hand.
      "@panzoom/panzoom": "^4.6.2",
      "@spice-ts/core": "^0.3.0",
      "@spice-ts/ui": "^0.3.0",
      "@tanstack/react-query": "^5.59.0",
      "@tscircuit/footprinter": "^0.0.426",
      "clipper2-wasm": "latest",
      comlink: "4.4.2",
      cytoscape: "^3.34.0",
      "d3-array": "^3.2.4",
      "d3-scale": "^4.0.2",
      "eecircuit-engine": "^1.8.0",
      elkjs: "^0.11.1",
      rbush: "^4.0.1",
      react: "^19.1.0",
      "react-dom": "^19.1.0",
      "react-router-dom": "^7.6.1",
      tsx: "^4.19.3",
      vitest: "^4.1.10",
      "webgl-plot": "^1.1.2",
      zustand: "^5.0.2"
    }
  };
  const manifestDir = path.join(repoRoot, "desktop", "build", "node-manifest");
  rmSync(manifestDir, { recursive: true, force: true });
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(path.join(manifestDir, "package.json"), JSON.stringify(manifest, null, 2));

  const result = spawnSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel", "error"], {
    cwd: manifestDir,
    stdio: "inherit",
    shell: process.platform === "win32"
  });
  if (result.status !== 0) {
    console.error("stage: npm install failed");
    process.exit(1);
  }
  renameSync(path.join(manifestDir, "node_modules"), path.join(appRoot, "node_modules"));
  rmSync(manifestDir, { recursive: true, force: true });
}

// "shared" is a workspace package, so the install manifest can't list it —
// copy it in as a real package dir.
console.log("stage: node_modules/shared…");
cpSync(path.join(repoRoot, "shared"), path.join(appRoot, "node_modules", "shared"), { recursive: true });

// bcryptjs runtime check: backend pins ^3, keep whatever the manifest gives.
if (existsSync(binRoot) && readdirSync(binRoot).length === 0) {
  console.warn("stage: bin/ is empty — run scripts/fetch-desktop-bins.mjs to bundle ngspice/vyges-lvs");
}

console.log(`stage: done → ${appRoot}`);
