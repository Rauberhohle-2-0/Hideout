/**
 * Chat types — persisted conversations for the chat interface.
 *
 * A chat is a thread of user/assistant turns plus the settings that were
 * active while it ran (model, assistant adherence, tools toggle), so opening
 * a chat again restores the exact conversation and its context.
 *
 * Persistence: one JSON file per chat in the store dir (0o600, dirs 0o700).
 *   ${storeDir}/chats/${id}.json
 *
 * No secrets — everything is safe to expose to the renderer.
 */

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatConfig {
  /** Unique id — slug, or a generated UUID for chats created without one */
  id: string;
  /** Short title derived from the first user message (editable) */
  title: string;
  /** The conversation, oldest first */
  messages: ChatMessage[];
  /** Whether the chat is pinned to the top of the sidebar */
  pinned: boolean;
  /** The model that was selected for this chat */
  model?: string;
  /** Assistant adherence active in this chat */
  assistantId?: string;
  /** Whether MCP tools were enabled for this chat */
  useTools?: boolean;
  /** ISO timestamps */
  createdAt?: string;
  updatedAt?: string;
}

/** Wire-safe type — identical to config (no secrets to redact) */
export type ChatSafe = ChatConfig;

export interface ChatListResponse {
  chats: ChatSafe[];
}

export interface ChatGetResponse {
  chat: ChatSafe;
}
