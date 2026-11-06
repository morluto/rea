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

/** Each member another attribute's value names alone among `members`, by that attribute and value. */
const aloneBy = (members: readonly Record<string, string>[], other: string) => {
  const counts = new Map<string, number>();
  for (const member of members) {
    const value = member[other];
    if (value !== undefined) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return new Map(
    members.flatMap((member, index) => {
      const value = member[other];
      return value !== undefined && counts.get(value) === 1
        ? [[value, index] as const]
        : [];
    }),
  );
};

/**
 * Whether `key` shifted as inserting or removing members shifts a numbering
 * by position: the count of members changed, and every member an attribute
 * other than `key` names alone at both ends kept its number or moved it the
 * way the count did, by no more than the count did and no less than a member
 * before it moved; and one moved. A value that only moved between members,
 * as two items swapping colours, is an edit, not a shift; so is one that
 * pairs a member with two others.
 */
const shifted = (
  newer: readonly Record<string, string>[],
  older: readonly Record<string, string>[],
  key: string,
) => {
  const change = newer.length - older.length;
  if (change === 0) return false;
  const others = new Set(
    [...newer, ...older].flatMap((member) => Object.keys(member)),
  );
  others.delete(key);
  const moves = new Map<number, number>();
  for (const other of others) {
    const before = aloneBy(older, other);
    for (const [value, index] of aloneBy(newer, other)) {
      const old = before.get(value);
      if (old === undefined) continue;
      const move = Number(newer[index]?.[key]) - Number(older[old]?.[key]);
      // Two attributes pairing one member with two others is no shift.
      if ((moves.get(old) ?? move) !== move) return false;
      moves.set(old, move);
    }
  }
  let reached = 0;
  for (const [, move] of [...moves].toSorted(
    ([left], [right]) => left - right,
  )) {
    const size = Math.sign(change) * move;
    if (size < reached || size > Math.abs(change)) return false;
    reached = size;
  }
  return reached > 0;
};

/**
 * Identifiers an app numbers by position, as Planner numbers its tasks 1..N
 * on every save: at both ends the members with a tag hold it as 1..N or
 * 0..N-1 in document order, and inserting or removing members `shifted` the
 * numbers of those after them. Such an identifier says where a member is, not
 * which one it is.
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

/**
 * Whether an attribute's values on the members with a tag end in numbers that
 * count up or down by one in document order, as MyPaint names each layer's
 * `src` `data/layer-00.png`, `data/layer-01.png` and on along the stack on
 * every save: they say where a member sits, not which it is.
 */
export const numberedInOrder = (
  members: readonly JsonValue[],
  tag: string,
  key: string,
): boolean => {
  const numbers = (attributesByTag(members).get(tag) ?? []).map((attributes) =>
    Number(
      /(?<n>\d+)\D*$/u.exec(attributes[key] ?? "")?.groups?.n ?? Number.NaN,
    ),
  );
  const [first, second] = numbers;
  if (first === undefined || second === undefined) return false;
  const step = second - first;
  return (
    Math.abs(step) === 1 &&
    numbers.every((number, index) => number === first + step * index)
  );
};
