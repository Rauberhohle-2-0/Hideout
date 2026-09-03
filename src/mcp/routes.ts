/**
 * Hono routes for MCP server management.
 *
 * - GET    /api/mcp/servers              — list all server infos (configs + status)
 * - POST   /api/mcp/servers              — create / upsert a server (validates transport separation)
 * - GET    /api/mcp/servers/:id          — single server info
 * - PUT    /api/mcp/servers/:id          — update server (full replace, id must match)
 * - DELETE /api/mcp/servers/:id          — remove server
 * - POST   /api/mcp/servers/:id/connect  — connect (listTools to verify)
 * - POST   /api/mcp/servers/:id/disconnect — disconnect
 * - GET    /api/mcp/servers/:id/tools    — list tools (auto-connects if enabled)
 * - POST   /api/mcp/servers/:id/tools/call — { name, arguments }
 *
 * All error bodies are `{ error: string }`.
 * Transport validation is strict: STDIO uses command/args/env, HTTP/SSE use url/headers/timeout.
 * Built-in servers (Exa) are code-owned and read-only: POST/PUT/DELETE with a
 * built-in id returns 409 and never touches the user store.
 */
import { Hono } from "hono";
import type { McpManager } from "./manager.ts";
import { validateMcpServerConfig, normalizeMcpServerConfig } from "../shared/mcp.ts";
import type { McpServerConfig } from "../shared/mcp.ts";

export function createMcpRoutes(manager: McpManager): Hono {
  const app = new Hono();

  // List all
  app.get("/api/mcp/servers", async (c) => {
    const infos = await manager.listInfos();
    return c.json({ servers: infos });
  });

  // Create / upsert
  app.post("/api/mcp/servers", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const err = validateMcpServerConfig(body);
    if (err) return c.json({ error: err }, 400);
    const normalized = normalizeMcpServerConfig(body as McpServerConfig);
    try {
      const info = await manager.upsert(normalized);
      return c.json(info, 201);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/built-in/i.test(msg)) return c.json({ error: msg }, 409);
      throw e;
    }
  });

  // Single info
  app.get("/api/mcp/servers/:id", async (c) => {
    const id = c.req.param("id");
    const info = await manager.getInfo(id);
    if (!info) return c.json({ error: `MCP server "${id}" not found` }, 404);
    return c.json(info);
  });

  // Update (full replace)
  app.put("/api/mcp/servers/:id", async (c) => {
    const id = c.req.param("id");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const raw = body as Record<string, unknown>;
    // Ensure id matches route
    if (typeof raw.id === "string" && raw.id !== id) {
      return c.json({ error: `id mismatch: route "${id}" vs body "${raw.id}"` }, 400);
    }
    const withId = { ...raw, id };
    const err = validateMcpServerConfig(withId);
    if (err) return c.json({ error: err }, 400);
    const normalized = normalizeMcpServerConfig(withId as McpServerConfig);
    try {
      const info = await manager.upsert(normalized);
      return c.json(info);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/built-in/i.test(msg)) return c.json({ error: msg }, 409);
      throw e;
    }
  });

  // Delete
  app.delete("/api/mcp/servers/:id", async (c) => {
    const id = c.req.param("id");
    let ok: boolean;
    try {
      ok = await manager.remove(id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/built-in/i.test(msg)) return c.json({ error: msg }, 409);
      throw e;
    }
    if (!ok) return c.json({ error: `MCP server "${id}" not found` }, 404);
    return c.json({ id, deleted: true });
  });

  // Connect
  app.post("/api/mcp/servers/:id/connect", async (c) => {
    const id = c.req.param("id");
    const exists = await manager.getConfig(id);
    if (!exists) return c.json({ error: `MCP server "${id}" not found` }, 404);
    try {
      const info = await manager.connect(id);
      return c.json(info);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 502);
    }
  });

  // Disconnect
  app.post("/api/mcp/servers/:id/disconnect", async (c) => {
    const id = c.req.param("id");
    const exists = await manager.getConfig(id);
    if (!exists) return c.json({ error: `MCP server "${id}" not found` }, 404);
    const info = await manager.disconnect(id);
    return c.json(info);
  });

  // List tools
  app.get("/api/mcp/servers/:id/tools", async (c) => {
    const id = c.req.param("id");
    const exists = await manager.getConfig(id);
    if (!exists) return c.json({ error: `MCP server "${id}" not found` }, 404);
    try {
      const tools = await manager.listTools(id);
      return c.json({ serverId: id, tools });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = /not connected|not found/i.test(msg) ? 503 : 502;
      return c.json({ error: msg }, status);
    }
  });

  // Call tool
  app.post("/api/mcp/servers/:id/tools/call", async (c) => {
    const id = c.req.param("id");
    const exists = await manager.getConfig(id);
    if (!exists) return c.json({ error: `MCP server "${id}" not found` }, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const b = body as Record<string, unknown>;
    if (typeof b.name !== "string" || !b.name.trim()) return c.json({ error: "name is required" }, 400);
    const args = (b.arguments ?? b.args ?? {}) as Record<string, unknown>;
    if (args !== null && typeof args !== "object") return c.json({ error: "arguments must be an object" }, 400);
    try {
      const result = await manager.callTool(id, b.name as string, (args ?? {}) as Record<string, unknown>);
      return c.json({ serverId: id, tool: b.name, result });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = /not connected|not found/i.test(msg) ? 503 : 502;
      return c.json({ error: msg }, status);
    }
  });

  return app;
}
