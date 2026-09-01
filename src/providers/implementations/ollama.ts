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
import { BaseProvider } from "../core/base.ts";
import type { ChatDelta, ChatOptions, ChatResult, Model } from "../core/types.ts";

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

  async chat(options: ChatOptions): Promise<ChatResult> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
      method: "POST",
      signal: options.signal,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        stream: false,
        // Qwen3.x and other thinking models default to `think:true`; the
        // non-stream response only carries the final `content`, so thinking
        // needs no special handling here. `think` is kept explicit so the
        // request is self-describing.
        think: true,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Ollama chat failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      message?: { role?: string; content?: string };
      done_reason?: string;
      done?: boolean;
    };
    const content = data.message?.content ?? "";
    if (!content && !data.done) throw new Error("Ollama returned empty reply");
    return {
      content,
      model: options.model,
      providerId: this.id,
      finishReason: data.done_reason ?? (data.done ? "stop" : undefined),
    };
  }

  async *chatStream(options: ChatOptions): AsyncIterable<ChatDelta> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
      method: "POST",
      signal: options.signal,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        stream: true,
        // `think:true` lets thinking models surface their reasoning as
        // `message.thinking` chunks before the `content` starts. The UI
        // renders the trace as a collapsible; the answer arrives as usual.
        think: true,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Ollama stream failed: ${res.status} ${text.slice(0, 200)}`);
    }
    if (!res.body) {
      // Fallback to non-stream
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
          if (!trimmed) continue;
          try {
            const obj = JSON.parse(trimmed) as {
              message?: { content?: string; thinking?: string };
              done?: boolean;
              error?: string;
            };
            if (obj.error) throw new Error(obj.error);
            // `thinking` (reasoning trace, think:true) streams before
            // `content`; both become typed deltas for the UI.
            if (obj.message?.thinking) yield { type: "thinking", text: obj.message.thinking };
            if (obj.message?.content) yield { type: "content", text: obj.message.content };
            if (obj.done) return;
          } catch (e) {
            // If not JSON, treat as raw content chunk
            if (trimmed) yield { type: "content", text: trimmed };
          }
        }
      }
      if (buf.trim()) {
        try {
          const obj = JSON.parse(buf) as { message?: { content?: string } };
          if (obj.message?.content) yield { type: "content", text: obj.message.content };
        } catch {
          yield { type: "content", text: buf };
        }
      }
    } finally {
      reader.releaseLock();
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
