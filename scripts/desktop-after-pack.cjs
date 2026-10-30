/**
 * afterPack hook (electron-builder): on Windows, swap the Electron exe for
 * the tiny launcher.
 *
 * Chromium's sandbox initialization crashes Electron before main.js on some
 * machines, and the escape hatch (ELECTRON_DISABLE_SANDBOX) must be in the
 * environment before the process starts. The launcher sets it and spawns the
 * real app, so double-clicking mmo-chip.exe just works:
 *
 *   mmo-chip.exe       ← launcher (desktop/launcher, Rust)
 *   mmo-chip-app.exe   ← Electron (renamed here)
 *
 * If the launcher binary was not built (no cargo), the plain Electron exe is
 * kept — starting it manually with ELECTRON_DISABLE_SANDBOX=1 still works.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;

  const outDir = context.appOutDir;
  const productName = context.packager.appInfo.productFilename; // "mmo-chip"
  const appExe = path.join(outDir, `${productName}.exe`);
  const launcherSource = path.join(__dirname, "..", "desktop", "build", "staging", "launcher.exe");

  if (!fs.existsSync(launcherSource)) {
    console.warn(
      "desktop-after-pack: launcher.exe not built (cargo missing?) — keeping the plain " +
        "Electron exe; users may need ELECTRON_DISABLE_SANDBOX=1 on sandbox-crashing machines"
    );
    return;
  }

  const renamed = path.join(outDir, "mmo-chip-app.exe");
  fs.renameSync(appExe, renamed);
  fs.copyFileSync(launcherSource, path.join(outDir, `${productName}.exe`));
  console.log("desktop-after-pack: launcher installed as mmo-chip.exe (app → mmo-chip-app.exe)");
};
