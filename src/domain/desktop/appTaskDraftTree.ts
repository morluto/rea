import type { JsonValue } from "../jsonValue.js";
import type { AddedContext } from "./appTaskDraftAdded.js";
import { changeNoise } from "./appTaskDraftNoise.js";
import { draftValues, oneEnd, type DraftValue } from "./appTaskDraftValues.js";
import { diffNamedMembers } from "./stateChanges.js";
import {
  entryWithoutView,
  zipArrayLeavesOut,
  zipEntryAt,
  zipLeavesOutAt,
  zipView,
} from "./zipView.js";

const isRecord = (
  value: JsonValue | null | undefined,
): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
 * `listed` whether a pointer is a value of the document a values list shows;
 * `empty` the view of a file that holds nothing.
 */
export interface CheckTree {
  readonly root: (
    view: JsonValue | null,
    pointer: string,
  ) => string | undefined;
  readonly xml: (view: JsonValue | null, pointer: string) => boolean;
  readonly leavesOut: (view: JsonValue | null, pointer: string) => boolean;
  readonly arrayLeavesOut: (view: JsonValue | null, array: string) => boolean;
  readonly listed: (view: JsonValue | null, pointer: string) => boolean;
  readonly empty: JsonValue | null;
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
  // An archive with no entries, so each entry of one created or deleted is listed by its name.
  empty: zipView([], 0),
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
  empty: null,
};

/**
 * The values of an archive or XML file created or deleted: what its one end
 * holds against `tree.empty`, each entry, or the root element, whole once, as
 * one added to a file that changed is listed, within the same limits.
 */
export const presenceValues = (
  ends: AddedContext["ends"],
  tree: CheckTree,
  created: boolean,
): { readonly values: DraftValue[]; readonly cut: boolean } => {
  const from = created
    ? { baseline: tree.empty, final: ends.final }
    : { baseline: ends.baseline, final: tree.empty };
  const change = oneEnd(diffNamedMembers(from.baseline, from.final), created);
  return draftValues(change, {
    ends: from,
    listed: tree.listed,
    noise: changeNoise(change, from),
  });
};
