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
 * on pointer-down instead. The platform draws and handles the window buttons
 * (macOS traffic lights); we place them so they stay centred in the bar and
 * keep a comfortable margin off the rounded corner - padded, not clamped.
 */
function wireTitleBar(): void {
  const bar = document.querySelector<HTMLElement>("[data-drag]");
  if (!bar) return;

  bar.addEventListener("pointerdown", () => {
    void appWindow?.startDragging();
  });

  const { height = 28, buttonHeight = 14 } = titleBarMetrics() ?? {};
  // Vertically centre the lights in the bar and breathe 12px off the leading
  // edge, a little more than the OS crammed-in default.
  void appWindow?.setTrafficLightPosition(20, Math.round(height / 2 - buttonHeight / 2));
}

wireTitleBar();
