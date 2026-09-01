/**
 * Shared chat contracts.
 *
 * Used by both the sidecar (`POST /api/chat`) and the renderer library
 * (`src/renderer/chat.ts`). No runtime, just types + validation helpers.
 */

export type ChatRole = "user" | "assistant" | "system";

export type ChatMessage = {
  role: ChatRole;
  content: string;
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
};

export type ChatResponse = {
  /** The assistant reply. */
  content: string;
  model: string;
  providerId: string;
  /** Optional finish reason (`stop`, `length`, etc.). */
  finishReason?: string;
};

/** Parse error shape returned by the sidecar. */
export type ChatError = { error: string };

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
  return null;
}
