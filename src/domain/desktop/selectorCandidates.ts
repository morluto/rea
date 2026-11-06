import type { JsonValue } from "../jsonValue.js";
import { isTimestamp } from "./appTask.js";
import {
  isGeneratedId,
  isIdentifyingAttribute,
  isNameLikeKey,
  isPlaceholder,
  rankAttributes,
} from "./attributeRank.js";
import { selectorOf, spellCondition, type Condition } from "./viewSelector.js";

const isRecord = (
  value: JsonValue | null | undefined,
): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const own = (record: Record<string, JsonValue>, key: string) =>
  Object.hasOwn(record, key) ? record[key] : undefined;

/**
 * A member's selectors as its name and the ids they are counted by, the
 * number its name is counted by and then the conditions after the name; how
 * many of them, from the first, may key it, where those by a child's text
 * start, and those by its stable identifiers end; how many ids the app
 * generated close the list; and the keys of its attributes that pair, best
 * ranked first, its pairs spelled from the first `MAX_PAIRED`.
 */
export interface Candidates {
  readonly name: string;
  readonly number: number;
  readonly ids: readonly string[];
  readonly choosable: number;
  readonly byChild: number;
  readonly identified: number;
  readonly generated: number;
  readonly pairable: readonly string[];
}

/** Attributes, from the best ranked, that pair into two-attribute selectors. */
export const MAX_PAIRED = 6;

/** An attribute a selector conditions on, as `@KEY=VALUE`. */
export type Attribute = Omit<Condition, "prefix">;

export const condition = ({ key, value }: Attribute) =>
  spellCondition({ prefix: "@", key, value });

/** A two-attribute selector's conditions, its keys in canonical order, so the order an app writes attributes in never splits a count. */
export const pairSuffix = (first: Attribute, second: Attribute) =>
  first.key < second.key
    ? `${condition(first)}${condition(second)}`
    : `${condition(second)}${condition(first)}`;

/** The longest child text a selector names a member by. */
const MAX_CHILD_TEXT = 64;

/**
 * An element's text with its whitespace collapsed as `collapseWhitespace`
 * does, as `[>CHILD=VALUE]` reads it, whatever elements hold it, so every
 * member a selector matches counts; collapsed as it is read, and undefined
 * once longer than a selector names a member by.
 */
const shortText = (element: JsonValue): string | undefined => {
  let text = "";
  let space = false;
  /** Add a text node's characters, collapsed; false once the text is past the limit, read no further. */
  const append = (node: string) => {
    for (const character of node)
      if (" \t\r\n".includes(character)) space = text !== "";
      else {
        text += `${space ? " " : ""}${character}`;
        space = false;
        if (text.length > MAX_CHILD_TEXT) return false;
      }
    return true;
  };
  const pending: JsonValue[] = [element];
  for (let node = pending.pop(); node !== undefined; node = pending.pop())
    if (typeof node === "string") {
      if (!append(node)) return undefined;
    } else if (isRecord(node) && Array.isArray(node.children))
      for (let index = node.children.length - 1; index >= 0; index -= 1)
        pending.push(node.children[index] ?? null);
  return text;
};

/**
 * The `[>CHILD=VALUE]` conditions that could name an element by a child's
 * text, best first by `attributeTier`: a name-like tag, as Osmo's
 * `first_name`, then worded text, then a small integer, then other numbers.
 * A child whose text is long, blank, a time, or a token or id a program
 * generates names nothing a later save keeps.
 */
export const childConditions = (member: JsonValue): string[] => {
  const children = isRecord(member) ? own(member, "children") : undefined;
  const found = (Array.isArray(children) ? children : []).flatMap((child) => {
    const key = isRecord(child) ? own(child, "name") : undefined;
    const value = typeof key === "string" ? shortText(child) : undefined;
    return typeof key === "string" &&
      value !== undefined &&
      key !== "" &&
      !/[=[\]]/u.test(key) &&
      /[\p{L}\d]/u.test(value) &&
      !value.includes("][") &&
      !isTimestamp(value) &&
      !isGeneratedId(value) &&
      !isPlaceholder(value) &&
      !/\d{10}/u.test(value)
      ? [{ key, value }]
      : [];
  });
  return [
    ...new Set(
      rankAttributes(found).map(({ key, value }) =>
        spellCondition({ prefix: ">", key, value }),
      ),
    ),
  ];
};

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

/** An identifier that holds its value at both versions and a selector can carry. */
const keptIdentifier = (
  after: Record<string, JsonValue>,
  before: Record<string, JsonValue>,
  name: string,
) => {
  const value = after[name];
  return typeof value === "string" &&
    value === before[name] &&
    !/[=[\]]/u.test(name) &&
    !value.includes("][") &&
    !isTimestamp(value)
    ? condition({ key: name, value })
    : undefined;
};

/** Whether an element holds elements and no text of its own, as Gnumeric's `gnm:Sheet` its name and cells. */
const holdsElements = (member: JsonValue) => {
  const children = isRecord(member) ? own(member, "children") : undefined;
  const all = Array.isArray(children) ? children : [];
  return (
    all.some((child) => isRecord(child)) &&
    all.every((child) => typeof child !== "string" || child.trim() === "")
  );
};

/** Whether an element holds a list, two or more elements of one tag and no text of its own, as Dia's layer its boxes. */
const isContainer = (member: JsonValue) => {
  const children = isRecord(member) ? own(member, "children") : undefined;
  const all = Array.isArray(children) ? children : [];
  const tags = all.flatMap((child) => {
    const tag = isRecord(child) ? own(child, "name") : undefined;
    return typeof tag === "string" ? [tag] : [];
  });
  return (
    new Set(tags).size < tags.length &&
    all.every((child) => typeof child !== "string" || child.trim() === "")
  );
};

/**
 * A condition that keeps a member its tag alone names its own once the app
 * adds a sibling of that tag, as Dia adds an empty `Background` layer each
 * time it reopens a diagram, for a list's container with an identifier, a
 * kind a document can hold several of: an id both versions hold, which a new
 * sibling would not share; else a child's text both hold, which an empty one
 * lacks; else its `name`, which a new one may repeat, as Dia's do. `nested`,
 * for a member of a list named for its tag, as a `gnm:Sheet` in
 * `gnm:Sheets`, takes any element holding elements, and only a name-like
 * child, as `[>gnm:Name=Budget]`. Undefined when none is there.
 */
export const holdingCondition = (
  newer: JsonValue,
  older: JsonValue,
  nested = false,
): string | undefined => {
  const attributesOf = (member: JsonValue) => {
    const attributes = isRecord(member) ? own(member, "attributes") : undefined;
    return isRecord(attributes) ? attributes : {};
  };
  const [after, before] = [attributesOf(newer), attributesOf(older)];
  const identifiers = (nested ? holdsElements : isContainer)(newer)
    ? Object.keys(after).filter(isIdentifyingAttribute)
    : [];
  const named = (key: string) => key.toLowerCase() === "name";
  const theirs = new Set(childConditions(older));
  const children = childConditions(newer).filter(
    (spelled) =>
      theirs.has(spelled) &&
      (!nested || isNameLikeKey(selectorOf(spelled)?.[0]?.key ?? "")),
  );
  const kept = (keys: readonly string[]) =>
    keys.flatMap((key) => keptIdentifier(after, before, key) ?? [])[0];
  return identifiers.length === 0 && !(nested && holdsElements(newer))
    ? undefined
    : (kept(identifiers.filter((key) => !named(key))) ??
        children[0] ??
        kept(identifiers.filter(named)));
};
