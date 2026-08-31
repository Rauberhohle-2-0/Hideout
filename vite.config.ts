import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// The Vantail CLI (`vantail dev`) loads this file and applies its own
// `@vantail/vite` plugin on top, so a project config only needs the pieces
// that are its own - here, Tailwind and the proxy to the Hono htmx server.
export const honoPort = Number(process.env.HONO_PORT ?? 8787);

export default defineConfig({
  plugins: [tailwindcss()],
  server: {
    // The window's page is served by Vite; the htmx endpoints live on the
    // Hono sidecar. Proxying makes them same-origin for the webview, so the
    // page never leaves its own origin.
    proxy: {
      "/greet": `http://127.0.0.1:${honoPort}`,
      "/tip": `http://127.0.0.1:${honoPort}`,
    },
  },
});
