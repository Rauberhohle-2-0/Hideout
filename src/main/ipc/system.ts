import { ipcMain } from 'electron'
import { HELLO_WORLD, IPC_CHANNELS } from '../../shared/api.ts'

export function registerSystemIpc(): void {
  ipcMain.handle(IPC_CHANNELS.HELLO_WORLD, async (): Promise<string> => {
    return HELLO_WORLD
  })
  ipcMain.handle(IPC_CHANNELS.PING, async (): Promise<string> => {
    return 'pong'
  })
}
