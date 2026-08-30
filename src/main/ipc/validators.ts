/**
 * Shared IPC input validators — security boundary.
 * Keep strict: renderer is untrusted.
 */

export function assertString(v: unknown, label: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`${label} must be a non-empty string`)
  if (v.length > 256) throw new Error(`${label} too long`)
  return v
}

export function assertObject(v: unknown, label: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`Invalid ${label}`)
  // Mitigate prototype pollution via __proto__/constructor pollution
  if ('__proto__' in (v as object) || 'constructor' in (v as object)) {
    // Allow constructor if it's the plain Object prototype, but block polluting values
    const obj = v as Record<string, unknown>
    if (obj['__proto__'] !== undefined) throw new Error(`Invalid ${label}: prototype pollution`)
  }
  return v as Record<string, unknown>
}
