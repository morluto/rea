import type { JsonValue } from "../jsonValue.js";
import type { DesktopTaskCheckInput } from "./appTask.js";
import {
  holdsSplitDate,
  isStamp,
  isVolatileValue,
} from "./appTaskDraftNoise.js";
import { valueEqualsCheck } from "./appTaskDraftScalars.js";
import { addedTextChecks } from "./appTaskDraftTextAdded.js";
import { rankAttributes } from "./attributeRank.js";
import type { DesktopStateDifference } from "./stateChanges.js";
import { elementText, isXmlElement, resolvePointer } from "./viewPointer.js";

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
  /** Whether a change at a pointer is noise, which never makes an ancestor's whole text a check. */
  readonly noise: (pointer: string) => boolean;
}

/** Text checks for the elements whose text changed, and the pointers those checks make redundant: text and whole runs holding text in them, or an element added whole checked itself, not an attribute or name of an element both ends hold, nor an element holding no text, as an image or a break. */
export interface WholeTextSuggestions {
  readonly suggestions: readonly DesktopTaskCheckInput[];
  /** Checks that text an addition kept is still there, for an author to add by choice. */
  readonly guards: readonly DesktopTaskCheckInput[];
  /** Elements whose text changed that no check took, because every place for one held more text than the limit. */
  readonly long: readonly string[];
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
    ...rankAttributes(
      keys
        .filter((key) => !isIdentifier(key))
        .map((key) => {
          const value = attributes[key];
          return { key, value: typeof value === "string" ? value : "" };
        }),
    ).map(({ key }) => key),
  ]) {
    const value = attributes[key];
    if (
      typeof value !== "string" ||
      attributesOf(before)[key] !== value ||
      /[=[\]]/u.test(key) ||
      value.includes("][") ||
      isStamp(value)
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

/** How far a text check climbs from an element no attribute names to an ancestor its tag names. */
const MAX_TAG_CLIMB = 3;
/** A formatting run a later save may split, merge, or drop while keeping the paragraph. */
const RUN_TAG = /^(?:a|b|c|em|i|span|strong|tspan|u)$/u;

/** The tag a diff pointer's last step names, without a namespace prefix. */
const tagOf = (pointer: string) =>
  (
    /\[name=(?<name>[^\][]+)/u.exec(pointer.split("/").at(-1) ?? "")?.groups
      ?.name ?? ""
  )
    .split(":")
    .at(-1) ?? "";

/**
 * Clean places for a text check, innermost first. A formatting run is left
 * out when a paragraph or other element remains, so the check does not depend
 * on a run a later save can drop.
 */
const withoutRuns = (
  chain: readonly string[],
  noisy: (element: string) => boolean,
): string[] => {
  const clean = chain.filter((element) => !noisy(element));
  const content = clean.filter((element) => !RUN_TAG.test(tagOf(element)));
  return content.length > 0 ? content : clean;
};

/** Whether an element's text, or a descendant's, is a time or a value the app makes anew. */
const holdsNoisyText = (value: JsonValue | undefined): boolean => {
  if (typeof value === "string") {
    const text = value.trim();
    return text.length > 0 && (isStamp(text) || isVolatileValue(text));
  }
  return isXmlElement(value) && value.children.some(holdsNoisyText);
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
 * ancestor too; one that only another attribute names goes after it. Where no
 * attribute names an ancestor, as MuseScore's `<Text>` in a `<VBox>`, the
 * element itself and then up to three ancestors, nearest first; `name` keeps
 * only one its tag names, with no step by position.
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
    if (parent === undefined) {
      const stopped = parentOf(named);
      const chain = [...passed, named].filter(
        (element, index, all) => all.indexOf(element) === index,
      );
      // A record directly under the document can still hold a save time. Leave a formatting run out when the paragraph remains.
      if (
        stopped !== undefined &&
        holdsNoisyText(resolvePointer(ends.final, stopped))
      ) {
        const narrower = withoutRuns(chain, (element) =>
          holdsNoisyText(resolvePointer(ends.final, element)),
        );
        if (narrower.length > 0)
          return narrower.map((element) => ({
            element,
            pointer: element,
            identifier: false,
          }));
      }
      return [current, ...[...passed.slice(1), named].slice(0, MAX_TAG_CLIMB)]
        .filter((element, index, all) => all.indexOf(element) === index)
        .map((element) => ({ element, pointer: element, identifier: false }));
    }
    passed.push(named);
    named = parent;
  }
  const noisy = (element: string) =>
    holdsNoisyText(resolvePointer(ends.final, element));
  // An ancestor whose text joins a timestamp fails a later save that only restamps it.
  if (noisy(named)) {
    const narrower = withoutRuns(
      [...passed].filter(
        (element, index, all) =>
          all.indexOf(element) === index && element !== named,
      ),
      noisy,
    );
    if (narrower.length > 0)
      return narrower.map((element) => ({
        element,
        pointer: element,
        identifier: false,
      }));
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
 * Where a text check goes for an element only position reaches, as a
 * spreadsheet cell in a row no attribute names: the ancestor above the
 * outermost step by position, as the table holding the rows, by an attribute
 * of its own that names it alone, as `[@table:name=Q1 Sales]`, and otherwise
 * as the diff names it; none when there is no such step or that ancestor is
 * the document's root.
 */
const abovePosition = (pointer: string, ends: Ends): readonly Candidate[] => {
  const segments = pointer.split("/");
  const step = segments.findIndex(
    (segment, index) =>
      segments[index - 1] === "children" && /^\d+$/u.test(segment),
  );
  if (step < 0) return [];
  const element = segments.slice(0, step - 1).join("/");
  if (parentOf(element) === undefined) return [];
  const own = byOwnAttribute(element, ends);
  return [
    ...(own === undefined ? [] : [own]),
    { element, pointer: element, identifier: false },
  ];
};

/** Whether an element holds only elements, as a record holds its fields, layout whitespace aside. */
const recordLike = (value: JsonValue | undefined): boolean =>
  isXmlElement(value) &&
  value.children.some((child) => isXmlElement(child)) &&
  value.children.every(
    (child) =>
      isXmlElement(child) || (typeof child === "string" && isWhitespace(child)),
  );

/**
 * A tag naming a paragraph or other piece of text, whose element children are
 * runs of it: AbiWord's, HTML's and Word's `p` (`w:p`), ODF's `text:p` and
 * `text:h`, HTML's `h1` to `h6` and `li`, DocBook's `para`, and SVG's `text`
 * and `tspan`, or a span or link holding further runs. Compared as written,
 * so MuseScore's `Text`, a record of `<style>` and `<text>`, is none.
 */
const TEXT_TAG = /^(?:p|h|h[1-6]|para|simpara|li|text|tspan|span|a)$/u;

/**
 * Whether an element holds fields: only elements, layout whitespace aside, as
 * Tellico's `<entry>` holds `<title>` and `<publisher>`, or a record holds
 * repeated `<field>` elements, whatever they are called; unless it is text
 * made of runs: its tag names a paragraph or other text (`TEXT_TAG`), or a
 * child's text opens or closes with whitespace, as a sentence splits into
 * runs, `Meet ` and a linked `Monday`, where a field holds a value whole.
 */
export const holdsFields = (value: JsonValue | undefined): boolean =>
  recordLike(value) &&
  isXmlElement(value) &&
  !TEXT_TAG.test(value.name.split(":").at(-1) ?? value.name) &&
  !value.children.some((child) => {
    const text = isXmlElement(child) ? elementText(child) : "";
    return text.trim() !== "" && text.trim() !== text;
  });

/**
 * Whether the kept ancestor of a record added or removed whole is a list of
 * its kind, whose whole text would fold in records the edit left alone: it
 * holds no text of its own, and another element of that tag with text that
 * both ends hold alike, as Tellico's `<collection>` holds the other entries.
 */
const listOf = (holder: string, element: JsonValue, ends: Ends) => {
  if (!isXmlElement(element) || !holdsFields(element) || mixedAt(holder, ends))
    return false;
  const like = (view: JsonValue | null) => {
    const list = resolvePointer(view, holder);
    return isXmlElement(list)
      ? list.children.flatMap((child) =>
          isXmlElement(child) &&
          child !== element &&
          child.name === element.name
            ? [elementText(child)]
            : [],
        )
      : [];
  };
  const before = new Set(like(ends.baseline));
  return like(ends.final).some(
    (text) => !isWhitespace(text) && before.has(text),
  );
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

/**
 * Where the text of an element added or removed whole is checked: its
 * `keptAncestor`, but never a list of its kind, whose whole text would fold
 * in the records the edit left alone, unless the element is a record
 * `removed` whole that only position names, whose absence no other check can
 * show; and whether a list is why it has none.
 */
const textHolder = (
  pointer: string,
  element: JsonValue,
  ends: Ends,
  removed: boolean,
) => {
  const kept = keptAncestor(pointer, ends);
  const unnamed = removed && /^\d+$/u.test(pointer.split("/").at(-1) ?? "");
  const listed = kept !== undefined && !unnamed && listOf(kept, element, ends);
  return { holder: listed ? undefined : kept, listed };
};

/** A text check, the element it reads as the diff names it, and guards of the text it kept. */
interface Placed {
  readonly element: string;
  readonly check: DesktopTaskCheckInput;
  readonly guards: readonly DesktopTaskCheckInput[];
}

/** What text checks read: the file, its two ends, and where checks go. */
interface TextContext {
  readonly file: string;
  readonly ends: Ends;
  readonly place: TextPlacement;
}

/**
 * The check of an element's whole text: a decimal held as the element's one
 * text node, as a spreadsheet keeps a cell's number, by its value within a
 * tolerance, so another spelling of the number still passes; text that grew
 * by whole lines by those lines, with guards of what it kept; any other text
 * whole.
 */
export const wholeTextCheck = (
  file: string,
  pointer: string,
  now: { readonly value: string; readonly children: readonly JsonValue[] },
  before: string | undefined,
): Pick<Placed, "check" | "guards"> => {
  const { value, children } = now;
  const [only] = children;
  if (children.length === 1 && typeof only === "string") {
    const check = valueEqualsCheck(file, `${pointer}/children/0`, only, before);
    if ("tolerance" in check) return { check, guards: [] };
  }
  return (
    (before === undefined
      ? undefined
      : addedTextChecks(file, pointer, before, value)) ?? {
      check: { kind: "text_equals", file, pointer, value },
      guards: [],
    }
  );
};

/** The element a candidate names in the final view, whole, at the pointer `name` gives it. */
const candidateAt = (
  { ends, place }: TextContext,
  { pointer: named }: Candidate,
) => {
  const pointer = place.name(named);
  const now =
    pointer === undefined ? undefined : resolvePointer(ends.final, pointer);
  return pointer === undefined || !isXmlElement(now)
    ? undefined
    : { pointer, now };
};

/**
 * The text check a candidate takes: an element the final view holds whole at
 * the pointer `name` gives it, its text at most the limit, no timestamp and
 * holding no date stamped in parts, and changed from the baseline's or, for
 * an element `added` whole, absent there.
 */
const textCheck = (
  context: TextContext,
  candidate: Candidate,
  added: boolean,
): Placed | undefined => {
  const found = candidateAt(context, candidate);
  if (found === undefined) return undefined;
  const { pointer, now } = found;
  const before = resolvePointer(context.ends.baseline, pointer);
  if (!added && !isXmlElement(before)) return undefined;
  const value = elementText(now);
  const old = isXmlElement(before) ? elementText(before) : undefined;
  return value !== old &&
    value.length <= context.place.limit.chars &&
    !isStamp(value) &&
    !holdsSplitDate(context.ends.final, pointer)
    ? {
        element: candidate.element,
        ...wholeTextCheck(
          context.file,
          pointer,
          { value, children: now.children },
          old,
        ),
      }
    : undefined;
};

/** Whether a candidate's element holds text past the limit a text check compares. */
const tooLong = (context: TextContext, candidate: Candidate) => {
  const found = candidateAt(context, candidate);
  return (
    found !== undefined &&
    elementText(found.now).length > context.place.limit.chars
  );
};

/**
 * The elements whose text a change may make a check: each holding a text
 * node the diff lists with more than whitespace in it, in either version of
 * a changed value, and the `textHolder` of each element it lists whole
 * holding such text; and the elements added whole, each with its holder.
 */
const textHolders = (change: Listed, ends: Ends, place: TextPlacement) => {
  const holders = new Set<string>();
  /** Elements added whole holding text, each with the ancestor checked for it, if any. */
  const added = new Map<string, string | undefined>();
  const note = (
    pointer: string,
    view: JsonValue | null,
    how: "changed" | "added" | "removed",
  ) => {
    const value = resolvePointer(view, pointer);
    const parent = parentOf(pointer);
    // Noise, such as a time the app stamps, never makes its ancestor's whole text a check.
    if (place.noise(pointer)) return;
    if (typeof value === "string") {
      if (
        parent !== undefined &&
        !isWhitespace(value) &&
        !isStamp(value) &&
        place.inTree(parent)
      )
        holders.add(parent);
    } else if (
      isXmlElement(value) &&
      !isWhitespace(elementText(value)) &&
      place.inTree(pointer)
    ) {
      const { holder, listed } = textHolder(
        pointer,
        value,
        ends,
        how === "removed",
      );
      if (holder !== undefined) holders.add(holder);
      // A record in a list is checked by its fields, not its whole text.
      if (how === "added" && !listed) added.set(pointer, holder);
    }
  };
  // A value that changed may be text at one end only, as text an app wraps in a run.
  for (const pointer of change.changed) {
    note(pointer, ends.final, "changed");
    note(pointer, ends.baseline, "changed");
  }
  for (const pointer of change.added) note(pointer, ends.final, "added");
  for (const pointer of change.removed) note(pointer, ends.baseline, "removed");
  return { holders, added };
};

/**
 * Checks of an element's whole text where an edit changed it, for an app that
 * splits a paragraph into runs as it saves: the element holding each text node
 * the diff lists with more than whitespace in it, in either version of a
 * changed value, and the nearest ancestor both ends hold of each element it
 * lists whole holding such text, taken out of the runs it sits in, the
 * outermost where one holds another, an element at both ends at the pointer
 * `name` gives it, whose text changed and that the final view holds whole;
 * never, for a record, a list of its kind, whose text holds records the edit
 * left alone. An element added whole whose ancestors cannot take the check
 * takes it itself, but a record in a list, which its fields check instead.
 */
export const wholeTextSuggestions = (
  file: string,
  change: Listed,
  ends: Ends,
  place: TextPlacement,
): WholeTextSuggestions => {
  const { holders, added } = textHolders(change, ends, place);
  const context = { file, ends, place };
  const checks = new Map<string, Placed | undefined>();
  const check = (candidate: Candidate) => {
    if (!checks.has(candidate.element))
      checks.set(candidate.element, textCheck(context, candidate, false));
    return checks.get(candidate.element);
  };
  const climbs = new Map<string, Placed | undefined>();
  /** Elements whose text changed and that no check took because every place for it held too much text. */
  const long = new Set<string>();
  const climb = (holder: string) => {
    if (!climbs.has(holder)) {
      const candidates = [
        ...outsideRuns(holder, ends),
        ...abovePosition(holder, ends),
      ];
      const found = candidates.find(
        (candidate) => check(candidate) !== undefined,
      );
      if (
        found === undefined &&
        candidates.some((candidate) => tooLong(context, candidate))
      )
        long.add(holder);
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
    guards: suggested.flatMap(({ guards }) => guards),
    long: [...long],
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
