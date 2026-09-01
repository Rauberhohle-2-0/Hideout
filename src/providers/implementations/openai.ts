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
import type { ChatDelta, ChatOptions, ChatResult, Model } from "../core/types.ts";
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

  async chat(options: ChatOptions): Promise<ChatResult> {
    const key = await this.getApiKey();
    if (!key) throw new Error("OpenAI API key not configured");
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      signal: options.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        stream: false,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`OpenAI chat failed: ${res.status} ${text.slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      error?: { message?: string };
    };
    if (data.error) throw new Error(data.error.message ?? "OpenAI error");
    const choice = data.choices?.[0];
    const content = choice?.message?.content ?? "";
    return {
      content,
      model: options.model,
      providerId: this.id,
      finishReason: choice?.finish_reason,
    };
  }

  async *chatStream(options: ChatOptions): AsyncIterable<ChatDelta> {
    const key = await this.getApiKey();
    if (!key) throw new Error("OpenAI API key not configured");
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      signal: options.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        stream: true,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`OpenAI stream failed: ${res.status} ${text.slice(0, 300)}`);
    }
    if (!res.body) {
      const fallback = await this.chat(options);
      if (fallback.content) yield { type: "content", text: fallback.content };
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === "data: [DONE]") continue;
          if (!trimmed.startsWith("data: ")) continue;
          const jsonStr = trimmed.slice(6);
          try {
            const obj = JSON.parse(jsonStr) as {
              choices?: Array<{ delta?: { content?: string; reasoning_content?: string }; finish_reason?: string | null }>;
            };
            const delta = obj.choices?.[0]?.delta;
            // o-series models send their reasoning trace as `reasoning_content`
            // deltas before the visible `content` starts.
            if (delta?.reasoning_content) yield { type: "thinking", text: delta.reasoning_content };
            if (delta?.content) yield { type: "content", text: delta.content };
            if (obj.choices?.[0]?.finish_reason) return;
          } catch {
            // ignore parse errors for keepalive comments
          }
        }
      }
    } finally {
      reader.releaseLock();
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
