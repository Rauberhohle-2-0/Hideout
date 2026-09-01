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

/** Minimal contract a plugin must satisfy. */
export interface Provider {
  /** Machine id, unique in the registry — e.g. `ollama`, `openai`. */
  readonly id: string;
  /** Human name shown in logs/UI. */
  readonly name: string;
  /** Whether the provider can be reached right now. */
  isAvailable(): Promise<boolean>;
  /** Models usable right now. Returns `[]` when not connected. */
  listModels(): Promise<Model[]>;
}

/** Optional richer status, useful for health endpoints. */
export type ProviderInfo = {
  id: string;
  name: string;
  status: ProviderStatus;
  models: Model[];
};
