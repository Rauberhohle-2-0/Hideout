import { ipcMain } from 'electron'
import { IPC_CHANNELS, type AssistantAddRequest } from '../../shared/api.ts'
import { getDefaultAssistantRegistry } from '../../assistants/registry.ts'
import { AssistantError } from '../../assistants/errors.ts'
import { assertString } from './validators.ts'

export function registerAssistantIpc(): void {
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
