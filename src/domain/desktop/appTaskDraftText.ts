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

/** Text checks for the elements whose text changed, and the pointers those checks make redundant: text and whole runs holding text in them, or an element added whole checked itself, not an attribute or name of an element both ends hold, nor an element holding no text, as an image or a break. */
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

const isRecord = (
  value: JsonValue | undefined,
): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** An element's attributes; none for any other value. */
const attributesOf = (value: JsonValue | undefined) =>
  isXmlElement(value) && isRecord(value.attributes) ? value.attributes : {};

/** Whether an attribute identifies its element, as `id`, `xml:id` or AbiWord's `xid` do, rather than formatting it. */
const isIdentifier = (key: string) => /^(?:[^:]*:)?x?id$/iu.test(key);

/** Whether the diff names an element by an identifier, as `[name=p][@xid=6]`. */
const namedByIdentifier = (pointer: string) => {
  const key = /\]\[@(?<key>[^=]+)=/u.exec(pointer.split("/").at(-1) ?? "")
    ?.groups?.key;
  return key !== undefined && isIdentifier(key);
};

/**
 * Whether an end holds an element whose text a check reads as nothing, as an
 * image or a break. A run of only whitespace is text the paragraph check
 * already reads, so it stays covered.
 */
const textlessAt = (pointer: string, ends: Ends) =>
  [ends.baseline, ends.final].some((view) => {
    const value = resolvePointer(view, pointer);
    return isXmlElement(value) && elementText(value) === "";
  });

/** Whether both ends hold an element at a pointer. */
const keptAt = (element: string, ends: Ends) =>
  [ends.baseline, ends.final].every((view) =>
    isXmlElement(resolvePointer(view, element)),
  );

/** Whether an element holds text of its own, at either end. */
const mixedAt = (element: string, ends: Ends) =>
  [ends.baseline, ends.final].some((view) =>
    holdsText(resolvePointer(view, element)),
  );

/** Where a text check may go: an element as the diff names it, the pointer the check names it by, and whether an identifier is in that pointer. */
interface Candidate {
  readonly element: string;
  readonly pointer: string;
  readonly identifier: boolean;
}

/**
 * An element named by its tag and one of its own attributes, an identifier
 * first: one with the same value at both ends that names the element alone
 * among its siblings at each; none when no attribute does.
 */
const byOwnAttribute = (element: string, ends: Ends): Candidate | undefined => {
  const parent = parentOf(element);
  const before = resolvePointer(ends.baseline, element);
  const after = resolvePointer(ends.final, element);
  if (parent === undefined || !isXmlElement(before) || !isXmlElement(after))
    return undefined;
  const attributes = attributesOf(after);
  const keys = Object.keys(attributes);
  for (const key of [
    ...keys.filter(isIdentifier),
    ...keys.filter((key) => !isIdentifier(key)),
  ]) {
    const value = attributes[key];
    if (
      typeof value !== "string" ||
      attributesOf(before)[key] !== value ||
      /[=[\]]/u.test(key) ||
      value.includes("][") ||
      isTimestamp(value)
    )
      continue;
    const selector = `[name=${after.name}][@${key}=${value}]`;
    const pointer = `${parent}/children/${selector.replaceAll("~", "~0").replaceAll("/", "~1")}`;
    if (
      resolvePointer(ends.baseline, pointer) === before &&
      resolvePointer(ends.final, pointer) === after
    )
      return { element, pointer, identifier: isIdentifier(key) };
  }
  return undefined;
};

/**
 * Where a text check goes for an element whose text changed, best first, so
 * the check names the paragraph, which a later save keeps, rather than a run
 * it may split or merge: up from an element in mixed content (its parent
 * holds text beside it, at either end) to the nearest that is not, then, from
 * one named by tag or position alone, to the nearest ancestor named by an
 * attribute, as AbiWord's `p` by its `xid`, where one is below the document's
 * root. An element passed on the way that an identifier of its own names, the
 * outermost first, goes ahead of that ancestor unless an identifier names the
 * ancestor too; one that only another attribute names goes after it.
 */
const outsideRuns = (pointer: string, ends: Ends): readonly Candidate[] => {
  let current = pointer;
  // A paragraph may be the document's root.
  for (
    let parent = parentOf(current);
    parent !== undefined && mixedAt(parent, ends);
    parent = parentOf(current)
  )
    current = parent;
  const passed: string[] = [];
  let named = current;
  while (!namedByAttribute(named)) {
    const parent = parentBelowRoot(named);
    if (parent === undefined)
      return [{ element: current, pointer: current, identifier: false }];
    passed.push(named);
    named = parent;
  }
  const ranked = [
    { element: named, pointer: named, identifier: namedByIdentifier(named) },
    ...passed
      .toReversed()
      .flatMap((element) => byOwnAttribute(element, ends) ?? []),
  ];
  return [
    ...ranked.filter(({ identifier }) => identifier),
    ...ranked.filter(({ identifier }) => !identifier),
  ];
};

/**
 * The nearest ancestor both ends hold of an element added or removed whole,
 * where its text is checked; none when that is the document's root holding no
 * text of its own, whose whole text a check would read instead.
 */
const keptAncestor = (pointer: string, ends: Ends): string | undefined => {
  let parent = parentOf(pointer);
  while (parent !== undefined && !keptAt(parent, ends))
    parent = parentOf(parent);
  return parent === undefined ||
    (parentOf(parent) === undefined && !mixedAt(parent, ends))
    ? undefined
    : parent;
};

/** A text check, and the element it reads as the diff names it. */
interface Placed {
  readonly element: string;
  readonly check: DesktopTaskCheckInput;
}

/** What text checks read: the file, its two ends, and where checks go. */
interface TextContext {
  readonly file: string;
  readonly ends: Ends;
  readonly place: TextPlacement;
}

/**
 * The text check a candidate takes: an element the final view holds whole at
 * the pointer `name` gives it, its text at most the limit and no timestamp,
 * and changed from the baseline's or, for an element `added` whole, absent
 * there.
 */
const textCheck = (
  { file, ends, place }: TextContext,
  { element, pointer: named }: Candidate,
  added: boolean,
): Placed | undefined => {
  const pointer = place.name(named);
  if (pointer === undefined) return undefined;
  const now = resolvePointer(ends.final, pointer);
  const before = resolvePointer(ends.baseline, pointer);
  if (!isXmlElement(now) || (!added && !isXmlElement(before))) return undefined;
  const value = elementText(now);
  return value !== (isXmlElement(before) ? elementText(before) : undefined) &&
    value.length <= place.limit.chars &&
    !isTimestamp(value)
    ? { element, check: { kind: "text_equals", file, pointer, value } }
    : undefined;
};

/**
 * Checks of an element's whole text where an edit changed it, for an app that
 * splits a paragraph into runs as it saves: the element holding each text node
 * the diff lists with more than whitespace in it, in either version of a
 * changed value, and the nearest ancestor both ends hold of each element it
 * lists whole holding such text, taken out of the runs it sits in, the
 * outermost where one holds another, an element at both ends at the pointer
 * `name` gives it, whose text changed and that the final view holds whole. An
 * element added whole whose ancestors cannot take the check takes it itself.
 */
export const wholeTextSuggestions = (
  file: string,
  change: Listed,
  ends: Ends,
  place: TextPlacement,
): WholeTextSuggestions => {
  const holders = new Set<string>();
  /** Elements added whole holding text, each with the ancestor checked for it, if any. */
  const added = new Map<string, string | undefined>();
  const note = (pointer: string, view: JsonValue | null, whole = false) => {
    const value = resolvePointer(view, pointer);
    const parent = parentOf(pointer);
    if (typeof value === "string") {
      if (parent !== undefined && !isWhitespace(value) && place.inTree(parent))
        holders.add(parent);
    } else if (
      isXmlElement(value) &&
      !isWhitespace(elementText(value)) &&
      place.inTree(pointer)
    ) {
      const holder = keptAncestor(pointer, ends);
      if (holder !== undefined) holders.add(holder);
      if (whole) added.set(pointer, holder);
    }
  };
  // A value that changed may be text at one end only, as text an app wraps in a run.
  for (const pointer of change.changed) {
    note(pointer, ends.final);
    note(pointer, ends.baseline);
  }
  for (const pointer of change.added) note(pointer, ends.final, true);
  for (const pointer of change.removed) note(pointer, ends.baseline);
  const context = { file, ends, place };
  const checks = new Map<string, Placed | undefined>();
  const check = (candidate: Candidate) => {
    if (!checks.has(candidate.element))
      checks.set(candidate.element, textCheck(context, candidate, false));
    return checks.get(candidate.element);
  };
  const climbs = new Map<string, Placed | undefined>();
  const climb = (holder: string) => {
    if (!climbs.has(holder)) {
      const found = outsideRuns(holder, ends).find(
        (candidate) => check(candidate) !== undefined,
      );
      climbs.set(holder, found === undefined ? undefined : check(found));
    }
    return climbs.get(holder);
  };
  const placed: Placed[] = [];
  const keep = (found: Placed | undefined) => {
    if (found !== undefined && !placed.includes(found)) placed.push(found);
  };
  for (const holder of holders) keep(climb(holder));
  for (const [element, holder] of added)
    if (holder === undefined || climb(holder) === undefined)
      keep(
        textCheck(
          context,
          { element, pointer: element, identifier: false },
          true,
        ),
      );
  const suggested = placed
    .filter(
      ({ element }) =>
        !placed.some((other) => element.startsWith(`${other.element}/`)),
    )
    .slice(0, place.limit.suggestions);
  return {
    suggestions: suggested.map(({ check }) => check),
    covers: (pointer) => {
      if (
        !suggested.some(
          ({ element }) =>
            pointer === element || pointer.startsWith(`${element}/children/`),
        )
      )
        return false;
      if (textlessAt(pointer, ends)) return false;
      const owner = ownerOf(pointer);
      return owner === undefined || !keptAt(owner, ends);
    },
  };
};
