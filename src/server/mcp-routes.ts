import { Hono } from "hono";
import { getDefaultMcpRegistry } from "../mcp/registry.ts";
import { getDefaultMcpManager } from "../mcp/manager.ts";
import { validateMcpServerConfig } from "../mcp/validation.ts";
import { McpError } from "../mcp/errors.ts";
import { Logger } from "../logger.ts";

const logger = new Logger({ prefix: "mcp-routes" });

export const mcpRoutes = new Hono();

// Simple rate limiter: 60 req/min per IP for MCP group
const WINDOW_MS = 60_000;
const MAX_REQ = 60;
const buckets = new Map<string, { count: number; resetAt: number }>();

function rateLimit(
  c: { req: { header(n: string): string | undefined }; json(d: unknown, s?: number): Response },
  next: () => Promise<void>,
): Promise<void> | Response {
  const ip = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "127.0.0.1";
  const key = `${ip}:mcp`;
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

export function __clearMcpRateLimit(): void {
  buckets.clear();
}

function getRegistry() {
  return getDefaultMcpRegistry();
}

function getManager() {
  return getDefaultMcpManager();
}

// GET /api/mcp/servers — list safe configs
mcpRoutes.get("/servers", async (c) => {
  const registry = getRegistry();
  const servers = registry.listSafe();
  return c.json({ servers });
});

// GET /api/mcp/servers/:id — single safe config
mcpRoutes.get("/servers/:id", async (c) => {
  const id = c.req.param("id");
  const registry = getRegistry();
  const s = registry.getSafe(id);
  if (!s) return c.json({ error: `MCP server not found: ${id}` }, 404);
  return c.json({ server: s });
});

// POST /api/mcp/servers — create
mcpRoutes.post("/servers", async (c) => {
  const rl = rateLimit(c as never, async () => {});
  if (rl instanceof Response) return rl as never;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const v = validateMcpServerConfig(body);
  if (!v.valid) return c.json({ error: "Validation failed", details: v.errors }, 400);

  const registry = getRegistry();
  try {
    const safe = await registry.add(v.sanitized!);
    return c.json({ server: safe }, 201);
  } catch (err) {
    if (err instanceof McpError) {
      const status = err.code === "ALREADY_EXISTS" ? 409 : err.code === "CONFIG_INVALID" ? 400 : 500;
      return c.json({ error: err.message, code: err.code }, status);
    }
    logger.warn(`mcp add failed: ${(err as Error).message}`);
    return c.json({ error: "Failed to add server" }, 500);
  }
});

// PUT /api/mcp/servers/:id — upsert / update
mcpRoutes.put("/servers/:id", async (c) => {
  const rl = rateLimit(c as never, async () => {});
  if (rl instanceof Response) return rl as never;

  const id = c.req.param("id");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  // Allow body without id or with matching id
  const candidate = { ...(body as Record<string, unknown>), id };
  const v = validateMcpServerConfig(candidate);
  if (!v.valid) return c.json({ error: "Validation failed", details: v.errors }, 400);

  const registry = getRegistry();
  try {
    const safe = await registry.upsert(v.sanitized!);
    return c.json({ server: safe });
  } catch (err) {
    if (err instanceof McpError) {
      const status = err.code === "NOT_FOUND" ? 404 : err.code === "CONFIG_INVALID" ? 400 : 500;
      return c.json({ error: err.message, code: err.code }, status);
    }
    return c.json({ error: "Failed to update server" }, 500);
  }
});

// PATCH /api/mcp/servers/:id — partial update
mcpRoutes.patch("/servers/:id", async (c) => {
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
    const safe = await registry.update(id, body as never);
    return c.json({ server: safe });
  } catch (err) {
    if (err instanceof McpError) {
      const status = err.code === "NOT_FOUND" ? 404 : err.code === "CONFIG_INVALID" ? 400 : 500;
      return c.json({ error: err.message, code: err.code }, status);
    }
    return c.json({ error: "Failed to patch server" }, 500);
  }
});

// POST /api/mcp/servers/:id/enable — enable server
mcpRoutes.post("/servers/:id/enable", async (c) => {
  const id = c.req.param("id");
  const registry = getRegistry();
  try {
    const safe = await registry.setEnabled(id, true);
    return c.json({ server: safe });
  } catch (err) {
    if (err instanceof McpError) {
      const status = err.code === "NOT_FOUND" ? 404 : 400;
      return c.json({ error: err.message, code: err.code }, status);
    }
    return c.json({ error: "Failed to enable server" }, 500);
  }
});

// POST /api/mcp/servers/:id/disable — disable server (also disconnects)
mcpRoutes.post("/servers/:id/disable", async (c) => {
  const id = c.req.param("id");
  const registry = getRegistry();
  const manager = getManager();
  try {
    const safe = await registry.setEnabled(id, false);
    await manager.disconnect(id).catch(() => {});
    return c.json({ server: safe });
  } catch (err) {
    if (err instanceof McpError) {
      const status = err.code === "NOT_FOUND" ? 404 : 400;
      return c.json({ error: err.message, code: err.code }, status);
    }
    return c.json({ error: "Failed to disable server" }, 500);
  }
});

// POST /api/mcp/servers/:id/enabled — generic toggle { enabled: boolean }
mcpRoutes.post("/servers/:id/enabled", async (c) => {
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
  const manager = getManager();
  try {
    const safe = await registry.setEnabled(id, enabled);
    if (!enabled) await manager.disconnect(id).catch(() => {});
    return c.json({ server: safe });
  } catch (err) {
    if (err instanceof McpError) {
      const status = err.code === "NOT_FOUND" ? 404 : 400;
      return c.json({ error: err.message, code: err.code }, status);
    }
    return c.json({ error: "Failed to set enabled" }, 500);
  }
});

// DELETE /api/mcp/servers/:id
mcpRoutes.delete("/servers/:id", async (c) => {
  const id = c.req.param("id");
  const registry = getRegistry();
  try {
    await registry.remove(id);
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof McpError && err.code === "NOT_FOUND") return c.json({ error: err.message }, 404);
    return c.json({ error: "Failed to delete server" }, 500);
  }
});

// GET /api/mcp/servers/:id/health
mcpRoutes.get("/servers/:id/health", async (c) => {
  const id = c.req.param("id");
  const registry = getRegistry();
  if (!registry.getSafe(id)) return c.json({ error: `MCP server not found: ${id}` }, 404);
  const manager = getManager();
  const health = await manager.healthCheck(id);
  return c.json(health, health.ok ? 200 : 503);
});

// POST /api/mcp/servers/:id/connect
mcpRoutes.post("/servers/:id/connect", async (c) => {
  const id = c.req.param("id");
  const registry = getRegistry();
  if (!registry.getSafe(id)) return c.json({ error: `MCP server not found: ${id}` }, 404);
  const manager = getManager();
  const status = await manager.connect(id);
  return c.json(status, status.connected ? 200 : 502);
});

// POST /api/mcp/servers/:id/disconnect
mcpRoutes.post("/servers/:id/disconnect", async (c) => {
  const id = c.req.param("id");
  const manager = getManager();
  await manager.disconnect(id);
  return c.json({ ok: true });
});

// GET /api/mcp/servers/:id/tools
mcpRoutes.get("/servers/:id/tools", async (c) => {
  const id = c.req.param("id");
  const registry = getRegistry();
  if (!registry.getSafe(id)) return c.json({ error: `MCP server not found: ${id}` }, 404);
  const manager = getManager();
  try {
    const tools = await manager.listTools(id);
    return c.json({ serverId: id, tools });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = err instanceof McpError ? err.code : "UPSTREAM_ERROR";
    return c.json({ error: msg, code }, code === "NOT_CONNECTED" ? 502 : 500);
  }
});

// GET /api/mcp/presets/exa — returns Exa preset (safe, no secrets)
mcpRoutes.get("/presets/exa", async (c) => {
  const { EXA_MCP_PRESET } = await import("../mcp/types.ts");
  // return safe (no secrets anyway)
  const { toSafeConfig } = await import("../mcp/secure-helpers.ts");
  return c.json({ preset: toSafeConfig(EXA_MCP_PRESET) , raw: EXA_MCP_PRESET });
});
