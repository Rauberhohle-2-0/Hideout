import { BrowserWindow } from 'electron'
import { Logger } from '../../logger.ts'
import { getServerUrl, startHonoServer } from '../../server/index.ts'
import { getPreloadPath, getRendererHtmlPath } from './paths.ts'
import { applySecurity, getSecureWebPreferences } from './security.ts'

const logger = new Logger({ prefix: 'main' })

function attachHonoServer(win: BrowserWindow): void {
  let started = false
  const startOnce = (): void => {
    if (started) return
    started = true
    try {
      const server = startHonoServer()
      server.once('listening', () => {
        logger.info(`Hono server listening at ${getServerUrl()}`)
      })
      setTimeout(() => {
        const url = getServerUrl()
        if (url) logger.info(`Hono server URL: ${url}`)
      }, 100)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`Failed to start Hono server: ${msg}`)
    }
  }

  win.once('ready-to-show', startOnce)
  win.once('show', startOnce)
  win.webContents.once('did-finish-load', () => {
    setTimeout(startOnce, 50)
  })
}

export function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: true,
    backgroundColor: '#ffffff',
    webPreferences: getSecureWebPreferences(getPreloadPath()),
  })

  attachHonoServer(win)
  applySecurity(win)

  const htmlPath = getRendererHtmlPath()
  logger.info(`Loading renderer: ${htmlPath}`)
  void win.loadFile(htmlPath)

  if (process.env.NODE_ENV !== 'production' && process.env.ELECTRON_OPEN_DEVTOOLS === '1') {
    win.webContents.openDevTools({ mode: 'detach' })
  }

  return win
}
