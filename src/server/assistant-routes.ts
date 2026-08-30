import { Hono } from "hono";
import { getDefaultAssistantRegistry } from "../assistants/registry.ts";
import { validateAssistantConfig } from "../assistants/validation.ts";
import { AssistantError } from "../assistants/errors.ts";
import { Logger } from "../logger.ts";

const logger = new Logger({ prefix: "assistant-routes" });

export const assistantRoutes = new Hono();

// Simple rate limiter: 60 req/min per IP for assistant group
const WINDOW_MS = 60_000;
const MAX_REQ = 60;
const buckets = new Map<string, { count: number; resetAt: number }>();

function rateLimit(
  c: { req: { header(n: string): string | undefined }; json(d: unknown, s?: number): Response },
  next: () => Promise<void>,
): Promise<void> | Response {
  const ip = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "127.0.0.1";
  const key = `${ip}:assistant`;
  const now = Date.now();
  const cur = buckets.get(key);
  if (!cur || now > cur.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return next();
  }
  if (cur.count >= MAX_REQ) return c.json({ error: "Rate limited" }, 429);
  cur.count++;
  return next();
}

export function __clearAssistantRateLimit(): void {
  buckets.clear();
}

function getRegistry() {
  return getDefaultAssistantRegistry();
}

// GET /api/assistants — list all
assistantRoutes.get("/", async (c) => {
  const registry = getRegistry();
  const assistants = registry.list();
  return c.json({ assistants });
});

// GET /api/assistants/:id — single
assistantRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");
  const registry = getRegistry();
  const a = registry.get(id);
  if (!a) return c.json({ error: `Assistant not found: ${id}` }, 404);
  return c.json({ assistant: a });
});

// POST /api/assistants — create
assistantRoutes.post("/", async (c) => {
  const rl = rateLimit(c as never, async () => {});
  if (rl instanceof Response) return rl as never;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const v = validateAssistantConfig(body);
  if (!v.valid) return c.json({ error: "Validation failed", details: v.errors }, 400);

  const registry = getRegistry();
  try {
    const assistant = await registry.add(v.sanitized!);
    return c.json({ assistant }, 201);
  } catch (err) {
    if (err instanceof AssistantError) {
      const status = err.code === "ALREADY_EXISTS" ? 409 : err.code === "CONFIG_INVALID" ? 400 : 500;
      return c.json({ error: err.message, code: err.code }, status);
    }
    logger.warn(`assistant add failed: ${(err as Error).message}`);
    return c.json({ error: "Failed to add assistant" }, 500);
  }
});

// PUT /api/assistants/:id — upsert
assistantRoutes.put("/:id", async (c) => {
  const rl = rateLimit(c as never, async () => {});
  if (rl instanceof Response) return rl as never;

  const id = c.req.param("id");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const candidate = { ...(body as Record<string, unknown>), id };
  const v = validateAssistantConfig(candidate);
  if (!v.valid) return c.json({ error: "Validation failed", details: v.errors }, 400);

  const registry = getRegistry();
  try {
    const assistant = await registry.upsert(v.sanitized!);
    return c.json({ assistant });
  } catch (err) {
    if (err instanceof AssistantError) {
      const status = err.code === "CONFIG_INVALID" ? 400 : 500;
      return c.json({ error: err.message, code: err.code }, status);
    }
    return c.json({ error: "Failed to update assistant" }, 500);
  }
});

// PATCH /api/assistants/:id — partial update
assistantRoutes.patch("/:id", async (c) => {
  const id = c.req.param("id");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "Invalid JSON body" }, 400);

  const registry = getRegistry();
  try {
    const assistant = await registry.update(id, body as never);
    return c.json({ assistant });
  } catch (err) {
    if (err instanceof AssistantError) {
      const status = err.code === "NOT_FOUND" ? 404 : err.code === "CONFIG_INVALID" ? 400 : 500;
      return c.json({ error: err.message, code: err.code }, status);
    }
    return c.json({ error: "Failed to patch assistant" }, 500);
  }
});

// DELETE /api/assistants/:id
assistantRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const registry = getRegistry();
  try {
    await registry.remove(id);
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof AssistantError && err.code === "NOT_FOUND") return c.json({ error: err.message }, 404);
    return c.json({ error: "Failed to delete assistant" }, 500);
  }
});

// POST /api/assistants/:id/enable — enable/disable toggles
assistantRoutes.post("/:id/enable", async (c) => {
  const id = c.req.param("id");
  const registry = getRegistry();
  try {
    const assistant = await registry.setEnabled(id, true);
    return c.json({ assistant });
  } catch (err) {
    if (err instanceof AssistantError) {
      const status = err.code === "NOT_FOUND" ? 404 : 400;
      return c.json({ error: err.message, code: err.code }, status);
    }
    return c.json({ error: "Failed to enable assistant" }, 500);
  }
});

assistantRoutes.post("/:id/disable", async (c) => {
  const id = c.req.param("id");
  const registry = getRegistry();
  try {
    const assistant = await registry.setEnabled(id, false);
    return c.json({ assistant });
  } catch (err) {
    if (err instanceof AssistantError) {
      const status = err.code === "NOT_FOUND" ? 404 : 400;
      return c.json({ error: err.message, code: err.code }, status);
    }
    return c.json({ error: "Failed to disable assistant" }, 500);
  }
});

assistantRoutes.post("/:id/enabled", async (c) => {
  const id = c.req.param("id");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const enabled = (body as Record<string, unknown>)?.enabled;
  if (typeof enabled !== "boolean") return c.json({ error: "enabled must be boolean" }, 400);
  const registry = getRegistry();
  try {
    const assistant = await registry.setEnabled(id, enabled);
    return c.json({ assistant });
  } catch (err) {
    if (err instanceof AssistantError) {
      const status = err.code === "NOT_FOUND" ? 404 : 400;
      return c.json({ error: err.message, code: err.code }, status);
    }
    return c.json({ error: "Failed to set enabled" }, 500);
  }
});
