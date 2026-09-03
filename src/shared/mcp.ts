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
 *
 * User-configured servers persist in the OS user-data directory. Code-owned
 * built-ins (Exa) are defined in code, never persisted, and exposed to the
 * UI as read-only (`builtIn: true` on `McpServerInfo`).
 */

export const MCP_TRANSPORTS = ["stdio", "http", "sse"] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

// ── Code-owned built-ins ────────────────────────────────────────────────
// Exa is Hideout's default web-search provider. It is defined in code (see
// `createExaMcpServer`) and is intentionally NOT persisted to the user MCP
// file — the store only ever holds user-configured servers.

/** Id of the built-in Exa server. Reserved: user configs with this id are rejected. */
export const EXA_SERVER_ID = "exa";
/** Exa Streamable HTTP endpoint (free tier, no API key required). */
export const EXA_SERVER_URL = "https://mcp.exa.ai/mcp";

export const MCP_ENABLED_DEFAULT = true;
export const MCP_TIMEOUT_SECONDS_DEFAULT = 30;
export const MCP_TIMEOUT_SECONDS_MIN = 1;
export const MCP_TIMEOUT_SECONDS_MAX = 600;

// ── Field/row limits (enforced in validateMcpServerConfig) ─────────────
export const MCP_MAX_NAME_LENGTH = 200;
export const MCP_MAX_DESCRIPTION_LENGTH = 2000;
export const MCP_MAX_URL_LENGTH = 2000;
export const MCP_MAX_COMMAND_LENGTH = 4000;
export const MCP_MAX_CWD_LENGTH = 2000;
export const MCP_MAX_ARGS = 64;
export const MCP_MAX_ARG_LENGTH = 1000;
export const MCP_MAX_HEADER_ENTRIES = 64;
export const MCP_MAX_ENV_ENTRIES = 64;
export const MCP_MAX_KEY_LENGTH = 200;
export const MCP_MAX_VALUE_LENGTH = 8192;

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
  /**
   * Opt-in to loopback/private/link-local/metadata network targets.
   * Defaults to `false`: the SSRF guard blocks such destinations unless the
   * user explicitly sets this flag (Phase 1 will surface it in a trust UI).
   */
  privateNetworkAllowed?: boolean;
};

/** SSE = legacy Server-Sent Events. Same shape as HTTP, distinct transport. */
export type McpSseConfig = {
  transport: "sse";
  url: string;
  headers?: Record<string, string>;
  timeout?: number;
  /** See `McpHttpConfig.privateNetworkAllowed`. */
  privateNetworkAllowed?: boolean;
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

export type McpServerStatus = "connected" | "disconnected" | "error" | "connecting" | "needs-approval";

/**
 * `needs-approval` applies only to STDIO servers whose persisted config has
 * no matching trust record (or whose command/args/cwd changed after the last
 * approval). Such servers never spawn until the user approves them through
 * the sidecar's approve route — even when a chat/web-search flow would
 * otherwise auto-connect them.
 */
export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

export type McpServerInfo = McpServerConfig & {
  status: McpServerStatus;
  /** True for code-owned built-ins (Exa): listed and usable, but never persisted or user-editable. */
  builtIn?: boolean;
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

  // Generic size limits shared by every transport.
  if (typeof r.name === "string" && r.name.length > MCP_MAX_NAME_LENGTH) {
    return `name must be at most ${MCP_MAX_NAME_LENGTH} characters`;
  }
  if (typeof r.description === "string" && r.description.length > MCP_MAX_DESCRIPTION_LENGTH) {
    return `description must be at most ${MCP_MAX_DESCRIPTION_LENGTH} characters`;
  }
  if (r.privateNetworkAllowed !== undefined && typeof r.privateNetworkAllowed !== "boolean") {
    return "privateNetworkAllowed must be boolean";
  }

  if (transport === "stdio") {
    if (typeof r.command !== "string" || !r.command.trim()) return "command is required for stdio transport";
    if (r.command.length > MCP_MAX_COMMAND_LENGTH) return `command must be at most ${MCP_MAX_COMMAND_LENGTH} characters`;
    // Strict separation: url/headers/timeout belong to http/sse, not stdio
    if (r.url !== undefined) return "url is not allowed for stdio transport (use command instead)";
    if (r.headers !== undefined) return "headers is not allowed for stdio transport (use env instead)";
    if (r.timeout !== undefined) return "timeout is not allowed for stdio transport";
    if (r.privateNetworkAllowed !== undefined) return "privateNetworkAllowed is not allowed for stdio transport";
    if (r.args !== undefined) {
      if (!Array.isArray(r.args)) return "args must be an array for stdio transport";
      if (r.args.length > MCP_MAX_ARGS) return `args must be at most ${MCP_MAX_ARGS} entries`;
      for (const a of r.args) {
        if (typeof a !== "string") return "args must be strings";
        if (a.length > MCP_MAX_ARG_LENGTH) return `args entries must be at most ${MCP_MAX_ARG_LENGTH} characters`;
      }
    }
    if (r.env !== undefined) {
      if (!isRecord(r.env)) return "env must be an object for stdio transport";
      const entries = Object.entries(r.env);
      if (entries.length > MCP_MAX_ENV_ENTRIES) return `env must be at most ${MCP_MAX_ENV_ENTRIES} entries`;
      for (const [k, v] of entries) {
        if (typeof v !== "string") return `env["${k}"] must be a string`;
        if (!k.trim()) return "env keys cannot be empty";
        if (k.length > MCP_MAX_KEY_LENGTH) return `env keys must be at most ${MCP_MAX_KEY_LENGTH} characters`;
        if (v.length > MCP_MAX_VALUE_LENGTH) return `env values must be at most ${MCP_MAX_VALUE_LENGTH} characters`;
      }
    }
    if (r.cwd !== undefined) {
      if (typeof r.cwd !== "string") return "cwd must be a string";
      if (r.cwd.length > MCP_MAX_CWD_LENGTH) return `cwd must be at most ${MCP_MAX_CWD_LENGTH} characters`;
    }
    return null;
  }

  // http / sse: url + headers + timeout, no command/args/env
  if (transport === "http" || transport === "sse") {
    if (typeof r.url !== "string" || !r.url.trim()) return `url is required for ${transport} transport`;
    if (!URL_RE.test(r.url as string)) return "url must be http(s)://...";
    if ((r.url as string).length > MCP_MAX_URL_LENGTH) return `url must be at most ${MCP_MAX_URL_LENGTH} characters`;
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
      const entries = Object.entries(r.headers);
      if (entries.length > MCP_MAX_HEADER_ENTRIES) return `headers must be at most ${MCP_MAX_HEADER_ENTRIES} entries`;
      for (const [k, v] of entries) {
        if (typeof v !== "string") return `headers["${k}"] must be a string`;
        if (!k.trim()) return "headers keys cannot be empty";
        if (k.length > MCP_MAX_KEY_LENGTH) return `headers keys must be at most ${MCP_MAX_KEY_LENGTH} characters`;
        if (v.length > MCP_MAX_VALUE_LENGTH) return `headers values must be at most ${MCP_MAX_VALUE_LENGTH} characters`;
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
  const remoteBase = {
    ...base,
    url: cfg.url,
    ...(cfg.headers ? { headers: { ...cfg.headers } } : {}),
    timeout: cfg.timeout ?? MCP_TIMEOUT_SECONDS_DEFAULT,
    ...(cfg.privateNetworkAllowed !== undefined ? { privateNetworkAllowed: cfg.privateNetworkAllowed } : {}),
  };
  if (cfg.transport === "http") {
    return { ...remoteBase, transport: "http" } as McpServerConfig;
  }
  return { ...remoteBase, transport: "sse" } as McpServerConfig;
}

// ── Helpers for secrets redaction ───────────────────────────────────────

/** Mask a single secret value: `••••` + last 4 chars. */
export function maskMcpSecretValue(value: string): string {
  return value ? `••••${value.slice(-4)}` : value;
}

/**
 * Whether a header key looks secret (auth/key/token/bearer). Keyword-based;
 * Phase 1 replaces this with explicit secret-field declarations.
 */
export function isSensitiveHeaderKey(key: string): boolean {
  const lower = key.toLowerCase();
  return lower.includes("auth") || lower.includes("key") || lower.includes("token") || lower.includes("bearer");
}

/**
 * True when `incoming` is exactly the masked form of `stored` — i.e. the
 * caller echoed the redacted value back instead of typing a new secret.
 * Used by the preserve-on-update merge so an edit that only changes the
 * display name cannot destroy stored header/env secrets.
 */
export function isMaskedValueOf(incoming: string, stored: string): boolean {
  return stored !== "" && incoming === maskMcpSecretValue(stored);
}

/** Redact the secret-bearing fields of a config for renderer-facing output. */
export function redactMcpConfig(cfg: McpServerConfig): McpServerConfig {
  const copy = { ...cfg } as McpServerConfig;
  if (cfg.transport === "stdio" && cfg.env) {
    const redacted: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfg.env)) {
      redacted[k] = maskMcpSecretValue(v);
    }
    (copy as McpStdioConfig).env = redacted;
  }
  if ((cfg.transport === "http" || cfg.transport === "sse") && cfg.headers) {
    const redacted: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfg.headers)) {
      redacted[k] = isSensitiveHeaderKey(k) ? maskMcpSecretValue(v) : v;
    }
    (copy as McpHttpConfig | McpSseConfig).headers = redacted;
  }
  return copy;
}

/**
 * Merge a freshly submitted config with the stored raw config so masked
 * echoes of stored secrets (`••••abcd`) keep the stored raw value instead
 * of overwriting it. The submitted key set stays authoritative: keys the
 * caller removed are removed, keys added with a real value are stored raw.
 * Returns a new config; never mutates either input.
 */
export function mergePreservedSecrets(stored: McpServerConfig, incoming: McpServerConfig): McpServerConfig {
  const out = { ...incoming } as McpServerConfig;
  if (stored.transport !== incoming.transport) return out;

  if (incoming.transport === "stdio") {
    const st = stored as McpStdioConfig;
    const inc = incoming as McpStdioConfig;
    if (st.env && inc.env) {
      const merged: Record<string, string> = {};
      for (const [k, v] of Object.entries(inc.env)) {
        const previous = st.env[k];
        merged[k] = previous !== undefined && isMaskedValueOf(v, previous) ? previous : v;
      }
      (out as McpStdioConfig).env = merged;
    }
  } else if (incoming.transport === "http" || incoming.transport === "sse") {
    const st = stored as McpHttpConfig | McpSseConfig;
    const inc = incoming as McpHttpConfig | McpSseConfig;
    if (st.headers && inc.headers) {
      const merged: Record<string, string> = {};
      for (const [k, v] of Object.entries(inc.headers)) {
        const previous = st.headers[k];
        merged[k] =
          previous !== undefined && isSensitiveHeaderKey(k) && isMaskedValueOf(v, previous) ? previous : v;
      }
      (out as McpHttpConfig | McpSseConfig).headers = merged;
    }
  }
  return out;
}

// ── Factory for the EXA.ai default ──────────────────────────────────────

export function createExaMcpServer(overrides: Partial<McpHttpConfig> & { id?: string; name?: string } = {}): McpServerConfig {
  return normalizeMcpServerConfig({
    id: overrides.id ?? EXA_SERVER_ID,
    name: overrides.name ?? "Exa Search",
    description: "Exa AI web search — https://mcp.exa.ai/mcp (Streamable HTTP, no API key required for free tier)",
    enabled: true,
    transport: "http",
    url: overrides.url ?? EXA_SERVER_URL,
    ...(overrides.headers ? { headers: overrides.headers } : {}),
    timeout: overrides.timeout ?? MCP_TIMEOUT_SECONDS_DEFAULT,
  });
}

// ── Route path constants ────────────────────────────────────────────────

export const MCP_ROUTE = "/api/mcp/servers";
export const MCP_SERVER_ROUTE = "/api/mcp/servers/:id";
export const MCP_SERVER_TOOLS_ROUTE = "/api/mcp/servers/:id/tools";
export const MCP_SERVER_CALL_TOOL_ROUTE = "/api/mcp/servers/:id/tools/call";

// ── Per-server trust & policy audit trail ───────────────────────────────

/** Trust- and policy-relevant events recorded sidecar-side per server. */
export type McpAuditEventType = "approve" | "revoke" | "relock" | "network" | "deleted";

/** One audit entry. `detail` is a short human string with NO secret values. */
export type McpAuditEvent = {
  /** ms since epoch. */
  at: number;
  type: McpAuditEventType;
  detail: string;
};

/** Events kept per server (ring buffer). */
export const MCP_AUDIT_LIMIT = 30;

export const MCP_AUDIT_ROUTE = "/api/mcp/servers/:id/audit";
