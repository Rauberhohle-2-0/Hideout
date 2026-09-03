/**
 * Renderer DOM test harness.
 *
 * Boots `src/renderer/bootstrap.ts` (the whole renderer wiring) against a
 * happy-dom window whose body is the real markup from `index.html`, then lets
 * the tests drive the UI exactly like a user: clicking buttons, typing into
 * the composer, opening the settings dialog. Network calls (`/api/*`) are
 * answered by a per-test `FetchRouter` instead of the real sidecar.
 *
 * Ordering rules (load-bearing):
 *
 * - The renderer modules capture the DOM and `localStorage` at *evaluation*
 *   time (`sidebar.ts` re-queries `#sidebar` at wire time; `sessions.ts`
 *   constructs the store singleton when imported). happy-dom globals must
 *   therefore be installed — and storage seeded — *before* the dynamic
 *   import of `bootstrap.ts`.
 * - The suite runs with `--isolate` (see the `test` script in package.json)
 *   so each file gets a fresh environment and the module-level singletons
 *   reset per file. Without `--isolate` (plain `bun test`) Bun keeps one
 *   global object *and* module registry across files: the second and later
 *   boots reuse the already-evaluated modules, so `bootRenderer()` re-syncs
 *   the `sessionStore` singleton from the freshly seeded storage (see
 *   `bootRenderer`) and the sidebar re-binds its handles at wire time. That
 *   keeps every file's boot equivalent to an isolated one; within one file,
 *   `bootRenderer()` may still be called only once per intended app state.
 *
 * The happy-dom `Window` is not the real thing: layout metrics are zero
 * (`getBoundingClientRect`, `scrollHeight`, …), `matchMedia` always reports
 * light, and nothing actually renders. That is fine — every flow asserted
 * here is driven through the DOM API (classList, `hidden`, textContent,
 * dataset, events), which happy-dom implements faithfully.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";

export const PROJECT_ROOT = join(import.meta.dir, "..");

const INDEX_HTML = readFileSync(join(PROJECT_ROOT, "index.html"), "utf8");

/** The inner HTML of `<body>` from index.html — the fixture for every boot. */
export function indexBodyHtml(): string {
  const m = INDEX_HTML.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!m) throw new Error("index.html has no <body>");
  return m[1]!;
}

/**
 * The DOM globals the renderer touches, copied from the happy-dom window.
 * Curated on purpose: `fetch`, `Response`, `setTimeout`, `TextDecoder` and
 * friends stay Bun's so the router and SSE helpers keep working.
 */
const DOM_GLOBAL_KEYS = [
  "window",
  "self",
  "document",
  "navigator",
  "location",
  "history",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLButtonElement",
  "HTMLFormElement",
  "HTMLAnchorElement",
  "HTMLImageElement",
  "HTMLDivElement",
  "HTMLSpanElement",
  "Element",
  "Node",
  "Document",
  "DocumentFragment",
  "Text",
  "Comment",
  "EventTarget",
  "Event",
  "CustomEvent",
  "KeyboardEvent",
  "MouseEvent",
  "PointerEvent",
  "FocusEvent",
  "InputEvent",
  "UIEvent",
  "SVGElement",
  "SVGSVGElement",
  "SVGPathElement",
  "MutationObserver",
  "getComputedStyle",
  "matchMedia",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "localStorage",
  "sessionStorage",
  "NamedNodeMap",
  "DOMRect",
  "DOMRectList",
  "HTMLCollection",
  "NodeList",
] as const;

/** Copy the curated happy-dom globals onto `globalThis`. */
export function installWindowGlobals(win: Window): void {
  const g = globalThis as unknown as Record<string, unknown>;
  const source = win as unknown as Record<string, unknown>;
  for (const key of DOM_GLOBAL_KEYS) {
    if (source[key] !== undefined) g[key] = source[key];
  }
}

/** Minimal `__VANTAIL__` bridge so `@vantail/api` calls resolve to no-ops. */
export function installBridgeStub(): void {
  (globalThis as unknown as Record<string, unknown>).__VANTAIL__ = {
    version: "0.0.0-test",
    label: "main",
    app: { name: "Hideout", version: "0.0.0-test" },
    titleBar: { height: 36, buttonHeight: 14 },
    subscribe: () => () => {},
    postMessage: () => {},
  };
}

/**
 * Keep the test output readable: lucide re-hydrates every `[data-lucide]`
 * node on each call, including SVGs it already swapped in, so subset calls
 * (sidebar rows, settings rows) warn about icons outside the subset. That is
 * existing runtime behavior, not a test failure.
 */
export function quietLucideHydrationWarnings(): void {
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    const joined = args.map(String).join(" ");
    if (joined.includes("icon name was not found")) return;
    origWarn(...args);
  };
}

/**
 * Await renderer microtasks (fetch stubs, stream chunks, event handlers).
 * The renderer's async work resolves on microtasks, so a few turns plus one
 * macrotask is enough; nothing in these flows uses real timers.
 */
export async function flushTicks(turns = 12): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ── Fetch router ──────────────────────────────────────────────────────────

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

export type FakeRequest = {
  method: HttpMethod;
  url: URL;
  path: string;
  headers: Headers;
  /** Raw request body text ("" when none). */
  bodyText: string;
  /** JSON-parsed body, or the raw string when it is not JSON, or null. */
  body: unknown;
};

export type RouteHandler = (req: FakeRequest) => Response | Promise<Response>;

function jsonBody(body: unknown): string {
  return typeof body === "string" ? body : JSON.stringify(body ?? null);
}

/** JSON response helper. */
export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(jsonBody(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * A scriptable stand-in for the sidecar. Routes match on method + pathname;
 * every call is recorded on `requests` so tests can assert what the UI sent.
 */
export class FetchRouter {
  readonly requests: FakeRequest[] = [];
  private readonly handlers: Array<{ method?: HttpMethod; matcher: RegExp; handler: RouteHandler }> = [];

  /** Route a method+path. `path` is a RegExp tested against the pathname. */
  route(method: HttpMethod, path: RegExp, handler: RouteHandler): this {
    this.handlers.push({ method, matcher: path, handler });
    return this;
  }

  install(): void {
    const router = this;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const rawUrl = input instanceof Request ? input.url : String(input);
      const url = new URL(rawUrl, "http://hideout.local");
      const method = (
        (init?.method ?? (input instanceof Request ? input.method : undefined)) ?? "GET"
      ).toUpperCase() as HttpMethod;
      const headers = new Headers(init?.headers);
      const bodyText = typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : "";
      let body: unknown = null;
      try {
        body = bodyText ? JSON.parse(bodyText) : null;
      } catch {
        body = bodyText;
      }
      const req: FakeRequest = { method, url, path: url.pathname, headers, bodyText, body };
      router.requests.push(req);
      for (const { method: want, matcher, handler } of router.handlers) {
        if (want && want !== method) continue;
        if (matcher.test(req.path)) return handler(req);
      }
      return json({ error: `No route for ${method} ${req.path}` }, 404);
    }) as typeof fetch;
  }
}

// ── SSE helpers (the sidecar streams `/api/chat` as server-sent events) ────

export type StreamEvent =
  | { type: "thinking"; text: string }
  | { type: "delta"; text: string }
  | { type: "sources"; sources: unknown[] }
  | { type: "done" };

function sseLine(event: StreamEvent): string {
  if (event.type === "done") return "data: [DONE]\n\n";
  const payload: Record<string, unknown> =
    event.type === "sources" ? { sources: event.sources } : { [event.type]: event.text };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** Wrap stream events in an SSE `Response` whose body is a ReadableStream. */
export function sseResponse(events: StreamEvent[]): Response {
  const frames = events.map(sseLine).join("");
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frames));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

// ── Boot ───────────────────────────────────────────────────────────────────

export type BootOptions = {
  /** Seed `localStorage` (before renderer modules evaluate). */
  seed?: (storage: Storage) => void;
  /** Route table for `/api/*` fetches. */
  router?: FetchRouter;
  /** Override the `<body>` fixture (defaults to index.html's body). */
  bodyHtml?: string;
};

/**
 * How many windows this module registry has booted. Under `--isolate` each
 * test file gets a fresh copy of this module, so the count always starts at
 * zero; under a shared registry (plain `bun test`) it counts every boot,
 * letting us detect re-boots that reuse the already-evaluated renderer
 * modules (see `bootRenderer`).
 */
let bootCount = 0;

/**
 * Create the happy-dom window, install globals, seed storage, then import
 * and run the renderer bootstrap. Call once per test file. On a re-boot in
 * a shared module registry, the renderer singletons are re-synced to the
 * new window's seeded storage so the boot behaves like a fresh one.
 */
export async function bootRenderer(opts: BootOptions = {}): Promise<void> {
  const win = new Window({ url: "http://hideout.local/" });
  win.document.body.innerHTML = opts.bodyHtml ?? indexBodyHtml();
  installWindowGlobals(win);
  installBridgeStub();
  quietLucideHydrationWarnings();
  opts.seed?.(win.localStorage);
  opts.router?.install();

  if (bootCount > 0) {
    // Shared-registry re-boot: `sessions.ts` was already evaluated during an
    // earlier file's boot, so its singleton still holds that window's data.
    // Re-read the freshly seeded storage (and notify listeners) before the
    // bootstrap's restore path reads the store.
    const { sessionStore } = await import("../src/renderer/sessions.ts");
    sessionStore._reload();
  }
  bootCount += 1;

  const { bootstrap } = await import("../src/renderer/bootstrap.ts");
  bootstrap();
  await flushTicks();
}
