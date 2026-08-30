import { Hono } from "hono";
import { getDefaultMcpRegistry } from "../mcp/registry.ts";
import { getDefaultMcpManager } from "../mcp/manager.ts";
import { McpError } from "../mcp/errors.ts";
import { createRateLimiter } from "./rate-limit.ts";
import {
  enabledToggleValidator,
  jsonObjectValidator,
  mcpCallValidator,
  mcpServerValidator,
  parseBody,
  rejectInvalid,
  requestJson,
} from "./validation.ts";
import type { McpServerConfig } from "../mcp/types.ts";
import { Logger } from "../logger.ts";

const logger = new Logger({ prefix: "mcp-routes" });

export const mcpRoutes = new Hono();

const rateLimit = createRateLimiter("mcp");

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
  const limited = rateLimit(c);
  if (limited) return limited;

  const server = await parseBody(c, mcpServerValidator);
  if (server instanceof Response) return server;

  const registry = getRegistry();
  try {
    const safe = await registry.add(server);
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
  const limited = rateLimit(c);
  if (limited) return limited;

  const id = c.req.param("id");
  const raw = await requestJson(c);
  if (raw instanceof Response) return raw;
  // Allow body without id or with matching id
  const candidate = { ...(raw as Record<string, unknown>), id };
  const server = rejectInvalid(c, mcpServerValidator, candidate);
  if (server instanceof Response) return server;

  const registry = getRegistry();
  try {
    const safe = await registry.upsert(server);
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
  const patch = await parseBody(c, jsonObjectValidator);
  if (patch instanceof Response) return patch;

  const registry = getRegistry();
  try {
    const safe = await registry.update(id, patch as Partial<McpServerConfig>);
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
  const toggle = await parseBody(c, enabledToggleValidator);
  if (toggle instanceof Response) return toggle;
  const enabled = toggle.enabled;
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

// POST /api/mcp/servers/:id/call — call a tool on a connected server
mcpRoutes.post("/servers/:id/call", async (c) => {
  const limited = rateLimit(c);
  if (limited) return limited;

  const id = c.req.param("id");
  const registry = getRegistry();
  if (!registry.getSafe(id)) return c.json({ error: `MCP server not found: ${id}` }, 404);

  const call = await parseBody(c, mcpCallValidator);
  if (call instanceof Response) return call;

  const manager = getManager();
  try {
    const result = await manager.callTool(id, call.name, call.arguments);
    return c.json({ serverId: id, name: call.name, result });
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
