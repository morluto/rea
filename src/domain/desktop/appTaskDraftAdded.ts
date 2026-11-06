import type { JsonValue } from "../jsonValue.js";
import { collapseWhitespace, type DesktopTaskCheckInput } from "./appTask.js";
import {
  isRenumberedKey,
  inSplitDate,
  isStamp,
  isVolatileValue,
} from "./appTaskDraftNoise.js";
import { valueEqualsCheck } from "./appTaskDraftScalars.js";
import { holdsFields, isRecordAt, wholeTextCheck } from "./appTaskDraftText.js";
import {
  isIdentifyingAttribute,
  isPlaceholder,
  isViewStateName,
  rankAttributes,
} from "./attributeRank.js";
import { pairMembers } from "./memberPairing.js";
import {
  elementText,
  escapeToken,
  isXmlElement,
  resolvePointer,
} from "./viewPointer.js";
import { selectorOf } from "./viewSelector.js";

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
  /** Whether a change at a pointer is noise, which no field check takes. */
  readonly noisy?: (pointer: string) => boolean;
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
  // A record's data is in its fields; an attribute every like record holds alike, as GnuCash's `version`, is its format's.
  const fields = element.children.some(isXmlElement);
  const list = resolvePointer(ends.final, listOf(pointer));
  const likes = (Array.isArray(list) ? list : []).filter(
    (item) =>
      item !== element && isXmlElement(item) && item.name === element.name,
  );
  const everywhere = (key: string, value: string) =>
    likes.every(
      (item) => isXmlElement(item) && attributesOf(item)[key] === value,
    );
  // A value two or more like siblings all hold, as Grisbi's `Cu="1"`, is a default: it comes after what varies.
  const usual = (key: string, value: string) =>
    likes.length > 1 && everywhere(key, value) ? 1 : 0;
  return rankAttributes(
    own.filter(
      ({ key, value }) =>
        !(fields && everywhere(key, value)) &&
        !isPlaceholder(value) &&
        !isStamp(value) &&
        !isVolatileValue(value) &&
        !isViewStateName(key) &&
        !isRenumberedKey(key),
    ),
  )
    .toSorted(
      (left, right) =>
        usual(left.key, left.value) - usual(right.key, right.value),
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
 * text at the seed, so each fails there. Empty for an element that
 * `holdsFields` says is no record, as a paragraph of runs, or that has no
 * like sibling.
 */
export const fieldChecks = (
  context: AddedContext,
  pointer: string,
  element: Element,
): Suggestion[] => {
  const { ends, file } = context;
  if (
    !isRecordAt(ends.final, pointer, element) ||
    likeCount(ends.final, pointer, element.name) < 2
  )
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

/** Each field's text that every like sibling at the end holds in a field of its tag, as Osmo's `<group>None</group>` on every record: a default, not what the user entered. */
const sharedFields = (
  { ends }: AddedContext,
  pointer: string,
  element: Element,
) => {
  const list = resolvePointer(ends.final, listOf(pointer));
  const likes = (Array.isArray(list) ? list : []).filter(
    (item) =>
      item !== element && isXmlElement(item) && item.name === element.name,
  );
  const fields = likes.map(
    (item) =>
      new Set(
        (isXmlElement(item) ? item.children : []).flatMap((field) =>
          isXmlElement(field)
            ? [`${field.name}\u0000${elementText(field)}`]
            : [],
        ),
      ),
  );
  const [first, ...rest] = fields;
  return new Set(
    [...(first ?? [])].filter((field) => rest.every((own) => own.has(field))),
  );
};

/** The child fields a pointer's last selector names its member by, `[>first_name=Delphine]`, as tag NUL text. */
const selectorFields = (pointer: string): ReadonlySet<string> =>
  new Set(
    (
      selectorOf(
        (pointer.split("/").at(-1) ?? "")
          .replaceAll("~1", "/")
          .replaceAll("~0", "~"),
      ) ?? []
    )
      .filter(({ prefix }) => prefix === ">")
      .map(({ key, value }) => `${key}\u0000${value}`),
  );

/**
 * A check per field of a record added whole to a list that a selector names,
 * as Tellico adds an `<entry id="4">` of `<title>`, `<authors>`, `<publisher>`
 * and `<pub_year>`: each child element a selector names among the record's
 * children, by its whole text as `wholeTextCheck` checks one, at most five;
 * leaving out a field repeating the record's identifier, the field its
 * selector names it by, a default a like sibling holds too, a date the app
 * stamps in parts, and text that is blank, a time, a volatile value or past
 * the limit. Empty for an element that `holdsFields` says is no record, or
 * that has no like sibling.
 */
export const recordChecks = (
  context: AddedContext,
  pointer: string,
  element: Element,
): Suggestion[] => {
  const { ends } = context;
  if (
    !isRecordAt(ends.final, pointer, element) ||
    (likeCount(ends.final, pointer, element.name) < 2 &&
      likeCount(ends.baseline, pointer, element.name) === 0)
  )
    return [];
  return fieldsOf(context, pointer, element, true).slice(0, MAX_FIELD_CHECKS);
};

/** Whether an element holds an identifier of its own among its descendants, as GnuCash's `<trn:splits>` holds each split's `<split:id>`, so its whole text holds ids a later save makes anew. */
const holdsIds = (element: Element): boolean =>
  element.children.some(
    (child) =>
      isXmlElement(child) && (ID_FIELD.test(child.name) || holdsIds(child)),
  );

/** Whether a field is a list of records of one tag, as `<trn:splits>` of `<trn:split>`, whose records are checked field by field instead. */
const recordList = (field: Element): boolean => {
  const records = field.children.filter(isXmlElement);
  return (
    records.length > 0 &&
    records.every(
      (record) => record.name === records[0]?.name && holdsFields(record),
    )
  );
};

/** The checks of a record's fields, as `recordChecks` says; a field that lists records, with `nested`, gives its records' own instead. */
const fieldsOf = (
  context: AddedContext,
  pointer: string,
  element: Element,
  nested: boolean,
): Suggestion[] => {
  const { ends, file } = context;
  const { keys } = pairMembers(element.children, []).newer;
  const skipped = new Set([
    ...sharedFields(context, pointer, element),
    ...selectorFields(pointer),
  ]);
  return element.children.flatMap((field, index) => {
    const key = keys[index] ?? "";
    const at = `${pointer}/children/${escapeToken(key)}`;
    if (
      !isXmlElement(field) ||
      !key.startsWith("[") ||
      ID_FIELD.test(field.name) ||
      context.noisy?.(at) === true ||
      [elementText(field), collapseWhitespace(elementText(field))].some(
        (text) => skipped.has(`${field.name}\u0000${text}`),
      ) ||
      inSplitDate(ends.final, at) ||
      !context.named(ends.final, at)
    )
      return [];
    if (nested && recordList(field)) {
      const records = pairMembers(field.children, []).newer.keys;
      return field.children.flatMap((record, place) =>
        isXmlElement(record)
          ? fieldsOf(
              context,
              `${at}/children/${escapeToken(records[place] ?? "")}`,
              record,
              false,
            )
          : [],
      );
    }
    const value = elementText(field);
    return value.trim() === "" ||
      value.length > context.chars ||
      isStamp(value) ||
      isVolatileValue(value) ||
      holdsIds(field)
      ? []
      : [
          wholeTextCheck(
            file,
            at,
            { value, children: field.children },
            undefined,
          ).check,
        ];
  });
};
