import type { JsonValue } from "../jsonValue.js";

const isRecord = (
  value: JsonValue | null | undefined,
): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const own = (record: Record<string, JsonValue>, key: string) =>
  Object.hasOwn(record, key) ? record[key] : undefined;

/**
 * A member's selectors as its name and the ids they are counted by, the
 * number its name is counted by and then the conditions after the name; how
 * many of them, from the first, may key it; and the keys of its attributes
 * that pair, best ranked first, its pairs spelled from the first
 * `MAX_PAIRED`.
 */
export interface Candidates {
  readonly name: string;
  readonly number: number;
  readonly ids: readonly string[];
  readonly choosable: number;
  readonly pairable: readonly string[];
}

/** Attributes, from the best ranked, that pair into two-attribute selectors. */
export const MAX_PAIRED = 6;

export type Attribute = { readonly key: string; readonly value: string };

export const condition = ({ key, value }: Attribute) => `[@${key}=${value}]`;

/** A two-attribute selector's conditions, its keys in canonical order, so the order an app writes attributes in never splits a count. */
export const pairSuffix = (first: Attribute, second: Attribute) =>
  first.key < second.key
    ? `${condition(first)}${condition(second)}`
    : `${condition(second)}${condition(first)}`;

/** One version's members, their candidates, and how many members each id names. */
interface CountedVersion {
  readonly members: readonly JsonValue[];
  readonly candidates: readonly (Candidates | undefined)[];
  readonly counts: Map<string, number>;
}

/**
 * By name number, each key some member ranks past its pairs, with the keys
 * another member of that name pairs it with.
 */
const partnersOf = (versions: readonly CountedVersion[]) => {
  const unpaired = new Map<number, Set<string>>();
  for (const { candidates } of versions)
    for (const member of candidates) {
      if (member === undefined || member.pairable.length <= MAX_PAIRED)
        continue;
      const keys = unpaired.get(member.number) ?? new Set<string>();
      unpaired.set(member.number, keys);
      for (const key of member.pairable.slice(MAX_PAIRED)) keys.add(key);
    }
  const partners = new Map<number, Map<string, Set<string>>>();
  for (const { candidates } of versions)
    for (const member of candidates) {
      const keys = member && unpaired.get(member.number);
      if (member === undefined || keys === undefined) continue;
      const paired = member.pairable.slice(0, MAX_PAIRED);
      for (const key of paired.filter((pairs) => keys.has(pairs))) {
        const byKey = partners.get(member.number) ?? new Map();
        partners.set(member.number, byKey);
        const others = byKey.get(key) ?? new Set<string>();
        byKey.set(key, others);
        for (const other of paired.filter((other) => other !== key))
          others.add(other);
      }
    }
  return partners;
};

/**
 * The ids of the pairs `byKey` lists that a member holds both values of
 * without spelling them, one key ranking past its first `MAX_PAIRED`; a pair
 * of two such keys once.
 */
const unspelledPairs = (
  member: Candidates,
  attributes: Record<string, JsonValue>,
  byKey: ReadonlyMap<string, ReadonlySet<string>>,
): string[] => {
  const unpaired = member.pairable.slice(MAX_PAIRED);
  const past = new Set(unpaired);
  const ids: string[] = [];
  for (const key of unpaired)
    for (const other of byKey.get(key) ?? []) {
      const [left, right] = [own(attributes, key), own(attributes, other)];
      if (
        typeof left === "string" &&
        typeof right === "string" &&
        !(past.has(other) && other < key)
      )
        ids.push(
          `${String(member.number)}${pairSuffix({ key, value: left }, { key: other, value: right })}`,
        );
    }
  return ids;
};

/**
 * Count each pair a member holds both values of but never spelled, as it
 * ranks one of the keys past its `MAX_PAIRED`, for the pairs some member of
 * either version spells: their selector matches that member too. Only the
 * keys members rank past their pairs are read again, with the keys others
 * pair them with, so a version where every member ranks few costs nothing.
 */
export const countUnspelledPairs = (versions: readonly CountedVersion[]) => {
  const partners = partnersOf(versions);
  if (partners.size === 0) return;
  const spelled = (id: string) => versions.some(({ counts }) => counts.has(id));
  for (const { members, candidates, counts } of versions)
    candidates.forEach((member, index) => {
      const item = members[index];
      const attributes = isRecord(item) ? own(item, "attributes") : undefined;
      const byKey = member && partners.get(member.number);
      if (member === undefined || byKey === undefined || !isRecord(attributes))
        return;
      for (const id of unspelledPairs(member, attributes, byKey))
        if (spelled(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
    });
};
