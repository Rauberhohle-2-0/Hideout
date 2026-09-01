/**
 * Shared chat session contracts.
 *
 * A `ChatSession` is a persisted conversation the user had with a model.
 * It keeps the title (shown in the sidebar), its messages, and whether it
 * is `pinned` (favourite) or normal. Two groups in the left sidebar are
 * rendered from this single list by filtering on `pinned`.
 *
 * Used by both the renderer store (`src/renderer/sessions.ts`, localStorage)
 * and, if needed, a future sidecar API (`/api/sessions`). No runtime imports.
 */

import type { ChatMessage } from "./chat.ts";

export type ChatSession = {
  /** Stable id, e.g. `crypto.randomUUID()` or `Date.now` fallback. */
  id: string;
  /** Sidebar title. Auto-derived from first user message if empty. */
  title: string;
  /** Full conversation, oldest first. */
  messages: ChatMessage[];
  /** When `true` the session appears in the "Pinned" group. */
  pinned: boolean;
  /** ms since epoch. */
  createdAt: number;
  /** ms since epoch, bumped on each message/edit/pin. */
  updatedAt: number;
};

/** Lightweight projection for list rendering / search without full messages. */
export type ChatSessionMeta = Omit<ChatSession, "messages"> & {
  preview: string;
  messageCount: number;
};

export function sessionPreview(session: ChatSession): string {
  const last = session.messages[session.messages.length - 1];
  if (!last) return "";
  // One line preview, cap length.
  const raw = last.content.trim().replace(/\s+/g, " ");
  return raw.length > 80 ? raw.slice(0, 80) + "…" : raw;
}

export function sessionMeta(session: ChatSession): ChatSessionMeta {
  const { messages, ...rest } = session;
  return {
    ...rest,
    preview: sessionPreview(session),
    messageCount: messages.length,
  };
}

/** Derive a short title from the first user message. */
export function deriveTitle(messages: ChatMessage[], fallback = "New chat"): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return fallback;
  const raw = firstUser.content.trim().replace(/\s+/g, " ");
  if (!raw) return fallback;
  return raw.length > 48 ? raw.slice(0, 48) + "…" : raw;
}

export function generateSessionId(): string {
  try {
    // Available in secure contexts / recent Bun / browsers.
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

export function validateSession(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return "Invalid session";
  const s = raw as Record<string, unknown>;
  if (typeof s.id !== "string" || !s.id.trim()) return "id is required";
  if (typeof s.title !== "string") return "title must be a string";
  if (!Array.isArray(s.messages)) return "messages must be an array";
  if (typeof s.pinned !== "boolean") return "pinned must be boolean";
  if (typeof s.createdAt !== "number" || typeof s.updatedAt !== "number") return "timestamps required";
  for (const m of s.messages) {
    if (!m || typeof m !== "object") return "Invalid message";
    const msg = m as Record<string, unknown>;
    if (msg.role !== "user" && msg.role !== "assistant" && msg.role !== "system") return "Invalid message role";
    if (typeof msg.content !== "string") return "Invalid message content";
    if (msg.thinking !== undefined && typeof msg.thinking !== "string") return "Invalid message thinking";
  }
  return null;
}

export function sortSessions(a: ChatSession, b: ChatSession): number {
  return b.updatedAt - a.updatedAt;
}

export function groupSessions(sessions: ChatSession[]): { pinned: ChatSession[]; recent: ChatSession[] } {
  const pinned = sessions.filter((s) => s.pinned).sort(sortSessions);
  const recent = sessions.filter((s) => !s.pinned).sort(sortSessions);
  return { pinned, recent };
}
