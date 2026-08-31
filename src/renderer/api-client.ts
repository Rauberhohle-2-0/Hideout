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
  ChatAddRequest,
  ChatSafe,
  ChatStreamEvent,
  ChatStreamHandlers,
  McpAddServerRequest,
  McpServerSafe,
  McpServerStatus,
  McpToolCallResult,
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

/** Parse one SSE block (multiple `name: value` lines) into a ChatStreamEvent. */
function parseSseBlock(block: string): ChatStreamEvent | undefined {
  let eventType = "";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (!line) continue;
    if (line.startsWith("event:")) eventType = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  const data = dataLines.join("\n");
  if (!data) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return undefined;
  }
  const obj = payload as Record<string, unknown>;
  const type = obj.type ?? eventType;
  switch (type) {
    case "delta":
      return { type: "delta", delta: String(obj.delta ?? ""), model: String(obj.model ?? "") };
    case "reasoning":
      return { type: "reasoning", delta: String(obj.delta ?? ""), model: String(obj.model ?? "") };
    case "tool_start":
      return {
        type: "tool_start",
        tool: String(obj.tool ?? ""),
        args: (obj.args ?? {}) as Record<string, unknown>,
      };
    case "tool_end":
      return { type: "tool_end", tool: String(obj.tool ?? ""), ok: Boolean(obj.ok), result: String(obj.result ?? "") };
    case "done":
      return { type: "done", model: String(obj.model ?? ""), finishReason: String(obj.finishReason ?? "stop") };
    case "error":
      return { type: "error", error: String(obj.error ?? "Unknown error"), code: obj.code as string | undefined };
    default:
      return undefined;
  }
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

    // ---- Streaming chat (SSE over the agent tool-loop) ----
    async aiChatStream(req: AiChatIpcRequest, handlers: ChatStreamHandlers): Promise<void> {
      // The runtime's default request timeout is 30 s, but this stream can
      // legitimately sit silent for longer: the agent collects MCP tools first
      // (Exa is spawned via `npx`), and reasoning models may "think" for a while
      // before their first token. Raise it so a slow start does not trip the
      // transport and surface as a bogus disconnect.
      const stream = await network.stream({
        url: `${baseUrl}/api/ai/chat/stream`,
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify(req),
        timeoutMs: 10 * 60_000,
      });

      // SSE framing: events are separated by blank lines; each field is a line
      // `name: value`. Chunks may split lines, so buffer until a `\n\n`.
      let buffer = "";
      const offChunk = stream.onChunk((chunk) => {
        buffer += chunk;
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const event = parseSseBlock(block);
          if (event) handlers.onEvent(event);
        }
      });
      const offEnd = stream.onEnd(({ error }) => {
        // Flush any trailing block that lacked a closing blank line.
        if (buffer.trim()) {
          const event = parseSseBlock(buffer);
          if (event) handlers.onEvent(event);
        }
        offChunk();
        offEnd();
        handlers.onEnd(error);
      });
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

    async mcpCallTool(id: string, name: string, args?: Record<string, unknown>): Promise<McpToolCallResult> {
      return call<McpToolCallResult>("POST", `/api/mcp/servers/${seg(id)}/call`, {
        body: { name, arguments: args },
      });
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

    // ---- Chats ----

    async chatList(): Promise<ChatSafe[]> {
      const { chats } = await call<{ chats: ChatSafe[] }>("GET", "/api/chats");
      if (!Array.isArray(chats)) throw new Error("Invalid response");
      return chats;
    },

    async chatGet(id: string): Promise<ChatSafe> {
      const { chat } = await call<{ chat: ChatSafe }>("GET", `/api/chats/${seg(id)}`);
      return chat;
    },

    async chatCreate(config: ChatAddRequest): Promise<ChatSafe> {
      const { chat } = await call<{ chat: ChatSafe }>("POST", "/api/chats", { body: config });
      return chat;
    },

    async chatUpdate(id: string, patch: Partial<ChatAddRequest>): Promise<ChatSafe> {
      const { chat } = await call<{ chat: ChatSafe }>("PATCH", `/api/chats/${seg(id)}`, { body: patch });
      return chat;
    },

    async chatRemove(id: string): Promise<{ ok: true }> {
      return call<{ ok: true }>("DELETE", `/api/chats/${seg(id)}`);
    },

    async chatSetPinned(id: string, pinned: boolean): Promise<ChatSafe> {
      const { chat } = await call<{ chat: ChatSafe }>("POST", `/api/chats/${seg(id)}/pinned`, {
        body: { pinned },
      });
      return chat;
    },
  };
}
