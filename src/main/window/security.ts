import type { BrowserWindow } from 'electron'
import { Logger } from '../../logger.ts'

const logger = new Logger({ prefix: 'main' })

/**
 * Centralized Electron security policy.
 * All window hardening must go through here — audit-friendly.
 */
export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' http://127.0.0.1:* http://localhost:*; base-uri 'none'; form-action 'none';"

export function getSecureWebPreferences(preloadPath: string): Electron.WebPreferences {
  return {
    preload: preloadPath,
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webviewTag: false,
    allowRunningInsecureContent: false,
  }
}

export function registerNavigationGuard(win: BrowserWindow): void {
  win.webContents.on('will-navigate', (event, url) => {
    const parsed = new URL(url)
    if (parsed.protocol !== 'file:') {
      event.preventDefault()
      logger.warn(`Blocked will-navigate to ${parsed.protocol}//${parsed.host}`)
    }
  })
}

export function registerWindowOpenHandler(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    const parsed = (() => {
      try {
        return new URL(url)
      } catch {
        return null
      }
    })()
    if (parsed && (parsed.protocol === 'https:' || parsed.protocol === 'http:')) {
      logger.warn(`Blocked window.open to ${url}`)
      return { action: 'deny' }
    }
    return { action: 'deny' }
  })
}

export function registerCspHandler(win: BrowserWindow): void {
  const ses = win.webContents.session
  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP],
      },
    })
  })
}

export function registerPermissionHandler(win: BrowserWindow): void {
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false)
  })
}

export function applySecurity(win: BrowserWindow): void {
  registerNavigationGuard(win)
  registerWindowOpenHandler(win)
  registerCspHandler(win)
  registerPermissionHandler(win)
}
