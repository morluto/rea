import type { JsonValue } from "../jsonValue.js";
import { collapseWhitespace, isTimestamp } from "./appTask.js";
import { isIdentifyingAttribute, rankAttributes } from "./attributeRank.js";
import { isPositionalKey, positionalKeys } from "./positionalKeys.js";
import {
  condition,
  countUnspelledPairs,
  MAX_PAIRED,
  pairSuffix,
  type Attribute,
  type Candidates,
} from "./selectorCandidates.js";
import { bracketed, selectorOf, type Condition } from "./viewSelector.js";

/** The arrays a pointer stepped into, each as the pointer to it. */
interface ArraySteps {
  /** Arrays a selector searched, whose every member it had to see. */
  readonly searched: readonly string[];
  /** Arrays it entered by position at a member that is an object or array. */
  readonly byPosition: readonly string[];
}

/** Where a pointer leads in a view, and the arrays it stepped into on the way. */
export type Located = ArraySteps &
  (
    | { readonly kind: "value"; readonly value: JsonValue }
    /** It names no value; `reason` says which last selector matched nothing, when one did. */
    | { readonly kind: "none"; readonly reason?: string }
    /** A selector before the last segment matched no member, or any matched several, or one is malformed. */
    | { readonly kind: "unresolved"; readonly problem: string }
  );

/** Where a step into an array leads, before the steps are attached. */
type Stepped =
  | { readonly kind: "none"; readonly reason?: string }
  | { readonly kind: "unresolved"; readonly problem: string };

const INDEX = /^(?:0|[1-9][0-9]*)$/u;

/** A pointer segment for a key: `~` and `/` escaped as RFC 6901 writes them. */
export const escapeToken = (token: string) =>
  token.replaceAll("~", "~0").replaceAll("/", "~1");

const isRecord = (
  value: JsonValue | null | undefined,
): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const own = (record: Record<string, JsonValue>, key: string) =>
  Object.hasOwn(record, key) ? record[key] : undefined;

/** An element of REA's XML view: its tag name, attributes and children. */
export const isXmlElement = (
  value: JsonValue | null | undefined,
): value is Record<string, JsonValue> & {
  name: string;
  attributes: Record<string, JsonValue>;
  children: JsonValue[];
} =>
  isRecord(value) &&
  typeof value.name === "string" &&
  isRecord(value.attributes) &&
  Array.isArray(value.children);

/**
 * An element's text as XPath's `string()` reads it from what the view keeps:
 * every text node among its children and its descendants', in document order.
 * With `attribute`, the values of that attribute on it and its descendants
 * instead, in document order, and no text node.
 */
export const elementText = (element: JsonValue, attribute?: string): string => {
  const parts: string[] = [];
  const pending: JsonValue[] = [element];
  for (let node = pending.pop(); node !== undefined; node = pending.pop())
    if (typeof node === "string") {
      if (attribute === undefined) parts.push(node);
    } else if (isXmlElement(node)) {
      const value =
        attribute === undefined ? undefined : own(node.attributes, attribute);
      if (typeof value === "string") parts.push(value);
      for (let index = node.children.length - 1; index >= 0; index -= 1)
        pending.push(node.children[index] ?? null);
    }
  return parts.join("");
};

/** The field a condition reads from a member, when it is a string; a child's text is none, since several children may hold one. */
const fieldOf = (member: JsonValue, { prefix, key }: Condition) => {
  if (!isRecord(member) || prefix === ">") return undefined;
  const fields = prefix === "@" ? own(member, "attributes") : member;
  const value = isRecord(fields) ? own(fields, key) : undefined;
  return typeof value === "string" ? value : undefined;
};

/** Whether an element has a child element named `key` whose text, its whitespace collapsed, is `value`. */
const hasChildText = (member: JsonValue, { key, value }: Condition) =>
  isXmlElement(member) &&
  member.children.some(
    (child) =>
      isXmlElement(child) &&
      child.name === key &&
      collapseWhitespace(elementText(child)) === value,
  );

/** Whether an array member meets every condition; selectors compare strings only. */
const selects = (member: JsonValue, conditions: readonly Condition[]) =>
  isRecord(member) &&
  conditions.every((condition) =>
    condition.prefix === ">"
      ? hasChildText(member, condition)
      : fieldOf(member, condition) === condition.value,
  );

/** Whether a member meets a selector's conditions, or undefined when the string is no selector. */
export const selectorTest = (
  selector: string,
): ((member: JsonValue) => boolean) | undefined => {
  const conditions = selectorOf(selector);
  return conditions === undefined
    ? undefined
    : (member) => selects(member, conditions);
};

/** One step into an array: by index, or by a selector that must match one member, or none when it is the last. */
const arrayStep = (
  items: readonly JsonValue[],
  token: string,
  last: boolean,
): { readonly member: JsonValue } | Stepped => {
  if (INDEX.test(token)) {
    const index = Number(token);
    return index < items.length
      ? { member: items[index] ?? null }
      : { kind: "none" };
  }
  const conditions = selectorOf(token);
  if (conditions === undefined)
    return bracketed(token)
      ? {
          kind: "unresolved",
          problem: `${token} is not a selector of the form [KEY=VALUE]`,
        }
      : { kind: "none" };
  const matched = items.filter((item) => selects(item, conditions));
  if (matched.length === 1) return { member: matched[0] ?? null };
  if (matched.length > 1)
    return {
      kind: "unresolved",
      problem: `${token} matches ${String(matched.length)} members, not one`,
    };
  const reason = `${token} matches no member`;
  return last
    ? { kind: "none", reason }
    : { kind: "unresolved", problem: reason };
};

/**
 * Follow an RFC 6901 pointer through a view, where a segment applied to an
 * array may also be a selector: `[KEY=VALUE]` one or more times, naming the one
 * member whose string field KEY equals VALUE, with `@KEY` whose `attributes`
 * hold it, as REA's XML view keeps them, or with `>KEY` that has a child
 * element KEY of that text. So `/root/children/[name=Object][@name=Hole]`
 * is the `Object` element named `Hole`, wherever it sits among its siblings.
 */
export const locatePointer = (
  view: JsonValue | null,
  pointer: string,
): Located => {
  let current: JsonValue = view;
  const segments = pointer.slice(1).split("/");
  const steps = { searched: [] as string[], byPosition: [] as string[] };
  for (const [position, segment] of segments.entries()) {
    const token = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      const array = segments
        .slice(0, position)
        .map((part) => `/${part}`)
        .join("");
      const indexed = INDEX.test(token);
      if (!indexed && selectorOf(token) !== undefined)
        steps.searched.push(array);
      const step = arrayStep(current, token, position === segments.length - 1);
      if ("kind" in step) return { ...step, ...steps };
      if (indexed && typeof step.member === "object" && step.member !== null)
        steps.byPosition.push(array);
      current = step.member;
    } else if (isRecord(current) && Object.hasOwn(current, token))
      current = current[token] ?? null;
    else return { kind: "none", ...steps };
  }
  return { kind: "value", value: current, ...steps };
};

const readsChild = ({ prefix }: Condition) => prefix === ">";

/** Marks selector values several members share, which therefore name none. */
const SHARED = Symbol("shared");

/**
 * A selector's conditions once per field, in field order, so every spelling of
 * one selector reads alike; undefined when it is malformed or two conditions on
 * one field differ, which no member meets.
 */
const normalSelector = (token: string): readonly Condition[] | undefined => {
  const conditions = selectorOf(token);
  if (conditions === undefined) return undefined;
  const byField = new Map<string, Condition>();
  for (const condition of conditions) {
    const field = `${condition.prefix}${condition.key}`;
    const seen = byField.get(field);
    if (seen !== undefined && seen.value !== condition.value) return undefined;
    byField.set(field, condition);
  }
  return [...byField.keys()]
    .sort()
    .flatMap((field) => byField.get(field) ?? []);
};

/** Selectors grouped by the fields they read, each wanted value list with the tokens spelling it. */
const selectorGroups = (tokens: Iterable<string>) => {
  const groups = new Map<
    string,
    { conditions: readonly Condition[]; wanted: Map<string, string[]> }
  >();
  for (const token of tokens) {
    if (INDEX.test(token)) continue;
    const conditions = normalSelector(token);
    if (conditions === undefined || conditions.some(readsChild)) continue;
    const fields = JSON.stringify(
      conditions.map(({ prefix, key }) => [prefix, key]),
    );
    const values = JSON.stringify(conditions.map(({ value }) => value));
    const group = groups.get(fields) ?? { conditions, wanted: new Map() };
    groups.set(fields, group);
    const spellings = group.wanted.get(values);
    if (spellings === undefined) group.wanted.set(values, [token]);
    else spellings.push(token);
  }
  return groups.values();
};

/**
 * The member each selector among `tokens` names alone, found in one pass over
 * the array per set of fields they read, holding only the values they ask for.
 * A selector reading a child's text, which no one field holds, is matched member by member.
 */
const selectedMembers = (
  items: readonly JsonValue[],
  tokens: Iterable<string>,
): ReadonlyMap<string, JsonValue> => {
  const selected = new Map<string, JsonValue>();
  const listed = [...tokens];
  for (const token of listed) {
    const meets = selectorOf(token)?.some(readsChild)
      ? selectorTest(token)
      : undefined;
    const matched = meets === undefined ? [] : items.filter(meets);
    if (matched.length === 1) selected.set(token, matched[0] ?? null);
  }
  for (const { conditions, wanted } of selectorGroups(listed)) {
    const found = new Map<string, JsonValue | typeof SHARED>();
    for (const item of items) {
      const values = conditions.map((condition) => fieldOf(item, condition));
      if (values.some((value) => value === undefined)) continue;
      const key = JSON.stringify(values);
      if (wanted.has(key)) found.set(key, found.has(key) ? SHARED : item);
    }
    for (const [key, member] of found)
      if (member !== SHARED)
        for (const token of wanted.get(key) ?? []) selected.set(token, member);
  }
  return selected;
};

/**
 * What pointer tokens name in one value by the evaluator's rules: an own key,
 * an index, or the one member a selector among `tokens` matches. The selectors
 * are resolved together up front, so many cost one pass per set of fields they
 * read, and what is kept grows with the tokens, not with the array.
 */
export const memberLookup = (
  value: JsonValue | undefined,
  tokens: Iterable<string> = [],
): ((token: string) => JsonValue | undefined) => {
  if (!Array.isArray(value))
    return (token) =>
      isRecord(value) && Object.hasOwn(value, token) ? value[token] : undefined;
  const selected = selectedMembers(value, tokens);
  return (token) =>
    INDEX.test(token) ? value[Number(token)] : selected.get(token);
};

/** The value a pointer names, or undefined when it names none or a selector on its way is unresolved. */
export const resolvePointer = (
  view: JsonValue | null,
  pointer: string,
): JsonValue | undefined => {
  const located = locatePointer(view, pointer);
  return located.kind === "value" ? located.value : undefined;
};

/** A value a selector can carry and that stays the same between saves. */
const selectable = (value: string) =>
  !value.includes("][") && !isTimestamp(value);

/** An attribute name a selector can carry. */
const attributeName = (key: string) => key !== "" && !/[=[\]]/u.test(key);

/** Two-attribute selectors from the attributes `paired`, the best ranked pairs first. */
const pairsOf = (paired: readonly (Attribute & { tier: number })[]) =>
  paired
    .flatMap((first, index) =>
      paired.slice(index + 1).map((second) => ({
        tier: first.tier + second.tier,
        suffix: pairSuffix(first, second),
      })),
    )
    .toSorted((left, right) => left.tier - right.tier)
    .map(({ suffix }) => suffix);

/**
 * The selectors that could name a member, most general first: `[name=N]`;
 * then its identifiers, a `name` attribute first; then each other attribute
 * by itself, a name-like key, a worded value or a small integer first; then
 * two of the best `MAX_PAIRED` of those together; then a coordinate, a long
 * number or a token by itself. All are counted over every sibling, so a
 * selector several siblings match is never taken for one naming a member
 * alone; but an element with identifying attributes is keyed by those alone,
 * so one whose identifiers are new is another element, whatever else it
 * shares. An identifier the app numbers by position (`positional`) names no
 * member. The ids number the name among those seen, so a name is spelled into
 * a selector only once one is chosen, not per attribute.
 */
const candidatesOf = (
  member: JsonValue,
  names: Map<string, number>,
  positional: ReadonlySet<string>,
): Candidates | undefined => {
  if (!isRecord(member)) return undefined;
  const name = own(member, "name");
  if (typeof name !== "string" || !selectable(name)) return undefined;
  const attributes = own(member, "attributes");
  const usable = (
    isRecord(attributes) ? Object.entries(attributes) : []
  ).flatMap(([key, value]) =>
    typeof value === "string" &&
    attributeName(key) &&
    selectable(value) &&
    !isPositionalKey(positional, name, key)
      ? [{ key, value }]
      : [],
  );
  const identities = usable.filter(({ key }) => isIdentifyingAttribute(key));
  const named = (key: string) => key.toLowerCase() === "name";
  const ranked = rankAttributes(
    usable.filter(({ key }) => !isIdentifyingAttribute(key)),
  );
  const pairable = ranked.filter(({ tier }) => tier < 3);
  const suffixes = [
    "",
    ...[
      ...identities.filter(({ key }) => named(key)),
      ...identities.filter(({ key }) => !named(key)),
      ...pairable,
    ].map(condition),
    ...pairsOf(pairable.slice(0, MAX_PAIRED)),
    ...ranked.filter(({ tier }) => tier === 3).map(condition),
  ];
  const number = names.get(name) ?? names.size;
  names.set(name, number);
  // A suffix is empty or opens with `[`, so the number before it cannot run into it.
  const ids = suffixes.map((suffix) => `${String(number)}${suffix}`);
  const choosable =
    identities.length > 0 ? identities.length + 1 : suffixes.length;
  return {
    name,
    number,
    ids,
    choosable,
    pairable: pairable.map(({ key }) => key),
  };
};

/** The selector a member's candidate at `index` spells: its name, then its id past the name's number. */
const selectorAt = ({ name, number, ids }: Candidates, index: number) =>
  `[name=${name}]${(ids[index] ?? "").slice(String(number).length)}`;

const countIds = (members: readonly (Candidates | undefined)[]) => {
  const counts = new Map<string, number>();
  for (const candidates of members)
    for (const id of candidates?.ids ?? [])
      counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
};

/** Each member's place among the members of its tag, as the tag and how many come before it; none for a member with no tag. */
const placesOf = (members: readonly JsonValue[]) => {
  const seen = new Map<string, number>();
  return members.map((member) => {
    const name = isRecord(member) ? own(member, "name") : undefined;
    if (typeof name !== "string") return undefined;
    const before = seen.get(name) ?? 0;
    seen.set(name, before + 1);
    return `${String(before)}\u0000${name}`;
  });
};

/**
 * Whether two members are one element renamed: the same tag and attribute
 * keys, one identifier's value changed and every other attribute and the
 * children alike, as MyPaint renames a layer.
 */
const renamed = (newer: JsonValue, older: JsonValue) => {
  if (!isRecord(newer) || !isRecord(older)) return false;
  const [after, before] = [own(newer, "attributes"), own(older, "attributes")];
  if (
    own(newer, "name") !== own(older, "name") ||
    !isRecord(after) ||
    !isRecord(before)
  )
    return false;
  const keys = Object.keys(after);
  const changed = keys.filter((key) => own(before, key) !== after[key]);
  const [key] = changed;
  return (
    keys.length === Object.keys(before).length &&
    changed.length === 1 &&
    key !== undefined &&
    Object.hasOwn(before, key) &&
    isIdentifyingAttribute(key) &&
    JSON.stringify(own(newer, "children")) ===
      JSON.stringify(own(older, "children"))
  );
};

/** One version's members as a pairing reads and fills them. */
interface Pairing {
  readonly members: readonly JsonValue[];
  readonly candidates: readonly (Candidates | undefined)[];
  readonly counts: ReadonlyMap<string, number>;
  readonly keys: (string | undefined)[];
  readonly partners: (number | undefined)[];
}

/**
 * Pair, as one element `renamed`, a member of each version left unpaired at
 * the same place among the members of its tag, by its first selector past
 * its identifiers that names it alone in both versions with the same value,
 * as a layer by its `src`; left unpaired when none does.
 */
const pairRenamed = (newer: Pairing, older: Pairing) => {
  const unpaired = new Map<string, number>();
  placesOf(older.members).forEach((place, index) => {
    if (place !== undefined && older.partners[index] === undefined)
      unpaired.set(place, index);
  });
  placesOf(newer.members).forEach((place, index) => {
    const match = place === undefined ? undefined : unpaired.get(place);
    const candidates = newer.candidates[index];
    const theirs = match === undefined ? undefined : older.candidates[match];
    if (
      match === undefined ||
      candidates === undefined ||
      theirs === undefined ||
      newer.partners[index] !== undefined ||
      !renamed(newer.members[index] ?? null, older.members[match] ?? null)
    )
      return;
    const at = candidates.ids.findIndex(
      (id, position) =>
        position >= candidates.choosable &&
        newer.counts.get(id) === 1 &&
        older.counts.get(id) === 1 &&
        theirs.ids.includes(id),
    );
    if (at < 0) return;
    newer.keys[index] = older.keys[match] = selectorAt(candidates, at);
    newer.partners[index] = match;
    older.partners[match] = index;
  });
};

/** One version's side of a pairing: each member's key, and the other version's member it pairs with. */
interface PairedSide {
  readonly keys: readonly string[];
  readonly partners: readonly (number | undefined)[];
}

/**
 * Pair the members of two versions of an array one to one. A member pairs by
 * its first candidate selector naming it alone in its version and one unpaired
 * member of the other, whichever before it name nothing there; then one
 * element renamed by another selector (`pairRenamed`). One with no partner
 * keeps its first selector naming it alone and nothing in the other version.
 * Members left without a selector are keyed and paired by position; so is an
 * identifier the app numbers by position, as `positionalKeys` finds.
 */
export const pairMembers = (
  newer: readonly JsonValue[],
  older: readonly JsonValue[],
): { readonly newer: PairedSide; readonly older: PairedSide } => {
  const names = new Map<string, number>();
  const positional = positionalKeys(newer, older);
  const newCandidates = newer.map((member) =>
    candidatesOf(member, names, positional),
  );
  const oldCandidates = older.map((member) =>
    candidatesOf(member, names, positional),
  );
  const newCounts = countIds(newCandidates);
  const oldCounts = countIds(oldCandidates);
  countUnspelledPairs([
    { members: newer, candidates: newCandidates, counts: newCounts },
    { members: older, candidates: oldCandidates, counts: oldCounts },
  ]);
  const count = (counts: ReadonlyMap<string, number>, id: string) =>
    counts.get(id) ?? 0;
  const oldById = new Map<string, number>();
  oldCandidates.forEach((candidates, index) => {
    for (const id of candidates?.ids.slice(0, candidates.choosable) ?? [])
      if (count(oldCounts, id) === 1) oldById.set(id, index);
  });
  const newKeys: (string | undefined)[] = newer.map(() => undefined);
  const oldKeys: (string | undefined)[] = older.map(() => undefined);
  const newPartners: (number | undefined)[] = newer.map(() => undefined);
  const oldPartners: (number | undefined)[] = older.map(() => undefined);
  newCandidates.forEach((candidates, index) => {
    if (candidates === undefined) return;
    for (const [at, id] of candidates.ids
      .slice(0, candidates.choosable)
      .entries()) {
      const match = count(newCounts, id) === 1 ? oldById.get(id) : undefined;
      if (match === undefined || oldPartners[match] !== undefined) continue;
      newKeys[index] = oldKeys[match] = selectorAt(candidates, at);
      newPartners[index] = match;
      oldPartners[match] = index;
      return;
    }
  });
  pairRenamed(
    {
      members: newer,
      candidates: newCandidates,
      counts: newCounts,
      keys: newKeys,
      partners: newPartners,
    },
    {
      members: older,
      candidates: oldCandidates,
      counts: oldCounts,
      keys: oldKeys,
      partners: oldPartners,
    },
  );
  /** The first selector naming a member alone in its version and nothing in the other. */
  const unmatched = (
    candidates: Candidates | undefined,
    here: ReadonlyMap<string, number>,
    there: ReadonlyMap<string, number>,
  ) => {
    if (candidates === undefined) return undefined;
    const at = candidates.ids
      .slice(0, candidates.choosable)
      .findIndex((id) => count(here, id) === 1 && count(there, id) === 0);
    return at < 0 ? undefined : selectorAt(candidates, at);
  };
  newCandidates.forEach((candidates, index) => {
    newKeys[index] ??= unmatched(candidates, newCounts, oldCounts);
  });
  oldCandidates.forEach((candidates, index) => {
    oldKeys[index] ??= unmatched(candidates, oldCounts, newCounts);
  });
  for (let index = 0; index < Math.min(newer.length, older.length); index += 1)
    if (newKeys[index] === undefined && oldKeys[index] === undefined) {
      newPartners[index] = index;
      oldPartners[index] = index;
    }
  const side = (
    keys: readonly (string | undefined)[],
    partners: readonly (number | undefined)[],
  ): PairedSide => ({
    keys: keys.map((key, index) => key ?? String(index)),
    partners,
  });
  return {
    newer: side(newKeys, newPartners),
    older: side(oldKeys, oldPartners),
  };
};
