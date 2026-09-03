/**
 * Renderer boot tests — session restore.
 *
 * Boots `bootstrap.ts` against a happy-dom window seeded with persisted
 * sessions in localStorage and asserts the startup contract: the active
 * conversation is re-rendered into the chat thread (user bubbles, persisted
 * assistant turns with their Reasoning + Sources pills), the sidebar groups
 * rows by pinned/recent with the active row highlighted, switching sessions
 * re-renders from the store, and “New chat” creates an empty draft.
 */
import { describe, expect, test } from "bun:test";
import type { ChatSession } from "../src/shared/sessions.ts";
import { bootRenderer, FetchRouter, flushTicks, json } from "./dom-harness.ts";

const PINNED_ID = "sess-pinned";
const RECENT_ID = "sess-recent";

function seedSessions(storage: Storage): void {
  const pinned: ChatSession = {
    id: PINNED_ID,
    title: "Pinned chat",
    pinned: true,
    createdAt: 1000,
    updatedAt: 3000,
    messages: [
      { role: "user", content: "How does pinning work?" },
      {
        role: "assistant",
        content: "Pinning keeps a chat at the top of the sidebar.",
        thinking: "Short answer: pin = sort to top.\n\nIt also survives restarts.",
        sources: [
          { url: "https://example.com/pinning", title: "Pinning docs" },
          { url: "https://example.com/faq", title: "FAQ" },
        ],
      },
    ],
  };
  const recent: ChatSession = {
    id: RECENT_ID,
    title: "Session basics",
    pinned: false,
    createdAt: 500,
    updatedAt: 2000,
    messages: [
      { role: "user", content: "What is a session?" },
      { role: "assistant", content: "A session is one conversation between you and a model." },
    ],
  };
  storage.setItem("hideout.sessions", JSON.stringify([pinned, recent]));
  storage.setItem("hideout.activeSessionId", PINNED_ID);
}

const router = new FetchRouter().route("GET", /^\/api\/models$/, () => json({ models: [] }));

await bootRenderer({ seed: seedSessions, router });

// Same module instance the bootstrap imported (evaluated after the globals
// were installed above).
const { sessionStore } = await import("../src/renderer/sessions.ts");

function userBubbleTexts(): string[] {
  return [...document.querySelectorAll<HTMLElement>(".user-message-bubble")].map((el) => el.textContent ?? "");
}

function answerTexts(): string[] {
  return [...document.querySelectorAll<HTMLElement>(".markdown-content")].map((el) => el.textContent ?? "");
}

describe("session restore", () => {
  test("boot renders the active session's messages into the chat thread", () => {
    expect(sessionStore.getActiveId()).toBe(PINNED_ID);
    expect(userBubbleTexts()).toEqual(["How does pinning work?"]);
    expect(answerTexts().join("\n")).toContain("Pinning keeps a chat at the top of the sidebar.");
  });

  test("persisted assistant turns carry their Reasoning and Sources pills", () => {
    const reasoning = document.querySelector<HTMLElement>(".reasoning-pill");
    expect(reasoning).not.toBeNull();
    expect(reasoning?.getAttribute("aria-label")).toBe("Reasoning");

    const sources = document.querySelector<HTMLElement>(".sources-pill:not(.reasoning-pill)");
    expect(sources?.getAttribute("aria-label")).toBe("2 sources — click to expand");

    // Expanding the reasoning panel shows the stored thinking steps + Done row.
    reasoning?.click();
    const steps = [...document.querySelectorAll<HTMLElement>(".reasoning-step")].map((el) => el.textContent);
    expect(steps).toContain("Short answer: pin = sort to top.");
    expect(document.querySelector(".reasoning-done")?.textContent).toContain("Done");

    // Expanding the sources pill lists one anchor per stored source.
    sources?.click();
    const links = [...document.querySelectorAll<HTMLAnchorElement>(".sources-panel .sources-item")];
    expect(links.map((a) => a.href)).toEqual([
      "https://example.com/pinning",
      "https://example.com/faq",
    ]);
  });

  test("sidebar groups sessions into pinned and recent, active row highlighted", () => {
    const pinnedRow = document.querySelector<HTMLElement>(`.session-row[data-session-id="${PINNED_ID}"]`);
    const recentRow = document.querySelector<HTMLElement>(`#chats-list .session-row[data-session-id="${RECENT_ID}"]`);
    expect(pinnedRow?.parentElement?.id).toBe("pinned-list");
    expect(pinnedRow?.classList.contains("active")).toBe(true);
    expect(pinnedRow?.textContent).toContain("Pinned chat");
    expect(recentRow?.parentElement?.id).toBe("chats-list");
    expect(recentRow?.classList.contains("active")).toBe(false);
  });

  test("clicking a sidebar row switches the thread to that session", () => {
    const row = document.querySelector<HTMLElement>(`#chats-list .session-row[data-session-id="${RECENT_ID}"]`);
    expect(row).not.toBeNull();
    row?.click();

    expect(sessionStore.getActiveId()).toBe(RECENT_ID);
    expect(userBubbleTexts()).toEqual(["What is a session?"]);
    expect(answerTexts().join("\n")).toContain("A session is one conversation");
    const active = document.querySelector<HTMLElement>(`.session-row[data-session-id="${RECENT_ID}"]`);
    expect(active?.classList.contains("active")).toBe(true);
  });

  test("New chat creates an empty draft, clears the thread and persists it", async () => {
    const before = sessionStore.counts().total;
    document.querySelector<HTMLButtonElement>("#new-chat-button")?.click();

    const activeId = sessionStore.getActiveId();
    expect(activeId).not.toBeNull();
    const active = sessionStore.get(activeId!);
    expect(active?.messages).toEqual([]);
    expect(sessionStore.counts().total).toBe(before + 1);

    // Thread cleared for the empty draft.
    expect(userBubbleTexts()).toEqual([]);
    expect(document.querySelector("#chat-column")?.textContent?.trim()).toBe("");

    // The new row appears in the sidebar as an untitled draft.
    const row = document.querySelector<HTMLElement>(`.session-row[data-session-id="${activeId}"]`);
    expect(row?.textContent).toContain("New chat");

    // And the draft is persisted (2 seeded + 1 new).
    const saved = JSON.parse(localStorage.getItem("hideout.sessions") ?? "[]") as ChatSession[];
    expect(saved.length).toBe(3);
    expect(saved.find((s) => s.id === activeId)?.title).toBe("New chat");
    await flushTicks();
  });
});
