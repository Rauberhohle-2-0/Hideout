/** Shared types and constants between Main, Preload and Renderer - security boundary types. */

export const HELLO_WORLD = "Hello World";

export const IPC_CHANNELS = {
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

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

// Shared AI wire types — no secrets ever cross this boundary
export interface AiProviderInfo {
  id: string;
  displayName: string;
  kind: "local" | "cloud";
  capabilities: { chat: boolean; streaming: boolean; embeddings?: boolean; tools?: boolean; vision?: boolean };
  config: { id: string; displayName?: string; baseUrl?: string; defaultModel?: string };
}

export interface AiChatIpcRequest {
  providerId: string;
  messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string[];
}

export interface AiChatIpcResponse {
  id: string;
  model: string;
  created: number;
  content: string;
  finishReason: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

// MCP wire types — never include raw secrets (values are "***" if present)
export type McpTransportType = "stdio" | "http" | "sse";

export interface McpServerSafe {
  id: string;
  name: string;
  transport: McpTransportType;
  enabled: boolean;
  description?: string;
  stdio?: { command: string; args?: string[]; env?: Record<string, string>; cwd?: string };
  http?: { url: string; headers?: Record<string, string>; timeoutSeconds?: number };
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

export interface McpAddServerRequest {
  id: string;
  name: string;
  transport: McpTransportType;
  enabled?: boolean;
  description?: string;
  stdio?: { command: string; args?: string[]; env?: Record<string, string>; cwd?: string };
  http?: { url: string; headers?: Record<string, string>; timeoutSeconds?: number };
  sse?: { url: string; headers?: Record<string, string>; timeoutSeconds?: number };
}

/** Minimal API exposed to renderer via contextBridge */
export interface Api {
  getHelloWorld(): Promise<string>;
  ping(): Promise<string>;
  // AI — universal provider interface (Ollama today, OpenAI/Claude tomorrow)
  aiListProviders(): Promise<AiProviderInfo[]>;
  aiHealth(providerId: string): Promise<{ ok: boolean; latencyMs?: number; version?: string; error?: string }>;
  aiListModels(providerId: string): Promise<Array<{ id: string; name: string; ownedBy?: string }>>;
  aiChat(req: AiChatIpcRequest): Promise<AiChatIpcResponse>;
  // MCP — transport-agnostic, secrets never cross to renderer
  mcpListServers(): Promise<McpServerSafe[]>;
  mcpGetServer(id: string): Promise<McpServerSafe>;
  mcpAddServer(config: McpAddServerRequest): Promise<McpServerSafe>;
  mcpUpdateServer(id: string, patch: Partial<McpAddServerRequest>): Promise<McpServerSafe>;
  mcpRemoveServer(id: string): Promise<{ ok: true }>;
  mcpHealth(id: string): Promise<{ ok: boolean; latencyMs?: number; error?: string; version?: string }>;
  mcpListTools(id: string): Promise<Array<{ name: string; description?: string }>>;
  mcpConnect(id: string): Promise<McpServerStatus>;
  mcpDisconnect(id: string): Promise<{ ok: true }>;
  mcpSetEnabled(id: string, enabled: boolean): Promise<McpServerSafe>;
}

declare global {
  interface Window {
    api: Api;
  }
}
