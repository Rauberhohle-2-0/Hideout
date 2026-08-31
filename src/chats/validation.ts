import type { ChatConfig, ChatMessage } from "./types.ts";
import type { SanitizerResult } from "../shared/validation.ts";

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

const MAX_MESSAGES = 1_000;
const MAX_CONTENT = 100_000;

export function validateChatMessages(messages: unknown): string[] {
  const errors: string[] = [];
  if (!Array.isArray(messages)) {
    errors.push("messages must be an array");
    return errors;
  }
  if (messages.length > MAX_MESSAGES) {
    errors.push(`messages too many (max ${MAX_MESSAGES})`);
    return errors;
  }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as Record<string, unknown> | undefined;
    if (!m || typeof m !== "object" || Array.isArray(m)) {
      errors.push(`messages[${i}] must be an object`);
      continue;
    }
    if (m.role !== "user" && m.role !== "assistant") {
      errors.push(`messages[${i}].role must be 'user' or 'assistant'`);
    }
    if (typeof m.content !== "string") {
      errors.push(`messages[${i}].content must be a string`);
    } else if (m.content.length > MAX_CONTENT) {
      errors.push(`messages[${i}].content too large (max ${MAX_CONTENT})`);
    }
  }
  return errors;
}

/**
 * Validate a chat config. `id` is optional for the create path (the registry
 * generates one); it is required when present as a file key or update target.
 */
export function validateChatConfig(config: unknown): SanitizerResult<ChatConfig> {
  const errors: string[] = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { valid: false, errors: ["config must be an object"] };
  }
  const c = config as Record<string, unknown>;

  if (c.id !== undefined && c.id !== null && c.id !== "") {
    if (typeof c.id !== "string" || !ID_RE.test(c.id as string)) {
      errors.push("id must be alphanumeric with ._-, max 64 chars, e.g. 'my-chat'");
    }
  }

  if (c.title !== undefined && c.title !== null && c.title !== "") {
    if (typeof c.title !== "string") errors.push("title must be a string");
    else if (c.title.length > 256) errors.push("title too long (max 256)");
  }

  if (c.messages !== undefined) {
    errors.push(...validateChatMessages(c.messages));
  }

  if (c.pinned !== undefined && typeof c.pinned !== "boolean") errors.push("pinned must be boolean");

  if (c.model !== undefined && c.model !== null && c.model !== "") {
    if (typeof c.model !== "string") errors.push("model must be a string");
    else if (c.model.length > 256) errors.push("model too long (max 256)");
  }
  if (c.assistantId !== undefined && c.assistantId !== null && c.assistantId !== "") {
    if (typeof c.assistantId !== "string") errors.push("assistantId must be a string");
    else if (c.assistantId.length > 64) errors.push("assistantId too long (max 64)");
  }
  if (c.useTools !== undefined && typeof c.useTools !== "boolean") errors.push("useTools must be boolean");

  if (c.createdAt !== undefined && typeof c.createdAt !== "string") errors.push("createdAt must be a string");
  if (c.updatedAt !== undefined && typeof c.updatedAt !== "string") errors.push("updatedAt must be a string");

  const valid = errors.length === 0;
  if (!valid) return { valid: false, errors };

  const sanitized: ChatConfig = {
    id: typeof c.id === "string" && c.id.trim() ? c.id.trim() : "",
    title: typeof c.title === "string" && c.title.trim() ? c.title.trim() : "",
    messages: Array.isArray(c.messages)
      ? (c.messages as ChatMessage[]).map((m) => ({ role: m.role, content: m.content }))
      : [],
    pinned: (c.pinned as boolean | undefined) ?? false,
    ...(typeof c.model === "string" && c.model.trim() ? { model: c.model.trim() } : {}),
    ...(typeof c.assistantId === "string" && c.assistantId.trim() ? { assistantId: c.assistantId.trim() } : {}),
    ...(typeof c.useTools === "boolean" ? { useTools: c.useTools } : {}),
    ...(typeof c.createdAt === "string" ? { createdAt: c.createdAt } : {}),
    ...(typeof c.updatedAt === "string" ? { updatedAt: c.updatedAt } : {}),
  };

  return { valid: true, errors, sanitized };
}
