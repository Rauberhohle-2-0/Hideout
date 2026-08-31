import { Hono } from "hono";
import { getDefaultRegistry } from "../ai/index.ts";
import { AiError } from "../ai/errors.ts";
import { Logger } from "../logger.ts";
import { getDefaultAssistantRegistry } from "../assistants/registry.ts";
import { createRateLimiter } from "./rate-limit.ts";
import { parseBody } from "./validation.ts";
import { agentStream } from "./agent.ts";
import { chatBodyValidator, type ValidChatBody } from "./chat-validation.ts";
import type { AiMessage } from "../ai/types.ts";

const logger = new Logger({ prefix: "ai-routes" });

export const aiRoutes = new Hono();

const rateLimit = createRateLimiter("ai");

function getRegistry() {
  return getDefaultRegistry();
}

function resolveAssistantChatContext(
  parsed: ValidChatBody,
): { messages: AiMessage[]; model?: string; temperature?: number; maxTokens?: number; topP?: number; topK?: number; minP?: number; repeatPenalty?: number; frequencyPenalty?: number; presencePenalty?: number; seed?: number; stop?: string[]; useTools?: boolean } {
  if (!("assistantId" in parsed) || !parsed.assistantId) {
    return {
      messages: parsed.messages,
      ...(parsed.model !== undefined ? { model: parsed.model } : {}),
      ...(parsed.temperature !== undefined ? { temperature: parsed.temperature } : {}),
      ...(parsed.maxTokens !== undefined ? { maxTokens: parsed.maxTokens } : {}),
      ...(parsed.topP !== undefined ? { topP: parsed.topP } : {}),
      ...(parsed.topK !== undefined ? { topK: parsed.topK } : {}),
      ...(parsed.minP !== undefined ? { minP: parsed.minP } : {}),
      ...(parsed.repeatPenalty !== undefined ? { repeatPenalty: parsed.repeatPenalty } : {}),
      ...(parsed.frequencyPenalty !== undefined ? { frequencyPenalty: parsed.frequencyPenalty } : {}),
      ...(parsed.presencePenalty !== undefined ? { presencePenalty: parsed.presencePenalty } : {}),
      ...(parsed.seed !== undefined ? { seed: parsed.seed } : {}),
      ...(parsed.stop !== undefined ? { stop: parsed.stop } : {}),
      useTools: parsed.useTools,
    };
  }
  const reg = getDefaultAssistantRegistry();
  const assistant = reg.get(parsed.assistantId!);
  if (!assistant || assistant.enabled === false) {
    // If assistant not found/disabled, return parsed as-is; route handler will return 404 before calling this for strict cases
    // For leniency, just return without injection
    return {
      messages: parsed.messages,
      ...(parsed.model !== undefined ? { model: parsed.model } : {}),
      ...(parsed.temperature !== undefined ? { temperature: parsed.temperature } : {}),
      ...(parsed.maxTokens !== undefined ? { maxTokens: parsed.maxTokens } : {}),
      ...(parsed.topP !== undefined ? { topP: parsed.topP } : {}),
      ...(parsed.topK !== undefined ? { topK: parsed.topK } : {}),
      ...(parsed.minP !== undefined ? { minP: parsed.minP } : {}),
      ...(parsed.repeatPenalty !== undefined ? { repeatPenalty: parsed.repeatPenalty } : {}),
      ...(parsed.frequencyPenalty !== undefined ? { frequencyPenalty: parsed.frequencyPenalty } : {}),
      ...(parsed.presencePenalty !== undefined ? { presencePenalty: parsed.presencePenalty } : {}),
      ...(parsed.seed !== undefined ? { seed: parsed.seed } : {}),
      ...(parsed.stop !== undefined ? { stop: parsed.stop } : {}),
      useTools: parsed.useTools,
    };
  }

  // Merge parameters: assistant defaults overridden by request
  const p = assistant.parameters ?? {};
  const merged = {
    temperature: parsed.temperature ?? p.temperature,
    maxTokens: parsed.maxTokens ?? p.maxTokens,
    topP: parsed.topP ?? p.topP,
    topK: parsed.topK ?? p.topK,
    minP: parsed.minP ?? p.minP,
    repeatPenalty: parsed.repeatPenalty ?? p.repeatPenalty,
    frequencyPenalty: parsed.frequencyPenalty ?? p.frequencyPenalty,
    presencePenalty: parsed.presencePenalty ?? p.presencePenalty,
    seed: parsed.seed ?? p.seed,
    stop: parsed.stop ?? p.stop,
    model: parsed.model ?? assistant.model,
  };

  // Inject system prompt if assistant has instructions and messages don't already start with system
  let messages: AiMessage[] = parsed.messages;
  const hasSystem = messages.length > 0 && messages[0]?.role === "system";
  if (assistant.instructions) {
    if (!hasSystem) {
      messages = [{ role: "system", content: assistant.instructions }, ...messages];
    } else {
      // Prepend assistant instructions before existing system content (assistant is primary system)
      // Keep existing system as second message or merge
      const existing = messages[0]!;
      const mergedSystem = `${assistant.instructions}\n\n${existing.content}`;
      messages = [{ role: "system", content: mergedSystem }, ...messages.slice(1)];
    }
  }

  return {
    messages: messages,
    ...(merged.model !== undefined ? { model: merged.model } : {}),
    ...(merged.temperature !== undefined ? { temperature: merged.temperature } : {}),
    ...(merged.maxTokens !== undefined ? { maxTokens: merged.maxTokens } : {}),
    ...(merged.topP !== undefined ? { topP: merged.topP } : {}),
    ...(merged.topK !== undefined ? { topK: merged.topK } : {}),
    ...(merged.minP !== undefined ? { minP: merged.minP } : {}),
    ...(merged.repeatPenalty !== undefined ? { repeatPenalty: merged.repeatPenalty } : {}),
    ...(merged.frequencyPenalty !== undefined ? { frequencyPenalty: merged.frequencyPenalty } : {}),
    ...(merged.presencePenalty !== undefined ? { presencePenalty: merged.presencePenalty } : {}),
    ...(merged.seed !== undefined ? { seed: merged.seed } : {}),
    ...(merged.stop !== undefined ? { stop: merged.stop } : {}),
    useTools: parsed.useTools,
  };
}

// GET /api/ai/providers
aiRoutes.get("/providers", async (c) => {
  const registry = getRegistry();
  const providers = registry.list().map((p) => ({
    id: p.id,
    displayName: p.displayName,
    kind: p.kind,
    capabilities: p.getCapabilities(),
    // safe config (no secrets)
    config: p.getConfig(),
  }));
  return c.json({ providers });
});

// GET /api/ai/providers/:id/health
aiRoutes.get("/providers/:id/health", async (c) => {
  const id = c.req.param("id");
  const registry = getRegistry();
  const provider = registry.get(id);
  if (!provider) return c.json({ error: `Provider not found: ${id}` }, 404);
  const health = await provider.healthCheck();
  return c.json(health, health.ok ? 200 : 503);
});

// GET /api/ai/providers/:id/models
aiRoutes.get("/providers/:id/models", async (c) => {
  const id = c.req.param("id");
  const registry = getRegistry();
  const provider = registry.get(id);
  if (!provider) return c.json({ error: `Provider not found: ${id}` }, 404);
  try {
    const models = await provider.listModels();
    return c.json({ providerId: id, models });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = err instanceof AiError ? err.code : "UPSTREAM_ERROR";
    logger.warn(`listModels ${id} failed: ${msg}`);
    const status = code === "NOT_FOUND" ? 404 : code === "TIMEOUT" ? 504 : 502;
    return c.json({ error: msg, code }, status);
  }
});

// POST /api/ai/chat  { providerId, messages, model?, temperature?, maxTokens?, topP?, topK?, minP?, repeatPenalty?, frequencyPenalty?, presencePenalty?, seed?, stop?, assistantId? }
aiRoutes.post("/chat", async (c) => {
  // rate limit
  const limited = rateLimit(c);
  if (limited) return limited;

  const parsed = await parseBody(c, chatBodyValidator);
  if (parsed instanceof Response) return parsed;

  // If assistantId provided, validate existence and adherence before proceeding
  if (parsed.assistantId) {
    const aReg = getDefaultAssistantRegistry();
    const a = aReg.get(parsed.assistantId);
    if (!a) return c.json({ error: `Assistant not found: ${parsed.assistantId}` }, 404);
    if (a.enabled === false) return c.json({ error: `Assistant disabled: ${parsed.assistantId}` }, 400);
    // Optional: if assistant is adhered to a specific provider, enforce or warn
    if (a.providerId && a.providerId !== parsed.providerId) {
      // Allow cross-provider use but log; adherence is default, not strict
      logger.info(`Assistant ${a.id} adhered to ${a.providerId} but chat uses ${parsed.providerId} — allowing`);
    }
  }

  const ctx = resolveAssistantChatContext(parsed);
  const { providerId } = parsed;
  const registry = getRegistry();
  const provider = registry.get(providerId);
  if (!provider) return c.json({ error: `Provider not found: ${providerId}` }, 404);

  try {
    const res = await provider.chat(ctx.messages, {
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
    });
    return c.json(res);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = err instanceof AiError ? err.code : "UPSTREAM_ERROR";
    logger.warn(`chat ${providerId} failed: ${msg}`);
    const status =
      code === "VALIDATION_ERROR" || code === "CONFIG_INVALID"
        ? 400
        : code === "AUTH_FAILED"
          ? 401
          : code === "NOT_FOUND"
            ? 404
            : code === "TIMEOUT"
              ? 504
              : code === "RATE_LIMITED"
                ? 429
                : 502;
    // Never leak internal stack
    return c.json({ error: msg, code }, status);
  }
});

// POST /api/ai/chat/stream  -> Server-Sent Events (text/event-stream)
aiRoutes.post("/chat/stream", async (c) => {
  const limited = rateLimit(c);
  if (limited) return limited;

  const parsed = await parseBody(c, chatBodyValidator);
  if (parsed instanceof Response) return parsed;

  if (parsed.assistantId) {
    const aReg = getDefaultAssistantRegistry();
    const a = aReg.get(parsed.assistantId);
    if (!a) return c.json({ error: `Assistant not found: ${parsed.assistantId}` }, 404);
    if (a.enabled === false) return c.json({ error: `Assistant disabled: ${parsed.assistantId}` }, 400);
  }

  const ctx = resolveAssistantChatContext(parsed);
  const { providerId } = parsed;
  const registry = getRegistry();
  const provider = registry.get(providerId);
  if (!provider) return c.json({ error: `Provider not found: ${providerId}` }, 404);

  // Stream as SSE over the agent tool-loop: tokens arrive live, and any MCP
  // tool the model asks for is executed and its result fed back in-line.
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown): void => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      // Send one byte immediately. The rest of the work — collecting MCP tools
      // (which can spawn exa via `npx`) and a reasoning model's first token —
      // can take a while, and the runtime's request timeout runs from the start
      // of the call, not from whenever we first flush. An instant keep-alive
      // therefore stops a slow start from being read as a dropped connection.
      send("start", { done: false });
      try {
        for await (const evt of agentStream(provider, ctx)) {
          send(evt.type, evt);
        }
        send("end", { done: true });
        controller.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = err instanceof AiError ? err.code : "UPSTREAM_ERROR";
        send("error", { error: msg, code });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});
