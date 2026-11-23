import { digestCanonicalValue } from "./canonicalDigest.js";
import type { NotExcerpt } from "./excerpt.js";

/**
 * Retain short exact string keys or commit their value in a reserved digest
 * namespace. A display excerpt is not the value, so it is refused.
 */
export const compactStringIdentityKey = <Value extends string>(
  value: NotExcerpt<Value>,
): string => {
  const prefix = "value-sha256:";
  const digestKey = `${prefix}${digestCanonicalValue(value, "String identity")}`;
  return value.length <= digestKey.length && !value.startsWith(prefix)
    ? value
    : digestKey;
};
