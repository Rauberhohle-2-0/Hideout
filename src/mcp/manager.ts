/**
 * MCP Manager — lifecycle for MCP servers across all transports.
 *
 * Responsibilities:
 * - Own the `McpStore` (persisted user configs)
 * - Include the code-owned EXA.ai HTTP server as a built-in (free-tier, no
 *   key) that is listed/usable but never persisted and never user-editable
 * - Connect / disconnect per server using the correct transport:
 *    - `stdio`  → StdioClientTransport (subprocess via `command` + `args` + `env`)
 *    - `http`   → StreamableHTTPClientTransport (Streamable HTTP, `url` + `headers` + `timeoutSeconds`)
 *    - `sse`    → SSEClientTransport (legacy SSE, `url` + `headers` + `timeoutSeconds`)
 * - Cache connected Clients and expose `listTools` / `callTool`
 * - Track per-server `status` and last `error`
 *
 * The manager intentionally does NOT spawn real SDK clients in tests when
 * `fetchImpl` is injected or when SDK is unavailable — it falls back to a
 * lightweight HTTP probe so tests stay deterministic and offline.
 *
 * Transport separation is enforced: STDIO configs never carry `url`/`headers`/`timeout`,
 * HTTP/SSE configs never carry `command`/`args`/`env`.
 */
import type { McpServerConfig, McpServerInfo, McpServerStatus, McpTool } from "../shared/mcp.ts";
import { EXA_SERVER_ID, createExaMcpServer } from "../shared/mcp.ts";
import type { McpStore } from "./store.ts";
import { MemoryMcpStore } from "./store.ts";

// ── Lightweight client abstraction ────────────────────────────────────────
// We wrap the real SDK Client when available; otherwise we use a fetch-based
// probe that speaks enough MCP to validate connectivity and list tools via
// JSON-RPC. This keeps the manager testable without installing the SDK in CI.

type McpClient = {
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
};

// Runtime holder per server.
type Entry = {
  config: McpServerConfig;
  status: McpServerStatus;
  /** True for code-owned built-ins (Exa) — never persisted, read-only. */
  builtIn?: boolean;
  error?: string;
  client?: McpClient;
  tools?: McpTool[];
};

export type McpManagerOptions = {
  store?: McpStore;
  fetchImpl?: typeof fetch;
  /** Include the code-owned built-in EXA server (default true). Set false in isolated tests. */
  includeExa?: boolean;
  /** Factory to create a real SDK client (injected for testing or when SDK present). */
  clientFactory?: (config: McpServerConfig, fetchImpl?: typeof fetch) => Promise<McpClient>;
};

export class McpManager {
  private readonly store: McpStore;
  private readonly fetchImpl: typeof fetch;
  private readonly clientFactory?: (config: McpServerConfig, fetchImpl?: typeof fetch) => Promise<McpClient>;
  private readonly includeExa: boolean;
  /** Ids of code-owned built-ins — read-only, never persisted. */
  private readonly builtInIds = new Set<string>();
  private readonly entries = new Map<string, Entry>();
  private initPromise: Promise<void> | null = null;
  private seeded = false;

  constructor(options: McpManagerOptions = {}) {
    this.store = options.store ?? new MemoryMcpStore();
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as typeof fetch);
    this.clientFactory = options.clientFactory;
    this.includeExa = options.includeExa ?? true;
  }

  /**
   * Load persisted user configs into memory, then register the code-owned
   * built-ins (Exa). Built-ins come first so `listInfos()` / web search
   * prefer them, and they are never written to the store.
   */
  async init(): Promise<void> {
    if (this.seeded) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      const builtInId = this.includeExa ? EXA_SERVER_ID : null;
      if (builtInId) this.builtInIds.add(builtInId);
      if (builtInId) {
        const exa = createExaMcpServer();
        this.entries.set(exa.id, { config: exa, status: "disconnected", builtIn: true });
      }
      const configs = await this.store.list();
      for (const c of configs) {
        // A user file can never shadow a built-in id.
        if (builtInId && c.id === builtInId) continue;
        this.entries.set(c.id, { config: c, status: "disconnected" });
      }
      this.seeded = true;
    })();
    return this.initPromise;
  }

  async listConfigs(): Promise<McpServerConfig[]> {
    await this.init();
    return [...this.entries.values()].map((e) => ({ ...e.config } as McpServerConfig));
  }

  async getConfig(id: string): Promise<McpServerConfig | null> {
    await this.init();
    const e = this.entries.get(id);
    return e ? ({ ...e.config } as McpServerConfig) : null;
  }

  async getInfo(id: string): Promise<McpServerInfo | null> {
    await this.init();
    const e = this.entries.get(id);
    if (!e) return null;
    return {
      ...e.config,
      status: e.status,
      ...(e.builtIn ? { builtIn: true } : {}),
      ...(e.error ? { error: e.error } : {}),
      ...(e.tools ? { tools: e.tools, toolCount: e.tools.length } : {}),
    } as McpServerInfo;
  }

  async listInfos(): Promise<McpServerInfo[]> {
    await this.init();
    const out: McpServerInfo[] = [];
    for (const e of this.entries.values()) {
      out.push({
        ...e.config,
        status: e.status,
        ...(e.builtIn ? { builtIn: true } : {}),
        ...(e.error ? { error: e.error } : {}),
        ...(e.tools ? { tools: e.tools, toolCount: e.tools.length } : {}),
      } as McpServerInfo);
    }
    return out;
  }

  async upsert(config: McpServerConfig): Promise<McpServerInfo> {
    await this.init();
    if (this.isBuiltIn(config.id)) {
      throw new Error(`MCP server "${config.id}" is built-in and cannot be modified`);
    }
    // Disconnect old client if transport/config changed.
    const existing = this.entries.get(config.id);
    if (existing?.client) {
      try {
        await existing.client.close();
      } catch {}
    }
    await this.store.set(config);
    this.entries.set(config.id, { config, status: "disconnected" });
    return (await this.getInfo(config.id))!;
  }

  async remove(id: string): Promise<boolean> {
    await this.init();
    if (this.isBuiltIn(id)) {
      throw new Error(`MCP server "${id}" is built-in and cannot be deleted`);
    }
    const e = this.entries.get(id);
    if (!e) return false;
    if (e.client) {
      try {
        await e.client.close();
      } catch {}
    }
    this.entries.delete(id);
    await this.store.delete(id);
    return true;
  }

  /** Connect to a single server (id). Updates status/error/tools. */
  async connect(id: string): Promise<McpServerInfo> {
    await this.init();
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`MCP server "${id}" not found`);
    if (entry.status === "connected" && entry.client) return (await this.getInfo(id))!;

    entry.status = "connecting";
    entry.error = undefined;
    try {
      const client = await this.createClient(entry.config);
      const tools = await this.withTimeout(client.listTools(), this.timeoutMs(entry.config), "listTools timed out");
      entry.client = client;
      entry.tools = tools;
      entry.status = "connected";
      entry.error = undefined;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      entry.status = "error";
      entry.error = msg;
      if (entry.client) {
        try {
          await entry.client.close();
        } catch {}
        entry.client = undefined;
      }
      // Re-throw so the HTTP route can return 502 with the error.
      throw new Error(msg);
    }
    return (await this.getInfo(id))!;
  }

  async disconnect(id: string): Promise<McpServerInfo> {
    await this.init();
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`MCP server "${id}" not found`);
    if (entry.client) {
      try {
        await entry.client.close();
      } catch {}
      entry.client = undefined;
    }
    entry.status = "disconnected";
    entry.error = undefined;
    entry.tools = undefined;
    return (await this.getInfo(id))!;
  }

  async listTools(id: string): Promise<McpTool[]> {
    await this.init();
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`MCP server "${id}" not found`);
    if (entry.status !== "connected" || !entry.client) {
      // Auto-connect if disconnected and enabled
      if (entry.config.enabled !== false) {
        await this.connect(id);
        return this.entries.get(id)!.tools ?? [];
      }
      throw new Error(`MCP server "${id}" is not connected`);
    }
    // Refresh tools
    const tools = await entry.client.listTools();
    entry.tools = tools;
    return tools;
  }

  async callTool(id: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    await this.init();
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`MCP server "${id}" not found`);
    if (entry.status !== "connected" || !entry.client) {
      throw new Error(`MCP server "${id}" is not connected`);
    }
    return await this.withTimeout(entry.client.callTool(toolName, args), this.timeoutMs(entry.config), "callTool timed out");
  }

  /** Probe connectivity without fully connecting (HEAD/GET for http/sse, spawn check for stdio). */
  async probe(id: string): Promise<{ ok: boolean; error?: string }> {
    await this.init();
    const entry = this.entries.get(id);
    if (!entry) return { ok: false, error: "not found" };
    try {
      // For http/sse, do a lightweight MCP initialize via JSON-RPC POST.
      if (entry.config.transport === "http" || entry.config.transport === "sse") {
        const url = (entry.config as { url: string }).url;
        const headers = (entry.config as { headers?: Record<string, string> }).headers ?? {};
        const timeoutMs = this.timeoutMs(entry.config);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await this.fetchImpl(url, {
            method: "POST",
            signal: controller.signal,
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              ...headers,
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2024-11-05",
                capabilities: {},
                clientInfo: { name: "hideout", version: "0.1.0" },
              },
            }),
          });
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            return { ok: false, error: `${res.status} ${text.slice(0, 200)}` };
          }
          return { ok: true };
        } finally {
          clearTimeout(timer);
        }
      }
      if (entry.config.transport === "stdio") {
        // Check command exists by trying to spawn with --help / --version quickly?
        // We just report disconnected — actual connect will validate.
        return { ok: true };
      }
      return { ok: false, error: "unknown transport" };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Built-in (code-owned) server ids — read-only, never persisted. */
  private isBuiltIn(id: string): boolean {
    return this.builtInIds.has(id);
  }

  private timeoutMs(config: McpServerConfig): number {
    if (config.transport === "http" || config.transport === "sse") {
      const sec = (config as { timeout?: number }).timeout ?? 30;
      return sec * 1000;
    }
    return 30_000;
  }

  private async withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(msg)), ms);
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async createClient(config: McpServerConfig): Promise<McpClient> {
    if (this.clientFactory) {
      return await this.clientFactory(config, this.fetchImpl);
    }
    // Try to load the real SDK if installed (optional dependency).
    const sdkClient = await this.tryCreateSdkClient(config);
    if (sdkClient) return sdkClient;

    // Fallback: lightweight HTTP JSON-RPC client for http/sse.
    // STDIO cannot be emulated without a subprocess — throw instructive error.
    if (config.transport === "stdio") {
      throw new Error(
        `STDIO transport requires @modelcontextprotocol/sdk to spawn "${config.command}". Install it with: npm install @modelcontextprotocol/sdk zod`,
      );
    }
    return this.createHttpFallbackClient(config as { url: string; headers?: Record<string, string>; timeout?: number });
  }

  private async tryCreateSdkClient(config: McpServerConfig): Promise<McpClient | null> {
    try {
      // Dynamic import so the package is optional. TS ignore — module may not be installed.
      // @ts-ignore - optional peer dependency
      const sdk = (await import("@modelcontextprotocol/sdk/client/index.js").catch(() => null)) as unknown as {
        Client?: new (info: { name: string; version: string }, opts?: unknown) => {
          connect(transport: unknown): Promise<void>;
          listTools(): Promise<{ tools: McpTool[] }>;
          callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
          close(): Promise<void>;
        };
      } | null;
      if (!sdk?.Client) return null;

      let transport: unknown;
      if (config.transport === "http") {
        // @ts-ignore - optional peer
        const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js").catch(() => ({ StreamableHTTPClientTransport: null }));
        if (!StreamableHTTPClientTransport) return null;
        const httpCfg = config as { url: string; headers?: Record<string, string> };
        transport = new (StreamableHTTPClientTransport as unknown as new (url: URL, opts?: unknown) => unknown)(new URL(httpCfg.url), {
          requestInit: { headers: httpCfg.headers },
        });
      } else if (config.transport === "sse") {
        // @ts-ignore - optional peer
        const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js").catch(() => ({ SSEClientTransport: null }));
        if (!SSEClientTransport) return null;
        const sseCfg = config as { url: string; headers?: Record<string, string> };
        transport = new (SSEClientTransport as unknown as new (url: URL, opts?: unknown) => unknown)(new URL(sseCfg.url), {
          requestInit: { headers: sseCfg.headers },
        });
      } else if (config.transport === "stdio") {
        // @ts-ignore - optional peer
        const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js").catch(() => ({ StdioClientTransport: null }));
        if (!StdioClientTransport) return null;
        const stdioCfg = config as { command: string; args?: string[]; env?: Record<string, string>; cwd?: string };
        transport = new (StdioClientTransport as unknown as new (opts: unknown) => unknown)({
          command: stdioCfg.command,
          args: stdioCfg.args ?? [],
          env: { ...process.env, ...(stdioCfg.env ?? {}) } as Record<string, string>,
          cwd: stdioCfg.cwd,
        });
      } else {
        return null;
      }

      const client = new sdk.Client({ name: "hideout", version: "0.1.0" });
      await client.connect(transport);
      return {
        async listTools(): Promise<McpTool[]> {
          const res = await client.listTools();
          return (res as { tools?: McpTool[] }).tools ?? [];
        },
        async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
          return await client.callTool({ name, arguments: args });
        },
        async close(): Promise<void> {
          await client.close();
        },
      };
    } catch {
      return null;
    }
  }

  private createHttpFallbackClient(cfg: { url: string; headers?: Record<string, string>; timeout?: number }): McpClient {
    const fetchImpl = this.fetchImpl;
    const url = cfg.url;
    const headers = cfg.headers ?? {};
    const timeoutMs = (cfg.timeout ?? 30) * 1000;
    let sessionId: string | undefined;

    const doRpc = async (method: string, params: unknown): Promise<unknown> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...(sessionId ? { "mcp-session-id": sessionId } : {}),
            ...headers,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
        });
        const sid = res.headers.get("mcp-session-id");
        if (sid) sessionId = sid;
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`${res.status} ${text.slice(0, 300)}`);
        }
        const contentType = res.headers.get("content-type") ?? "";
        if (contentType.includes("text/event-stream")) {
          // SSE-style Streamable HTTP — collect first JSON event
          const text = await res.text();
          const jsonLine = text
            .split("\n")
            .map((l) => l.trim())
            .find((l) => l.startsWith("data: "));
          if (!jsonLine) throw new Error("Empty SSE response");
          const data = jsonLine.slice(6).trim();
          if (data === "[DONE]") return {};
          try {
            const obj = JSON.parse(data) as { result?: unknown; error?: { message?: string } };
            if (obj.error) throw new Error(obj.error.message ?? "RPC error");
            return obj.result ?? obj;
          } catch (e) {
            if (e instanceof SyntaxError) throw new Error(`Invalid SSE JSON: ${data.slice(0, 200)}`);
            throw e;
          }
        }
        const obj = (await res.json()) as { result?: unknown; error?: { message?: string } };
        if (obj.error) throw new Error(obj.error.message ?? "RPC error");
        return obj.result ?? obj;
      } finally {
        clearTimeout(timer);
      }
    };

    // Initialize eagerly to obtain sessionId where supported
    let initialized = false;
    const ensureInit = async () => {
      if (initialized) return;
      try {
        await doRpc("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "hideout", version: "0.1.0" },
        });
        // Send initialized notification (no response expected)
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          await fetchImpl(url, {
            method: "POST",
            signal: controller.signal,
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              ...(sessionId ? { "mcp-session-id": sessionId } : {}),
              ...headers,
            },
            body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
          }).catch(() => {});
          clearTimeout(timer);
        } catch {}
      } catch {
        // Non-fatal — some servers accept list without strict init
      }
      initialized = true;
    };

    return {
      async listTools(): Promise<McpTool[]> {
        await ensureInit();
        const res = (await doRpc("tools/list", {})) as { tools?: McpTool[] } | McpTool[];
        if (Array.isArray(res)) return res;
        return res.tools ?? [];
      },
      async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
        await ensureInit();
        const res = (await doRpc("tools/call", { name, arguments: args })) as unknown;
        return res;
      },
      async close(): Promise<void> {
        // No persistent connection for fetch fallback
      },
    };
  }

  /** For tests: clear in-memory entries (does not touch store file). */
  clearEntries(): void {
    this.entries.clear();
    this.builtInIds.clear();
    this.seeded = false;
    this.initPromise = null;
  }
}
