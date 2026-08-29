import { serve, type ServerType } from "@hono/node-server";
import { app } from "./app.ts";
import { Logger } from "../logger.ts";

const DEFAULT_PORT = 3000;
const DEFAULT_HOSTNAME = "127.0.0.1";

const logger = new Logger({ prefix: "hono" });

let server: ServerType | null = null;

export function getPort(): number {
  const raw = process.env.HONO_PORT ?? process.env.PORT;
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_PORT;
  if (Number.isFinite(parsed) && parsed > 0 && parsed < 65536) return parsed;
  return DEFAULT_PORT;
}

export function getHostname(): string {
  return process.env.HONO_HOSTNAME ?? DEFAULT_HOSTNAME;
}

export function getServerUrl(): string | null {
  if (!server) return null;
  const addr = server.address();
  if (addr && typeof addr === "object") {
    const host = addr.address === "0.0.0.0" || addr.address === "::" ? "127.0.0.1" : addr.address;
    return `http://${host}:${addr.port}`;
  }
  return `http://${getHostname()}:${getPort()}`;
}

export function getServer(): ServerType | null {
  return server;
}

export function getApp() {
  return app;
}

/**
 * Start Hono server via @hono/node-server.
 * Idempotent - calling multiple times returns existing server.
 * Binds to 127.0.0.1 by default (not 0.0.0.0) for security.
 */
export function startHonoServer(opts?: { port?: number; hostname?: string }): ServerType {
  if (server) {
    logger.info(`Hono already running at ${getServerUrl()}`);
    return server;
  }

  const port = opts?.port ?? getPort();
  const hostname = opts?.hostname ?? getHostname();

  logger.info(`Starting Hono server on http://${hostname}:${port}`);

  server = serve(
    {
      fetch: app.fetch,
      port,
      hostname,
    },
    (info) => {
      logger.info(`Hono listening on http://${info.address}:${info.port}`);
    },
  );

  // Log server errors without crashing Electron
  server.on("error", (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Hono server error: ${msg}`);

    // EADDRINUSE - try to inform but don't crash
    if (msg.includes("EADDRINUSE")) {
      logger.error(`Port ${port} already in use. Set HONO_PORT env to use another port.`);
    }
  });

  return server;
}

/**
 * Gracefully stop Hono server if running.
 */
export function stopHonoServer(): Promise<void> {
  if (!server) return Promise.resolve();

  const s = server;
  server = null;

  return new Promise((resolve, reject) => {
    s.close((err?: Error) => {
      if (err) {
        logger.error(`Error closing Hono server: ${err.message}`);
        reject(err);
      } else {
        logger.info("Hono server stopped");
        resolve();
      }
    });
  });
}

export { app as honoApp };
