/**
 * Agent tool-loop for chat.
 *
 * Turns a plain `provider.chat` call into an agentic one: it collects the tools
 * exposed by every *enabled* MCP server, hands them to the model as function
 * definitions, and when the model requests a tool call it routes that call back
 * to the owning MCP server (via McpManager.callTool) and feeds the result into
 * the next round. Iterates until the model produces a final text answer (or the
 * max-round cap is hit, always returning *something*).
 *
 * Streaming emits typed events:
 *   { type: "delta", delta, model }        — text tokens of the answer
 *   { type: "tool_start", name, args }     — about to call a tool
 *   { type: "tool_end", name, ok, result } — a tool returned
 *   { type: "done", model, finishReason }  — a final round produced an answer
 */
import { AiError } from "../ai/errors.ts";
import type {
  AiChatOptions,
  AiChatResponse,
  AiMessage,
  AiProvider,
  AiTool,
  AiToolCall,
} from "../ai/types.ts";
import { Logger } from "../logger.ts";
import { getDefaultMcpManager } from "../mcp/manager.ts";
import { getDefaultMcpRegistry } from "../mcp/registry.ts";
import type { McpServerSafe } from "../mcp/types.ts";

const logger = new Logger({ prefix: "agent" });

/** How many model<->tool rounds we allow before forcing a final answer. */
const MAX_TOOL_ROUNDS = 6;

export interface AgentTool {
  tool: AiTool;
  /** Tool name scoped to a specific server (name may collide across servers). */
  serverId: string;
}

export type AgentEvent =
  | { type: "delta"; delta: string; model: string }
  | { type: "tool_start"; tool: string; args: Record<string, unknown> }
  | { type: "tool_end"; tool: string; ok: boolean; result: string }
  | { type: "done"; model: string; finishReason: AiChatResponse["finishReason"] }
  | { type: "error"; error: string; code?: string };

export interface AgentContext {
  /** The provider the caller resolved; informational (tools are global). */
  providerId?: string;
  /** The messages the caller wants answered (assistant adherence already applied). */
  messages: AiMessage[];
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
}

/** A ChatMessage the caller gives us; our internal message carries tool fields. */
export interface AgentChatMessage extends AiMessage {}

/**
 * Enumerate MCP tools from every enabled server, flattening MCP's inputSchema
 * into AiTool. Failures to list one server never block the others.
 */
export async function collectEnabledTools(): Promise<AgentTool[]> {
  const registry = getDefaultMcpRegistry();
  const manager = getDefaultMcpManager();
  const servers = registry.listSafe();
  const enabled = servers.filter((s: McpServerSafe) => s.enabled !== false);
  const out: AgentTool[] = [];
  await Promise.all(
    enabled.map(async (server) => {
      try {
        const tools = await manager.listTools(server.id);
        for (const t of tools) {
          out.push({
            serverId: server.id,
            tool: {
              name: t.name,
              ...(t.description !== undefined ? { description: t.description } : {}),
              ...(t.inputSchema !== undefined && t.inputSchema
                ? { parameters: t.inputSchema as Record<string, unknown> }
                : {}),
            },
          });
        }
      } catch (err) {
        logger.debug(`Agent: skip tools for ${server.id}: ${(err as Error).message}`);
      }
    }),
  );
  return out;
}

function toChatOptions(ctx: AgentContext, tools?: AiTool[]): AiChatOptions {
  const options: AiChatOptions = {
    model: ctx.model,
    temperature: ctx.temperature,
    maxTokens: ctx.maxTokens,
    topP: ctx.topP,
    topK: ctx.topK,
    minP: ctx.minP,
    repeatPenalty: ctx.repeatPenalty,
    frequencyPenalty: ctx.frequencyPenalty,
    presencePenalty: ctx.presencePenalty,
    seed: ctx.seed,
    stop: ctx.stop,
    timeoutMs: 120_000,
  };
  if (tools && tools.length > 0) options.tools = tools;
  return options;
}

async function executeTool(manager: ReturnType<typeof getDefaultMcpManager>, serverId: string, call: AiToolCall): Promise<string> {
  const result = await manager.callTool(serverId, call.name, call.arguments);
  if (result.isError) {
    return `Tool "${call.name}" failed: ${result.text ?? JSON.stringify(result.content ?? {})}`;
  }
  if (result.text) return result.text;
  if (result.structuredContent !== undefined) return JSON.stringify(result.structuredContent, null, 2);
  if (result.content !== undefined) return JSON.stringify(result.content);
  return "(empty result)";
}

/**
 * Stream an agentic reply. Uses provider.chatStream so text tokens arrive live,
 * and runs the tool loop when the model requests function calls. A tool-call
 * round is usually silent (the model asks for tools without commenting), so
 * optimistic streaming of its (near-empty) text is safe; the real answer comes
 * on a later round.
 */
export async function* agentStream(
  provider: AiProvider,
  ctx: AgentContext,
): AsyncIterable<AgentEvent> {
  const tools = await collectEnabledTools();
  const toolMap = new Map<string, string>(); // tool name -> server id
  for (const entry of tools) toolMap.set(entry.tool.name, entry.serverId);
  const aiTools = tools.map((e) => e.tool);

  const history: AgentChatMessage[] = [...ctx.messages];
  const manager = getDefaultMcpManager();
  let sentError = false;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let roundCalls: AiToolCall[] | undefined;
    let roundModel = ctx.model ?? "";
    try {
      for await (const chunk of provider.chatStream(history, toChatOptions(ctx, aiTools))) {
        if (chunk.model) roundModel = chunk.model;
        if (chunk.done) {
          roundCalls = chunk.toolCalls ?? [];
          break;
        }
        if (chunk.delta) {
          yield { type: "delta", delta: chunk.delta, model: chunk.model ?? "" } as AgentEvent;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = err instanceof AiError ? err.code : "UPSTREAM_ERROR";
      if (!sentError) {
        sentError = true;
        yield { type: "error", error: msg, code };
      }
      return;
    }

    const calls = roundCalls ?? [];
    // Push the assistant turn (carries the requested tool calls so the model's
    // request stays part of the conversation history for the model's own coherence).
    history.push({ role: "assistant", content: "", toolCalls: calls.length ? calls : undefined });

    if (calls.length === 0) {
      yield { type: "done", model: roundModel, finishReason: "stop" } as AgentEvent;
      return;
    }

    for (const call of calls) {
      const serverId = toolMap.get(call.name);
      yield { type: "tool_start", tool: call.name, args: call.arguments };
      if (!serverId) {
        const msg = `Tool "${call.name}" is not available (no enabled server exposes it).`;
        yield { type: "tool_end", tool: call.name, ok: false, result: msg };
        history.push({ role: "tool", name: call.name, content: msg });
        continue;
      }
      try {
        const result = (await executeTool(manager, serverId, call)).slice(0, 20_000);
        yield { type: "tool_end", tool: call.name, ok: true, result };
        history.push({ role: "tool", name: call.name, content: result });
      } catch (err) {
        const msg = `Tool "${call.name}" errored: ${(err as Error).message}`;
        yield { type: "tool_end", tool: call.name, ok: false, result: msg };
        history.push({ role: "tool", name: call.name, content: msg });
      }
    }
  }

  // The model asked for tools on every allowed round and never answered.
  if (!sentError) {
    yield { type: "delta", delta: "The model requested tools too many times without producing an answer.", model: ctx.model ?? "" } as AgentEvent;
    yield { type: "done", model: ctx.model ?? "", finishReason: "stop" } as AgentEvent;
  }
}

