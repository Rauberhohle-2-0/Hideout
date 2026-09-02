/**
 * Shared chat contracts.
 *
 * Used by both the sidecar (`POST /api/chat`) and the renderer library
 * (`src/renderer/chat.ts`). No runtime, just types + validation helpers.
 */

export type ChatRole = "user" | "assistant" | "system";

export type Source = {
  /** Source URL — used as link href and favicon origin. */
  url: string;
  /** Human title for the source (page title, domain fallback). */
  title?: string;
  /** Optional favicon URL. When absent, UI derives from `url` origin. */
  favicon?: string;
};

export type ChatMessage = {
  role: ChatRole;
  content: string;
  /** Model reasoning captured separately from the visible assistant answer. */
  thinking?: string;
  /** Citations returned when a web search MCP tool was used successfully. */
  sources?: Source[];
};

export type ChatRequest = {
  /** Provider id, e.g. `ollama`, `openai`, `anthropic`. */
  providerId: string;
  /** Model id as advertised by `GET /api/models`, e.g. `llama3.1:8b`. */
  model: string;
  /** Conversation so far, in order. Last entry should be the new user message. */
  messages: ChatMessage[];
  /** When true, server streams NDJSON/SSE chunks instead of a single JSON. */
  stream?: boolean;
  /** Whether MCP/tools are enabled for this chat. Defaults to true. When false, server must not expose tools. */
  toolsEnabled?: boolean;
};

export type ChatResponse = {
  /** The assistant reply. */
  content: string;
  model: string;
  providerId: string;
  /** Optional finish reason (`stop`, `length`, etc.). */
  finishReason?: string;
  /** Sources cited when a web-search MCP tool contributed to this answer. */
  sources?: Source[];
};

/** Parse error shape returned by the sidecar. */
export type ChatError = { error: string };

/**
 * Strip LLM-generated source attributions that duplicate the UI's sources pill.
 *
 * The grounding prompt now tells the model NOT to emit inline citations, but
 * older turns or wayward models may still append a footer like
 * `Source: [1], [2], [3]` or `Sources: [1] [2]` (with optional markdown
 * emphasis). Some models go further and emit a `Sources:` header followed by
 * descriptive bullets that merely *contain* citations mid-line, e.g.
 * `- Apple Leadership page: Lists John Ternus as CEO [1], [2].` The UI
 * already shows sources in a dedicated pill below the answer, so any of
 * these footers is redundant and looks broken.
 *
 * This is intentionally conservative: it only removes a *trailing* source
 * block (1–2 paragraphs at the very end) and leaves legitimate bracket
 * usage elsewhere in the body untouched. Inline `[1]` markers mid-sentence
 * are kept — the updated prompt prevents new ones. The descriptive-bullet
 * rule (6) additionally requires every bullet in the trailing block to
 * carry a `[N]` citation or URL, so prose lists that merely end in a
 * `Sources:`-style header survive.
 *
 * Exported for use in both the server (to sanitize provider output before
 * persisting/streaming) and the renderer (defense-in-depth before display).
 */
export function stripSourcesFromContent(content: string): string {
  if (!content) return content;
  let s = content;
  let prev = "";
  // Iteratively strip trailing source blocks until stable — handles stacked
  // variants (e.g. "Sources: [1]" followed by a bare "[2] [3]" line).
  while (s !== prev) {
    prev = s;
    // 1) Header + citations on same line: "**Source:** [1], [2], ..." or "Sources: [1] [2]"
    //    Optionally followed by continuation lines that are also citation lists.
    s = s.replace(
      /\n+[ \t]*[*_]*Sources?\s*:?[*_]*[ \t]*(?:\[[0-9]+\][ \t,;]*)+(?:\n[ \t]*(?:[-*]\s*)?\[[0-9]+\][^\n]*)*\s*$/i,
      "",
    );
    // 2) Bare citation list at the very end without a header: "[1], [2], [3]" or "[1] [2]"
    s = s.replace(/\n+[ \t]*(?:\[[0-9]+\][ \t,;]*)+\s*$/g, "");
    // 3) Multiline "Sources:" header on its own line followed by bullet/numbered citation lines
    s = s.replace(
      /\n+[ \t]*[*_]*Sources?\s*:?[*_]*[ \t]*\n+([ \t]*[-*•]?\s*\[[0-9]+\][^\n]*\n?)+\s*$/i,
      "",
    );
    // 4) Trailing paragraph that is just source URLs (e.g. "Sources: https://...")
    s = s.replace(/\n+[ \t]*[*_]*Sources?\s*:?[*_]*[ \t]*https?:\/\/[^\n]+\s*$/i, "");
    // 5) Inline variant where the header and citations are the entire content (no leading newline after trimming)
    s = s.replace(/^[ \t]*[*_]*Sources?\s*:?[*_]*[ \t]*(?:\[[0-9]+\][ \t,;]*)+\s*$/i, "");
    // 6) Header-only line ("Sources:", "**Sources**", "Source:", "References:",
    //    "Citations:") followed by bullet/numbered lines where EVERY bullet
    //    contains a [N] citation or a URL — the descriptive-bullet variant
    //    ("- Apple Leadership page: Lists John Ternus as CEO [1], [2].").
    //    Requires every bullet to cite so ordinary lists after such a header
    //    are never eaten. Bullet sub-content (continuation lines) is allowed
    //    as long as the bullet's first line cites.
    s = s.replace(
      /\n+[ \t]*[*_]*(?:Sources?|References?|Citations)[ \t]*:?[*_]*[ \t]*\n+(?:[ \t]*(?:[-*•]|\d+[.)])[ \t]+[^\n]*\n?)+$/i,
      (block) => {
        const bulletLines = block.split("\n").filter((l) => /^[ \t]*(?:[-*•]|\d+[.)])[ \t]+/.test(l));
        const allCite = bulletLines.length > 0 && bulletLines.every((l) => /\[[0-9]+\]/.test(l) || /https?:\/\//.test(l));
        return allCite ? "" : block;
      },
    );
  }
  return s.trimEnd();
}

/** Validate a ChatRequest payload. Returns an error string or null when valid. */
export function validateChatRequest(body: unknown): string | null {
  if (!body || typeof body !== "object") return "Invalid body";
  const b = body as Record<string, unknown>;
  if (typeof b.providerId !== "string" || !b.providerId.trim()) return "providerId is required";
  if (typeof b.model !== "string" || !b.model.trim()) return "model is required";
  if (!Array.isArray(b.messages) || b.messages.length === 0) return "messages is required";
  for (const m of b.messages) {
    if (!m || typeof m !== "object") return "Invalid message";
    const msg = m as Record<string, unknown>;
    if (msg.role !== "user" && msg.role !== "assistant" && msg.role !== "system") return "Invalid message role";
    if (typeof msg.content !== "string") return "Invalid message content";
    // Allow empty assistant placeholders when streaming, but user messages must have content
    if (msg.role === "user" && !(msg.content as string).trim()) return "User message cannot be empty";
  }
  if (b.stream !== undefined && typeof b.stream !== "boolean") return "stream must be boolean";
  if (b.toolsEnabled !== undefined && typeof b.toolsEnabled !== "boolean") return "toolsEnabled must be boolean";
  return null;
}
