/**
 * Universal AI Provider types — reusable across local (Ollama, LM Studio)
 * and future cloud providers (OpenAI, Claude, etc.).
 */

export type AiProviderId = string;

export type AiProviderKind = "local" | "cloud";

export type AiRole = "system" | "user" | "assistant" | "tool";

export interface AiMessage {
  role: AiRole;
  content: string;
  /** Optional tool call id / name — future-proof */
  toolCallId?: string;
  name?: string;
}

export interface AiChatOptions {
  /** Model id — if omitted provider uses its default */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  repeatPenalty?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
  stop?: string[];
  /** Request timeout in ms */
  timeoutMs?: number;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
}

export interface AiChatResponse {
  id: string;
  model: string;
  created: number;
  content: string;
  finishReason: "stop" | "length" | "tool_calls" | "error" | "unknown";
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

export interface AiChatChunk {
  id: string;
  model: string;
  delta: string;
  done: boolean;
  finishReason?: AiChatResponse["finishReason"];
}

export interface AiModel {
  id: string;
  name: string;
  ownedBy?: string;
  created?: number;
  contextLength?: number;
  capabilities?: string[];
}

export interface AiProviderCapabilities {
  chat: boolean;
  streaming: boolean;
  embeddings?: boolean;
  tools?: boolean;
  vision?: boolean;
}

export interface AiHealthStatus {
  ok: boolean;
  latencyMs?: number;
  version?: string;
  error?: string;
}

export interface AiProviderConfig {
  /** Unique id — e.g. "ollama" */
  id: AiProviderId;
  displayName: string;
  kind: AiProviderKind;
  /** Base URL for local providers (e.g. http://127.0.0.1:11434) */
  baseUrl?: string;
  /** Default model to use when none specified */
  defaultModel?: string;
  /** Encrypted at rest via SecureStore; never exposed to renderer */
  apiKey?: string;
  /** Extra headers — values are secrets, also encrypted */
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface AiProvider {
  readonly id: AiProviderId;
  readonly displayName: string;
  readonly kind: AiProviderKind;

  getCapabilities(): AiProviderCapabilities;

  /** Safe config (secrets omitted) for reads. */
  getConfig(): Readonly<AiProviderConfig>;
  /** Patch config in place (e.g. to apply a hydrated secret). */
  updateConfig(patch: Partial<AiProviderConfig>): void;

  /** Validate config without making network calls (URL shape, required fields) */
  validateConfig(config: AiProviderConfig): { valid: boolean; errors: string[] };

  /** Lightweight liveness check */
  healthCheck(signal?: AbortSignal): Promise<AiHealthStatus>;

  listModels(signal?: AbortSignal): Promise<AiModel[]>;

  chat(messages: AiMessage[], options?: AiChatOptions): Promise<AiChatResponse>;

  /** Streaming chat — yields deltas; caller must consume fully or abort */
  chatStream(
    messages: AiMessage[],
    options?: AiChatOptions,
  ): AsyncIterable<AiChatChunk>;
}
