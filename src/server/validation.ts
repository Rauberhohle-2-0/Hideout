import type { Context } from 'hono'
import type { AssistantConfig } from '../assistants/types.ts'
import { validateAssistantConfig } from '../assistants/validation.ts'
import type { McpServerConfig } from '../mcp/types.ts'
import { validateMcpServerConfig } from '../mcp/validation.ts'
import type { SanitizerResult } from '../shared/validation.ts'

/**
 * Generic request-body validation for the interface <-> sidecar layer.
 *
 * A `Validator` is a pure function from an unknown JSON value to a typed value
 * or human-readable error strings. Write routes run bodies through `parseBody`,
 * which owns reading the JSON and shaping the 400 response, so every failure
 * carries the same `{ error, details }` shape.
 */
export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] }

export interface Validator<T> {
  parse(input: unknown): Validation<T>
}

/** Wrap the domain validators (SanitizerResult) into the shared Validation shape. */
export function fromSanitizer<T>(fn: (input: unknown) => SanitizerResult<T>): Validator<T> {
  return {
    parse(input) {
      const r = fn(input)
      if (r.valid) return { ok: true, value: r.sanitized }
      return { ok: false, errors: r.errors }
    },
  }
}

export const mcpServerValidator: Validator<McpServerConfig> = fromSanitizer(validateMcpServerConfig)
export const assistantValidator: Validator<AssistantConfig> = fromSanitizer(validateAssistantConfig)

/** A non-null, non-array JSON object — for endpoints whose real checks happen
 *  after merge (e.g. PATCH re-validates the merged config in the registry). */
export const jsonObjectValidator: Validator<Record<string, unknown>> = {
  parse(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, errors: ['body must be a JSON object'] }
    }
    return { ok: true, value: input as Record<string, unknown> }
  },
}

export const mcpCallValidator: Validator<{ name: string; arguments?: Record<string, unknown> }> = {
  parse(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, errors: ['body must be a JSON object'] }
    }
    const name = (input as Record<string, unknown>).name
    if (typeof name !== 'string' || name.trim().length === 0) {
      return { ok: false, errors: ['name must be a non-empty string'] }
    }
    const args = (input as Record<string, unknown>).arguments
    if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
      return { ok: false, errors: ['arguments must be a JSON object'] }
    }
    return { ok: true, value: { name: name.trim(), ...(args !== undefined ? { arguments: args as Record<string, unknown> } : {}) } }
  },
}

export const enabledToggleValidator: Validator<{ enabled: boolean }> = {
  parse(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, errors: ['body must be a JSON object'] }
    }
    const enabled = (input as Record<string, unknown>).enabled
    if (typeof enabled !== 'boolean') return { ok: false, errors: ['enabled must be a boolean'] }
    return { ok: true, value: { enabled } }
  },
}

/** Parse the request body into an unknown JSON value, or a 400 Response. */
export async function requestJson(c: Context): Promise<unknown | Response> {
  try {
    return await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON', details: [] }, 400)
  }
}

/** Run a validator over an already-parsed value, or a 400 Response. */
export function rejectInvalid<T>(c: Context, validator: Validator<T>, raw: unknown): T | Response {
  const r = validator.parse(raw)
  if (r.ok) return r.value
  return c.json({ error: 'Validation failed', details: r.errors }, 400)
}

/** Read + validate a JSON request body: the typed value, or a 400 Response. */
export async function parseBody<T>(c: Context, validator: Validator<T>): Promise<T | Response> {
  const raw = await requestJson(c)
  if (raw instanceof Response) return raw
  return rejectInvalid(c, validator, raw)
}
