/**
 * Shared types between the interface and the sidecar — the wire contract.
 *
 * `Api` is deliberately unchanged from the Electron IPC era: the interface
 * calls the same methods, and only the transport underneath differs (see
 * src/renderer/api-client.ts). No secret appears in any type here.
 */

export const HELLO_WORLD = "Hello World";

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
  topK?: number;
  minP?: number;
  repeatPenalty?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
  stop?: string[];
  /** Optional adherence: run this chat as this assistant (system prompt + default params) */
  assistantId?: string;
  /** Whether the agent may call MCP tools (Exa etc.); default true */
  useTools?: boolean;
}

export interface AiChatIpcResponse {
  id: string;
  model: string;
  created: number;
  content: string;
  finishReason: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

// Assistant wire types — system prompt + sampling parameters + adherence to model
export interface AssistantParametersWire {
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  repeatPenalty?: number;
  maxTokens?: number;
  stop?: string[];
  seed?: number;
}

export interface AssistantSafe {
  id: string;
  name: string;
  description?: string;
  emoji?: string;
  instructions: string;
  parameters?: AssistantParametersWire;
  providerId?: string;
  model?: string;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface AssistantAddRequest {
  id: string;
  name: string;
  description?: string;
  emoji?: string;
  instructions: string;
  parameters?: AssistantParametersWire;
  providerId?: string;
  model?: string;
  enabled?: boolean;
}

// Chat wire types — persisted conversations, safe to expose
export interface ChatMessageWire {
  role: "user" | "assistant";
  content: string;
}

export interface ChatSafe {
  id: string;
  title: string;
  messages: ChatMessageWire[];
  pinned: boolean;
  model?: string;
  assistantId?: string;
  useTools?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface ChatAddRequest {
  id?: string;
  title?: string;
  messages?: ChatMessageWire[];
  pinned?: boolean;
  model?: string;
  assistantId?: string;
  useTools?: boolean;
}

// Chat stream wire types — SSE events emitted by the agent tool-loop in /chat/stream
export type ChatStreamEvent =
  | { type: "delta"; delta: string; model: string }
  | { type: "tool_start"; tool: string; args: Record<string, unknown> }
  | { type: "tool_end"; tool: string; ok: boolean; result: string }
  | { type: "done"; model: string; finishReason: string }
  | { type: "error"; error: string; code?: string };

/** Callbacks for a streaming chat; onEnd fires exactly once, with an error string when the transport failed. */
export interface ChatStreamHandlers {
  onEvent(event: ChatStreamEvent): void;
  onEnd(error?: string): void;
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

export interface McpToolCallRequest {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface McpToolCallResult {
  ok: boolean;
  isError?: boolean;
  text?: string;
  content?: unknown;
  structuredContent?: Record<string, unknown>;
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

/** The surface the interface calls. Implemented over HTTP in src/renderer/api-client.ts. */
export interface Api {
  getHelloWorld(): Promise<string>;
  ping(): Promise<string>;
  // AI — universal provider interface (Ollama today, OpenAI/Claude tomorrow)
  aiListProviders(): Promise<AiProviderInfo[]>;
  aiHealth(providerId: string): Promise<{ ok: boolean; latencyMs?: number; version?: string; error?: string }>;
  aiListModels(providerId: string): Promise<Array<{ id: string; name: string; ownedBy?: string }>>;
  aiChat(req: AiChatIpcRequest): Promise<AiChatIpcResponse>;
  /** Streaming chat over the agent tool-loop; resolves when the stream ends. */
  aiChatStream(req: AiChatIpcRequest, handlers: ChatStreamHandlers): Promise<void>;
  // MCP — transport-agnostic, secrets never cross to renderer
  mcpListServers(): Promise<McpServerSafe[]>;
  mcpGetServer(id: string): Promise<McpServerSafe>;
  mcpAddServer(config: McpAddServerRequest): Promise<McpServerSafe>;
  mcpUpdateServer(id: string, patch: Partial<McpAddServerRequest>): Promise<McpServerSafe>;
  mcpRemoveServer(id: string): Promise<{ ok: true }>;
  mcpHealth(id: string): Promise<{ ok: boolean; latencyMs?: number; error?: string; version?: string }>;
  mcpListTools(id: string): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>>;
  mcpCallTool(id: string, name: string, args?: Record<string, unknown>): Promise<McpToolCallResult>;
  mcpConnect(id: string): Promise<McpServerStatus>;
  mcpDisconnect(id: string): Promise<{ ok: true }>;
  mcpSetEnabled(id: string, enabled: boolean): Promise<McpServerSafe>;
  // Assistant — system prompt + sampling params + model adherence
  assistantList(): Promise<AssistantSafe[]>;
  assistantGet(id: string): Promise<AssistantSafe>;
  assistantAdd(config: AssistantAddRequest): Promise<AssistantSafe>;
  assistantUpdate(id: string, patch: Partial<AssistantAddRequest>): Promise<AssistantSafe>;
  assistantRemove(id: string): Promise<{ ok: true }>;
  assistantSetEnabled(id: string, enabled: boolean): Promise<AssistantSafe>;
  // Chats — persisted conversations (sidebar history + pinning)
  chatList(): Promise<ChatSafe[]>;
  chatGet(id: string): Promise<ChatSafe>;
  chatCreate(config: ChatAddRequest): Promise<ChatSafe>;
  chatUpdate(id: string, patch: Partial<ChatAddRequest>): Promise<ChatSafe>;
  chatRemove(id: string): Promise<{ ok: true }>;
  chatSetPinned(id: string, pinned: boolean): Promise<ChatSafe>;
}

declare global {
  interface Window {
    api: Api;
  }
}
