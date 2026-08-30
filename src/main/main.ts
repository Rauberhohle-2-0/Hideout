import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import { HELLO_WORLD, IPC_CHANNELS, type AiChatIpcRequest, type McpAddServerRequest, type AssistantAddRequest } from '../shared/api.ts'
import { getServerUrl, startHonoServer, stopHonoServer } from '../server/index.ts'
import { Logger } from '../logger.ts'
import { getDefaultRegistry } from '../ai/index.ts'
import { setStoreDir } from '../ai/secure-store.ts'
import { AiError } from '../ai/errors.ts'
import { getDefaultMcpRegistry, setMcpStoreDir } from '../mcp/registry.ts'
import { getDefaultMcpManager } from '../mcp/manager.ts'
import { McpError } from '../mcp/errors.ts'
import { EXA_MCP_PRESET } from '../mcp/types.ts'
import { getDefaultAssistantRegistry, setAssistantStoreDir } from '../assistants/registry.ts'
import { AssistantError } from '../assistants/errors.ts'

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
    if (r.topP !== undefined && (typeof r.topP !== 'number' || r.topP < 0 || r.topP > 1)) throw new Error('topP must be 0..1')
    if (r.topK !== undefined && (typeof r.topK !== 'number' || !Number.isInteger(r.topK) || r.topK < 0 || r.topK > 100)) throw new Error('topK must be integer 0..100')
    if (r.minP !== undefined && (typeof r.minP !== 'number' || r.minP < 0 || r.minP > 1)) throw new Error('minP must be 0..1')
    if (r.repeatPenalty !== undefined && (typeof r.repeatPenalty !== 'number' || r.repeatPenalty < 0 || r.repeatPenalty > 2)) throw new Error('repeatPenalty must be 0..2')
    if (r.frequencyPenalty !== undefined && (typeof r.frequencyPenalty !== 'number' || r.frequencyPenalty < -2 || r.frequencyPenalty > 2)) throw new Error('frequencyPenalty must be -2..2')
    if (r.presencePenalty !== undefined && (typeof r.presencePenalty !== 'number' || r.presencePenalty < -2 || r.presencePenalty > 2)) throw new Error('presencePenalty must be -2..2')
    if (r.seed !== undefined && (typeof r.seed !== 'number' || !Number.isInteger(r.seed))) throw new Error('seed must be integer')
    if (r.stop !== undefined && (!Array.isArray(r.stop) || !(r.stop as unknown[]).every((s) => typeof s === 'string'))) throw new Error('stop must be string[]')
    if (r.assistantId !== undefined && typeof r.assistantId !== 'string') throw new Error('assistantId must be string')

    const registry = getDefaultRegistry()
    const provider = registry.get(providerId)
    if (!provider) throw new Error(`Provider not found: ${providerId}`)

    // Resolve assistant adherence: inject system prompt + merge sampling params
    let messages: typeof r.messages = r.messages
    let model: string | undefined = r.model
    let temperature: number | undefined = r.temperature
    let maxTokens: number | undefined = r.maxTokens
    let topP: number | undefined = r.topP
    let topK: number | undefined = r.topK
    let minP: number | undefined = r.minP
    let repeatPenalty: number | undefined = r.repeatPenalty
    let frequencyPenalty: number | undefined = r.frequencyPenalty
    let presencePenalty: number | undefined = r.presencePenalty
    let seed: number | undefined = r.seed
    let stop: string[] | undefined = r.stop

    if (r.assistantId) {
      const aReg = getDefaultAssistantRegistry()
      const assistant = aReg.get(r.assistantId)
      if (!assistant) throw new Error(`Assistant not found: ${r.assistantId}`)
      if (assistant.enabled === false) throw new Error(`Assistant disabled: ${r.assistantId}`)
      const p = assistant.parameters ?? {}
      // request overrides assistant
      model = model ?? assistant.model
      temperature = temperature ?? p.temperature
      maxTokens = maxTokens ?? p.maxTokens
      topP = topP ?? p.topP
      topK = topK ?? p.topK
      minP = minP ?? p.minP
      repeatPenalty = repeatPenalty ?? p.repeatPenalty
      frequencyPenalty = frequencyPenalty ?? p.frequencyPenalty
      presencePenalty = presencePenalty ?? p.presencePenalty
      seed = seed ?? p.seed
      stop = stop ?? p.stop

      // Inject instructions as system message
      if (assistant.instructions) {
        const hasSystem = messages.length > 0 && messages[0]!.role === 'system'
        if (!hasSystem) {
          messages = [{ role: 'system', content: assistant.instructions }, ...messages]
        } else {
          const existing = messages[0]!
          const merged = `${assistant.instructions}\n\n${existing.content}`
          messages = [{ role: 'system', content: merged }, ...messages.slice(1)]
        }
      }
      // If assistant is adhered to a specific provider, warn if mismatched (allow but log)
      if (assistant.providerId && assistant.providerId !== providerId) {
        logger.info(`Assistant ${assistant.id} adhered to ${assistant.providerId} but chat uses ${providerId} — allowing`)
      }
    }

    try {
      return await provider.chat(messages as never, {
        model,
        temperature,
        maxTokens,
        topP,
        topK,
        minP,
        repeatPenalty,
        frequencyPenalty,
        presencePenalty,
        seed,
        stop,
        timeoutMs: 120_000,
      })
    } catch (err) {
      // Preserve AiError code for renderer UX, but strip internal details
      if (err instanceof AiError) throw new Error(`${err.code}: ${err.message}`)
      throw err
    }
  })

  // ---- MCP IPC — secrets never leave Main ----
  ipcMain.handle(IPC_CHANNELS.MCP_LIST_SERVERS, async () => {
    return getDefaultMcpRegistry().listSafe()
  })

  ipcMain.handle(IPC_CHANNELS.MCP_GET_SERVER, async (_evt, id: unknown) => {
    const sid = assertString(id, 'id')
    const s = getDefaultMcpRegistry().getSafe(sid)
    if (!s) throw new Error(`MCP server not found: ${sid}`)
    return s
  })

  ipcMain.handle(IPC_CHANNELS.MCP_ADD_SERVER, async (_evt, cfg: unknown) => {
    const c = cfg as McpAddServerRequest
    if (!c || typeof c.id !== 'string' || typeof c.name !== 'string' || typeof c.transport !== 'string') {
      throw new Error('Invalid MCP server config')
    }
    try {
      return await getDefaultMcpRegistry().add(c as never)
    } catch (err) {
      if (err instanceof McpError) throw new Error(`${err.code}: ${err.message}`)
      throw err
    }
  })

  ipcMain.handle(IPC_CHANNELS.MCP_UPDATE_SERVER, async (_evt, id: unknown, patch: unknown) => {
    const sid = assertString(id, 'id')
    if (!patch || typeof patch !== 'object') throw new Error('Invalid patch')
    try {
      return await getDefaultMcpRegistry().update(sid, patch as never)
    } catch (err) {
      if (err instanceof McpError) throw new Error(`${err.code}: ${err.message}`)
      throw err
    }
  })

  ipcMain.handle(IPC_CHANNELS.MCP_REMOVE_SERVER, async (_evt, id: unknown) => {
    const sid = assertString(id, 'id')
    try {
      await getDefaultMcpRegistry().remove(sid)
      return { ok: true as const }
    } catch (err) {
      if (err instanceof McpError) throw new Error(`${err.code}: ${err.message}`)
      throw err
    }
  })

  ipcMain.handle(IPC_CHANNELS.MCP_HEALTH, async (_evt, id: unknown) => {
    const sid = assertString(id, 'id')
    return getDefaultMcpManager().healthCheck(sid)
  })

  ipcMain.handle(IPC_CHANNELS.MCP_LIST_TOOLS, async (_evt, id: unknown) => {
    const sid = assertString(id, 'id')
    return getDefaultMcpManager().listTools(sid)
  })

  ipcMain.handle(IPC_CHANNELS.MCP_CONNECT, async (_evt, id: unknown) => {
    const sid = assertString(id, 'id')
    return getDefaultMcpManager().connect(sid)
  })

  ipcMain.handle(IPC_CHANNELS.MCP_DISCONNECT, async (_evt, id: unknown) => {
    const sid = assertString(id, 'id')
    await getDefaultMcpManager().disconnect(sid)
    return { ok: true as const }
  })

  ipcMain.handle(IPC_CHANNELS.MCP_SET_ENABLED, async (_evt, id: unknown, enabled: unknown) => {
    const sid = assertString(id, 'id')
    if (typeof enabled !== 'boolean') throw new Error('enabled must be boolean')
    try {
      const safe = await getDefaultMcpRegistry().setEnabled(sid, enabled)
      // If disabling, ensure any active connection / cached tools are cleared
      if (!enabled) {
        await getDefaultMcpManager().disconnect(sid).catch(() => {})
      }
      return safe
    } catch (err) {
      if (err instanceof McpError) throw new Error(`${err.code}: ${err.message}`)
      throw err
    }
  })

  // ---- Assistant IPC — system prompt + sampling params + model adherence ----
  ipcMain.handle(IPC_CHANNELS.ASSISTANT_LIST, async () => {
    return getDefaultAssistantRegistry().list()
  })

  ipcMain.handle(IPC_CHANNELS.ASSISTANT_GET, async (_evt, id: unknown) => {
    const sid = assertString(id, 'id')
    const a = getDefaultAssistantRegistry().get(sid)
    if (!a) throw new Error(`Assistant not found: ${sid}`)
    return a
  })

  ipcMain.handle(IPC_CHANNELS.ASSISTANT_ADD, async (_evt, cfg: unknown) => {
    const c = cfg as AssistantAddRequest
    if (!c || typeof c.id !== 'string' || typeof c.name !== 'string' || typeof c.instructions !== 'string') {
      throw new Error('Invalid assistant config: id, name, instructions required')
    }
    try {
      return await getDefaultAssistantRegistry().add(c as never)
    } catch (err) {
      if (err instanceof AssistantError) throw new Error(`${err.code}: ${err.message}`)
      throw err
    }
  })

  ipcMain.handle(IPC_CHANNELS.ASSISTANT_UPDATE, async (_evt, id: unknown, patch: unknown) => {
    const sid = assertString(id, 'id')
    if (!patch || typeof patch !== 'object') throw new Error('Invalid patch')
    try {
      return await getDefaultAssistantRegistry().update(sid, patch as never)
    } catch (err) {
      if (err instanceof AssistantError) throw new Error(`${err.code}: ${err.message}`)
      throw err
    }
  })

  ipcMain.handle(IPC_CHANNELS.ASSISTANT_REMOVE, async (_evt, id: unknown) => {
    const sid = assertString(id, 'id')
    try {
      await getDefaultAssistantRegistry().remove(sid)
      return { ok: true as const }
    } catch (err) {
      if (err instanceof AssistantError) throw new Error(`${err.code}: ${err.message}`)
      throw err
    }
  })

  ipcMain.handle(IPC_CHANNELS.ASSISTANT_SET_ENABLED, async (_evt, id: unknown, enabled: unknown) => {
    const sid = assertString(id, 'id')
    if (typeof enabled !== 'boolean') throw new Error('enabled must be boolean')
    try {
      return await getDefaultAssistantRegistry().setEnabled(sid, enabled)
    } catch (err) {
      if (err instanceof AssistantError) throw new Error(`${err.code}: ${err.message}`)
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
    setMcpStoreDir(userData)
    setAssistantStoreDir(userData)
    logger.info(`Secure store dir: ${userData}`)
    // Hydrate secrets (non-blocking, but log failures)
    void getDefaultRegistry()
      .hydrateSecrets()
      .catch((err) => logger.warn(`hydrateSecrets failed: ${(err as Error).message}`))

    // Ensure Exa preset exists for testing (no API key required)
    void (async () => {
      const reg = getDefaultMcpRegistry()
      if (!reg.getSafe(EXA_MCP_PRESET.id)) {
        try {
          await reg.add(EXA_MCP_PRESET)
          logger.info(`Seeded Exa MCP preset: ${EXA_MCP_PRESET.id}`)
        } catch (err) {
          // Already exists or validation error — not fatal
          if ((err as McpError)?.code !== "ALREADY_EXISTS") {
            logger.warn(`Failed to seed Exa preset: ${(err as Error).message}`)
          }
        }
      }
    })()
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
