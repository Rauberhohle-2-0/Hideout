/**
 * The contract the Hono sidecar (`src/main`) serves its fragments under: the
 * route paths, the query field a request may carry, and the fallback name
 * when none is sent. Kept out of the server so the routes and views can't
 * drift apart.
 */

/** The query field `/greet` reads the name from. */
export const NAME_FIELD = "name";

/** The fallback greeting name when no name is sent. */
export const DEFAULT_NAME = "friend";

/** Route paths served by the Hono sidecar. */
export const GREET_ROUTE = "/greet";
export const TIP_ROUTE = "/tip";
export const MODELS_ROUTE = "/api/models";
export const PROVIDERS_ROUTE = "/api/providers";
export const CREDENTIALS_ROUTE = "/api/credentials";
export const CREDENTIAL_ROUTE = "/api/credentials/:providerId";

/** The element htmx swaps server fragments into. */
export const SWAP_TARGET = "#greeting";