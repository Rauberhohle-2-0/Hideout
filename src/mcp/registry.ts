/**
 * MCP Registry — CRUD + file persistence + SecureStore integration.
 *
 * File: ${storeDir}/mcp-servers.json  (0o600, dir 0o700)
 * Secrets: stored separately in SecureStore (OS keychain when available)
 *   — never in the JSON file (values appear as "***").
 *
 * Platform store dirs (resolved via shared/paths.ts):
 *   macOS:   ~/Library/Application Support/Hideout/mcp-servers.json
 *   Windows: %APPDATA%/Hideout/mcp-servers.json
 *   Linux:   $XDG_CONFIG_HOME/hideout/mcp-servers.json or ~/.config/hideout/mcp-servers.json
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Logger } from "../logger.ts";
import { McpConfigError, McpError } from "./errors.ts";
import type { McpServerConfig, McpServerSafe, McpServerStatus } from "./types.ts";
import { validateMcpServerConfig } from "./validation.ts";
import { splitSecrets, storeSecrets, deleteSecretsForServer, hydrateSecrets, toSafeConfig } from "./secure-helpers.ts";
import type { SecureStore } from "../ai/secure-store.ts";
import { secureStore as defaultSecureStore, setStoreDir as setSecureStoreDir } from "../ai/secure-store.ts";
import { getMcpStoreDir, getLegacyHideoutDir } from "../shared/paths.ts";

const logger = new Logger({ prefix: "mcp-registry" });

function getStoreDir(): string {
  return getMcpStoreDir();
}

let overrideDir: string | null = null;

export function setMcpStoreDir(dir: string): void {
  overrideDir = dir;
  // also set secure-store dir so secrets co-locate (optional)
  // we don't override global secureStore dir unconditionally; caller can set both if needed
}

function resolveStoreDir(): string {
  return overrideDir ?? getStoreDir();
}

function storeFilePath(): string {
  return path.join(resolveStoreDir(), "mcp-servers.json");
}

function ensureDir(): void {
  const dir = resolveStoreDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch (err) {
    // Windows ignores chmod; anything else is worth knowing about.
    logger.debug(`chmod failed on ${dir}: ${(err as Error).message}`);
  }
}

function parseStoreContent(raw: string): Record<string, McpServerConfig> {
  const parsed = JSON.parse(raw) as unknown;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    if ("servers" in (parsed as Record<string, unknown>) && Array.isArray((parsed as Record<string, unknown>).servers)) {
      const arr = (parsed as { servers: McpServerConfig[] }).servers;
      const map: Record<string, McpServerConfig> = {};
      for (const s of arr) if (s?.id) map[s.id] = s;
      return map;
    }
    return parsed as Record<string, McpServerConfig>;
  }
  return {};
}

function readLegacyFileStore(): Record<string, McpServerConfig> | null {
  const usingDefaultDir = !process.env.HIDEOUT_MCP_STORE_DIR && !process.env.HIDEOUT_SECURE_STORE_DIR && !overrideDir;
  if (!usingDefaultDir) return null;
  const legacyFp = path.join(getLegacyHideoutDir(), "mcp-servers.json");
  if (!fs.existsSync(legacyFp)) return null;
  try {
    const raw = fs.readFileSync(legacyFp, "utf-8");
    return parseStoreContent(raw);
  } catch {
    return null;
  }
}

function readFileStore(): Record<string, McpServerConfig> {
  const fp = storeFilePath();
  if (fs.existsSync(fp)) {
    try {
      const raw = fs.readFileSync(fp, "utf-8");
      return parseStoreContent(raw);
    } catch (err) {
      logger.warn(`Failed to read MCP store file: ${(err as Error).message}`);
      return {};
    }
  }
  const legacy = readLegacyFileStore();
  if (legacy) {
    logger.info(`Migrating MCP servers from legacy store: ${path.join(getLegacyHideoutDir(), "mcp-servers.json")}`);
    return legacy;
  }
  return {};
}

function writeFileStore(data: Record<string, McpServerConfig>): void {
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

/**
 * In-memory fallback for tests already handled via file with tmp dir.
 * This class is the main persistence + secrets layer.
 */
export class McpRegistry {
  private cache: Map<string, McpServerConfig> | null = null;

  constructor(private store: SecureStore = defaultSecureStore) {}

  /** For tests: inject store dir override */
  static withDir(dir: string, store?: SecureStore): McpRegistry {
    const r = new McpRegistry(store);
    // set override for this instance via closure — we use global overrideDir for simplicity
    // but tests should use HIDEOUT_MCP_STORE_DIR env
    setMcpStoreDir(dir);
    return r;
  }

  private loadCache(): Map<string, McpServerConfig> {
    if (this.cache) return this.cache;
    const data = readFileStore();
    this.cache = new Map(Object.entries(data));
    return this.cache;
  }

  private flushCache(): void {
    if (!this.cache) return;
    const obj: Record<string, McpServerConfig> = {};
    for (const [k, v] of this.cache.entries()) obj[k] = v;
    writeFileStore(obj);
  }

  /** List safe configs (secrets redacted) */
  listSafe(): McpServerSafe[] {
    const m = this.loadCache();
    return [...m.values()].map(toSafeConfig);
  }

  /** List full configs without hydrating secrets (plain stored) */
  listPlain(): McpServerConfig[] {
    return [...this.loadCache().values()];
  }

  /** Get safe config by id */
  getSafe(id: string): McpServerSafe | undefined {
    const c = this.loadCache().get(id);
    return c ? toSafeConfig(c) : undefined;
  }

  getPlain(id: string): McpServerConfig | undefined {
    return this.loadCache().get(id);
  }

  /** Hydrated config with secrets from SecureStore */
  async getHydrated(id: string): Promise<McpServerConfig | undefined> {
    const plain = this.loadCache().get(id);
    if (!plain) return undefined;
    return hydrateSecrets(plain, this.store);
  }

  async add(config: McpServerConfig): Promise<McpServerSafe> {
    const v = validateMcpServerConfig(config);
    if (!v.valid) throw new McpConfigError(v.errors.join("; "));
    const sanitized = v.sanitized;

    const m = this.loadCache();
    if (m.has(sanitized.id)) throw new McpError(`MCP server already exists: ${sanitized.id}`, "ALREADY_EXISTS");

    const { plain, secrets } = splitSecrets(sanitized);
    // Store secrets first (fail fast)
    if (Object.keys(secrets).length > 0) {
      await storeSecrets(secrets, this.store).catch((err) => {
        throw new McpError(`Failed to store secrets: ${(err as Error).message}`, "STORE_ERROR", err);
      });
    }

    m.set(plain.id, plain);
    this.flushCache();
    logger.info(`Added MCP server: ${plain.id} (${plain.transport})`);
    return toSafeConfig(plain);
  }

  async upsert(config: McpServerConfig): Promise<McpServerSafe> {
    const v = validateMcpServerConfig(config);
    if (!v.valid) throw new McpConfigError(v.errors.join("; "));
    const sanitized = v.sanitized;

    const m = this.loadCache();
    const existing = m.get(sanitized.id);
    // If updating, delete old secrets that are no longer present? For simplicity we overwrite
    if (existing) {
      // delete old secrets that are being removed
      await deleteSecretsForServer(existing.id, existing, this.store).catch(() => {});
    }

    const { plain, secrets } = splitSecrets(sanitized);
    if (Object.keys(secrets).length > 0) {
      await storeSecrets(secrets, this.store);
    }
    m.set(plain.id, plain);
    this.flushCache();
    logger.info(`Upserted MCP server: ${plain.id}`);
    return toSafeConfig(plain);
  }

  async update(id: string, patch: Partial<McpServerConfig>): Promise<McpServerSafe> {
    const m = this.loadCache();
    const existing = m.get(id);
    if (!existing) throw new McpError(`MCP server not found: ${id}`, "NOT_FOUND");

    // Strip placeholder "***" values from patch — they mean "keep existing secret"
    const sanitizedPatch: Partial<McpServerConfig> = { ...patch };
    if (sanitizedPatch.stdio?.env) {
      const filtered: Record<string, string> = {};
      for (const [k, v] of Object.entries(sanitizedPatch.stdio.env)) {
        if (v === "***") continue;
        filtered[k] = v;
      }
      // If all were placeholders, omit env to preserve existing
      if (Object.keys(filtered).length === 0 && Object.keys(sanitizedPatch.stdio.env).length > 0) {
        const { env: _omit, ...restStdio } = sanitizedPatch.stdio;
        (sanitizedPatch as McpServerConfig).stdio = restStdio as McpServerConfig["stdio"];
        // patch had only placeholders -> treat as no env patch
        if (Object.keys(restStdio).length === 0) delete (sanitizedPatch as Record<string, unknown>).stdio;
        else sanitizedPatch.stdio = restStdio as McpServerConfig["stdio"];
      } else {
        sanitizedPatch.stdio = { ...sanitizedPatch.stdio, env: filtered };
      }
    }
    if (sanitizedPatch.http?.headers) {
      const filtered: Record<string, string> = {};
      for (const [k, v] of Object.entries(sanitizedPatch.http.headers)) {
        if (v === "***") continue;
        filtered[k] = v;
      }
      if (Object.keys(filtered).length === 0 && Object.keys(sanitizedPatch.http.headers).length > 0) {
        const { headers: _omit, ...restHttp } = sanitizedPatch.http;
        sanitizedPatch.http = restHttp as McpServerConfig["http"];
        if (Object.keys(restHttp).length === 0) delete (sanitizedPatch as Record<string, unknown>).http;
        else sanitizedPatch.http = restHttp as McpServerConfig["http"];
      } else {
        sanitizedPatch.http = { ...sanitizedPatch.http, headers: filtered };
      }
    }
    if (sanitizedPatch.sse?.headers) {
      const filtered: Record<string, string> = {};
      for (const [k, v] of Object.entries(sanitizedPatch.sse.headers)) {
        if (v === "***") continue;
        filtered[k] = v;
      }
      if (Object.keys(filtered).length === 0 && Object.keys(sanitizedPatch.sse.headers).length > 0) {
        const { headers: _omit, ...restSse } = sanitizedPatch.sse as unknown as Record<string, unknown>;
        (sanitizedPatch as Record<string, unknown>).sse = Object.keys(restSse).length ? restSse : undefined;
        if (!Object.keys(restSse).length) delete (sanitizedPatch as Record<string, unknown>).sse;
      } else if (sanitizedPatch.sse) {
        sanitizedPatch.sse = { ...sanitizedPatch.sse, headers: filtered };
      }
    }

    // Merge patch onto existing plain, then hydrate existing secrets so we don't lose them if patch omits env/headers
    const hydrated = await hydrateSecrets(existing, this.store);
    const merged: McpServerConfig = {
      ...hydrated,
      ...sanitizedPatch,
      id, // id immutable
      // Deep merge stdio/http (use sanitized patch)
      ...(sanitizedPatch.stdio
        ? {
            stdio: {
              ...hydrated.stdio,
              ...sanitizedPatch.stdio,
              env: { ...(hydrated.stdio?.env ?? {}), ...(sanitizedPatch.stdio.env ?? {}) },
            },
          }
        : {}),
      ...(sanitizedPatch.http
        ? {
            http: {
              ...hydrated.http,
              ...sanitizedPatch.http,
              headers: { ...(hydrated.http?.headers ?? {}), ...(sanitizedPatch.http.headers ?? {}) },
            },
          }
        : {}),
      ...(sanitizedPatch.sse
        ? {
            sse: {
              ...(hydrated.sse as unknown as Record<string, unknown>),
              ...sanitizedPatch.sse,
              headers: {
                ...((hydrated.sse?.headers ?? hydrated.http?.headers ?? {}) as Record<string, string>),
                ...(sanitizedPatch.sse.headers ?? {}),
              },
            } as McpServerConfig["sse"],
          }
        : {}),
    };

    const v = validateMcpServerConfig(merged);
    if (!v.valid) throw new McpConfigError(v.errors.join("; "));
    const sanitized = v.sanitized;

    // Remove old secrets for keys that were deleted
    await deleteSecretsForServer(id, existing, this.store).catch(() => {});
    const { plain, secrets } = splitSecrets(sanitized);
    if (Object.keys(secrets).length > 0) await storeSecrets(secrets, this.store);

    m.set(id, plain);
    this.flushCache();
    logger.info(`Updated MCP server: ${id}`);
    return toSafeConfig(plain);
  }

  async remove(id: string): Promise<void> {
    const m = this.loadCache();
    const existing = m.get(id);
    if (!existing) throw new McpError(`MCP server not found: ${id}`, "NOT_FOUND");

    await deleteSecretsForServer(id, existing, this.store).catch(() => {});
    // Also try to delete any header secrets that were stored (we don't know names if plain had "***")
    // Best-effort: iterate plain headers keys
    m.delete(id);
    this.flushCache();
    logger.info(`Removed MCP server: ${id}`);
  }

  async setEnabled(id: string, enabled: boolean): Promise<McpServerSafe> {
    if (typeof enabled !== "boolean") throw new McpConfigError("enabled must be boolean");
    const m = this.loadCache();
    const existing = m.get(id);
    if (!existing) throw new McpError(`MCP server not found: ${id}`, "NOT_FOUND");
    if ((existing.enabled ?? true) === enabled) return toSafeConfig(existing);
    const updated: McpServerConfig = { ...existing, enabled };
    // validate updated config (ensures other fields still valid)
    const v = validateMcpServerConfig(updated);
    if (!v.valid) throw new McpConfigError(v.errors.join("; "));
    const sanitized = v.sanitized;
    m.set(id, sanitized);
    this.flushCache();
    logger.info(`${enabled ? "Enabled" : "Disabled"} MCP server: ${id}`);
    return toSafeConfig(sanitized);
  }

  /** Clear all — for tests */
  clearAll(): void {
    this.cache = new Map();
    this.flushCache();
  }

  /** Hydrate all secrets (e.g. at startup) — returns hydrated list */
  async hydrateAll(): Promise<McpServerConfig[]> {
    const plains = this.listPlain();
    const out: McpServerConfig[] = [];
    for (const p of plains) {
      out.push(await hydrateSecrets(p, this.store));
    }
    return out;
  }

  /** Export store file path (for debugging) */
  getStoreFilePath(): string {
    return storeFilePath();
  }
}

// Singleton
let defaultRegistry: McpRegistry | null = null;

export function getDefaultMcpRegistry(): McpRegistry {
  if (!defaultRegistry) defaultRegistry = new McpRegistry();
  return defaultRegistry;
}

export function setDefaultMcpRegistry(registry: McpRegistry): void {
  defaultRegistry = registry;
}
