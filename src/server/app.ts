import { Hono } from "hono";
import { HELLO_WORLD } from "../shared/api.ts";
import { Logger } from "../logger.ts";
import { aiRoutes } from "./ai-routes.ts";

const logger = new Logger({ prefix: "hono" });

export const app = new Hono();

// AI provider API — universal interface (local: Ollama; future: OpenAI, Claude, …)
app.route("/api/ai", aiRoutes);

// Root - plain text Hello World (matches spec)
app.get("/", (c) => {
  return c.text(HELLO_WORLD);
});

// Health check - useful for Electron / external probes
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
