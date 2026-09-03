/**
 * Shared bounded request-body reading.
 *
 * Every JSON-accepting sidecar route reads through `readJsonBodyBounded`
 * instead of calling `c.req.json()` directly, so an oversized or endless
 * request cannot buffer unbounded memory in the sidecar. Pure web APIs only
 * (no Node/Bun imports) so both realms can share it if ever needed.
 */

/** Default cap for JSON request bodies (4 MiB). */
export const MAX_JSON_BODY_BYTES = 4 * 1024 * 1024;

export type BoundedBodyResult = { ok: true; body: unknown } | { ok: false; error: "parse" | "too-large" };

/**
 * Read and parse a request body with a hard byte cap.
 *
 * - `content-length` over the cap fails fast without touching the body.
 * - Otherwise the stream is read with the cap enforced mid-read, so a
 *   chunked/endless body is cut off at the cap instead of buffered whole.
 * - Non-JSON or empty bodies yield `{ ok: false, error: "parse" }`.
 */
export async function readJsonBodyBounded(raw: Request, maxBytes: number = MAX_JSON_BODY_BYTES): Promise<BoundedBodyResult> {
  const declared = Number(raw.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, error: "too-large" };
  }

  let text: string;
  if (!raw.body) {
    text = "";
  } else {
    const reader = raw.body.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          return { ok: false, error: "too-large" };
        }
        chunks.push(decoder.decode(value, { stream: true }));
      }
      chunks.push(decoder.decode());
    } finally {
      reader.releaseLock();
    }
    text = chunks.join("");
  }

  if (!text.trim()) return { ok: false, error: "parse" };
  try {
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: "parse" };
  }
}
