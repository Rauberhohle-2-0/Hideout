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

  const { height = 36, buttonHeight = 14 } = titleBarMetrics() ?? {};
  // Keep a generous amount of space above the lights, a little more than a
  // plain centre, and breathe off the leading edge too.
  const y = Math.round(height / 2 - buttonHeight / 2 + 6);
  void appWindow?.setTrafficLightPosition(20, y);
}

wireTitleBar();

/**
 * Collapse/enlarge the left sidebar and keep every toggle in sync.
 *
 * There are two buttons: one in the sidebar's top row (visible while open)
 * and one in the right-pane title bar (visible only while closed, so it stays
 * reachable once the sidebar has shrunk away).
 */
function setSidebarCollapsed(collapsed: boolean): void {
  if (!sidebar) return;
  sidebar.classList.toggle("collapsed", collapsed);
  for (const toggle of sidebarToggles) {
    toggle.setAttribute("aria-expanded", String(!collapsed));
  }
  if (titleBarToggle) titleBarToggle.hidden = !collapsed;
}

function wireSidebarToggle(): void {
  if (!sidebar) return;
  for (const toggle of sidebarToggles) {
    toggle.addEventListener("click", () => {
      setSidebarCollapsed(!sidebar.classList.contains("collapsed"));
    });
  }
}

// Shared handles used by the toggle and the resize wiring.
const sidebar = document.querySelector<HTMLElement>("#sidebar");
const sidebarToggles = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-sidebar-toggle]"));
const titleBarToggle = document.querySelector<HTMLButtonElement>("#sidebar-toggle");

if (sidebar) {
  wireSidebarToggle();
}

/**
 * Resize the sidebar by dragging the handle between it and the content.
 *
 * The handle captures the pointer for the whole drag and sets the sidebar
 * width from the cursor's X (the sidebar starts at the window's left edge).
 * Width is clamped so it cannot get too narrow to hold content or push the
 * content pane out entirely.
 */
function wireSidebarResize(): void {
  const handle = document.querySelector<HTMLElement>("#sidebar-resizer");
  if (!sidebar || !handle) return;

  const minWidth = 160;
  handle.addEventListener("pointerdown", (event) => {
    sidebar.classList.add("dragging");
    setSidebarCollapsed(false); // a drag resizes it open
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  handle.addEventListener("pointermove", (event) => {
    if (!handle.hasPointerCapture(event.pointerId)) return;
    const maxWidth = Math.max(minWidth, Math.floor(window.innerWidth * 0.5));
    const width = Math.min(maxWidth, Math.max(minWidth, event.clientX));
    sidebar.style.width = `${width}px`;
  });

  const endDrag = () => sidebar.classList.remove("dragging");
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);
}

wireSidebarResize();

