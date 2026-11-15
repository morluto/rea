import { err, ok, type Result } from "./result.js";

/** One keyed member of a parsed table, at its position among keyed members. */
export interface KeyedEntry<T> {
  readonly key: string;
  readonly ordinal: number;
  readonly value: T;
}

/**
 * The keyed members of one parsed table or object, in source order, with
 * every repeated key retained. A lookup states what a repeat means through
 * its selector, instead of inheriting `find` (first) or `Map.set` (last).
 */
export interface Keyed<T> {
  readonly entries: readonly KeyedEntry<T>[];
  /** Keys declared more than once, in the order they first repeat. */
  readonly duplicates: readonly string[];
}

/** A key the format allows once, declared more than once. */
export interface DuplicateKey {
  readonly kind: "duplicate";
  readonly key: string;
  /** Ordinals of every declaration of the key. */
  readonly ordinals: readonly number[];
}

/**
 * Key the members of a parsed table. Members without a key (null or
 * undefined), such as an unnamed section, are not keyed and cannot be
 * selected by key.
 */
export const keyedBy = <T>(
  values: Iterable<T>,
  keyOf: (value: T) => string | null | undefined,
): Keyed<T> => {
  const entries: KeyedEntry<T>[] = [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    const key = keyOf(value);
    if (key === undefined || key === null) continue;
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
    entries.push({ key, ordinal: entries.length, value });
  }
  return { entries, duplicates: [...duplicates] };
};

/**
 * The single declaration of a key the format allows once: undefined when
 * absent, and a typed failure carrying every ordinal when repeated.
 */
export const uniqueKeyed = <T>(
  keyed: Keyed<T>,
  key: string,
): Result<T | undefined, DuplicateKey> => {
  const matches = keyed.entries.filter((entry) => entry.key === key);
  if (matches.length > 1)
    return err({
      kind: "duplicate",
      key,
      ordinals: matches.map(({ ordinal }) => ordinal),
    });
  return ok(matches[0]?.value);
};
