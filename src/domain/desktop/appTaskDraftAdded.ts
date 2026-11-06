import type { JsonValue } from "../jsonValue.js";
import type { DesktopTaskCheckInput } from "./appTask.js";
import { elementText, isXmlElement } from "./appTaskChecks.js";
import {
  isRenumberedKey,
  isSplitDate,
  isStamp,
  isVolatileValue,
} from "./appTaskDraftNoise.js";
import { valueEqualsCheck } from "./appTaskDraftScalars.js";
import { holdsFields, recordLike, wholeTextCheck } from "./appTaskDraftText.js";
import {
  isIdentifyingAttribute,
  isViewStateName,
  rankAttributes,
} from "./attributeRank.js";
import { escapeToken, pairMembers, resolvePointer } from "./viewPointer.js";

type Suggestion = DesktopTaskCheckInput;

/** Attributes of an added element checked one by one, and new fields of an added record. */
const MAX_ATTRIBUTE_CHECKS = 6;
const MAX_FIELD_CHECKS = 5;
/** A field that repeats its record's identifier, as Tellico's `<id>`, which the app numbers. */
const ID_FIELD = /^(?:[^:]*:)?x?id$/iu;
/** The fewest attributes a sibling must share for an added element to count as its copy: one alone may match by chance. */
const MIN_COPIED = 2;
/** The shortest field text checked: shorter text is too likely to be found elsewhere. */
const MIN_FIELD_CHARS = 3;

/** What checks of an element added whole read: the file, its two ends, whether a check is decided by name there, and the longest text a check compares. */
export interface AddedContext {
  readonly file: string;
  readonly ends: {
    readonly baseline: JsonValue | null;
    readonly final: JsonValue | null;
  };
  readonly named: (view: JsonValue | null, pointer: string) => boolean;
  readonly chars: number;
}

type Element = Extract<JsonValue, Record<string, JsonValue>> & {
  readonly name: string;
  readonly children: JsonValue[];
};

const isRecord = (
  value: JsonValue | undefined,
): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const attributesOf = (element: Element) =>
  isRecord(element.attributes) ? element.attributes : {};

const listOf = (pointer: string) => pointer.replace(/\/[^/]+$/u, "");
const parentElementOf = (pointer: string): string | undefined =>
  /^(?<parent>.+)\/children\/[^/]+$/u.exec(pointer)?.groups?.parent;

/** How many elements with a tag the list a member sits in holds, in a view. */
const likeCount = (view: JsonValue | null, pointer: string, tag: string) => {
  const list = resolvePointer(view, listOf(pointer));
  return Array.isArray(list)
    ? list.filter((item) => isXmlElement(item) && item.name === tag).length
    : 0;
};

/** Whether a like sibling at either end holds every one of the attributes as they are, so they are the app's defaults for a new member rather than what the user entered. */
const copiesSibling = (
  { ends }: AddedContext,
  pointer: string,
  element: Element,
  attributes: readonly { readonly key: string; readonly value: string }[],
) =>
  attributes.length >= MIN_COPIED &&
  [ends.baseline, ends.final].some((view) => {
    const list = resolvePointer(view, listOf(pointer));
    return (
      Array.isArray(list) &&
      list.some(
        (item) =>
          item !== element &&
          isXmlElement(item) &&
          item.name === element.name &&
          attributes.every(
            ({ key, value }) => attributesOf(item)[key] === value,
          ),
      )
    );
  });

/** The attribute keys the last segment of a pointer selects by. */
const selectorKeys = (pointer: string): ReadonlySet<string> => {
  const segment = (pointer.split("/").at(-1) ?? "")
    .replaceAll("~1", "/")
    .replaceAll("~0", "~");
  return new Set(
    [...segment.matchAll(/\[@(?<key>[^=\]]+)=/gu)].map(
      (match) => match.groups?.key ?? "",
    ),
  );
};

/**
 * A `value_equals` per attribute of an element added whole to a list, as
 * HomeBank adds an `<ope>`, ranked by `attributeTier`, at most six: what the
 * user entered. Its selector's own attributes, identifiers, times, volatile
 * values and view state are left out. Empty for an element with no like
 * sibling at either end, or whose other attributes a like sibling holds
 * every one of, as a new Planner task copies its neighbour's defaults; such
 * an element keeps the check that it is there.
 */
export const attributeChecks = (
  context: AddedContext,
  pointer: string,
  element: Element,
): Suggestion[] => {
  const { ends, file } = context;
  if (
    likeCount(ends.final, pointer, element.name) < 2 &&
    likeCount(ends.baseline, pointer, element.name) === 0
  )
    return [];
  const selected = selectorKeys(pointer);
  const own = Object.entries(
    isRecord(element.attributes) ? element.attributes : {},
  ).flatMap(([key, value]) =>
    typeof value === "string" &&
    !selected.has(key) &&
    !isIdentifyingAttribute(key)
      ? [{ key, value }]
      : [],
  );
  if (copiesSibling(context, pointer, element, own)) return [];
  return rankAttributes(
    own.filter(
      ({ key, value }) =>
        !isStamp(value) &&
        !isVolatileValue(value) &&
        !isViewStateName(key) &&
        !isRenumberedKey(key),
    ),
  )
    .slice(0, MAX_ATTRIBUTE_CHECKS)
    .map(({ key, value }) =>
      valueEqualsCheck(
        file,
        `${pointer}/attributes/${escapeToken(key)}`,
        value,
      ),
    );
};

/** The nearest ancestor both ends hold that a check names without a step by position. */
const keptNamedAncestor = (context: AddedContext, pointer: string) => {
  const { ends } = context;
  for (
    let at = parentElementOf(pointer);
    at !== undefined;
    at = parentElementOf(at)
  )
    if (
      context.named(ends.final, at) &&
      isXmlElement(resolvePointer(ends.baseline, at)) &&
      isXmlElement(resolvePointer(ends.final, at))
    )
      return at;
  return undefined;
};

/** The texts an element holds, each trimmed, in document order. */
const leafTexts = (value: JsonValue): string[] =>
  typeof value === "string"
    ? [value.trim()]
    : isXmlElement(value)
      ? value.children.flatMap(leafTexts)
      : [];

/**
 * A `text_contains` per new field of a record added whole that only position
 * names, as Osmo adds a `<record>` of `<first_name>` and `<email_1>` among
 * others, at the nearest ancestor both ends hold that a check can name: up to
 * five fields of three or more characters, each absent from that ancestor's
 * text at the seed, so each fails there. Empty for an element that is no
 * record or has no like sibling.
 */
export const fieldChecks = (
  context: AddedContext,
  pointer: string,
  element: Element,
): Suggestion[] => {
  const { ends, file } = context;
  if (!recordLike(element) || likeCount(ends.final, pointer, element.name) < 2)
    return [];
  const at = keptNamedAncestor(context, pointer);
  if (at === undefined) return [];
  const seen = elementText(resolvePointer(ends.baseline, at) ?? null);
  return [...new Set(leafTexts(element))]
    .filter(
      (text) =>
        text.length >= MIN_FIELD_CHARS &&
        /[\p{L}\d]/u.test(text) &&
        !seen.includes(text) &&
        !isStamp(text) &&
        !isVolatileValue(text),
    )
    .slice(0, MAX_FIELD_CHECKS)
    .map((value) => ({ kind: "text_contains", file, pointer: at, value }));
};

/**
 * A check per field of a record added whole to a list that a selector names,
 * as Tellico adds an `<entry id="4">` of `<title>`, `<authors>`, `<publisher>`
 * and `<pub_year>`: each child element a selector names among the record's
 * children, by its whole text as `wholeTextCheck` checks one, at most five;
 * leaving out a field repeating the record's identifier, a date the app
 * stamps in parts, and text that is blank, a time, a volatile value or past
 * the limit. Empty for an element that `holdsFields` says is no record, or
 * that has no like sibling.
 */
export const recordChecks = (
  context: AddedContext,
  pointer: string,
  element: Element,
): Suggestion[] => {
  const { ends, file } = context;
  if (
    !holdsFields(element) ||
    (likeCount(ends.final, pointer, element.name) < 2 &&
      likeCount(ends.baseline, pointer, element.name) === 0)
  )
    return [];
  const { keys } = pairMembers(element.children, []).newer;
  return element.children
    .flatMap((field, index) => {
      const key = keys[index] ?? "";
      const at = `${pointer}/children/${escapeToken(key)}`;
      if (
        !isXmlElement(field) ||
        !key.startsWith("[") ||
        ID_FIELD.test(field.name) ||
        isSplitDate(field) ||
        !context.named(ends.final, at)
      )
        return [];
      const value = elementText(field);
      return value.trim() === "" ||
        value.length > context.chars ||
        isStamp(value) ||
        isVolatileValue(value)
        ? []
        : [
            wholeTextCheck(
              file,
              at,
              { value, children: field.children },
              undefined,
            ).check,
          ];
    })
    .slice(0, MAX_FIELD_CHECKS);
};
