import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { HELLO_WORLD, IPC_CHANNELS } from "../shared/api.ts";
import { getServerUrl, startHonoServer, stopHonoServer } from "../server/index.ts";
import { Logger } from "../logger.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = new Logger({ prefix: "main" });

function getPreloadPath(): string {
  // Compiled: dist/preload/preload.js (from dist/main/main.js => ../preload)
  return path.join(__dirname, "../preload/preload.js");
}

function getRendererHtmlPath(): string {
  // Try built location first (dist/renderer/index.html), fallback to src/renderer/index.html for dev
  const built = path.join(__dirname, "../renderer/index.html");
  if (fs.existsSync(built)) return built;
  // __dirname = dist/main => ../../src/renderer/index.html
  const srcPath = path.join(__dirname, "../../src/renderer/index.html");
  if (fs.existsSync(srcPath)) return srcPath;
  // Fallback absolute relative to project root (when running via electron .)
  const cwdSrc = path.join(process.cwd(), "src/renderer/index.html");
  return cwdSrc;
}

function attachHonoServer(win: BrowserWindow): void {
  let started = false;
  const startOnce = (): void => {
    if (started) return;
    started = true;
    try {
      const server = startHonoServer();
      // Log URL once listening; getServerUrl() may be provisional until callback
      server.once("listening", () => {
        logger.info(`Hono server listening at ${getServerUrl()}`);
      });
      // Fallback if already listening (unlikely)
      setTimeout(() => {
        const url = getServerUrl();
        if (url) logger.info(`Hono server URL: ${url}`);
      }, 100);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to start Hono server: ${msg}`);
    }
  };

  // Start when window is visible / ready to be shown (satisfies "when window appears")
  win.once("ready-to-show", startOnce);
  // Fallback: window with show:true may already be visible before ready-to-show fires in some configs
  win.once("show", startOnce);
  // Final safety: ensure server starts after content loaded even if events missed
  win.webContents.once("did-finish-load", () => {
    // slight delay to let "show" fire first if it will
    setTimeout(startOnce, 50);
  });
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: true,
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: getPreloadPath(),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      // disable webviewTag and remote
      webviewTag: false,
      allowRunningInsecureContent: false,
    },
  });

  attachHonoServer(win);

  // Security: block navigation to external URLs / untrusted origins
  win.webContents.on("will-navigate", (event, url) => {
    const parsed = new URL(url);
    // Only allow file:// navigation for our own renderer
    if (parsed.protocol !== "file:") {
      event.preventDefault();
      logger.warn(`Blocked will-navigate to ${parsed.protocol}//${parsed.host}`);
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    // Deny all new windows; if external https is needed explicitly allow via shell.openExternal with validation
    const parsed = (() => {
      try {
        return new URL(url);
      } catch {
        return null;
      }
    })();
    if (parsed && (parsed.protocol === "https:" || parsed.protocol === "http:")) {
      // For this Hello World app, deny blind open. If you need to allow, validate against allowlist.
      // Example strict allowlist: never blindly open user-controlled URLs
      // For now deny and log
      logger.warn(`Blocked window.open to ${url}`);
      return { action: "deny" };
    }
    return { action: "deny" };
  });

  // Extra hardening: enforce CSP headers via webRequest (defense in depth, meta CSP already in HTML)
  // Even with sandbox, this prevents inline unsafe-eval
  const ses = win.webContents.session;
  ses.webRequest.onHeadersReceived((details, callback) => {
    const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none';";
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp],
      },
    });
  });

  // Prevent permission requests by default (security: no media, geolocation, etc.)
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  const htmlPath = getRendererHtmlPath();
  logger.info(`Loading renderer: ${htmlPath}`);
  void win.loadFile(htmlPath);

  // Optional: open devtools in development only via env
  if (process.env.NODE_ENV !== "production" && process.env.ELECTRON_OPEN_DEVTOOLS === "1") {
    win.webContents.openDevTools({ mode: "detach" });
  }

  return win;
}

function registerIpc(): void {
  // Validate all IPC input: for this app no input needed, but pattern is important
  ipcMain.handle(IPC_CHANNELS.HELLO_WORLD, async (): Promise<string> => {
    // No user input to validate, return constant
    return HELLO_WORLD;
  });

  ipcMain.handle(IPC_CHANNELS.PING, async (): Promise<string> => {
    return "pong";
  });
}

void app.whenReady().then(() => {
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  // Graceful Hono shutdown adheres to Electron lifecycle; no dangling server on quit
  void stopHonoServer();
});

app.on("window-all-closed", () => {
  void stopHonoServer();
  if (process.platform !== "darwin") app.quit();
});

// Security: discourage navigation via shell injection patterns — use spawn with args, not exec with shell strings
// For Hideout AI endpoints: only allow explicitly permitted Ollama/LM Studio endpoints and validate URLs/ports
