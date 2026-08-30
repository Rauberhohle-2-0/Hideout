/**
 * MCP Manager — lifecycle for MCP servers (health/connect/disconnect, tool listing).
 *
 * For STDIO: validates command exists, can spawn child_process with timeout and env from SecureStore.
 * For HTTP/SSE: performs fetch with headers + timeoutSeconds.
 *
 */

import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { Logger } from "../logger.ts";
import { McpError } from "./errors.ts";
import type { McpCallResult, McpServerConfig, McpServerStatus, McpTool } from "./types.ts";
import { McpRegistry, getDefaultMcpRegistry } from "./registry.ts";

const logger = new Logger({ prefix: "mcp-manager" });

export interface McpHealthResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
  version?: string;
}

export class McpManager {
  private registry: McpRegistry;
  private statuses = new Map<string, McpServerStatus>();
  private toolsCache = new Map<string, McpTool[]>();

  /** Live, connected MCP sessions keyed by server id. */
  private sessions = new Map<string, { client: Client; transport: Transport }>();

  constructor(registry?: McpRegistry) {
    this.registry = registry ?? getDefaultMcpRegistry();
  }

  async healthCheck(id: string, signal?: AbortSignal): Promise<McpHealthResult> {
    const config = await this.registry.getHydrated(id);
    if (!config) throw new McpError(`MCP server not found: ${id}`, "NOT_FOUND");
    if (config.enabled === false) return { ok: false, error: "Server disabled" };

    const start = Date.now();
    try {
      if (config.transport === "stdio") {
        const result = await this.healthStdio(config, signal);
        return { ok: true, latencyMs: Date.now() - start, ...result };
      } else {
        const result = await this.healthHttp(config, signal);
        return { ok: true, latencyMs: Date.now() - start, ...result };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Do not leak secret values — sanitize already via logger, but also ensure we don't echo env
      const safeMsg = msg.replace(/api[_-]?key[=:]\s*\S+/gi, "api_key=[REDACTED]");
      return { ok: false, error: safeMsg, latencyMs: Date.now() - start };
    }
  }

  private async healthStdio(config: McpServerConfig, signal?: AbortSignal): Promise<{ version?: string }> {
    const stdio = config.stdio!;
    // Validate command exists by spawning with --version or --help or just checking spawn
    // For npx/uvx we don't want to actually run the server (it would block), so we do a lightweight probe:
    // spawn the command with args + a quick timeout and check it starts without immediate ENOENT.

    // Security: prevent shell injection — spawn without shell, args as array
    return new Promise((resolve, reject) => {
      // For health, we try to spawn the command with --help and kill quickly.
      // For servers like "npx -y exa-mcp-server", we check that npx exists; we don't download.
      const probeArgs = stdio.command === "npx" || stdio.command === "uvx" ? ["--version"] : ["--help"];
      const child = spawn(stdio.command, probeArgs, {
        env: { ...process.env, ...(stdio.env ?? {}) },
        cwd: stdio.cwd,
        stdio: "ignore",
        shell: false,
        timeout: 5000,
      });

      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            child.kill("SIGTERM");
          } catch {}
          // If we got this far without error, command exists
          resolve({});
        }
      }, 1500);

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const code = (err as NodeJS.ErrnoException).code;
        // ENOENT here means the command is not on PATH, which is a different
        // problem from a server that starts and misbehaves — and the one a
        // user can actually act on. Name the command rather than the errno.
        const message =
          code === "ENOENT"
            ? `Command not found: ${stdio.command}. Check it is installed and on your PATH.`
            : `STDIO command failed: ${code ?? err.message}`;
        reject(new McpError(message, "CONNECTION_FAILED", err));
      });

      child.on("exit", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // exit 0 is fine, non-zero also means command exists (e.g., --help may return 0 or 1)
        if (code !== null) resolve({});
        else reject(new McpError(`STDIO probe exited`, "CONNECTION_FAILED"));
      });

      if (signal) {
        signal.addEventListener("abort", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try {
            child.kill("SIGTERM");
          } catch {}
          reject(new McpError("Health check aborted", "TIMEOUT"));
        }, { once: true });
      }
    });
  }

  private async healthHttp(config: McpServerConfig, signal?: AbortSignal): Promise<{ version?: string }> {
    const http = config.http ?? config.sse!;
    const url = http.url;
    const timeoutMs = (http.timeoutSeconds ?? 30) * 1000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new DOMException("Timeout", "TimeoutError")), timeoutMs);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
    }

    try {
      // MCP Streamable HTTP spec: GET or POST to base URL should respond; we try GET first
      const headers: Record<string, string> = {
        Accept: "application/json, text/event-stream",
        ...(http.headers ?? {}),
      };
      const res = await fetch(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      if (!res.ok) {
        // Some MCP servers only answer POST — retry the probe over POST before
        // reporting a connection failure.
        if (res.status === 405 || res.status === 404) {
          const retry = await fetch(url, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-03-26",
                capabilities: {},
                clientInfo: { name: "hideout", version: "1.0.0" },
              },
            }),
            signal: controller.signal,
          });
          if (!retry.ok) throw new McpError(`HTTP probe ${retry.status} at ${url}`, "CONNECTION_FAILED");
          return { version: retry.headers.get("mcp-version") ?? undefined };
        }
        throw new McpError(`HTTP ${res.status} at ${url}: ${(await res.text().catch(() => "")).slice(0, 500)}`, "CONNECTION_FAILED");
      }
      // Try to parse version from header or body
      const version = res.headers.get("mcp-version") ?? undefined;
      return { version: version ?? undefined };
    } catch (err) {
      if ((err as DOMException).name === "TimeoutError" || (err as Error).name === "AbortError") {
        throw new McpError(`Timeout after ${http.timeoutSeconds ?? 30}s to ${url}`, "TIMEOUT", err);
      }
      if (err instanceof McpError) throw err;
      throw new McpError(`HTTP health failed: ${(err as Error).message}`, "CONNECTION_FAILED", err);
    } finally {
      clearTimeout(timeout);
    }
  }

  /** List tools for a server, connecting first if no live session exists yet. */
  async listTools(id: string): Promise<McpTool[]> {
    const cached = this.toolsCache.get(id);
    if (cached) return cached;
    const session = this.sessions.get(id);
    if (session) {
      const tools = await this.listToolsForClient(session.client, 60_000);
      this.toolsCache.set(id, tools);
      return tools;
    }
    await this.connect(id);
    return this.toolsCache.get(id) ?? [];
  }

  getStatus(id: string): McpServerStatus | undefined {
    return this.statuses.get(id);
  }

  setStatus(id: string, status: McpServerStatus): void {
    this.statuses.set(id, status);
  }

  /**
   * Establish a real MCP session (initialize/initialized handshake) and cache
   * the server's tools. This is what actually makes an added server's tools
   * available, unlike the transport-only health probe below.
   */
  async connect(id: string): Promise<McpServerStatus> {
    const config = await this.registry.getHydrated(id);
    if (!config) throw new McpError(`MCP server not found: ${id}`, "NOT_FOUND");
    if (config.enabled === false) {
      const status: McpServerStatus = { id, connected: false, transport: config.transport, error: "Server disabled" };
      this.statuses.set(id, status);
      return status;
    }

    await this.closeSession(id);

    const timeoutMs = this.transportTimeout(config);
    const client = new Client({ name: "hideout", version: "1.0.0" }, { capabilities: {} });
    const transport = this.buildTransport(config);
    const session = { client, transport };
    this.sessions.set(id, session);

    try {
      await this.withTimeout(client.connect(transport), timeoutMs);
      await this.withTimeout(client.notification({ method: "notifications/initialized" }), timeoutMs);
      const tools = await this.listToolsForClient(client, timeoutMs);
      this.toolsCache.set(id, tools);
      const status: McpServerStatus = {
        id,
        connected: true,
        transport: config.transport,
        lastConnectedAt: new Date().toISOString(),
        toolCount: tools.length,
      };
      this.statuses.set(id, status);
      logger.info(`MCP connected: ${id} (${tools.length} tools)`);
      return status;
    } catch (err) {
      await this.closeSession(id);
      const status: McpServerStatus = { id, connected: false, transport: config.transport, error: this.errorMessage(err) };
      this.statuses.set(id, status);
      logger.warn(`MCP connect failed ${id}: ${this.errorMessage(err)}`);
      return status;
    }
  }

  async disconnect(id: string): Promise<void> {
    await this.closeSession(id);
    this.statuses.delete(id);
    logger.info(`MCP disconnected: ${id}`);
  }

  /** Call a named tool on a connected server, connecting first if needed. */
  async callTool(
    id: string,
    name: string,
    args?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallResult> {
    let session = this.sessions.get(id);
    if (!session) {
      const status = await this.connect(id);
      if (!status.connected) {
        throw new McpError(`Not connected to ${id}: ${status.error ?? "unknown error"}`, "NOT_CONNECTED");
      }
      session = this.sessions.get(id);
    }
    if (!session) throw new McpError(`Not connected: ${id}`, "NOT_CONNECTED");

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (!signal) timer = setTimeout(() => controller.abort(), 120_000);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
    }

    try {
      const result = (await session.client.callTool(
        { name, arguments: args },
        undefined,
        { signal: controller.signal },
      )) as unknown as CallToolRaw;
      const hasToolResult = result.toolResult !== undefined;
      const text = extractText(result.content);
      return {
        ok: hasToolResult ? true : !result.isError,
        text,
        content: hasToolResult ? result.toolResult : result.content,
        structuredContent: hasToolResult ? undefined : (result.structuredContent as Record<string, unknown> | undefined),
        isError: hasToolResult ? false : result.isError,
      };
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new McpError(`Tool call aborted (timed out after 120s): ${name}`, "TIMEOUT", err);
      }
      throw this.asMcpError(err);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** List tools from a live client if the server advertises the tools capability. */
  private async listToolsForClient(
    client: Client,
    timeoutMs: number,
  ): Promise<McpTool[]> {
    const caps = client.getServerCapabilities();
    if (!caps?.tools) return [];
    try {
      const { tools } = await this.withTimeout(client.listTools(), timeoutMs);
      return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    } catch (err) {
      // Tools capability is advertised but the call failed — surface the error rather
      // than silently pretending there are none.
      throw this.asMcpError(err);
    }
  }

  /** Build the SDK transport matching the server's transport type. */
  private buildTransport(config: McpServerConfig): Transport {
    if (config.transport === "stdio") {
      const stdio = config.stdio!;
      return new StdioClientTransport({
        command: stdio.command,
        args: stdio.args,
        env: { ...getDefaultEnvironment(), ...(stdio.env ?? {}) },
        cwd: stdio.cwd,
      });
    }

    const http = config.http ?? config.sse!;
    const url = new URL(http.url);
    const headers: Record<string, string> = {};
    if (http.headers) {
      for (const [k, v] of Object.entries(http.headers)) {
        if (typeof v === "string" && v.length > 0) headers[k] = v;
      }
    }
    const requestInit: RequestInit = { headers };

    if (config.transport === "sse") {
      return new SSEClientTransport(url, { requestInit });
    }
    return new StreamableHTTPClientTransport(url, { requestInit });
  }

  /** Tear down a live session (if any) and clear its cached tools. */
  private async closeSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    this.toolsCache.delete(id);
    if (session) {
      try {
        await session.client.close();
      } catch (err) {
        logger.debug(`Error closing MCP session ${id}: ${(err as Error).message}`);
      }
    }
  }

  /** A sane connect/list timeout per transport. */
  private transportTimeout(config: McpServerConfig): number {
    const http = config.http ?? config.sse;
    if (http?.timeoutSeconds) return http.timeoutSeconds * 1000;
    return 15_000;
  }

  /** Race a promise against a timeout, rejecting with an McpError on expiry. */
  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new McpError(`MCP request timed out after ${ms}ms`, "TIMEOUT")), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private errorMessage(err: unknown): string {
    if (err instanceof McpError) return err.message;
    return err instanceof Error ? err.message : String(err);
  }

  private asMcpError(err: unknown): McpError {
    if (err instanceof McpError) return err;
    const msg = err instanceof Error ? err.message : String(err);
    // SDK wraps protocol/server errors; map verification-type failures precisely.
    const lower = msg.toLowerCase();
    if (lower.includes("not connected") || lower.includes("no transport")) {
      return new McpError(msg, "NOT_CONNECTED", err);
    }
    if (lower.includes("invalid param") || lower.includes("method not found") || lower.includes("tool")) {
      return new McpError(msg, "VALIDATION_ERROR", err);
    }
    if (lower.includes("unauthor") || lower.includes("forbidden")) {
      return new McpError(msg, "AUTH_FAILED", err);
    }
    return new McpError(msg, "CONNECTION_FAILED", err);
  }

  async setEnabled(id: string, enabled: boolean): Promise<import("./types.ts").McpServerSafe> {
    const safe = await this.registry.setEnabled(id, enabled);
    if (!enabled) {
      await this.disconnect(id);
    }
    return safe;
  }
}

/** Relaxed view of the SDK callTool() result (its union + toolResult variant). */
interface CallToolRaw {
  content?: ContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
  toolResult?: unknown;
}

/**
 * Flatten an MCP tool result into plain text for the renderer. Text blocks are
 * joined with newlines; any non-text block is JSON-serialized inline so nothing
 * is silently dropped.
 */
function extractText(content: ContentBlock[] | undefined): string | undefined {
  if (!content || content.length === 0) return undefined;
  const parts = content.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "resource" && block.resource && "text" in block.resource) {
      return block.resource.text;
    }
    try {
      return JSON.stringify(block);
    } catch {
      return String(block);
    }
  });
  const joined = parts.join("\n");
  return joined.length > 0 ? joined : undefined;
}

let defaultManager: McpManager | null = null;

export function getDefaultMcpManager(): McpManager {
  if (!defaultManager) defaultManager = new McpManager(getDefaultMcpRegistry());
  return defaultManager;
}
