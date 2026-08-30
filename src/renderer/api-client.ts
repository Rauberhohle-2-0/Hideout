/**
 * The `Api` implementation the interface talks to.
 *
 * Under Electron this was a contextBridge over IPC; under Vantail it is HTTP
 * to the sidecar. The interface never learns the difference — `Api` is
 * unchanged, so every call site in renderer.ts is unchanged too.
 *
 * Requests go through `network.request` (the runtime's HTTP client) rather
 * than the webview's `fetch`. That matters for two reasons: the page is served
 * from `vantail://`, so `fetch` to a loopback port would be a cross-origin
 * request needing CORS headers on the server; and routing through the runtime
 * means the sidecar's host is covered by `permissions.network` in
 * vantail.config.ts rather than by nothing at all.
 */

import { network } from "@vantail/api";
import type {
  AiChatIpcRequest,
  AiChatIpcResponse,
  AiProviderInfo,
  Api,
  AssistantAddRequest,
  AssistantSafe,
  McpAddServerRequest,
  McpServerSafe,
  McpServerStatus,
} from "../shared/api.ts";

export interface SidecarConnection {
  baseUrl: string;
  token: string;
}

/** The error body every route uses for a failure. */
interface ErrorBody {
  error?: string;
  code?: string;
}

function messageFor(status: number, body: unknown): string {
  const err = body as ErrorBody | null;
  if (err && typeof err.error === "string") {
    return err.code ? `${err.code}: ${err.error}` : err.error;
  }
  return `Request failed with status ${status}`;
}

export function createApiClient(connection: SidecarConnection): Api {
  const { baseUrl, token } = connection;

  /**
   * `expectOk: false` is for the endpoints where a non-2xx *is* the answer:
   * health returns 503 with a populated body when a provider is down, and
   * connect returns 502 with a status object. Throwing there would turn a
   * reportable state into an exception the interface has to unpick.
   */
  async function call<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    options: { body?: unknown; expectOk?: boolean } = {},
  ): Promise<T> {
    const { body, expectOk = true } = options;
    const response = await network.json<T>({
      url: `${baseUrl}${path}`,
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (!response.ok && expectOk) {
      throw new Error(messageFor(response.status, response.body));
    }
    return response.body;
  }

  /** Path segments are user-chosen ids; encode so a slash cannot invent a route. */
  const seg = (id: string): string => encodeURIComponent(id);

  return {
    async getHelloWorld(): Promise<string> {
      const { message } = await call<{ message: string }>("GET", "/api/hello");
      if (typeof message !== "string") throw new Error("Invalid response");
      return message;
    },

    async ping(): Promise<string> {
      const { status } = await call<{ status: string }>("GET", "/health");
      return status === "ok" ? "pong" : status;
    },

    // ---- AI ----

    async aiListProviders(): Promise<AiProviderInfo[]> {
      const { providers } = await call<{ providers: AiProviderInfo[] }>("GET", "/api/ai/providers");
      if (!Array.isArray(providers)) throw new Error("Invalid response");
      return providers;
    },

    async aiHealth(providerId: string) {
      return call<Awaited<ReturnType<Api["aiHealth"]>>>(
        "GET",
        `/api/ai/providers/${seg(providerId)}/health`,
        { expectOk: false },
      );
    },

    async aiListModels(providerId: string) {
      const { models } = await call<{ models: Awaited<ReturnType<Api["aiListModels"]>> }>(
        "GET",
        `/api/ai/providers/${seg(providerId)}/models`,
      );
      if (!Array.isArray(models)) throw new Error("Invalid response");
      return models;
    },

    async aiChat(req: AiChatIpcRequest): Promise<AiChatIpcResponse> {
      return call<AiChatIpcResponse>("POST", "/api/ai/chat", { body: req });
    },

    // ---- MCP ----

    async mcpListServers(): Promise<McpServerSafe[]> {
      const { servers } = await call<{ servers: McpServerSafe[] }>("GET", "/api/mcp/servers");
      if (!Array.isArray(servers)) throw new Error("Invalid response");
      return servers;
    },

    async mcpGetServer(id: string): Promise<McpServerSafe> {
      const { server } = await call<{ server: McpServerSafe }>("GET", `/api/mcp/servers/${seg(id)}`);
      return server;
    },

    async mcpAddServer(config: McpAddServerRequest): Promise<McpServerSafe> {
      const { server } = await call<{ server: McpServerSafe }>("POST", "/api/mcp/servers", { body: config });
      return server;
    },

    async mcpUpdateServer(id: string, patch: Partial<McpAddServerRequest>): Promise<McpServerSafe> {
      const { server } = await call<{ server: McpServerSafe }>("PATCH", `/api/mcp/servers/${seg(id)}`, {
        body: patch,
      });
      return server;
    },

    async mcpRemoveServer(id: string): Promise<{ ok: true }> {
      return call<{ ok: true }>("DELETE", `/api/mcp/servers/${seg(id)}`);
    },

    async mcpHealth(id: string) {
      return call<Awaited<ReturnType<Api["mcpHealth"]>>>("GET", `/api/mcp/servers/${seg(id)}/health`, {
        expectOk: false,
      });
    },

    async mcpListTools(id: string) {
      const { tools } = await call<{ tools: Awaited<ReturnType<Api["mcpListTools"]>> }>(
        "GET",
        `/api/mcp/servers/${seg(id)}/tools`,
      );
      if (!Array.isArray(tools)) throw new Error("Invalid response");
      return tools;
    },

    async mcpConnect(id: string): Promise<McpServerStatus> {
      return call<McpServerStatus>("POST", `/api/mcp/servers/${seg(id)}/connect`, { expectOk: false });
    },

    async mcpDisconnect(id: string): Promise<{ ok: true }> {
      return call<{ ok: true }>("POST", `/api/mcp/servers/${seg(id)}/disconnect`);
    },

    async mcpSetEnabled(id: string, enabled: boolean): Promise<McpServerSafe> {
      const { server } = await call<{ server: McpServerSafe }>("POST", `/api/mcp/servers/${seg(id)}/enabled`, {
        body: { enabled },
      });
      return server;
    },

    // ---- Assistants ----

    async assistantList(): Promise<AssistantSafe[]> {
      const { assistants } = await call<{ assistants: AssistantSafe[] }>("GET", "/api/assistants");
      if (!Array.isArray(assistants)) throw new Error("Invalid response");
      return assistants;
    },

    async assistantGet(id: string): Promise<AssistantSafe> {
      const { assistant } = await call<{ assistant: AssistantSafe }>("GET", `/api/assistants/${seg(id)}`);
      return assistant;
    },

    async assistantAdd(config: AssistantAddRequest): Promise<AssistantSafe> {
      const { assistant } = await call<{ assistant: AssistantSafe }>("POST", "/api/assistants", { body: config });
      return assistant;
    },

    async assistantUpdate(id: string, patch: Partial<AssistantAddRequest>): Promise<AssistantSafe> {
      const { assistant } = await call<{ assistant: AssistantSafe }>("PATCH", `/api/assistants/${seg(id)}`, {
        body: patch,
      });
      return assistant;
    },

    async assistantRemove(id: string): Promise<{ ok: true }> {
      return call<{ ok: true }>("DELETE", `/api/assistants/${seg(id)}`);
    },

    async assistantSetEnabled(id: string, enabled: boolean): Promise<AssistantSafe> {
      const { assistant } = await call<{ assistant: AssistantSafe }>("POST", `/api/assistants/${seg(id)}/enabled`, {
        body: { enabled },
      });
      return assistant;
    },
  };
}
