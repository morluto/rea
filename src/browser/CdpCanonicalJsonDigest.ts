import { createHash } from "node:crypto";

import canonicalize from "canonicalize";

/** Hash a value using the canonical JSON representation. */
export const canonicalJsonDigest = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined) throw new TypeError("Expected canonical JSON");
  return createHash("sha256").update(encoded).digest("hex");
};
