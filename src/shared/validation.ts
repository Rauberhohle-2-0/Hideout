/**
 * Result of a validator that may both reject and shape/sanitize its input.
 *
 * `valid: true` guarantees `sanitized` is present, so callers can rely on the
 * discriminated union instead of a non-null `!` assertion on a nullable field.
 */
export type SanitizerResult<T> =
  | { valid: true; errors: string[]; sanitized: T }
  | { valid: false; errors: string[] };
