/**
 * OpenAI provider — API-key authenticated.
 *
 * The API key is **never** held in the provider instance. It is fetched from
 * the OS keychain (`Bun.secrets` / `@vantail/api` secrets) on every request
 * via `CredentialStore`, so it never lives in heap longer than the request
 * and is never serialised, logged, or returned over HTTP.
 *
 * Key storage: `provider.openai.apiKey` under service `dev.hideout.desktop`
 * (see `credentials.ts`). Set it via the sidecar's credential routes:
 *   PUT /api/credentials/openai  { apiKey: "sk-..." }
 *
 * Env fallback: `OPENAI_API_KEY` is checked only when the keychain has
 * nothing — useful for CI, but the keychain is the source of truth.
 */
import { BaseProvider } from "../core/base.ts";
import type { Model } from "../core/types.ts";
import type { CredentialStore } from "../core/credentials.ts";
import { createDefaultCredentialStore } from "../core/credentials.ts";

export type OpenAIOptions = {
  credentialStore?: CredentialStore;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
};

type OpenAIModel = {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
};

type OpenAIListResponse = {
  data: OpenAIModel[];
  object?: string;
};

function resolveApiKeyFromEnv(): string | null {
  if (typeof process !== "undefined") {
    const env = process.env as Record<string, string | undefined>;
    return env.OPENAI_API_KEY ?? null;
  }
  return null;
}

export class OpenAIProvider extends BaseProvider {
  readonly id = "openai";
  readonly name = "OpenAI";

  private readonly credentialStore: CredentialStore;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(options: OpenAIOptions = {}) {
    super();
    this.credentialStore = options.credentialStore ?? createDefaultCredentialStore();
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as typeof fetch);
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  }

  /** Whether a key is stored in the keychain (or env fallback). */
  async hasKey(): Promise<boolean> {
    const fromStore = await this.credentialStore.get(this.id);
    if (fromStore) return true;
    return resolveApiKeyFromEnv() !== null;
  }

  private async getApiKey(): Promise<string | null> {
    const fromStore = await this.credentialStore.get(this.id);
    if (fromStore) return fromStore;
    return resolveApiKeyFromEnv();
  }

  async isAvailable(): Promise<boolean> {
    const key = await this.getApiKey();
    if (!key) return false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/models`, {
          method: "GET",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${key}`,
            Accept: "application/json",
          },
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
    const key = await this.getApiKey();
    if (!key) return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/models`, {
        method: "GET",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: "application/json",
        },
      });
      if (!res.ok) return [];
      const data = (await res.json()) as OpenAIListResponse;
      if (!data || !Array.isArray(data.data)) return [];
      return data.data.map((m) => this.toModel(m));
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  private toModel(m: OpenAIModel): Model {
    return {
      id: m.id,
      name: m.id,
      providerId: this.id,
      providerName: this.name,
      details: {
        owned_by: m.owned_by,
        created: m.created,
      },
    };
  }
}
