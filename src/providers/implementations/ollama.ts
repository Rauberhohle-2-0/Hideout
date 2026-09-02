/**
 * Ollama — the first local provider.
 *
 * Talks to the Ollama daemon's HTTP API (default `http://127.0.0.1:11434`).
 * Only `/api/tags` is needed for the "Models" dropdown. `isAvailable()` does
 * a short-timeout GET to the same endpoint.
 *
 * Thinking: `think:true` is sent to `/api/chat` only for models whose
 * `/api/show` capabilities include thinking — sending it to a plain
 * instruct/vision model is a 400 (`"..." does not support thinking`). A
 * verdict that turns out wrong self-heals: the request is retried once
 * without `think` and the corrected verdict is remembered (cached as
 * "no thinking") so later calls skip the failing path.
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
  /** Opt out of `/api/show` capability probing — `think` is then never sent. */
  probeThinking?: boolean;
};

/** Subset of Ollama's `/api/show` response this provider cares about. */
type OllamaShowResponse = {
  capabilities?: string[];
};

/**
 * Ollama capability names that mean "this model can emit a reasoning trace".
 * `/api/show` reports `"thinking"`; older daemons have been seen reporting
 * `"think"` — accept both so version drift doesn't regress the feature.
 */
const THINKING_CAPABILITIES = new Set(["thinking", "think"]);

/** Marker inside Ollama's 400 when `think` is sent to a non-reasoning model. */
const NO_THINKING_ERROR = "does not support thinking";

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
  private readonly probeThinking: boolean;
  /** Cached `/api/show` verdict per model id; absent = not probed yet. */
  private readonly thinkingByModel = new Map<string, boolean>();

  constructor(options: OllamaOptions = {}) {
    super();
    this.baseUrl = resolveBaseUrl(options.baseUrl);
    // `globalThis.fetch` exists in Bun / browsers; fallback to global fetch.
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as typeof fetch);
    this.timeoutMs = options.timeoutMs ?? 2500;
    this.probeThinking = options.probeThinking ?? true;
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

  /**
   * Ask the daemon whether `model` supports a reasoning trace. Probed via
   * `/api/show` and cached per model id. Any failure (old daemon without
   * `/api/show`, connection drop, unknown model) resolves to `false` — the
   * conservative outcome is to not send `think`, which can never 400.
   */
  private async supportsThinking(model: string): Promise<boolean> {
    if (!this.probeThinking) return false;
    const cached = this.thinkingByModel.get(model);
    if (cached !== undefined) return cached;
    let supports = false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/api/show`, {
          method: "POST",
          signal: controller.signal,
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ model }),
        });
        if (res.ok) {
          const data = (await res.json()) as OllamaShowResponse;
          const caps = Array.isArray(data.capabilities) ? data.capabilities : [];
          supports = caps.some((c) => typeof c === "string" && THINKING_CAPABILITIES.has(c.toLowerCase()));
        }
      } finally {
        clearTimeout(timer);
      }
    } catch {
      supports = false;
    }
    this.thinkingByModel.set(model, supports);
    return supports;
  }

  /**
   * The 400 proved the cached verdict wrong — remember `false` so later
   * calls skip both the probe and the failing `think` path entirely.
   */
  private rememberNoThinking(model: string): void {
    this.thinkingByModel.set(model, false);
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
        // Only thinking-capable models accept `think:true` — sending it to a
        // plain instruct/VL model is a 400 (`does not support thinking`). The
        // flag is omitted entirely for other models; the daemon then applies
        // its own default, which is safe for both model classes.
        ...(await this.supportsThinking(options.model) ? { think: true } : {}),
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // Self-healing: a stale/absent capability verdict surfaces as this 400.
      // Retry once with `think` explicitly off, then remember the correction.
      if (res.status === 400 && text.includes(NO_THINKING_ERROR)) {
        this.rememberNoThinking(options.model);
        const retry = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
          method: "POST",
          signal: options.signal,
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            model: options.model,
            messages: options.messages,
            stream: false,
            think: false,
          }),
        });
        if (!retry.ok) {
          const retryText = await retry.text().catch(() => "");
          throw new Error(`Ollama chat failed: ${retry.status} ${retryText.slice(0, 200)}`);
        }
        const data = (await retry.json()) as {
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
    const useThink = await this.supportsThinking(options.model);
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
        // Sent only for thinking-capable models — see `supportsThinking`.
        ...(useThink ? { think: true } : {}),
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // Self-healing: the capability verdict was wrong (or unprobeable) and
      // the daemon rejected `think`. The 400 fires before any stream bytes,
      // so a clean re-issue without `think` cannot duplicate deltas.
      if (res.status === 400 && text.includes(NO_THINKING_ERROR)) {
        this.rememberNoThinking(options.model);
        yield* this.streamWithoutThinking(options);
        return;
      }
      throw new Error(`Ollama stream failed: ${res.status} ${text.slice(0, 200)}`);
    }
    if (!res.body) {
      // Fallback to non-stream
      const fallback = await this.chat(options);
      if (fallback.content) yield { type: "content", text: fallback.content };
      return;
    }
    yield* this.consumeStream(res.body);
  }

  /** Streamed chat with `think` explicitly off — used for the 400 retry. */
  private async *streamWithoutThinking(options: ChatOptions): AsyncIterable<ChatDelta> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
      method: "POST",
      signal: options.signal,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        stream: true,
        think: false,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Ollama stream failed: ${res.status} ${text.slice(0, 200)}`);
    }
    if (!res.body) return;
    yield* this.consumeStream(res.body);
  }

  /** Consume an Ollama NDJSON stream body into typed deltas. */
  private async *consumeStream(body: ReadableStream<Uint8Array>): AsyncIterable<ChatDelta> {
    const reader = body.getReader();
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
