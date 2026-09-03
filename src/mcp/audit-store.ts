/**
 * Persistence for the per-server trust & policy audit trail.
 *
 * Approve/revoke decisions, STDIO re-locks (command-shape changes) and
 * HTTP/SSE private-network policy flips are recorded sidecar-side, next to
 * the config and trust files:
 *
 *   macOS:   ~/Library/Application Support/Hideout/MCP/mcp-audit.json
 *   Windows: %APPDATA%/Hideout/MCP/mcp-audit.json
 *   Linux:   $XDG_DATA_HOME/Hideout/MCP/mcp-audit.json
 *
 * Events are bounded per server (MCP_AUDIT_LIMIT, oldest dropped) and their
 * `detail` strings are deliberately plain (command names, policy changes) —
 * raw env/header secrets never enter the log.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { McpAuditEvent } from "../shared/mcp.ts";
import { MCP_AUDIT_LIMIT } from "../shared/mcp.ts";
import { resolveMcpDataDir } from "./store.ts";

export interface McpAuditStore {
  list(id: string): Promise<McpAuditEvent[]>;
  append(id: string, event: McpAuditEvent): Promise<void>;
  /** Remove a server's whole history (used when the server is deleted). */
  deleteServer(id: string): Promise<void>;
}

function clone(events: McpAuditEvent[]): McpAuditEvent[] {
  return events.map((e) => ({ ...e }));
}

export class MemoryAuditStore implements McpAuditStore {
  private readonly map = new Map<string, McpAuditEvent[]>();

  async list(id: string): Promise<McpAuditEvent[]> {
    return clone(this.map.get(id) ?? []);
  }

  async append(id: string, event: McpAuditEvent): Promise<void> {
    const next = [...(this.map.get(id) ?? []), { ...event }];
    this.map.set(id, next.slice(-MCP_AUDIT_LIMIT));
  }

  async deleteServer(id: string): Promise<void> {
    this.map.delete(id);
  }

  clear(): void {
    this.map.clear();
  }
}

const AUDIT_FILE_NAME = "mcp-audit.json";

/** File-backed audit store — `{ servers: { [id]: McpAuditEvent[] } }`. */
export class FileAuditStore implements McpAuditStore {
  private readonly map = new Map<string, McpAuditEvent[]>();
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
      if (!servers || typeof servers !== "object" || Array.isArray(servers)) return;
      for (const [id, rawEvents] of Object.entries(servers as Record<string, unknown>)) {
        if (!Array.isArray(rawEvents)) continue;
        const events: McpAuditEvent[] = [];
        for (const e of rawEvents) {
          if (!e || typeof e !== "object") continue;
          const ev = e as Partial<McpAuditEvent>;
          if (typeof ev.at !== "number" || !Number.isFinite(ev.at)) continue;
          if (typeof ev.type !== "string") continue;
          if (typeof ev.detail !== "string") continue;
          events.push({ at: ev.at, type: ev.type as McpAuditEvent["type"], detail: ev.detail });
        }
        if (events.length > 0) {
          // Bound per server (defense in depth against a hand-edited file).
          this.map.set(id, clone(events).slice(-MCP_AUDIT_LIMIT));
        }
      }
    } catch {
      // Missing/corrupt audit file — start empty (fail closed, no history).
    }
  }

  private async writeAll(): Promise<void> {
    const all: Record<string, McpAuditEvent[]> = {};
    for (const [id, events] of this.map) {
      if (events.length > 0) all[id] = clone(events);
    }
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, JSON.stringify({ servers: all }, null, 2));
    } catch {
      // Best-effort persistence; the in-memory copy still serves this process.
    }
  }

  async list(id: string): Promise<McpAuditEvent[]> {
    await this.ensureLoaded();
    return clone(this.map.get(id) ?? []);
  }

  async append(id: string, event: McpAuditEvent): Promise<void> {
    await this.ensureLoaded();
    const next = [...(this.map.get(id) ?? []), { ...event }];
    this.map.set(id, next.slice(-MCP_AUDIT_LIMIT));
    await this.writeAll();
  }

  async deleteServer(id: string): Promise<void> {
    await this.ensureLoaded();
    if (this.map.delete(id)) await this.writeAll();
  }
}

/** Preferred audit store: a JSON file next to the MCP config file. */
export function createDefaultAuditStore(): McpAuditStore {
  const dir = resolveMcpDataDir();
  if (!dir) return new MemoryAuditStore();
  return new FileAuditStore(`${dir}/${AUDIT_FILE_NAME}`);
}
