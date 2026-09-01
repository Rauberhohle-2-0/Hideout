/**
 * Ollama — the first local provider.
 *
 * Talks to the Ollama daemon's HTTP API (default `http://127.0.0.1:11434`).
 * Only `/api/tags` is needed for the "Models" dropdown. `isAvailable()` does
 * a short-timeout GET to the same endpoint.
 *
 * Env: `OLLAMA_HOST` or `OLLAMA_BASE_URL` can override the base URL.
 *
 * Example as plugin:
 *   import { OllamaProvider, providerRegistry } from "./providers/index.ts";
 *   providerRegistry.register(new OllamaProvider({ baseUrl: "http://localhost:11434" }));
 *
 * A custom `fetch` can be injected for tests or non-standard runtimes.
 */
import { BaseProvider } from "./base.ts";
import type { Model } from "./types.ts";

export type OllamaOptions = {
  /** Base URL without trailing slash, e.g. `http://127.0.0.1:11434`. */
  baseUrl?: string;
  /** Fetch implementation — defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Timeout per request in ms. */
  timeoutMs?: number;
};

type OllamaTag = {
  name: string;
  model: string;
  modified_at: string;
  size: number;
  digest: string;
  details?: Record<string, unknown>;
};

type OllamaTagsResponse = {
  models: OllamaTag[];
};

function resolveBaseUrl(explicit?: string): string {
  if (explicit) return explicit.replace(/\/+$/, "");
  const env = (typeof process !== "undefined" ? (process.env as Record<string, string | undefined>) : {}) as Record<string, string | undefined>;
  const fromEnv = env.OLLAMA_BASE_URL ?? env.OLLAMA_HOST;
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  return "http://127.0.0.1:11434";
}

export class OllamaProvider extends BaseProvider {
  readonly id = "ollama";
  readonly name = "Ollama";

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: OllamaOptions = {}) {
    super();
    this.baseUrl = resolveBaseUrl(options.baseUrl);
    // `globalThis.fetch` exists in Bun / browsers; fallback to global fetch.
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as typeof fetch);
    this.timeoutMs = options.timeoutMs ?? 2500;
  }

  /** Exposed for debugging / health checks. */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/api/tags`, {
          method: "GET",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        return res.ok;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return false;
    }
  }

  async listModels(): Promise<Model[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/tags`, {
        method: "GET",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return [];
      const data = (await res.json()) as OllamaTagsResponse;
      if (!data || !Array.isArray(data.models)) return [];
      return data.models.map((m) => this.toModel(m));
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  private toModel(tag: OllamaTag): Model {
    // Ollama's `name` includes the tag (e.g. `llama3.1:8b`), `model` is the base.
    const id = tag.name || tag.model;
    return {
      id,
      name: tag.name || tag.model,
      providerId: this.id,
      providerName: this.name,
      details: {
        model: tag.model,
        size: tag.size,
        digest: tag.digest,
        modified_at: tag.modified_at,
        ...(tag.details ?? {}),
      },
    };
  }
}
