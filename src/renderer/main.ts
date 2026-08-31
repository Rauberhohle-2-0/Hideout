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
import { os } from "@vantail/api";
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
