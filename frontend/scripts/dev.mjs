// Windows stopgap for the Vite dev server dying with exit code
// 3221226505 (0xC0000409 STATUS_STACK_BUFFER_OVERRUN).
//
// Root cause is NOT this repo: Node 24.0–24.15 bundle libuv 1.51.0, whose
// Windows TCP-connect path calls RtlGetVersion() on an uninitialised
// OSVERSIONINFOW — /GS stack-cookie overrun → __fastfail, no output. It
// runs on EVERY outbound uv_tcp_connect, and the Vite dev proxy opens one
// per proxied request (/api, /api/ws, /mcp → backend :3001), so a session
// with the GUI open hits it within minutes. Upstream:
//   libuv#5106 (bug) · libuv#5107 (fix) · nodejs/node#62561
// FIXED in Node 24.16.0. This wrapper simply restarts vite on that exact
// exit code (HMR clients reconnect automatically); once the runtime is
// upgraded past 24.16 it never triggers and can be removed.
import { spawn } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import process from "node:process";

const CRASH_CODE = 3221226505; // 0xC0000409
const MAX_RESTARTS = 50;
const RESTART_DELAY_MS = 1000;

const require = createRequire(new URL("../package.json", import.meta.url));
// `vite/bin/vite.js` is not exported by vite's package.json exports map —
// resolve via the package.json and join the known bin path.
const pkgJson = require.resolve("vite/package.json");
const viteBin = path.join(path.dirname(pkgJson), "bin", "vite.js");
// The old script was `vite --host 0.0.0.0`; extra args pass through.
const viteArgs = ["--host", "0.0.0.0", ...process.argv.slice(2)];

let restarts = 0;
const run = () => {
  const child = spawn(process.execPath, [viteBin, ...viteArgs], {
    stdio: "inherit"
  });
  child.on("exit", (code) => {
    if (code === CRASH_CODE && restarts < MAX_RESTARTS) {
      restarts += 1;
      console.error(
        `[dev] vite died with 0xC0000409 (libuv#5106 — Node 24.0–24.15 ` +
          `fast-fails on outbound TCP connects; the /api proxy hits it).\n` +
          `[dev] restart #${restarts} in ${RESTART_DELAY_MS}ms. ` +
          `UPGRADE NODE to >= 24.16.0 to stop this for real.`
      );
      setTimeout(run, RESTART_DELAY_MS);
      return;
    }
    process.exitCode = code ?? 0;
  });
};

run();
