import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { CAPABILITY_HEADER } from "./src/shared/constants.ts";

// The Vantail CLI (`vantail dev`) loads this file and applies its own
// `@vantail/vite` plugin on top, so a project config only needs the pieces
// that are its own - here, Tailwind and the proxy to the Hono htmx server.
export const honoPort = Number(process.env.HONO_PORT ?? 8787);

// The Hono sidecar now requires a per-process capability token on every
// request (see src/main/server.ts). The renderer must never learn the token:
// the window's page is served by Vite, and this proxy is the ONLY path from
// page to sidecar, so we stamp the header here from the env var that
// src/main/index.ts publishes to the `vantail dev` child process. When the
// sidecar is started standalone without the env var (e.g. `vantail dev`
// alone), proxied requests will be rejected with 401 - start via `bun run
// dev` so index.ts generates and shares the token.
function stampCapabilityHeader(proxy: { on: (event: string, handler: (req: { setHeader: (name: string, value: string) => void }) => void) => void }): void {
  const token = process.env.HIDEOUT_CAPABILITY_TOKEN;
  if (!token) return;
  proxy.on("proxyReq", (proxyReq) => {
    proxyReq.setHeader(CAPABILITY_HEADER, token);
  });
}

export default defineConfig({
  plugins: [tailwindcss()],
  server: {
    // The window's page is served by Vite; the htmx endpoints live on the
    // Hono sidecar. Proxying makes them same-origin for the webview, so the
    // page never leaves its own origin.
    // `timeout`/`proxyTimeout` are raised for SSE (`POST /api/chat` with
    // `stream:true`): Bun's default idleTimeout (10s) and http-proxy's
    // default would otherwise close an idle token gap with `socket hang up`.
    proxy: {
      "/greet": {
        target: `http://127.0.0.1:${honoPort}`,
        configure: stampCapabilityHeader,
      },
      "/tip": {
        target: `http://127.0.0.1:${honoPort}`,
        configure: stampCapabilityHeader,
      },
      "/api": {
        target: `http://127.0.0.1:${honoPort}`,
        changeOrigin: true,
        // 0 = no timeout for streaming; Vite 5 forwards to http-proxy
        timeout: 0,
        proxyTimeout: 0,
        configure: stampCapabilityHeader,
      },
    },
  },
});
