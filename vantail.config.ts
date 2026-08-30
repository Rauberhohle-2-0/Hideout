import { defineConfig } from "@vantail/cli";

/**
 * Hideout runs its backend as a *sidecar*: a Bun-compiled binary carrying the
 * Hono server plus the AI, MCP and assistant registries. The webview holds no
 * provider credentials — only a master key from the OS keychain, handed to the
 * sidecar at spawn time (see src/renderer/bootstrap.ts).
 *
 * The permissions below therefore constrain the *webview*. The sidecar is a
 * separate OS process running with the user's full privileges; once spawned,
 * nothing here applies to it. Its own boundary is the bearer token on every
 * route and the validation in src/server/.
 */
export default defineConfig({
  app: {
    name: "Hideout",
    identifier: "dev.wissen.hideout",
    version: "1.0.0",
  },

  window: {
    title: "Hideout",
    width: 900,
    height: 700,
    minWidth: 560,
    minHeight: 480,
    // Matches the light --bg in index.html so a live resize shows no pale gap.
    backgroundColor: "#f6f7f9",
  },

  permissions: {
    // The master key for the sidecar's encrypted store. Filed under the app
    // identifier, so no other application can read it.
    secrets: true,

    filesystem: {
      // Only to confirm the sidecar binary is present before spawning it.
      read: ["$RESOURCE/**"],
      grantFromDialog: false,
    },

    network: {
      // The sidecar, on whatever ephemeral port it reports at startup.
      // No port means any port on that scheme and host.
      allow: ["http://127.0.0.1"],
    },

    shell: {
      allow: [
        // The sidecar itself. `$RESOURCE` is `dist/` in dev and
        // `Contents/Resources/dist/` in a packaged bundle, so this one rule
        // covers both.
        { program: "$RESOURCE/bin/hideout-server" },

        // ---------------------------------------------------------------
        // NOTE: these two are currently INERT. MCP stdio servers are spawned
        // by the sidecar via node:child_process, which does not pass through
        // Vantail's permission layer at all. They are here so the webview
        // *could* launch MCP servers directly, and can be deleted outright
        // while the sidecar owns that job.
        //
        // Be aware of what they mean if you do start using them: `npx` with
        // unrestricted arguments is `npx -y <anything>`, i.e. arbitrary code
        // execution. Pin `args` to a vetted server list before shipping.
        // ---------------------------------------------------------------
        { program: "npx" },
        { program: "uvx" },
      ],
    },
  },
});
