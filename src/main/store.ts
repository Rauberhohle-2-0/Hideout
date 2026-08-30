import { app } from 'electron'
import { Logger } from '../logger.ts'
import { getDefaultRegistry } from '../ai/index.ts'
import { setStoreDir } from '../ai/secure-store.ts'
import { getDefaultMcpRegistry, setMcpStoreDir } from '../mcp/registry.ts'
import { McpError } from '../mcp/errors.ts'
import { EXA_MCP_PRESET } from '../mcp/types.ts'
import { getDefaultAssistantRegistry, setAssistantStoreDir } from '../assistants/registry.ts'

const logger = new Logger({ prefix: 'main' })

export function initSecureStore(): void {
  try {
    // app.getPath('userData') is only available after app.whenReady
    const userData = app.getPath('userData')
    setStoreDir(userData)
    setMcpStoreDir(userData)
    setAssistantStoreDir(userData)
    logger.info(`Secure store dir: ${userData}`)

    void getDefaultRegistry()
      .hydrateSecrets()
      .catch((err) => logger.warn(`hydrateSecrets failed: ${(err as Error).message}`))

    // Seed Exa preset for testing (no API key required)
    void (async () => {
      const reg = getDefaultMcpRegistry()
      if (!reg.getSafe(EXA_MCP_PRESET.id)) {
        try {
          await reg.add(EXA_MCP_PRESET)
          logger.info(`Seeded Exa MCP preset: ${EXA_MCP_PRESET.id}`)
        } catch (err) {
          if ((err as McpError)?.code !== 'ALREADY_EXISTS') {
            logger.warn(`Failed to seed Exa preset: ${(err as Error).message}`)
          }
        }
      }
    })()
  } catch (err) {
    logger.warn(`initSecureStore failed: ${(err as Error).message}`)
  }
}
