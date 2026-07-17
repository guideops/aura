import path from "node:path";
import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, Menu, nativeImage, safeStorage, Tray } from "electron";
import { TokenStore } from "./token-store.js";

const PORT = Number(process.env["AURA_PORT"] ?? 8311);
const HOST = "127.0.0.1"; // local-only by design; never bind 0.0.0.0
const BASE = `http://${HOST}:${PORT}`;
const dirname = path.dirname(fileURLToPath(import.meta.url));

let store: TokenStore;
let tray: Tray | null = null;
let quitting = false;

/** Icons live in resources/icons (dev) or process.resourcesPath/icons (packaged). */
function iconPath(name: string): string {
  const packaged = path.join(process.resourcesPath ?? "", "icons", name);
  if (app.isPackaged && fs.existsSync(packaged)) return packaged;
  return path.join(dirname, "..", "resources", "icons", name);
}

/**
 * Boots the daemon as a child `node` process (NOT in-process): native modules
 * (better-sqlite3) are compiled for the system Node ABI, which differs from
 * Electron's. Child keeps the daemon testable under plain Node and isolates
 * crashes from the UI shell. Resolves once /api/health answers.
 */
async function startDaemon(): Promise<void> {
  const dataDir = path.join(app.getPath("userData"), "aura");
  fs.mkdirSync(dataDir, { recursive: true });
  // Packaged builds carry a bundled daemon in resources/; dev resolves the
  // workspace package. Both are driven by the system `node` (ABI, see above).
  let cliPath: string;
  let publicDir: string | undefined;
  const bundled = path.join(process.resourcesPath ?? "", "daemon", "cli.cjs");
  if (app.isPackaged && fs.existsSync(bundled)) {
    cliPath = bundled;
    publicDir = path.join(path.dirname(bundled), "public");
  } else {
    const require = createRequire(import.meta.url);
    // dist/index.js → sibling cli.js
    cliPath = path.join(path.dirname(require.resolve("@aura/daemon")), "cli.js");
  }
  const child: ChildProcess = spawn(process.env["AURA_NODE"] ?? "node", [cliPath], {
    cwd: dataDir,
    shell: process.platform === "win32", // resolve node from PATH
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      AURA_PORT: String(PORT),
      AURA_DB: path.join(dataDir, "aura.db"),
      AURA_VAULT: process.env["AURA_VAULT"] ?? path.join(dataDir, "vault"),
      AURA_SKILLS: process.env["AURA_SKILLS"] ?? path.join(dataDir, "skills"),
      ...(publicDir ? { AURA_PUBLIC: publicDir } : {}),
    },
  });
  child.stderr?.on("data", (d: Buffer) => console.error(`[daemon] ${d}`));
  app.on("will-quit", () => {
    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { shell: true });
    } else {
      child.kill("SIGTERM");
    }
  });
  // Poll health until the daemon is up (10s budget).
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("daemon failed to start within 10s");
}

/** Relinks GitHub sync from the encrypted store; silent no-op when unlinked. */
async function relinkGitHub(): Promise<boolean> {
  const link = store.load();
  if (!link) return false;
  const res = await fetch(`${BASE}/api/github/link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...link, intervalMs: 60_000 }), // desktop defaults to auto-sync
  });
  return res.ok;
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: "AURA",
    backgroundColor: "#0e1116",
    icon: iconPath("icon-256.png"),
    webPreferences: {
      preload: path.join(dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  void win.loadURL(`${BASE}/app/index.html`);
  // Close = hide to tray; the daemon (and office) keep running. Quit via tray.
  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  return win;
}

function showMain(win: BrowserWindow, page?: string): void {
  if (page) void win.loadURL(`${BASE}/${page}`);
  win.show();
  win.focus();
}

function createTray(win: BrowserWindow): void {
  const image = nativeImage.createFromPath(iconPath("icon-32.png"));
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip("AURA — agent command center");
  const menu = Menu.buildFromTemplate([
    { label: "Open Command Center", click: () => showMain(win, "app/index.html") },
    { label: "Office", click: () => showMain(win, "app/index.html?view=office") },
    { label: "Board", click: () => showMain(win, "app/index.html?view=board") },
    { label: "Connections", click: () => showMain(win, "app/index.html?view=connections") },
    { type: "separator" },
    {
      label: "Sync GitHub now",
      click: () => { void fetch(`${BASE}/api/github/sync`, { method: "POST" }).catch(() => {}); },
    },
    {
      label: "Start at login",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: "separator" },
    { label: "Quit AURA", click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on("double-click", () => showMain(win));
}

function openSettings(parent: BrowserWindow): void {
  const win = new BrowserWindow({
    width: 460,
    height: 420,
    parent,
    modal: true,
    title: "AURA — GitHub Sync",
    backgroundColor: "#0e1116",
    webPreferences: {
      preload: path.join(dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  void win.loadFile(path.join(dirname, "..", "static", "settings.html"));
}

// Single instance: second launch just surfaces the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}
app.on("second-instance", () => {
  const [win] = BrowserWindow.getAllWindows();
  if (win) { win.show(); win.focus(); }
});
app.on("before-quit", () => { quitting = true; });

app.whenReady().then(async () => {
  store = new TokenStore(path.join(app.getPath("userData"), "aura"), safeStorage);

  ipcMain.handle("github:save", async (_ev, token: string, projectId: string) => {
    if (typeof token !== "string" || typeof projectId !== "string" || !token || !projectId) {
      return { ok: false, error: "token and projectId required" };
    }
    store.save({ token, projectId });
    const linked = await relinkGitHub();
    return { ok: linked, error: linked ? undefined : "daemon rejected link" };
  });
  ipcMain.handle("github:status", async () => {
    const res = await fetch(`${BASE}/api/github/status`).then((r) => r.json());
    return { ...(res as object), stored: store.load() !== null };
  });
  ipcMain.handle("github:clear", async () => {
    store.clear();
    return { ok: true };
  });

  await startDaemon();
  await relinkGitHub().catch(() => false);

  const main = createWindow();
  const pages = [
    { label: "Command Center", page: "app/index.html" },
    { label: "Office", page: "office.html" },
    { label: "Board", page: "board.html" },
    { label: "Console", page: "index.html" },
  ];
  const menu = Menu.buildFromTemplate([
    {
      label: "View",
      submenu: [
        ...pages.map((p) => ({
          label: p.label,
          click: () => { void main.loadURL(`${BASE}/${p.page}`); },
        })),
        { type: "separator" as const },
        { role: "reload" as const },
        { role: "toggleDevTools" as const },
      ],
    },
    {
      label: "Sync",
      submenu: [{ label: "GitHub Sync…", click: () => openSettings(main) }],
    },
  ]);
  Menu.setApplicationMenu(menu);
  createTray(main);
});

// Tray keeps the app alive when the window hides; quitting only via tray/menu.
app.on("window-all-closed", () => {
  if (quitting) app.quit();
});
