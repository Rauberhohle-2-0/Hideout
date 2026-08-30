import { Hono } from "hono";
import { getDefaultRegistry } from "../ai/index.ts";
import { AiError } from "../ai/errors.ts";
import { Logger } from "../logger.ts";
import { getDefaultAssistantRegistry } from "../assistants/registry.ts";

const logger = new Logger({ prefix: "ai-routes" });

export const aiRoutes = new Hono();

// Simple in-memory rate limiter: 60 req/min per IP per route group
const WINDOW_MS = 60_000;
const MAX_REQ = 60;
const buckets = new Map<string, { count: number; resetAt: number }>();

function rateLimit(
  c: { req: { header(n: string): string | undefined }; json(d: unknown, s?: number): Response },
  next: () => Promise<void>,
): Promise<void> | Response {
  const ip = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "127.0.0.1";
  const key = `${ip}:ai`;
  const now = Date.now();
  const cur = buckets.get(key);
  if (!cur || now > cur.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return next();
  }
  if (cur.count >= MAX_REQ) {
    return c.json({ error: "Rate limited" }, 429);
  }
  cur.count++;
  return next();
}

// For tests: clear buckets
export function __clearAiRateLimit(): void {
  buckets.clear();
}

function getRegistry() {
  return getDefaultRegistry();
}

type ValidChatBody = {
  providerId: string;
  messages: unknown[];
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
  assistantId?: string;
};

function validateChatBody(body: unknown): ValidChatBody | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Invalid JSON body" };
  const b = body as Record<string, unknown>;
  if (typeof b.providerId !== "string" || !b.providerId) return { error: "providerId is required" };
  if (!Array.isArray(b.messages) || (b.messages as unknown[]).length === 0) return { error: "messages must be a non-empty array" };
  for (let i = 0; i < (b.messages as unknown[]).length; i++) {
    const m = (b.messages as unknown[])[i] as Record<string, unknown>;
    if (!m || typeof m.role !== "string" || typeof m.content !== "string") {
      return { error: `messages[${i}] must have string role and content` };
    }
    if (!["system", "user", "assistant", "tool"].includes(m.role as string)) {
      return { error: `messages[${i}].role invalid` };
    }
    if ((m.content as string).length > 200_000) return { error: `messages[${i}].content too large` };
  }
  if (b.model !== undefined && typeof b.model !== "string") return { error: "model must be a string" };
  if (b.temperature !== undefined && (typeof b.temperature !== "number" || b.temperature < 0 || b.temperature > 2)) {
    return { error: "temperature must be a number 0..2" };
  }
  if (b.maxTokens !== undefined && (typeof b.maxTokens !== "number" || b.maxTokens <= 0 || b.maxTokens > 200_000)) {
    return { error: "maxTokens must be a positive number" };
  }
  if (b.topP !== undefined && (typeof b.topP !== "number" || b.topP < 0 || b.topP > 1)) return { error: "topP must be 0..1" };
  if (b.topK !== undefined && (typeof b.topK !== "number" || !Number.isInteger(b.topK as number) || (b.topK as number) < 0 || (b.topK as number) > 100)) return { error: "topK must be integer 0..100" };
  if (b.minP !== undefined && (typeof b.minP !== "number" || b.minP < 0 || b.minP > 1)) return { error: "minP must be 0..1" };
  if (b.repeatPenalty !== undefined && (typeof b.repeatPenalty !== "number" || b.repeatPenalty < 0 || b.repeatPenalty > 2)) return { error: "repeatPenalty must be 0..2" };
  if (b.frequencyPenalty !== undefined && (typeof b.frequencyPenalty !== "number" || b.frequencyPenalty < -2 || b.frequencyPenalty > 2)) return { error: "frequencyPenalty must be -2..2" };
  if (b.presencePenalty !== undefined && (typeof b.presencePenalty !== "number" || b.presencePenalty < -2 || b.presencePenalty > 2)) return { error: "presencePenalty must be -2..2" };
  if (b.seed !== undefined && (typeof b.seed !== "number" || !Number.isInteger(b.seed as number))) return { error: "seed must be integer" };
  if (b.stop !== undefined && (!Array.isArray(b.stop) || !(b.stop as unknown[]).every((s) => typeof s === "string"))) {
    return { error: "stop must be string[]" };
  }
  if (b.assistantId !== undefined && typeof b.assistantId !== "string") return { error: "assistantId must be string" };
  if (typeof b.assistantId === "string" && b.assistantId.length > 64) return { error: "assistantId too long" };
  return b as never;
}

function resolveAssistantChatContext(
  parsed: ValidChatBody,
): { messages: unknown[]; model?: string; temperature?: number; maxTokens?: number; topP?: number; topK?: number; minP?: number; repeatPenalty?: number; frequencyPenalty?: number; presencePenalty?: number; seed?: number; stop?: string[] } {
  if (!("assistantId" in parsed) || !parsed.assistantId) {
    return {
      messages: parsed.messages as never,
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
    };
  }
  const reg = getDefaultAssistantRegistry();
  const assistant = reg.get(parsed.assistantId!);
  if (!assistant || assistant.enabled === false) {
    // If assistant not found/disabled, return parsed as-is; route handler will return 404 before calling this for strict cases
    // For leniency, just return without injection
    return {
      messages: parsed.messages as never,
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
  let messages: unknown[] = parsed.messages as unknown[];
  const hasSystem = messages.length > 0 && (messages[0] as { role?: string })?.role === "system";
  if (assistant.instructions) {
    if (!hasSystem) {
      messages = [{ role: "system", content: assistant.instructions }, ...messages];
    } else {
      // Prepend assistant instructions before existing system content (assistant is primary system)
      // Keep existing system as second message or merge
      const existing = messages[0] as { role: string; content: string };
      const mergedSystem = `${assistant.instructions}\n\n${existing.content}`;
      messages = [{ role: "system", content: mergedSystem }, ...messages.slice(1)];
    }
  }

  return {
    messages: messages as never,
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
    config: (p as unknown as { getConfig?: () => unknown }).getConfig?.() ?? { id: p.id },
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
  const rl = rateLimit(c as never, async () => {});
  if (rl instanceof Response) return rl as never;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const parsed = validateChatBody(body);
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);

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
    const res = await provider.chat(ctx.messages as never, {
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
  const rl = rateLimit(c as never, async () => {});
  if (rl instanceof Response) return rl as never;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const parsed = validateChatBody(body);
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);

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

  // Stream as SSE
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown): void => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      try {
        for await (const chunk of provider.chatStream(ctx.messages as never, {
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
        })) {
          send(chunk.done ? "done" : "delta", chunk);
          if (chunk.done) break;
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
