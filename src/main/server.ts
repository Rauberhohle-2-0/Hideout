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
  CAPABILITY_HEADER,
  CHAT_ROUTE,
  DEFAULT_NAME,
  GREET_ROUTE,
  MODELS_ROUTE,
  NAME_FIELD,
  PROVIDERS_ROUTE,
  TIP_ROUTE,
} from "../shared/constants.ts";
import { readJsonBodyBounded } from "../shared/http-body.ts";
import { stripSourcesFromContent, validateChatRequest, type Source } from "../shared/chat.ts";
import { isAllowedHttpUrl } from "../shared/safe-url.ts";
import { greeting, tip } from "./views.ts";
import { OllamaProvider } from "../providers/implementations/ollama.ts";
import { OpenAIProvider } from "../providers/implementations/openai.ts";
import { AnthropicProvider } from "../providers/implementations/anthropic.ts";
import { withLocalModelPrompt } from "../providers/core/local-prompt.ts";
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
import { MemoryTrustStore, createDefaultTrustStore } from "../mcp/trust-store.ts";
import { MemoryAuditStore, createDefaultAuditStore } from "../mcp/audit-store.ts";

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

/**
 * Follow-up signals that, on their own, don't trigger `shouldUseWebSearch`
 * but *do* warrant a fresh search when the conversation already established
 * grounded facts (e.g. "I heard Merz is the best chancellor — is that true?",
 * "what do people think of him?", "is he popular?").
 *
 * Covers opinion/approval/poll language, hearsay verification ("I heard",
 * "people say", "is that true"), and bare pronouns referring to a previously
 * grounded entity.
 *
 * Exported for testing.
 */
const FOLLOWUP_SEARCH_SIGNALS =
  /\b(best|worst|greatest|popular|popularity|approval|approve|approves|rating|ratings|poll|polls|survey|surveys|think|thinks|thought|people|public|opinion|reputation|legacy|record|heard|rumor|rumour|claim|claims|really|truth|true|right\?|correct\?|is that so|do you agree)\b|\b(he|she|they|him|her|them|his|hers|their|it)\b/i;

const STOPWORDS = new Set([
  "the",
  "that",
  "this",
  "with",
  "from",
  "have",
  "has",
  "are",
  "was",
  "were",
  "will",
  "would",
  "what",
  "when",
  "where",
  "which",
  "who",
  "how",
  "why",
  "your",
  "about",
  "into",
  "over",
  "under",
  "then",
  "than",
  "them",
  "they",
  "hear",
  "heard",
  "people",
  "think",
  "years",
]);

function contentTokens(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9äöüß\s]/gi, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  return new Set(words);
}

export type TurnMessage = {
  role: "user" | "assistant" | "system";
  content: string;
  sources?: Source[];
};

function lastUserMessage(messages: readonly TurnMessage[]): TurnMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") return messages[i];
  }
  return undefined;
}

/**
 * Conversation-aware search decision.
 *
 * `shouldUseWebSearch(query)` looks at one message in isolation, so a
 * follow-up like "I heard Merz is the best chancellor in years?" never
 * searches — and the model falls back to stale params (Scholz) instead of
 * the facts grounded two turns earlier. This version also looks at history:
 * when prior turns were grounded (earlier user question needed a search, or
 * an assistant turn carries `sources`) and the new turn references that
 * context (follow-up signals or token overlap), it triggers a fresh search
 * with a rewritten query that carries the entity forward.
 *
 * Returns whether to search and which query to send to the search tool.
 * Exported for testing.
 */
export function decideWebSearch(messages: readonly TurnMessage[]): { shouldSearch: boolean; searchQuery: string } {
  const lastUser = lastUserMessage(messages);
  const query = lastUser?.content ?? "";
  if (!query.trim()) return { shouldSearch: false, searchQuery: "" };
  if (shouldUseWebSearch(query)) return { shouldSearch: true, searchQuery: query };

  // Only consider follow-ups when there is prior conversation.
  const prior = messages.slice(0, messages.lastIndexOf(lastUser!));
  if (prior.length === 0) return { shouldSearch: false, searchQuery: "" };

  const priorUserQueries = prior.filter((m) => m.role === "user").map((m) => m.content);
  const priorAssistants = prior.filter((m) => m.role === "assistant");
  const hadGroundedHistory =
    priorUserQueries.some((q) => shouldUseWebSearch(q)) || prior.some((m) => Array.isArray(m.sources) && m.sources.length > 0);
  if (!hadGroundedHistory) return { shouldSearch: false, searchQuery: "" };

  const hasFollowUpSignal = FOLLOWUP_SEARCH_SIGNALS.test(query);
  // Token overlap with recent history (last 4 turns) — e.g. "Merz",
  // "chancellor", "Germany" carried into the follow-up.
  const recentText = prior.slice(-4).map((m) => m.content).join(" ");
  const queryTokens = contentTokens(query);
  const recentTokens = contentTokens(recentText);
  let overlap = 0;
  for (const t of queryTokens) if (recentTokens.has(t)) overlap += 1;

  if (!hasFollowUpSignal && overlap === 0) return { shouldSearch: false, searchQuery: "" };

  // Rewrite the query so the search tool sees the entity, not just "he".
  // Prefer the most recent prior user question that needed a search
  // ("Who is the current Chancellor of Germany?"), else the last assistant
  // answer's lead (which holds the entity name).
  const anchorUser = [...priorUserQueries].reverse().find((q) => shouldUseWebSearch(q));
  const anchorAssistant = priorAssistants.length > 0 ? priorAssistants[priorAssistants.length - 1]!.content.slice(0, 200) : "";
  const anchor = anchorUser ?? anchorAssistant;
  const searchQuery = anchor ? `${query} Context: ${anchor}`.slice(0, 500) : query;
  return { shouldSearch: true, searchQuery };
}

/**
 * Continuity reminder built from previously grounded assistant turns.
 *
 * Search grounding is otherwise ephemeral: `buildGroundedMessages` injects
 * results for one turn only, and the next turn sends just user/assistant
 * texts. Without this, a follow-up with no fresh search lets the model
 * revert to stale pretraining ("Scholz is chancellor"). When earlier
 * assistant turns carry `sources` (sent by the renderer snapshot), remind
 * the model to treat them as authoritative.
 *
 * Exported for testing.
 */
export function buildContinuityContext(messages: readonly TurnMessage[]): string {
  const grounded = messages.filter(
    (m) => m.role === "assistant" && Array.isArray(m.sources) && m.sources.length > 0 && m.content.trim(),
  );
  if (grounded.length === 0) return "";
  const lines = grounded
    .slice(-2)
    .map((m) => `- ${m.content.trim().slice(0, 300)}`)
    .join("\n");
  return `Previously verified in this conversation via web search:\n${lines}\nTreat these as authoritative unless newer search results contradict them. Do not revert to stale pretraining.`;
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
  return `Current date: ${date}\nWeb search results for "${query}":\n${lines}\n\nInstructions: You MUST answer based on these web search results. They are current and authoritative. If they conflict with your prior knowledge, prefer the search results. Write plain prose only. Do NOT include inline citations like [1], [2], and never add a "Sources", "Source", "References", or "Citations" section — not as a trailing list, not as bullet points, not as a summary. Do not describe or mention the sources themselves; the UI already shows them in a pill below your answer.`;
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
    // Dedupe by URL, dropping anything that is not an absolute http(s) URL so
    // no javascript:/file:/malformed link can reach the renderer's pills.
    const seen = new Set<string>();
    const deduped: Source[] = [];
    for (const s of sources) {
      if (!isAllowedHttpUrl(s.url) || seen.has(s.url)) continue;
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

/** Maximum concurrent chat requests (streaming + non-streaming). */
export const MAX_ACTIVE_CHATS = 8;
/** Hard timeout for a non-streaming chat round-trip. */
export const CHAT_TIMEOUT_MS = 240_000;
/** Cap on total bytes streamed for one chat answer (SSE deltas). */
export const CHAT_MAX_STREAM_BYTES = 32 * 1024 * 1024;
/** Non-streaming replies longer than this are truncated before sending. */
export const CHAT_MAX_REPLY_CHARS = 16 * 1024 * 1024;

/**
 * Abort signal bound to an optional parent (client disconnect) plus a hard
 * timer. `timedOut()` distinguishes the two so error mapping can differ.
 */
function withTimeoutSignal(
  parent: AbortSignal | undefined,
  ms: number,
): { signal: AbortSignal; timedOut: () => boolean; cancel: () => void } {
  const controller = new AbortController();
  let didTimeOut = false;
  const onAbort = (): void => controller.abort();
  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    didTimeOut = true;
    controller.abort();
  }, ms);
  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    cancel: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

/** Random per-process capability token (64 hex chars). */
export function generateCapabilityToken(): string {
  const bytes = new Uint8Array(32);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    // Extremely unlikely fallback for environments without Web Crypto.
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The Hono app plus the capability token the trusted channel must send. */
export type HideoutApp = Hono & { capabilityToken?: string };

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
  /** Include the code-owned built-in EXA server (default true). */
  includeExa?: boolean;
  /**
   * Per-process capability token required by every route. When omitted a
   * fresh random token is generated and exposed on the returned app as
   * `capabilityToken`. Production must inject it into the trusted renderer
   * path (dev: the Vite proxy — see vite.config.ts / src/main/index.ts).
   */
  capabilityToken?: string;
  /**
   * Test-only escape hatch: set `false` to skip the token check while the
   * Host/Origin rules stay active. Production must never set this.
   */
  requireCapability?: boolean;
};

/** Best-effort hostname from a Host header, an Origin, or a request URL. */
function hostnameOf(raw: string): string | null {
  try {
    const candidate = raw.includes("://") ? raw : `http://${raw}`;
    return new URL(candidate).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}

/** Only loopback hostnames may reach the sidecar. */
function isLoopbackHostname(host: string): boolean {
  return host === "localhost" || host.startsWith("127.") || host === "::1" || host === "[::1]";
}

export function createApp(options: CreateAppOptions = {}) {
  const app = new Hono() as HideoutApp;

  // ── Capability token + request-origin gate ────────────────────────────
  // Loopback binding alone is NOT authorization: any local process (or a
  // DNS-rebinding web page) can reach 127.0.0.1. Every request must present
  // the per-process capability token, and defense in depth additionally
  // rejects non-loopback Host headers (rebinding) and cross-origin browser
  // requests (Origin header whose host is not loopback). The token is
  // injected only into the trusted renderer path — in dev, the Vite proxy
  // (see vite.config.ts and src/main/index.ts).
  const requireCapability = options.requireCapability ?? true;
  const capabilityToken =
    options.capabilityToken ?? (requireCapability ? generateCapabilityToken() : undefined);
  app.capabilityToken = capabilityToken;
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    // Host gate: the sidecar must only ever be addressed as loopback.
    const host = hostnameOf(c.req.header("host") ?? c.req.url);
    if (!host || !isLoopbackHostname(host)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    // Origin gate: browser-originated requests (cross-origin forms/fetch
    // carry Origin; sandboxed iframes send "null") must come from a
    // loopback-hosted page. Non-browser local clients send no Origin and are
    // still stopped by the token below.
    const origin = c.req.header("origin");
    if (origin !== undefined) {
      const originHost = hostnameOf(origin);
      if (origin === "null" || !originHost || !isLoopbackHostname(originHost)) {
        return c.json({ error: "Forbidden origin" }, 403);
      }
    }
    // Capability token: the actual authorization decision.
    if (requireCapability) {
      const provided = c.req.header(CAPABILITY_HEADER);
      if (!capabilityToken || provided !== capabilityToken) {
        return c.json({ error: "Unauthorized" }, 401);
      }
    }
    await next();
  });

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
  // Exa is a code-owned built-in (defined in `createExaMcpServer`) and is
  // never written to the store. User servers persist in the OS user-data
  // directory via `createDefaultMcpStore`.

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
      // STDIO approvals persist separately from server configs; a memory
      // store keeps tests isolated, the file store survives restarts.
      trustStore: (() => {
        try {
          return createDefaultTrustStore();
        } catch {
          return new MemoryTrustStore();
        }
      })(),
      // Trust & policy change history, same persistence scheme as above.
      auditStore: (() => {
        try {
          return createDefaultAuditStore();
        } catch {
          return new MemoryAuditStore();
        }
      })(),
      fetchImpl: options.mcpFetch ?? (globalThis.fetch as typeof fetch),
      includeExa: options.includeExa ?? true,
    });
  // Eagerly register the built-in EXA server so GET /api/mcp/servers is
  // never empty in production. Lazy init also works, but this makes the
  // first request deterministic.
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

  // `claude` is deliberately NOT a provider: Anthropic is the sole provider
  // for Claude models. Older versions also stored a key under the `claude`
  // alias; `migrateLegacyClaudeKey` folds any such entry into the canonical
  // `anthropic` one, and the routes below stop keeping the alias in sync.
  const KNOWN_CREDENTIAL_PROVIDERS = new Set(["openai", "anthropic"]);
  const LEGACY_CREDENTIAL_IDS = new Set(["claude"]);
  const isValidProviderId = (id: string): boolean =>
    !LEGACY_CREDENTIAL_IDS.has(id) &&
    (KNOWN_CREDENTIAL_PROVIDERS.has(id) || /^[a-z][a-z0-9_-]{1,30}$/.test(id));

  /** State for one provider's key — raw keys never leave this function. */
  const toCredentialState = async (providerId: string) => {
    const raw = await credentialStore.get(providerId).catch(() => null);
    const hasKey = raw !== null && raw.length > 0;
    return {
      providerId,
      hasKey,
      maskedKey: hasKey ? maskApiKey(raw!) : null,
    };
  };

  /**
   * One-time migration: older builds kept Anthropic keys in sync under the
   * `claude` alias. Fold a legacy `claude` entry into the canonical
   * `anthropic` one (when no `anthropic` key exists yet) and delete it, so
   * every read converges on a single entry per provider. Safe to call
   * repeatedly; it is a no-op once no `claude` key remains.
   */
  const migrateLegacyClaudeKey = async (): Promise<void> => {
    const legacy = await credentialStore.get("claude").catch(() => null);
    if (!legacy) return;
    try {
      const canonical = await credentialStore.get("anthropic");
      if (!canonical) await credentialStore.set("anthropic", legacy);
    } finally {
      // Drop the alias whether or not the copy succeeded — the canonical
      // entry (new or pre-existing) is the single source of truth now.
      await credentialStore.delete("claude").catch(() => {});
    }
  };

  // List every known provider's credential state — no raw keys.
  app.get("/api/credentials", async (c) => {
    // Fold any legacy `claude` key into `anthropic` before listing so the UI
    // never shows a stale duplicate row.
    await migrateLegacyClaudeKey();
    const ids = new Set<string>([
      ...KNOWN_CREDENTIAL_PROVIDERS,
      ...registry.ids().filter((id) => id !== "ollama"),
    ]);
    const credentials = await Promise.all([...ids].map((id) => toCredentialState(id)));
    return c.json({ credentials });
  });

  app.get("/api/credentials/:providerId", async (c) => {
    const providerId = c.req.param("providerId");
    if (!isValidProviderId(providerId)) {
      // `claude` is rejected on purpose — Anthropic is the only provider; the
      // legacy alias key is migrated (see migrateLegacyClaudeKey).
      return c.json({ error: "Unknown provider" }, 400);
    }
    if (providerId === "anthropic") await migrateLegacyClaudeKey();
    return c.json(await toCredentialState(providerId));
  });

  app.put("/api/credentials/:providerId", async (c) => {
    const providerId = c.req.param("providerId");
    if (!isValidProviderId(providerId)) {
      return c.json({ error: "Unknown provider" }, 400);
    }
    const parsed = await readJsonBodyBounded(c.req.raw);
    if (!parsed.ok) {
      return parsed.error === "too-large"
        ? c.json({ error: "Request body too large" }, 413)
        : c.json({ error: "Invalid JSON" }, 400);
    }
    const apiKey = (parsed.body as { apiKey?: unknown })?.apiKey;
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
    // A stored key supersedes any legacy `claude` alias (it would otherwise
    // shadow nothing — `anthropic` always wins — but leave the keychain tidy).
    await credentialStore.delete("claude").catch(() => {});
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
    // Removing a provider's key also removes its legacy `claude` alias so a
    // stale copy cannot resurface on the next read.
    await credentialStore.delete("claude").catch(() => {});
    return c.json({ providerId, deleted, hasKey: false, maskedKey: null });
  });

  // ── Chat — proxy to the selected provider/model ─────────────────────
  // Chat concurrency: bound simultaneous provider requests/streams so many
  // parallel sessions cannot pile up unbounded work in the sidecar.
  let activeChats = 0;
  const tryAcquireChatSlot = (): boolean => {
    if (activeChats >= MAX_ACTIVE_CHATS) return false;
    activeChats += 1;
    return true;
  };
  const releaseChatSlot = (): void => {
    activeChats = Math.max(0, activeChats - 1);
  };
  // The renderer posts `{ providerId, model, messages, stream? }`.
  // Non-streaming returns `{ content, model, providerId, finishReason }`.
  // Streaming returns SSE `text/event-stream` with `data: {"delta":"..."}` lines
  // and a final `data: [DONE]`. Keys never leave the sidecar — the provider
  // fetches them from `credentialStore` at call time.

  app.post(CHAT_ROUTE, async (c) => {
    const parsed = await readJsonBodyBounded(c.req.raw);
    if (!parsed.ok) {
      return parsed.error === "too-large"
        ? c.json({ error: "Request body too large" }, 413)
        : c.json({ error: "Invalid JSON" }, 400);
    }
    const body = parsed.body;
    const err = validateChatRequest(body);
    if (err) return c.json({ error: err }, 400);
    const { providerId, model, messages, stream, toolsEnabled } = body as {
      providerId: string;
      model: string;
      messages: TurnMessage[];
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

    // Local models (Ollama and friends) don't ship with the strong
    // instruction-following of hosted Claude/OpenAI models, so they get
    // Hideout's code-owned base system prompt. Remote providers keep their
    // own well-tuned system behaviour and their requests pass through
    // untouched. See src/providers/core/local-prompt.ts.
    const requestMessages = provider.isLocal ? withLocalModelPrompt(messages) : messages;

    if (stream) {
      // Stream as SSE. Each chunk is `data: {"delta":"..."}\n\n` for visible
      // answer text, `data: {"thinking":"..."}` for the model's reasoning
      // trace, or `data: {"sources": [...]}` for the web-search pill (only
      // when a successful MCP web search was performed). Closed with
      // `data: [DONE]`.
      const encoder = new TextEncoder();
      const chatToolsEnabled = toolsEnabled !== false;
      const searchDecision = decideWebSearch(requestMessages);
      const continuityContext = buildContinuityContext(requestMessages);
      if (!tryAcquireChatSlot()) {
        return c.json({ error: "Too many concurrent chats — wait for one to finish." }, 429);
      }
      let streamBytes = 0;
      const readable = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            // Kick off a web-search via MCP when tools are enabled *and*
            // the turn looks like it needs fresh web info. `decideWebSearch`
            // is conversation-aware: follow-ups referencing previously
            // grounded facts ("I heard Merz is the best...?", "is he
            // popular?") trigger a fresh search with the entity carried
            // forward, and `continuityContext` reminds the model of earlier
            // verified answers so it can't revert to stale pretraining.
            // Only successful searches produce a `sources` pill — no pill otherwise.
            // Crucially, the search context is injected into the LLM messages so
            // the model's answer is grounded in the fresh results (fixes the
            // bug where sources were shown in the UI but not seen by the model).
            let groundedMessages = requestMessages;
            if (chatToolsEnabled && searchDecision.shouldSearch && searchDecision.searchQuery.trim()) {
              try {
                const { sources, context } = await collectWebSearch(mcpManager, searchDecision.searchQuery, c.req.raw.signal);
                const combined = [continuityContext, context].filter(Boolean).join("\n\n");
                if (sources.length > 0 && !c.req.raw.signal.aborted) {
                  const line = `data: ${JSON.stringify({ sources })}\n\n`;
                  controller.enqueue(encoder.encode(line));
                  if (combined) groundedMessages = buildGroundedMessages(requestMessages, combined);
                } else if (continuityContext) {
                  groundedMessages = buildGroundedMessages(requestMessages, continuityContext);
                }
              } catch {
                // Search failure is non-fatal — fall back to continuity only
                if (continuityContext) groundedMessages = buildGroundedMessages(requestMessages, continuityContext);
              }
            } else if (continuityContext) {
              groundedMessages = buildGroundedMessages(requestMessages, continuityContext);
            }

            const iterator = provider.chatStream
              ? provider.chatStream({ model, messages: groundedMessages, signal: c.req.raw.signal, toolsEnabled: chatToolsEnabled })
              : (async function* () {
                  const res = await provider.chat({ model, messages: groundedMessages, signal: c.req.raw.signal, toolsEnabled: chatToolsEnabled });
                  if (res.content) yield { type: "content" as const, text: stripSourcesFromContent(res.content) };
                })();
            for await (const chunk of iterator) {
              if (c.req.raw.signal.aborted) break;
              streamBytes += chunk.text.length;
              if (streamBytes > CHAT_MAX_STREAM_BYTES) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: "Response exceeded the size limit" })}\n\n`));
                controller.close();
                return;
              }
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
          } finally {
            releaseChatSlot();
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

    // Non-streaming: bounded by the chat slot, a hard timeout, and a reply
    // size cap so one runaway model reply cannot wedge the sidecar.
    if (!tryAcquireChatSlot()) {
      return c.json({ error: "Too many concurrent chats — wait for one to finish." }, 429);
    }
    const timed = withTimeoutSignal(c.req.raw.signal, CHAT_TIMEOUT_MS);
    try {
      const chatToolsEnabled = toolsEnabled !== false;
      const searchDecision = decideWebSearch(requestMessages);
      const continuityContext = buildContinuityContext(requestMessages);
      let sources: Source[] | undefined;
      let groundedMessages = requestMessages;
      if (chatToolsEnabled && searchDecision.shouldSearch && searchDecision.searchQuery.trim()) {
        try {
          const collected = await collectWebSearch(mcpManager, searchDecision.searchQuery, timed.signal);
          const combined = [continuityContext, collected.context].filter(Boolean).join("\n\n");
          if (collected.sources.length > 0) {
            sources = collected.sources;
            if (combined) groundedMessages = buildGroundedMessages(requestMessages, combined);
          } else if (continuityContext) {
            groundedMessages = buildGroundedMessages(requestMessages, continuityContext);
          }
        } catch {
          if (continuityContext) groundedMessages = buildGroundedMessages(requestMessages, continuityContext);
        }
      } else if (continuityContext) {
        groundedMessages = buildGroundedMessages(requestMessages, continuityContext);
      }
      const result = await provider.chat({ model, messages: groundedMessages, signal: timed.signal, toolsEnabled: chatToolsEnabled });
      let content = stripSourcesFromContent(result.content);
      if (content.length > CHAT_MAX_REPLY_CHARS) {
        content = `${content.slice(0, CHAT_MAX_REPLY_CHARS)}…[truncated]`;
      }
      return c.json({
        content,
        model: result.model,
        providerId: result.providerId,
        finishReason: result.finishReason ?? null,
        ...(sources ? { sources } : {}),
      });
    } catch (e) {
      if (timed.timedOut()) {
        return c.json({ error: "Chat request timed out" }, 504);
      }
      const msg = e instanceof Error ? e.message : String(e);
      // Map common auth errors to 502/401 for nicer UI handling
      const status = /not configured|api key|unauthorized|401/i.test(msg) ? 401 : 502;
      return c.json({ error: msg }, status);
    } finally {
      timed.cancel();
      releaseChatSlot();
    }
  });

  return app;
}
