#!/usr/bin/env node
/**
 * fetch-desktop-bins.mjs — bundle native simulators into the desktop resources.
 *
 *   resources/bin/Spice64/{bin,lib,share}/   console ngspice (Windows)
 *   resources/bin/ngspice                    system ngspice copy (Linux/CI)
 *   resources/bin/vyges-lvs(.exe)            LVS CLI (copied from ~/.cargo/bin)
 *
 * ngspice Windows: downloads the official 64-bit build from SourceForge and
 * unpacks it with 7-Zip (GitHub runners ship 7-Zip; dev machines usually too).
 * The whole Spice64 tree is kept — ngspice resolves ../lib/../share relative
 * to the binary. docs/ and examples/ are dropped.
 *
 * Linux: copies the distro-installed ngspice (WASM sim in the UI covers
 * anything missing). vyges-lvs falls back to the built-in TS engine when the
 * cargo binary is absent, so bundling is always best-effort.
 *
 * Idempotent: re-running is a no-op. Usage: node scripts/fetch-desktop-bins.mjs
 */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const staging = path.join(repoRoot, "desktop", "build", "staging", "resources");
const binRoot = path.join(staging, "bin");

const NGSPICE_VERSION = "47";
// The Windows archive is pinned in two upstream folder layouts; try both.
const NGSPICE_URLS = [
  `https://downloads.sourceforge.net/project/ngspice/ng-spice-rework/old-releases/46/ngspice-${NGSPICE_VERSION}_64.7z`,
  `https://downloads.sourceforge.net/project/ngspice/ng-spice-rework/47/ngspice-${NGSPICE_VERSION}_64.7z`
];

mkdirSync(binRoot, { recursive: true });

/** Complete bundle = binary + the ../lib XSPICE code models it loads. */
function hasNgspice() {
  if (process.platform === "win32") {
    return (
      existsSync(path.join(binRoot, "Spice64", "bin", "ngspice_con.exe")) &&
      existsSync(path.join(binRoot, "Spice64", "lib", "ngspice"))
    );
  }
  return existsSync(path.join(binRoot, "ngspice"));
}

function findSevenZip() {
  const candidates =
    process.platform === "win32"
      ? ["7z.exe", "7z", "C:/Program Files/7-Zip/7z.exe", "C:/Program Files (x86)/7-Zip/7z.exe"]
      : ["7zz", "7za", "7z"];
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, [], { stdio: "ignore", timeout: 10_000 });
      return candidate; // 7-Zip without args exits non-zero but spawning works
    } catch (error) {
      if (error.code === "ENOENT") continue;
      return candidate; // spawned, but exited with usage error → present
    }
  }
  return null;
}

async function installNgspiceWindows() {
  const sevenZip = findSevenZip();
  if (!sevenZip) {
    console.error(
      "bins: 7-Zip not found — install it, or extract ngspice yourself with " +
        "Spice64/{bin,lib,share} landing in desktop/build/staging/resources/bin"
    );
    process.exit(1);
  }

  const work = path.join(repoRoot, "desktop", "build", "ngspice-work");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const archive = path.join(work, "ngspice.7z");

  let lastError = null;
  // SourceForge redirects are flaky; a few retries settle it.
  outer: for (const url of NGSPICE_URLS) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const response = await fetch(url, { redirect: "follow" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        writeFileSync(archive, bytes);
        console.log(
          `bins: downloaded ngspice-${NGSPICE_VERSION} (${(bytes.length / 1e6).toFixed(1)} MB, attempt ${attempt})`
        );
        lastError = null;
        break outer;
      } catch (error) {
        lastError = error;
      }
    }
  }
  if (lastError) {
    console.error(`bins: ngspice download failed: ${lastError.message}`);
    process.exit(1);
  }

  execFileSync(sevenZip, ["x", "-y", `-o${work}`, archive], { stdio: "ignore", maxBuffer: 16e6 });
  // Some releases nest under a version folder, some extract to work/ directly.
  const nested = readdirSync(work)
    .filter((name) => !name.endsWith(".7z"))
    .map((name) => path.join(work, name, "Spice64"));
  // spiceRoot IS the Spice64 dir (whatever depth it landed at).
  const spiceRoot = [path.join(work, "Spice64"), ...nested].find((dir) =>
    existsSync(path.join(dir, "bin", "ngspice_con.exe"))
  );
  if (!spiceRoot) {
    console.error("bins: unexpected ngspice archive layout — inspect " + work);
    process.exit(1);
  }

  for (const part of ["bin", "lib", "share"]) {
    const source = path.join(spiceRoot, part);
    if (existsSync(source)) cpSync(source, path.join(binRoot, "Spice64", part), { recursive: true });
  }
  rmSync(work, { recursive: true, force: true });
  console.log("bins: ngspice_con.exe bundled (bin/lib/share kept)");
}

function installNgspiceLinux() {
  const target = path.join(binRoot, "ngspice");
  if (existsSync(target)) {
    console.log("bins: ngspice already bundled");
    return;
  }
  const probe = spawnSync("sh", ["-c", "command -v ngspice"], { encoding: "utf8" });
  const source = probe.stdout?.toString().trim();
  if (source && existsSync(source)) {
    copyFileSync(source, target);
    console.log(`bins: ngspice bundled from ${source}`);
  } else {
    console.warn("bins: system ngspice not found — the app still has the WASM simulator");
  }
}

function installVyges() {
  const exe = process.platform === "win32" ? "vyges-lvs.exe" : "vyges-lvs";
  const target = path.join(binRoot, exe);
  if (existsSync(target)) {
    console.log("bins: vyges-lvs already bundled");
    return;
  }
  const source = path.join(homedir(), ".cargo", "bin", exe);
  if (existsSync(source)) {
    copyFileSync(source, target);
    console.log("bins: vyges-lvs bundled from cargo");
    return;
  }
  console.warn(
    "bins: vyges-lvs not found (~/.cargo/bin) — skipping; the app falls back " +
      "to its built-in name-based LVS engine (scripts/setup-lvs.ps1 installs it)"
  );
}

if (process.platform === "win32") {
  if (hasNgspice()) console.log("bins: ngspice already bundled");
  else await installNgspiceWindows();
} else {
  installNgspiceLinux();
}
installVyges();
console.log(`bins: done → ${binRoot}`);
