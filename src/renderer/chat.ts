/**
 * Renderer-side chat library.
 *
 * Talks to `POST /api/chat` on the sidecar, which then proxies to the
 * selected provider (Ollama / OpenAI / Anthropic). No keys ever touch the
 * renderer — the sidecar attaches them from the keychain.
 *
 * The library is intentionally headless: it does not touch the DOM except
 * through the helpers for selected-model persistence. The UI wiring in
 * `main.ts` decides how to render messages.
 *
 * ```ts
 * import { chat, chatStream, getSelectedModel, setSelectedModel } from "./chat.ts";
 *
 * // non-streaming
 * const reply = await chat({ providerId, model, messages });
 *
 * // streaming — update the UI per delta, distinguishing reasoning from text
 * for await (const chunk of chatStream({ providerId, model, messages })) {
 *   if (chunk.type === "thinking") renderThinking(chunk.text);
 *   else el.textContent += chunk.text;
 * }
 * ```
 */

import type { ChatMessage, ChatRequest, ChatResponse, Source } from "../shared/chat.ts";
import { CHAT_ROUTE } from "../shared/constants.ts";

export type { ChatMessage, ChatRequest, ChatResponse, Source } from "../shared/chat.ts";

/** Key in localStorage for the currently selected model. */
export const SELECTED_MODEL_KEY = "hideout.selectedModel";

/** What the picker stores: both ids so routing is unambiguous. */
export type SelectedModel = {
  providerId: string;
  id: string;
  name: string;
};

export function getSelectedModel(): SelectedModel | null {
  try {
    const raw = localStorage.getItem(SELECTED_MODEL_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SelectedModel>;
    if (typeof parsed.providerId === "string" && typeof parsed.id === "string") {
      return {
        providerId: parsed.providerId,
        id: parsed.id,
        name: typeof parsed.name === "string" ? parsed.name : parsed.id,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function setSelectedModel(sel: SelectedModel | null): void {
  try {
    if (!sel) localStorage.removeItem(SELECTED_MODEL_KEY);
    else localStorage.setItem(SELECTED_MODEL_KEY, JSON.stringify(sel));
  } catch {
    // storage unavailable — selection lives for this session only
  }
}

/** In-memory conversation history for the current session. */
export class ChatHistory {
  private readonly messages: ChatMessage[] = [];

  get all(): readonly ChatMessage[] {
    return this.messages;
  }

  get length(): number {
    return this.messages.length;
  }

  add(role: ChatMessage["role"], content: string): ChatMessage {
    const m: ChatMessage = { role, content };
    this.messages.push(m);
    return m;
  }

  push(msg: ChatMessage): void {
    this.messages.push({ ...msg });
  }

  clear(): void {
    this.messages.length = 0;
  }

  /** Snapshot suitable for sending to the API. */
  snapshot(): ChatMessage[] {
    return this.messages.map((m) => ({ ...m }));
  }
}

export type ChatOptions = {
  providerId: string;
  model: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
  /** Whether MCP/tools are enabled for this chat. Defaults to true. When false, server must not use tools. */
  toolsEnabled?: boolean;
};

async function handleErrorResponse(res: Response): Promise<never> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Chat failed: ${res.status}`);
  }
  const msg = (body as { error?: string })?.error ?? `Chat failed: ${res.status}`;
  throw new Error(msg);
}

/**
 * Non-streaming chat. Returns the full assistant reply.
 */
export async function chat(options: ChatOptions): Promise<ChatResponse> {
  const payload: ChatRequest = {
    providerId: options.providerId,
    model: options.model,
    messages: options.messages,
    stream: false,
    ...(options.toolsEnabled !== undefined ? { toolsEnabled: options.toolsEnabled } : {}),
  };
  const res = await fetch(CHAT_ROUTE, {
    method: "POST",
    signal: options.signal,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) await handleErrorResponse(res);
  const data = (await res.json()) as ChatResponse & { finishReason?: string | null };
  return {
    content: data.content ?? "",
    model: data.model,
    providerId: data.providerId,
    finishReason: data.finishReason ?? undefined,
    sources: (data as ChatResponse).sources,
  };
}

/** One chunk of a streaming reply: reasoning (`thinking`), visible answer text, or sources pill. */
export type ChatStreamChunk =
  | { type: "thinking" | "content"; text: string }
  | { type: "sources"; sources: Source[] };

/**
 * Streaming chat — yields deltas as they arrive.
 *
 * The sidecar emits SSE `data: {"delta":"..."}` (visible text) and
 * `data: {"thinking":"..."}` (reasoning trace) lines; we parse them here.
 * The async iterable completes after `data: [DONE]`.
 */
export async function* chatStream(options: ChatOptions): AsyncIterable<ChatStreamChunk> {
  const payload: ChatRequest = {
    providerId: options.providerId,
    model: options.model,
    messages: options.messages,
    stream: true,
    ...(options.toolsEnabled !== undefined ? { toolsEnabled: options.toolsEnabled } : {}),
  };
  const res = await fetch(CHAT_ROUTE, {
    method: "POST",
    signal: options.signal,
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) await handleErrorResponse(res);
  if (!res.body) {
    // No streaming body — fall back to non-streaming
    const data = (await res.json()) as ChatResponse;
    if (data.content) yield { type: "content", text: data.content };
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
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const part of parts) {
        const lines = part.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);
          if (data === "[DONE]") return;
          try {
            const obj = JSON.parse(data) as { delta?: string; thinking?: string; sources?: Source[]; error?: string };
            if (obj.error) throw new Error(obj.error);
            if (obj.sources && Array.isArray(obj.sources) && obj.sources.length > 0) {
              // Validate minimal shape before yielding — malformed sources are ignored
              const normalized = (obj.sources as unknown[]).filter(
                (s): s is Source => !!s && typeof (s as Record<string, unknown>).url === "string",
              ) as Source[];
              if (normalized.length > 0) yield { type: "sources", sources: normalized };
            } else if (obj.thinking) yield { type: "thinking", text: obj.thinking };
            else if (obj.delta) yield { type: "content", text: obj.delta };
          } catch (e) {
            if (e instanceof SyntaxError) continue;
            throw e;
          }
        }
      }
    }
    // flush remainder
    if (buf.trim().startsWith("data: ")) {
      const data = buf.trim().slice(6);
      if (data !== "[DONE]" && data) {
        try {
          const obj = JSON.parse(data) as { delta?: string; thinking?: string; sources?: Source[] };
          if (obj.sources && Array.isArray(obj.sources) && obj.sources.length > 0) {
            const normalized = (obj.sources as unknown[]).filter(
              (s): s is Source => !!s && typeof (s as Record<string, unknown>).url === "string",
            ) as Source[];
            if (normalized.length > 0) yield { type: "sources", sources: normalized };
          } else if (obj.thinking) yield { type: "thinking", text: obj.thinking };
          else if (obj.delta) yield { type: "content", text: obj.delta };
        } catch {}
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
}

/**
 * Convenience: send one user message and get the reply, managing history.
 *
 * Appends the user message to `history`, calls the API, appends the
 * assistant reply, and returns it. On failure the user message stays in
 * history so the caller can retry; the caller decides whether to remove it.
 */
export async function sendMessage(
  history: ChatHistory,
  selected: SelectedModel,
  content: string,
  opts: { stream?: boolean; signal?: AbortSignal } = {},
): Promise<ChatResponse> {
  const trimmed = content.trim();
  if (!trimmed) throw new Error("Message cannot be empty");
  history.add("user", trimmed);
  const messages = history.snapshot();
  if (opts.stream) {
    let full = "";
    for await (const chunk of chatStream({
      providerId: selected.providerId,
      model: selected.id,
      messages,
      signal: opts.signal,
    })) {
      if (chunk.type === "content") full += chunk.text;
    }
    const res: ChatResponse = { content: full, model: selected.id, providerId: selected.providerId };
    history.add("assistant", full);
    return res;
  }
  const res = await chat({
    providerId: selected.providerId,
    model: selected.id,
    messages,
    signal: opts.signal,
  });
  history.add("assistant", res.content);
  return res;
}
