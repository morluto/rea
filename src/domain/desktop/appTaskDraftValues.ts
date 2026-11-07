import { z } from "zod";

import { jsonValueSchema, type JsonValue } from "../jsonValue.js";
import { isXmlElement } from "./appTaskChecks.js";
import {
  attributeKeyOf,
  NOISE_REASONS,
  type NoiseReason,
} from "./appTaskDraftNoise.js";
import { isIdentifyingAttribute } from "./attributeRank.js";
import type { DesktopStateDifference } from "./stateChanges.js";
import { locatePointer, resolvePointer } from "./viewPointer.js";

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
      "by_position: no selector names it, so no check can use the pointer; view_state, renumbered, volatile, timestamp or upkeep: noise the app writes, left out of the suggested checks.",
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
});

/** Bounds on the values a draft lists, so a large change cannot crowd out the rest of it. */
export const VALUE_LIMITS = {
  entries: 20,
  fileBytes: 8 * 1024,
  draftBytes: 24 * 1024,
  chars: 600,
  references: 3,
} as const;

const isRecord = (
  value: JsonValue | undefined,
): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const cut = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

const escapeText = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
const escapeAttribute = (text: string) =>
  escapeText(text).replaceAll('"', "&quot;");

/** An element's attributes; none for a value that holds none. */
const attributesOf = (element: Record<string, JsonValue>) => {
  const { attributes } = element;
  return isRecord(attributes) ? attributes : {};
};

/** An element's start tag with its attributes. */
const startTag = (element: Record<string, JsonValue> & { name: string }) =>
  `<${element.name}${Object.entries(attributesOf(element))
    .map(([key, value]) => ` ${key}="${escapeAttribute(String(value))}"`)
    .join("")}`;

/** An archive entry's own fields, without its view. */
const isArchiveEntry = (value: JsonValue): value is Record<string, JsonValue> =>
  isRecord(value) && "sha256" in value && "view" in value && "name" in value;

/**
 * A value as an author reads it: a scalar as it is, cut past `max`
 * characters; an element as compact XML, with every text node the XML reader
 * kept, which already leaves out the whitespace an app lays out between
 * elements; an archive entry as its name, format and size; anything else as
 * JSON. Writing stops once past `max`, so a large subtree costs no more than
 * the cut.
 */
export const compactValue = (
  value: JsonValue | undefined,
  format: "json" | "xml" | "archive",
  max: number = VALUE_LIMITS.chars,
): JsonValue => {
  if (value === undefined) return null;
  if (typeof value === "string") return cut(value, max);
  if (value === null || typeof value !== "object") return value;
  const parts: string[] = [];
  let length = 0;
  const push = (text: string) => {
    parts.push(text);
    length += text.length;
    return length <= max;
  };
  const write = (node: JsonValue): boolean => {
    if (format === "xml" && isXmlElement(node)) {
      const start = startTag(node);
      if (node.children.length === 0) return push(`${start}/>`);
      return (
        push(`${start}>`) &&
        node.children.every((child) =>
          typeof child === "string" ? push(escapeText(child)) : write(child),
        ) &&
        push(`</${node.name}>`)
      );
    }
    if (format === "archive" && isArchiveEntry(node))
      return push(
        JSON.stringify({
          name: node.name,
          format: node.format ?? null,
          size: node.size ?? null,
        }),
      );
    if (Array.isArray(node))
      return (
        push("[") &&
        node.every(
          (item, index) => (index === 0 || push(",")) && write(item),
        ) &&
        push("]")
      );
    if (isRecord(node))
      return (
        push("{") &&
        Object.entries(node).every(
          ([key, item], index) =>
            (index === 0 || push(",")) &&
            push(`${JSON.stringify(key)}:`) &&
            write(item),
        ) &&
        push("}")
      );
    return push(JSON.stringify(node));
  };
  write(value);
  return cut(parts.join(""), max);
};

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
 * XML elements by the value of their `key` or `id` attribute, across a view,
 * and by tag: at most `PER_TAG` of a tag in document order, so a key that
 * records or archive entries repeat costs no more than that.
 */
const referenceIndex = (roots: readonly JsonValue[]) => {
  const index = new Map<string, Map<string, JsonValue[]>>();
  const pending: JsonValue[] = [...roots];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isXmlElement(node))
      for (const [key, value] of Object.entries(attributesOf(node)))
        if (
          typeof value === "string" &&
          referable(value) &&
          /^(?:key|id)$/iu.test(key.split(":").at(-1) ?? key)
        )
          indexUnder(index, value, node);
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

/** What a value a pointer reads names: the one other element whose `key` or `id` it equals, or, among several, the one whose tag shares the attribute's stem. */
const referencesFrom = (
  index: ReadonlyMap<string, ReadonlyMap<string, readonly JsonValue[]>>,
) => {
  const resolve = (
    value: string,
    attribute: string | undefined,
    self: JsonValue | undefined,
  ): ValueReference | undefined => {
    if (!referable(value)) return undefined;
    const found = [...(index.get(value)?.values() ?? [])]
      .flat()
      .filter((node) => node !== self);
    const hinted =
      found.length === 1 || attribute === undefined
        ? found
        : found.filter(
            (node) => isXmlElement(node) && stemOf(attribute, node.name),
          );
    const [element] = hinted;
    return hinted.length === 1 && isXmlElement(element)
      ? {
          ...(attribute === undefined ? {} : { attribute }),
          value,
          element: cut(
            `${startTag(element)}${element.children.length === 0 ? "/>" : ">…"}`,
            VALUE_LIMITS.chars,
          ),
        }
      : undefined;
  };
  return resolve;
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

/**
 * The elements a value names: each attribute of an element by its own value,
 * other than the element's own identifiers, or a scalar, with the attribute
 * that holds it.
 */
const referencesOf = (
  resolve: ReturnType<typeof referencesFrom>,
  view: JsonValue | null,
  pointer: string,
): ValueReference[] => {
  const value = resolvePointer(view, pointer);
  if (isXmlElement(value))
    return Object.entries(attributesOf(value)).flatMap(([key, item]) =>
      typeof item === "string" &&
      !isIdentifyingAttribute(key) &&
      !/^key$/iu.test(key)
        ? (resolve(item, key, value) ?? [])
        : [],
    );
  if (typeof value !== "string") return [];
  const segments = pointer.split("/");
  const attribute =
    segments.at(-2) === "attributes" ? attributeKeyOf(pointer) : undefined;
  const owner = resolvePointer(view, segments.slice(0, -2).join("/"));
  return [resolve(value, attribute, owner) ?? []].flat();
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
  const located = locatePointer(view, pointer);
  const found = located.kind === "value";
  // A text node added or removed is reached only by its index among its element's children.
  const listPointer = pointer.replace(/\/\d+$/u, "");
  const indexedText =
    found &&
    context.format(view, pointer) === "xml" &&
    kind !== "changed" &&
    /\/children\/\d+$/u.test(pointer) &&
    Array.isArray(resolvePointer(view, listPointer)) &&
    isXmlElement(resolvePointer(view, listPointer.replace(/\/children$/u, "")));
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
  return {
    pointer,
    kind,
    before:
      kind === "added"
        ? null
        : compactValue(
            resolvePointer(baseline, pointer),
            context.format(baseline, pointer),
          ),
    after:
      kind === "removed"
        ? null
        : compactValue(
            resolvePointer(final, pointer),
            context.format(final, pointer),
          ),
    ...(note === undefined ? {} : { note }),
    ...(refers.length === 0 ? {} : { refers_to: refers }),
  };
};

/** How an entry sorts: what a check can name first, then what only position reaches, then noise. */
const rank = (entry: DraftValue) =>
  entry.note === undefined ? 0 : entry.note === "by_position" ? 1 : 2;

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
      .map((pointer) => entryOf(context, references, pointer, "added")),
    ...change.changed
      .filter((pointer) => context.listed(final, pointer))
      .map((pointer) => entryOf(context, references, pointer, "changed")),
    ...change.removed
      .filter((pointer) => context.listed(baseline, pointer))
      .map((pointer) => entryOf(context, references, pointer, "removed")),
  ].toSorted((left, right) => rank(left) - rank(right));
  const values: DraftValue[] = [];
  let bytes = 0;
  for (const entry of entries) {
    const size = byteLength(entry);
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
  let left = VALUE_LIMITS.draftBytes;
  return files.map((file) => {
    const kept: DraftValue[] = [];
    for (const entry of file.values) {
      const size = byteLength(entry);
      if (size > left) break;
      kept.push(entry);
      left -= size;
    }
    return kept.length === file.values.length
      ? file
      : { ...file, values: kept, values_cut: true };
  });
};
