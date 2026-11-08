import type { JsonValue } from "../jsonValue.js";
import type { DesktopTaskCheckInput } from "./appTask.js";
import { elementText, isXmlElement } from "./appTaskChecks.js";
import {
  isRenumberedKey,
  isBookkeeping,
  isBookkeepingName,
  inSplitDate,
  isStamp,
  isVolatileValue,
} from "./appTaskDraftNoise.js";
import { valueEqualsCheck } from "./appTaskDraftScalars.js";
import {
  holdsFields,
  holdsNoisyText,
  wholeTextCheck,
} from "./appTaskDraftText.js";
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
  /** Fields left unchecked because their text is past `chars`. */
  readonly long?: string[];
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
  const eligible = own.filter(
    ({ key, value }) =>
      !isStamp(value) &&
      !isVolatileValue(
        value,
        isBookkeeping(element) || isBookkeepingName(key),
      ) &&
      !isViewStateName(key) &&
      !isRenumberedKey(key),
  );
  for (const { key, value } of eligible)
    if (value.length > context.chars)
      context.long?.push(`${pointer}/attributes/${escapeToken(key)}`);
  return rankAttributes(
    eligible.filter(({ value }) => value.length <= context.chars),
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

/**
 * A field's text with save-time leaves removed, split where a timestamp sat
 * between them. `Delphine` and `Moreau` around a save time stay two checks;
 * joining them would look for text the file never contains.
 */
const keptFieldPieces = (node: JsonValue, bookkeeping = false): string[] => {
  if (typeof node === "string")
    return isStamp(node) || isVolatileValue(node.trim(), bookkeeping)
      ? []
      : [node];
  if (!isXmlElement(node)) return [];
  const inBookkeeping = bookkeeping || isBookkeeping(node);
  const pieces: string[] = [];
  let run = "";
  const flush = () => {
    if (run !== "") pieces.push(run);
    run = "";
  };
  for (const child of node.children) {
    if (typeof child === "string") {
      if (isStamp(child) || isVolatileValue(child.trim(), inBookkeeping))
        flush();
      else run += child;
      continue;
    }
    if (!isXmlElement(child)) continue;
    if (isStamp(elementText(child))) {
      flush();
      continue;
    }
    const nested = keptFieldPieces(child, inBookkeeping);
    if (nested.length !== 1) {
      flush();
      pieces.push(...nested);
      continue;
    }
    run += nested[0] ?? "";
  }
  flush();
  return pieces;
};

/** An element's text with save-time leaves removed, in document order. */
const plainText = (node: JsonValue | null): string => {
  if (typeof node === "string") return isStamp(node) ? "" : node;
  if (!isXmlElement(node)) return "";
  if (isStamp(elementText(node))) return "";
  return node.children.map((child) => plainText(child)).join("");
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

/**
 * A `text_contains` per new field of a record added whole that only position
 * names, as Osmo adds a `<record>` of `<first_name>` and `<email_1>` among
 * others, at the nearest ancestor both ends hold that a check can name: up to
 * five fields of three or more characters, each absent from that ancestor's
 * text at the seed, so each fails there. A record a selector names is checked
 * itself, so the words have to be in that record. The field's own path is
 * kept, so an identifier, a date stamped in parts and text past the limit are
 * left out, as `recordChecks` leaves them out; a field past the limit is
 * named in `context.long`. Empty for an element that `holdsFields` says is
 * no record, as a paragraph of runs, or that has no like sibling.
 */
export const fieldChecks = (
  context: AddedContext,
  pointer: string,
  element: Element,
): Suggestion[] => {
  const { ends, file } = context;
  if (!holdsFields(element) || likeCount(ends.final, pointer, element.name) < 2)
    return [];
  const at = keptNamedAncestor(context, pointer);
  if (at === undefined) return [];
  // The record's own selector. Words already in another record still have to be here.
  const onRecord = context.named(ends.final, pointer);
  const seen = onRecord
    ? ""
    : elementText(resolvePointer(ends.baseline, at) ?? null);
  const { keys } = pairMembers(element.children, []).newer;
  const texts: string[] = [];
  let alreadySeen = false;
  element.children.forEach((field, index) => {
    if (!isXmlElement(field)) return;
    const key = keys[index] ?? String(index);
    const fieldAt = `${pointer}/children/${key.startsWith("[") ? escapeToken(key) : key}`;
    if (ID_FIELD.test(field.name) || inSplitDate(ends.final, fieldAt)) return;
    for (const value of keptFieldPieces(field)) {
      const text = value.trim();
      if (
        text.length < MIN_FIELD_CHARS ||
        !/[\p{L}\d]/u.test(text) ||
        isStamp(text) ||
        isVolatileValue(text, isBookkeeping(field))
      )
        continue;
      if (seen.includes(text)) {
        alreadySeen = true;
        continue;
      }
      if (value.length > context.chars) {
        context.long?.push(fieldAt);
        continue;
      }
      texts.push(text);
    }
  });
  if (texts.length > 0)
    return [...new Set(texts)].slice(0, MAX_FIELD_CHECKS).map((value) => ({
      kind: "text_contains" as const,
      file,
      pointer: onRecord ? pointer : at,
      value,
    }));
  if (onRecord) return [];
  // Every new field repeats text the seed already has. The list's text shows the record was added, when it fits and holds no save time. A save time stays out of the check: the new record's own text has to be there, and the seed's text has to remain.
  const holder = resolvePointer(ends.final, at);
  const before = resolvePointer(ends.baseline, at);
  const now = elementText(holder ?? null);
  const plain = plainText(holder ?? null);
  const seedPlain = plainText(before ?? null);
  if (
    !alreadySeen ||
    plain === seedPlain ||
    plain.length === 0 ||
    plain.length > context.chars
  )
    return [];
  if (plain === now)
    return [{ kind: "text_equals", file, pointer: at, value: now }];
  const addedPlain = plainText(element);
  const seed = elementText(before ?? null);
  // The seed's own text already passes, so it is not a check. Only text the new record adds, which the seed does not hold, shows that the record is there.
  return addedPlain.length >= MIN_FIELD_CHARS &&
    now.includes(addedPlain) &&
    !seed.includes(addedPlain)
    ? [{ kind: "text_contains", file, pointer: at, value: addedPlain }]
    : [];
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
    .flatMap<Suggestion>((field, index) => {
      const key = keys[index] ?? "";
      const at = `${pointer}/children/${escapeToken(key)}`;
      if (
        !isXmlElement(field) ||
        !key.startsWith("[") ||
        ID_FIELD.test(field.name) ||
        inSplitDate(ends.final, at) ||
        !context.named(ends.final, at)
      )
        return [];
      const value = elementText(field);
      if (holdsNoisyText(field))
        return keptFieldPieces(field).flatMap((piece) => {
          const text = piece.trim();
          return text.length < MIN_FIELD_CHARS ||
            text.length > context.chars ||
            !/[\p{L}\d]/u.test(text) ||
            isStamp(text) ||
            isVolatileValue(text, isBookkeeping(field))
            ? []
            : [
                {
                  kind: "text_contains" as const,
                  file,
                  pointer: at,
                  value: text,
                },
              ];
        });
      return value.trim() === "" ||
        value.length > context.chars ||
        isStamp(value) ||
        isVolatileValue(value, isBookkeeping(field))
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
