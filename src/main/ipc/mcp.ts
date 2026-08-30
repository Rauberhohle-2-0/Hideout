import { ipcMain } from 'electron'
import { IPC_CHANNELS, type McpAddServerRequest } from '../../shared/api.ts'
import { getDefaultMcpRegistry } from '../../mcp/registry.ts'
import { getDefaultMcpManager } from '../../mcp/manager.ts'
import { McpError } from '../../mcp/errors.ts'
import { assertString } from './validators.ts'

export function registerMcpIpc(): void {
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
      if (!enabled) {
        await getDefaultMcpManager().disconnect(sid).catch(() => {})
      }
      return safe
    } catch (err) {
      if (err instanceof McpError) throw new Error(`${err.code}: ${err.message}`)
      throw err
    }
  })
}
