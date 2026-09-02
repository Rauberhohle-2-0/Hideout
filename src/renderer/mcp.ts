/**
 * Renderer-side MCP library — headless helpers for the UI.
 *
 * Talks to the sidecar's `/api/mcp/*` routes. No MCP protocol logic here;
 * the sidecar (Bun + McpManager) owns transports and keeps env/headers out of
 * the webview except when the user explicitly edits them.
 *
 * Transport separation is surfaced to callers: use the discriminated
 * `McpServerConfig` from `src/shared/mcp.ts` — the UI must render different
 * forms for STDIO (command/args/env) vs HTTP/SSE (url/headers/timeout).
 */
import type { McpServerConfig, McpServerInfo, McpTool } from "../shared/mcp.ts";
import { MCP_ROUTE } from "../shared/mcp.ts";

export type { McpServerConfig, McpServerInfo, McpTool } from "../shared/mcp.ts";

async function handleError(res: Response): Promise<never> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    const text = await res.text().catch(() => "");
    throw new Error(text || `MCP request failed: ${res.status}`);
  }
  const msg = (body as { error?: string })?.error ?? `MCP request failed: ${res.status}`;
  throw new Error(msg);
}

export async function listMcpServers(): Promise<McpServerInfo[]> {
  const res = await fetch(MCP_ROUTE, { headers: { Accept: "application/json" } });
  if (!res.ok) await handleError(res);
  const data = (await res.json()) as { servers: McpServerInfo[] };
  return data.servers ?? [];
}

export async function getMcpServer(id: string): Promise<McpServerInfo> {
  const res = await fetch(`${MCP_ROUTE}/${encodeURIComponent(id)}`, { headers: { Accept: "application/json" } });
  if (!res.ok) await handleError(res);
  return (await res.json()) as McpServerInfo;
}

export async function createMcpServer(config: McpServerConfig): Promise<McpServerInfo> {
  const res = await fetch(MCP_ROUTE, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(config),
  });
  if (!res.ok) await handleError(res);
  return (await res.json()) as McpServerInfo;
}

export async function updateMcpServer(id: string, config: McpServerConfig): Promise<McpServerInfo> {
  const res = await fetch(`${MCP_ROUTE}/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(config),
  });
  if (!res.ok) await handleError(res);
  return (await res.json()) as McpServerInfo;
}

export async function deleteMcpServer(id: string): Promise<void> {
  const res = await fetch(`${MCP_ROUTE}/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) await handleError(res);
}

export async function connectMcpServer(id: string): Promise<McpServerInfo> {
  const res = await fetch(`${MCP_ROUTE}/${encodeURIComponent(id)}/connect`, { method: "POST" });
  if (!res.ok) await handleError(res);
  return (await res.json()) as McpServerInfo;
}

export async function disconnectMcpServer(id: string): Promise<McpServerInfo> {
  const res = await fetch(`${MCP_ROUTE}/${encodeURIComponent(id)}/disconnect`, { method: "POST" });
  if (!res.ok) await handleError(res);
  return (await res.json()) as McpServerInfo;
}

export async function listMcpTools(serverId: string): Promise<McpTool[]> {
  const res = await fetch(`${MCP_ROUTE}/${encodeURIComponent(serverId)}/tools`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) await handleError(res);
  const data = (await res.json()) as { tools: McpTool[] };
  return data.tools ?? [];
}

export async function callMcpTool(
  serverId: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const res = await fetch(`${MCP_ROUTE}/${encodeURIComponent(serverId)}/tools/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ name, arguments: args }),
  });
  if (!res.ok) await handleError(res);
  const data = (await res.json()) as { result: unknown };
  return data.result;
}
