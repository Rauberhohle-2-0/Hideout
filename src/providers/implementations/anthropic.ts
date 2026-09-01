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
import { BaseProvider } from "../core/base.ts";
import type { ChatDelta, ChatOptions, ChatResult, Model } from "../core/types.ts";
import type { CredentialStore } from "../core/credentials.ts";
import { createDefaultCredentialStore } from "../core/credentials.ts";

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

  async chat(options: ChatOptions): Promise<ChatResult> {
    const key = await this.getApiKey();
    if (!key) throw new Error("Anthropic API key not configured");
    // Anthropic requires a top-level `system` string and user/assistant turns in `messages`.
    const systemParts = options.messages.filter((m) => m.role === "system").map((m) => m.content);
    const system = systemParts.length > 0 ? systemParts.join("\n\n") : undefined;
    const messages = options.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    const body: Record<string, unknown> = {
      model: options.model,
      max_tokens: 4096,
      messages,
    };
    if (system) body.system = system;

    const res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      signal: options.signal,
      headers: {
        "x-api-key": key,
        "anthropic-version": this.anthropicVersion,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Anthropic chat failed: ${res.status} ${text.slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      content?: Array<{ type?: string; text?: string }>;
      stop_reason?: string;
      error?: { message?: string };
    };
    if (data.error) throw new Error(data.error.message ?? "Anthropic error");
    const content = (data.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    return {
      content,
      model: options.model,
      providerId: this.id,
      finishReason: data.stop_reason,
    };
  }

  async *chatStream(options: ChatOptions): AsyncIterable<ChatDelta> {
    const key = await this.getApiKey();
    if (!key) throw new Error("Anthropic API key not configured");
    const systemParts = options.messages.filter((m) => m.role === "system").map((m) => m.content);
    const system = systemParts.length > 0 ? systemParts.join("\n\n") : undefined;
    const messages = options.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    const body: Record<string, unknown> = {
      model: options.model,
      max_tokens: 4096,
      messages,
      stream: true,
    };
    if (system) body.system = system;

    const res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      signal: options.signal,
      headers: {
        "x-api-key": key,
        "anthropic-version": this.anthropicVersion,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Anthropic stream failed: ${res.status} ${text.slice(0, 300)}`);
    }
    if (!res.body) {
      const fallback = await this.chat(options);
      if (fallback.content) yield { type: "content", text: fallback.content };
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let currentEvent = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
            continue;
          }
          if (!line.startsWith("data: ")) {
            if (line.trim() === "") currentEvent = "";
            continue;
          }
          const jsonStr = line.slice(6);
          try {
            const obj = JSON.parse(jsonStr) as {
              type?: string;
              delta?: { type?: string; text?: string; thinking?: string };
              content_block?: { type?: string; text?: string };
            };
            if (currentEvent === "content_block_delta" || obj.type === "content_block_delta") {
              // Extended thinking models stream `thinking_delta` frames before
              // the `text_delta` frames of the visible answer.
              if (obj.delta?.type === "thinking_delta" && obj.delta.thinking) {
                yield { type: "thinking", text: obj.delta.thinking };
              } else if (obj.delta?.type === "text_delta" && obj.delta.text) {
                yield { type: "content", text: obj.delta.text };
              }
            } else if (obj.type === "content_block_start" && obj.content_block?.type === "text" && obj.content_block.text) {
              yield { type: "content", text: obj.content_block.text };
            }
            if (obj.type === "message_stop") return;
          } catch {
            // ignore keepalive or malformed
          }
        }
      }
    } finally {
      reader.releaseLock();
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
