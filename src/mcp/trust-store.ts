/**
 * Trust records for STDIO MCP servers.
 *
 * Approval to execute a local STDIO server is a *trust decision*, kept
 * deliberately apart from the server configuration itself:
 *
 *   macOS:   ~/Library/Application Support/Hideout/MCP/mcp-trust.json
 *   Windows: %APPDATA%/Hideout/MCP/mcp-trust.json
 *   Linux:   $XDG_DATA_HOME/Hideout/MCP/mcp-trust.json
 *
 * Each record pins the *command fingerprint* that was approved. Editing the
 * server's command/args/cwd changes the fingerprint, so the next connect
 * requires a fresh approval even though the config file was never touched.
 * Deleting a server removes its trust record, so an id cannot be reused to
 * inherit a stale approval.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveMcpDataDir } from "./store.ts";

export type McpTrustRecord = {
  id: string;
  /** Canonical fingerprint of the approved command/args/cwd. */
  fingerprint: string;
  /** ms since epoch. */
  approvedAt: number;
};

export interface McpTrustStore {
  list(): Promise<McpTrustRecord[]>;
  get(id: string): Promise<McpTrustRecord | null>;
  set(record: McpTrustRecord): Promise<void>;
  delete(id: string): Promise<boolean>;
}

export class MemoryTrustStore implements McpTrustStore {
  private readonly map = new Map<string, McpTrustRecord>();

  async list(): Promise<McpTrustRecord[]> {
    return [...this.map.values()].map((r) => ({ ...r }));
  }

  async get(id: string): Promise<McpTrustRecord | null> {
    const r = this.map.get(id);
    return r ? { ...r } : null;
  }

  async set(record: McpTrustRecord): Promise<void> {
    this.map.set(record.id, { ...record });
  }

  async delete(id: string): Promise<boolean> {
    return this.map.delete(id);
  }

  clear(): void {
    this.map.clear();
  }
}

const TRUST_DATA_FILE_NAME = "mcp-trust.json";

/** File-backed trust store — one JSON object per server, keyed by id. */
export class FileTrustStore implements McpTrustStore {
  private readonly memory = new MemoryTrustStore();
  private loaded = false;

  constructor(private readonly filePath: string) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const text = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object") return;
      const servers = (parsed as { servers?: unknown }).servers;
      if (!Array.isArray(servers)) return;
      for (const entry of servers) {
        if (!entry || typeof entry !== "object") continue;
        const r = entry as Partial<McpTrustRecord>;
        if (typeof r.id !== "string" || !r.id) continue;
        if (typeof r.fingerprint !== "string") continue;
        if (typeof r.approvedAt !== "number" || !Number.isFinite(r.approvedAt)) continue;
        this.memory.set({ id: r.id, fingerprint: r.fingerprint, approvedAt: r.approvedAt });
      }
    } catch {
      // Missing/corrupt trust file — start empty (fail closed: no approvals).
    }
  }

  private async persist(): Promise<void> {
    try {
      const list = await this.memory.list();
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, JSON.stringify({ servers: list }, null, 2));
    } catch {
      // Best-effort; the decision still applies for this process's lifetime.
    }
  }

  async list(): Promise<McpTrustRecord[]> {
    await this.ensureLoaded();
    return this.memory.list();
  }

  async get(id: string): Promise<McpTrustRecord | null> {
    await this.ensureLoaded();
    return this.memory.get(id);
  }

  async set(record: McpTrustRecord): Promise<void> {
    await this.ensureLoaded();
    await this.memory.set(record);
    await this.persist();
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const ok = await this.memory.delete(id);
    if (ok) await this.persist();
    return ok;
  }
}

/** Preferred trust store: a JSON file next to the MCP config file. */
export function createDefaultTrustStore(): McpTrustStore {
  const dir = resolveMcpDataDir();
  if (!dir) return new MemoryTrustStore();
  return new FileTrustStore(`${dir}/${TRUST_DATA_FILE_NAME}`);
}
