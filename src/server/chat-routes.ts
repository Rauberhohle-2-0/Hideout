import { Hono } from "hono";
import { getDefaultChatRegistry } from "../chats/registry.ts";
import { ChatError } from "../chats/errors.ts";
import { createRateLimiter } from "./rate-limit.ts";
import { jsonObjectValidator, parseBody } from "./validation.ts";
import type { ChatConfig } from "../chats/types.ts";
import { Logger } from "../logger.ts";

const logger = new Logger({ prefix: "chat-routes" });

export const chatRoutes = new Hono();

const rateLimit = createRateLimiter("chat");

function getRegistry() {
  return getDefaultChatRegistry();
}

function chatStatus(err: ChatError): 400 | 404 | 409 | 500 {
  switch (err.code) {
    case "NOT_FOUND":
      return 404;
    case "ALREADY_EXISTS":
      return 409;
    case "CONFIG_INVALID":
      return 400;
    default:
      return 500;
  }
}

// GET /api/chats — list all (pinned first, then most recent)
chatRoutes.get("/", async (c) => {
  const chats = getRegistry().list();
  return c.json({ chats });
});

// GET /api/chats/:id — single
chatRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");
  const chat = getRegistry().get(id);
  if (!chat) return c.json({ error: `Chat not found: ${id}` }, 404);
  return c.json({ chat });
});

// POST /api/chats — create. Body is a partial config; the registry generates
// the id (UUID) and derives the title from the first user message.
chatRoutes.post("/", async (c) => {
  const limited = rateLimit(c);
  if (limited) return limited;

  const parsed = await parseBody(c, jsonObjectValidator);
  if (parsed instanceof Response) return parsed;

  try {
    const chat = await getRegistry().add(parsed as Partial<ChatConfig>);
    return c.json({ chat }, 201);
  } catch (err) {
    if (err instanceof ChatError) return c.json({ error: err.message, code: err.code }, chatStatus(err));
    logger.warn(`chat add failed: ${(err as Error).message}`);
    return c.json({ error: "Failed to add chat" }, 500);
  }
});

// PATCH /api/chats/:id — partial update (append messages, rename, pin, …)
chatRoutes.patch("/:id", async (c) => {
  const limited = rateLimit(c);
  if (limited) return limited;
  const id = c.req.param("id");
  const patch = await parseBody(c, jsonObjectValidator);
  if (patch instanceof Response) return patch;

  try {
    const chat = await getRegistry().update(id, patch as Partial<ChatConfig>);
    return c.json({ chat });
  } catch (err) {
    if (err instanceof ChatError) return c.json({ error: err.message, code: err.code }, chatStatus(err));
    return c.json({ error: "Failed to patch chat" }, 500);
  }
});

// DELETE /api/chats/:id
chatRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    await getRegistry().remove(id);
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof ChatError && err.code === "NOT_FOUND") return c.json({ error: err.message }, 404);
    return c.json({ error: "Failed to delete chat" }, 500);
  }
});

// POST /api/chats/:id/pinned — { pinned: boolean }
chatRoutes.post("/:id/pinned", async (c) => {
  const limited = rateLimit(c);
  if (limited) return limited;
  const id = c.req.param("id");
  const body = await parseBody(c, jsonObjectValidator);
  if (body instanceof Response) return body;

  const pinned = (body as Record<string, unknown>).pinned;
  if (typeof pinned !== "boolean") {
    return c.json({ error: "Validation failed", details: ["pinned must be a boolean"] }, 400);
  }

  try {
    const chat = await getRegistry().setPinned(id, pinned);
    return c.json({ chat });
  } catch (err) {
    if (err instanceof ChatError) return c.json({ error: err.message, code: err.code }, chatStatus(err));
    return c.json({ error: "Failed to set pinned" }, 500);
  }
});
