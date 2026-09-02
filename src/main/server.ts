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
import { validateChatRequest, type Source } from "../shared/chat.ts";
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

/** Extract http(s) URLs from free text. Deduped, capped. */
function extractUrls(text: string): string[] {
  const re = /https?:\/\/[^\s"'<>]+/g;
  const matches = text.match(re);
  if (!matches) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    // Trim trailing punctuation unlikely to be part of URL
    const cleaned = m.replace(/[),.\]]+$/, "");
    if (!seen.has(cleaned)) {
      seen.add(cleaned);
      out.push(cleaned);
    }
    if (out.length >= 10) break;
  }
  return out;
}

/** Normalize a raw MCP tool result into `Source[]`. Handles EXA and generic shapes. */
function extractSourcesFromMcpResult(raw: unknown): Source[] {
  if (!raw) return [];
  // Common MCP envelope: { content: [{ type:"text", text: "...json..." }] }
  if (typeof raw === "object" && raw !== null && "content" in (raw as Record<string, unknown>)) {
    const c = (raw as { content?: unknown }).content;
    if (Array.isArray(c)) {
      for (const item of c) {
        if (item && typeof (item as Record<string, unknown>).text === "string") {
          const text = (item as { text: string }).text;
          // Try JSON first (EXA returns JSON stringified results)
          try {
            const parsed = JSON.parse(text) as unknown;
            const nested = extractSourcesFromMcpResult(parsed);
            if (nested.length > 0) return nested;
          } catch {}
          const urls = extractUrls(text);
          if (urls.length > 0) return urls.map((url) => ({ url }));
        }
        if (item && typeof (item as Record<string, unknown>).url === "string") {
          const u = item as Record<string, unknown>;
          return [{ url: u.url as string, title: u.title as string | undefined }];
        }
      }
    }
  }
  if (Array.isArray(raw)) {
    const out: Source[] = [];
    for (const v of raw) {
      if (v && typeof v === "object" && typeof (v as Record<string, unknown>).url === "string") {
        const r = v as Record<string, unknown>;
        out.push({ url: r.url as string, title: r.title as string | undefined, favicon: r.favicon as string | undefined });
      } else if (typeof v === "string" && v.startsWith("http")) {
        out.push({ url: v });
      }
    }
    if (out.length > 0) return out.slice(0, 10);
  }
  if (typeof raw === "object" && raw !== null) {
    const obj = raw as Record<string, unknown>;
    // EXA shape: { results: [{ url, title, ... }] }
    if (Array.isArray(obj.results)) {
      const out: Source[] = [];
      for (const r of obj.results as unknown[]) {
        if (r && typeof r === "object" && typeof (r as Record<string, unknown>).url === "string") {
          const rr = r as Record<string, unknown>;
          out.push({ url: rr.url as string, title: (rr.title as string) ?? (rr.url as string), favicon: rr.favicon as string | undefined });
        }
      }
      if (out.length > 0) return out.slice(0, 10);
    }
    if (Array.isArray(obj.sources)) {
      const nested = extractSourcesFromMcpResult(obj.sources);
      if (nested.length > 0) return nested;
    }
    // Fallback: scrape URLs from JSON string
    try {
      const urls = extractUrls(JSON.stringify(obj));
      if (urls.length > 0) return urls.slice(0, 10).map((url) => ({ url }));
    } catch {}
  }
  if (typeof raw === "string") {
    const urls = extractUrls(raw);
    if (urls.length > 0) return urls.map((url) => ({ url }));
    try {
      const parsed = JSON.parse(raw) as unknown;
      return extractSourcesFromMcpResult(parsed);
    } catch {}
  }
  return [];
}

/**
 * Heuristic: does this user message likely need a web search?
 *
 * The old behavior called MCP search for *every* chat when tools were
 * enabled. That is wasteful for greetings, small-talk, creative,
 * coding, or chit-chat turns. This heuristic is intentionally
 * conservative: greetings/short casual messages return false, only
 * informational / time-sensitive / explicit-search queries return true.
 * The wrench toggle (`toolsEnabled`) remains the master switch — when
 * the user disables tools, no search happens regardless of this check.
 *
 * Exported for testing.
 */
export function shouldUseWebSearch(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed) return false;
  if (trimmed.length < 8) return false;

  const lower = trimmed.toLowerCase();

  // Explicit opt-in always searches (user typed /search or "search:" prefix)
  if (/^\/(search|web)\b/i.test(trimmed)) return true;
  if (/^search:\s*/i.test(trimmed)) return true;

  // Greetings / small-talk / acknowledgements — never search
  if (
    /^(hi|hello|hey|hiya|yo|sup|howdy|greetings|good\s*(morning|afternoon|evening|night)|thanks|thank\s*you|thank\s*ya|thx|ok|okay|got\s*it|sure|great|awesome|cool|nice|perfect|bye|goodbye|see\s*you|later|cya|cheers|lol|haha|hehe)[!?.\s]*$/i.test(
      lower,
    )
  ) {
    return false;
  }
  // Short social prompts like "how are you?" / "what's up?"
  if (/^(how\s+are\s+you|how\s+is\s+it\s+going|what'?s\s+up|how\s+are\s+things|how\s+can\s+you\s+help)[?!.]*$/i.test(lower)) {
    return false;
  }
  // Very short without question/keyword — likely casual
  if (trimmed.length < 20 && !/[?]/.test(trimmed)) {
    return false;
  }

  // Tiered signals: strong = needs fresh web data on its own;
  // weak = generic question words — only valuable with time-sensitivity.
  const strongSignals =
    /\b(latest|recent|current|today|tomorrow|yesterday|news|weather|price|prices|stock|stocks|score|scores|update|updates|release|released|announced|trending|forecast|schedule|results|upcoming|outage|status|20\d{2})\b/i;
  const weakSignals = /\b(what|who|when|where|why|how|which)\b/i;
  const timeSensitive = /\b(20\d{2}|today|this\s+week|this\s+month|currently|right\s+now)\b/i;
  const explicitSearchPhrase = /\b(search\s+the\s+web|look\s*up|google\s+it|browse|find\s+out)\b/i;

  // Strong signals always warrant a search (e.g. "price today", "latest news", "2026")
  if (strongSignals.test(trimmed)) return true;
  if (explicitSearchPhrase.test(trimmed)) return true;
  // Weak question words alone (e.g. "What is 2+2?") are NOT enough — require time-sensitivity
  if (weakSignals.test(trimmed) && timeSensitive.test(trimmed)) return true;

  // Default: conversational / creative / coding help without external facts -> no search
  return false;
}

/** Enriched item extracted from EXA / generic MCP search results. */
type SearchItem = { url: string; title?: string; text?: string };

/** Extract structured items (url + title + snippet) from raw MCP results. */
function extractSearchItems(raw: unknown): SearchItem[] {
  if (!raw) return [];
  // MCP envelope: { content: [{ type:"text", text: "...json..." }] }
  if (typeof raw === "object" && raw !== null && "content" in (raw as Record<string, unknown>)) {
    const c = (raw as { content?: unknown }).content;
    if (Array.isArray(c)) {
      for (const item of c) {
        if (item && typeof (item as Record<string, unknown>).text === "string") {
          const text = (item as { text: string }).text;
          try {
            const parsed = JSON.parse(text) as unknown;
            const nested = extractSearchItems(parsed);
            if (nested.length > 0) return nested;
          } catch {}
          // If text is not JSON, it may already be a snippet — but without URL we can't make an item
          const urls = extractUrls(text);
          if (urls.length > 0) return urls.map((url) => ({ url, text: text.slice(0, 600) }));
        }
        if (item && typeof (item as Record<string, unknown>).url === "string") {
          const u = item as Record<string, unknown>;
          const txt = typeof u.text === "string" ? (u.text as string) : typeof u.snippet === "string" ? (u.snippet as string) : undefined;
          return [{ url: u.url as string, title: u.title as string | undefined, text: txt?.slice(0, 800) }];
        }
      }
    }
  }
  if (Array.isArray(raw)) {
    const out: SearchItem[] = [];
    for (const v of raw) {
      if (v && typeof v === "object" && typeof (v as Record<string, unknown>).url === "string") {
        const r = v as Record<string, unknown>;
        const txt =
          typeof r.text === "string"
            ? (r.text as string)
            : typeof r.snippet === "string"
              ? (r.snippet as string)
              : typeof r.summary === "string"
                ? (r.summary as string)
                : undefined;
        out.push({ url: r.url as string, title: r.title as string | undefined, text: txt?.slice(0, 800) });
      } else if (typeof v === "string" && v.startsWith("http")) {
        out.push({ url: v });
      }
    }
    if (out.length > 0) return out.slice(0, 10);
  }
  if (typeof raw === "object" && raw !== null) {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.results)) {
      const out: SearchItem[] = [];
      for (const r of obj.results as unknown[]) {
        if (r && typeof r === "object" && typeof (r as Record<string, unknown>).url === "string") {
          const rr = r as Record<string, unknown>;
          const txt =
            typeof rr.text === "string"
              ? (rr.text as string)
              : typeof rr.snippet === "string"
                ? (rr.snippet as string)
                : typeof rr.summary === "string"
                  ? (rr.summary as string)
                  : Array.isArray(rr.highlights) && rr.highlights.length > 0 && typeof rr.highlights[0] === "string"
                    ? (rr.highlights as string[]).join(" ").slice(0, 800)
                    : typeof rr.description === "string"
                      ? (rr.description as string)
                      : undefined;
          out.push({ url: rr.url as string, title: (rr.title as string) ?? (rr.url as string), text: txt?.slice(0, 800) });
        }
      }
      if (out.length > 0) return out.slice(0, 10);
    }
    if (Array.isArray(obj.sources)) {
      const nested = extractSearchItems(obj.sources);
      if (nested.length > 0) return nested;
    }
    if (Array.isArray(obj.items)) {
      const nested = extractSearchItems(obj.items);
      if (nested.length > 0) return nested;
    }
    try {
      const urls = extractUrls(JSON.stringify(obj));
      if (urls.length > 0) return urls.slice(0, 10).map((url) => ({ url }));
    } catch {}
  }
  if (typeof raw === "string") {
    const urls = extractUrls(raw);
    if (urls.length > 0) return urls.map((url) => ({ url, text: raw.slice(0, 600) }));
    try {
      const parsed = JSON.parse(raw) as unknown;
      return extractSearchItems(parsed);
    } catch {}
  }
  return [];
}

/** Build a grounding context block from search items. Exported for testing. */
export function buildSearchContext(items: SearchItem[], query: string): string {
  if (items.length === 0) return "";
  const date = new Date().toISOString().slice(0, 10);
  const lines = items
    .slice(0, 5)
    .map((it, i) => {
      const title = it.title?.trim() ? it.title.trim() : it.url;
      const snippet = it.text?.trim() ? ` — ${it.text.trim().slice(0, 400)}` : "";
      return `[${i + 1}] ${title} — ${it.url}${snippet}`;
    })
    .join("\n");
  return `Current date: ${date}\nWeb search results for "${query}":\n${lines}\n\nInstructions: You MUST answer based on these web search results. They are current and authoritative. If they conflict with your prior knowledge, prefer the search results. Cite sources when possible.`;
}

/** Inject grounding context as a system message so the LLM sees the search results. */
export function buildGroundedMessages(
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>,
  context: string,
): Array<{ role: "user" | "assistant" | "system"; content: string }> {
  if (!context.trim()) return messages;
  // System messages MUST be at the start for Ollama / many chat templates.
  // Trailing `system` after `user` triggers 500 `System message must be first`
  // on Ollama (jinja template `raise_exception`). Prepend (and merge if a
  // system already exists) so Ollama, OpenAI and Anthropic all stay happy:
  // - Ollama: single leading system -> template OK
  // - Anthropic: all system parts are concatenated regardless of position
  // - OpenAI: leading system is canonical
  if (messages.length > 0 && messages[0]!.role === "system") {
    const merged: { role: "system"; content: string } = {
      role: "system",
      content: `${messages[0]!.content}\n\n${context}`,
    };
    return [merged, ...messages.slice(1)];
  }
  return [{ role: "system", content: context }, ...messages];
}

/**
 * Attempt a web search via MCP when tools are enabled. Returns sources on
 * success, empty array otherwise. Only runs when a search-capable server
 * exists — safe to call unconditionally when `toolsEnabled` is true.
 * Exported for backwards compatibility; prefer `collectWebSearch` which also
 * returns grounding context for the LLM.
 */
export async function collectWebSources(
  manager: McpManager,
  query: string,
  signal?: AbortSignal,
): Promise<Source[]> {
  const res = await collectWebSearch(manager, query, signal);
  return res.sources;
}

/**
 * Attempt a web search via MCP and return both Sources (for UI) and a grounding
 * context string (for the LLM). Exported for testing.
 */
export async function collectWebSearch(
  manager: McpManager,
  query: string,
  signal?: AbortSignal,
): Promise<{ sources: Source[]; context: string; items: SearchItem[] }> {
  if (!query.trim()) return { sources: [], context: "", items: [] };
  if (signal?.aborted) return { sources: [], context: "", items: [] };
  try {
    const infos = await manager.listInfos();
    // Prefer a connected server; otherwise try to connect the first enabled http/sse server
    let candidateId: string | null = null;
    let candidateToolName: string | null = null;

    for (const info of infos) {
      if (info.enabled === false) continue;
      let tools = info.tools ?? [];
      // If not connected but enabled, try to connect to discover tools
      if (info.status !== "connected" || tools.length === 0) {
        try {
          const connected = await manager.connect(info.id);
          tools = connected.tools ?? [];
        } catch {
          continue;
        }
      }
      const searchTool = tools.find((t) => /search/i.test(t.name));
      if (searchTool) {
        candidateId = info.id;
        candidateToolName = searchTool.name;
        break;
      }
    }
    if (!candidateId || !candidateToolName) return { sources: [], context: "", items: [] };

    // EXA expects { query, numResults?, ... } — keep generic
    const args: Record<string, unknown> = { query, numResults: 5 };
    // Some servers use `q` or `query` — try query first, fallback handled by server
    const raw = await manager.callTool(candidateId, candidateToolName, args);
    const items = extractSearchItems(raw);
    // Fallback to old extractor if enriched extraction missed URLs
    const fallbackSources = items.length === 0 ? extractSourcesFromMcpResult(raw) : [];
    const sourcesFromItems: Source[] = items.map((it) => ({ url: it.url, title: it.title ?? it.url }));
    const sources = sourcesFromItems.length > 0 ? sourcesFromItems : fallbackSources;
    // Dedupe by URL
    const seen = new Set<string>();
    const deduped: Source[] = [];
    for (const s of sources) {
      if (!s.url || seen.has(s.url)) continue;
      seen.add(s.url);
      deduped.push(s);
      if (deduped.length >= 5) break;
    }
    const dedupedItems = deduped
      .map((s) => items.find((it) => it.url === s.url) ?? { url: s.url, title: s.title })
      .slice(0, 5);
    const context = dedupedItems.length > 0 ? buildSearchContext(dedupedItems, query) : "";
    return { sources: deduped, context, items: dedupedItems };
  } catch {
    return { sources: [], context: "", items: [] };
  }
}

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
      // answer text, `data: {"thinking":"..."}` for the model's reasoning
      // trace, or `data: {"sources": [...]}` for the web-search pill (only
      // when a successful MCP web search was performed). Closed with
      // `data: [DONE]`.
      const encoder = new TextEncoder();
      const chatToolsEnabled = toolsEnabled !== false;
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const queryForSearch = lastUser?.content ?? "";
      const readable = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            // Kick off a web-search via MCP when tools are enabled *and*
            // the query looks like it needs fresh web info. The heuristic
            // avoids searching for greetings / small-talk / casual chat.
            // Only successful searches produce a `sources` pill — no pill otherwise.
            // Crucially, the search context is injected into the LLM messages so
            // the model's answer is grounded in the fresh results (fixes the
            // bug where sources were shown in the UI but not seen by the model).
            let groundedMessages = messages;
            if (chatToolsEnabled && queryForSearch.trim() && shouldUseWebSearch(queryForSearch)) {
              try {
                const { sources, context } = await collectWebSearch(mcpManager, queryForSearch, c.req.raw.signal);
                if (sources.length > 0 && !c.req.raw.signal.aborted) {
                  const line = `data: ${JSON.stringify({ sources })}\n\n`;
                  controller.enqueue(encoder.encode(line));
                  if (context) groundedMessages = buildGroundedMessages(messages, context);
                }
              } catch {
                // Search failure is non-fatal — continue to chat without sources
              }
            }

            const iterator = provider.chatStream
              ? provider.chatStream({ model, messages: groundedMessages, signal: c.req.raw.signal, toolsEnabled: chatToolsEnabled })
              : (async function* () {
                  const res = await provider.chat({ model, messages: groundedMessages, signal: c.req.raw.signal, toolsEnabled: chatToolsEnabled });
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
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const queryForSearch = lastUser?.content ?? "";
      let sources: Source[] | undefined;
      let groundedMessages = messages;
      if (chatToolsEnabled && queryForSearch.trim() && shouldUseWebSearch(queryForSearch)) {
        try {
          const collected = await collectWebSearch(mcpManager, queryForSearch, c.req.raw.signal);
          if (collected.sources.length > 0) {
            sources = collected.sources;
            if (collected.context) groundedMessages = buildGroundedMessages(messages, collected.context);
          }
        } catch {
          // ignore
        }
      }
      const result = await provider.chat({ model, messages: groundedMessages, signal: c.req.raw.signal, toolsEnabled: chatToolsEnabled });
      return c.json({
        content: result.content,
        model: result.model,
        providerId: result.providerId,
        finishReason: result.finishReason ?? null,
        ...(sources ? { sources } : {}),
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
