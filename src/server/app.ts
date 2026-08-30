import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { HELLO_WORLD } from "../shared/api.ts";
import { Logger } from "../logger.ts";
import { aiRoutes } from "./ai-routes.ts";
import { mcpRoutes } from "./mcp-routes.ts";
import { assistantRoutes } from "./assistant-routes.ts";

const logger = new Logger({ prefix: "hono" });

export const app = new Hono();

// ---- Authentication ----
// A loopback port is not a boundary: every process on the machine can reach it,
// and this server holds the user's provider credentials. So every route
// demands the per-launch bearer token that the webview generated and handed to
// this process at spawn time. The token never touches disk.

let authToken: string | null = null;

export function setAuthToken(token: string): void {
  authToken = token;
}

/** Constant-time compare, so a wrong token leaks nothing through timing. */
function tokenMatches(presented: string): boolean {
  if (authToken === null) return false;
  const a = Buffer.from(presented, "utf-8");
  const b = Buffer.from(authToken, "utf-8");
  // timingSafeEqual throws on a length mismatch, which would itself be a
  // timing signal — compare lengths only after both buffers exist.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

app.use("*", async (c, next) => {
  if (authToken === null) {
    logger.error("No auth token configured — refusing every request");
    return c.json({ error: "Unauthorized" }, 401);
  }
  const header = c.req.header("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!presented || !tokenMatches(presented)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
  // Explicit, because `return next()` hands Hono the composer's return value
  // and it ends up building a response with status 0.
  return undefined;
});

// AI provider API — universal interface (local: Ollama; future: OpenAI, Claude, …)
app.route("/api/ai", aiRoutes);
app.route("/api/mcp", mcpRoutes);
app.route("/api/assistants", assistantRoutes);

// Root - plain text Hello World (matches spec)
app.get("/", (c) => {
  return c.text(HELLO_WORLD);
});

// Health check - the interface's `ping()` and any external probe
app.get("/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

// API example - JSON Hello World
app.get("/api/hello", (c) => {
  return c.json({ message: HELLO_WORLD });
});

// Catch-all 404 as JSON
app.notFound((c) => {
  return c.json({ error: "Not Found", path: c.req.path }, 404);
});

app.onError((err, c) => {
  // Don't leak stack in production; still log server-side
  logger.error(err.message);
  return c.json({ error: "Internal Server Error" }, 500);
});

export type HonoApp = typeof app;
