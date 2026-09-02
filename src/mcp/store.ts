/**
 * Persistence for MCP server configs.
 *
 * Two implementations:
 * - `MemoryMcpStore` — for tests / ephemeral use.
 * - `FileMcpStore`   — JSON file on disk, used by the sidecar when it has
 *   filesystem access. Falls back to memory when the file cannot be written.
 *
 * The store holds only configs (no secrets in extra fields — env/headers are
 * part of the config and should be redacted when returned over HTTP).
 */
import type { McpServerConfig } from "../shared/mcp.ts";
import { normalizeMcpServerConfig } from "../shared/mcp.ts";

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

export class FileMcpStore implements McpStore {
  private readonly filePath: string;
  private readonly memory = new MemoryMcpStore();
  private loaded = false;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const file = Bun.file(this.filePath);
      if (!(await file.exists())) return;
      const raw = await file.json();
      if (!Array.isArray(raw)) return;
      for (const entry of raw) {
        if (entry && typeof entry.id === "string") {
          // Store without strict validation here — server validates on write.
          // Normalize for consistent defaults.
          try {
            await this.memory.set(entry as McpServerConfig);
          } catch {}
        }
      }
    } catch {
      // Ignore corrupt file — start empty.
    }
  }

  private async persist(): Promise<void> {
    try {
      const list = await this.memory.list();
      const dir = this.filePath.slice(0, this.filePath.lastIndexOf("/"));
      if (dir) {
        try {
          await Bun.file(dir).exists(); // no-op, Bun doesn't need mkdir for file write?
        } catch {}
      }
      await Bun.write(this.filePath, JSON.stringify(list, null, 2));
    } catch {
      // Best-effort; ignore write failures (e.g. packaged app without write perms)
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

export function createDefaultMcpStore(): McpStore {
  // In Bun sidecar, persist to data/mcp-servers.json next to project root.
  // When running in tests (no Bun.file or no writable FS), fall back to memory.
  try {
    const g = globalThis as unknown as { Bun?: { file?: unknown; write?: unknown } };
    if (g.Bun?.file && g.Bun?.write) {
      const path = `${process.cwd()}/data/mcp-servers.json`;
      return new FileMcpStore(path);
    }
  } catch {}
  return new MemoryMcpStore();
}
