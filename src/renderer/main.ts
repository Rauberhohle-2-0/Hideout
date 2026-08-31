/**
 * Application entry point.
 *
 * Order matters here. `renderer.ts` calls `init()` the moment it is evaluated,
 * and that reaches straight for `window.api` — so the sidecar has to be up and
 * the client installed *before* it is imported. Hence the dynamic import
 * rather than a static one at the top of the file.
 */

import "../style.css";
// htmx is loaded for resident client-side behaviors (show/hide, class tools).
// The data path stays on the IPC bridge; this import is what bundles it as a
// `'self'` asset so the strict CSP holds.
import "htmx.org";

import type { Api } from "../shared/api.ts";
import { createApiClient } from "./api-client.ts";
import { startSidecar } from "./bootstrap.ts";

declare global {
  interface Window {
    api: Api;
  }
}

/**
 * A failed sidecar means every panel would render the same error. Say it once,
 * at the top, in the markup the page already has for load failures.
 */
function showFatal(message: string): void {
  const content = document.getElementById("content");
  if (!content) return;
  const box = document.createElement("div");
  box.className = "load-error";
  box.textContent = `Could not start the Hideout backend: ${message}`;
  content.replaceChildren(box);
}

async function boot(): Promise<void> {
  try {
    window.api = createApiClient(await startSidecar());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Sidecar startup failed:", message);
    showFatal(message);
    return;
  }
  await import("./renderer.ts");
}

void boot();
