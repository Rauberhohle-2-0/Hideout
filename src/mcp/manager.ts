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
import type { McpAuditEvent, McpServerConfig, McpServerInfo, McpServerStatus, McpStdioConfig, McpTool } from "../shared/mcp.ts";
import { EXA_SERVER_ID, createExaMcpServer, redactMcpConfig } from "../shared/mcp.ts";
import type { McpStore } from "./store.ts";
import { MemoryMcpStore } from "./store.ts";
import type { McpTrustRecord, McpTrustStore } from "./trust-store.ts";
import { MemoryTrustStore } from "./trust-store.ts";
import type { McpAuditStore } from "./audit-store.ts";
import { MemoryAuditStore } from "./audit-store.ts";
import { buildStdioEnv } from "./stdio-env.ts";
import {
  MCP_MAX_PROBE_BYTES,
  MCP_MAX_REDIRECTS,
  MCP_MAX_RESPONSE_BYTES,
  assertExternalUrlAllowed,
  dnsResolveHost,
  isRedirectStatus,
  readBoundedText,
  type ResolveHost,
} from "./net-guard.ts";

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
  /**
   * DNS resolver for the SSRF guard (tests inject a stub to stay offline).
   * Defaults to the OS resolver (`node:dns` lookup), the same one fetch uses.
   */
  resolveHost?: ResolveHost;
  /**
   * Store of STDIO execution approvals, kept apart from server configs.
   * Defaults to an in-memory store; the production sidecar passes a
   * file-backed store (see createDefaultTrustStore).
   */
  trustStore?: McpTrustStore;
  /**
   * Store of per-server trust/policy audit events. Defaults to in-memory;
   * the production sidecar passes a file-backed store (see
   * createDefaultAuditStore).
   */
  auditStore?: McpAuditStore;
};

/**
 * Thrown when a STDIO server has no valid approval for its current command.
 * Connect flows that would otherwise auto-start the subprocess (GET tools,
 * the chat web-search path) surface this instead of executing anything.
 */
export class McpApprovalRequiredError extends Error {
  readonly approvalRequired = true;
  constructor(message: string) {
    super(message);
    this.name = "McpApprovalRequiredError";
  }
}

/** Canonical fingerprint of the approved executable shape (command/args/cwd). */
function stdioFingerprint(config: McpServerConfig): string {
  const s = config as McpStdioConfig;
  return JSON.stringify([s.command, s.args ?? [], s.cwd ?? null]);
}

/** Human command line for audit detail strings (never includes env values). */
function stdioCmdLine(config: McpServerConfig): string {
  const s = config as McpStdioConfig;
  return [s.command, ...(s.args ?? [])].filter(Boolean).join(" ");
}

export class McpManager {
  private readonly store: McpStore;
  private readonly fetchImpl: typeof fetch;
  private readonly clientFactory?: (config: McpServerConfig, fetchImpl?: typeof fetch) => Promise<McpClient>;
  private readonly includeExa: boolean;
  private readonly resolveHost: ResolveHost;
  private readonly trustStore: McpTrustStore;
  private readonly auditStore: McpAuditStore;
  /** Ids of code-owned built-ins — read-only, never persisted. */
  private readonly builtInIds = new Set<string>();
  private readonly entries = new Map<string, Entry>();
  /** In-flight operation count per server id (concurrency limit). */
  private readonly inflight = new Map<string, number>();
  /** Loaded STDIO approvals, keyed by server id. */
  private approvals = new Map<string, McpTrustRecord>();
  private initPromise: Promise<void> | null = null;
  private seeded = false;

  constructor(options: McpManagerOptions = {}) {
    this.store = options.store ?? new MemoryMcpStore();
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as typeof fetch);
    this.clientFactory = options.clientFactory;
    this.includeExa = options.includeExa ?? true;
    this.resolveHost = options.resolveHost ?? dnsResolveHost;
    this.trustStore = options.trustStore ?? new MemoryTrustStore();
    this.auditStore = options.auditStore ?? new MemoryAuditStore();
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
      // Load persisted trust decisions so unapproved STDIO servers start in
      // `needs-approval` and can never silently execute after a restart.
      const approvals = await this.trustStore.list();
      this.approvals = new Map(approvals.map((a) => [a.id, a]));
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
        const entry: Entry = { config: c, status: "disconnected" };
        if (c.transport === "stdio" && !this.hasValidApproval(c)) {
          entry.status = "needs-approval";
          entry.error = this.approvalMessage(c);
        }
        this.entries.set(c.id, entry);
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

  /**
   * Renderer-facing info = config with secrets redacted. Raw env/header
   * values live only in the in-memory entry / store and are merged back on
   * update (see `mergePreservedSecrets` in the routes).
   */
  private infoFrom(entry: Entry): McpServerInfo {
    return {
      ...redactMcpConfig(entry.config),
      status: entry.status,
      ...(entry.builtIn ? { builtIn: true } : {}),
      ...(entry.error ? { error: entry.error } : {}),
      ...(entry.tools ? { tools: entry.tools, toolCount: entry.tools.length } : {}),
    } as McpServerInfo;
  }

  async getInfo(id: string): Promise<McpServerInfo | null> {
    await this.init();
    const e = this.entries.get(id);
    if (!e) return null;
    return this.infoFrom(e);
  }

  async listInfos(): Promise<McpServerInfo[]> {
    await this.init();
    const out: McpServerInfo[] = [];
    for (const e of this.entries.values()) {
      out.push(this.infoFrom(e));
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
    const entry: Entry = { config, status: "disconnected" };
    // A config edit may change the executable shape — re-require approval.
    if (config.transport === "stdio" && !this.hasValidApproval(config)) {
      entry.status = "needs-approval";
      entry.error = this.approvalMessage(config);
    }
    this.entries.set(config.id, entry);
    // Audit the trust/policy consequences of the edit (only for real diffs).
    if (existing) {
      const old = existing.config;
      if (config.transport === "stdio") {
        const wasApproved = this.hasValidApproval(old);
        if (wasApproved && !this.hasValidApproval(config)) {
          this.recordAudit(config.id, "relock", "Command, arguments or working directory changed — the approval was reset");
        }
      } else if (config.transport === "http" || config.transport === "sse") {
        const oldNet = Boolean((old as { privateNetworkAllowed?: boolean }).privateNetworkAllowed);
        const newNet = Boolean((config as { privateNetworkAllowed?: boolean }).privateNetworkAllowed);
        if (oldNet !== newNet) {
          this.recordAudit(
            config.id,
            "network",
            newNet ? "Allowed local & private network access" : "Restricted to public internet only",
          );
        }
      }
    }
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
    // Deleting a server revokes its trust so the id cannot be reused to
    // inherit a stale approval, and drops its audit history with it.
    this.approvals.delete(id);
    await this.trustStore.delete(id).catch(() => {});
    await this.auditStore.deleteServer(id).catch(() => {});
    return true;
  }

  /** Connect to a single server (id). Updates status/error/tools. */
  async connect(id: string): Promise<McpServerInfo> {
    await this.init();
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`MCP server "${id}" not found`);
    if (entry.status === "connected" && entry.client) return (await this.getInfo(id))!;

    // STDIO gate: connecting spawns a local process, so a valid approval for
    // the *current* command/args/cwd is mandatory — this also covers flows
    // that auto-connect (GET tools, the chat web-search path, save-then-
    // connect in Settings).
    if (entry.config.transport === "stdio" && !this.hasValidApproval(entry.config)) {
      entry.status = "needs-approval";
      entry.error = this.approvalMessage(entry.config);
      throw new McpApprovalRequiredError(entry.error);
    }

    entry.status = "connecting";
    entry.error = undefined;
    try {
      const client = await this.withOpSlot(id, 1, () => this.createClient(entry.config));
      const tools = await this.withOpSlot(id, 1, () =>
        this.withTimeout(client.listTools(), this.timeoutMs(entry.config), "listTools timed out"),
      );
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

  /**
   * Record an explicit approval to run a STDIO server's current command.
   *
   * The decision is persisted separately from the server config (see
   * McpTrustStore). A later command/args/cwd edit changes the fingerprint,
   * which invalidates the approval and requires a fresh one. Only ever call
   * this from an explicit user-facing approve action.
   */
  async approveServer(id: string): Promise<McpServerInfo> {
    await this.init();
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`MCP server "${id}" not found`);
    if (entry.config.transport !== "stdio") {
      throw new Error(`MCP server "${id}" does not run a local program — nothing to approve`);
    }
    const record: McpTrustRecord = {
      id,
      fingerprint: stdioFingerprint(entry.config),
      approvedAt: Date.now(),
    };
    await this.trustStore.set(record);
    this.approvals.set(id, record);
    if (entry.status === "needs-approval") {
      entry.status = "disconnected";
      entry.error = undefined;
    }
    this.recordAudit(id, "approve", stdioCmdLine(entry.config));
    return (await this.getInfo(id))!;
  }

  /**
   * Revoke an earlier approval without touching the server config. A running
   * subprocess is stopped and the server returns to `needs-approval`, so it
   * cannot start again until the user explicitly approves it once more.
   */
  async revokeApproval(id: string): Promise<McpServerInfo> {
    await this.init();
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`MCP server "${id}" not found`);
    if (entry.config.transport !== "stdio") {
      throw new Error(`MCP server "${id}" does not run a local program — nothing to revoke`);
    }
    if (entry.client) {
      try {
        await entry.client.close();
      } catch {}
      entry.client = undefined;
    }
    entry.tools = undefined;
    this.approvals.delete(id);
    await this.trustStore.delete(id).catch(() => {});
    entry.status = "needs-approval";
    entry.error = this.approvalMessage(entry.config);
    this.recordAudit(id, "revoke", stdioCmdLine(entry.config));
    return (await this.getInfo(id))!;
  }

  /**
   * Per-server trust/policy history (approve, revoke, re-locks, network
   * policy flips). Detail strings never contain secrets.
   */
  async audit(id: string): Promise<McpAuditEvent[]> {
    await this.init();
    if (!this.entries.has(id)) throw new Error(`MCP server "${id}" not found`);
    return this.auditStore.list(id);
  }

  /** Record an audit event; persistence failures never break the main flow. */
  private recordAudit(id: string, type: McpAuditEvent["type"], detail: string): void {
    void this.auditStore
      .append(id, { at: Date.now(), type, detail })
      .catch(() => {});
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
    // Disconnecting must not masquerade an unapproved STDIO server as ready.
    if (entry.config.transport === "stdio" && !this.hasValidApproval(entry.config)) {
      entry.status = "needs-approval";
      entry.error = this.approvalMessage(entry.config);
    }
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
    const tools = await this.withOpSlot(id, 2, () => entry.client!.listTools());
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
    return await this.withOpSlot(id, 2, () =>
      this.withTimeout(entry.client!.callTool(toolName, args), this.timeoutMs(entry.config), "callTool timed out"),
    );
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
          const res = await this.guardedFetch(
            url,
            {
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
            },
            entry.config,
          );
          if (!res.ok) {
            const text = await readBoundedText(res, MCP_MAX_PROBE_BYTES).catch(() => "");
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

  /** True when the config opts out of the private-network block (SSRF guard). */
  private allowsPrivateNetwork(config: McpServerConfig): boolean {
    return (config as { privateNetworkAllowed?: boolean }).privateNetworkAllowed === true;
  }

  /** Whether a persisted approval matches this config's current executable shape. */
  private hasValidApproval(config: McpServerConfig): boolean {
    const record = this.approvals.get(config.id);
    return record !== undefined && record.fingerprint === stdioFingerprint(config);
  }

  /** Human-readable explanation shown when a STDIO server needs approval. */
  private approvalMessage(config: McpServerConfig): string {
    const s = config as McpStdioConfig;
    const cmd = s.args && s.args.length > 0 ? `${s.command} ${s.args.join(" ")}` : s.command;
    return `"${config.name}" runs a local program (${cmd}) and has not been approved yet. ` +
      "Approve it in Settings before it can start.";
  }

  /**
   * Per-server in-flight operation slot. Rejects when `limit` operations are
   * already running for `id` so a misbehaving server cannot queue unbounded
   * work in the sidecar.
   */
  private async withOpSlot<T>(id: string, limit: number, fn: () => Promise<T>): Promise<T> {
    const current = this.inflight.get(id) ?? 0;
    if (current >= limit) {
      throw new Error(`Too many concurrent operations on MCP server "${id}" (limit ${limit})`);
    }
    this.inflight.set(id, current + 1);
    try {
      return await fn();
    } finally {
      const next = (this.inflight.get(id) ?? 1) - 1;
      if (next <= 0) this.inflight.delete(id);
      else this.inflight.set(id, next);
    }
  }

  /**
   * Outbound fetch for user-configured MCP endpoints: runs the SSRF guard on
   * the initial URL and on every redirect hop (capped), with redirects
   * handled manually so each target is re-checked. The caller keeps its own
   * timeout/abort controller around this call.
   */
  private async guardedFetch(url: string, init: RequestInit, config: McpServerConfig): Promise<Response> {
    let current = url;
    for (let hops = 0; ; hops++) {
      await assertExternalUrlAllowed(new URL(current), this.resolveHost, this.allowsPrivateNetwork(config));
      const res = await this.fetchImpl(current, { ...init, redirect: "manual" });
      if (!isRedirectStatus(res.status)) return res;
      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!location) throw new Error(`MCP redirect without Location header (HTTP ${res.status})`);
      if (hops >= MCP_MAX_REDIRECTS) {
        throw new Error(`Too many MCP redirects (max ${MCP_MAX_REDIRECTS})`);
      }
      current = new URL(location, current).toString();
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
    return this.createHttpFallbackClient(config);
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
        // SSRF guard: the SDK's transport does its own fetch internally, so
        // validate the literal target (name + resolved addresses) up front.
        await assertExternalUrlAllowed(new URL(httpCfg.url), this.resolveHost, this.allowsPrivateNetwork(config));
        transport = new (StreamableHTTPClientTransport as unknown as new (url: URL, opts?: unknown) => unknown)(new URL(httpCfg.url), {
          requestInit: { headers: httpCfg.headers },
        });
      } else if (config.transport === "sse") {
        // @ts-ignore - optional peer
        const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js").catch(() => ({ SSEClientTransport: null }));
        if (!SSEClientTransport) return null;
        const sseCfg = config as { url: string; headers?: Record<string, string> };
        // SSRF guard — see the http branch comment.
        await assertExternalUrlAllowed(new URL(sseCfg.url), this.resolveHost, this.allowsPrivateNetwork(config));
        transport = new (SSEClientTransport as unknown as new (url: URL, opts?: unknown) => unknown)(new URL(sseCfg.url), {
          requestInit: { headers: sseCfg.headers },
        });
      } else if (config.transport === "stdio") {
        // @ts-ignore - optional peer
        const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js").catch(() => ({ StdioClientTransport: null }));
        if (!StdioClientTransport) return null;
        const stdioCfg = config as { command: string; args?: string[]; env?: Record<string, string>; cwd?: string };
        // Minimal environment: never the sidecar's full process.env (which
        // can carry API keys) — only benign allowlisted vars plus whatever
        // the user explicitly configured for this server.
        transport = new (StdioClientTransport as unknown as new (opts: unknown) => unknown)({
          command: stdioCfg.command,
          args: stdioCfg.args ?? [],
          env: buildStdioEnv(stdioCfg.env ?? {}),
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

  private createHttpFallbackClient(cfg: McpServerConfig): McpClient {
    const config = cfg as McpServerConfig & { url: string; headers?: Record<string, string>; timeout?: number };
    const url = config.url;
    const headers = config.headers ?? {};
    const timeoutMs = (config.timeout ?? 30) * 1000;
    const guardFetch = (u: string, init: RequestInit): Promise<Response> => this.guardedFetch(u, init, config);
    let sessionId: string | undefined;

    const doRpc = async (method: string, params: unknown): Promise<unknown> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await guardFetch(url, {
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
          const text = await readBoundedText(res, MCP_MAX_RESPONSE_BYTES).catch(() => "");
          throw new Error(`${res.status} ${text.slice(0, 300)}`);
        }
        const contentType = res.headers.get("content-type") ?? "";
        if (contentType.includes("text/event-stream")) {
          // SSE-style Streamable HTTP — collect first JSON event
          const text = await readBoundedText(res, MCP_MAX_RESPONSE_BYTES);
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
        const text = await readBoundedText(res, MCP_MAX_RESPONSE_BYTES);
        const obj = JSON.parse(text) as { result?: unknown; error?: { message?: string } };
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
          await guardFetch(url, {
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

  /** For tests: clear in-memory entries and loaded approvals (does not touch store files). */
  clearEntries(): void {
    this.entries.clear();
    this.builtInIds.clear();
    this.approvals.clear();
    this.seeded = false;
    this.initPromise = null;
  }
}
