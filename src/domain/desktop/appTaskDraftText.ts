import type { JsonValue } from "../jsonValue.js";
import { isTimestamp, type DesktopTaskCheckInput } from "./appTask.js";
import { elementText, isXmlElement } from "./appTaskChecks.js";
import type { DesktopStateDifference } from "./stateChanges.js";
import { resolvePointer } from "./viewPointer.js";

/** The pointers a diff lists, of every kind. */
type Listed = Pick<DesktopStateDifference, "added" | "changed" | "removed">;

/** Where a format's text checks go, and how many and how long a draft keeps. */
export interface TextPlacement {
  /** Whether a pointer is an element of an XML tree both evaluators read alike. */
  readonly inTree: (pointer: string) => boolean;
  /** The pointer a check names an element by, or undefined when the final view cannot decide a check there. */
  readonly name: (pointer: string) => string | undefined;
  readonly limit: { readonly suggestions: number; readonly chars: number };
}

/** Text checks for the elements whose text changed, and the pointers into their runs those checks make redundant. */
export interface WholeTextSuggestions {
  readonly suggestions: readonly DesktopTaskCheckInput[];
  readonly covers: (pointer: string) => boolean;
}

/** The element a listed text node sits in: the pointer up to its last `/children/N`. */
const TEXT_PARENT = /^(?<parent>.+)\/children\/[^/]+$/u;

/**
 * Checks of an element's whole text where an edit changed it, for an app that
 * splits a paragraph into runs as it saves: the element holding each text node
 * the diff lists with more than whitespace in it, the outermost where one holds
 * another, an element at both ends at the pointer `name` gives it, whose text
 * changed and that the final view holds whole.
 */
export const wholeTextSuggestions = (
  file: string,
  change: Listed,
  views: {
    readonly baseline: JsonValue | null;
    readonly final: JsonValue | null;
  },
  place: TextPlacement,
): WholeTextSuggestions => {
  const parents: string[] = [];
  const note = (pointer: string, view: JsonValue | null) => {
    const parent = TEXT_PARENT.exec(pointer)?.groups?.parent;
    const text = resolvePointer(view, pointer);
    if (
      parent !== undefined &&
      typeof text === "string" &&
      !/^[ \t\r\n]*$/u.test(text) &&
      place.inTree(parent) &&
      !parents.includes(parent)
    )
      parents.push(parent);
  };
  for (const pointer of [...change.changed, ...change.added])
    note(pointer, views.final);
  for (const pointer of change.removed) note(pointer, views.baseline);
  const suggested: string[] = [];
  const suggestions: DesktopTaskCheckInput[] = [];
  for (const parent of parents) {
    if (suggestions.length >= place.limit.suggestions) break;
    if (parents.some((other) => parent.startsWith(`${other}/`))) continue;
    const pointer = place.name(parent);
    if (pointer === undefined) continue;
    const now = resolvePointer(views.final, pointer);
    const before = resolvePointer(views.baseline, pointer);
    if (!isXmlElement(now) || !isXmlElement(before)) continue;
    const value = elementText(now);
    if (
      value !== elementText(before) &&
      value.length <= place.limit.chars &&
      !isTimestamp(value)
    ) {
      suggested.push(parent);
      suggestions.push({ kind: "text_equals", file, pointer, value });
    }
  }
  return {
    suggestions,
    covers: (pointer) =>
      suggested.some((parent) => pointer.startsWith(`${parent}/children/`)),
  };
};
