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
  DEFAULT_NAME,
  GREET_ROUTE,
  MODELS_ROUTE,
  NAME_FIELD,
  PROVIDERS_ROUTE,
  TIP_ROUTE,
} from "../shared/constants.ts";
import { greeting, tip } from "./views.ts";
import { OllamaProvider } from "../providers/ollama.ts";
import { OpenAIProvider } from "../providers/openai.ts";
import { AnthropicProvider } from "../providers/anthropic.ts";
import { ProviderRegistry, providerRegistry } from "../providers/registry.ts";
import type { Provider } from "../providers/types.ts";
import {
  type CredentialStore,
  MemoryCredentialStore,
  createDefaultCredentialStore,
  maskApiKey,
} from "../providers/credentials.ts";

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

  return app;
}
