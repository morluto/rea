import type { JsonValue } from "../jsonValue.js";
import { isTimestamp, type DesktopTaskCheckInput } from "./appTask.js";
import { isXmlElement } from "./appTaskChecks.js";
import { wholeTextSuggestions } from "./appTaskDraftText.js";
import { diffNamedMembers } from "./stateChanges.js";
import { locatePointer, pairMembers, resolvePointer } from "./viewPointer.js";
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

/** A pointer segment for a key: `~` and `/` escaped as RFC 6901 writes them. */
export const escapeToken = (token: string) =>
  token.replaceAll("~", "~0").replaceAll("/", "~1");

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
 * reaches, and `arrayLeavesOut` members of the array a pointer names.
 */
interface CheckTree {
  readonly root: (
    view: JsonValue | null,
    pointer: string,
  ) => string | undefined;
  readonly xml: (view: JsonValue | null, pointer: string) => boolean;
  readonly leavesOut: (view: JsonValue | null, pointer: string) => boolean;
  readonly arrayLeavesOut: (view: JsonValue | null, array: string) => boolean;
}

export const ARCHIVE: CheckTree = {
  root: checkRoot,
  xml: (view, pointer) => readableEntry(view, pointer)?.format === "xml",
  leavesOut: zipLeavesOutAt,
  arrayLeavesOut: zipArrayLeavesOut,
};

/** An XML file's view leaves out what its `truncated` says, anywhere in the tree. */
const truncatedXml = (view: JsonValue | null) =>
  isRecord(view) && view.truncated === true;

export const XML_FILE: CheckTree = {
  root: (_view, pointer) =>
    pointer === "/root" || pointer.startsWith("/root/") ? pointer : undefined,
  xml: () => true,
  leavesOut: truncatedXml,
  arrayLeavesOut: truncatedXml,
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

/**
 * Checks by the selectors a keyed diff names members with, in an archive's
 * entries or an XML file: the whole text of each element whose text changed
 * first, then elements added or removed whole, then values changed, added and
 * removed. A JSON value or an entry added whole is checked through its
 * members. Nothing goes through an object or array by position.
 */
export const namedSuggestions = (
  file: string,
  ends: {
    readonly baseline: JsonValue | null;
    readonly final: JsonValue | null;
  },
  tree: CheckTree,
  limit: { readonly suggestions: number; readonly chars: number },
): Suggestion[] => {
  const change = diffNamedMembers(ends.baseline, ends.final);
  const texts = wholeTextSuggestions(file, change, ends, {
    limit,
    inTree: (pointer) =>
      tree.xml(ends.final, pointer) &&
      tree.root(ends.final, pointer) === pointer,
    name: (pointer) =>
      byName(ends.final, pointer, tree) && !tree.leavesOut(ends.final, pointer)
        ? pointer
        : undefined,
  });
  const elements: Suggestion[] = [];
  const values: Suggestion[] = [];
  const equals = (pointer: string, value: JsonValue | undefined) => {
    if (
      values.length < limit.suggestions &&
      !texts.covers(pointer) &&
      value !== undefined &&
      !(isRecord(value) && Object.keys(value).length > 0) &&
      !isTimestamp(value) &&
      !isLayoutText(tree, ends.final, pointer, value) &&
      byName(ends.final, pointer, tree)
    )
      values.push({ kind: "value_equals", file, pointer, value });
  };
  const added = (pointer: string, value: JsonValue | undefined): void => {
    if (
      (elements.length >= limit.suggestions &&
        values.length >= limit.suggestions) ||
      texts.covers(pointer)
    )
      return;
    const name = elementName(value);
    if (name !== undefined) {
      if (
        elements.length < limit.suggestions &&
        byName(ends.final, `${pointer}/name`, tree)
      )
        elements.push({
          kind: "value_equals",
          file,
          pointer: `${pointer}/name`,
          value: name,
        });
    } else if (Array.isArray(value) && value.length > 0) {
      const { keys } = pairMembers(value, []).newer;
      value.forEach((item, index) =>
        added(`${pointer}/${escapeToken(keys[index] ?? String(index))}`, item),
      );
    } else if (isRecord(value) && Object.keys(value).length > 0)
      for (const [key, item] of Object.entries(value))
        added(`${pointer}/${escapeToken(key)}`, item);
    // A scalar, or an empty array or object, is checked as it is.
    else equals(pointer, value);
  };
  for (const pointer of change.added) {
    const root = tree.root(ends.final, pointer);
    if (root !== undefined) added(root, resolvePointer(ends.final, root));
  }
  for (const pointer of innermost(change.changed))
    if (tree.root(ends.final, pointer) === pointer)
      equals(pointer, resolvePointer(ends.final, pointer));
  // An absence is checked only where the entry still has a view to lack it in.
  for (const pointer of change.removed)
    if (
      !texts.covers(pointer) &&
      !isLayoutText(
        tree,
        ends.baseline,
        pointer,
        resolvePointer(ends.baseline, pointer),
      ) &&
      tree.root(ends.baseline, pointer) === pointer &&
      tree.root(ends.final, pointer) === pointer &&
      byName(ends.baseline, pointer, tree) &&
      byName(ends.final, pointer, tree)
    )
      (elementName(resolvePointer(ends.baseline, pointer)) === undefined
        ? values
        : elements
      ).push({ kind: "value_absent", file, pointer });
  return [...texts.suggestions, ...elements, ...values];
};
