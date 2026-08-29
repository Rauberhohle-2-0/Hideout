import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import { HELLO_WORLD, IPC_CHANNELS, type AiChatIpcRequest } from '../shared/api.ts'
import { getServerUrl, startHonoServer, stopHonoServer } from '../server/index.ts'
import { Logger } from '../logger.ts'
import { getDefaultRegistry } from '../ai/index.ts'
import { setStoreDir } from '../ai/secure-store.ts'
import { AiError } from '../ai/errors.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const logger = new Logger({ prefix: 'main' })

function getPreloadPath(): string {
  // Sandbox preload must be CommonJS (.cjs) — ESM import fails in sandbox_bundle with
  // "Cannot use import statement outside a module". The build step generates preload.cjs from preload.ts
  // via scripts/build-preload-cjs.mjs. Prefer .cjs if present, fallback to .js for dev.
  const cjs = path.join(__dirname, '../preload/preload.cjs')
  if (fs.existsSync(cjs)) return cjs
  return path.join(__dirname, '../preload/preload.js')
}

function getRendererHtmlPath(): string {
  // Try built location first (dist/renderer/index.html), fallback to src/renderer/index.html for dev
  const built = path.join(__dirname, '../renderer/index.html')
  if (fs.existsSync(built)) return built
  // __dirname = dist/main => ../../src/renderer/index.html
  const srcPath = path.join(__dirname, '../../src/renderer/index.html')
  if (fs.existsSync(srcPath)) return srcPath
  // Fallback absolute relative to project root (when running via electron .)
  const cwdSrc = path.join(process.cwd(), 'src/renderer/index.html')
  return cwdSrc
}

function attachHonoServer(win: BrowserWindow): void {
  let started = false
  const startOnce = (): void => {
    if (started) return
    started = true
    try {
      const server = startHonoServer()
      // Log URL once listening; getServerUrl() may be provisional until callback
      server.once('listening', () => {
        logger.info(`Hono server listening at ${getServerUrl()}`)
      })
      // Fallback if already listening (unlikely)
      setTimeout(() => {
        const url = getServerUrl()
        if (url) logger.info(`Hono server URL: ${url}`)
      }, 100)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`Failed to start Hono server: ${msg}`)
    }
  }

  // Start when window is visible / ready to be shown (satisfies "when window appears")
  win.once('ready-to-show', startOnce)
  // Fallback: window with show:true may already be visible before ready-to-show fires in some configs
  win.once('show', startOnce)
  // Final safety: ensure server starts after content loaded even if events missed
  win.webContents.once('did-finish-load', () => {
    // slight delay to let "show" fire first if it will
    setTimeout(startOnce, 50)
  })
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: true,
    backgroundColor: '#ffffff',
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
  })

  attachHonoServer(win)

  // Security: block navigation to external URLs / untrusted origins
  win.webContents.on('will-navigate', (event, url) => {
    const parsed = new URL(url)
    // Only allow file:// navigation for our own renderer
    if (parsed.protocol !== 'file:') {
      event.preventDefault()
      logger.warn(`Blocked will-navigate to ${parsed.protocol}//${parsed.host}`)
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    // Deny all new windows; if external https is needed explicitly allow via shell.openExternal with validation
    const parsed = (() => {
      try {
        return new URL(url)
      } catch {
        return null
      }
    })()
    if (parsed && (parsed.protocol === 'https:' || parsed.protocol === 'http:')) {
      // For this Hello World app, deny blind open. If you need to allow, validate against allowlist.
      // Example strict allowlist: never blindly open user-controlled URLs
      // For now deny and log
      logger.warn(`Blocked window.open to ${url}`)
      return { action: 'deny' }
    }
    return { action: 'deny' }
  })

  // Extra hardening: enforce CSP headers via webRequest (defense in depth, meta CSP already in HTML)
  // Even with sandbox, this prevents inline unsafe-eval
  const ses = win.webContents.session
  ses.webRequest.onHeadersReceived((details, callback) => {
    const csp =
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' http://127.0.0.1:* http://localhost:*; base-uri 'none'; form-action 'none';"
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    })
  })

  // Prevent permission requests by default (security: no media, geolocation, etc.)
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })

  const htmlPath = getRendererHtmlPath()
  logger.info(`Loading renderer: ${htmlPath}`)
  void win.loadFile(htmlPath)

  // Optional: open devtools in development only via env
  if (process.env.NODE_ENV !== 'production' && process.env.ELECTRON_OPEN_DEVTOOLS === '1') {
    win.webContents.openDevTools({ mode: 'detach' })
  }

  return win
}

function assertString(v: unknown, label: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`${label} must be a non-empty string`)
  if (v.length > 256) throw new Error(`${label} too long`)
  return v
}

function registerIpc(): void {
  // Validate all IPC input: for this app no input needed, but pattern is important
  ipcMain.handle(IPC_CHANNELS.HELLO_WORLD, async (): Promise<string> => {
    // No user input to validate, return constant
    return HELLO_WORLD
  })

  ipcMain.handle(IPC_CHANNELS.PING, async (): Promise<string> => {
    return 'pong'
  })

  // ---- AI IPC — universal provider interface (secrets never leave Main) ----
  ipcMain.handle(IPC_CHANNELS.AI_LIST_PROVIDERS, async () => {
    const registry = getDefaultRegistry()
    return registry.list().map((p) => ({
      id: p.id,
      displayName: p.displayName,
      kind: p.kind,
      capabilities: p.getCapabilities(),
      config: (p as unknown as { getConfig: () => unknown }).getConfig?.() ?? { id: p.id },
    }))
  })

  ipcMain.handle(IPC_CHANNELS.AI_HEALTH, async (_evt, providerId: unknown) => {
    const id = assertString(providerId, 'providerId')
    const registry = getDefaultRegistry()
    const provider = registry.get(id)
    if (!provider) throw new Error(`Provider not found: ${id}`)
    return provider.healthCheck()
  })

  ipcMain.handle(IPC_CHANNELS.AI_LIST_MODELS, async (_evt, providerId: unknown) => {
    const id = assertString(providerId, 'providerId')
    const registry = getDefaultRegistry()
    const provider = registry.get(id)
    if (!provider) throw new Error(`Provider not found: ${id}`)
    return provider.listModels()
  })

  ipcMain.handle(IPC_CHANNELS.AI_CHAT, async (_evt, req: unknown) => {
    const r = req as AiChatIpcRequest
    if (!r || typeof r.providerId !== 'string' || !Array.isArray(r.messages) || r.messages.length === 0) {
      throw new Error('Invalid chat request: providerId and non-empty messages required')
    }
    const providerId = assertString(r.providerId, 'providerId')
    // Validate messages shape + size (prevent abuse)
    for (let i = 0; i < r.messages.length; i++) {
      const m = r.messages[i] as { role?: unknown; content?: unknown }
      if (!m || typeof m.role !== 'string' || typeof m.content !== 'string') {
        throw new Error(`messages[${i}] must have string role and content`)
      }
      if (!['system', 'user', 'assistant', 'tool'].includes(m.role)) {
        throw new Error(`messages[${i}].role invalid`)
      }
      if ((m.content as string).length > 200_000) throw new Error(`messages[${i}].content too large`)
    }
    if (r.model !== undefined && typeof r.model !== 'string') throw new Error('model must be string')
    if (r.temperature !== undefined && (typeof r.temperature !== 'number' || r.temperature < 0 || r.temperature > 2)) {
      throw new Error('temperature must be 0..2')
    }
    if (r.maxTokens !== undefined && (typeof r.maxTokens !== 'number' || r.maxTokens <= 0 || r.maxTokens > 200_000)) {
      throw new Error('maxTokens invalid')
    }

    const registry = getDefaultRegistry()
    const provider = registry.get(providerId)
    if (!provider) throw new Error(`Provider not found: ${providerId}`)

    try {
      return await provider.chat(r.messages as never, {
        model: r.model,
        temperature: r.temperature,
        maxTokens: r.maxTokens,
        topP: r.topP,
        stop: r.stop,
        timeoutMs: 120_000,
      })
    } catch (err) {
      // Preserve AiError code for renderer UX, but strip internal details
      if (err instanceof AiError) throw new Error(`${err.code}: ${err.message}`)
      throw err
    }
  })
}

function initSecureStore(): void {
  try {
    // app.getPath('userData') is only available after app.whenReady, but
    // initSecureStore is called inside whenReady — safe.
    const userData = app.getPath('userData')
    setStoreDir(userData)
    logger.info(`Secure store dir: ${userData}`)
    // Hydrate secrets (non-blocking, but log failures)
    void getDefaultRegistry()
      .hydrateSecrets()
      .catch((err) => logger.warn(`hydrateSecrets failed: ${(err as Error).message}`))
  } catch (err) {
    logger.warn(`initSecureStore failed: ${(err as Error).message}`)
  }
}

void app.whenReady().then(() => {
  initSecureStore()
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  // Graceful Hono shutdown adheres to Electron lifecycle; no dangling server on quit
  void stopHonoServer()
})

app.on('window-all-closed', () => {
  void stopHonoServer()
  if (process.platform !== 'darwin') app.quit()
})

// Security: discourage navigation via shell injection patterns — use spawn with args, not exec with shell strings
// For Hideout AI endpoints: only allow explicitly permitted Ollama/LM Studio endpoints and validate URLs/ports
