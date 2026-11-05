import type { JsonValue } from "../jsonValue.js";
import { isTimestamp } from "./appTask.js";

/** One condition of a selector: a member's string field, or with `@` one of its attributes, equal to a value. */
interface Condition {
  readonly attribute: boolean;
  readonly key: string;
  readonly value: string;
}

/** Where a pointer leads in a view. */
export type Located =
  | { readonly kind: "value"; readonly value: JsonValue }
  /** It names no value; `reason` says which last selector matched nothing, when one did. */
  | { readonly kind: "none"; readonly reason?: string }
  /** A selector before the last segment matched no member, or any matched several, or one is malformed. */
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
): { readonly member: JsonValue } | Located => {
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
  const tokens = pointer
    .slice(1)
    .split("/")
    .map((raw) => raw.replaceAll("~1", "/").replaceAll("~0", "~"));
  for (const [position, token] of tokens.entries()) {
    if (Array.isArray(current)) {
      const step = arrayStep(current, token, position === tokens.length - 1);
      if ("kind" in step) return step;
      current = step.member;
    } else if (isRecord(current) && Object.hasOwn(current, token))
      current = current[token] ?? null;
    else return { kind: "none" };
  }
  return { kind: "value", value: current };
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

/**
 * A key per array member: the first selector naming it alone among its
 * siblings and naming at most one member of the other version, or its index.
 */
export const memberKeys = (
  items: readonly JsonValue[],
  other?: ReadonlyMap<string, JsonValue | undefined>,
): readonly string[] => {
  const candidates = items.map(candidateKeys);
  const counts = new Map<string, number>();
  for (const keys of candidates)
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  const single = (key: string) =>
    counts.get(key) === 1 &&
    (other?.has(key) !== true || other.get(key) !== undefined);
  return candidates.map((keys, index) => keys.find(single) ?? String(index));
};

/** The members of another version of an array by each selector that could name them; undefined where several share one. */
export const selectorIndex = (
  items: readonly JsonValue[],
): ReadonlyMap<string, JsonValue | undefined> => {
  const index = new Map<string, JsonValue | undefined>();
  for (const item of items)
    for (const key of candidateKeys(item))
      index.set(key, index.has(key) ? undefined : item);
  return index;
};
