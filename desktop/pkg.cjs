/**
 * Universal electron-builder wrapper for pkg:win / pkg:linux.
 *
 * electron-builder stores the big Electron zips in %LOCALAPPDATA%\electron\Cache
 * by default, and on machines where the user profile is only partially writable
 * (security filters, agent sandboxes) the download fails mid-way with
 * "open ...part5: Access is denied". Point both caches into the repo instead:
 * desktop/.electron-cache + desktop/.electron-builder-cache (both gitignored).
 * The first build fills them once; every later build is a cache hit — no
 * network, no proxy env, no per-machine setup. Explicit env still wins
 * (?? keeps caller overrides, e.g. CI).
 *
 * Usage: node pkg.cjs <electron-builder args…>
 */
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
process.env.ELECTRON_CACHE ??= path.join(root, "desktop", ".electron-cache");
process.env.ELECTRON_BUILDER_CACHE ??= path.join(root, "desktop", ".electron-builder-cache");

// Resolve from desktop/node_modules (this file lives there), regardless of
// where npm invoked the script from.
const builder = require.resolve("electron-builder/cli.js");
const result = spawnSync(process.execPath, [builder, ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: false,
  // Run from desktop/ like the npm scripts did: staging paths in
  // electron-builder.yml are relative to it.
  cwd: __dirname,
  env: process.env
});
process.exit(result.status ?? 1);
