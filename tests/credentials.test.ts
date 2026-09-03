import { describe, expect, test } from "bun:test";
import { createApp } from "../src/main/server.ts";
import { MemoryCredentialStore, maskApiKey } from "../src/providers/core/credentials.ts";
import { ProviderRegistry } from "../src/providers/core/registry.ts";
import { OllamaProvider } from "../src/providers/implementations/ollama.ts";
import { OpenAIProvider } from "../src/providers/implementations/openai.ts";
import { AnthropicProvider } from "../src/providers/implementations/anthropic.ts";

function mockFetchFor(models: { openai?: string[]; anthropic?: string[] }): typeof fetch {
  // `typeof fetch` in Bun carries extra members (e.g. `preconnect`); the mock
  // only implements the callable part.
  return (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    if (u.includes("api.openai.com")) {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization
        ?? (init?.headers as Record<string, string> | undefined)?.["Authorization"]
        ?? "";
      if (!auth.startsWith("Bearer sk-")) return new Response("unauthorized", { status: 401 });
      return new Response(JSON.stringify({ data: (models.openai ?? []).map((id) => ({ id })) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("api.anthropic.com")) {
      const key = (init?.headers as Record<string, string> | undefined)?.["x-api-key"] ?? "";
      if (!key.startsWith("sk-")) return new Response("unauthorized", { status: 401 });
      return new Response(JSON.stringify({ data: (models.anthropic ?? []).map((id) => ({ id, display_name: id })) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("11434")) {
      return new Response(JSON.stringify({ models: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("secure credential storage", () => {
  test("maskApiKey never returns raw key", () => {
    const raw = "sk-proj-1234567890abcdef";
    const masked = maskApiKey(raw);
    expect(masked).not.toContain("1234567890abcdef");
    expect(masked).toBe("sk-...cdef");
    expect(maskApiKey("short")).toBe("••••hort");
    expect(maskApiKey("")).toBe("••••");
  });

  test("PUT stores key, GET returns only masked", async () => {
    const store = new MemoryCredentialStore();
    const registry = new ProviderRegistry();
    registry.register(new OllamaProvider({ fetchImpl: mockFetchFor({}) }));
    registry.register(new OpenAIProvider({ credentialStore: store, fetchImpl: mockFetchFor({ openai: ["gpt-4o"] }) }));
    const app = createApp({ requireCapability: false, registry, credentialStore: store, cloudFetch: mockFetchFor({ openai: ["gpt-4o"] }) });

    const raw = "sk-test-openai-1234567890abcd";
    const put = await app.request("/api/credentials/openai", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: raw }),
    });
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as { maskedKey: string; hasKey: boolean };
    expect(putBody.hasKey).toBe(true);
    expect(putBody.maskedKey).toBe(maskApiKey(raw));
    expect(JSON.stringify(putBody)).not.toContain(raw);

    const get = await app.request("/api/credentials/openai");
    expect(get.status).toBe(200);
    const getBody = (await get.json()) as { hasKey: boolean; maskedKey: string | null };
    expect(getBody.hasKey).toBe(true);
    expect(getBody.maskedKey).toBe(maskApiKey(raw));
    expect(JSON.stringify(getBody)).not.toContain(raw);

    // Internal store still holds raw (needed for Authorization header), but API never exposes it
    expect(await store.get("openai")).toBe(raw);
  });

  test("list credentials never leaks raw keys", async () => {
    const store = new MemoryCredentialStore();
    await store.set("openai", "sk-list-test-key-aaaabbbbccccdddd");
    await store.set("anthropic", "sk-ant-list-key-eeeeffffgggghhhh");
    const registry = new ProviderRegistry();
    registry.register(new OllamaProvider({ fetchImpl: mockFetchFor({}) }));
    registry.register(new OpenAIProvider({ credentialStore: store, fetchImpl: mockFetchFor({}) }));
    registry.register(new AnthropicProvider({ credentialStore: store, fetchImpl: mockFetchFor({}) }));
    const app = createApp({ requireCapability: false, registry, credentialStore: store });

    const res = await app.request("/api/credentials");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { credentials: Array<{ providerId: string; hasKey: boolean; maskedKey: string | null }> };
    const text = JSON.stringify(body);
    expect(text).not.toContain("sk-list-test");
    expect(text).not.toContain("sk-ant-list");
    const openai = body.credentials.find((c) => c.providerId === "openai");
    expect(openai?.hasKey).toBe(true);
    expect(openai?.maskedKey).toBe(maskApiKey("sk-list-test-key-aaaabbbbccccdddd"));
  });

  test("DELETE removes key, subsequent listModels returns []", async () => {
    const store = new MemoryCredentialStore();
    const registry = new ProviderRegistry();
    registry.register(new OllamaProvider({ fetchImpl: mockFetchFor({}) }));
    const openai = new OpenAIProvider({ credentialStore: store, fetchImpl: mockFetchFor({ openai: ["gpt-4o"] }) });
    registry.register(openai);
    const app = createApp({ requireCapability: false, registry, credentialStore: store, cloudFetch: mockFetchFor({ openai: ["gpt-4o"] }) });

    await app.request("/api/credentials/openai", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-delete-test-1234567890abcd" }),
    });
    const list = (await (await app.request("/api/models")).json()) as { models: unknown[] };
    expect(list.models.length).toBe(1);

    const del = await app.request("/api/credentials/openai", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await del.json() as { hasKey: boolean }).hasKey).toBe(false);

    const models = (await (await app.request("/api/models")).json()) as { models: unknown[] };
    expect(models.models.length).toBe(0);
  });

  test("legacy claude key migrates to anthropic on list", async () => {
    const store = new MemoryCredentialStore();
    // Simulate an older build: the key lives only under the `claude` alias.
    const raw = "sk-ant-legacy-test-1234567890abcd";
    await store.set("claude", raw);
    const registry = new ProviderRegistry();
    registry.register(new OllamaProvider({ fetchImpl: mockFetchFor({}) }));
    registry.register(new AnthropicProvider({ credentialStore: store, fetchImpl: mockFetchFor({}) }));
    const app = createApp({ requireCapability: false, registry, credentialStore: store });

    const res = await app.request("/api/credentials");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { credentials: Array<{ providerId: string; hasKey: boolean; maskedKey: string | null }> };

    // The migrated key now shows under the canonical `anthropic` provider.
    const anthropic = body.credentials.find((c) => c.providerId === "anthropic");
    expect(anthropic?.hasKey).toBe(true);
    expect(anthropic?.maskedKey).toBe(maskApiKey(raw));

    // Claude is no longer a credential provider — no separate row.
    expect(body.credentials.find((c) => c.providerId === "claude")).toBeUndefined();

    // The alias entry is gone; the canonical one holds the key.
    expect(await store.get("claude")).toBeNull();
    expect(await store.get("anthropic")).toBe(raw);
  });

  test("anthropic PUT stores only the canonical entry", async () => {
    const store = new MemoryCredentialStore();
    // A stale alias from an older build must not survive a fresh save.
    await store.set("claude", "sk-ant-stale-alias-1234567890abcd");
    const registry = new ProviderRegistry();
    registry.register(new OllamaProvider({ fetchImpl: mockFetchFor({}) }));
    registry.register(new AnthropicProvider({ credentialStore: store, fetchImpl: mockFetchFor({ anthropic: ["claude-3"] }) }));
    const app = createApp({ requireCapability: false, registry, credentialStore: store });

    const raw = "sk-ant-canonical-test-1234567890abcd";
    const put = await app.request("/api/credentials/anthropic", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: raw }),
    });
    expect(put.status).toBe(200);
    expect(await store.get("anthropic")).toBe(raw);
    expect(await store.get("claude")).toBeNull();

    // DELETE removes the canonical entry only (there is no alias to mirror).
    const del = await app.request("/api/credentials/anthropic", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await store.get("anthropic")).toBeNull();
    expect(await store.get("claude")).toBeNull();
  });

  test("legacy claude provider id is rejected", async () => {
    const store = new MemoryCredentialStore();
    await store.set("claude", "sk-ant-legacy-get-1234567890abcd");
    const app = createApp({ requireCapability: false, credentialStore: store });

    const res = await app.request("/api/credentials/claude");
    expect(res.status).toBe(400);
    // The key stays in the store until a canonical read migrates it.
    expect(await store.get("claude")).toBe("sk-ant-legacy-get-1234567890abcd");
    expect(await store.get("anthropic")).toBeNull();

    // Reading the canonical provider migrates the legacy key.
    const get = await app.request("/api/credentials/anthropic");
    expect(get.status).toBe(200);
    expect((await get.json() as { hasKey: boolean }).hasKey).toBe(true);
    expect(await store.get("claude")).toBeNull();
    expect(await store.get("anthropic")).toBe("sk-ant-legacy-get-1234567890abcd");
  });

  test("invalid apiKey is rejected", async () => {
    const store = new MemoryCredentialStore();
    const app = createApp({ requireCapability: false, credentialStore: store });
    const empty = await app.request("/api/credentials/openai", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "" }),
    });
    expect(empty.status).toBe(400);
    const short = await app.request("/api/credentials/openai", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "short" }),
    });
    expect(short.status).toBe(400);
  });

  test("providers status never leaks keys", async () => {
    const store = new MemoryCredentialStore();
    await store.set("openai", "sk-status-test-1234567890abcd");
    const registry = new ProviderRegistry();
    registry.register(new OllamaProvider({ fetchImpl: mockFetchFor({}) }));
    registry.register(new OpenAIProvider({ credentialStore: store, fetchImpl: mockFetchFor({ openai: ["gpt-4o"] }) }));
    const app = createApp({ requireCapability: false, registry, credentialStore: store });

    const res = await app.request("/api/providers");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("sk-status-test");
  });
});
