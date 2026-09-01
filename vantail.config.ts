import { defineConfig } from "@vantail/cli";

export default defineConfig({
  app: {
    name: "Hideout",
    identifier: "dev.hideout.desktop",
    version: "0.1.0",
  },
  window: {
    title: "Hideout",
    width: 1280,
    height: 800,
    minWidth: 1000,
    minHeight: 680,
    // What shows before the page has painted, so a fast resize does not open
    // a pale gap down the side.
    backgroundColor: "#ffffff",
    // Let the page draw its own title bar: the window content reaches the top
    // edge (titleBarStyle: "hidden") with room reserved for a bar about the
    // height of the system's own. The platform's buttons stay (macOS traffic
    // lights); the renderer drags the bar and centres them in it.
    titleBarStyle: "hidden",
    titleBarHeight: 36,
  },
  permissions: {
    // Secrets = OS keychain (Keychain on macOS, Credential Manager on Windows,
    // Secret Service on Linux). Namespaced by `app.identifier`, so
    // `dev.hideout.desktop` cannot read another app's entries and vice versa.
    // This is where AI provider API keys live — never in localStorage,
    // filesystem plaintext, or logs.
    secrets: true,
    // Webview network: only the hosts the app intentionally talks to. The
    // Hono sidecar (Bun) is not gated by this, but declaring it here makes
    // the permission file the single reviewer-visible allow-list. `*` is
    // avoided — each provider host is listed explicitly per docs/permissions.md.
    network: {
      allow: [
        "api.openai.com",
        "api.anthropic.com",
        // Ollama is local; listed for completeness when the webview probes it.
        "127.0.0.1",
        "localhost",
      ],
    },
  },
});
