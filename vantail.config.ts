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
    // a pale gap down the side. The window itself is transparent so the page
    // can blur the desktop behind the sidebar (frosted glass).
    backgroundColor: "#0f172a",
    transparent: true,
    // Let the page draw its own title bar: the window content reaches the top
    // edge (titleBarStyle: "hidden") with room reserved for a bar about the
    // height of the system's own. The platform's buttons stay (macOS traffic
    // lights); the renderer drags the bar and centres them in it.
    titleBarStyle: "hidden",
    titleBarHeight: 36,
  },
  permissions: {
    // Everything is denied until you ask for it. This app needs nothing native
    // other than its own window, so the default (nothing) is kept.
  },
});
