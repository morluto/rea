import { err, ok, type Result } from "./result.js";

/**
 * What keys a table: a name, or a numeric tag such as an ELF section type.
 */
export type TableKey = string | number;

/** One keyed member of a parsed table, at its position among keyed members. */
export interface KeyedEntry<T, K extends TableKey = string> {
  readonly key: K;
  readonly ordinal: number;
  readonly value: T;
}

/**
 * The keyed members of one parsed table or object, in source order, with
 * every repeated key retained. A lookup states what a repeat means through
 * its selector, instead of inheriting `find` (first) or `Map.set` (last).
 */
export interface Keyed<T, K extends TableKey = string> {
  readonly entries: readonly KeyedEntry<T, K>[];
  /** Keys declared more than once, in the order they first repeat. */
  readonly duplicates: readonly K[];
}

/** A key the format allows once, declared more than once. */
export interface DuplicateKey<K extends TableKey = string> {
  readonly kind: "duplicate";
  readonly key: K;
  /** Ordinals of every declaration of the key. */
  readonly ordinals: readonly number[];
}

/**
 * Key the members of a parsed table. Members without a key (null or
 * undefined), such as an unnamed section, are not keyed and cannot be
 * selected by key.
 */
export const keyedBy = <T, K extends TableKey = string>(
  values: Iterable<T>,
  keyOf: (value: T) => K | null | undefined,
): Keyed<T, K> => {
  const entries: KeyedEntry<T, K>[] = [];
  const seen = new Set<K>();
  const duplicates = new Set<K>();
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
export const uniqueKeyed = <T, K extends TableKey>(
  keyed: Keyed<T, K>,
  key: K,
): Result<T | undefined, DuplicateKey<K>> => {
  const matches = keyed.entries.filter((entry) => entry.key === key);
  if (matches.length > 1)
    return err({
      kind: "duplicate",
      key,
      ordinals: matches.map(({ ordinal }) => ordinal),
    });
  return ok(matches[0]?.value);
};

/**
 * Every declaration of a key the format allows to repeat, in source order,
 * such as same-named sections that a consumer reads together.
 */
export const allKeyed = <T, K extends TableKey>(
  keyed: Keyed<T, K>,
  key: K,
): readonly T[] =>
  keyed.entries.flatMap((entry) => (entry.key === key ? [entry.value] : []));

/**
 * The first or last declaration of a key, for a format whose own consumer
 * defines that precedence. `precedence` states that rule, so a choice among
 * repeats is never inherited from `find` or `Map.set`.
 */
const precedenceKeyed =
  (pick: "first" | "last") =>
  <T, K extends TableKey>(
    keyed: Keyed<T, K>,
    key: K,
    precedence: string,
  ): T | undefined => {
    if (precedence.trim() === "")
      throw new TypeError("A keyed precedence must state its format rule");
    const matches = allKeyed(keyed, key);
    return pick === "first" ? matches[0] : matches.at(-1);
  };

/** The first declaration of a key; see {@link precedenceKeyed}. */
export const firstKeyed = precedenceKeyed("first");
/** The last declaration of a key; see {@link precedenceKeyed}. */
export const lastKeyed = precedenceKeyed("last");
