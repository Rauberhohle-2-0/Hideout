import { app, BrowserWindow } from 'electron'
import { stopHonoServer } from '../server/index.ts'
import { initSecureStore } from './store.ts'
import { registerIpc } from './ipc/index.ts'
import { createWindow } from './window/window.ts'

export function initLifecycle(): void {
  void app.whenReady().then(() => {
    initSecureStore()
    registerIpc()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('before-quit', () => {
    void stopHonoServer()
  })

  app.on('window-all-closed', () => {
    void stopHonoServer()
    if (process.platform !== 'darwin') app.quit()
  })
}
