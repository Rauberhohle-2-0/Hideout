import { contextBridge, ipcRenderer } from "electron";
import type { Api } from "../shared/api.ts";

// Inlined to keep preload self-contained for sandbox CJS bundle (avoids ESM import of shared)
const IPC_CHANNELS = {
  HELLO_WORLD: "hello-world",
  PING: "ping",
  AI_LIST_PROVIDERS: "ai:list-providers",
  AI_HEALTH: "ai:health",
  AI_LIST_MODELS: "ai:list-models",
  AI_CHAT: "ai:chat",
  MCP_LIST_SERVERS: "mcp:list-servers",
  MCP_GET_SERVER: "mcp:get-server",
  MCP_ADD_SERVER: "mcp:add-server",
  MCP_UPDATE_SERVER: "mcp:update-server",
  MCP_REMOVE_SERVER: "mcp:remove-server",
  MCP_HEALTH: "mcp:health",
  MCP_LIST_TOOLS: "mcp:list-tools",
  MCP_CONNECT: "mcp:connect",
  MCP_DISCONNECT: "mcp:disconnect",
  MCP_SET_ENABLED: "mcp:set-enabled",
} as const;

// Minimal, validated IPC API - Renderer = untrusted
// Never expose ipcRenderer directly, shell, fs, or Node access.
function assertString(v: unknown, label: string): string {
  if (typeof v !== "string") throw new Error(`Invalid ${label}`);
  return v;
}

const api: Api = {
  getHelloWorld: async (): Promise<string> => {
    const result = await ipcRenderer.invoke(IPC_CHANNELS.HELLO_WORLD);
    if (typeof result !== "string") throw new Error("Invalid response");
    return result;
  },
  ping: async (): Promise<string> => {
    const result = await ipcRenderer.invoke(IPC_CHANNELS.PING);
    if (typeof result !== "string") throw new Error("Invalid response");
    return result;
  },
  aiListProviders: async () => {
    const res = await ipcRenderer.invoke(IPC_CHANNELS.AI_LIST_PROVIDERS);
    if (!Array.isArray(res)) throw new Error("Invalid response");
    return res as Api extends { aiListProviders(): Promise<infer T> } ? T : never;
  },
  aiHealth: async (providerId: string) => {
    assertString(providerId, "providerId");
    const res = await ipcRenderer.invoke(IPC_CHANNELS.AI_HEALTH, providerId);
    if (!res || typeof res !== "object" || typeof (res as { ok: unknown }).ok !== "boolean") {
      throw new Error("Invalid response");
    }
    return res as Awaited<ReturnType<Api["aiHealth"]>>;
  },
  aiListModels: async (providerId: string) => {
    assertString(providerId, "providerId");
    const res = await ipcRenderer.invoke(IPC_CHANNELS.AI_LIST_MODELS, providerId);
    if (!Array.isArray(res)) throw new Error("Invalid response");
    return res as Awaited<ReturnType<Api["aiListModels"]>>;
  },
  aiChat: async (req) => {
    if (!req || typeof req.providerId !== "string" || !Array.isArray(req.messages)) {
      throw new Error("Invalid request");
    }
    const res = await ipcRenderer.invoke(IPC_CHANNELS.AI_CHAT, req);
    if (!res || typeof (res as { content: unknown }).content !== "string") throw new Error("Invalid response");
    return res as Awaited<ReturnType<Api["aiChat"]>>;
  },
  mcpListServers: async () => {
    const res = await ipcRenderer.invoke(IPC_CHANNELS.MCP_LIST_SERVERS);
    if (!Array.isArray(res)) throw new Error("Invalid response");
    return res as Awaited<ReturnType<Api["mcpListServers"]>>;
  },
  mcpGetServer: async (id: string) => {
    assertString(id, "id");
    const res = await ipcRenderer.invoke(IPC_CHANNELS.MCP_GET_SERVER, id);
    if (!res || typeof (res as { id: unknown }).id !== "string") throw new Error("Invalid response");
    return res as Awaited<ReturnType<Api["mcpGetServer"]>>;
  },
  mcpAddServer: async (config) => {
    if (!config || typeof config.id !== "string" || typeof config.name !== "string") throw new Error("Invalid request");
    const res = await ipcRenderer.invoke(IPC_CHANNELS.MCP_ADD_SERVER, config);
    if (!res || typeof (res as { id: unknown }).id !== "string") throw new Error("Invalid response");
    return res as Awaited<ReturnType<Api["mcpAddServer"]>>;
  },
  mcpUpdateServer: async (id: string, patch) => {
    assertString(id, "id");
    const res = await ipcRenderer.invoke(IPC_CHANNELS.MCP_UPDATE_SERVER, id, patch);
    if (!res || typeof (res as { id: unknown }).id !== "string") throw new Error("Invalid response");
    return res as Awaited<ReturnType<Api["mcpUpdateServer"]>>;
  },
  mcpRemoveServer: async (id: string) => {
    assertString(id, "id");
    const res = await ipcRenderer.invoke(IPC_CHANNELS.MCP_REMOVE_SERVER, id);
    if (!res || typeof (res as { ok: unknown }).ok !== "boolean") throw new Error("Invalid response");
    return res as Awaited<ReturnType<Api["mcpRemoveServer"]>>;
  },
  mcpHealth: async (id: string) => {
    assertString(id, "id");
    const res = await ipcRenderer.invoke(IPC_CHANNELS.MCP_HEALTH, id);
    if (!res || typeof (res as { ok: unknown }).ok !== "boolean") throw new Error("Invalid response");
    return res as Awaited<ReturnType<Api["mcpHealth"]>>;
  },
  mcpListTools: async (id: string) => {
    assertString(id, "id");
    const res = await ipcRenderer.invoke(IPC_CHANNELS.MCP_LIST_TOOLS, id);
    if (!Array.isArray(res)) throw new Error("Invalid response");
    return res as Awaited<ReturnType<Api["mcpListTools"]>>;
  },
  mcpConnect: async (id: string) => {
    assertString(id, "id");
    const res = await ipcRenderer.invoke(IPC_CHANNELS.MCP_CONNECT, id);
    if (!res || typeof (res as { connected: unknown }).connected !== "boolean") throw new Error("Invalid response");
    return res as Awaited<ReturnType<Api["mcpConnect"]>>;
  },
  mcpDisconnect: async (id: string) => {
    assertString(id, "id");
    const res = await ipcRenderer.invoke(IPC_CHANNELS.MCP_DISCONNECT, id);
    if (!res || typeof (res as { ok: unknown }).ok !== "boolean") throw new Error("Invalid response");
    return res as Awaited<ReturnType<Api["mcpDisconnect"]>>;
  },
  mcpSetEnabled: async (id: string, enabled: boolean) => {
    assertString(id, "id");
    if (typeof enabled !== "boolean") throw new Error("Invalid enabled");
    const res = await ipcRenderer.invoke(IPC_CHANNELS.MCP_SET_ENABLED, id, enabled);
    if (!res || typeof (res as { id: unknown }).id !== "string") throw new Error("Invalid response");
    return res as Awaited<ReturnType<Api["mcpSetEnabled"]>>;
  },
};

contextBridge.exposeInMainWorld("api", api);
