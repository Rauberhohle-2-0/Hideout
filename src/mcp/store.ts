/**
 * Persistence for MCP server configs.
 *
 * User-configured servers live in a single JSON file under the current
 * user's application-data directory — never inside the repository:
 *
 *   macOS:   ~/Library/Application Support/Hideout/MCP/mcp-servers.json
 *   Windows: %APPDATA%/Hideout/MCP/mcp-servers.json
 *   Linux:   $XDG_DATA_HOME/Hideout/MCP/mcp-servers.json
 *            (~/.local/share/Hideout/MCP/mcp-servers.json when unset)
 *
 * Two implementations:
 * - `MemoryMcpStore` — for tests / ephemeral use.
 * - `FileMcpStore`   — JSON file on disk. Falls back to memory when the
 *   file cannot be written.
 *
 * The store holds only user configs. Code-owned built-in servers (Exa) are
 * defined in code (`createExaMcpServer`) and are never persisted here; the
 * reserved `exa` id is filtered out on load and during legacy migration.
 *
 * Upgrades from the old project-local `data/mcp-servers.json` are migrated
 * once: valid non-Exa entries are imported into the user file and the legacy
 * file is left untouched for recovery.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { McpServerConfig } from "../shared/mcp.ts";
import { EXA_SERVER_ID, normalizeMcpServerConfig, validateMcpServerConfig } from "../shared/mcp.ts";

export interface McpStore {
  list(): Promise<McpServerConfig[]>;
  get(id: string): Promise<McpServerConfig | null>;
  set(config: McpServerConfig): Promise<void>;
  delete(id: string): Promise<boolean>;
  clear(): Promise<void>;
}

export class MemoryMcpStore implements McpStore {
  private readonly map = new Map<string, McpServerConfig>();

  async list(): Promise<McpServerConfig[]> {
    return [...this.map.values()].map((c) => {
      const copy = { ...c } as McpServerConfig;
      if (c.transport === "http" || c.transport === "sse") {
        const h = (c as { headers?: Record<string, string> }).headers;
        if (h) (copy as unknown as { headers: Record<string, string> }).headers = { ...h };
      }
      if (c.transport === "stdio") {
        const env = (c as { env?: Record<string, string> }).env;
        if (env) (copy as unknown as { env: Record<string, string> }).env = { ...env };
      }
      return copy;
    });
  }

  async get(id: string): Promise<McpServerConfig | null> {
    const v = this.map.get(id);
    if (!v) return null;
    return { ...v } as McpServerConfig;
  }

  async set(config: McpServerConfig): Promise<void> {
    const normalized = normalizeMcpServerConfig(config);
    this.map.set(normalized.id, normalized);
  }

  async delete(id: string): Promise<boolean> {
    return this.map.delete(id);
  }

  async clear(): Promise<void> {
    this.map.clear();
  }

  /** Test helper — seed directly. */
  seed(configs: McpServerConfig[]): void {
    for (const c of configs) this.map.set(c.id, normalizeMcpServerConfig(c));
  }
}

// ── User-data path resolution ───────────────────────────────────────────

export type McpDataEnv = Record<string, string | undefined>;

export type ResolveMcpDataOptions = {
  /** Override the platform (tests). Defaults to `process.platform`. */
  platform?: string;
  /** Override the environment (tests). Defaults to `process.env`. */
  env?: McpDataEnv;
};

const APP_DATA_DIR_NAME = "Hideout";
const MCP_DATA_DIR_NAME = "MCP";
const MCP_DATA_FILE_NAME = "mcp-servers.json";

/** Directory holding user MCP data, or null when no user dir can be determined. */
export function resolveMcpDataDir(opts: ResolveMcpDataOptions = {}): string | null {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? (process.env as McpDataEnv);
  let base: string | null = null;
  if (platform === "darwin") {
    const home = env.HOME;
    if (home) base = `${home}/Library/Application Support`;
  } else if (platform === "win32") {
    const appData = env.APPDATA;
    if (appData) base = appData.replace(/[\\/]+$/, "");
  } else if (platform === "linux") {
    const xdg = env.XDG_DATA_HOME;
    const home = env.HOME;
    if (xdg) base = xdg.replace(/[\\/]+$/, "");
    else if (home) base = `${home}/.local/share`;
  }
  if (!base) return null;
  return `${base}/${APP_DATA_DIR_NAME}/${MCP_DATA_DIR_NAME}`;
}

/** Path of the user-owned MCP config file, or null when no user dir exists. */
export function resolveMcpDataFile(opts: ResolveMcpDataOptions = {}): string | null {
  const dir = resolveMcpDataDir(opts);
  return dir ? `${dir}/${MCP_DATA_FILE_NAME}` : null;
}

/** Legacy project-local location used before user-data storage (dev checkouts). */
export function legacyMcpDataFile(): string {
  return `${process.cwd()}/data/mcp-servers.json`;
}

// ── File-backed store ────────────────────────────────────────────────────

export class FileMcpStore implements McpStore {
  private readonly filePath: string;
  private readonly legacyPath?: string;
  private readonly memory = new MemoryMcpStore();
  private loaded = false;

  /**
   * @param filePath   Path of the user-owned MCP config file.
   * @param legacyPath Optional legacy file migrated from once when `filePath`
   *                   does not exist yet.
   */
  constructor(filePath: string, legacyPath?: string) {
    this.filePath = filePath;
    this.legacyPath = legacyPath;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await this.readArray(this.filePath);
      if (raw) {
        const added = await this.importEntries(raw);
        // Clean stale built-in / invalid entries out of the user file.
        if (added < raw.length) await this.persist();
        return;
      }
      if (this.legacyPath) {
        const legacy = await this.readArray(this.legacyPath);
        if (legacy && legacy.length > 0) {
          await this.importEntries(legacy);
          // Write the migrated custom servers to the user file so the legacy
          // file is only ever read once.
          await this.persist();
        }
      }
    } catch {
      // Ignore corrupt file — start empty.
    }
  }

  /** Read a JSON array, returning null for missing/unreadable files. */
  private async readArray(path: string): Promise<unknown[] | null> {
    try {
      const text = await readFile(path, "utf8");
      const parsed = JSON.parse(text) as unknown;
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /** True for entries that must never come from disk: built-in Exa or `builtIn` flags. */
  private isSkippable(entry: unknown): boolean {
    if (typeof entry !== "object" || entry === null) return false;
    const r = entry as { id?: unknown; builtIn?: unknown };
    return r.id === EXA_SERVER_ID || r.builtIn === true;
  }

  /** Import valid user configs, discarding built-ins and malformed entries. Returns count added. */
  private async importEntries(raw: unknown[]): Promise<number> {
    let added = 0;
    for (const entry of raw) {
      if (this.isSkippable(entry)) continue;
      if (validateMcpServerConfig(entry) !== null) continue;
      try {
        await this.memory.set(entry as McpServerConfig);
        added++;
      } catch {}
    }
    return added;
  }

  private async persist(): Promise<void> {
    try {
      const list = await this.memory.list();
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, JSON.stringify(list, null, 2));
    } catch {
      // Best-effort; ignore write failures (e.g. read-only FS).
    }
  }

  async list(): Promise<McpServerConfig[]> {
    await this.ensureLoaded();
    return this.memory.list();
  }

  async get(id: string): Promise<McpServerConfig | null> {
    await this.ensureLoaded();
    return this.memory.get(id);
  }

  async set(config: McpServerConfig): Promise<void> {
    await this.ensureLoaded();
    await this.memory.set(config);
    await this.persist();
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const ok = await this.memory.delete(id);
    if (ok) await this.persist();
    return ok;
  }

  async clear(): Promise<void> {
    await this.ensureLoaded();
    await this.memory.clear();
    await this.persist();
  }
}

/**
 * Preferred store for the sidecar: a JSON file in the current user's
 * application-data directory. Falls back to memory when no user directory
 * can be resolved (e.g. unusual environments / tests).
 */
export function createDefaultMcpStore(): McpStore {
  try {
    const filePath = resolveMcpDataFile();
    if (!filePath) return new MemoryMcpStore();
    return new FileMcpStore(filePath, legacyMcpDataFile());
  } catch {
    return new MemoryMcpStore();
  }
}