import { z } from "zod";

import { jsonValueSchema, type JsonValue } from "../jsonValue.js";
import {
  attributeKeyOf,
  NOISE_REASONS,
  type NoiseReason,
} from "./appTaskDraftNoise.js";
import { isIdentifyingAttribute, isViewStateName } from "./attributeRank.js";
import type { DesktopStateDifference } from "./stateChanges.js";
import { alternativePointers } from "./appTaskDraftAlternatives.js";
import { isIdReference } from "./appTaskDraftMirrors.js";
import { recordListsOf } from "./appTaskDraftNested.js";
import { holdsFields, isRecordAt } from "./appTaskDraftText.js";
import { attributesOf, compactValue, previewWriter } from "./compactValue.js";
import { pairMembers, pairedAtSeed } from "./memberPairing.js";
import {
  escapeToken,
  isXmlElement,
  locatePointer,
  resolvePointer,
} from "./viewPointer.js";

/** Why a value's pointer cannot go into a check as it is, or why the value is noise. */
export const VALUE_NOTES = ["by_position", ...NOISE_REASONS] as const;
export type ValueNote = (typeof VALUE_NOTES)[number];

/** Another element a value names by its `key` or `id`: the attribute holding the value, when one does, and that element's start tag. */
export interface ValueReference {
  readonly attribute?: string;
  readonly value: string;
  readonly element: string;
}

/** One value a file's net change added, changed or removed, with what it was and became. */
export interface DraftValue {
  readonly pointer: string;
  readonly kind: "added" | "changed" | "removed";
  /** The scalar, or the element as compact XML, cut short; null for a value added. */
  readonly before: JsonValue;
  /** The same at the end; null for a value removed. */
  readonly after: JsonValue;
  readonly note?: ValueNote;
  readonly refers_to?: readonly ValueReference[];
  readonly alternatives?: readonly string[];
}

/** One entry of a drafted file's `values`, as the draft writes it. */
export const draftValueSchema = z.strictObject({
  pointer: z
    .string()
    .describe(
      "Where the value is, as a check names it: by selector, by position only where the note says by_position.",
    ),
  kind: z
    .enum(["added", "changed", "removed"])
    .describe(
      "before is the value at the seed and after at the end: a scalar, or an element as compact XML, cut at 600 characters; null at the end that lacks it.",
    ),
  // jsonValueSchema keeps its JSON Schema only undescribed.
  before: jsonValueSchema,
  after: jsonValueSchema,
  note: z
    .enum(VALUE_NOTES)
    .optional()
    .describe(
      "by_position: no selector names it, so no check can use the pointer; view_state, renumbered, volatile, timestamp, upkeep or layout: noise the app writes, left out of the suggested checks.",
    ),
  refers_to: z
    .array(
      z.strictObject({
        attribute: z.string().optional(),
        value: z.string(),
        element: z.string(),
      }),
    )
    .optional()
    .describe(
      'Other elements a value names by their key or id, such as category 44 naming <cat key="44" name="Groceries"/>.',
    ),
  alternatives: z
    .array(z.string())
    .optional()
    .describe(
      "A changed value's pointer naming its element by another identifier or name it holds alone, such as a shape's draw:name, for a check to use instead; at most three.",
    ),
});

/** Bounds on the values a draft lists, so a large change cannot crowd out the rest of it. */
export const VALUE_LIMITS = {
  entries: 20,
  fileBytes: 8 * 1024,
  draftBytes: 24 * 1024,
  chars: 600,
  references: 5,
} as const;

const isRecord = (
  value: JsonValue | undefined,
): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The longest value a reference is resolved from. */
const MAX_REFERENCE_CHARS = 64;

/** Whether a value is one a reference is resolved from: not blank, and no longer than `MAX_REFERENCE_CHARS`. */
const referable = (value: string) =>
  value.trim() !== "" && value.length <= MAX_REFERENCE_CHARS;

/**
 * Elements of a tag a value's list keeps: enough to tell one other element
 * from several when the element reading the value is among them.
 */
const PER_TAG = 3;

/** Add an element to a value's list under its tag, while that holds fewer than `PER_TAG`. */
const indexUnder = (
  index: Map<string, Map<string, JsonValue[]>>,
  value: string,
  node: JsonValue & { readonly name: string },
) => {
  const byTag = index.get(value) ?? new Map<string, JsonValue[]>();
  index.set(value, byTag);
  const tagged = byTag.get(node.name) ?? [];
  byTag.set(node.name, tagged);
  if (tagged.length < PER_TAG && !tagged.includes(node)) tagged.push(node);
};

/**
 * XML elements by the value of their `key` or `id` attribute, `xmi:id`
 * among them, across a view, and by tag: at most `PER_TAG` of a tag in
 * document order, so a key that records or archive entries repeat costs no
 * more than that. A view the app keeps of the document, as Umbrello's
 * `listview` mirroring its model by id, names nothing.
 */
const referenceIndex = (roots: readonly JsonValue[]) => {
  const index = new Map<string, Map<string, JsonValue[]>>();
  const pending: JsonValue[] = [...roots];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isXmlElement(node) && isViewStateName(node.name)) continue;
    if (isXmlElement(node)) {
      for (const [key, value] of Object.entries(attributesOf(node)))
        if (
          typeof value === "string" &&
          referable(value) &&
          /^(?:key|id)$/iu.test(localOf(key))
        )
          indexUnder(index, value, node);
      // An id an app keeps as a child's text, as GnuCash's `<act:id type="guid">`, names the element it sits in.
      for (const child of node.children) {
        const id = leafText(child);
        if (
          isXmlElement(child) &&
          /^id$/iu.test(localOf(child.name)) &&
          id !== undefined &&
          referable(id)
        )
          indexUnder(index, id, node);
      }
    }
    const children = isXmlElement(node)
      ? node.children
      : Array.isArray(node)
        ? node
        : isRecord(node)
          ? Object.values(node)
          : [];
    for (const child of children) pending.push(child);
  }
  return index;
};

/** A name without its namespace prefix. */
const localOf = (name: string) => name.split(":").at(-1) ?? name;

/** An element's text when it holds only one text node, as `<act:name>Groceries</act:name>`. */
const leafText = (node: JsonValue): string | undefined => {
  const [only] = isXmlElement(node) ? node.children : [];
  return isXmlElement(node) &&
    node.children.length === 1 &&
    typeof only === "string"
    ? only
    : undefined;
};

/** An element as a reference shows it: its start tag, and its name where a child holds one, as `<gnc:account version="2.0.0"><act:name>Groceries</act:name>…`. */
const referenceTag = (
  element: Record<string, JsonValue> & { name: string },
) => {
  const writer = previewWriter(VALUE_LIMITS.chars);
  if (!writer.startTag(element)) return writer.result();
  const children = isXmlElement(element) ? element.children : [];
  if (children.length === 0) {
    writer.push("/>");
    return writer.result();
  }
  if (!writer.push(">")) return writer.result();
  const named = children.find(
    (child) =>
      isXmlElement(child) &&
      /^(?:name|title|label)$/iu.test(localOf(child.name)) &&
      leafText(child) !== undefined,
  );
  if (isXmlElement(named)) {
    if (
      !writer.push("<") ||
      !writer.push(named.name) ||
      !writer.push(">") ||
      !writer.escaped(leafText(named) ?? "") ||
      !writer.push("</") ||
      !writer.push(named.name) ||
      !writer.push(">")
    )
      return writer.result();
  }
  writer.push("…");
  return writer.result();
};

/** Whether an attribute's name and an element's tag share a stem, as HomeBank's `payee` and `<pay>`. */
const stemOf = (attribute: string, tag: string) => {
  const [left, right] = [attribute, tag].map((name) =>
    (name.split(":").at(-1) ?? name).toLowerCase(),
  );
  return (
    left !== undefined &&
    right !== undefined &&
    Math.min(left.length, right.length) >= 3 &&
    (left.startsWith(right) || right.startsWith(left))
  );
};

/** What a value a pointer reads names: the one other element whose `key` or `id` it equals, or, among several, the one whose tag shares the attribute's stem, the one named for it first; a plain number only through an attribute so named, or one ending in `id`, `ref` or `key`. */
const referencesFrom = (
  index: ReadonlyMap<string, ReadonlyMap<string, readonly JsonValue[]>>,
) => {
  const resolve = (
    value: string,
    attribute: string | undefined,
    self: JsonValue | undefined,
  ): ValueReference | undefined => {
    if (!referable(value)) return undefined;
    // A plain number, as a list's `count="5"`, names an element only through an attribute named for one.
    const plain = /^-?\d+(?:\.\d+)?$/u.test(value);
    const found = [...(index.get(value)?.values() ?? [])]
      .flat()
      .filter(
        (node) =>
          node !== self &&
          (!plain ||
            (attribute !== undefined &&
              isXmlElement(node) &&
              (stemOf(attribute, node.name) ||
                /(?:id|ref|key)$/iu.test(localOf(attribute))))),
      );
    const stemmed =
      found.length === 1 || attribute === undefined
        ? found
        : found.filter(
            (node) => isXmlElement(node) && stemOf(attribute, node.name),
          );
    // Among several, the tag the attribute is named for, as `account` an `<ACCOUNT>` before an `<ACCOUNTID>`.
    const named = stemmed.filter(
      (node) =>
        isXmlElement(node) &&
        localOf(node.name).toLowerCase() ===
          localOf(attribute ?? "").toLowerCase(),
    );
    const hinted = stemmed.length > 1 && named.length === 1 ? named : stemmed;
    const [element] = hinted;
    return hinted.length === 1 && isXmlElement(element)
      ? {
          ...(attribute === undefined ? {} : { attribute }),
          value,
          element: referenceTag(element),
        }
      : undefined;
  };
  return resolve;
};

/** References without repeats, the first of each attribute and value. */
const uniqueReferences = (references: readonly ValueReference[]) => {
  const seen = new Set<string>();
  return references.filter(({ attribute, value }) => {
    const key = JSON.stringify([attribute, value]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** What a values list reads: a file's two ends and how it treats each pointer. */
export interface ValueContext {
  readonly ends: {
    readonly baseline: JsonValue | null;
    readonly final: JsonValue | null;
  };
  /** Whether a pointer is one the values list shows: a value of the document rather than a reader's field. */
  readonly listed: (view: JsonValue | null, pointer: string) => boolean;
  /** Why a pointer is noise, if it is. */
  readonly noise: (pointer: string) => NoiseReason | undefined;
  readonly format: (
    view: JsonValue | null,
    pointer: string,
  ) => "json" | "xml" | "archive";
  readonly referenceRoots: (view: JsonValue | null) => readonly JsonValue[];
}

const byteLength = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;

/** Records of attributes an element nests whose references a value lists, as the splits of a transaction. */
const MAX_NESTED_RECORDS = 10;

/** The references in an element's attributes other than its own identifiers; of one holding nothing but an identifier, as Parley's `<entry id="6"/>`, that identifier's. */
const attributeReferences = (
  resolve: ReturnType<typeof referencesFrom>,
  element: JsonValue,
) =>
  Object.entries(isXmlElement(element) ? element.attributes : {}).flatMap(
    ([key, item]) =>
      typeof item === "string" &&
      ((!isIdentifyingAttribute(key) && !/^key$/iu.test(key)) ||
        isIdReference(element))
        ? (resolve(item, key, element) ?? [])
        : [],
  );

/**
 * The elements a value names: each attribute of an element by its own value,
 * other than the element's own identifiers, and of the records of
 * attributes it nests, as a KMyMoney split's `account` and `payee`; or a
 * scalar, with the attribute that holds it. Each once.
 */
const referencesOf = (
  resolve: ReturnType<typeof referencesFrom>,
  view: JsonValue | null,
  pointer: string,
): ValueReference[] => {
  const value = resolvePointer(view, pointer, "xml");
  if (isXmlElement(value))
    return uniqueReferences([
      ...attributeReferences(resolve, value),
      ...recordListsOf(value)
        .flatMap(({ records }) => records)
        .slice(0, MAX_NESTED_RECORDS)
        .flatMap((record) => attributeReferences(resolve, record)),
      // A field holding another element's id as its text, as a split's `<split:account>`.
      ...[value, ...value.children].flatMap((field) => {
        const text = leafText(field);
        return isXmlElement(field) &&
          text !== undefined &&
          !/^id$/iu.test(localOf(field.name))
          ? (resolve(text, field.name, value) ?? [])
          : [];
      }),
    ]);
  if (typeof value !== "string") return [];
  const segments = pointer.split("/");
  const attribute =
    segments.at(-2) === "attributes" ? attributeKeyOf(pointer) : undefined;
  const owner = resolvePointer(view, segments.slice(0, -2).join("/"), "xml");
  return [resolve(value, attribute, owner) ?? []].flat();
};

/** What a pointer names at the seed; an attribute of a member keyed by its new name, as a renamed layer, read from the member it pairs with there. */
const seedValue = ({ ends, format }: ValueContext, pointer: string) => {
  const key = attributeKeyOf(pointer);
  const seen = resolvePointer(
    ends.baseline,
    pointer,
    format(ends.baseline, pointer),
  );
  if (
    seen !== undefined ||
    key === undefined ||
    format(ends.final, pointer) !== "xml"
  )
    return seen;
  const member = pairedAtSeed(ends, pointer.split("/").slice(0, -2).join("/"));
  return isXmlElement(member) ? member.attributes[key] : undefined;
};

/** A value's entry, with the references it holds, before any limit. */
const entryOf = (
  context: ValueContext,
  references: (view: JsonValue | null) => ReturnType<typeof referencesFrom>,
  pointer: string,
  kind: DraftValue["kind"],
): DraftValue => {
  const { baseline, final } = context.ends;
  const view = kind === "removed" ? baseline : final;
  const located = locatePointer(view, pointer, context.format(view, pointer));
  const found = located.kind === "value";
  // A text node added or removed is reached only by its index among its element's children.
  const listPointer = pointer.replace(/\/\d+$/u, "");
  const indexedText =
    found &&
    context.format(view, pointer) === "xml" &&
    kind !== "changed" &&
    /\/children\/\d+$/u.test(pointer) &&
    Array.isArray(resolvePointer(view, listPointer, "xml")) &&
    isXmlElement(
      resolvePointer(view, listPointer.replace(/\/children$/u, ""), "xml"),
    );
  const note: ValueNote | undefined =
    found && located.byPosition.length > 0
      ? "by_position"
      : (context.noise(pointer) ?? (indexedText ? "by_position" : undefined));
  const refers =
    context.format(view, pointer) === "xml"
      ? referencesOf(references(view), view, pointer).slice(
          0,
          VALUE_LIMITS.references,
        )
      : [];
  const alternatives =
    kind === "changed" &&
    note === undefined &&
    context.format(view, pointer) === "xml"
      ? alternativePointers(view, pointer)
      : [];
  return {
    pointer,
    kind,
    before:
      kind === "added"
        ? null
        : compactValue(
            seedValue(context, pointer),
            VALUE_LIMITS.chars,
            context.format(baseline, pointer),
          ),
    after:
      kind === "removed"
        ? null
        : compactValue(
            resolvePointer(final, pointer, context.format(final, pointer)),
            VALUE_LIMITS.chars,
            context.format(final, pointer),
          ),
    ...(note === undefined ? {} : { note }),
    ...(refers.length === 0 ? {} : { refers_to: refers }),
    ...(alternatives.length === 0 ? {} : { alternatives }),
  };
};

/**
 * The pointers a value added whole is listed by: a record of text fields in
 * a list of its kind, as GnuCash's `<gnc:transaction>`, by each of its
 * fields, and a field that lists such records, as its `<trn:splits>`, by
 * each record, so the cut on one value never hides a field; anything else
 * whole, as a document's root or a FreeCAD object of property lists.
 */
const fieldsOf = (view: JsonValue | null, pointer: string): string[] => {
  const value = resolvePointer(view, pointer, "xml");
  const list = resolvePointer(view, pointer.replace(/\/[^/]+$/u, ""), "xml");
  if (
    !isXmlElement(value) ||
    !/\/children\/[^/]+$/u.test(pointer) ||
    !Array.isArray(list) ||
    list.filter((item) => isXmlElement(item) && item.name === value.name)
      .length < 2 ||
    !isRecordAt(view, pointer, value) ||
    !value.children.some((child) => leafText(child) !== undefined)
  )
    return [pointer];
  const members = (element: JsonValue) => {
    const { keys } = pairMembers(
      isXmlElement(element) ? element.children : [],
      [],
      undefined,
      "xml",
    ).newer;
    return (isXmlElement(element) ? element.children : []).flatMap(
      (child, index) =>
        isXmlElement(child)
          ? [{ child, key: escapeToken(keys[index] ?? String(index)) }]
          : [],
    );
  };
  return members(value).flatMap(({ child, key }) => {
    const at = `${pointer}/children/${key}`;
    const records = members(child);
    return records.length > 0 &&
      records.every(
        ({ child: record }) =>
          record.name === records[0]?.child.name && holdsFields(record),
      )
      ? records.map((record) => `${at}/children/${record.key}`)
      : [at];
  });
};

/** How an entry sorts: what a check can name first, text before attributes and whole elements, so a cut never drops the edit; then what only position reaches; then noise. */
const rank = (entry: DraftValue) =>
  entry.note === undefined
    ? typeof entry.after === "string" &&
      !entry.after.startsWith("<") &&
      /\/children\/\d+$/u.test(entry.pointer)
      ? 0
      : 1
    : entry.note === "by_position"
      ? 2
      : 3;

/**
 * The values a file's net change added, changed and removed, at the pointers
 * the keyed diff names them by: a check's pointer and expected value ready to
 * copy. What a check can name comes first, then what only position reaches
 * (`by_position`), then noise, each with its note; at most `VALUE_LIMITS`
 * entries and bytes, `cut` when any is left out, the diff's own lists
 * included.
 */
export const draftValues = (
  change: Pick<
    DesktopStateDifference,
    | "added"
    | "changed"
    | "removed"
    | "added_count"
    | "changed_count"
    | "removed_count"
  >,
  context: ValueContext,
): { readonly values: DraftValue[]; readonly cut: boolean } => {
  const indexes = new Map<
    JsonValue | null,
    ReturnType<typeof referencesFrom>
  >();
  const references = (view: JsonValue | null) => {
    const known = indexes.get(view);
    if (known !== undefined) return known;
    const made = referencesFrom(referenceIndex(context.referenceRoots(view)));
    indexes.set(view, made);
    return made;
  };
  const { baseline, final } = context.ends;
  const entries = [
    ...change.added
      .filter((pointer) => context.listed(final, pointer))
      .flatMap((pointer) =>
        context.format(final, pointer) === "xml"
          ? fieldsOf(final, pointer)
          : [pointer],
      )
      .map((pointer) => entryOf(context, references, pointer, "added")),
    ...change.changed
      .filter((pointer) => context.listed(final, pointer))
      .map((pointer) => entryOf(context, references, pointer, "changed")),
    ...change.removed
      .filter((pointer) => context.listed(baseline, pointer))
      .map((pointer) => entryOf(context, references, pointer, "removed")),
  ].toSorted((left, right) => rank(left) - rank(right));
  const values: DraftValue[] = [];
  let bytes = 2; // The serialized values array's brackets.
  for (const entry of entries) {
    const size = byteLength(entry) + (values.length === 0 ? 0 : 1);
    if (
      values.length >= VALUE_LIMITS.entries ||
      bytes + size > VALUE_LIMITS.fileBytes
    )
      break;
    values.push(entry);
    bytes += size;
  }
  const listedAll =
    change.added.length === change.added_count &&
    change.changed.length === change.changed_count &&
    change.removed.length === change.removed_count;
  return { values, cut: values.length < entries.length || !listedAll };
};

/**
 * A change from nothing to a file created, or from a file deleted to nothing,
 * as only what its one end holds: added or removed. Against nothing, a
 * container's own entry changing says no more than that.
 */
export const oneEnd = <
  Change extends Pick<
    DesktopStateDifference,
    | "added"
    | "changed"
    | "removed"
    | "added_count"
    | "changed_count"
    | "removed_count"
  >,
>(
  change: Change,
  created: boolean,
): Change => ({
  ...change,
  added: created ? change.added : [],
  added_count: created ? change.added_count : 0,
  removed: created ? [] : change.removed,
  removed_count: created ? 0 : change.removed_count,
  changed: [],
  changed_count: 0,
});

/** Values of files in order, kept while the draft's whole list stays within `VALUE_LIMITS.draftBytes`. */
export const withinDraftBudget = <
  File extends { values: readonly DraftValue[]; values_cut: boolean },
>(
  files: readonly File[],
): File[] => {
  // Reserve every file's array brackets before assigning entry bytes in file order.
  let left = VALUE_LIMITS.draftBytes - files.length * 2;
  return files.map((file) => {
    const kept: DraftValue[] = [];
    for (const entry of file.values) {
      const size = byteLength(entry) + (kept.length === 0 ? 0 : 1);
      if (size > left) break;
      kept.push(entry);
      left -= size;
    }
    return kept.length === file.values.length
      ? file
      : { ...file, values: kept, values_cut: true };
  });
};
