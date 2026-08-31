import { createLogger, defineConfig, type Logger, type LogErrorOptions, type LogOptions } from "vite";
import tailwindcss from "@tailwindcss/vite";

/**
 * Vantail injects its own plugin automatically when you run `vantail build` /
 * `vantail dev`, so it must NOT be listed here (that would run it twice).
 * This config only layers Tailwind CSS v4 on top; `@vantail/vite` still supplies
 * the `vantail://`-relative output and webview build target.
 */
function silenceHtmxEval(base: Logger): Logger {
  const isHtmxEval = (msg: string): boolean => msg.includes("[EVAL]");
  return {
    ...base,
    warn: (msg: string, options?: LogOptions) => {
      if (isHtmxEval(msg)) return;
      base.warn(msg, options);
    },
    warnOnce: (msg: string, options?: LogOptions) => {
      if (isHtmxEval(msg)) return;
      base.warnOnce(msg, options);
    },
    error: (msg: string, options?: LogErrorOptions) => base.error(msg, options),
    async clearScreen() {
      base.clearScreen();
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss()],
  // htmx's `internalEval` (used only for `hx-on:*` / `js:` attributes, which
  // Hideout never emits) trips rolldown's static `[EVAL]` advisory. It is dead
  // code here and rejected by our CSP (no unsafe-eval) if ever reached, so we
  // drop just that line from the build log.
  customLogger: silenceHtmxEval(createLogger("info")),
});