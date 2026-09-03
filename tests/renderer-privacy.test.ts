/**
 * Renderer boot tests — “Do not save chat history” privacy mode.
 *
 * Boots `bootstrap.ts` with a pre-saved conversation, then drives the
 * Settings toggle: enabling makes NEW chats ephemeral (kept only in memory,
 * never written to localStorage) while previously saved chats stay saved;
 * disabling restores persistence for later chats without resurrecting or
 * deleting anything. Asserts the toggle DOM, the localStorage flag, and what
 * the session store actually writes.
 */
import { describe, expect, test } from "bun:test";
import { bootRenderer, FetchRouter, flushTicks, json } from "./dom-harness.ts";

const SAVED_SESSION = [
  {
    id: "old-1",
    title: "Old saved chat",
    messages: [{ role: "user" as const, content: "hello" }],
    pinned: false,
    createdAt: 1000,
    updatedAt: 2000,
  },
];

const router = new FetchRouter()
  .route("GET", /^\/api\/models$/, () => json({ models: [] }))
  .route("GET", /^\/api\/credentials$/, () => json({ credentials: [] }));

await bootRenderer({
  router,
  seed: (storage) => {
    storage.setItem("hideout.sessions", JSON.stringify(SAVED_SESSION));
  },
});

const { sessionStore } = await import("../src/renderer/sessions.ts");
const { isEphemeralChatsEnabled } = await import("../src/renderer/privacy.ts");

function toggle(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>("#privacy-ephemeral-checkbox")!;
}

function stateNote(): HTMLElement | null {
  return document.querySelector<HTMLElement>("#privacy-state-note");
}

function storedSessions(): string | null {
  return window.localStorage.getItem("hideout.sessions");
}

async function openSettings(): Promise<void> {
  document.querySelector<HTMLButtonElement>("#settings-button")!.click();
  await flushTicks();
}

describe("Chat-history privacy mode", () => {
  test("toggle is off by default and previously saved chats remain stored", async () => {
    expect(isEphemeralChatsEnabled()).toBe(false);
    await openSettings();
    expect(toggle().checked).toBe(false);
    expect(stateNote()?.hidden).toBe(true);
    expect(storedSessions()).toContain("Old saved chat");
  });

  test("enabling makes new chats ephemeral without touching saved history", async () => {
    toggle().click(); // on
    await flushTicks();

    expect(toggle().checked).toBe(true);
    expect(stateNote()?.hidden).toBe(false);
    expect(stateNote()?.textContent).toContain("disappear when you close the window");
    expect(isEphemeralChatsEnabled()).toBe(true);
    // Previously saved history is not wiped.
    expect(storedSessions()).toContain("Old saved chat");

    // A chat started while the mode is on never reaches localStorage.
    const secret = sessionStore.create("Secret plan", [{ role: "user", content: "needle" }]);
    expect(sessionStore.isEphemeral(secret.id)).toBe(true);
    expect(storedSessions()).not.toContain("Secret plan");
    // And it is still fully usable in memory.
    expect(sessionStore.get(secret.id)?.title).toBe("Secret plan");
  });

  test("the ephemeral chat stays memory-only while history keeps working", async () => {
    // Existing session still updates persisted storage even in the mode.
    sessionStore.appendMessages("old-1", [{ role: "assistant", content: "reply" }]);
    const stored = storedSessions() ?? "";
    expect(stored).toContain("Old saved chat");
    expect(stored).not.toContain("Secret plan");
  });

  test("disabling restores persistence for later chats; ephemeral ones stay unsaved", async () => {
    toggle().click(); // off
    await flushTicks();

    expect(toggle().checked).toBe(false);
    expect(stateNote()?.hidden).toBe(true);
    expect(isEphemeralChatsEnabled()).toBe(false);

    const normal = sessionStore.create("Normal chat", [{ role: "user", content: "after" }]);
    expect(sessionStore.isEphemeral(normal.id)).toBe(false);
    const stored = storedSessions() ?? "";
    expect(stored).toContain("Normal chat");
    // The chat from the privacy period was never written and stays that way;
    // it only lives in memory until the window closes.
    expect(stored).not.toContain("Secret plan");
    expect(sessionStore.list().some((s) => s.title === "Secret plan")).toBe(true);
  });
});
