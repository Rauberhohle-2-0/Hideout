/**
 * The application, as a Hono app and nothing else.
 *
 * No file system, no port, no runtime-specific anything - just routes over
 * `Request` and `Response`. That is what makes it testable without a window
 * and, later, able to run as a packaged sidecar.
 */
import { Hono } from "hono";
import { escape } from "../shared/escape.ts";
import {
  DEFAULT_NAME,
  GREET_ROUTE,
  NAME_FIELD,
  TIP_ROUTE,
} from "../shared/constants.ts";
import { greeting, tip } from "./views.ts";

export function createApp() {
  const app = new Hono();

  // Greet by name. The window's page sends the OS user's name, filled in by
  // src/renderer/main.ts, through an htmx request that Vite proxies here.
  app.get(GREET_ROUTE, (c) => {
    const name = (c.req.query(NAME_FIELD) ?? "").trim() || DEFAULT_NAME;
    return c.html(greeting(escape(name)), 200);
  });

  // A short tip, modelled on the previous one we served (kept on the server
  // in memory for the demo - stateless is fine too).
  let tipsServed = 0;
  app.get(TIP_ROUTE, (c) => {
    return c.html(tip(tipsServed++), 200);
  });

  return app;
}
