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

/** Why strict UTF-8 decoding of JSON bytes failed. */
export type Utf8JsonDecodeReason = "invalid-utf8" | "too-large";

/** Decoded JSON text, or the classified reason decoding the bytes failed. */
export type Utf8JsonDecodeResult =
  | { readonly ok: true; readonly text: string }
  | {
      readonly ok: false;
      readonly reason: Utf8JsonDecodeReason;
      readonly cause: unknown;
    };

/**
 * Decode JSON bytes as strict UTF-8 without throws. A decoding failure is
 * invalid UTF-8 unless the decoded text would exceed the runtime's
 * single-string limit, which is a size constraint, not malformed input.
 */
export const decodeUtf8Json = (bytes: Uint8Array): Utf8JsonDecodeResult => {
  try {
    return {
      ok: true,
      text: new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes),
    };
  } catch (cause: unknown) {
    return {
      ok: false,
      reason: exceedsSingleStringLimit(cause) ? "too-large" : "invalid-utf8",
      cause,
    };
  }
};

const exceedsSingleStringLimit = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  (("code" in cause && cause.code === "ERR_STRING_TOO_LONG") ||
    (cause instanceof Error &&
      cause.message.startsWith("Cannot create a string longer than ")));
