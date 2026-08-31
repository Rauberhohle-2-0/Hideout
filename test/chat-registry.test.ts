import { test, expect, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ChatRegistry, setChatStoreDir, setDefaultChatRegistry } from "../src/chats/registry.ts";

const tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join("node_modules", ".hideout-chat-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
  setChatStoreDir(null);
  setDefaultChatRegistry(new ChatRegistry());
});

let currentDir: string | null = null;

function freshRegistry(): ChatRegistry {
  const dir = makeTmp();
  currentDir = dir;
  setChatStoreDir(dir);
  const registry = new ChatRegistry();
  setDefaultChatRegistry(registry);
  return registry;
}

function dirOf(_registry: ChatRegistry): string {
  return currentDir!;
}

test("add generates an id and derives the title from the first user message", async () => {
  const registry = freshRegistry();
  const chat = await registry.add({
    messages: [
      { role: "user", content: "How do I pin a chat in the sidebar?" },
      { role: "assistant", content: "Click the pin icon." },
    ],
  });

  expect(chat.id).toBeTruthy();
  expect(chat.pinned).toBe(false);
  expect(chat.title).toContain("How do I pin a chat");
  expect(chat.createdAt).toBeTruthy();
  expect(chat.updatedAt).toBeTruthy();

  // Persisted to disk under the store dir: ${dir}/chats/<id>.json
  const chatsDir = fs.readdirSync(path.join(dirOf(registry), "chats"));
  expect(chatsDir).toContain(`${chat.id}.json`);
});

test("list sorts pinned chats first, then by most recent update", async () => {
  const registry = freshRegistry();
  const first = await registry.add({ messages: [{ role: "user", content: "first" }] });
  const second = await registry.add({ messages: [{ role: "user", content: "second" }] });

  // Pin the older one — it must move to the top despite the newer timestamps.
  await registry.setPinned(first.id, true);
  await registry.update(second.id, { title: "second renamed" });

  const ids = registry.list().map((c) => c.id);
  expect(ids[0]).toBe(first.id);
  expect(ids[1]).toBe(second.id);
});

test("update appends messages and touches updatedAt", async () => {
  const registry = freshRegistry();
  const chat = await registry.add({ messages: [{ role: "user", content: "hi" }] });
  const before = chat.updatedAt;

  await new Promise((r) => setTimeout(r, 5));
  const updated = await registry.update(chat.id, {
    messages: [
      ...chat.messages,
      { role: "assistant", content: "hello!" },
    ],
  });

  expect(updated.messages).toHaveLength(2);
  expect(updated.messages[1]!.content).toBe("hello!");
  expect(updated.updatedAt).not.toBe(before);
});

test("remove deletes the chat; unknown id throws NOT_FOUND", async () => {
  const registry = freshRegistry();
  const chat = await registry.add({ messages: [{ role: "user", content: "hi" }] });
  await registry.remove(chat.id);
  expect(registry.get(chat.id)).toBeUndefined();

  expect(registry.remove(chat.id)).rejects.toThrow("not found");
});

test("config validation rejects bad roles and oversized content", async () => {
  const registry = freshRegistry();
  await expect(
    registry.add({ messages: [{ role: "system", content: "nope" }] }),
  ).rejects.toThrow();

  await expect(
    registry.add({ messages: [{ role: "user", content: "x".repeat(200_000) }] }),
  ).rejects.toThrow();
});
