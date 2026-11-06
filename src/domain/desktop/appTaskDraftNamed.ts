import type { JsonValue } from "../jsonValue.js";
import { isTimestamp, type DesktopTaskCheckInput } from "./appTask.js";
import { isXmlElement } from "./appTaskChecks.js";
import {
  attributeChecks,
  fieldChecks,
  type AddedContext,
} from "./appTaskDraftAdded.js";
import { draftGuards } from "./appTaskDraftGuards.js";
import { changeNoise, type NoiseReason } from "./appTaskDraftNoise.js";
import { valueEqualsCheck } from "./appTaskDraftScalars.js";
import {
  wholeTextSuggestions,
  type WholeTextSuggestions,
} from "./appTaskDraftText.js";
import { draftValues, type DraftValue } from "./appTaskDraftValues.js";
import {
  diffNamedMembers,
  type DesktopStateDifference,
} from "./stateChanges.js";
import {
  escapeToken,
  locatePointer,
  pairMembers,
  resolvePointer,
} from "./viewPointer.js";
import {
  entryWithoutView,
  zipArrayLeavesOut,
  zipEntryAt,
  zipLeavesOutAt,
} from "./zipView.js";

type Suggestion = DesktopTaskCheckInput;

const isRecord = (
  value: JsonValue | null | undefined,
): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Pointers without a listed descendant: a container listed with its members is suggested through them. */
export const innermost = (pointers: readonly string[]): readonly string[] =>
  pointers.filter(
    (pointer) => !pointers.some((other) => other.startsWith(`${pointer}/`)),
  );

/**
 * The entry a pointer into a zip view goes into, when it has a view and both
 * evaluators read it alike: JSON, a key file or XML. A binary or unread
 * entry also holds a `null` view, which is no JSON `null`.
 */
const readableEntry = (view: JsonValue | null, pointer: string) => {
  const entry = zipEntryAt(view, pointer);
  return typeof entry === "object" &&
    entryWithoutView(entry) === undefined &&
    (entry.format === "json" ||
      entry.format === "keyfile" ||
      entry.format === "xml")
    ? entry
    : undefined;
};

/**
 * Where checks for a pointer the diff lists start: the view of an entry it
 * names whole, or its root element for XML; the pointer itself inside that;
 * undefined for an entry neither evaluator reads alike, or the entry's fields.
 */
const checkRoot = (
  view: JsonValue | null,
  pointer: string,
): string | undefined => {
  const entry = readableEntry(view, pointer);
  const [entryPointer] = /^\/entries\/[^/]+/u.exec(pointer) ?? [];
  if (entry === undefined || entryPointer === undefined) return undefined;
  const inner = pointer.slice(entryPointer.length).split("/").slice(1);
  const root = entry.format === "xml" ? ["view", "root"] : ["view"];
  const prefix = (short: readonly string[], long: readonly string[]) =>
    short.length <= long.length &&
    short.every((part, index) => long[index] === part);
  if (prefix(inner, root)) return `${entryPointer}/${root.join("/")}`;
  return prefix(root, inner) ? pointer : undefined;
};

/**
 * Where checks into a view can go: an archive's entries, or an XML file's root
 * element. `root` is where checks for a pointer the diff lists start, undefined
 * where the evaluators do not read alike; `xml` whether a pointer goes into an
 * XML view; `leavesOut` whether the view may lack part of what a pointer
 * reaches, and `arrayLeavesOut` members of the array a pointer names;
 * `listed` whether a pointer is a value of the document a values list shows.
 */
interface CheckTree {
  readonly root: (
    view: JsonValue | null,
    pointer: string,
  ) => string | undefined;
  readonly xml: (view: JsonValue | null, pointer: string) => boolean;
  readonly leavesOut: (view: JsonValue | null, pointer: string) => boolean;
  readonly arrayLeavesOut: (view: JsonValue | null, array: string) => boolean;
  readonly listed: (view: JsonValue | null, pointer: string) => boolean;
}

export const ARCHIVE: CheckTree = {
  root: checkRoot,
  xml: (view, pointer) => readableEntry(view, pointer)?.format === "xml",
  leavesOut: zipLeavesOutAt,
  arrayLeavesOut: zipArrayLeavesOut,
  // An entry added or removed whole, or a value inside a readable one; not an entry's size or digest.
  listed: (view, pointer) =>
    /^\/entries\/[^/]+$/u.test(pointer) ||
    checkRoot(view, pointer) !== undefined,
};

/** An XML file's view leaves out what its `truncated` says, anywhere in the tree. */
const truncatedXml = (view: JsonValue | null) =>
  isRecord(view) && view.truncated === true;

const inXmlRoot = (pointer: string) =>
  pointer === "/root" || pointer.startsWith("/root/");

export const XML_FILE: CheckTree = {
  root: (_view, pointer) => (inXmlRoot(pointer) ? pointer : undefined),
  xml: () => true,
  leavesOut: truncatedXml,
  arrayLeavesOut: truncatedXml,
  listed: (_view, pointer) => inXmlRoot(pointer),
};

/** Whether a check at a pointer is decided by name: no object or array reached by position, no array searched that the view may cut. */
const byName = (view: JsonValue | null, pointer: string, tree: CheckTree) => {
  const located = locatePointer(view, pointer);
  return (
    located.kind !== "unresolved" &&
    located.byPosition.length === 0 &&
    !located.searched.some((array) => tree.arrayLeavesOut(view, array))
  );
};

/** An element of REA's XML view, by its tag name, or undefined for any other value. */
const elementName = (value: JsonValue | undefined): string | undefined =>
  isXmlElement(value) ? value.name : undefined;

/** A text node of an XML view holding only whitespace, which an app writes as it lays out the file. */
const isLayoutText = (
  tree: CheckTree,
  view: JsonValue | null,
  pointer: string,
  value: JsonValue | undefined,
) =>
  typeof value === "string" &&
  /^[ \t\r\n]*$/u.test(value) &&
  /\/children\/[^/]+$/u.test(pointer) &&
  tree.xml(view, pointer);

/** The tags of elements a pointer reaches by position, which no attribute names alone among their siblings. */
const positionalTags = (view: JsonValue | null, pointer: string): string[] => {
  const segments = pointer.split("/");
  return segments.flatMap((segment, index) => {
    if (segments[index - 1] !== "children" || !/^\d+$/u.test(segment))
      return [];
    const element = resolvePointer(
      view,
      segments.slice(0, index + 1).join("/"),
    );
    return isXmlElement(element) ? [element.name] : [];
  });
};

/** Facts a file's notes rest on, gathered as the suggestions are filtered. */
export interface NamedFacts {
  /** Changes no check took because only position reaches them. */
  readonly positional: number;
  /** The tags of the elements position alone reaches on their way. */
  readonly positionalTags: readonly string[];
  /** Elements whose changed text no check took, because it was past the limit. */
  readonly long: readonly string[];
  /** The changes the diff lists, and how many of them are noise. */
  readonly changes: number;
  readonly noise: number;
  /** Suggested checks that are noise, kept because nothing else was. */
  readonly flagged: readonly string[];
}

/** A file's draft by named pointers: its suggested checks, values, guards and the facts its notes rest on. */
export interface NamedDraft {
  readonly suggested: Suggestion[];
  readonly values: DraftValue[];
  readonly valuesCut: boolean;
  readonly guards: Suggestion[];
  readonly facts: NamedFacts;
}

/** Noise checks kept when a file's change is nothing else, so an author still sees one. */
const MAX_FLAGGED = 3;

/** The draft's options: its limits, and whether noise is demoted, as it is in a document. */
export interface NamedOptions {
  readonly limit: { readonly suggestions: number; readonly chars: number };
  readonly document: boolean;
}

/** What one pass over the named diff reads: the file, its ends, where checks go, the limits and the text checks already placed. */
interface CollectContext {
  readonly file: string;
  readonly ends: AddedContext["ends"];
  readonly tree: CheckTree;
  readonly limit: NamedOptions["limit"];
  readonly texts: WholeTextSuggestions;
}

/** The checks a pass gathers, elements' apart from values', and the changes it left to position. */
interface Collected {
  readonly context: CollectContext;
  readonly elements: Suggestion[];
  readonly values: Suggestion[];
  readonly positional: { count: number; readonly tags: Set<string> };
}

const named = (
  { context }: Collected,
  view: JsonValue | null,
  pointer: string,
) => byName(view, pointer, context.tree);

/** Count a change no check names because position alone reaches it; one a cut view rejects is the view's to explain. */
const unnamed = (
  collected: Collected,
  view: JsonValue | null,
  pointer: string,
) => {
  if (
    collected.context.texts.covers(pointer) ||
    locatePointer(view, pointer).byPosition.length === 0
  )
    return;
  collected.positional.count += 1;
  for (const tag of positionalTags(view, pointer))
    collected.positional.tags.add(tag);
};

const room = ({ context }: Collected, list: readonly Suggestion[]) =>
  list.length < context.limit.suggestions;

const take = (
  { context }: Collected,
  list: Suggestion[],
  checks: readonly Suggestion[],
) => list.push(...checks.slice(0, context.limit.suggestions - list.length));

/** A check that a scalar, or an empty container, holds its final value. */
const equals = (
  collected: Collected,
  pointer: string,
  value: JsonValue | undefined,
) => {
  const { file, ends, tree, texts } = collected.context;
  if (
    !room(collected, collected.values) ||
    texts.covers(pointer) ||
    value === undefined ||
    (isRecord(value) && Object.keys(value).length > 0) ||
    isTimestamp(value) ||
    isLayoutText(tree, ends.final, pointer, value)
  )
    return;
  if (named(collected, ends.final, pointer))
    collected.values.push(
      valueEqualsCheck(
        file,
        pointer,
        value,
        resolvePointer(ends.baseline, pointer),
      ),
    );
  else unnamed(collected, ends.final, pointer);
};

/**
 * Checks of an element added whole: a record only position names by its new
 * fields, beside any whole text; a list member by its own attributes; any
 * other by its presence.
 */
const elementChecks = (
  collected: Collected,
  pointer: string,
  value: JsonValue,
): void => {
  if (!isXmlElement(value)) return;
  const { file, ends, texts } = collected.context;
  const added = {
    file,
    ends,
    named: (view: JsonValue | null, at: string) => named(collected, view, at),
  };
  if (!named(collected, ends.final, `${pointer}/name`)) {
    take(collected, collected.values, fieldChecks(added, pointer, value));
    if (!texts.covers(pointer)) unnamed(collected, ends.final, pointer);
    return;
  }
  if (texts.covers(pointer) || !room(collected, collected.elements)) return;
  const own = attributeChecks(added, pointer, value);
  take(
    collected,
    collected.elements,
    own.length > 0
      ? own
      : [
          {
            kind: "value_equals",
            file,
            pointer: `${pointer}/name`,
            value: value.name,
          },
        ],
  );
};

/** Checks of a value added whole: an element as `elementChecks` says, a container through its members, a scalar as it is. */
const addedChecks = (
  collected: Collected,
  pointer: string,
  value: JsonValue | undefined,
): void => {
  if (
    !room(collected, collected.elements) &&
    !room(collected, collected.values)
  )
    return;
  if (isXmlElement(value)) elementChecks(collected, pointer, value);
  else if (collected.context.texts.covers(pointer)) return;
  else if (Array.isArray(value) && value.length > 0) {
    const { keys } = pairMembers(value, []).newer;
    value.forEach((item, index) =>
      addedChecks(
        collected,
        `${pointer}/${escapeToken(keys[index] ?? String(index))}`,
        item,
      ),
    );
  } else if (isRecord(value) && Object.keys(value).length > 0)
    for (const [key, item] of Object.entries(value))
      addedChecks(collected, `${pointer}/${escapeToken(key)}`, item);
  // A scalar, or an empty array or object, is checked as it is.
  else equals(collected, pointer, value);
};

/** A check that a value is gone, only where the entry still has a view to lack it in. */
const removedCheck = (collected: Collected, pointer: string) => {
  const { file, ends, tree, texts } = collected.context;
  const before = resolvePointer(ends.baseline, pointer);
  if (
    texts.covers(pointer) ||
    isLayoutText(tree, ends.baseline, pointer, before) ||
    tree.root(ends.baseline, pointer) !== pointer ||
    tree.root(ends.final, pointer) !== pointer
  )
    return;
  if (
    named(collected, ends.baseline, pointer) &&
    named(collected, ends.final, pointer)
  )
    (elementName(before) === undefined
      ? collected.values
      : collected.elements
    ).push({ kind: "value_absent", file, pointer });
  else unnamed(collected, ends.baseline, pointer);
};

/** The checks one pass over the named diff suggests, with what it left out by position. */
const collectChecks = (
  context: CollectContext,
  change: DesktopStateDifference,
): Collected => {
  const collected: Collected = {
    context,
    elements: [],
    values: [],
    positional: { count: 0, tags: new Set() },
  };
  const { ends, tree } = context;
  for (const pointer of change.added) {
    const root = tree.root(ends.final, pointer);
    if (root !== undefined)
      addedChecks(collected, root, resolvePointer(ends.final, root));
  }
  for (const pointer of innermost(change.changed))
    if (tree.root(ends.final, pointer) === pointer)
      equals(collected, pointer, resolvePointer(ends.final, pointer));
  for (const pointer of change.removed) removedCheck(collected, pointer);
  return collected;
};

/**
 * Checks by the selectors a keyed diff names members with, in an archive's
 * entries or an XML file: the whole text of each element whose text changed
 * first, then elements added or removed whole, then values changed, added and
 * removed. An element added to a list is checked by its own attributes, a
 * record only position names by its new fields, a decimal by its number. A
 * JSON value or an entry added whole is checked through its members. Nothing
 * goes through an object or array by position. In a document, noise (view
 * state, renumbered ids, volatile values) leaves the suggestions when anything
 * else is there, and up to three stay, flagged, when it is all there is.
 * Beside them: the values the change added, changed and removed, and guards
 * that like siblings stay as they were.
 */
export const namedDraft = (
  file: string,
  ends: AddedContext["ends"],
  tree: CheckTree,
  options: NamedOptions,
): NamedDraft => {
  const change = diffNamedMembers(ends.baseline, ends.final);
  const noise: (pointer: string) => NoiseReason | undefined = options.document
    ? changeNoise(change, ends)
    : () => undefined;
  const texts = wholeTextSuggestions(file, change, ends, {
    limit: options.limit,
    inTree: (pointer) =>
      tree.xml(ends.final, pointer) &&
      tree.root(ends.final, pointer) === pointer,
    name: (pointer) =>
      byName(ends.final, pointer, tree) && !tree.leavesOut(ends.final, pointer)
        ? pointer
        : undefined,
  });
  const checks = collectChecks(
    { file, ends, tree, limit: options.limit, texts },
    change,
  );
  const all = [...texts.suggestions, ...checks.elements, ...checks.values];
  const noisy = (check: Suggestion) =>
    "pointer" in check && noise(check.pointer) !== undefined;
  const clean = all.filter((check) => !noisy(check));
  const suggested = (
    clean.length > 0 ? clean : all.slice(0, MAX_FLAGGED)
  ).slice(0, options.limit.suggestions);
  const listed = [...change.added, ...change.changed, ...change.removed];
  const { values, cut } = draftValues(change, {
    ends,
    listed: tree.listed,
    noise,
  });
  return {
    suggested,
    values,
    valuesCut: cut,
    guards:
      clean.length === 0
        ? []
        : draftGuards(
            {
              file,
              ends,
              named: (view, pointer) =>
                byName(view, pointer, tree) && !tree.leavesOut(view, pointer),
              noisy: (pointer) => noise(pointer) !== undefined,
              chars: options.limit.chars,
            },
            suggested,
          ),
    facts: {
      positional: checks.positional.count,
      positionalTags: [...checks.positional.tags],
      long: texts.long,
      changes: listed.length,
      noise: listed.filter((pointer) => noise(pointer) !== undefined).length,
      flagged:
        clean.length > 0
          ? []
          : suggested.flatMap((check) =>
              "pointer" in check ? [check.pointer] : [],
            ),
    },
  };
};
