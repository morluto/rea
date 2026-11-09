import type { JsonValue } from "../jsonValue.js";
import { collapseWhitespace, isTimestamp } from "./appTask.js";
import {
  bracketed,
  insideSteps,
  selectorOf,
  type Condition,
} from "./viewSelector.js";

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

/** The field a condition reads from a member, when it is a string; what a path inside it reads is none, since several elements may hold one. */
const fieldOf = (member: JsonValue, { prefix, key }: Condition) => {
  if (!isRecord(member) || prefix === ">") return undefined;
  const fields = prefix === "@" ? own(member, "attributes") : member;
  const value = isRecord(fields) ? own(fields, key) : undefined;
  return typeof value === "string" ? value : undefined;
};

/** An element's text with save-time leaves removed, so a name around a timestamp still matches after the time changes. */
const textWithoutStamps = (node: JsonValue): string => {
  if (typeof node === "string") return isTimestamp(node) ? "" : node;
  if (!isRecord(node) || !Array.isArray(node.children)) return "";
  return node.children.map((child) => textWithoutStamps(child)).join("");
};

/** A child's text as a condition reads it: whitespace collapsed, without a nested save time unless it is only a time. */
const conditionText = (child: JsonValue): string => {
  const plain = collapseWhitespace(textWithoutStamps(child));
  return plain === "" ? collapseWhitespace(elementText(child)) : plain;
};

/**
 * Whether an element has a child element named the first step that holds
 * `value` along the rest: at the last step its text, whitespace collapsed,
 * or with `NAME@ATTR` its attribute ATTR. Each element on the way is visited once.
 */
const elementHolds = (
  element: { readonly children: readonly JsonValue[] },
  steps: readonly string[],
  value: string,
): boolean => {
  const [step = "", ...rest] = steps;
  const at = rest.length === 0 ? step.indexOf("@") : -1;
  const name = at < 0 ? step : step.slice(0, at);
  return element.children.some(
    (child) =>
      isXmlElement(child) &&
      child.name === name &&
      (rest.length > 0
        ? elementHolds(child, rest, value)
        : at < 0
          ? conditionText(child) === value
          : own(child.attributes, step.slice(at + 1)) === value),
  );
};

/** Whether a `>` condition's path inside a member holds its value: in an XML element as `elementHolds` reads it, in a JSON record the string at those keys. */
const holdsInside = (
  member: JsonValue,
  { key, value }: Condition,
  format: string | null | undefined,
) => {
  const steps = insideSteps(key) ?? [];
  if (format === "xml")
    return isXmlElement(member) && elementHolds(member, steps, value);
  let found: JsonValue | undefined = member;
  for (const step of steps)
    found = isRecord(found) ? own(found, step) : undefined;
  return found === value;
};

/** Whether an array member meets every condition; selectors compare strings only. */
const selects = (
  member: JsonValue,
  conditions: readonly Condition[],
  format: string | null | undefined,
) =>
  isRecord(member) &&
  conditions.every((condition) =>
    condition.prefix === ">"
      ? holdsInside(member, condition, format)
      : fieldOf(member, condition) === condition.value,
  );

/** Whether a member meets a selector's conditions, or undefined when the string is no selector. */
export const selectorTest = (
  selector: string,
  format: string | null | undefined,
): ((member: JsonValue) => boolean) | undefined => {
  const conditions = selectorOf(selector);
  return conditions === undefined
    ? undefined
    : (member) => selects(member, conditions, format);
};

/** One step into an array: by index, or by a selector that must match one member, or none when it is the last. */
const arrayStep = (
  items: readonly JsonValue[],
  token: string,
  last: boolean,
  format: string | null | undefined,
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
  const matched = items.filter((item) => selects(item, conditions, format));
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
 * hold it, as REA's XML view keeps them, or with `>PATH` that holds it up to
 * three steps inside: a child element KEY of that text, `KEY/SUB` a grandchild,
 * `KEY@ATTR` a child's attribute, or in a JSON record the string at those keys.
 * So `/root/children/[name=Object][@name=Hole]` is the `Object` element named
 * `Hole`, wherever it sits among its siblings. A step is decoded before it is
 * read as a selector, so a path's `/` is written `~1`.
 */
export const locatePointer = (
  view: JsonValue | null,
  pointer: string,
  format: string | null | undefined,
): Located => {
  if (pointer === "")
    return { kind: "value", value: view, searched: [], byPosition: [] };
  let current: JsonValue = view;
  let currentFormat = format;
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
      const step = arrayStep(
        current,
        token,
        position === segments.length - 1,
        currentFormat,
      );
      if ("kind" in step) return { ...step, ...steps };
      if (indexed && typeof step.member === "object" && step.member !== null)
        steps.byPosition.push(array);
      current = step.member;
    } else if (isRecord(current) && Object.hasOwn(current, token)) {
      // The archive entry is metadata until its view is entered.
      if (
        format === "zip" &&
        position === 2 &&
        segments[0] === "entries" &&
        token === "view"
      )
        currentFormat =
          typeof current.format === "string" ? current.format : undefined;
      current = current[token] ?? null;
    } else return { kind: "none", ...steps };
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
  format: string | null | undefined,
): ReadonlyMap<string, JsonValue> => {
  const selected = new Map<string, JsonValue>();
  const listed = [...tokens];
  for (const token of listed) {
    const meets = selectorOf(token)?.some(readsChild)
      ? selectorTest(token, format)
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
  tokens: Iterable<string>,
  format: string | null | undefined,
): ((token: string) => JsonValue | undefined) => {
  if (!Array.isArray(value))
    return (token) =>
      isRecord(value) && Object.hasOwn(value, token) ? value[token] : undefined;
  const selected = selectedMembers(value, tokens, format);
  return (token) =>
    INDEX.test(token) ? value[Number(token)] : selected.get(token);
};

/** The value a pointer names, or undefined when it names none or a selector on its way is unresolved. */
export const resolvePointer = (
  view: JsonValue | null,
  pointer: string,
  format: string | null | undefined,
): JsonValue | undefined => {
  const located = locatePointer(view, pointer, format);
  return located.kind === "value" ? located.value : undefined;
};
