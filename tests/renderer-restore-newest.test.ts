/**
 * Renderer boot tests — restoring the newest saved chat.
 *
 * Boots `bootstrap.ts` with saved sessions in localStorage but NO persisted
 * active id — the exact state `SessionStore` leaves behind when the last
 * active chat was ephemeral ("Do not save chat history" mode): ephemeral
 * sessions never reach storage, and `persist()` drops their active id. The
 * app must not auto-create an empty draft in that case; instead it resumes
 * the most recent saved conversation that actually has messages (message-less
 * drafts are skipped — there is nothing to resume), makes it the active
 * session (sidebar highlight + persisted active id), and renders its
 * messages into the chat thread.
 */
import { describe, expect, test } from "bun:test";
import type { ChatSession } from "../src/shared/sessions.ts";
import { bootRenderer, FetchRouter, json } from "./dom-harness.ts";

const EMPTY_DRAFT_ID = "sess-empty-draft";
const NEWEST_REAL_ID = "sess-newest-real";
const OLDER_ID = "sess-older";

function seed(storage: Storage): void {
  const emptyDraft: ChatSession = {
    id: EMPTY_DRAFT_ID,
    title: "New chat",
    pinned: false,
    createdAt: 6000,
    updatedAt: 6000,
    messages: [],
  };
  const newest: ChatSession = {
    id: NEWEST_REAL_ID,
    title: "Newest real chat",
    pinned: false,
    createdAt: 3000,
    updatedAt: 4000,
    messages: [
      { role: "user", content: "Newest question?" },
      { role: "assistant", content: "Newest answer." },
    ],
  };
  const older: ChatSession = {
    id: OLDER_ID,
    title: "Older chat",
    pinned: false,
    createdAt: 500,
    updatedAt: 1000,
    messages: [
      { role: "user", content: "Old question?" },
      { role: "assistant", content: "Old answer." },
    ],
  };
  storage.setItem("hideout.sessions", JSON.stringify([emptyDraft, newest, older]));
  // Deliberately NO hideout.activeSessionId — mirrors a privacy-mode shutdown
  // where the last active chat was ephemeral and never persisted.
}

const router = new FetchRouter().route("GET", /^\/api\/models$/, () => json({ models: [] }));

await bootRenderer({ seed, router });

const { sessionStore } = await import("../src/renderer/sessions.ts");

function userBubbleTexts(): string[] {
  return [...document.querySelectorAll<HTMLElement>(".user-message-bubble")].map((el) => el.textContent ?? "");
}

function answerTexts(): string[] {
  return [...document.querySelectorAll<HTMLElement>(".markdown-content")].map((el) => el.textContent ?? "");
}

describe("restoring the newest saved chat after a privacy-mode shutdown", () => {
  test("boot resumes the newest saved chat with messages, skipping the empty draft", () => {
    expect(sessionStore.getActiveId()).toBe(NEWEST_REAL_ID);
    expect(sessionStore.getActive()?.title).toBe("Newest real chat");
    // The resumed conversation is rendered, not an empty thread.
    expect(userBubbleTexts()).toEqual(["Newest question?"]);
    expect(answerTexts().join("\n")).toContain("Newest answer.");
  });

  test("the resumed chat is the highlighted sidebar row", () => {
    const newestRow = document.querySelector<HTMLElement>(`.session-row[data-session-id="${NEWEST_REAL_ID}"]`);
    const emptyRow = document.querySelector<HTMLElement>(`.session-row[data-session-id="${EMPTY_DRAFT_ID}"]`);
    const olderRow = document.querySelector<HTMLElement>(`.session-row[data-session-id="${OLDER_ID}"]`);
    expect(newestRow?.classList.contains("active")).toBe(true);
    expect(emptyRow?.classList.contains("active")).toBe(false);
    expect(olderRow?.classList.contains("active")).toBe(false);
  });

  test("no empty draft is created at boot, and the active id is persisted for the next restart", () => {
    expect(sessionStore.counts().total).toBe(3);
    expect(localStorage.getItem("hideout.activeSessionId")).toBe(NEWEST_REAL_ID);
  });
});
