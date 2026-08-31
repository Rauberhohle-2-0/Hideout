/**
 * Chat Registry — CRUD + per-file JSON persistence.
 *
 * Each chat stored as its own file:
 *   ${storeDir}/chats/${id}.json  (0o600, dirs 0o700)
 *
 * Store dir resolved via shared/paths.ts (same base as assistants/servers):
 *   macOS:   ~/Library/Application Support/Hideout/chats/<id>.json
 *   Windows: %APPDATA%/Hideout/chats/<id>.json
 *   Linux:   $XDG_CONFIG_HOME/hideout/chats/<id>.json or ~/.config/hideout/chats/<id>.json
 *
 * `list()` sorts pinned chats first, then by most-recent update — the order
 * the chat sidebar wants, with no extra client sorting.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Logger } from "../logger.ts";
import { ChatError, ChatConfigError } from "./errors.ts";
import type { ChatConfig, ChatSafe } from "./types.ts";
import { validateChatConfig } from "./validation.ts";
import { getAssistantStoreDir } from "../shared/paths.ts";

const logger = new Logger({ prefix: "chat-registry" });

let overrideDir: string | null = null;

export function setChatStoreDir(dir: string | null): void {
  overrideDir = dir;
}

function resolveStoreDir(): string {
  return overrideDir ?? getAssistantStoreDir();
}

function chatsDirPath(): string {
  return path.join(resolveStoreDir(), "chats");
}

function chatFilePath(id: string): string {
  // id already validated by ID_RE — prevent any path traversal just in case
  if (id.includes("/") || id.includes("\\") || id.includes("\0")) {
    throw new ChatConfigError(`Invalid chat id for file path: ${id}`);
  }
  return path.join(chatsDirPath(), `${id}.json`);
}

function ensureChatsDir(): void {
  const base = resolveStoreDir();
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(base, 0o700);
  } catch (err) {
    logger.debug(`chmod failed on ${base}: ${(err as Error).message}`);
  }
  const dir = chatsDirPath();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch (err) {
    logger.debug(`chmod failed on ${dir}: ${(err as Error).message}`);
  }
}

function writeChatFile(id: string, data: ChatConfig): void {
  ensureChatsDir();
  const fp = chatFilePath(id);
  const tmp = `${fp}.tmp.${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {}
  fs.renameSync(tmp, fp);
  try {
    fs.chmodSync(fp, 0o600);
  } catch {}
}

function deleteChatFile(id: string): void {
  const fp = chatFilePath(id);
  if (fs.existsSync(fp)) {
    try {
      fs.unlinkSync(fp);
    } catch (err) {
      logger.warn(`Failed to delete chat file ${fp}: ${(err as Error).message}`);
    }
  }
}

function readPerFileStore(): Map<string, ChatConfig> {
  const dir = chatsDirPath();
  const map = new Map<string, ChatConfig>();
  if (!fs.existsSync(dir)) return map;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith(".json")) continue;
    const fp = path.join(dir, ent.name);
    try {
      const raw = fs.readFileSync(fp, "utf-8");
      const parsed = JSON.parse(raw) as ChatConfig;
      if (parsed && typeof parsed.id === "string" && parsed.id) {
        const v = validateChatConfig(parsed);
        if (!v.valid) {
          logger.warn(`Skipping invalid chat file ${ent.name}: ${v.errors.join("; ")}`);
          continue;
        }
        map.set(v.sanitized.id, v.sanitized);
      }
    } catch (err) {
      logger.warn(`Failed to read chat file ${ent.name}: ${(err as Error).message}`);
    }
  }
  return map;
}

function deriveTitle(messages: ChatConfig["messages"]): string {
  const firstUser = messages.find((m) => m.role === "user");
  const text = (firstUser?.content ?? "New chat").trim().replace(/\s+/g, " ");
  return text.length > 48 ? `${text.slice(0, 48).trimEnd()}…` : text || "New chat";
}

export class ChatRegistry {
  private cache: Map<string, ChatConfig> | null = null;

  private loadCache(): Map<string, ChatConfig> {
    if (this.cache) return this.cache;
    this.cache = readPerFileStore();
    return this.cache;
  }

  /** Pinned first, then most recently updated. */
  list(): ChatSafe[] {
    const all = [...this.loadCache().values()];
    all.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const at = a.updatedAt ?? a.createdAt ?? "";
      const bt = b.updatedAt ?? b.createdAt ?? "";
      return bt.localeCompare(at);
    });
    return all;
  }

  get(id: string): ChatSafe | undefined {
    return this.loadCache().get(id);
  }

  async add(config: Partial<ChatConfig> & { messages?: ChatConfig["messages"] }): Promise<ChatSafe> {
    const v = validateChatConfig({ ...config, id: config.id ?? "" });
    if (!v.valid) throw new ChatConfigError(v.errors.join("; "));
    let sanitized = v.sanitized;

    const m = this.loadCache();
    if (sanitized.id && m.has(sanitized.id)) {
      throw new ChatError(`Chat already exists: ${sanitized.id}`, "ALREADY_EXISTS");
    }

    const now = new Date().toISOString();
    sanitized = {
      ...sanitized,
      id: sanitized.id || crypto.randomUUID(),
      title: sanitized.title || deriveTitle(sanitized.messages),
      createdAt: now,
      updatedAt: now,
    };

    m.set(sanitized.id, sanitized);
    writeChatFile(sanitized.id, sanitized);
    logger.info(`Added chat: ${sanitized.id} (${sanitized.title}) -> ${chatFilePath(sanitized.id)}`);
    return sanitized;
  }

  async update(id: string, patch: Partial<ChatConfig>): Promise<ChatSafe> {
    const m = this.loadCache();
    const existing = m.get(id);
    if (!existing) throw new ChatError(`Chat not found: ${id}`, "NOT_FOUND");

    // id is immutable; never let a patch rewrite it
    const merged: ChatConfig = {
      ...existing,
      ...patch,
      id,
      messages: patch.messages ?? existing.messages,
      pinned: patch.pinned ?? existing.pinned,
    };

    const v = validateChatConfig(merged);
    if (!v.valid) throw new ChatConfigError(v.errors.join("; "));
    const sanitized = v.sanitized;
    sanitized.createdAt = existing.createdAt;
    sanitized.updatedAt = new Date().toISOString();
    if (!sanitized.title) sanitized.title = deriveTitle(sanitized.messages);

    m.set(id, sanitized);
    writeChatFile(id, sanitized);
    logger.info(`Updated chat: ${id}`);
    return sanitized;
  }

  async remove(id: string): Promise<void> {
    const m = this.loadCache();
    if (!m.has(id)) throw new ChatError(`Chat not found: ${id}`, "NOT_FOUND");
    m.delete(id);
    deleteChatFile(id);
    logger.info(`Removed chat: ${id}`);
  }

  async setPinned(id: string, pinned: boolean): Promise<ChatSafe> {
    if (typeof pinned !== "boolean") throw new ChatConfigError("pinned must be boolean");
    return this.update(id, { pinned });
  }

  /** Clear all — for tests */
  clearAll(): void {
    this.cache = new Map();
    const dir = chatsDirPath();
    if (fs.existsSync(dir)) {
      const entries = fs.readdirSync(dir);
      for (const name of entries) {
        if (!name.endsWith(".json")) continue;
        try {
          fs.unlinkSync(path.join(dir, name));
        } catch {}
      }
    }
  }

  /** Reload from disk (useful after external overrideDir change) */
  reload(): void {
    this.cache = null;
  }
}

// Singleton
let defaultRegistry: ChatRegistry | null = null;

export function getDefaultChatRegistry(): ChatRegistry {
  if (!defaultRegistry) defaultRegistry = new ChatRegistry();
  return defaultRegistry;
}

export function setDefaultChatRegistry(registry: ChatRegistry): void {
  defaultRegistry = registry;
}
