/**
 * Anthropic (Claude) provider — API-key authenticated.
 *
 * Same keychain guarantees as `OpenAIProvider`: the key is fetched from
 * `Bun.secrets` / `@vantail/api` secrets on every request, never cached in
 * the instance, never logged, never returned over HTTP.
 *
 * Storage key: `provider.anthropic.apiKey` (service `dev.hideout.desktop`).
 * Also aliased as `provider.claude.apiKey` for backwards compat — both names
 * are checked, `anthropic` wins.
 *
 * API: `GET https://api.anthropic.com/v1/models` with headers
 * `x-api-key` and `anthropic-version`. Env fallback: `ANTHROPIC_API_KEY`.
 */
import { BaseProvider } from "./base.ts";
import type { Model } from "./types.ts";
import type { CredentialStore } from "./credentials.ts";
import { createDefaultCredentialStore } from "./credentials.ts";

export type AnthropicOptions = {
  credentialStore?: CredentialStore;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
  anthropicVersion?: string;
};

type AnthropicModel = {
  id: string;
  display_name?: string;
  created_at?: string;
  type?: string;
};

type AnthropicListResponse = {
  data: AnthropicModel[];
  first_id?: string;
  last_id?: string;
  has_more?: boolean;
};

function resolveApiKeyFromEnv(): string | null {
  if (typeof process !== "undefined") {
    const env = process.env as Record<string, string | undefined>;
    return env.ANTHROPIC_API_KEY ?? env.CLAUDE_API_KEY ?? null;
  }
  return null;
}

export class AnthropicProvider extends BaseProvider {
  readonly id = "anthropic";
  readonly name = "Claude";

  private readonly credentialStore: CredentialStore;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly anthropicVersion: string;

  constructor(options: AnthropicOptions = {}) {
    super();
    this.credentialStore = options.credentialStore ?? createDefaultCredentialStore();
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as typeof fetch);
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.baseUrl = (options.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
    this.anthropicVersion = options.anthropicVersion ?? "2023-06-01";
  }

  /** Also accept `claude` alias when reading credentials. */
  private async getApiKey(): Promise<string | null> {
    const primary = await this.credentialStore.get(this.id);
    if (primary) return primary;
    // Alias: `provider.claude.apiKey` — lets users store under either name.
    const alias = await this.credentialStore.get("claude");
    if (alias) return alias;
    return resolveApiKeyFromEnv();
  }

  async hasKey(): Promise<boolean> {
    const k = await this.getApiKey();
    return k !== null && k.length > 0;
  }

  async isAvailable(): Promise<boolean> {
    const key = await this.getApiKey();
    if (!key) return false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/v1/models`, {
          method: "GET",
          signal: controller.signal,
          headers: {
            "x-api-key": key,
            "anthropic-version": this.anthropicVersion,
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
      const res = await this.fetchImpl(`${this.baseUrl}/v1/models`, {
        method: "GET",
        signal: controller.signal,
        headers: {
          "x-api-key": key,
          "anthropic-version": this.anthropicVersion,
          Accept: "application/json",
        },
      });
      if (!res.ok) return [];
      const data = (await res.json()) as AnthropicListResponse;
      if (!data || !Array.isArray(data.data)) return [];
      return data.data.map((m) => this.toModel(m));
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  private toModel(m: AnthropicModel): Model {
    return {
      id: m.id,
      name: m.display_name ?? m.id,
      providerId: this.id,
      providerName: this.name,
      details: {
        display_name: m.display_name,
        created_at: m.created_at,
        type: m.type,
      },
    };
  }
}

/** Alias so `new ClaudeProvider()` also works — same backing store. */
export const ClaudeProvider = AnthropicProvider;
export type ClaudeOptions = AnthropicOptions;
