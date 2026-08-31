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
import { createApp } from "./server.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const honoPort = Number(process.env.HONO_PORT ?? 8787);

const app = createApp();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: honoPort,
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
