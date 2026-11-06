import type { JsonValue } from "../jsonValue.js";
import type { DesktopTaskCheckInput } from "./appTask.js";
import { isStamp } from "./appTaskDraftNoise.js";
import { elementText, isXmlElement, resolvePointer } from "./viewPointer.js";

/** The fewest characters of an item's text a check looks for, and the kept items a draft guards. */
const MIN_TEXT = 3;
const MAX_KEPT = 4;

/** The list a member sits in, and the element holding it. */
const placeOf = (pointer: string) =>
  /^(?<owner>.+)\/children\/[^/]+$/u.exec(pointer)?.groups?.owner;

const NUMBER = /^-?\d+(?:\.\d+)?$/u;

/** Whether an element holds a position of its own, numeric `x` and `y`. */
const placed = (element: JsonValue | undefined) =>
  isXmlElement(element) &&
  ["x", "y"].every((key) => NUMBER.test(String(element.attributes[key] ?? "")));

/**
 * Whether the element at a pointer is an item placed by its own position, as
 * Xournal++ places each `<text x="88.3" y="156.5">` note on a layer: it and a
 * like sibling hold numeric `x` and `y`. Each is then an item of its own,
 * however its tag names text, and never a run of the others' text.
 */
export const isPlacedItem = (
  view: JsonValue | null,
  pointer: string,
): boolean => {
  const element = resolvePointer(view, pointer);
  const owner = placeOf(pointer);
  const list =
    owner === undefined ? undefined : resolvePointer(view, `${owner}/children`);
  return (
    isXmlElement(element) &&
    placed(element) &&
    Array.isArray(list) &&
    list.some(
      (item) =>
        item !== element &&
        isXmlElement(item) &&
        item.name === element.name &&
        placed(item),
    )
  );
};

/** What an item's check reads: a file's two ends, the pointer a check names an element by, and the longest text it compares. */
export interface ItemContext {
  readonly file: string;
  readonly ends: {
    readonly baseline: JsonValue | null;
    readonly final: JsonValue | null;
  };
  readonly name: (pointer: string) => string | undefined;
  readonly chars: number;
}

/** The texts of the other members of a tag in a list, in a view, with their places. */
const siblingTexts = (
  view: JsonValue | null,
  owner: string,
  item: JsonValue & { readonly name: string },
) => {
  const list = resolvePointer(view, `${owner}/children`);
  return (Array.isArray(list) ? list : []).flatMap((sibling, index) =>
    sibling !== item && isXmlElement(sibling) && sibling.name === item.name
      ? [{ text: elementText(sibling).trim(), index }]
      : [],
  );
};

/**
 * The check of an item placed by its own position and added whole: a
 * `text_contains` of its text on the element holding the items, which holds
 * wherever the user places it, and guards of the text of up to four items
 * both ends hold, nearest first; undefined when that element is no check's,
 * or the text is short, a time, past the limit, or there at the seed.
 */
export const placedItemCheck = (
  context: ItemContext,
  pointer: string,
):
  | {
      readonly element: string;
      readonly check: DesktopTaskCheckInput;
      readonly guards: readonly DesktopTaskCheckInput[];
    }
  | undefined => {
  const { ends, file } = context;
  const owner = placeOf(pointer);
  const at = owner === undefined ? undefined : context.name(owner);
  const item = resolvePointer(ends.final, pointer);
  const value = isXmlElement(item) ? elementText(item).trim() : "";
  const seed = at === undefined ? undefined : resolvePointer(ends.baseline, at);
  if (
    owner === undefined ||
    at === undefined ||
    !isXmlElement(item) ||
    !isXmlElement(seed) ||
    value.length < MIN_TEXT ||
    value.length > context.chars ||
    isStamp(value) ||
    elementText(seed).includes(value)
  )
    return undefined;
  const kept = new Set(
    siblingTexts(ends.baseline, owner, item).map(({ text }) => text),
  );
  const list = resolvePointer(ends.final, `${owner}/children`);
  const here = Array.isArray(list) ? list.indexOf(item) : 0;
  const guards = siblingTexts(ends.final, owner, item)
    .filter(({ text }) => text.length >= MIN_TEXT && kept.has(text))
    .toSorted(
      (left, right) =>
        Math.abs(left.index - here) - Math.abs(right.index - here),
    )
    .slice(0, MAX_KEPT)
    .toSorted((left, right) => left.index - right.index)
    .map(({ text }) => ({
      kind: "text_contains" as const,
      file,
      pointer: at,
      value: text,
    }));
  return {
    element: pointer,
    check: { kind: "text_contains", file, pointer: at, value },
    guards,
  };
};
