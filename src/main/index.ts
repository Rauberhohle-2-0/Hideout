/**
 * `bun run dev` - start the Hono htmx sidecar, then the Vantail window.
 *
 * `vantail dev` starts Vite and opens the native window at the Vite URL; the
 * page's htmx requests (`/greet`, `/tip`) are proxied by Vite to the Hono
 * server started here. Keeping the two in one entry point ties their
 * lifetimes together: the window closing ends the run.
 *
 * This is the `main` realm of the app (a small Node sidecar). The window's
 * page lives in `src/renderer`, and values shared between the two live in
 * `src/shared`.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, generateCapabilityToken } from "./server.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const honoPort = Number(process.env.HONO_PORT ?? 8787);

// Per-process sidecar capability token. The renderer never sees it: it is
// published to the child `vantail dev` process via the environment, and the
// Vite proxy (vite.config.ts) adds the header to /api, /greet and /tip
// requests only. The packaged runtime's sidecar launcher must do the same.
const capabilityToken = process.env.HIDEOUT_CAPABILITY_TOKEN ?? generateCapabilityToken();
process.env.HIDEOUT_CAPABILITY_TOKEN = capabilityToken;

const app = createApp({ capabilityToken });
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: honoPort,
  // SSE / chat streaming can be idle between tokens; Bun's default
  // idleTimeout (10s) closes the socket mid-stream → Vite logs
  // "http proxy error: socket hang up". 255 is Bun's max; 0 disables.
  idleTimeout: 255,
  fetch: app.fetch,
});

// The `vantail` binary from the project's own node_modules/.bin.
const cli = join(root, "node_modules", ".bin", "vantail");

console.log(`\n Hideout`);
console.log(`  hono   http://127.0.0.1:${server.port}`);
console.log(`  window via vantail dev\n`);

const child = spawn(cli, ["dev"], { stdio: "inherit", cwd: root });

child.on("exit", (code) => {
  void server.stop(true);
  process.exit(code ?? 0);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    child.kill();
    void server.stop(true);
  });
}
