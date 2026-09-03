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
 * - POST   /api/mcp/servers/:id/approve  — trust a STDIO server (record approval)
 * - POST   /api/mcp/servers/:id/revoke-approval — untrust a STDIO server
 * - GET    /api/mcp/servers/:id/audit    — trust/policy change history
 * - GET    /api/mcp/servers/:id/tools    — list tools (auto-connects if enabled)
 * - POST   /api/mcp/servers/:id/tools/call — { name, arguments }
 *
 * All error bodies are `{ error: string }`.
 * Transport validation is strict: STDIO uses command/args/env, HTTP/SSE use url/headers/timeout.
 * Built-in servers (Exa) are code-owned and read-only: POST/PUT/DELETE with a
 * built-in id returns 409 and never touches the user store.
 */
import { Hono, type Context } from "hono";
import { McpApprovalRequiredError, type McpManager } from "./manager.ts";
import {
  validateMcpServerConfig,
  normalizeMcpServerConfig,
  mergePreservedSecrets,
} from "../shared/mcp.ts";
import type { McpServerConfig } from "../shared/mcp.ts";
import { readJsonBodyBounded } from "../shared/http-body.ts";

/** Read a JSON body with the shared byte cap; returns a Hono error response on failure. */
async function readBody(c: Context): Promise<{ error?: Response; body?: unknown }> {
  const result = await readJsonBodyBounded(c.req.raw);
  if (result.ok) return { body: result.body };
  if (result.error === "too-large") {
    return { error: c.json({ error: "Request body too large" }, 413) };
  }
  return { error: c.json({ error: "Invalid JSON" }, 400) };
}

export function createMcpRoutes(manager: McpManager): Hono {
  const app = new Hono();

  // List all
  app.get("/api/mcp/servers", async (c) => {
    const infos = await manager.listInfos();
    return c.json({ servers: infos });
  });

  // Create / upsert
  app.post("/api/mcp/servers", async (c) => {
    const { error, body } = await readBody(c);
    if (error) return error;
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

  // Update (full replace with secret preservation)
  app.put("/api/mcp/servers/:id", async (c) => {
    const id = c.req.param("id");
    const { error, body } = await readBody(c);
    if (error) return error;
    const raw = body as Record<string, unknown>;
    // Ensure id matches route
    if (typeof raw.id === "string" && raw.id !== id) {
      return c.json({ error: `id mismatch: route "${id}" vs body "${raw.id}"` }, 400);
    }
    const withId = { ...raw, id };
    const err = validateMcpServerConfig(withId);
    if (err) return c.json({ error: err }, 400);
    const normalized = normalizeMcpServerConfig(withId as McpServerConfig);
    // Preserve-on-update: masked echoes of stored headers/env must not
    // overwrite the stored raw values when an edit only changed other fields.
    const stored = await manager.getConfig(id);
    const toSave = stored ? mergePreservedSecrets(stored, normalized) : normalized;
    try {
      const info = await manager.upsert(toSave);
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
      if (e instanceof McpApprovalRequiredError) {
        return c.json({ error: msg, approvalRequired: true }, 403);
      }
      return c.json({ error: msg }, 502);
    }
  });

  // Explicitly approve a STDIO server so it may spawn its local program.
  // This is the ONLY way an unapproved STDIO server can transition out of
  // `needs-approval`; the approval is recorded separately from the config.
  app.post("/api/mcp/servers/:id/approve", async (c) => {
    const id = c.req.param("id");
    const exists = await manager.getConfig(id);
    if (!exists) return c.json({ error: `MCP server "${id}" not found` }, 404);
    try {
      const info = await manager.approveServer(id);
      return c.json(info);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 400);
    }
  });

  // Revoke a STDIO server's approval: stops it if running and returns it to
  // `needs-approval`. Distinct from DELETE — the config stays, only trust is
  // withdrawn, so it can be re-approved later without re-entering it.
  app.post("/api/mcp/servers/:id/revoke-approval", async (c) => {
    const id = c.req.param("id");
    const exists = await manager.getConfig(id);
    if (!exists) return c.json({ error: `MCP server "${id}" not found` }, 404);
    try {
      const info = await manager.revokeApproval(id);
      return c.json(info);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 400);
    }
  });

  // Per-server trust & policy audit history.
  app.get("/api/mcp/servers/:id/audit", async (c) => {
    const id = c.req.param("id");
    const exists = await manager.getConfig(id);
    if (!exists) return c.json({ error: `MCP server "${id}" not found` }, 404);
    const events = await manager.audit(id);
    return c.json({ serverId: id, events });
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
      // Auto-connect in listTools can hit the STDIO approval gate.
      if (e instanceof McpApprovalRequiredError) {
        return c.json({ error: msg, approvalRequired: true }, 403);
      }
      const status = /not connected|not found/i.test(msg) ? 503 : 502;
      return c.json({ error: msg }, status);
    }
  });

  // Call tool
  app.post("/api/mcp/servers/:id/tools/call", async (c) => {
    const id = c.req.param("id");
    const exists = await manager.getConfig(id);
    if (!exists) return c.json({ error: `MCP server "${id}" not found` }, 404);
    const { error, body } = await readBody(c);
    if (error) return error;
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
