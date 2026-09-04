/**
 * Renderer boot tests — first launch with no saved chats.
 *
 * Boots `bootstrap.ts` against empty localStorage (no sessions, no active
 * id) and asserts the startup contract is unchanged: with no saved
 * conversation to resume, the app still creates the requested empty draft —
 * it becomes the active, persisted "New chat" row and the thread stays empty.
 */
import { describe, expect, test } from "bun:test";
import type { ChatSession } from "../src/shared/sessions.ts";
import { bootRenderer, FetchRouter, json } from "./dom-harness.ts";

const router = new FetchRouter().route("GET", /^\/api\/models$/, () => json({ models: [] }));

// No seed: fresh storage, privacy flag off.
await bootRenderer({ router });

const { sessionStore } = await import("../src/renderer/sessions.ts");

describe("first launch with an empty history", () => {
  test("boot creates one empty draft and makes it active", () => {
    expect(sessionStore.counts().total).toBe(1);
    const activeId = sessionStore.getActiveId();
    expect(activeId).not.toBeNull();
    const active = sessionStore.get(activeId!);
    expect(active?.title).toBe("New chat");
    expect(active?.messages).toEqual([]);
  });

  test("the draft renders as an empty thread and a sidebar row", () => {
    expect(document.querySelector("#chat-column")?.textContent?.trim()).toBe("");
    const activeId = sessionStore.getActiveId();
    const row = document.querySelector<HTMLElement>(`.session-row[data-session-id="${activeId}"]`);
    expect(row?.textContent).toContain("New chat");
    expect(row?.classList.contains("active")).toBe(true);
  });

  test("the draft is persisted so the next restart restores it", () => {
    const activeId = sessionStore.getActiveId();
    expect(activeId).not.toBeNull();
    expect(localStorage.getItem("hideout.activeSessionId")).toBe(activeId);
    const saved = JSON.parse(localStorage.getItem("hideout.sessions") ?? "[]") as ChatSession[];
    expect(saved.length).toBe(1);
    expect(saved[0]?.id).toBe(activeId!);
    expect(saved[0]?.title).toBe("New chat");
  });
});
