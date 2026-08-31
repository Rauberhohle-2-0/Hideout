/**
 * The window's front end.
 *
 * Two jobs, kept deliberately tiny:
 *  1. Load htmx (plain, as a library - the markup in index.html stays plain
 *     HTML attributes, no JSX or component abstraction).
 *  2. Ask the Vantail runtime who the OS user is and drop the name into the
 *     hidden `#who` field, then let htmx fire the `/greet` request.
 */
import "htmx.org";
import { appWindow, os, titleBarMetrics } from "@vantail/api";
import { DEFAULT_NAME, WHO_SELECTOR } from "../shared/constants.ts";

// Trimmed, non-empty, and never used mid-tag - just a friendly name.
function usernameOf(home: string): string {
  const cleaned = home.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  return cleaned.length > 0 ? cleaned : DEFAULT_NAME;
}

async function greetByOsUser(): Promise<void> {
  const field = document.querySelector<HTMLInputElement>(WHO_SELECTOR);
  if (!field) return;

  let name: string = DEFAULT_NAME;
  try {
    const home = await os.homeDir();
    name = usernameOf(home);
  } catch {
    // Outside Vantail (e.g. the page opened in a plain browser) there is no
    // runtime to answer; fall back to a friendly default.
    name = DEFAULT_NAME;
  }

  if (field.value === name) return;
  field.value = name;
  field.dispatchEvent(new Event("change", { bubbles: true }));
}

void greetByOsUser();

/**
 * Drive the custom title bar from index.html.
 *
 * `-webkit-app-region: drag` is a Chromium extension and does nothing in
 * WKWebView, so the bar is dragged by telling the runtime to start dragging
 * on pointer-down instead. Buttons are exempt so they stay clickable.
 */
function wireTitleBar(): void {
  const bar = document.querySelector<HTMLElement>("[data-drag]");
  const controls = document.querySelector<HTMLElement>("#window-controls");
  if (!bar) return;

  bar.addEventListener("pointerdown", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("button")) return; // let the window controls win
    void appWindow?.startDragging();
  });

  if (!controls) return;

  // If the platform still owns a trailing edge (e.g. it kept system buttons),
  // it reserves an inset and there is nothing for us to draw. Otherwise the
  // trailing inset is 0 and the runtime wants us to paint our own controls.
  const { insetRight = 0 } = titleBarMetrics() ?? {};
  if (insetRight > 0) return;

  for (const button of controls.querySelectorAll<HTMLButtonElement>("button[data-action]")) {
    button.addEventListener("click", () => {
      switch (button.dataset.action) {
        case "minimize":
          void appWindow?.minimize();
          break;
        case "maximize":
          void appWindow?.toggleMaximize();
          break;
        case "close":
          void appWindow?.close();
          break;
      }
    });
  }
}

wireTitleBar();
