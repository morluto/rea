import type { JsonValue } from "../jsonValue.js";
import { isIdentifyingAttribute } from "./attributeRank.js";

const isRecord = (
  value: JsonValue | null | undefined,
): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** An identifier of the members with one tag, as `tag` NUL `key`. */
const tagKey = (tag: string, key: string) => `${tag}\u0000${key}`;

/** Members of an array by tag, each with its string attributes, in document order. */
const attributesByTag = (items: readonly JsonValue[]) => {
  const byTag = new Map<string, Record<string, string>[]>();
  for (const item of items) {
    if (!isRecord(item) || typeof item.name !== "string") continue;
    const attributes = isRecord(item.attributes) ? item.attributes : {};
    const strings = Object.fromEntries(
      Object.entries(attributes).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const members = byTag.get(item.name);
    if (members === undefined) byTag.set(item.name, [strings]);
    else members.push(strings);
  }
  return byTag;
};

/** The identifiers every member holds, numbering them 1..N or 0..N-1 in document order. */
const sequenceKeys = (members: readonly Record<string, string>[]) => {
  const [first] = members;
  return Object.keys(first ?? {}).filter(
    (key) =>
      isIdentifyingAttribute(key) &&
      [0, 1].some((start) =>
        members.every((member, index) => member[key] === String(start + index)),
      ),
  );
};

/** Whether an attribute other than `key` names one member alone at both ends, and that member's `key` differs between them. */
const shifted = (
  newer: readonly Record<string, string>[],
  older: readonly Record<string, string>[],
  key: string,
) => {
  const alone = (members: readonly Record<string, string>[], other: string) => {
    const counts = new Map<string, number>();
    for (const member of members) {
      const value = member[other];
      if (value !== undefined) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return new Map(
      members.flatMap((member) => {
        const value = member[other];
        return value !== undefined && counts.get(value) === 1
          ? [[value, member] as const]
          : [];
      }),
    );
  };
  const others = new Set(
    [...newer, ...older].flatMap((member) => Object.keys(member)),
  );
  others.delete(key);
  return [...others].some((other) => {
    const before = alone(older, other);
    return [...alone(newer, other)].some(([value, member]) => {
      const old = before.get(value);
      return old !== undefined && old[key] !== member[key];
    });
  });
};

/**
 * Identifiers an app numbers by position, as Planner numbers its tasks 1..N
 * on every save: at both ends the members with a tag hold it as 1..N or
 * 0..N-1 in document order, and a member another attribute names alone at
 * both ends holds a different one at each, so inserting a member shifted the
 * rest. Such an identifier says where a member is, not which one it is.
 */
export const positionalKeys = (
  newer: readonly JsonValue[],
  older: readonly JsonValue[],
): ReadonlySet<string> => {
  const before = attributesByTag(older);
  const keys = new Set<string>();
  for (const [tag, members] of attributesByTag(newer)) {
    const old = before.get(tag) ?? [];
    const sequenced = new Set(sequenceKeys(old));
    for (const key of sequenceKeys(members))
      if (sequenced.has(key) && shifted(members, old, key))
        keys.add(tagKey(tag, key));
  }
  return keys;
};

/** Whether `positionalKeys` holds an identifier of members with a tag. */
export const isPositionalKey = (
  keys: ReadonlySet<string>,
  tag: string,
  key: string,
) => keys.has(tagKey(tag, key));
