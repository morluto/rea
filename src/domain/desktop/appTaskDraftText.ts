import type { JsonValue } from "../jsonValue.js";
import { isTimestamp, type DesktopTaskCheckInput } from "./appTask.js";
import { elementText, isXmlElement } from "./appTaskChecks.js";
import type { DesktopStateDifference } from "./stateChanges.js";
import { resolvePointer } from "./viewPointer.js";

/** The pointers a diff lists, of every kind. */
type Listed = Pick<DesktopStateDifference, "added" | "changed" | "removed">;

/** A file's views at its two ends. */
interface Ends {
  readonly baseline: JsonValue | null;
  readonly final: JsonValue | null;
}

/** Where a format's text checks go, and how many and how long a draft keeps. */
export interface TextPlacement {
  /** Whether a pointer is an element of an XML tree both evaluators read alike. */
  readonly inTree: (pointer: string) => boolean;
  /** The pointer a check names an element by, or undefined when the final view cannot decide a check there. */
  readonly name: (pointer: string) => string | undefined;
  readonly limit: { readonly suggestions: number; readonly chars: number };
}

/** Text checks for the elements whose text changed, and the pointers into them those checks make redundant: text and whole runs, not an attribute or name of an element both ends hold. */
export interface WholeTextSuggestions {
  readonly suggestions: readonly DesktopTaskCheckInput[];
  readonly covers: (pointer: string) => boolean;
}

/** The element a member of `children` sits in: the pointer up to its last `/children/N`; none for the root. */
const parentOf = (pointer: string): string | undefined =>
  /^(?<parent>.+)\/children\/[^/]+$/u.exec(pointer)?.groups?.parent;

const isWhitespace = (text: string) => /^[ \t\r\n]*$/u.test(text);

/** The element whose name or attribute a pointer reaches; none for text or a whole element. */
const ownerOf = (pointer: string): string | undefined => {
  const segments = pointer.split("/");
  // An attribute's own key may be `name` or `attributes`, so `attributes` is read one up first.
  if (segments.at(-2) === "attributes") return segments.slice(0, -2).join("/");
  const last = segments.at(-1);
  return last === "attributes" || last === "name"
    ? segments.slice(0, -1).join("/")
    : undefined;
};

/** Whether an element holds text of its own beside its children, as a paragraph holds the text between its runs. */
const holdsText = (value: JsonValue | undefined): boolean =>
  isXmlElement(value) &&
  value.children.some(
    (child) => typeof child === "string" && !isWhitespace(child),
  );

/** An element's parent below the document's root, whose text a check could read instead; none for a child of the root. */
const parentBelowRoot = (pointer: string): string | undefined => {
  const parent = parentOf(pointer);
  return parent === undefined || parentOf(parent) === undefined
    ? undefined
    : parent;
};

/** Whether the diff names an element by one of its attributes, as `[name=p][@xid=6]`, rather than by its tag alone or its position. */
const namedByAttribute = (pointer: string) =>
  (pointer.split("/").at(-1) ?? "").includes("[@");

/**
 * The element a text check goes to for one whose text changed, so the check
 * names the paragraph, which a later save keeps, rather than a run it may split
 * or merge: up from an element in mixed content (its parent holds text beside
 * it, at either end) to the nearest that is not, then, from one named by tag or
 * position alone, to the nearest ancestor named by an attribute, as AbiWord's
 * `p` by its `xid`, where one is below the document's root.
 */
const outsideRuns = (pointer: string, ends: Ends): string => {
  const mixed = (element: string) =>
    [ends.baseline, ends.final].some((view) =>
      holdsText(resolvePointer(view, element)),
    );
  let current = pointer;
  for (
    let parent = parentBelowRoot(current);
    parent !== undefined && mixed(parent);
    parent = parentBelowRoot(current)
  )
    current = parent;
  let named = current;
  while (!namedByAttribute(named)) {
    const parent = parentBelowRoot(named);
    if (parent === undefined) return current;
    named = parent;
  }
  return named;
};

/**
 * Checks of an element's whole text where an edit changed it, for an app that
 * splits a paragraph into runs as it saves: the element holding each text node
 * the diff lists with more than whitespace in it, in either version of a
 * changed value, taken out of the runs it sits in, the outermost where one
 * holds another, an element at both ends at the pointer `name` gives it, whose
 * text changed and that the final view holds whole.
 */
export const wholeTextSuggestions = (
  file: string,
  change: Listed,
  ends: Ends,
  place: TextPlacement,
): WholeTextSuggestions => {
  const holders = new Set<string>();
  const note = (pointer: string, view: JsonValue | null) => {
    const parent = parentOf(pointer);
    const text = resolvePointer(view, pointer);
    if (
      parent !== undefined &&
      typeof text === "string" &&
      !isWhitespace(text) &&
      place.inTree(parent)
    )
      holders.add(outsideRuns(parent, ends));
  };
  // A value that changed may be text at one end only, as text an app wraps in a run.
  for (const pointer of change.changed) {
    note(pointer, ends.final);
    note(pointer, ends.baseline);
  }
  for (const pointer of change.added) note(pointer, ends.final);
  for (const pointer of change.removed) note(pointer, ends.baseline);
  const elements = [...holders];
  const suggested: string[] = [];
  const suggestions: DesktopTaskCheckInput[] = [];
  for (const element of elements) {
    if (suggestions.length >= place.limit.suggestions) break;
    if (elements.some((other) => element.startsWith(`${other}/`))) continue;
    const pointer = place.name(element);
    if (pointer === undefined) continue;
    const now = resolvePointer(ends.final, pointer);
    const before = resolvePointer(ends.baseline, pointer);
    if (!isXmlElement(now) || !isXmlElement(before)) continue;
    const value = elementText(now);
    if (
      value !== elementText(before) &&
      value.length <= place.limit.chars &&
      !isTimestamp(value)
    ) {
      suggested.push(element);
      suggestions.push({ kind: "text_equals", file, pointer, value });
    }
  }
  const kept = (element: string) =>
    [ends.baseline, ends.final].every((view) =>
      isXmlElement(resolvePointer(view, element)),
    );
  return {
    suggestions,
    covers: (pointer) => {
      if (
        !suggested.some((element) => pointer.startsWith(`${element}/children/`))
      )
        return false;
      const owner = ownerOf(pointer);
      return owner === undefined || !kept(owner);
    },
  };
};
