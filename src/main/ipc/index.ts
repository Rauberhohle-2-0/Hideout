import { registerSystemIpc } from './system.ts'
import { registerAiIpc } from './ai.ts'
import { registerMcpIpc } from './mcp.ts'
import { registerAssistantIpc } from './assistant.ts'

export function registerIpc(): void {
  registerSystemIpc()
  registerAiIpc()
  registerMcpIpc()
  registerAssistantIpc()
}

export { registerSystemIpc } from './system.ts'
export { registerAiIpc } from './ai.ts'
export { registerMcpIpc } from './mcp.ts'
export { registerAssistantIpc } from './assistant.ts'
