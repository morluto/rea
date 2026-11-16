/**
 * The message text of a caught value: an Error's message, or the value as a
 * string. Use it wherever a diagnostic needs text from an unknown cause.
 */
export const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
