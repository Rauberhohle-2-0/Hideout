/**
 * Renderer-side helpers for the settings modal — MCP server management.
 *
 * Pure, headless helpers shared between the modal wiring
 * (src/renderer/main.ts) and the unit tests: suggesting a server id from a
 * display name and collecting key/value input rows into an object. Anything
 * DOM-related lives in main.ts (`wireSettings`); this module never touches
 * the window so it can be tested without a DOM.
 */

/** Best-effort server id from a display name. The sidecar still validates. */
export function slugifyServerId(name: string): string {
  let s = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(s)) s = `server-${s}`;
  return s.slice(0, 31);
}

/** Row model for a key/value input pair (env vars, HTTP headers). */
export type KvRowValue = { key: string; value: string };

/** Collect rows into an object, skipping rows with empty keys. */
export function kvToObject(rows: KvRowValue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const key = r.key.trim();
    if (!key) continue;
    out[key] = r.value;
  }
  return out;
}

/** Human label for known provider ids; falls back to the raw id. */
export function providerLabel(providerId: string): string {
  const labels: Record<string, string> = {
    openai: "OpenAI",
    anthropic: "Anthropic",
  };
  return labels[providerId] ?? providerId;
}
