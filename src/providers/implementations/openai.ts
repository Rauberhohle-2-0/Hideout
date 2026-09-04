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
 *
 * API: chat generation uses the Responses API (`POST /v1/responses`), both
 * for one-shot answers and SSE streaming. Streaming surfaces two kinds of
 * deltas: `response.output_text.delta` (the visible answer → `content`) and
 * `response.reasoning_summary_text.delta` (the model's reasoning summary →
 * `thinking`). Private chain-of-thought (`response.reasoning_text.delta`) is
 * deliberately ignored — only summaries the API explicitly returns for
 * display are forwarded to the UI. Model discovery keeps `GET /v1/models`.
 */
import { BaseProvider } from "../core/base.ts";
import type { ChatDelta, ChatMessage, ChatOptions, ChatResult, Model } from "../core/types.ts";
import type { CredentialStore } from "../core/credentials.ts";
import { createDefaultCredentialStore, maskApiKey } from "../core/credentials.ts";

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

/** Non-streaming Responses API response. */
type OpenAIChatResponse = {
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  output_text?: string;
  status?: string;
  error?: { message?: string };
};

/** One SSE `data:` frame from a streaming Responses request. */
type ResponsesStreamEvent = {
  type?: string;
  delta?: string;
  message?: string;
  code?: string;
  response?: {
    status?: string;
    error?: { code?: string; message?: string };
  };
};

function resolveApiKeyFromEnv(): string | null {
  if (typeof process !== "undefined") {
    const env = process.env as Record<string, string | undefined>;
    return env.OPENAI_API_KEY ?? null;
  }
  return null;
}

/**
 * Mask key-shaped tokens (e.g. `sk-proj-...`) inside API-provided messages.
 * OpenAI's own auth error echoes the presented key, so every error surfaced
 * from this provider passes through here — the message stays readable while
 * the key never leaks into errors or logs.
 */
function maskKeysInMessage(text: string): string {
  return text.replace(/\bsk-[A-Za-z0-9_-]{12,}/g, (token) => maskApiKey(token));
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

  /** Translate Hideout's conversation into Responses API `input` items. */
  private toResponsesInput(messages: ChatMessage[]): Array<{ role: ChatMessage["role"]; content: string }> {
    return messages.map((m) => ({ role: m.role, content: m.content }));
  }

  /** Concatenate the visible text from a completed Responses API response. */
  private extractOutputText(data: OpenAIChatResponse): string {
    const parts: string[] = [];
    for (const item of data.output ?? []) {
      if (item.type !== "message") continue;
      for (const part of item.content ?? []) {
        if (part.type === "output_text" && part.text) parts.push(part.text);
      }
    }
    return parts.length > 0 ? parts.join("") : (data.output_text ?? "");
  }

  /** Build a useful, key-redacted Error from a non-2xx response. */
  private async errorFor(prefix: string, res: Response): Promise<Error> {
    const text = await res.text().catch(() => "");
    let detail = text.slice(0, 300);
    if (text) {
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } };
        if (parsed.error?.message) detail = parsed.error.message.slice(0, 300);
      } catch {
        // not JSON — keep the raw body
      }
    }
    return new Error(`${prefix}: ${res.status} ${maskKeysInMessage(detail)}`.trim());
  }

  async chat(options: ChatOptions): Promise<ChatResult> {
    const key = await this.getApiKey();
    if (!key) throw new Error("OpenAI API key not configured");
    const res = await this.fetchImpl(`${this.baseUrl}/responses`, {
      method: "POST",
      signal: options.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model: options.model,
        input: this.toResponsesInput(options.messages),
        stream: false,
      }),
    });
    if (!res.ok) throw await this.errorFor("OpenAI chat failed", res);
    const data = (await res.json()) as OpenAIChatResponse;
    if (data.error) throw new Error(maskKeysInMessage(data.error.message ?? "OpenAI error"));
    return {
      content: this.extractOutputText(data),
      model: options.model,
      providerId: this.id,
      finishReason: data.status,
    };
  }

  async *chatStream(options: ChatOptions): AsyncIterable<ChatDelta> {
    const key = await this.getApiKey();
    if (!key) throw new Error("OpenAI API key not configured");
    const res = await this.fetchImpl(`${this.baseUrl}/responses`, {
      method: "POST",
      signal: options.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        model: options.model,
        input: this.toResponsesInput(options.messages),
        stream: true,
      }),
    });
    if (!res.ok) throw await this.errorFor("OpenAI stream failed", res);
    if (!res.body) {
      const fallback = await this.chat(options);
      if (fallback.content) yield { type: "content", text: fallback.content };
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let eventName = "";
    try {
      while (true) {
        if (options.signal?.aborted) return;
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("event: ")) {
            eventName = trimmed.slice(7).trim();
            continue;
          }
          if (!trimmed.startsWith("data: ")) {
            if (trimmed === "") eventName = "";
            continue;
          }
          const jsonStr = trimmed.slice(6);
          if (jsonStr === "[DONE]") return;
          let event: ResponsesStreamEvent | null = null;
          try {
            event = JSON.parse(jsonStr) as ResponsesStreamEvent;
          } catch {
            // keepalive comments / malformed frames — ignore
          }
          if (!event) continue;
          const type = event.type ?? eventName;
          switch (type) {
            case "response.output_text.delta":
              // Visible answer text — streamed incrementally to the UI.
              if (event.delta) yield { type: "content", text: event.delta };
              break;
            case "response.reasoning_summary_text.delta":
              // Reasoning summary — surfaced as Hideout's `thinking` delta.
              // Only what the API explicitly returns for display; the
              // encrypted `response.reasoning_text.delta` chain-of-thought
              // is never forwarded.
              if (event.delta) yield { type: "thinking", text: event.delta };
              break;
            case "response.completed":
            case "response.incomplete":
              // Terminal states — everything worth showing already streamed.
              return;
            case "response.failed":
              throw new Error(maskKeysInMessage(event.response?.error?.message ?? "OpenAI response failed"));
            case "error":
              throw new Error(maskKeysInMessage(event.message ?? event.code ?? "OpenAI stream error"));
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