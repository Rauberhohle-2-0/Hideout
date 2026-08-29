import { Hono } from "hono";
import { getDefaultRegistry } from "../ai/index.ts";
import { AiError } from "../ai/errors.ts";
import { Logger } from "../logger.ts";

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

function validateChatBody(body: unknown): { providerId: string; messages: unknown; model?: string; temperature?: number; maxTokens?: number; topP?: number; stop?: string[] } | { error: string } {
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
  if (b.stop !== undefined && (!Array.isArray(b.stop) || !(b.stop as unknown[]).every((s) => typeof s === "string"))) {
    return { error: "stop must be string[]" };
  }
  return b as never;
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

// POST /api/ai/chat  { providerId, messages, model?, temperature?, maxTokens?, topP?, stop? }
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

  const { providerId, messages, model, temperature, maxTokens, topP, stop } = parsed;
  const registry = getRegistry();
  const provider = registry.get(providerId);
  if (!provider) return c.json({ error: `Provider not found: ${providerId}` }, 404);

  try {
    const res = await provider.chat(messages as never, {
      model,
      temperature,
      maxTokens,
      topP,
      stop,
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

  const { providerId, messages, model, temperature, maxTokens, topP, stop } = parsed;
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
        for await (const chunk of provider.chatStream(messages as never, {
          model,
          temperature,
          maxTokens,
          topP,
          stop,
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
