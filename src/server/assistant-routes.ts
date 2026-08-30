import { Hono } from "hono";
import { getDefaultAssistantRegistry } from "../assistants/registry.ts";
import { AssistantError } from "../assistants/errors.ts";
import { createRateLimiter } from "./rate-limit.ts";
import {
  assistantValidator,
  enabledToggleValidator,
  jsonObjectValidator,
  parseBody,
  rejectInvalid,
  requestJson,
} from "./validation.ts";
import type { AssistantConfig } from "../assistants/types.ts";
import { Logger } from "../logger.ts";

const logger = new Logger({ prefix: "assistant-routes" });

export const assistantRoutes = new Hono();

const rateLimit = createRateLimiter("assistant");

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
  const limited = rateLimit(c);
  if (limited) return limited;

  const parsed = await parseBody(c, assistantValidator);
  if (parsed instanceof Response) return parsed;

  const registry = getRegistry();
  try {
    const assistant = await registry.add(parsed);
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
  const limited = rateLimit(c);
  if (limited) return limited;

  const id = c.req.param("id");
  const raw = await requestJson(c);
  if (raw instanceof Response) return raw;
  const candidate = { ...(raw as Record<string, unknown>), id };
  const parsed = rejectInvalid(c, assistantValidator, candidate);
  if (parsed instanceof Response) return parsed;

  const registry = getRegistry();
  try {
    const assistant = await registry.upsert(parsed);
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
  const limited = rateLimit(c);
  if (limited) return limited;
  const id = c.req.param("id");
  const patch = await parseBody(c, jsonObjectValidator);
  if (patch instanceof Response) return patch;

  const registry = getRegistry();
  try {
    const assistant = await registry.update(id, patch as Partial<AssistantConfig>);
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
  const limited = rateLimit(c);
  if (limited) return limited;
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
  const limited = rateLimit(c);
  if (limited) return limited;
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
  const limited = rateLimit(c);
  if (limited) return limited;
  const id = c.req.param("id");
  const toggle = await parseBody(c, enabledToggleValidator);
  if (toggle instanceof Response) return toggle;
  const enabled = toggle.enabled;
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
