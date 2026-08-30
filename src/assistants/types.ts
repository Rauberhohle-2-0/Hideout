/**
 * Assistant types — configurable system prompt + sampling parameters.
 *
 * An assistant influences how an AI model responds:
 * - identity: name, description, emoji (face)
 * - instructions: system prompt injected as first `system` message
 * - parameters: sampling controls (temperature, top_p, top_k, min_p, repeat/frequency/presence penalties, etc.)
 * - adherence: optional binding to a specific provider/model (assistant -> AI model)
 *
 * Persistence: file `assistants.json` in HIDEOUT store dir (0o600).
 * No secrets — everything is safe to expose to renderer.
 */

export interface AssistantParameters {
  /** Sampling temperature 0..2 (0 deterministic, 2 very random). Common default 0.7 */
  temperature?: number;
  /** Nucleus sampling 0..1 */
  topP?: number;
  /** Top-K sampling 0..100 (0 = disabled). Ollama / local models */
  topK?: number;
  /** Min-P sampling 0..1 */
  minP?: number;
  /** Frequency penalty -2..2 (OpenAI style). Penalizes frequent tokens */
  frequencyPenalty?: number;
  /** Presence penalty -2..2 (OpenAI style). Penalizes new tokens based on presence */
  presencePenalty?: number;
  /** Repeat penalty 0..2 (Ollama style). 1.1 typical */
  repeatPenalty?: number;
  /** Max tokens to generate (num_predict). 1..200000 */
  maxTokens?: number;
  /** Stop sequences */
  stop?: string[];
  /** Seed for deterministic sampling */
  seed?: number;
}

export interface AssistantConfig {
  /** Unique id — slug, e.g. "coding-helper", "research-assistant" */
  id: string;
  /** Display name — e.g. "Code Helper" */
  name: string;
  /** Optional description for UI */
  description?: string;
  /** Optional emoji/face — e.g. "🤖", "🧙", "🦊". Max 16 chars */
  emoji?: string;
  /** System instructions — injected as `system` message before conversation */
  instructions: string;
  /** Sampling / generation parameters */
  parameters?: AssistantParameters;
  /**
   * Optional adherence to an AI model / provider.
   * If set, UI and chat can default to this model when assistant is selected.
   * `providerId` like "ollama", `model` like "llama3.2" — both optional.
   */
  providerId?: string;
  model?: string;
  /** Whether assistant is enabled (default true) */
  enabled?: boolean;
  /** ISO timestamps */
  createdAt?: string;
  updatedAt?: string;
}

/** Wire-safe type — identical to config (no secrets to redact) */
export type AssistantSafe = AssistantConfig;

export interface AssistantListResponse {
  assistants: AssistantSafe[];
}

export interface AssistantGetResponse {
  assistant: AssistantSafe;
}
