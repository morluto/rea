import type { JsonValue } from "../jsonValue.js";
import { isTimestamp, type DesktopTaskCheckInput } from "./appTask.js";
import { elementText, isXmlElement } from "./appTaskChecks.js";
import {
  isRenumberedKey,
  isViewStateName,
  isVolatileValue,
} from "./appTaskDraftNoise.js";
import { valueEqualsCheck } from "./appTaskDraftScalars.js";
import { isIdentifyingAttribute, rankAttributes } from "./attributeRank.js";
import { escapeToken, resolvePointer } from "./viewPointer.js";

type Suggestion = DesktopTaskCheckInput;

/** Attributes of an added element checked one by one, and new fields of an added record. */
const MAX_ATTRIBUTE_CHECKS = 6;
const MAX_FIELD_CHECKS = 5;
/** The shortest field text checked: shorter text is too likely to be found elsewhere. */
const MIN_FIELD_CHARS = 3;

/** What checks of an element added whole read: the file, its two ends, and whether a check is decided by name there. */
export interface AddedContext {
  readonly file: string;
  readonly ends: {
    readonly baseline: JsonValue | null;
    readonly final: JsonValue | null;
  };
  readonly named: (view: JsonValue | null, pointer: string) => boolean;
}

type Element = Extract<JsonValue, Record<string, JsonValue>> & {
  readonly name: string;
  readonly children: JsonValue[];
};

const isRecord = (
  value: JsonValue | undefined,
): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
 * sibling at either end, which keeps the check that it is there.
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
  return rankAttributes(
    Object.entries(
      isRecord(element.attributes) ? element.attributes : {},
    ).flatMap(([key, value]) =>
      typeof value === "string" &&
      !selected.has(key) &&
      !isIdentifyingAttribute(key) &&
      !isTimestamp(value) &&
      !isVolatileValue(value) &&
      !isViewStateName(key) &&
      !isRenumberedKey(key)
        ? [{ key, value }]
        : [],
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

/** Whether an element holds only elements, as a record holds its fields, layout whitespace aside. */
const recordLike = (element: Element) =>
  element.children.some((child) => isXmlElement(child)) &&
  element.children.every(
    (child) =>
      isXmlElement(child) ||
      (typeof child === "string" && /^[ \t\r\n]*$/u.test(child)),
  );

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
        !isTimestamp(text) &&
        !isVolatileValue(text),
    )
    .slice(0, MAX_FIELD_CHECKS)
    .map((value) => ({ kind: "text_contains", file, pointer: at, value }));
};
