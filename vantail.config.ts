import { defineConfig } from "@vantail/cli";

export default defineConfig({
  app: {
    name: "Hideout",
    identifier: "dev.hideout.desktop",
    version: "0.1.0",
  },
  window: {
    title: "Hideout",
    width: 760,
    height: 520,
    minWidth: 420,
    minHeight: 320,
    // What shows before the page has painted, so a fast resize does not open
    // a pale gap down the side.
    backgroundColor: "#0f172a",
  },
  permissions: {
    // Everything is denied until you ask for it. This app needs nothing native
    // other than its own window, so the default (nothing) is kept.
  },
});
