import type { JsonValue } from "../jsonValue.js";
import { isTimestamp } from "./appTask.js";

/** One condition of a selector: a member's string field, or with `@` one of its attributes, equal to a value. */
interface Condition {
  readonly attribute: boolean;
  readonly key: string;
  readonly value: string;
}

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

const isRecord = (
  value: JsonValue | null | undefined,
): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const own = (record: Record<string, JsonValue>, key: string) =>
  Object.hasOwn(record, key) ? record[key] : undefined;

const bracketed = (segment: string) =>
  segment.length >= 2 && segment.startsWith("[") && segment.endsWith("]");

/** A segment's conditions when it is a selector; otherwise undefined. A value cannot hold `][`. */
const selectorOf = (segment: string): readonly Condition[] | undefined => {
  if (!bracketed(segment)) return undefined;
  const conditions: Condition[] = [];
  for (const part of segment.slice(1, -1).split("][")) {
    const equals = part.indexOf("=");
    const key = equals < 0 ? "" : part.slice(0, equals);
    const attribute = key.startsWith("@");
    const name = attribute ? key.slice(1) : key;
    if (name === "") return undefined;
    conditions.push({ attribute, key: name, value: part.slice(equals + 1) });
  }
  return conditions;
};

/** Whether an array member meets every condition; selectors compare strings only. */
const selects = (member: JsonValue, conditions: readonly Condition[]) =>
  isRecord(member) &&
  conditions.every(({ attribute, key, value }) => {
    const fields = attribute ? own(member, "attributes") : member;
    return isRecord(fields) && own(fields, key) === value;
  });

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
 * member whose string field KEY equals VALUE, or with `@KEY` whose `attributes`
 * hold it, as REA's XML view keeps them. So `/root/children/[name=Object][@name=Hole]`
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

/** The field a condition reads from a member, when it is a string. */
const fieldOf = (member: JsonValue, { attribute, key }: Condition) => {
  if (!isRecord(member)) return undefined;
  const fields = attribute ? own(member, "attributes") : member;
  const value = isRecord(fields) ? own(fields, key) : undefined;
  return typeof value === "string" ? value : undefined;
};

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
    const field = `${condition.attribute ? "@" : ""}${condition.key}`;
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
    if (conditions === undefined) continue;
    const fields = JSON.stringify(
      conditions.map(({ attribute, key }) => [attribute, key]),
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
 */
const selectedMembers = (
  items: readonly JsonValue[],
  tokens: Iterable<string>,
): ReadonlyMap<string, JsonValue> => {
  const selected = new Map<string, JsonValue>();
  for (const { conditions, wanted } of selectorGroups(tokens)) {
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

/**
 * Selectors that could name a member, most general first: `[name=N]`, then
 * `[name=N][@A=V]` for each attribute, a `name` attribute before the others.
 */
const candidateKeys = (member: JsonValue): readonly string[] => {
  if (!isRecord(member)) return [];
  const name = own(member, "name");
  if (typeof name !== "string" || !selectable(name)) return [];
  const base = `[name=${name}]`;
  const attributes = own(member, "attributes");
  const entries = isRecord(attributes) ? Object.entries(attributes) : [];
  const named = (key: string) => key.toLowerCase() === "name";
  return [
    base,
    ...[
      ...entries.filter(([key]) => named(key)),
      ...entries.filter(([key]) => !named(key)),
    ].flatMap(([key, value]) =>
      typeof value === "string" && attributeName(key) && selectable(value)
        ? [`${base}[@${key}=${value}]`]
        : [],
    ),
  ];
};

const countKeys = (candidates: readonly (readonly string[])[]) => {
  const counts = new Map<string, number>();
  for (const keys of candidates)
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
};

/** One version's side of a pairing: each member's key, and the other version's member it pairs with. */
interface PairedSide {
  readonly keys: readonly string[];
  readonly partners: readonly (number | undefined)[];
}

/**
 * Pair the members of two versions of an array one to one. A member pairs by
 * the first selector naming it alone in its version and one unpaired member of
 * the other; one with no partner keeps a selector naming nothing in the other
 * version. Members left without a selector are keyed and paired by position.
 */
export const pairMembers = (
  newer: readonly JsonValue[],
  older: readonly JsonValue[],
): { readonly newer: PairedSide; readonly older: PairedSide } => {
  const newCandidates = newer.map(candidateKeys);
  const oldCandidates = older.map(candidateKeys);
  const newCounts = countKeys(newCandidates);
  const oldCounts = countKeys(oldCandidates);
  const count = (counts: ReadonlyMap<string, number>, key: string) =>
    counts.get(key) ?? 0;
  const oldByKey = new Map<string, number>();
  oldCandidates.forEach((keys, index) => {
    for (const key of keys)
      if (count(oldCounts, key) === 1) oldByKey.set(key, index);
  });
  const newKeys: (string | undefined)[] = newer.map(() => undefined);
  const oldKeys: (string | undefined)[] = older.map(() => undefined);
  const newPartners: (number | undefined)[] = newer.map(() => undefined);
  const oldPartners: (number | undefined)[] = older.map(() => undefined);
  newCandidates.forEach((keys, index) => {
    for (const key of keys.filter((key) => count(newCounts, key) === 1)) {
      if (count(oldCounts, key) === 0) {
        newKeys[index] = key;
        return;
      }
      const match = oldByKey.get(key);
      if (match !== undefined && oldPartners[match] === undefined) {
        newKeys[index] = oldKeys[match] = key;
        newPartners[index] = match;
        oldPartners[match] = index;
        return;
      }
    }
  });
  oldCandidates.forEach((keys, index) => {
    oldKeys[index] ??= keys.find(
      (key) => count(oldCounts, key) === 1 && count(newCounts, key) === 0,
    );
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
