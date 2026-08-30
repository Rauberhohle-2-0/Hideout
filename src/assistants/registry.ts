/**
 * Assistant Registry — CRUD + per-file JSON persistence.
 *
 * Each assistant stored as its own file:
 *   ${storeDir}/assistants/${id}.json  (0o600, dirs 0o700)
 * Example: "gary" -> .../assistants/gary.json
 *
 * Platform store dirs (mirrors Electron app.getPath("userData")):
 *   macOS:   ~/Library/Application Support/Hideout/assistants/<id>.json
 *   Windows: %APPDATA%/Hideout/assistants/<id>.json  (e.g. C:\Users\<user>\AppData\Roaming\Hideout)
 *   Linux:   $XDG_CONFIG_HOME/hideout/assistants/<id>.json or ~/.config/hideout/assistants/<id>.json
 *
 * Legacy (auto-migrated on first load if per-file store empty):
 *   ${storeDir}/assistants.json (single map file, platform-specific)
 *   ~/.hideout/assistants.json (pre-platform migration)
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Logger } from "../logger.ts";
import { AssistantError, AssistantConfigError } from "./errors.ts";
import type { AssistantConfig, AssistantSafe } from "./types.ts";
import { validateAssistantConfig } from "./validation.ts";
import { getAssistantStoreDir, getLegacyHideoutDir } from "../shared/paths.ts";

const logger = new Logger({ prefix: "assistant-registry" });

function getStoreDir(): string {
  return getAssistantStoreDir();
}

let overrideDir: string | null = null;

export function setAssistantStoreDir(dir: string): void {
  overrideDir = dir;
}

function resolveStoreDir(): string {
  return overrideDir ?? getStoreDir();
}

function assistantsDirPath(): string {
  return path.join(resolveStoreDir(), "assistants");
}

function assistantFilePath(id: string): string {
  // id already validated by ID_RE (alphanumeric + ._-) — safe as filename
  // Prevent any path traversal just in case
  if (id.includes("/") || id.includes("\\") || id.includes("\0")) {
    throw new AssistantConfigError(`Invalid assistant id for file path: ${id}`);
  }
  return path.join(assistantsDirPath(), `${id}.json`);
}

function ensureAssistantsDir(): void {
  const base = resolveStoreDir();
  // ensure base exists (for legacy single-file cleanup, but harmless)
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(base, 0o700);
  } catch {}
  const dir = assistantsDirPath();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {}
}

function isUsingDefaultDir(): boolean {
  return (
    !process.env.HIDEOUT_ASSISTANT_STORE_DIR &&
    !process.env.HIDEOUT_MCP_STORE_DIR &&
    !process.env.HIDEOUT_SECURE_STORE_DIR &&
    !overrideDir
  );
}

function parseSingleFileContent(raw: string): Record<string, AssistantConfig> {
  const parsed = JSON.parse(raw) as unknown;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    if ("assistants" in (parsed as Record<string, unknown>) && Array.isArray((parsed as Record<string, unknown>).assistants)) {
      const arr = (parsed as { assistants: AssistantConfig[] }).assistants;
      const map: Record<string, AssistantConfig> = {};
      for (const a of arr) if (a?.id) map[a.id] = a;
      return map;
    }
    return parsed as Record<string, AssistantConfig>;
  }
  return {};
}

function readSingleFileAt(fp: string): Record<string, AssistantConfig> | null {
  if (!fs.existsSync(fp)) return null;
  try {
    const raw = fs.readFileSync(fp, "utf-8");
    return parseSingleFileContent(raw);
  } catch (err) {
    logger.warn(`Failed to read legacy single file ${fp}: ${(err as Error).message}`);
    return null;
  }
}

function writeAssistantFile(id: string, data: AssistantConfig): void {
  ensureAssistantsDir();
  const fp = assistantFilePath(id);
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

function deleteAssistantFile(id: string): void {
  const fp = assistantFilePath(id);
  if (fs.existsSync(fp)) {
    try {
      fs.unlinkSync(fp);
    } catch (err) {
      logger.warn(`Failed to delete assistant file ${fp}: ${(err as Error).message}`);
    }
  }
}

function readPerFileStore(): Record<string, AssistantConfig> {
  const dir = assistantsDirPath();
  if (!fs.existsSync(dir)) return {};
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const map: Record<string, AssistantConfig> = {};
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith(".json")) continue;
    const fp = path.join(dir, ent.name);
    try {
      const raw = fs.readFileSync(fp, "utf-8");
      const parsed = JSON.parse(raw) as AssistantConfig;
      if (parsed && typeof parsed.id === "string" && parsed.id) {
        // Optional: validate, skip invalid
        const v = validateAssistantConfig(parsed);
        if (!v.valid) {
          logger.warn(`Skipping invalid assistant file ${ent.name}: ${v.errors.join("; ")}`);
          continue;
        }
        // Use sanitized or original? Use sanitized to normalize
        const cfg = v.sanitized ?? parsed;
        map[cfg.id] = cfg;
      }
    } catch (err) {
      logger.warn(`Failed to read assistant file ${ent.name}: ${(err as Error).message}`);
    }
  }
  return map;
}

function migrateSingleFileIfNeeded(): Record<string, AssistantConfig> | null {
  // Check per-file store first — if it has any files, no migration needed
  const perFile = readPerFileStore();
  if (Object.keys(perFile).length > 0) return perFile;

  // Try single file at current storeDir/assistants.json (previous location)
  const singleFp = path.join(resolveStoreDir(), "assistants.json");
  let legacyMap = readSingleFileAt(singleFp);
  let migratedFrom: string | null = null;
  if (legacyMap && Object.keys(legacyMap).length > 0) {
    migratedFrom = singleFp;
  } else if (isUsingDefaultDir()) {
    const legacyHideoutFp = path.join(getLegacyHideoutDir(), "assistants.json");
    const m2 = readSingleFileAt(legacyHideoutFp);
    if (m2 && Object.keys(m2).length > 0) {
      legacyMap = m2;
      migratedFrom = legacyHideoutFp;
    }
  }

  if (legacyMap && migratedFrom && Object.keys(legacyMap).length > 0) {
    logger.info(`Migrating assistants from legacy single file: ${migratedFrom} -> ${assistantsDirPath()}/<id>.json`);
    // Write each entry as per-file
    for (const [id, cfg] of Object.entries(legacyMap)) {
      try {
        // Ensure config is validated/sanitized before writing
        const v = validateAssistantConfig(cfg);
        const toWrite = v.valid && v.sanitized ? v.sanitized : cfg;
        // Ensure id matches key (defensive)
        if (toWrite.id !== id) toWrite.id = id;
        writeAssistantFile(toWrite.id, toWrite);
      } catch (err) {
        logger.warn(`Failed to migrate assistant ${id}: ${(err as Error).message}`);
      }
    }
    // Best-effort: remove or archive legacy single file after successful migration
    try {
      // Keep a backup instead of deleting outright — rename to .migrated
      const backup = `${migratedFrom}.migrated.${Date.now()}`;
      fs.renameSync(migratedFrom, backup);
      logger.info(`Archived legacy file to ${backup}`);
    } catch {
      // If rename fails, try unlink
      try {
        fs.unlinkSync(migratedFrom);
      } catch {}
    }
    return legacyMap;
  }

  return null;
}

function readFileStore(): Record<string, AssistantConfig> {
  // Prefer per-file store; migrate if needed
  const migrated = migrateSingleFileIfNeeded();
  if (migrated) return migrated;

  // Otherwise just read per-file
  return readPerFileStore();
}

export class AssistantRegistry {
  private cache: Map<string, AssistantConfig> | null = null;

  private loadCache(): Map<string, AssistantConfig> {
    if (this.cache) return this.cache;
    const data = readFileStore();
    this.cache = new Map(Object.entries(data));
    return this.cache;
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
    writeAssistantFile(sanitized.id, sanitized);
    logger.info(`Added assistant: ${sanitized.id} (${sanitized.name}) -> ${assistantFilePath(sanitized.id)}`);
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
    writeAssistantFile(sanitized.id, sanitized);
    logger.info(`Upserted assistant: ${sanitized.id} -> ${assistantFilePath(sanitized.id)}`);
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
    writeAssistantFile(id, sanitized);
    logger.info(`Updated assistant: ${id}`);
    return sanitized;
  }

  async remove(id: string): Promise<void> {
    const m = this.loadCache();
    if (!m.has(id)) throw new AssistantError(`Assistant not found: ${id}`, "NOT_FOUND");
    m.delete(id);
    deleteAssistantFile(id);
    logger.info(`Removed assistant: ${id}`);
  }

  async setEnabled(id: string, enabled: boolean): Promise<AssistantSafe> {
    if (typeof enabled !== "boolean") throw new AssistantConfigError("enabled must be boolean");
    return this.update(id, { enabled });
  }

  /** Clear all — for tests */
  clearAll(): void {
    const dir = assistantsDirPath();
    // Clear in-memory cache first
    this.cache = new Map();
    // Delete all per-file JSONs in assistants dir
    if (fs.existsSync(dir)) {
      const entries = fs.readdirSync(dir);
      for (const name of entries) {
        if (!name.endsWith(".json")) continue;
        try {
          fs.unlinkSync(path.join(dir, name));
        } catch {}
      }
    }
    // Also clean up legacy single files if present (test overrides may have created them)
    const singleFp = path.join(resolveStoreDir(), "assistants.json");
    if (fs.existsSync(singleFp)) {
      try {
        fs.unlinkSync(singleFp);
      } catch {}
    }
    if (isUsingDefaultDir()) {
      const legacyFp = path.join(getLegacyHideoutDir(), "assistants.json");
      if (fs.existsSync(legacyFp)) {
        try {
          fs.unlinkSync(legacyFp);
        } catch {}
      }
    }
  }

  /** Returns the assistants folder path (e.g. .../Hideout/assistants) */
  getAssistantsDirPath(): string {
    return assistantsDirPath();
  }

  /** Returns file path for a specific assistant (e.g. .../assistants/gary.json) */
  getAssistantFilePath(id: string): string {
    return assistantFilePath(id);
  }

  /** Deprecated: returns assistants dir for backward compat (old single file was .../assistants.json) */
  getStoreFilePath(): string {
    return assistantsDirPath();
  }

  /** Legacy alias — returns assistants dir */
  getStoreDirPath(): string {
    return resolveStoreDir();
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
