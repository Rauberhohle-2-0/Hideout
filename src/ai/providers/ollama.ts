/**
 * Ollama provider — connects to a local Ollama server.
 *
 * Default: http://127.0.0.1:11434
 * Docs: https://github.com/ollama/ollama/blob/main/docs/api.md
 *
 * SECURITY:
 * - baseUrl is restricted to loopback by default (isLoopbackUrl).
 * - No API key is required for vanilla Ollama; if the user configures one
 *   (e.g. via reverse proxy) it is read from SecureStore and sent as
 *   `Authorization: Bearer <token>` — never logged.
 * - Fetch uses explicit timeouts and AbortSignal.
 */

import { BaseProvider, validateBaseUrl } from "../base-provider.ts";
import type {
  AiChatChunk,
  AiChatOptions,
  AiChatResponse,
  AiHealthStatus,
  AiMessage,
  AiModel,
  AiProviderCapabilities,
  AiProviderConfig,
  AiTool,
  AiToolCall,
} from "../types.ts";
import { AiError, AiUpstreamError } from "../errors.ts";
import { Logger } from "../../logger.ts";

const logger = new Logger({ prefix: "ollama" });

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "llama3.2";
const DEFAULT_TIMEOUT_MS = 30_000;

export interface OllamaConfig extends AiProviderConfig {
  id: "ollama";
}

interface OllamaTagsResponse {
  models?: Array<{
    name: string;
    model: string;
    modified_at?: string;
    size?: number;
    details?: { family?: string; parameter_size?: string };
  }>;
}

interface OllamaToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

interface OllamaChatMessage {
  role: string;
  content: string;
  /** Reasoning/thinking text — separate from `content` on reasoning models. */
  thinking?: string;
  reasoning_content?: string;
  reasoning?: string;
  name?: string;
  tool_calls?: Array<{
    function?: { name?: string; arguments?: unknown };
    name?: string;
    arguments?: unknown;
  }>;
}

interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  stream: boolean;
  tools?: OllamaToolDef[];
  options?: Record<string, unknown>;
  keep_alive?: string;
}

interface OllamaChatResponse {
  model: string;
  created_at: string;
  message?: OllamaChatMessage;
  done: boolean;
  done_reason?: string;
  eval_count?: number;
  prompt_eval_count?: number;
}

export class OllamaProvider extends BaseProvider {
  override readonly id = "ollama" as const;
  override readonly displayName = "Ollama";
  override readonly kind = "local" as const;

  constructor(config: Partial<OllamaConfig> & { id: "ollama" }) {
    const merged: AiProviderConfig = {
      displayName: "Ollama",
      kind: "local",
      baseUrl: DEFAULT_BASE_URL,
      defaultModel: DEFAULT_MODEL,
      enabled: true,
      ...config,
    };
    super(merged);
  }

  getCapabilities(): AiProviderCapabilities {
    return { chat: true, streaming: true, embeddings: false, tools: true };
  }

  validateConfig(config: AiProviderConfig): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!config.id) errors.push("id is required");
    if (config.kind !== "local") errors.push('kind must be "local" for Ollama');
    const urlErrors = validateBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL, { allowRemote: false });
    errors.push(...urlErrors);
    if (config.defaultModel !== undefined && typeof config.defaultModel !== "string") {
      errors.push("defaultModel must be a string");
    }
    if (config.defaultModel !== undefined && config.defaultModel.trim() === "") {
      errors.push("defaultModel must not be empty");
    }
    return { valid: errors.length === 0, errors };
  }

  private resolveBaseUrl(): string {
    const raw = this.config.baseUrl ?? DEFAULT_BASE_URL;
    // Strip trailing slash for consistent joining
    return raw.replace(/\/+$/, "");
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    // Optional token for proxied Ollama — read from config (populated from SecureStore by caller)
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }
    if (this.config.headers) {
      for (const [k, v] of Object.entries(this.config.headers)) {
        // Defensive: header name validation
        if (/^[a-zA-Z0-9-]+$/.test(k) && typeof v === "string" && v.length > 0) {
          headers[k] = v;
        }
      }
    }
    return headers;
  }

  private async fetchJson<T>(path: string, init: RequestInit & { timeoutMs?: number }): Promise<T> {
    const url = `${this.resolveBaseUrl()}${path}`;
    const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const signal = this.buildTimeoutSignal(timeoutMs, init.signal as AbortSignal | undefined);

    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: { ...this.buildHeaders(), ...(init.headers as Record<string, string> | undefined) },
        signal,
      });
    } catch (err) {
      if ((err as DOMException)?.name === "TimeoutError" || (err as Error).name === "AbortError") {
        throw new AiError(`Ollama request timed out: ${path}`, "TIMEOUT", err);
      }
      if ((err as Error).name === "AbortError") {
        throw new AiError("Ollama request aborted", "ABORTED", err);
      }
      throw new AiUpstreamError(`Ollama unreachable at ${this.resolveBaseUrl()}: ${(err as Error).message}`, err);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // Do not leak body verbatim if it contains secrets; truncate
      const safeBody = body.slice(0, 500);
      if (res.status === 401 || res.status === 403) {
        throw new AiError(`Ollama auth failed (${res.status}): ${safeBody}`, "AUTH_FAILED");
      }
      if (res.status === 404) {
        throw new AiError(`Ollama not found (${res.status}): ${safeBody}`, "NOT_FOUND");
      }
      if (res.status === 429) {
        throw new AiError(`Ollama rate limited: ${safeBody}`, "RATE_LIMITED");
      }
      throw new AiUpstreamError(`Ollama error ${res.status}: ${safeBody}`);
    }

    try {
      return (await res.json()) as T;
    } catch (err) {
      throw new AiUpstreamError(`Invalid JSON from Ollama ${path}`, err);
    }
  }

  async healthCheck(signal?: AbortSignal): Promise<AiHealthStatus> {
    const start = Date.now();
    try {
      // /api/version answers in one round trip.
      let version: string | undefined;
      try {
        const v = await this.fetchJson<{ version: string }>("/api/version", {
          method: "GET",
          signal,
          timeoutMs: 5000,
        });
        version = v.version;
      } catch {
        // Older Ollama without /api/version: probe /api/tags for the version it carries.
        const tags = await this.fetchJson<{ version?: string }>("/api/tags", {
          method: "GET",
          signal,
          timeoutMs: 5000,
        });
        version = tags.version;
      }
      const latencyMs = Date.now() - start;
      logger.info(`Ollama health ok latency=${latencyMs}ms`);
      return { ok: true, latencyMs, version };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Ollama health failed: ${msg}`);
      return { ok: false, error: msg, latencyMs: Date.now() - start };
    }
  }

  async listModels(signal?: AbortSignal): Promise<AiModel[]> {
    const data = await this.fetchJson<OllamaTagsResponse>("/api/tags", {
      method: "GET",
      signal,
      timeoutMs: 10_000,
    });
    const models = data.models ?? [];
    return models.map((m) => ({
      id: m.model || m.name,
      name: m.name || m.model,
      ownedBy: "ollama",
      created: m.modified_at ? Date.parse(m.modified_at) : undefined,
    }));
  }

  private toOllamaTools(tools?: AiTool[]): OllamaToolDef[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    return tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        ...(t.description !== undefined ? { description: t.description } : {}),
        ...(t.parameters !== undefined ? { parameters: t.parameters } : {}),
      },
    }));
  }

  /** Map our messages to Ollama's wire shape, carrying tool_calls/name through. */
  private toOllamaMessages(messages: AiMessage[]): OllamaChatMessage[] {
    return messages.map((m) => {
      const base: OllamaChatMessage = { role: m.role, content: m.content };
      if (m.name) base.name = m.name;
      if (m.toolCalls && m.toolCalls.length > 0) {
        base.tool_calls = m.toolCalls.map((tc) => ({
          function: {
            name: tc.name,
            arguments: tc.arguments,
          },
        }));
      }
      return base;
    });
  }

  private parseToolCalls(message?: OllamaChatMessage): AiToolCall[] {
    if (!message?.tool_calls || message.tool_calls.length === 0) return [];
    const out: AiToolCall[] = [];
    for (const tc of message.tool_calls) {
      const fn = tc.function ?? tc;
      const name = fn?.name;
      if (!name) continue;
      let args: Record<string, unknown> = {};
      const rawArgs = fn?.arguments;
      if (typeof rawArgs === "object" && rawArgs !== null) args = rawArgs as Record<string, unknown>;
      else if (typeof rawArgs === "string" && rawArgs) {
        try {
          const parsed = JSON.parse(rawArgs) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
        } catch {
          // ignore malformed args
        }
      }
      out.push({ name, arguments: args });
    }
    return out;
  }

  async chat(messages: AiMessage[], options?: AiChatOptions): Promise<AiChatResponse> {
    const errs = this.validateMessages(messages);
    if (errs.length) throw new AiError(errs.join("; "), "VALIDATION_ERROR");

    const model = options?.model ?? this.config.defaultModel ?? DEFAULT_MODEL;
    const body: OllamaChatRequest = {
      model,
      messages: this.toOllamaMessages(messages),
      stream: false,
      ...(this.toOllamaTools(options?.tools) ? { tools: this.toOllamaTools(options?.tools) } : {}),
    };
    const ollamaOptions: Record<string, unknown> = {};
    if (options?.temperature !== undefined) ollamaOptions.temperature = options.temperature;
    if (options?.topP !== undefined) ollamaOptions.top_p = options.topP;
    if (options?.topK !== undefined) ollamaOptions.top_k = options.topK;
    if (options?.minP !== undefined) ollamaOptions.min_p = options.minP;
    if (options?.repeatPenalty !== undefined) ollamaOptions.repeat_penalty = options.repeatPenalty;
    if (options?.frequencyPenalty !== undefined) ollamaOptions.frequency_penalty = options.frequencyPenalty;
    if (options?.presencePenalty !== undefined) ollamaOptions.presence_penalty = options.presencePenalty;
    if (options?.seed !== undefined) ollamaOptions.seed = options.seed;
    if (options?.stop?.length) ollamaOptions.stop = options.stop;
    if (options?.maxTokens !== undefined) ollamaOptions.num_predict = options.maxTokens;
    if (Object.keys(ollamaOptions).length) body.options = ollamaOptions;

    const res = await this.fetchJson<OllamaChatResponse>("/api/chat", {
      method: "POST",
      body: JSON.stringify(body),
      signal: options?.signal,
      timeoutMs: options?.timeoutMs ?? 120_000,
    });

    const content = res.message?.content ?? "";
    const toolCalls = this.parseToolCalls(res.message);
    return {
      id: `ollama-${Date.now()}`,
      model: res.model || model,
      created: Date.parse(res.created_at) || Date.now(),
      content,
      finishReason:
        res.done_reason === "length"
          ? "length"
          : toolCalls.length > 0
            ? "tool_calls"
            : res.done
              ? "stop"
              : "unknown",
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      usage: {
        promptTokens: res.prompt_eval_count,
        completionTokens: res.eval_count,
        totalTokens:
          res.prompt_eval_count !== undefined && res.eval_count !== undefined
            ? res.prompt_eval_count + res.eval_count
            : undefined,
      },
    };
  }

  async *chatStream(
    messages: AiMessage[],
    options?: AiChatOptions,
  ): AsyncIterable<AiChatChunk> {
    const errs = this.validateMessages(messages);
    if (errs.length) throw new AiError(errs.join("; "), "VALIDATION_ERROR");

    const model = options?.model ?? this.config.defaultModel ?? DEFAULT_MODEL;
    const body: OllamaChatRequest = {
      model,
      messages: this.toOllamaMessages(messages),
      stream: true,
      ...(this.toOllamaTools(options?.tools) ? { tools: this.toOllamaTools(options?.tools) } : {}),
    };
    const ollamaOptions: Record<string, unknown> = {};
    if (options?.temperature !== undefined) ollamaOptions.temperature = options.temperature;
    if (options?.topP !== undefined) ollamaOptions.top_p = options.topP;
    if (options?.topK !== undefined) ollamaOptions.top_k = options.topK;
    if (options?.minP !== undefined) ollamaOptions.min_p = options.minP;
    if (options?.repeatPenalty !== undefined) ollamaOptions.repeat_penalty = options.repeatPenalty;
    if (options?.frequencyPenalty !== undefined) ollamaOptions.frequency_penalty = options.frequencyPenalty;
    if (options?.presencePenalty !== undefined) ollamaOptions.presence_penalty = options.presencePenalty;
    if (options?.seed !== undefined) ollamaOptions.seed = options.seed;
    if (options?.stop?.length) ollamaOptions.stop = options.stop;
    if (options?.maxTokens !== undefined) ollamaOptions.num_predict = options.maxTokens;
    if (Object.keys(ollamaOptions).length) body.options = ollamaOptions;

    const url = `${this.resolveBaseUrl()}/api/chat`;
    const signal = this.buildTimeoutSignal(options?.timeoutMs ?? 120_000, options?.signal);

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") throw new AiError("Ollama stream aborted", "ABORTED", err);
      throw new AiUpstreamError(`Ollama stream unreachable: ${(err as Error).message}`, err);
    }

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new AiUpstreamError(`Ollama stream error ${res.status}: ${text.slice(0, 500)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    const id = `ollama-stream-${Date.now()}`;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // Ollama streams newline-delimited JSON
        let nlIndex: number;
        while ((nlIndex = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nlIndex).trim();
          buf = buf.slice(nlIndex + 1);
          if (!line) continue;
          let parsed: OllamaChatResponse;
          try {
            parsed = JSON.parse(line) as OllamaChatResponse;
          } catch {
            continue; // skip malformed line
          }
          // Surface reasoning when a model thinks and offers no visible content
          // yet; once real content arrives it takes over. Native /api/chat uses
          // `thinking`, OpenAI-compat uses `reasoning_content`/`reasoning`.
          const contentDelta = parsed.message?.content ?? "";
          const reasoningDelta =
            parsed.message?.thinking ??
            parsed.message?.reasoning_content ??
            (parsed.message as { reasoning?: string })?.reasoning ??
            "";
          const delta = contentDelta || reasoningDelta;
          const reasoning = !contentDelta && !!reasoningDelta;
          const isDone = parsed.done === true;
          if (delta || isDone) {
            const toolCalls = isDone ? this.parseToolCalls(parsed.message) : [];
            yield {
              id,
              model: parsed.model || model,
              delta,
              done: isDone,
              reasoning,
              finishReason: isDone
                ? toolCalls.length > 0
                  ? "tool_calls"
                  : parsed.done_reason === "length"
                    ? "length"
                    : "stop"
                : undefined,
              ...(toolCalls.length > 0 ? { toolCalls } : {}),
            };
          }
          if (isDone) {
            // Drain remaining? Ollama sends done=true as last chunk
            // Break after yielding done, but still need to cancel reader
            // We'll exit outer loop after consuming buffered rest
          }
        }
      }
      // Flush trailing buffer (no newline)
      if (buf.trim()) {
        try {
          const parsed = JSON.parse(buf.trim()) as OllamaChatResponse;
          const contentDelta = parsed.message?.content ?? "";
          const reasoningDelta =
            parsed.message?.thinking ??
            parsed.message?.reasoning_content ??
            (parsed.message as { reasoning?: string })?.reasoning ??
            "";
          const delta = contentDelta || reasoningDelta;
          const reasoning = !contentDelta && !!reasoningDelta;
          const toolCalls = parsed.done === true ? this.parseToolCalls(parsed.message) : [];
          yield {
            id,
            model: parsed.model || model,
            delta,
            done: parsed.done === true,
            reasoning,
            finishReason: parsed.done
              ? toolCalls.length > 0
                ? "tool_calls"
                : parsed.done_reason === "length"
                  ? "length"
                  : "stop"
              : undefined,
            ...(toolCalls.length > 0 ? { toolCalls } : {}),
          };
        } catch {
          // ignore
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
      // Abort underlying fetch if consumer stopped early
      try {
        await res.body.cancel().catch(() => {});
      } catch {
        // ignore
      }
    }
  }
}
