/**
 * Sidecar entry point.
 *
 * Hideout's backend runs as a separate process, compiled to a single binary by
 * `bun build --compile` and spawned by the webview at startup. That split is
 * what keeps provider credentials out of the UI: the webview holds only the
 * master key (from the OS keychain) and a per-launch bearer token, and every
 * secret lives on this side of the boundary.
 *
 * The contract with the webview is two environment variables in, and one line
 * of stdout back:
 *
 *   HIDEOUT_AUTH_TOKEN   required — bearer token demanded on every route
 *   HIDEOUT_MASTER_KEY   required — base64 AES-256 key for the secure store
 *
 *   stdout: HIDEOUT_READY {"port":54321}
 *
 * Where data is written is deliberately *not* part of that contract. It comes
 * from shared/paths.ts, which keeps the location the earlier desktop build used
 * and migrates the older `~/.hideout`. Passing Vantail's own `appDataDir` here
 * would be a different directory (named after `app.identifier`) and would
 * strand every existing install's servers, assistants and credentials.
 *
 * The port is ephemeral rather than a fixed 3000, so two Hideout launches do
 * not fight over a port and nothing else on the machine can guess where to
 * find us.
 */

import { app, setAuthToken } from "./app.ts";
import { Logger } from "../logger.ts";
import { getDefaultRegistry } from "../ai/index.ts";
import { setMasterKey } from "../ai/secure-store.ts";
import { getDefaultMcpRegistry } from "../mcp/registry.ts";
import { McpError } from "../mcp/errors.ts";
import { EXA_MCP_PRESET } from "../mcp/types.ts";
import { getSecureStoreDir } from "../shared/paths.ts";
import { installUserPath } from "./user-path.ts";

const logger = new Logger({ prefix: "sidecar" });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    // Fail loudly rather than falling back to an unauthenticated server or an
    // unencrypted store — either would be a silent downgrade of the boundary
    // this process exists to provide.
    logger.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

async function seedExaPreset(): Promise<void> {
  const registry = getDefaultMcpRegistry();
  if (registry.getSafe(EXA_MCP_PRESET.id)) return;
  try {
    await registry.add(EXA_MCP_PRESET);
    logger.info(`Seeded Exa MCP preset: ${EXA_MCP_PRESET.id}`);
  } catch (err) {
    if ((err as McpError)?.code !== "ALREADY_EXISTS") {
      logger.warn(`Failed to seed Exa preset: ${(err as Error).message}`);
    }
  }
}

async function main(): Promise<void> {
  setAuthToken(requireEnv("HIDEOUT_AUTH_TOKEN"));
  setMasterKey(requireEnv("HIDEOUT_MASTER_KEY"));

  // Before anything can spawn an MCP stdio server. A packaged app inherits
  // launchd's PATH, which has none of the directories `npx` and `uvx` live in.
  await installUserPath();

  // No setStoreDir here: the registries resolve their own location through
  // shared/paths.ts, which is where the earlier desktop build already put
  // things.
  logger.info(`Data dir: ${getSecureStoreDir()}`);

  try {
    await getDefaultRegistry().hydrateSecrets();
  } catch (err) {
    logger.warn(`hydrateSecrets failed: ${(err as Error).message}`);
  }

  await seedExaPreset();

  // Bun's own server, not @hono/node-server: this binary is compiled by Bun, and
  // Hono runs natively on it. Going through the Node adapter here produced a
  // server that answered every route with Bun's default greeting instead of the
  // Hono app.
  //
  // Port 0 asks the OS for a free one, so two launches never collide and
  // nothing else on the machine can guess where to find us.
  const server = Bun.serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });

  // The one line the webview is waiting for. Written straight to stdout rather
  // than through the logger, so log formatting can never break the handshake.
  process.stdout.write(`HIDEOUT_READY ${JSON.stringify({ port: server.port })}\n`);
  logger.info(`Listening on http://127.0.0.1:${server.port}`);

  const shutdown = (): void => {
    void server.stop(true);
    process.exit(0);
  };

  // Vantail kills its children when the runtime exits, so there is no orphan
  // watchdog here. An earlier version watched stdin for EOF, which killed the
  // process instantly whenever stdin was not an open pipe — running the binary
  // by hand, or from a test — for no benefit the runtime does not already give.
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

void main();
