/**
 * mmo-chip desktop shell (Electron main).
 *
 * The app is a UI over the Node backend: the local mode spawns the backend as
 * a plain Node child (`ELECTRON_RUN_AS_NODE=1` turns the Electron binary into
 * a Node runtime) and opens a frameless window on the URL Express serves. The
 * resources root mirrors the repo layout (resources/app = repo root), so the
 * backend's own netlist-export re-spawn keeps working unchanged:
 *
 *   resources/
 *     app/            backend/dist + frontend/dist + shared + node_modules
 *     bin/            bundled ngspice / vyges-lvs (optional)
 *
 * The launcher (desktop/launcher) sets ELECTRON_DISABLE_SANDBOX and spawns
 * this exe as mmo-chip-app.exe: on some machines Chromium's sandbox
 * initialization crashes before main.js even runs, so "mmo-chip.exe" is a
 * tiny launcher and the Electron binary sits next to it.
 *
 * Launch modes:
 *   (default)       spawn a local backend, window on http://127.0.0.1:<port>
 *   --serve         spawn a local backend, no window: a tray icon offers the
 *                   LAN URLs — teammates open http://<ip>:<port> in a browser
 *                   (MMOCHECK_ROLE=server env does the same)
 *   --connect <url> no backend; the window loads a remote server. Bare
 *                   "host:port" works (http:// is implied, port defaults to
 *                   3101). The URL is persisted to userData/connection.json,
 *                   so plain launches reconnect to it afterwards.
 *   --local         forget the saved remote connection, back to local backend
 *   --dev-vite      attach to an already running `npm run dev` stack (Vite on
 *                   :5173, backend on :3001) without spawning one.
 */
"use strict";

const { app, BrowserWindow, Tray, Menu, dialog, ipcMain, shell, clipboard, nativeImage } = require("electron");
const { spawn, spawnSync, execFile } = require("node:child_process");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

// Windows shells often pass single-dash flags (`-connect`); canonicalize to
// "--flag" before matching. Values (URLs, paths) never start with "-", so
// they pass through untouched.
const argvCanon = process.argv.map((a) =>
  a.startsWith("-") && a !== "-" ? `--${a.replace(/^-+/, "")}` : a
);

const DEV_VITE = argvCanon.includes("--dev-vite");
const SERVE = argvCanon.includes("--serve") || process.env.MMOCHECK_ROLE === "server";
const LOCAL = argvCanon.includes("--local");
const CONNECT_ARG = parseConnectArg(argvCanon);
const BACKEND_PORT = Number(process.env.MMOCHECK_PORT ?? process.env.PORT ?? 3101);
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const VITE_URL = "http://localhost:5173";

const resourcesRoot = process.env.MMOCHECK_RESOURCES
  ? path.resolve(process.env.MMOCHECK_RESOURCES)
  : app.isPackaged
    // Packaged: main.cjs lives in <root>/resources/app.asar → resources is its
    // parent directory.
    ? path.dirname(__dirname)
    // Dev: this file lives in desktop/ → staging sits next to it.
    : path.join(__dirname, "build", "staging", "resources");
const appRoot = path.join(resourcesRoot, "app");
const binDir = path.join(resourcesRoot, "bin");

let backend = null;
let mainWindow = null;
let tray = null;
let quitting = false;

// Resolved in whenReady: the URL every window loads (local backend, remote
// server in --connect mode, or the Vite dev server).
let targetUrl = BACKEND_URL;
let launchMode = "local";
let lanUrls = [];

// ── launch mode ───────────────────────────────────────────────────

function parseConnectArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // "" = flag present without a usable value; null = flag absent.
    if (arg === "--connect") return argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : "";
    if (arg.startsWith("--connect=")) return arg.slice("--connect=".length);
  }
  return null;
}

/** Advertised default when the user omits the port (`--connect 10.0.0.5`). */
const DEFAULT_SERVER_PORT = 3101;

/**
 * Accept what humans actually type: "10.0.0.5:3101", "host:3101", full
 * "http(s)://..." URLs. Scheme-less input gets http://; an http URL without
 * an explicit port gets the default one. Returns normalized href or null.
 */
function normalizeServerUrl(raw) {
  let value = String(raw).trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `http://${value}`;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.protocol === "http:" && !url.port) url.port = String(DEFAULT_SERVER_PORT);
    return url.href;
  } catch {
    return null;
  }
}

function loadConnection() {
  try {
    const file = path.join(app.getPath("userData"), "connection.json");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed?.mode === "remote" && typeof parsed.url === "string" && normalizeServerUrl(parsed.url)) return parsed;
    if (parsed?.mode === "local") return parsed;
  } catch {}
  return null;
}

function saveConnection(entry) {
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(path.join(app.getPath("userData"), "connection.json"), JSON.stringify(entry, null, 2) + "\n");
  } catch (error) {
    log(`connection.json save failed: ${error.message}`);
  }
}

function resolveLaunchMode() {
  if (SERVE) return { mode: "serve" };
  if (DEV_VITE) return { mode: "dev" };
  if (LOCAL) {
    saveConnection({ mode: "local" });
    return { mode: "local" };
  }
  if (CONNECT_ARG !== null) {
    if (!CONNECT_ARG) throw new Error("--connect: не указан адрес сервера (пример: --connect 10.0.0.5:3101)");
    const url = normalizeServerUrl(CONNECT_ARG);
    if (!url) throw new Error(`--connect: не удалось разобрать адрес «${CONNECT_ARG}»`);
    saveConnection({ mode: "remote", url });
    return { mode: "connect", url };
  }
  const saved = loadConnection();
  if (saved?.mode === "remote") return { mode: "connect", url: normalizeServerUrl(saved.url) };
  return { mode: "local" };
}

// ── logging (double-click launches have no console) ───────────────

let logDir = null;
let logFile = null;

/**
 * Windows consoles default to the OEM codepage (cp866 on Russian systems),
 * while our log lines are UTF-8 → mojibake. Flip the attached console to
 * UTF-8 before the first output. The codepage is a property of the console
 * itself, so the child cmd call affects the parent's console too. Lines
 * printed before this point stay garbled; that's just the shell banner.
 */
function initConsoleCodepage() {
  if (process.platform !== "win32" || !process.stdout?.isTTY) return;
  try {
    // /d: skip cmd autorun scripts; stdio ignore hides the "Active code page"
    // banner. Harmless no-op when there is no console (double-click launch).
    spawnSync("cmd.exe", ["/d", "/c", "chcp", "65001"], { stdio: "ignore", windowsHide: true, timeout: 2000 });
  } catch {}
}

function initLogging() {
  try {
    logDir = app.getPath("logs");
  } catch {
    logDir = path.join(resourcesRoot, "logs");
  }
  if (!ensureWritable(logDir)) {
    logDir = path.join(resourcesRoot, "logs");
  }
  try {
    fs.mkdirSync(logDir, { recursive: true });
    logFile = path.join(logDir, "mmo-chip.log");
    log(`— session start (argv=${JSON.stringify(process.argv)})`);
  } catch {
    logFile = null;
  }
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  if (logFile) {
    try {
      // Keep the file bounded; the newest session matters most.
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 2_000_000) {
        fs.renameSync(logFile, logFile + ".old");
      }
      fs.appendFileSync(logFile, line + "\n");
    } catch {}
  }
  console.log(line);
}

function ensureWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function showError(title, detail) {
  log(`ERROR: ${title} — ${detail}`);
  try {
    dialog.showMessageBoxSync({
      type: "error",
      title: "mmo-chip",
      message: title,
      detail: `${detail}\n\nLog: ${logFile ?? "(log unavailable)"}`
    });
  } catch {}
}

// ── user data location ────────────────────────────────────────────

let dataDirChoice = null;

function initDataDir() {
  // The launcher may pass --user-data-dir (portable fallback when the user
  // profile is not writable) — honour it instead of second-guessing.
  const fromArg = process.argv.find((a) => a.startsWith("--user-data-dir="));
  if (fromArg) {
    const portable = path.resolve(fromArg.slice("--user-data-dir=".length));
    app.setPath("userData", portable);
    app.setPath("logs", path.join(portable, "logs"));
    dataDirChoice = `${portable} (from launcher --user-data-dir)`;
    return;
  }
  // Pin the profile dir to the product name: after the launcher rename the
  // Electron exe is "mmo-chip-app.exe", which would otherwise become the
  // profile folder name.
  const preferred = path.join(app.getPath("appData"), "mmo-chip");
  if (ensureWritable(preferred)) {
    app.setPath("userData", preferred);
    app.setPath("logs", path.join(preferred, "logs"));
    dataDirChoice = preferred;
    return;
  }
  // Locked-down machines that deny writes to the user profile: keep all
  // state next to the resources (portable mode) instead of failing silently.
  const portable = path.join(resourcesRoot, "portable-data");
  fs.mkdirSync(portable, { recursive: true });
  app.setPath("userData", portable);
  app.setPath("logs", path.join(portable, "logs"));
  dataDirChoice = `${portable} (portable fallback — user profile not writable)`;
}

// ── small helpers ─────────────────────────────────────────────────

/** Pick the first bundled binary so the backend never probes the system. */
function bundledBinary(names) {
  for (const name of names) {
    const p = path.join(binDir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** LAN IPv4 addresses to advertise in serve mode (localhost excluded). */
function discoverLanUrls() {
  const urls = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family !== "IPv4" || net.internal) continue;
      urls.push(`http://${net.address}:${BACKEND_PORT}`);
    }
  }
  return urls;
}

function waitForUrl(url, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const probe = () => {
      const request = http.get(url, (response) => {
        response.resume();
        if (response.statusCode && response.statusCode < 500) resolve();
        else retry();
      });
      request.on("error", retry);
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`did not come up within ${timeoutMs / 1000}s: ${url}`));
        return;
      }
      setTimeout(probe, 500);
    };
    probe();
  });
}

function waitForBackend(timeoutMs) {
  return waitForUrl(`${BACKEND_URL}/api/health/`, timeoutMs);
}

// ── backend child ─────────────────────────────────────────────────

function startBackend() {
  const entry = path.join(appRoot, "backend", "dist", "index.js");
  if (!fs.existsSync(entry)) {
    throw new Error(`backend bundle missing: ${entry} — run npm run desktop:build:win first`);
  }

  const env = {
    ...process.env,
    // Run the Electron binary as a plain Node runtime. Inherited by any
    // grandchild the backend spawns (netlist-export), so the whole chain
    // behaves exactly like the dev setup.
    ELECTRON_RUN_AS_NODE: "1",
    PORT: String(BACKEND_PORT),
    // Follow the pinned user-data dir (the backend writes dies/overlays here).
    CHIPTOOL_DATA_ROOT: path.join(app.getPath("userData"), "data"),
    CHIPTOOL_FRONTEND_DIST: path.join(appRoot, "frontend", "dist"),
    CHIPTOOL_APP_ROOT: appRoot,
    NO_COLOR: "1"
  };

  // Bundled simulators beat whatever the system PATH offers. ngspice keeps the
  // official Spice64 layout (share/ init files resolve relative to the binary).
  const ngspice = bundledBinary([
    "Spice64/bin/ngspice_con.exe",
    "ngspice_con.exe",
    "ngspice_con",
    "ngspice.exe",
    "ngspice"
  ]);
  const lvs = bundledBinary(["vyges-lvs.exe", "vyges-lvs"]);
  if (ngspice) env.NGSPICE_BIN = ngspice;
  if (lvs) env.LVS_CLI_PATH = lvs;
  // Make the bundled helper binaries resolvable by anything that `which`es.
  if (process.platform === "win32") {
    env.PATH = `${binDir};${env.PATH ?? ""}`;
  } else {
    env.PATH = `${binDir}:${env.PATH ?? ""}`;
  }

  backend = spawn(
    process.execPath,
    // --import tsx: "shared" ships as TS sources inside node_modules, and
    // plain Node refuses type stripping there — same trick the backend's own
    // netlist-export spawn already uses.
    ["--import", "tsx", entry],
    {
      cwd: appRoot,
      env,
      windowsHide: true,
      // The backend log lands next to the shell log: double-click launches
      // have no console, so this file is the only visible trace otherwise.
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  backend.stdout.on("data", (chunk) => log(`[backend] ${String(chunk).trimEnd()}`));
  backend.stderr.on("data", (chunk) => log(`[backend:err] ${String(chunk).trimEnd()}`));
  backend.on("error", (error) => log(`backend spawn failed: ${error.message}`));
  backend.on("exit", (code) => {
    backend = null;
    if (code && !quitting) log(`backend exited with code ${code}`);
  });
  return backend;
}

function stopBackend() {
  if (!backend) return;
  const child = backend;
  backend = null;
  if (process.platform === "win32") {
    // Node kills only the direct child; the backend may have spawned helpers.
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {
      try {
        child.kill();
      } catch {}
    });
  } else {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 3000).unref();
  }
}

// ── ML sidecar plugin (optional) ──────────────────────────────────
//
// The ML sidecar ships as an optional plugin: scripts/setup_ml_desktop.ps1
// / setup_ml_desktop.sh (staged next to the exe as setup_ml.*) create a
// Python venv inside resources/app/ml — exactly the dev repo layout. When
// the venv is present the shell starts the sidecar next to the backend
// (local and serve modes); without it the app runs as before and ML
// features answer "sidecar unreachable". In --connect mode ML is the
// server's business, so the client never starts one.

const ML_DIR = path.join(appRoot, "ml");
let sidecar = null;

function findSidecarPlugin() {
  const script = path.join(ML_DIR, "sidecar.py");
  const python = path.join(
    ML_DIR,
    ".venv",
    ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"])
  );
  if (fs.existsSync(python) && fs.existsSync(script)) return { python, script };
  return null;
}

/** Port the sidecar should listen on; follows CHIPTOOL_ML_SIDECAR_URL. */
function mlSidecarPort() {
  const url = process.env.CHIPTOOL_ML_SIDECAR_URL;
  if (url) {
    try {
      const port = Number(new URL(url).port);
      if (port > 0) return port;
    } catch {}
  }
  return 8001;
}

function startSidecar() {
  const plugin = findSidecarPlugin();
  if (!plugin) {
    log("ml sidecar: плагин не установлен (опционально) — запустите setup_ml.ps1 / setup_ml.sh рядом с mmo-chip.exe");
    return;
  }
  const port = mlSidecarPort();
  log(`ml sidecar: плагин найден — запускаю на 127.0.0.1:${port}`);
  sidecar = spawn(
    plugin.python,
    [
      plugin.script,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      // Keep training data / cv dumps in the profile, not inside the app dir.
      "--data-root",
      path.join(app.getPath("userData"), "data")
    ],
    {
      cwd: ML_DIR,
      env: {
        ...process.env,
        // Stream log lines instead of buffering them in the pipe.
        PYTHONUNBUFFERED: "1",
        PYTHONIOENCODING: "utf-8"
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  sidecar.stdout.on("data", (chunk) => log(`[sidecar] ${String(chunk).trimEnd()}`));
  sidecar.stderr.on("data", (chunk) => log(`[sidecar:err] ${String(chunk).trimEnd()}`));
  sidecar.on("error", (error) => log(`sidecar spawn failed: ${error.message}`));
  sidecar.on("exit", (code) => {
    sidecar = null;
    if (code && !quitting) log(`sidecar exited with code ${code}`);
  });
  // First start imports torch (slow, sometimes minutes) — probe in the
  // background and just record the outcome, the window must not wait.
  waitForUrl(`http://127.0.0.1:${port}/health`, 10 * 60_000)
    .then(() => log(`sidecar up on http://127.0.0.1:${port}`))
    .catch(() => log("sidecar: /health не ответил за 10 минут — ML может быть недоступен (см. [sidecar] логи)"));
}

function stopSidecar() {
  if (!sidecar) return;
  const child = sidecar;
  sidecar = null;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {
      try {
        child.kill();
      } catch {}
    });
  } else {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 3000).unref();
  }
}

// ── window ────────────────────────────────────────────────────────

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }
  const { width = 1600, height = 960, maximized = true } = loadWindowBounds();
  mainWindow = new BrowserWindow({
    // Frameless in the app's own style: drag + controls live in the TopBar.
    frame: false,
    backgroundColor: "#0b0d10",
    minWidth: 900,
    minHeight: 600,
    width,
    height,
    show: false,
    title: "mmo-chip",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });
  if (maximized) mainWindow.maximize();
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("resize", saveWindowBoundsSoon);
  mainWindow.on("maximize", () => mainWindow?.webContents.send("desktop:state", maximizedState()));
  mainWindow.on("unmaximize", () => mainWindow?.webContents.send("desktop:state", maximizedState()));
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    showError("Окно приложения закрылось", `renderer: ${details.reason} (exit code ${details.exitCode})`);
  });

  // --connect: the server may be down/unreachable — offer a retry instead of
  // leaving a blank frameless window (main frame loads only).
  if (launchMode === "connect") {
    mainWindow.webContents.on("did-fail-load", async (_event, code, desc, url, isMain) => {
      if (!isMain) return;
      log(`connect failed: [${code}] ${desc} ${url}`);
      try {
        const { response } = await dialog.showMessageBox(mainWindow, {
          type: "warning",
          title: "mmo-chip",
          message: "Не удалось подключиться к серверу",
          detail: `${url}\n[${code}] ${desc}\n\nПроверьте, что сервер запущен (--serve) и доступен по сети.`,
          buttons: ["Повторить", "Закрыть окно"],
          defaultId: 0,
          cancelId: 1
        });
        if (response === 0) mainWindow?.loadURL(targetUrl);
        else mainWindow?.close();
      } catch {}
    });
  }

  // Open external links (docs, sourceforge …) in the real browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.loadURL(targetUrl);
  return mainWindow;
}

function maximizedState() {
  return { maximized: !!mainWindow?.isMaximized() };
}

function loadWindowBounds() {
  try {
    const file = path.join(app.getPath("userData"), "window.json");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

let boundsTimer = null;
function saveWindowBoundsSoon() {
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      fs.writeFileSync(
        path.join(app.getPath("userData"), "window.json"),
        JSON.stringify({
          maximized: mainWindow.isMaximized(),
          ...(mainWindow.isMaximized() ? {} : mainWindow.getBounds())
        })
      );
    } catch {}
  }, 400);
}

// ── tray (serve mode) ─────────────────────────────────────────────

// 16×16 green dot: "server running". Embedded so the tray works in every
// context (dev staging, asar) without shipping an icon file.
const TRAY_ICON_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAADbSURBVDhPtVIhEgIxDDyJRCKRSCQOHNeDGZBIJJIfpI4n8ASegETyBAS9i0QikZCUzMG04QqCnVnT7m6SSbK/YorQmyCMCoS+PKUxRGiZym6K0t6Kyt4D7iisI9IYXMmU9qQYa9L/hbsSywtcmaqiZgpJIdeoE/rYhsIm0ph7sdbVtZkbOUbo+gCeXROkaM4w9wHGwUoTpGhKsD7A71oRJOlg6QNmCG1VkOL7gdHDIRI0kVYu1if4bH/ZhHpMuYPFNyGkW4slhnRy1Iwfz1hDjjDg9fKquKJuzLIHHze2bBzzNfEAAAAASUVORK5CYII=";

function createTray() {
  tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON_DATA_URL));
  tray.setToolTip(`mmo-chip — сервер на :${BACKEND_PORT}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "mmo-chip: сервер запущен", enabled: false },
      { label: BACKEND_URL, enabled: false },
      // Read-only URLs: teammates can read them straight off the menu.
      ...lanUrls.map((url) => ({ label: url, enabled: false })),
      { type: "separator" },
      {
        label: "Копировать ссылку",
        click: () => clipboard.writeText(lanUrls[0] ?? BACKEND_URL)
      },
      { label: "Открыть окно", click: () => createWindow() },
      { type: "separator" },
      {
        label: "Выход",
        click: () => {
          quitting = true;
          app.quit();
        }
      }
    ])
  );
}

// ── IPC from the frameless title bar ──────────────────────────────

ipcMain.on("desktop:window", (_event, action) => {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
  if (!win) return;
  switch (action) {
    case "minimize":
      win.minimize();
      break;
    case "toggle-maximize":
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
      break;
    case "close":
      win.close();
      break;
    default:
      break;
  }
});
ipcMain.handle("desktop:info", () => ({
  platform: process.platform,
  version: app.getVersion(),
  // In --connect mode this is the remote server the window actually talks to.
  backendUrl: targetUrl,
  frameless: true,
  // ML plugin installed into this app dir (setup_ml.ps1/.sh)? The frontend
  // can use it to point users at the installer instead of dead ML tabs.
  mlSidecar: findSidecarPlugin() !== null
}));

// ── lifecycle ─────────────────────────────────────────────────────

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else if (SERVE) {
      // A second --serve launch doubles as "reveal the window".
      createWindow();
    }
  });

  app.whenReady().then(async () => {
    initConsoleCodepage();
    initDataDir();
    initLogging();
    log(`userData: ${dataDirChoice}`);
    try {
      const launch = resolveLaunchMode();
      launchMode = launch.mode;
      if (launch.mode === "connect") targetUrl = launch.url;
      else if (launch.mode === "dev") targetUrl = VITE_URL;
      else targetUrl = BACKEND_URL;
      log(`mode: ${launch.mode} → ${targetUrl}`);

      if (launch.mode === "serve" || launch.mode === "local") {
        log("starting backend…");
        startBackend();
        await waitForBackend(30_000);
        log(`backend up on ${BACKEND_URL}`);
        // Optional ML plugin: start after the backend, don't block the window
        // on torch import — health is probed in the background.
        startSidecar();
      }

      if (launch.mode === "serve") {
        // No window: the process lives in the tray and serves the LAN.
        lanUrls = discoverLanUrls();
        for (const url of lanUrls) log(`serve: ${url}`);
        log(`serve: коллеги открывают ${lanUrls[0] ?? BACKEND_URL} в браузере`);
        createTray();
        log("serve mode: окно не открывается автоматически — см. трей");
      } else {
        createWindow();
      }
    } catch (error) {
      showError(
        "Не удалось запустить приложение",
        error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)
      );
      app.exit(1);
    }
  });

  app.on("window-all-closed", () => {
    // Serve mode: closing the window keeps the server alive in the tray.
    if (SERVE) {
      log("окно закрыто — сервер продолжает работать (трей)");
      return;
    }
    quitting = true;
    stopBackend();
    stopSidecar();
    app.quit();
  });

  app.on("before-quit", () => {
    quitting = true;
    stopBackend();
    stopSidecar();
  });

  process.on("uncaughtException", (error) => {
    showError("Внутренняя ошибка приложения", error.stack ?? error.message);
  });
}
