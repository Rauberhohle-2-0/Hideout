import { ipcMain } from 'electron'
import { IPC_CHANNELS, type AiChatIpcRequest } from '../../shared/api.ts'
import { Logger } from '../../logger.ts'
import { getDefaultRegistry } from '../../ai/index.ts'
import { AiError } from '../../ai/errors.ts'
import { getDefaultAssistantRegistry } from '../../assistants/registry.ts'
import { assertString } from './validators.ts'

const logger = new Logger({ prefix: 'main' })

export function registerAiIpc(): void {
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
      if (err instanceof AiError) throw new Error(`${err.code}: ${err.message}`)
      throw err
    }
  })
}
