/**
 * MCP (Model Context Protocol) types — transport-agnostic config.
 *
 * SECURITY:
 * - Secrets (env values that look like API keys, header values) are NEVER stored
 *   in plain JSON. They are written to SecureStore (OS keychain via safeStorage)
 *   under keys `mcp:${serverId}:env:${VAR}` / `mcp:${serverId}:header:${NAME}`.
 * - Safe configs returned to renderer / API omit secrets (values replaced with "***"
 *   or omitted). Logs redact via logger's SENSITIVE_KEY_PATTERN.
 * - All IDs validated against KEY_RE to prevent path traversal.
 */

export type McpTransportType = "stdio" | "http" | "sse";

export interface McpStdioConfig {
  /** Command to spawn — e.g. "npx", "uvx", "node", "python3" */
  command: string;
  /** Arguments for the command — e.g. ["-y", "exa-mcp-server"] */
  args?: string[];
  /** Environment variables for the child process. Values that look like secrets are stored encrypted. */
  env?: Record<string, string>;
  /** Optional working directory */
  cwd?: string;
}

export interface McpHttpConfig {
  /** URL of the MCP server — http(s)://... */
  url: string;
  /** Optional headers — values are secrets (encrypted at rest) */
  headers?: Record<string, string>;
  /** Timeout in seconds (converted to ms internally). Common default 30 */
  timeoutSeconds?: number;
}

/** SSE shares the same shape as HTTP (Streamable HTTP vs SSE) */
export type McpSseConfig = McpHttpConfig;

export interface McpServerConfig {
  /** Unique id — slug, e.g. "exa", "my-stdio-tool" */
  id: string;
  /** Human-readable name */
  name: string;
  /** Transport type */
  transport: McpTransportType;
  /** Whether server is enabled (default true) */
  enabled?: boolean;
  /** Optional description */
  description?: string;

  /** Required when transport === "stdio" */
  stdio?: McpStdioConfig;
  /** Required when transport === "http" | "sse" */
  http?: McpHttpConfig; // used for both http and sse for simplicity
  // Alias: for SSE callers that prefer `sse` key, we normalize to `http`
  sse?: McpSseConfig;
}

export interface McpServerSafe {
  id: string;
  name: string;
  transport: McpTransportType;
  enabled: boolean;
  description?: string;
  stdio?: {
    command: string;
    args?: string[];
    env?: Record<string, string>; // values redacted or omitted
    cwd?: string;
  };
  http?: {
    url: string;
    headers?: Record<string, string>; // redacted
    timeoutSeconds?: number;
  };
}

export interface McpServerStatus {
  id: string;
  connected: boolean;
  transport: McpTransportType;
  error?: string;
  latencyMs?: number;
  lastConnectedAt?: string;
  toolCount?: number;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpServerInfo {
  config: McpServerSafe;
  status: McpServerStatus;
  tools?: McpTool[];
}

/** Preset for Exa.ai — free, no API key required */
export const EXA_MCP_PRESET: McpServerConfig = {
  id: "exa",
  name: "Exa AI",
  transport: "stdio",
  enabled: true,
  description: "Exa.ai web search MCP — free, no API key required. Provides web_search and related tools.",
  stdio: {
    command: "npx",
    args: ["-y", "exa-mcp-server"],
    env: {},
  },
};

/** Alternative HTTP preset for Exa if user runs remote SSE/HTTP endpoint */
export const EXA_MCP_HTTP_PRESET: McpServerConfig = {
  id: "exa-http",
  name: "Exa AI (HTTP)",
  transport: "http",
  enabled: true,
  description: "Exa.ai MCP over HTTP/SSE — configure URL if you self-host the MCP server.",
  http: {
    url: "http://127.0.0.1:3000/mcp",
    timeoutSeconds: 30,
  },
};
