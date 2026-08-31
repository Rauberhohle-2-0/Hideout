/**
 * The contract shared between the window's page and the Hono htmx sidecar.
 *
 * These are the values the renderer (`src/renderer`), the server
 * (`src/main`), and the static `index.html` must all agree on: the hidden
 * field the page asks the runtime to fill and htmx sends, the route paths,
 * and the "friend" fallback when no OS user is available. `index.html` writes
 * them as literal attributes (a static document cannot import TypeScript);
 * this module keeps the two code realms from drifting apart.
 */

/** The hidden input htmx includes when re-requesting `/greet`. */
export const NAME_FIELD = "name";

/** Selector for that hidden input on the page. */
export const WHO_SELECTOR = "#who";

/** The fallback greeting name when the OS username cannot be resolved. */
export const DEFAULT_NAME = "friend";

/** Route paths served by the Hono sidecar and requested by the page. */
export const GREET_ROUTE = "/greet";
export const TIP_ROUTE = "/tip";

/** The element htmx swaps server fragments into. */
export const SWAP_TARGET = "#greeting";