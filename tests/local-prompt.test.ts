import { describe, expect, test } from "bun:test";
import { BaseProvider } from "../src/providers/core/base.ts";
import { MemoryCredentialStore } from "../src/providers/core/credentials.ts";
import { LOCAL_MODEL_SYSTEM_PROMPT, withLocalModelPrompt } from "../src/providers/core/local-prompt.ts";
import { ProviderRegistry } from "../src/providers/core/registry.ts";
import type { ChatDelta, ChatMessage, ChatOptions, ChatResult, Model } from "../src/providers/core/types.ts";
import { AnthropicProvider } from "../src/providers/implementations/anthropic.ts";
import { OllamaProvider } from "../src/providers/implementations/ollama.ts";
import { OpenAIProvider } from "../src/providers/implementations/openai.ts";
import { buildGroundedMessages, createApp } from "../src/main/server.ts";
import { MemoryMcpStore } from "../src/mcp/store.ts";

/**
 * The app's base system prompt is code-owned (`src/providers/core/local-prompt.ts`)
 * and applies only to local providers (those opting in via `isLocal`). Cloud
 * providers (OpenAI/Anthropic) keep their own system behaviour and must
 * receive the renderer's messages untouched.
 */

const baseMessages: ChatMessage[] = [
  { role: "user", content: "hi" },
  { role: "assistant", content: "hello" },
  { role: "user", content: "who is the ceo" },
];

const noopFetch = (async (): Promise<Response> => new Response("", { status: 404 })) as unknown as typeof fetch;

describe("withLocalModelPrompt", () => {
  test("prepends a single leading system message and preserves the rest", () => {
    const out = withLocalModelPrompt(baseMessages);
    expect(out).toHaveLength(baseMessages.length + 1);
    expect(out[0]).toEqual({ role: "system", content: LOCAL_MODEL_SYSTEM_PROMPT });
    expect(out.slice(1)).toEqual(baseMessages);
  });

  test("merges into an existing leading system message instead of adding a second one", () => {
    const withSystem: ChatMessage[] = [{ role: "system", content: "You are a test." }, ...baseMessages];
    const out = withLocalModelPrompt(withSystem);
    const systems = out.filter((m) => m.role === "system");
    expect(systems).toHaveLength(1);
    expect(out[0]!.role).toBe("system");
    expect(out[0]!.content).toContain(LOCAL_MODEL_SYSTEM_PROMPT);
    expect(out[0]!.content).toContain("You are a test.");
    expect(out.slice(1)).toEqual(baseMessages);
  });

  test("does not mutate the input array", () => {
    const snapshot = JSON.stringify(baseMessages);
    withLocalModelPrompt(baseMessages);
    expect(JSON.stringify(baseMessages)).toBe(snapshot);
  });
});

describe("grounding merges into the prompt's system message", () => {
  test("search context joins the leading system message, never a trailing one", () => {
    const prompted = withLocalModelPrompt(baseMessages);
    const grounded = buildGroundedMessages(prompted, "Current date: 2026-09-03\nWeb search results for \"who is the ceo\":\n[1] Example — https://example.com");
    const systems = grounded.filter((m) => m.role === "system");
    expect(systems).toHaveLength(1);
    expect(grounded[0]!.content).toContain(LOCAL_MODEL_SYSTEM_PROMPT);
    expect(grounded[0]!.content).toContain("Web search results");
    expect(grounded.slice(1)).toEqual(prompted.slice(1));
  });
});

describe("provider locality flags", () => {
  test("Ollama is local; OpenAI and Anthropic are not", () => {
    expect(new OllamaProvider({ fetchImpl: noopFetch }).isLocal).toBe(true);
    expect(new OpenAIProvider({ credentialStore: new MemoryCredentialStore(), fetchImpl: noopFetch }).isLocal).toBe(false);
    expect(new AnthropicProvider({ credentialStore: new MemoryCredentialStore(), fetchImpl: noopFetch }).isLocal).toBe(false);
  });
});

/** Records the exact messages each request was sent with. */
class RecordingProvider extends BaseProvider {
  readonly id: string;
  readonly name: string;
  readonly isLocal: boolean;
  received: ChatMessage[][] = [];

  constructor(id: string, isLocal: boolean) {
    super();
    this.id = id;
    this.name = id;
    this.isLocal = isLocal;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async listModels(): Promise<Model[]> {
    return [{ id: "m", name: "m", providerId: this.id, providerName: this.name }];
  }

  async chat(options: ChatOptions): Promise<ChatResult> {
    this.received.push(options.messages);
    return { content: "ok", model: options.model, providerId: this.id };
  }

  async *chatStream(options: ChatOptions): AsyncIterable<ChatDelta> {
    this.received.push(options.messages);
    yield { type: "content", text: "ok" };
  }
}

function makeApp(): { app: ReturnType<typeof createApp>; local: RecordingProvider; remote: RecordingProvider } {
  const registry = new ProviderRegistry();
  const local = new RecordingProvider("local-test", true);
  const remote = new RecordingProvider("remote-test", false);
  registry.register(local);
  registry.register(remote);
  // includeExa: false — no MCP network in these tests; toolsEnabled: false
  // below also keeps the search heuristic from running.
  const app = createApp({ registry, mcpStore: new MemoryMcpStore(), includeExa: false });
  return { app, local, remote };
}

describe("chat route prompt injection", () => {
  test("local provider chat receives exactly one leading system prompt", async () => {
    const { app, local } = makeApp();
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "local-test", model: "m", messages: baseMessages, stream: false, toolsEnabled: false }),
    });
    expect(res.status).toBe(200);
    expect(local.received).toHaveLength(1);
    const sent = local.received[0]!;
    expect(sent.filter((m) => m.role === "system")).toHaveLength(1);
    expect(sent[0]!.role).toBe("system");
    expect(sent[0]!.content).toBe(LOCAL_MODEL_SYSTEM_PROMPT);
    expect(sent.slice(1)).toEqual(baseMessages);
  });

  test("remote provider chat passes messages through unchanged", async () => {
    const { app, remote } = makeApp();
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "remote-test", model: "m", messages: baseMessages, stream: false, toolsEnabled: false }),
    });
    expect(res.status).toBe(200);
    expect(remote.received).toHaveLength(1);
    expect(remote.received[0]).toEqual(baseMessages);
  });

  test("streaming route applies the prompt for local providers too", async () => {
    const { app, local } = makeApp();
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "local-test", model: "m", messages: baseMessages, stream: true, toolsEnabled: false }),
    });
    expect(res.status).toBe(200);
    expect(local.received).toHaveLength(1);
    const sent = local.received[0]!;
    expect(sent[0]!.role).toBe("system");
    expect(sent[0]!.content).toBe(LOCAL_MODEL_SYSTEM_PROMPT);
    expect(sent.slice(1)).toEqual(baseMessages);
  });
});