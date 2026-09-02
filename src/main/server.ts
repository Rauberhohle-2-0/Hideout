/**
 * The application, as a Hono app and nothing else.
 *
 * No file system, no port, no runtime-specific anything - just routes over
 * `Request` and `Response`. That is what makes it testable without a window
 * and, later, able to run as a packaged sidecar.
 */
import { Hono } from "hono";
import { escape } from "../shared/escape.ts";
import {
  CHAT_ROUTE,
  DEFAULT_NAME,
  GREET_ROUTE,
  MODELS_ROUTE,
  NAME_FIELD,
  PROVIDERS_ROUTE,
  TIP_ROUTE,
} from "../shared/constants.ts";
import { validateChatRequest } from "../shared/chat.ts";
import { greeting, tip } from "./views.ts";
import { OllamaProvider } from "../providers/implementations/ollama.ts";
import { OpenAIProvider } from "../providers/implementations/openai.ts";
import { AnthropicProvider } from "../providers/implementations/anthropic.ts";
import { ProviderRegistry, providerRegistry } from "../providers/core/registry.ts";
import type { Provider } from "../providers/core/types.ts";
import {
  type CredentialStore,
  MemoryCredentialStore,
  createDefaultCredentialStore,
  maskApiKey,
} from "../providers/core/credentials.ts";
import { McpManager } from "../mcp/manager.ts";
import { createMcpRoutes } from "../mcp/routes.ts";
import type { McpStore } from "../mcp/store.ts";
import { MemoryMcpStore, createDefaultMcpStore } from "../mcp/store.ts";

export type CreateAppOptions = {
  /** Override the registry (useful for tests). */
  registry?: ProviderRegistry;
  /** Extra providers to register in addition to the built-ins. */
  providers?: Provider[];
  /** Custom fetch for the built-in Ollama provider (tests). */
  ollamaFetch?: typeof fetch;
  /** Override Ollama base URL. */
  ollamaBaseUrl?: string;
  /** Credential store override (tests). Defaults to OS keychain or memory fallback. */
  credentialStore?: CredentialStore;
  /** Custom fetch for OpenAI/Anthropic providers (tests). */
  cloudFetch?: typeof fetch;
  /** MCP store override (tests). */
  mcpStore?: McpStore;
  /** MCP manager override (tests). */
  mcpManager?: McpManager;
  /** Custom fetch for MCP HTTP/SSE probes (tests). */
  mcpFetch?: typeof fetch;
  /** Whether to auto-seed the free EXA server when store is empty (default true). */
  autoSeedExa?: boolean;
};

export function createApp(options: CreateAppOptions = {}) {
  const app = new Hono();

  // Secure credential store — OS keychain in production, memory in tests/CI.
  // The same instance is shared with OpenAI/Anthropic providers so `hasKey`
  // checks and credential routes stay consistent.
  const credentialStore: CredentialStore =
    options.credentialStore ??
    (() => {
      try {
        return createDefaultCredentialStore();
      } catch {
        return new MemoryCredentialStore();
      }
    })();

  // Provider wiring — extensible registry with Ollama as the first local
  // provider. `providerRegistry` is the shared singleton plugins can use:
  //   import { providerRegistry, BaseProvider } from "../providers/index.ts";
  //   providerRegistry.register(new MyProvider());
  // For test isolation, `createApp({ registry })` can inject a clean one.
  // When no registry is given we start from a fresh one seeded with the
  // singleton's providers so both patterns work.
  let registry: ProviderRegistry;
  if (options.registry) {
    registry = options.registry;
  } else {
    registry = new ProviderRegistry();
    for (const p of providerRegistry.list()) {
      if (!registry.get(p.id)) registry.register(p);
    }
  }
  const hasOllama = registry.get("ollama") !== undefined || (options.providers ?? []).some((p) => p.id === "ollama");
  if (!hasOllama) {
    registry.register(
      new OllamaProvider({
        baseUrl: options.ollamaBaseUrl,
        fetchImpl: options.ollamaFetch,
      }),
    );
  }
  // Cloud providers are registered by default so the app *can* talk to
  // OpenAI/Anthropic once a key is stored in the keychain. Without a key
  // they report `disconnected` and `listModels()` returns `[]`, so no network
  // is touched until the user has opted in.
  const hasOpenAI = registry.get("openai") !== undefined || (options.providers ?? []).some((p) => p.id === "openai");
  if (!hasOpenAI) {
    registry.register(
      new OpenAIProvider({
        credentialStore,
        fetchImpl: options.cloudFetch ?? options.ollamaFetch,
      }),
    );
  }
  const hasAnthropic =
    registry.get("anthropic") !== undefined || (options.providers ?? []).some((p) => p.id === "anthropic");
  if (!hasAnthropic) {
    registry.register(
      new AnthropicProvider({
        credentialStore,
        fetchImpl: options.cloudFetch ?? options.ollamaFetch,
      }),
    );
  }
  for (const p of options.providers ?? []) {
    if (!registry.get(p.id)) registry.register(p);
  }

  // ── MCP servers — STDIO / HTTP (Streamable) / SSE ─────────────────────
  // Each transport is strictly separated:
  // - stdio:  command + args + env (+ cwd)   — spawns a local subprocess (npx/uvx)
  // - http:   url + headers + timeoutSeconds — Streamable HTTP (modern, `https://mcp.exa.ai/mcp`)
  // - sse:    url + headers + timeoutSeconds — legacy SSE (deprecated but still supported)
  // The default when the store is empty is the free EXA server over HTTP.
  const mcpManager =
    options.mcpManager ??
    new McpManager({
      store:
        options.mcpStore ??
        (() => {
          try {
            return createDefaultMcpStore();
          } catch {
            return new MemoryMcpStore();
          }
        })(),
      fetchImpl: options.mcpFetch ?? (globalThis.fetch as typeof fetch),
      autoSeedExa: options.autoSeedExa ?? true,
    });
  // Eagerly seed EXA so GET /api/mcp/servers is never empty in production.
  // Lazy init also works, but this makes the first request deterministic.
  void mcpManager.init().catch(() => {});
  app.route("/", createMcpRoutes(mcpManager));

  // Greet by name. The window's page sends the OS user's name, filled in by
  // src/renderer/main.ts, through an htmx request that Vite proxies here.
  app.get(GREET_ROUTE, (c) => {
    const name = (c.req.query(NAME_FIELD) ?? "").trim() || DEFAULT_NAME;
    return c.html(greeting(escape(name)), 200);
  });

  // A short tip, modelled on the previous one we served (kept on the server
  // in memory for the demo - stateless is fine too).
  let tipsServed = 0;
  app.get(TIP_ROUTE, (c) => {
    return c.html(tip(tipsServed++), 200);
  });

  // AI provider API — aggregated models across all registered providers.
  // When a provider is connected (e.g. Ollama daemon running), its usable
  // models appear here and are shown in the "Models" dropdown.
  app.get(MODELS_ROUTE, async (c) => {
    const models = await registry.listModels();
    return c.json({ models });
  });

  app.get(PROVIDERS_ROUTE, async (c) => {
    const providers = await registry.getStatus();
    return c.json({ providers });
  });

  // ── Credential management — API keys stay in the OS keychain ──────────
  // Keys are stored via `Bun.secrets` (Keychain / Credential Manager /
  // Secret Service) and **never** returned in plaintext. GET returns only
  // `{ hasKey, maskedKey }`; PUT/DELETE mutate the store.
  // The sidecar binds to 127.0.0.1 only, so remote hosts cannot reach these
  // routes. Logs redact keys via `maskApiKey`.

  const KNOWN_CREDENTIAL_PROVIDERS = new Set(["openai", "anthropic", "claude"]);
  const isValidProviderId = (id: string): boolean =>
    KNOWN_CREDENTIAL_PROVIDERS.has(id) || /^[a-z][a-z0-9_-]{1,30}$/.test(id);

  // List every known provider's credential state — no raw keys.
  app.get("/api/credentials", async (c) => {
    const ids = new Set<string>([
      ...KNOWN_CREDENTIAL_PROVIDERS,
      ...registry.ids().filter((id) => id !== "ollama"),
    ]);
    const credentials = await Promise.all(
      [...ids].map(async (providerId) => {
        const raw = await credentialStore.get(providerId).catch(() => null);
        const hasKey = raw !== null && raw.length > 0;
        return {
          providerId,
          hasKey,
          maskedKey: hasKey ? maskApiKey(raw!) : null,
        };
      }),
    );
    return c.json({ credentials });
  });

  app.get("/api/credentials/:providerId", async (c) => {
    const providerId = c.req.param("providerId");
    if (!isValidProviderId(providerId)) {
      return c.json({ error: "Unknown provider" }, 400);
    }
    const raw = await credentialStore.get(providerId).catch(() => null);
    const hasKey = raw !== null && raw.length > 0;
    return c.json({
      providerId,
      hasKey,
      maskedKey: hasKey ? maskApiKey(raw!) : null,
    });
  });

  app.put("/api/credentials/:providerId", async (c) => {
    const providerId = c.req.param("providerId");
    if (!isValidProviderId(providerId)) {
      return c.json({ error: "Unknown provider" }, 400);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const apiKey = (body as { apiKey?: unknown })?.apiKey;
    if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
      return c.json({ error: "apiKey is required" }, 400);
    }
    const trimmed = apiKey.trim();
    // Basic sanity: reject obviously short keys (most providers use >20 chars).
    // Keep error generic — don't echo the key length.
    if (trimmed.length < 8) {
      return c.json({ error: "apiKey looks too short" }, 400);
    }
    await credentialStore.set(providerId, trimmed);
    // Also mirror `claude` <-> `anthropic` so either name works. The keychain
    // holds one entry per name; keep them in sync for UX.
    if (providerId === "anthropic") {
      await credentialStore.set("claude", trimmed).catch(() => {});
    } else if (providerId === "claude") {
      await credentialStore.set("anthropic", trimmed).catch(() => {});
    }
    return c.json({
      providerId,
      hasKey: true,
      maskedKey: maskApiKey(trimmed),
    });
  });

  app.delete("/api/credentials/:providerId", async (c) => {
    const providerId = c.req.param("providerId");
    if (!isValidProviderId(providerId)) {
      return c.json({ error: "Unknown provider" }, 400);
    }
    const deleted = await credentialStore.delete(providerId).catch(() => false);
    if (providerId === "anthropic") {
      await credentialStore.delete("claude").catch(() => {});
    } else if (providerId === "claude") {
      await credentialStore.delete("anthropic").catch(() => {});
    }
    return c.json({ providerId, deleted, hasKey: false, maskedKey: null });
  });

  // ── Chat — proxy to the selected provider/model ─────────────────────
  // The renderer posts `{ providerId, model, messages, stream? }`.
  // Non-streaming returns `{ content, model, providerId, finishReason }`.
  // Streaming returns SSE `text/event-stream` with `data: {"delta":"..."}` lines
  // and a final `data: [DONE]`. Keys never leave the sidecar — the provider
  // fetches them from `credentialStore` at call time.

  app.post(CHAT_ROUTE, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const err = validateChatRequest(body);
    if (err) return c.json({ error: err }, 400);
    const { providerId, model, messages, stream, toolsEnabled } = body as {
      providerId: string;
      model: string;
      messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
      stream?: boolean;
      toolsEnabled?: boolean;
    };

    const provider = registry.get(providerId);
    if (!provider) return c.json({ error: `Unknown provider "${providerId}"` }, 400);

    // Optional guard: if provider reports disconnected, fail fast with a clear error.
    // Do not treat as 500 — the UI can surface "provider not connected".
    try {
      const available = await provider.isAvailable();
      if (!available) {
        return c.json({ error: `Provider "${providerId}" is not available` }, 503);
      }
    } catch {
      // isAvailable threw — continue to chat and let it surface the error
    }

    if (stream) {
      // Stream as SSE. Each chunk is `data: {"delta":"..."}\n\n` for visible
      // answer text or `data: {"thinking":"..."}` for the model's reasoning
      // trace, closed with `data: [DONE]`.
      const encoder = new TextEncoder();
      const chatToolsEnabled = toolsEnabled !== false;
      // When tools are enabled, we could attach MCP tools here. For now we
      // forward the flag so providers can gate tool exposure; the flag is
      // per-chat and defaults to true (see shared/chat.ts and sessions.ts).
      // Future: if (chatToolsEnabled) { tools = await mcpManager.listInfos() ... }
      void mcpManager;
      void chatToolsEnabled;
      const readable = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            const iterator = provider.chatStream
              ? provider.chatStream({ model, messages, signal: c.req.raw.signal, toolsEnabled: chatToolsEnabled })
              : (async function* () {
                  const res = await provider.chat({ model, messages, signal: c.req.raw.signal, toolsEnabled: chatToolsEnabled });
                  if (res.content) yield { type: "content" as const, text: res.content };
                })();
            for await (const chunk of iterator) {
              if (c.req.raw.signal.aborted) break;
              const payload =
                chunk.type === "thinking" ? { thinking: chunk.text } : { delta: chunk.text };
              const line = `data: ${JSON.stringify(payload)}\n\n`;
              controller.enqueue(encoder.encode(line));
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const line = `data: ${JSON.stringify({ error: msg })}\n\n`;
            try {
              controller.enqueue(encoder.encode(line));
            } catch {
              // controller already closed
            }
            try {
              controller.close();
            } catch {}
          }
        },
        cancel() {
          // client disconnected — provider's signal will abort if wired
        },
      });
      return new Response(readable, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    try {
      const chatToolsEnabled = toolsEnabled !== false;
      const result = await provider.chat({ model, messages, signal: c.req.raw.signal, toolsEnabled: chatToolsEnabled });
      return c.json({
        content: result.content,
        model: result.model,
        providerId: result.providerId,
        finishReason: result.finishReason ?? null,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Map common auth errors to 502/401 for nicer UI handling
      const status = /not configured|api key|unauthorized|401/i.test(msg) ? 401 : 502;
      return c.json({ error: msg }, status);
    }
  });

  return app;
}
