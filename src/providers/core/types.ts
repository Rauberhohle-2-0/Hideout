/**
 * Core contracts for the AI provider API.
 *
 * The library is intentionally small: a `Provider` exposes whether it is
 * reachable and which models it can use. A `ProviderRegistry` aggregates many
 * providers so the server can expose a single `/api/models` endpoint and the
 * renderer can populate one dropdown. Third-party plugins implement the
 * `Provider` interface (or extend `BaseProvider`) and register themselves.
 */

/** A model a provider can run. Keep it serialisable for the HTTP API. */
export type Model = {
  /** Stable identifier, e.g. `llama3.1:8b` for Ollama. */
  id: string;
  /** Human label shown in the UI. Defaults to `id` if not distinct. */
  name: string;
  /** Provider that owns the model, e.g. `ollama`. */
  providerId: string;
  /** Human provider name, e.g. `Ollama`. */
  providerName: string;
  /** Optional extra metadata (size, digest, capabilities). */
  details?: Record<string, unknown>;
};

/** High-level reachability of a provider. */
export type ProviderStatus = "connected" | "disconnected" | "error";

/** A single turn in a conversation. */
export type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

/** Options for a chat completion. */
export type ChatOptions = {
  model: string;
  messages: ChatMessage[];
  /** Abort a long-running request. */
  signal?: AbortSignal;
  /** Whether MCP/tools are enabled for this request. Defaults to true. */
  toolsEnabled?: boolean;
};

/** Result of a chat completion. */
export type ChatResult = {
  content: string;
  model: string;
  providerId: string;
  finishReason?: string;
};

/** One chunk of a streaming chat reply. */
export type ChatDelta = {
  /** `content` is the visible answer; `thinking` is the model's reasoning. */
  type: "content" | "thinking";
  text: string;
};

/** Minimal contract a plugin must satisfy. */
export interface Provider {
  /** Machine id, unique in the registry — e.g. `ollama`, `openai`. */
  readonly id: string;
  /** Human name shown in logs/UI. */
  readonly name: string;
  /**
   * Whether this provider runs models locally on the user's machine. Local
   * providers receive Hideout's code-owned base system prompt; remote
   * providers opt out (false) and keep their own system behaviour.
   */
  readonly isLocal: boolean;
  /** Whether the provider can be reached right now. */
  isAvailable(): Promise<boolean>;
  /** Models usable right now. Returns `[]` when not connected. */
  listModels(): Promise<Model[]>;
  /** Chat completion — must return the assistant text. */
  chat(options: ChatOptions): Promise<ChatResult>;
  /** Streaming chat — yields text deltas (content and thinking). Default falls back to `chat`. */
  chatStream?(options: ChatOptions): AsyncIterable<ChatDelta>;
}

/** Optional richer status, useful for health endpoints. */
export type ProviderInfo = {
  id: string;
  name: string;
  status: ProviderStatus;
  models: Model[];
};
