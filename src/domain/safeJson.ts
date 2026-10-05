/** JSON parsing without throws at an input boundary. */
export type SafeJsonParseResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string; readonly cause: unknown };

/** Parse JSON text, returning the failure reason instead of throwing. */
export const safeParseJson = (value: string): SafeJsonParseResult => {
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch (cause: unknown) {
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : String(cause),
      cause,
    };
  }
};
