/**
 * Assistant Registry — CRUD + file persistence.
 * File: ${storeDir}/assistants.json  (0o600, dir 0o700)
 * No secrets — JSON stores plaintext assistant configs.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { Logger } from "../logger.ts";
import { AssistantError, AssistantConfigError } from "./errors.ts";
import type { AssistantConfig, AssistantSafe } from "./types.ts";
import { validateAssistantConfig } from "./validation.ts";

const logger = new Logger({ prefix: "assistant-registry" });

function getStoreDir(): string {
  if (process.env.HIDEOUT_ASSISTANT_STORE_DIR) return process.env.HIDEOUT_ASSISTANT_STORE_DIR;
  if (process.env.HIDEOUT_MCP_STORE_DIR) return process.env.HIDEOUT_MCP_STORE_DIR;
  if (process.env.HIDEOUT_SECURE_STORE_DIR) return process.env.HIDEOUT_SECURE_STORE_DIR;
  return path.join(os.homedir(), ".hideout");
}

let overrideDir: string | null = null;

export function setAssistantStoreDir(dir: string): void {
  overrideDir = dir;
}

function resolveStoreDir(): string {
  return overrideDir ?? getStoreDir();
}

function storeFilePath(): string {
  return path.join(resolveStoreDir(), "assistants.json");
}

function ensureDir(): void {
  const dir = resolveStoreDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {}
}

function readFileStore(): Record<string, AssistantConfig> {
  const fp = storeFilePath();
  if (!fs.existsSync(fp)) return {};
  try {
    const raw = fs.readFileSync(fp, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      // support both { id: config } map and { assistants: [] } shape
      if ("assistants" in (parsed as Record<string, unknown>) && Array.isArray((parsed as Record<string, unknown>).assistants)) {
        const arr = (parsed as { assistants: AssistantConfig[] }).assistants;
        const map: Record<string, AssistantConfig> = {};
        for (const a of arr) if (a?.id) map[a.id] = a;
        return map;
      }
      return parsed as Record<string, AssistantConfig>;
    }
    return {};
  } catch (err) {
    logger.warn(`Failed to read assistant store file: ${(err as Error).message}`);
    return {};
  }
}

function writeFileStore(data: Record<string, AssistantConfig>): void {
  ensureDir();
  const fp = storeFilePath();
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

export class AssistantRegistry {
  private cache: Map<string, AssistantConfig> | null = null;

  private loadCache(): Map<string, AssistantConfig> {
    if (this.cache) return this.cache;
    const data = readFileStore();
    this.cache = new Map(Object.entries(data));
    return this.cache;
  }

  private flushCache(): void {
    if (!this.cache) return;
    const obj: Record<string, AssistantConfig> = {};
    for (const [k, v] of this.cache.entries()) obj[k] = v;
    writeFileStore(obj);
  }

  list(): AssistantSafe[] {
    return [...this.loadCache().values()];
  }

  listEnabled(): AssistantSafe[] {
    return this.list().filter((a) => a.enabled !== false);
  }

  get(id: string): AssistantSafe | undefined {
    return this.loadCache().get(id);
  }

  has(id: string): boolean {
    return this.loadCache().has(id);
  }

  async add(config: AssistantConfig): Promise<AssistantSafe> {
    const v = validateAssistantConfig(config);
    if (!v.valid) throw new AssistantConfigError(v.errors.join("; "));
    const sanitized = v.sanitized!;

    const m = this.loadCache();
    if (m.has(sanitized.id)) throw new AssistantError(`Assistant already exists: ${sanitized.id}`, "ALREADY_EXISTS");

    const now = new Date().toISOString();
    sanitized.createdAt = now;
    sanitized.updatedAt = now;

    m.set(sanitized.id, sanitized);
    this.flushCache();
    logger.info(`Added assistant: ${sanitized.id} (${sanitized.name})`);
    return sanitized;
  }

  async upsert(config: AssistantConfig): Promise<AssistantSafe> {
    const v = validateAssistantConfig(config);
    if (!v.valid) throw new AssistantConfigError(v.errors.join("; "));
    const sanitized = v.sanitized!;

    const m = this.loadCache();
    const existing = m.get(sanitized.id);
    const now = new Date().toISOString();
    if (existing) {
      sanitized.createdAt = existing.createdAt ?? now;
      sanitized.updatedAt = now;
    } else {
      sanitized.createdAt = now;
      sanitized.updatedAt = now;
    }

    m.set(sanitized.id, sanitized);
    this.flushCache();
    logger.info(`Upserted assistant: ${sanitized.id}`);
    return sanitized;
  }

  async update(id: string, patch: Partial<AssistantConfig>): Promise<AssistantSafe> {
    const m = this.loadCache();
    const existing = m.get(id);
    if (!existing) throw new AssistantError(`Assistant not found: ${id}`, "NOT_FOUND");

    // id immutable
    const merged: AssistantConfig = {
      ...existing,
      ...patch,
      id,
      // deep merge parameters
      ...(patch.parameters
        ? { parameters: { ...(existing.parameters ?? {}), ...patch.parameters } }
        : {}),
    };

    // If patch explicitly removes description/emoji/providerId/model by setting empty string, treat accordingly
    // sanitize via validation will trim and omit empty optional fields — for updates we want to allow clearing
    // so we handle empty string as "delete key"
    if (patch.description !== undefined && patch.description === "") delete (merged as unknown as Record<string, unknown>).description;
    if (patch.emoji !== undefined && patch.emoji === "") delete (merged as unknown as Record<string, unknown>).emoji;
    if (patch.providerId !== undefined && patch.providerId === "") delete (merged as unknown as Record<string, unknown>).providerId;
    if (patch.model !== undefined && patch.model === "") delete (merged as unknown as Record<string, unknown>).model;

    const v = validateAssistantConfig(merged);
    if (!v.valid) throw new AssistantConfigError(v.errors.join("; "));
    const sanitized = v.sanitized!;
    sanitized.createdAt = existing.createdAt;
    sanitized.updatedAt = new Date().toISOString();

    // Preserve createdAt if patch tried to overwrite
    m.set(id, sanitized);
    this.flushCache();
    logger.info(`Updated assistant: ${id}`);
    return sanitized;
  }

  async remove(id: string): Promise<void> {
    const m = this.loadCache();
    if (!m.has(id)) throw new AssistantError(`Assistant not found: ${id}`, "NOT_FOUND");
    m.delete(id);
    this.flushCache();
    logger.info(`Removed assistant: ${id}`);
  }

  async setEnabled(id: string, enabled: boolean): Promise<AssistantSafe> {
    if (typeof enabled !== "boolean") throw new AssistantConfigError("enabled must be boolean");
    return this.update(id, { enabled });
  }

  /** Clear all — for tests */
  clearAll(): void {
    this.cache = new Map();
    this.flushCache();
  }

  getStoreFilePath(): string {
    return storeFilePath();
  }

  /** Reload from disk (useful after external overrideDir change) */
  reload(): void {
    this.cache = null;
  }
}

// Singleton
let defaultRegistry: AssistantRegistry | null = null;

export function getDefaultAssistantRegistry(): AssistantRegistry {
  if (!defaultRegistry) defaultRegistry = new AssistantRegistry();
  return defaultRegistry;
}

export function setDefaultAssistantRegistry(registry: AssistantRegistry): void {
  defaultRegistry = registry;
}
