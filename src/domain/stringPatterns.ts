/** Portable ASCII identifier starting with a letter. */
export const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9._\x2d]*$/u;

/** Stable evidence identifier, also admitting namespace and path separators. */
export const STABLE_IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9._:\x2f\x2d]*$/u;

/** Canonical padded base64, including zero pad bits and the empty encoding. */
export const CANONICAL_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+\x2f]{4})*(?:[A-Za-z0-9+\x2f][AQgw]==|[A-Za-z0-9+\x2f]{2}[AEIMQUYcgkosw048]=)?$/;
