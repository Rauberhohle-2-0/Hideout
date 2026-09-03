/**
 * Shared URL validation for values that cross the sidecar/renderer boundary.
 *
 * Dependency-free and usable in both realms. Only absolute `http`/`https`
 * URLs are treated as safe — anything else (javascript:, data:, file:,
 * relative, malformed) is rejected so callers never hand it to an anchor or
 * an <img src>.
 *
 * Used by the sidecar when it normalizes MCP search results into `Source[]`
 * and by the renderer as defense-in-depth before sources are rendered.
 */

/** Whether `value` is an absolute http(s) URL. Narrowing to `string`. */
export function isAllowedHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  // Scheme check is case-insensitive; the URL parser normalizes it anyway.
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Copy of `value` for URL fields, or `undefined` when it is not http(s). */
export function allowedHttpUrlOrUndefined(value: unknown): string | undefined {
  return isAllowedHttpUrl(value) ? value : undefined;
}
