/**
 * Shared MCP (Model Context Protocol) contracts.
 *
 * Transport separation is load-bearing — mixing fields across transports
 * (e.g. `command` on an HTTP server, `url` on STDIO) is rejected at
 * validation and by the type system. Callers must use the discriminated
 * union `McpServerConfig` and check `transport` before touching
 * transport-specific fields.
 *
 * - STDIO: runs a local subprocess. Needs `command` (e.g. `npx`, `uvx`),
 *   optional `args` and `env`. No URL, no headers, no timeoutSeconds-in-header sense.
 * - HTTP (Streamable HTTP): remote endpoint. Needs `url`, optional `headers`
 *   and `timeout` in **seconds**. No command/args/env.
 * - SSE (legacy Server-Sent Events): same shape as HTTP, legacy transport.
 *   Still uses `url` + `headers` + `timeout`. Kept separate because some
 *   servers still require the older SSE handshake.
 */

export const MCP_TRANSPORTS = ["stdio", "http", "sse"] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

export const MCP_ENABLED_DEFAULT = true;
export const MCP_TIMEOUT_SECONDS_DEFAULT = 30;
export const MCP_TIMEOUT_SECONDS_MIN = 1;
export const MCP_TIMEOUT_SECONDS_MAX = 600;

// ── Per-transport configs ───────────────────────────────────────────────

/** STDIO: local subprocess via `command` + `args` + `env`. */
export type McpStdioConfig = {
  /** Discriminator — must be exactly `"stdio"`. */
  transport: "stdio";
  /** Executable, e.g. `npx`, `uvx`, `node`, `python`. */
  command: string;
  /** CLI args passed to `command`. */
  args?: string[];
  /** Environment variables injected into the subprocess. */
  env?: Record<string, string>;
  /** Optional working directory for the subprocess. */
  cwd?: string;
};

/** HTTP = Streamable HTTP (modern). Remote URL + headers + timeout in seconds. */
export type McpHttpConfig = {
  transport: "http";
  /** Endpoint URL, e.g. `https://mcp.exa.ai/mcp`. */
  url: string;
  /** Optional HTTP headers (auth, etc.). */
  headers?: Record<string, string>;
  /** Request/connection timeout in **seconds**. */
  timeout?: number;
};

/** SSE = legacy Server-Sent Events. Same shape as HTTP, distinct transport. */
export type McpSseConfig = {
  transport: "sse";
  url: string;
  headers?: Record<string, string>;
  timeout?: number;
};

// ── Full server record ──────────────────────────────────────────────────

type McpBase = {
  /** Stable id, e.g. `exa`, `filesystem`. Lowercase, hyphen/underscore allowed. */
  id: string;
  /** Human label shown in UI. */
  name: string;
  /** Whether the server should be connected. */
  enabled?: boolean;
  /** Optional description. */
  description?: string;
};

export type McpServerConfig = McpBase & (McpStdioConfig | McpHttpConfig | McpSseConfig);

// Alias for clarity in call-sites that accept any transport.
export type AnyMcpServerConfig = McpServerConfig;

// ── Status / tool types ─────────────────────────────────────────────────

export type McpServerStatus = "connected" | "disconnected" | "error" | "connecting";

export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

export type McpServerInfo = McpServerConfig & {
  status: McpServerStatus;
  error?: string;
  tools?: McpTool[];
  toolCount?: number;
};

// ── Validation ──────────────────────────────────────────────────────────

const ID_RE = /^[a-z][a-z0-9_-]{1,30}$/;
const URL_RE = /^https?:\/\/.+/i;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validateMcpServerConfig(raw: unknown): string | null {
  if (!isRecord(raw)) return "Invalid MCP server config";
  const r = raw as Record<string, unknown>;

  if (typeof r.id !== "string" || !r.id.trim()) return "id is required";
  if (!ID_RE.test(r.id)) return "id must be lowercase alphanumeric with -/_ (2-31 chars)";
  if (typeof r.name !== "string" || !r.name.trim()) return "name is required";
  if (r.description !== undefined && typeof r.description !== "string") return "description must be a string";
  if (r.enabled !== undefined && typeof r.enabled !== "boolean") return "enabled must be boolean";
  if (typeof r.transport !== "string") return "transport is required";
  if (!MCP_TRANSPORTS.includes(r.transport as McpTransport)) return `transport must be one of ${MCP_TRANSPORTS.join(", ")}`;

  const transport = r.transport as McpTransport;

  if (transport === "stdio") {
    if (typeof r.command !== "string" || !r.command.trim()) return "command is required for stdio transport";
    // Strict separation: url/headers/timeout belong to http/sse, not stdio
    if (r.url !== undefined) return "url is not allowed for stdio transport (use command instead)";
    if (r.headers !== undefined) return "headers is not allowed for stdio transport (use env instead)";
    if (r.timeout !== undefined) return "timeout is not allowed for stdio transport";
    if (r.args !== undefined) {
      if (!Array.isArray(r.args)) return "args must be an array for stdio transport";
      for (const a of r.args) if (typeof a !== "string") return "args must be strings";
    }
    if (r.env !== undefined) {
      if (!isRecord(r.env)) return "env must be an object for stdio transport";
      for (const [k, v] of Object.entries(r.env)) {
        if (typeof v !== "string") return `env["${k}"] must be a string`;
        if (!k.trim()) return "env keys cannot be empty";
      }
    }
    if (r.cwd !== undefined && typeof r.cwd !== "string") return "cwd must be a string";
    return null;
  }

  // http / sse: url + headers + timeout, no command/args/env
  if (transport === "http" || transport === "sse") {
    if (typeof r.url !== "string" || !r.url.trim()) return `url is required for ${transport} transport`;
    if (!URL_RE.test(r.url as string)) return "url must be http(s)://...";
    try {
      // Validate URL structure
      new URL(r.url as string);
    } catch {
      return "url must be a valid URL";
    }
    // Strict separation: command/args/env belong to stdio, not http/sse
    if (r.command !== undefined) return `command is not allowed for ${transport} transport (use url instead)`;
    if (r.args !== undefined) return `args is not allowed for ${transport} transport`;
    if (r.env !== undefined) return `env is not allowed for ${transport} transport (use headers instead)`;
    if (r.cwd !== undefined) return `cwd is not allowed for ${transport} transport`;
    if (r.headers !== undefined) {
      if (!isRecord(r.headers)) return "headers must be an object";
      for (const [k, v] of Object.entries(r.headers)) {
        if (typeof v !== "string") return `headers["${k}"] must be a string`;
        if (!k.trim()) return "headers keys cannot be empty";
      }
    }
    if (r.timeout !== undefined) {
      if (typeof r.timeout !== "number" || !Number.isFinite(r.timeout)) return "timeout must be a number (seconds)";
      if (r.timeout < MCP_TIMEOUT_SECONDS_MIN || r.timeout > MCP_TIMEOUT_SECONDS_MAX)
        return `timeout must be between ${MCP_TIMEOUT_SECONDS_MIN} and ${MCP_TIMEOUT_SECONDS_MAX} seconds`;
    }
    return null;
  }

  return "Unknown transport";
}

/** Normalize defaults (enabled, timeout, etc.) without mutating input. */
export function normalizeMcpServerConfig(cfg: McpServerConfig): McpServerConfig {
  const base: McpBase = {
    id: cfg.id,
    name: cfg.name,
    enabled: cfg.enabled ?? MCP_ENABLED_DEFAULT,
    ...(cfg.description ? { description: cfg.description } : {}),
  };
  if (cfg.transport === "stdio") {
    return {
      ...base,
      transport: "stdio",
      command: cfg.command,
      ...(cfg.args ? { args: [...cfg.args] } : {}),
      ...(cfg.env ? { env: { ...cfg.env } } : {}),
      ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
    };
  }
  if (cfg.transport === "http") {
    return {
      ...base,
      transport: "http",
      url: cfg.url,
      ...(cfg.headers ? { headers: { ...cfg.headers } } : {}),
      timeout: cfg.timeout ?? MCP_TIMEOUT_SECONDS_DEFAULT,
    };
  }
  return {
    ...base,
    transport: "sse",
    url: cfg.url,
    ...(cfg.headers ? { headers: { ...cfg.headers } } : {}),
    timeout: cfg.timeout ?? MCP_TIMEOUT_SECONDS_DEFAULT,
  };
}

// ── Helpers for secrets redaction ───────────────────────────────────────

export function redactMcpConfig(cfg: McpServerConfig): McpServerConfig {
  const copy = { ...cfg } as McpServerConfig;
  if (cfg.transport === "stdio" && cfg.env) {
    const redacted: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfg.env)) {
      redacted[k] = v ? "••••" + v.slice(-4) : v;
    }
    (copy as McpStdioConfig).env = redacted;
  }
  if ((cfg.transport === "http" || cfg.transport === "sse") && cfg.headers) {
    const redacted: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfg.headers)) {
      const lower = k.toLowerCase();
      if (lower.includes("auth") || lower.includes("key") || lower.includes("token") || lower.includes("bearer")) {
        redacted[k] = v ? "••••" + v.slice(-4) : v;
      } else {
        redacted[k] = v;
      }
    }
    (copy as McpHttpConfig | McpSseConfig).headers = redacted;
  }
  return copy;
}

// ── Factory for the EXA.ai default ──────────────────────────────────────

export function createExaMcpServer(overrides: Partial<McpHttpConfig> & { id?: string; name?: string } = {}): McpServerConfig {
  return normalizeMcpServerConfig({
    id: overrides.id ?? "exa",
    name: overrides.name ?? "Exa Search",
    description: "Exa AI web search — https://mcp.exa.ai/mcp (Streamable HTTP, no API key required for free tier)",
    enabled: true,
    transport: "http",
    url: overrides.url ?? "https://mcp.exa.ai/mcp",
    ...(overrides.headers ? { headers: overrides.headers } : {}),
    timeout: overrides.timeout ?? MCP_TIMEOUT_SECONDS_DEFAULT,
  });
}

// ── Route path constants ────────────────────────────────────────────────

export const MCP_ROUTE = "/api/mcp/servers";
export const MCP_SERVER_ROUTE = "/api/mcp/servers/:id";
export const MCP_SERVER_TOOLS_ROUTE = "/api/mcp/servers/:id/tools";
export const MCP_SERVER_CALL_TOOL_ROUTE = "/api/mcp/servers/:id/tools/call";
