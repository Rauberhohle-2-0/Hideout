/**
 * Generic helpers for building HTML safely.
 *
 * Keeping escaping here means both the server-rendered views (`src/main`) and
 * any future client-side rendering (`src/renderer`) can lean on one
 * implementation without a template engine or JSX anywhere in the project.
 */

const escapes: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape a value that came from outside the program before putting it in HTML. */
export function escape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => escapes[char] ?? char);
}