/**
 * Renderer boot tests — send + stream rendering.
 *
 * Boots `bootstrap.ts`, preselects a model in localStorage, types into the
 * composer, and clicks Send. The sidecar route stub answers
 * `POST /api/chat` with a real SSE stream (thinking → sources → content →
 * [DONE]) and the test asserts the full lifecycle: user bubble, the live
 * assistant answer with its collapsible Reasoning trace (steps, “Used Web
 * Search” row, Done row) and the Sources pill, the send/stop UI returning
 * to rest, and the turn being persisted to localStorage with the reasoning
 * trace and only the *sanitized* (http/https) sources.
 */
import { describe, expect, test } from "bun:test";
import { bootRenderer, FetchRouter, flushTicks, json, sseResponse, type StreamEvent } from "./dom-harness.ts";

const PROMPT = "Where do these facts come from?";
const THINKING = "Let me check where these facts come from.\n\nI found two reliable sources.";
const DELTA = "Here is the **verified** answer.";

function seedModel(storage: Storage): void {
  storage.setItem(
    "hideout.selectedModel",
    JSON.stringify({ providerId: "ollama", id: "llama3", name: "Llama 3" }),
  );
}

const streamEvents: StreamEvent[] = [
  { type: "thinking", text: THINKING },
  {
    type: "sources",
    sources: [
      { url: "https://example.com/one", title: "Example One" },
      { url: "https://example.com/two", title: "Example Two" },
      { url: "javascript:alert(1)", title: "Malicious" },
    ],
  },
  { type: "delta", text: DELTA },
  { type: "done" },
];

const router = new FetchRouter()
  .route("GET", /^\/api\/models$/, () =>
    json({ models: [{ id: "llama3", name: "Llama 3", providerId: "ollama", providerName: "Ollama" }] }),
  )
  .route("POST", /^\/api\/chat$/, () => sseResponse(streamEvents));

await bootRenderer({ seed: seedModel, router });

const { sessionStore } = await import("../src/renderer/sessions.ts");

function field(): HTMLTextAreaElement {
  return document.querySelector<HTMLTextAreaElement>("#composer-field")!;
}

function sendButton(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>("#send-button")!;
}

describe("send + streaming", () => {
  test("typing enables Send; Send is idle-disabled when empty", () => {
    expect(sendButton().disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>("#stop-button")?.hidden).toBe(true);
    field().value = PROMPT;
    field().dispatchEvent(new Event("input", { bubbles: true }));
    expect(sendButton().disabled).toBe(false);
    expect(field().value).toBe(PROMPT);
  });

  test("sending streams thinking, sources and content into the thread", async () => {
    sendButton().click();
    await flushTicks();
    await flushTicks();

    // Composer cleared; UI back at rest (Send visible, Stop gone, no busy).
    expect(field().value).toBe("");
    expect(sendButton().hidden).toBe(false);
    expect(sendButton().getAttribute("aria-busy")).toBe("false");
    expect(sendButton().disabled).toBe(true); // empty again → idle-disabled
    expect(document.querySelector<HTMLButtonElement>("#stop-button")?.hidden).toBe(true);

    // User bubble optimistically appended.
    const bubbles = [...document.querySelectorAll<HTMLElement>(".user-message-bubble")];
    expect(bubbles.map((b) => b.textContent)).toEqual([PROMPT]);

    // Assistant answer rendered (markdown bold → <strong>).
    const answers = [...document.querySelectorAll<HTMLElement>(".markdown-content")];
    expect(answers.map((a) => a.textContent).join("\n")).toContain("Here is the verified answer.");

    // Reasoning pill finished (label rests at “Reasoning”) with steps inside.
    const reasoning = document.querySelector<HTMLElement>(".reasoning-pill");
    expect(reasoning).not.toBeNull();
    expect(reasoning?.querySelector(".reasoning-pill-label")?.textContent).toBe("Reasoning");
    reasoning?.click();
    const steps = [...document.querySelectorAll<HTMLElement>(".reasoning-step")].map((el) => el.textContent);
    expect(steps).toEqual(["Let me check where these facts come from.", "I found two reliable sources."]);
    expect(document.querySelector(".reasoning-done")?.textContent).toContain("Done");

    // The “Used Web Search” tool row sits in the trace with the query + links.
    const toolHead = document.querySelector<HTMLElement>(".reasoning-tool-head");
    expect(toolHead?.textContent).toContain("Used Web Search");
    toolHead?.click();
    const entries = [...document.querySelectorAll<HTMLElement>(".reasoning-tool-entry")];
    expect(entries.some((e) => e.textContent?.startsWith("Search:"))).toBe(true);
    expect(
      [...document.querySelectorAll<HTMLAnchorElement>(".reasoning-tool-body a")].map((a) => a.href),
    ).toEqual(["https://example.com/one", "https://example.com/two"]);

    // Sources pill reveals only the two valid http(s) sources — the
    // javascript: URL never becomes an anchor.
    const sources = document.querySelector<HTMLElement>(".sources-pill:not(.reasoning-pill)");
    expect(sources?.querySelector(".sources-count")?.textContent).toBe("2 sources");
    sources?.click();
    const links = [...document.querySelectorAll<HTMLAnchorElement>(".sources-panel .sources-item")];
    expect(links.map((a) => a.href)).toEqual(["https://example.com/one", "https://example.com/two"]);
    for (const a of document.querySelectorAll<HTMLAnchorElement>("a")) {
      expect(a.getAttribute("href")?.startsWith("javascript:")).toBe(false);
    }
  });

  test("the streamed turn is persisted with thinking and sanitized sources", () => {
    const active = sessionStore.getActive();
    expect(active).not.toBeNull();
    expect(active?.title).toBe(PROMPT); // auto-titled from the first user message
    expect(active?.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    const assistant = active!.messages[1]!;
    expect(assistant.content).toBe(DELTA);
    expect(assistant.thinking).toBe(THINKING.trim());
    expect(assistant.sources?.map((s) => s.url)).toEqual([
      "https://example.com/one",
      "https://example.com/two",
    ]);

    // And the same data is what survived into localStorage.
    const saved = JSON.parse(localStorage.getItem("hideout.sessions") ?? "[]") as Array<{
      id: string;
      title: string;
      messages: Array<{ role: string; content: string; thinking?: string; sources?: Array<{ url: string }> }>;
    }>;
    const persisted = saved.find((s) => s.id === active!.id);
    expect(persisted?.messages.at(-1)?.content).toBe(DELTA);
    expect(persisted?.messages.at(-1)?.thinking).toBe(THINKING.trim());
  });
});
