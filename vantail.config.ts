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
    minWidth: 760,
    minHeight: 560,
    // What shows before the page has painted, so a fast resize does not open
    // a pale gap down the side.
    backgroundColor: "#0f172a",
    // Let the page draw its own title bar: the window content reaches the top
    // edge (titleBarStyle: "hidden") with room reserved for a bar of this
    // height, and the platform's own buttons are hidden so the renderer can
    // paint minimize / maximize / close that match the theme.
    titleBarStyle: "hidden",
    titleBarHeight: 48,
    titleBarButtons: "hidden",
  },
  permissions: {
    // Everything is denied until you ask for it. This app needs nothing native
    // other than its own window, so the default (nothing) is kept.
  },
});
