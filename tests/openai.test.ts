import { describe, expect, test } from "bun:test";
import { MemoryCredentialStore } from "../src/providers/core/credentials.ts";
import type { ChatDelta, ChatOptions } from "../src/providers/core/types.ts";
import { OpenAIProvider } from "../src/providers/implementations/openai.ts";

const API_KEY = "sk-test-openai-1234567890abcdef";

/**
 * OpenAI Responses API mock — route-based, mirroring the wire format.
 * `onChat` answers `POST /v1/responses`; SSE bodies are built with `sse()`.
 */
type RecordedRequest = { url: string; init: RequestInit; body: unknown };

function makeFetch(opts: {
  models?: string[];
  onChat?: (url: string, init: RequestInit, body: unknown) => Response;
}): { fetch: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchMock = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;
    requests.push({ url: u, init: init ?? {}, body });
    if (u.endsWith("/models")) {
      return new Response(JSON.stringify({ data: (opts.models ?? []).map((id) => ({ id })) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.endsWith("/responses")) {
      if (opts.onChat) return opts.onChat(u, init ?? {}, body);
      return new Response("not found", { status: 404 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetch: fetchMock, requests };
}

function makeProvider(fetchImpl: typeof fetch): { provider: OpenAIProvider; store: MemoryCredentialStore } {
  const store = new MemoryCredentialStore();
  const provider = new OpenAIProvider({ credentialStore: store, fetchImpl });
  return { provider, store };
}

const opts = (extra: Partial<ChatOptions> = {}): ChatOptions => ({
  model: "gpt-5",
  messages: [
    { role: "system", content: "You are a test." },
    { role: "user", content: "hello" },
  ],
  ...extra,
});

/** Render Responses API SSE frames the way the wire carries them. */
function sse(frames: Array<{ event?: string; data: unknown }>): string {
  return frames
    .map(({ event, data }) => {
      const payload = typeof data === "string" ? data : JSON.stringify(data);
      return (event ? `event: ${event}\n` : "") + `data: ${payload}\n\n`;
    })
    .join("");
}

const outputDelta = (delta: string) => ({
  type: "response.output_text.delta",
  item_id: "msg_1",
  output_index: 0,
  content_index: 0,
  delta,
});

const reasoningDelta = (delta: string) => ({
  type: "response.reasoning_summary_text.delta",
  item_id: "rs_1",
  output_index: 0,
  summary_index: 0,
  delta,
});

const completedEvent = () => ({
  type: "response.completed",
  response: { id: "resp_1", status: "completed", output: [] },
});

const failedEvent = (message: string) => ({
  type: "response.failed",
  response: { id: "resp_1", status: "failed", error: { code: "server_error", message } },
});

describe("OpenAI Responses API chat", () => {
  test("chat() posts to /responses, translates messages, aggregates output text", async () => {
    const m = makeFetch({
      onChat: (_url, init, body) => {
        expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
        expect((body as { stream?: boolean }).stream).toBe(false);
        return new Response(
          JSON.stringify({
            id: "resp_1",
            status: "completed",
            output: [
              {
                id: "msg_1",
                type: "message",
                role: "assistant",
                content: [
                  { type: "output_text", text: "Hello " },
                  { type: "output_text", text: "world" },
                ],
              },
            ],
            output_text: "Hello world",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const { provider, store } = makeProvider(m.fetch);
    await store.set("openai", API_KEY);

    const result = await provider.chat(opts());

    expect(result.content).toBe("Hello world");
    expect(result.providerId).toBe("openai");
    expect(result.finishReason).toBe("completed");

    const req = m.requests.find((r) => r.url.endsWith("/responses"));
    expect(req).toBeDefined();
    const sent = req!.body as { model: string; input: Array<{ role: string; content: string }> };
    expect(sent.model).toBe("gpt-5");
    // system/user/assistant semantics survive the translation unchanged.
    expect(sent.input).toEqual([
      { role: "system", content: "You are a test." },
      { role: "user", content: "hello" },
    ]);
  });

  test("chatStream yields content deltas incrementally and stops on response.completed", async () => {
    const m = makeFetch({
      onChat: (_url, _init, body) => {
        expect((body as { stream?: boolean }).stream).toBe(true);
        return new Response(
          sse([
            // `event:` line supplies the type when the JSON payload omits it.
            {
              event: "response.output_text.delta",
              data: { item_id: "msg_1", output_index: 0, content_index: 0, delta: "Hi" },
            },
            { data: outputDelta(" there") },
            { data: outputDelta("!") },
            { data: completedEvent() },
          ]),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const { provider, store } = makeProvider(m.fetch);
    await store.set("openai", API_KEY);

    const deltas: ChatDelta[] = [];
    for await (const d of provider.chatStream(opts())) deltas.push(d);

    expect(deltas).toEqual([
      { type: "content", text: "Hi" },
      { type: "content", text: " there" },
      { type: "content", text: "!" },
    ]);
  });

  test("reasoning-summary events map to thinking deltas", async () => {
    const m = makeFetch({
      onChat: () =>
        new Response(
          sse([
            { data: reasoningDelta("Let me think") },
            { data: reasoningDelta(" about it.") },
            { data: outputDelta("Answer: 42") },
            { data: completedEvent() },
          ]),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    });
    const { provider, store } = makeProvider(m.fetch);
    await store.set("openai", API_KEY);

    const deltas: ChatDelta[] = [];
    for await (const d of provider.chatStream(opts())) deltas.push(d);

    expect(deltas).toEqual([
      { type: "thinking", text: "Let me think" },
      { type: "thinking", text: " about it." },
      { type: "content", text: "Answer: 42" },
    ]);
  });

  test("data: [DONE] ends the stream cleanly without response.completed", async () => {
    const m = makeFetch({
      onChat: () =>
        new Response(
          sse([{ data: outputDelta("partial") }, { data: "[DONE]" }]),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    });
    const { provider, store } = makeProvider(m.fetch);
    await store.set("openai", API_KEY);

    const deltas: ChatDelta[] = [];
    for await (const d of provider.chatStream(opts())) deltas.push(d);

    expect(deltas).toEqual([{ type: "content", text: "partial" }]);
  });

  test("chat() rejects on 401 with the API error message", async () => {
    const m = makeFetch({
      onChat: () =>
        new Response(
          JSON.stringify({
            error: { message: "Incorrect API key provided", type: "invalid_request_error" },
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
    });
    const { provider, store } = makeProvider(m.fetch);
    await store.set("openai", API_KEY);

    await expect(provider.chat(opts())).rejects.toThrow("OpenAI chat failed: 401 Incorrect API key provided");
  });

  test("chatStream() rejects on 404 (invalid model) with the API error message", async () => {
    const m = makeFetch({
      onChat: () =>
        new Response(
          JSON.stringify({ error: { message: "The model gpt-5 does not exist" } }),
          { status: 404, headers: { "content-type": "application/json" } },
        ),
    });
    const { provider, store } = makeProvider(m.fetch);
    await store.set("openai", API_KEY);

    await expect(
      (async () => {
        for await (const _ of provider.chatStream(opts())) void _;
      })(),
    ).rejects.toThrow("OpenAI stream failed: 404 The model gpt-5 does not exist");
  });

  test("response.failed mid-stream surfaces the API error after prior deltas", async () => {
    const m = makeFetch({
      onChat: () =>
        new Response(
          sse([{ data: reasoningDelta("thinking…") }, { data: failedEvent("Rate limit exceeded") }]),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    });
    const { provider, store } = makeProvider(m.fetch);
    await store.set("openai", API_KEY);

    const deltas: ChatDelta[] = [];
    let error: unknown;
    try {
      for await (const d of provider.chatStream(opts())) deltas.push(d);
    } catch (e) {
      error = e;
    }

    // Deltas streamed before the failure are preserved.
    expect(deltas).toEqual([{ type: "thinking", text: "thinking…" }]);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Rate limit exceeded");
  });

  test("aborting the signal stops the stream; the signal reaches fetch", async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | null = null;
    const m = makeFetch({
      onChat: (_url, init) => {
        seenSignal = init.signal ?? null;
        // Each SSE frame is its own stream chunk, so an abort between reads
        // is observed before the next frame is processed — like real network
        // chunking. (A single in-memory chunk is consumed atomically.)
        const enc = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(enc.encode(`data: ${JSON.stringify(outputDelta("one"))}\n\n`));
            controller.enqueue(enc.encode(`data: ${JSON.stringify(outputDelta("two"))}\n\n`));
            controller.enqueue(enc.encode(`data: ${JSON.stringify(completedEvent())}\n\n`));
            controller.close();
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });
    const { provider, store } = makeProvider(m.fetch);
    await store.set("openai", API_KEY);

    const deltas: ChatDelta[] = [];
    for await (const d of provider.chatStream(opts({ signal: controller.signal }))) {
      deltas.push(d);
      if (deltas.length === 1) controller.abort();
    }

    // The caller's own signal must have reached fetch (and aborted the stream).
    expect(seenSignal === controller.signal).toBe(true);
    expect(deltas).toEqual([{ type: "content", text: "one" }]);
  });

  test("a pre-aborted signal yields no deltas", async () => {
    const controller = new AbortController();
    controller.abort();
    const m = makeFetch({
      onChat: () =>
        new Response(
          sse([{ data: outputDelta("should not appear") }]),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    });
    const { provider, store } = makeProvider(m.fetch);
    await store.set("openai", API_KEY);

    const deltas: ChatDelta[] = [];
    for await (const d of provider.chatStream(opts({ signal: controller.signal }))) deltas.push(d);

    expect(deltas).toEqual([]);
  });

  test("error messages never contain the raw API key even when the API echoes it", async () => {
    const m = makeFetch({
      onChat: () =>
        new Response(
          JSON.stringify({
            error: { message: `Incorrect API key provided: ${API_KEY}`, type: "invalid_request_error" },
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
    });
    const { provider, store } = makeProvider(m.fetch);
    await store.set("openai", API_KEY);

    let error: unknown;
    try {
      await provider.chat(opts());
    } catch (e) {
      error = e;
    }
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain("Incorrect API key provided");
    expect(message).toContain("401");
    expect(message).not.toContain(API_KEY);
    expect(message).not.toContain("sk-test-openai-1234567890");
  });

  test("listModels keeps using GET /models", async () => {
    const m = makeFetch({ models: ["gpt-5", "o3-mini"] });
    const { provider, store } = makeProvider(m.fetch);
    await store.set("openai", API_KEY);

    const models = await provider.listModels();
    expect(models.map((x) => x.id)).toEqual(["gpt-5", "o3-mini"]);

    const req = m.requests.find((r) => r.url.endsWith("/models"));
    expect(req).toBeDefined();
    expect(req!.init.method).toBe("GET");
    expect((req!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
  });

  test("chat without a configured key fails fast", async () => {
    const m = makeFetch({});
    const { provider } = makeProvider(m.fetch);
    await expect(provider.chat(opts())).rejects.toThrow("OpenAI API key not configured");
  });
});