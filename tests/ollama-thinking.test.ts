import { describe, expect, test } from "bun:test";
import { OllamaProvider } from "../src/providers/implementations/ollama.ts";
import type { ChatDelta, ChatOptions } from "../src/providers/core/types.ts";

/**
 * Route-based Ollama daemon mock.
 *
 * `models` maps a model id to the capabilities `/api/show` advertises —
 * `null` simulates a daemon that returns no capability info. `rejectThink`
 * lists models whose /api/chat rejects `think:true` with the real-world
 * 400 ("does not support thinking") even when /api/show claims support —
 * i.e. stale or lying metadata, the case the self-healing retry covers.
 *
 * Streaming responses only carry a `thinking` line when `think:true` was
 * sent, mirroring real daemon behaviour.
 */
function makeFetch(
  models: Record<string, string[] | null>,
  rejectThink: string[] = [],
): { fetch: typeof fetch; chatBodies: unknown[]; showCalls: () => number } {
  const chatBodies: unknown[] = [];
  let showCalls = 0;
  const fetchMock = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

    if (u.endsWith("/api/show")) {
      showCalls++;
      const caps = models[String(body.model)];
      if (caps === undefined) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(caps === null ? {} : { capabilities: caps }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.endsWith("/api/chat")) {
      chatBodies.push(body);
      const model = String(body.model);
      if (body.think === true && rejectThink.includes(model)) {
        return new Response(JSON.stringify({ error: `"${model}" does not support thinking` }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      if (body.stream === true) {
        const lines: string[] = [];
        if (body.think === true) lines.push(JSON.stringify({ message: { thinking: "hmm " } }));
        lines.push(JSON.stringify({ message: { content: "hi" } }));
        lines.push(JSON.stringify({ done: true }));
        return new Response(lines.join("\n") + "\n", {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        });
      }
      return new Response(JSON.stringify({ message: { role: "assistant", content: "hi" }, done: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetch: fetchMock, chatBodies, showCalls: () => showCalls };
}

function opts(model: string): ChatOptions {
  return { model, messages: [{ role: "user", content: "hello" }] };
}

describe("ollama thinking capability gating", () => {
  test("thinking-capable model gets think:true and yields thinking deltas", async () => {
    const m = makeFetch({ "qwen3:8b": ["completion", "thinking"] });
    const p = new OllamaProvider({ fetchImpl: m.fetch });

    const deltas: ChatDelta[] = [];
    for await (const d of p.chatStream(opts("qwen3:8b"))) deltas.push(d);

    expect(m.showCalls()).toBe(1); // probed once, then cached
    expect((m.chatBodies[0] as { think?: boolean }).think).toBe(true);
    expect(deltas.map((d) => d.type)).toEqual(["thinking", "content"]);

    // Second call: cache hit — no extra /api/show round trip.
    for await (const _ of p.chatStream(opts("qwen3:8b"))) void _;
    expect(m.showCalls()).toBe(1);
    expect(m.chatBodies.length).toBe(2);
    expect((m.chatBodies[1] as { think?: boolean }).think).toBe(true);
  });

  test("non-thinking model omits think entirely and streams plain content", async () => {
    const m = makeFetch({ "vision-model:8b": ["completion", "vision"] });
    const p = new OllamaProvider({ fetchImpl: m.fetch });

    const deltas: ChatDelta[] = [];
    for await (const d of p.chatStream(opts("vision-model:8b"))) deltas.push(d);

    expect(m.showCalls()).toBe(1);
    expect(m.chatBodies.length).toBe(1);
    expect("think" in (m.chatBodies[0] as object)).toBe(false); // omitted, not false
    expect(deltas.map((d) => d.type)).toEqual(["content"]);
  });

  test("chat() on a non-thinking model works without the think flag", async () => {
    const m = makeFetch({ "vision-model:8b": ["completion", "vision"] });
    const p = new OllamaProvider({ fetchImpl: m.fetch });

    const result = await p.chat(opts("vision-model:8b"));
    expect(result.content).toBe("hi");
    expect("think" in (m.chatBodies[0] as object)).toBe(false);
  });

  test("404 /api/show degrades to no think flag without failing", async () => {
    const m = makeFetch({}); // /api/show 404s for any model
    const p = new OllamaProvider({ fetchImpl: m.fetch });

    const deltas: ChatDelta[] = [];
    for await (const d of p.chatStream(opts("some-model"))) deltas.push(d);

    expect(m.showCalls()).toBe(1);
    expect("think" in (m.chatBodies[0] as object)).toBe(false);
    expect(deltas.some((d) => d.type === "content")).toBe(true);
  });

  test("stream: 400 does-not-support-thinking self-heals with one retry", async () => {
    // /api/show claims thinking, but the daemon rejects think:true —
    // exactly the stale-metadata case the retry exists for.
    const m = makeFetch({ "lying:v1": ["thinking"] }, ["lying:v1"]);
    const p = new OllamaProvider({ fetchImpl: m.fetch });

    const deltas: ChatDelta[] = [];
    for await (const d of p.chatStream(opts("lying:v1"))) deltas.push(d);

    expect(m.chatBodies.length).toBe(2); // think:true attempt, then clean retry
    expect((m.chatBodies[0] as { think?: boolean }).think).toBe(true);
    expect((m.chatBodies[1] as { think?: boolean }).think).toBe(false);
    expect(deltas.map((d) => d.type)).toEqual(["content"]);

    // Corrected verdict is remembered: next call goes straight out clean.
    for await (const _ of p.chatStream(opts("lying:v1"))) void _;
    expect(m.chatBodies.length).toBe(3);
    expect("think" in (m.chatBodies[2] as object)).toBe(false);
  });

  test("chat(): 400 does-not-support-thinking self-heals with one retry", async () => {
    const m = makeFetch({ "lying:v1": ["thinking"] }, ["lying:v1"]);
    const p = new OllamaProvider({ fetchImpl: m.fetch });

    const result = await p.chat(opts("lying:v1"));
    expect(result.content).toBe("hi");
    expect(m.chatBodies.length).toBe(2);
    expect((m.chatBodies[0] as { think?: boolean }).think).toBe(true);
    expect((m.chatBodies[1] as { think?: boolean }).think).toBe(false);

    // Second call skips both probe and think path.
    await p.chat(opts("lying:v1"));
    expect(m.chatBodies.length).toBe(3);
    expect("think" in (m.chatBodies[2] as object)).toBe(false);
  });

  test("unrelated 400 errors are not retried", async () => {
    const chatBodies: unknown[] = [];
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      if (u.endsWith("/api/show")) {
        return new Response(JSON.stringify({ capabilities: ["thinking"] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.endsWith("/api/chat")) {
        chatBodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ error: "model requires more system memory" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const p = new OllamaProvider({ fetchImpl: fetchMock });

    await expect(p.chat(opts("big:70b"))).rejects.toThrow("more system memory");
    expect(chatBodies.length).toBe(1); // no blind retry
  });
});
