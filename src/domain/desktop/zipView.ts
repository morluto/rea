import { createHash } from "node:crypto";

import type { JsonValue } from "../jsonValue.js";
import { err, ok, type Result } from "../result.js";
import {
  detectStateFormat,
  textualView,
  type DesktopStateFormat,
} from "./stateFormats.js";
import { locatePointer } from "./viewPointer.js";

const MIB = 1024 * 1024;
/** Entries a zip view lists; past them it counts entries and is truncated. */
export const MAX_ZIP_ENTRIES = 1000;
/** Largest entry read, uncompressed. */
export const MAX_ZIP_ENTRY_BYTES = 16 * MIB;
/** Uncompressed bytes read from one archive, the same as the largest file the state view reads. */
const MAX_ZIP_BYTES = 64 * MIB;
/** Most an entry may expand over its compressed size; a zip bomb expands about a thousand times. */
export const MAX_ZIP_RATIO = 100;

/** Why an archive has no view; the exported reader words it the same. */
export const UNREADABLE_ZIP = "not a readable zip archive";
/** Why an entry whose data fails its checks has no view. */
export const DAMAGED_ZIP_ENTRY = "its compressed data is damaged";

/** What the central directory says of one entry, before it is read. */
export interface ZipEntryHeader {
  readonly name: string;
  readonly size: number;
  readonly compressedSize: number;
  readonly method: number;
  readonly encrypted: boolean;
}

/** Why an entry is not read, checked in this order by both readers, or undefined; `spent` is the archive's bytes read so far. */
export const zipEntryRefusal = (
  header: ZipEntryHeader,
  spent: number,
): string | undefined => {
  if (header.encrypted) return "encrypted, so it is not read";
  if (header.method !== 0 && header.method !== 8)
    return `compressed with method ${String(header.method)}, which the view does not read`;
  if (header.size > MAX_ZIP_ENTRY_BYTES)
    return `larger than the ${String(MAX_ZIP_ENTRY_BYTES / MIB)} MiB an entry's view reads`;
  if (header.size > MAX_ZIP_RATIO * header.compressedSize)
    return `expands more than ${String(MAX_ZIP_RATIO)} times, so it is not read`;
  if (spent + header.size > MAX_ZIP_BYTES)
    return `past the ${String(MAX_ZIP_BYTES / MIB)} MiB read from one archive`;
  return undefined;
};

/** An entry that was not read: its name and size, and why. */
export const unreadZipEntry = (
  header: ZipEntryHeader,
  error: string,
): JsonValue => ({
  name: header.name,
  size: header.size,
  sha256: null,
  format: null,
  view: null,
  view_error: error,
});

/** An entry's view for its format; one whose reader needs a tool, a worker or another archive opened is not read. */
const entryView = (
  format: DesktopStateFormat,
  bytes: Uint8Array,
): Result<JsonValue, string> => {
  switch (format) {
    case "text":
    case "json":
    case "keyfile":
    case "xml":
      return textualView(format, bytes);
    case "sqlite":
      return err("a SQLite database inside an archive is not read");
    case "dconf":
      return err("a dconf database inside an archive is not read");
    case "zip":
      return err("an archive inside an archive is not read");
    case "binary":
      return ok(null);
  }
};

/** An entry read from its uncompressed bytes by the readers and limits a file's view uses. */
export const zipEntry = (
  header: ZipEntryHeader,
  bytes: Uint8Array,
): JsonValue => {
  const format = detectStateFormat(header.name, bytes);
  const read = entryView(format, bytes);
  return {
    name: header.name,
    size: header.size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    format,
    view: read.ok ? read.value : null,
    view_error: read.ok ? null : read.error,
  };
};

/** A zip archive's view: its file entries in archive order, up to the listing limit, and how many it has. */
export const zipView = (
  entries: readonly JsonValue[],
  count: number,
): JsonValue => ({
  entries: [...entries],
  entry_count: count,
  truncated: count > entries.length,
});

const isRecord = (
  value: JsonValue | null | undefined,
): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether an entry's view is missing or holds only part of it. */
const entryLeavesOut = (entry: JsonValue): boolean =>
  isRecord(entry) &&
  (typeof entry.view_error === "string" ||
    ((entry.format === "text" || entry.format === "xml") &&
      isRecord(entry.view) &&
      entry.view.truncated === true));

/** Whether a zip view leaves anything out: entries past its listing, or what an entry's view lacks. */
export const zipLeavesOut = (view: JsonValue | null): boolean =>
  isRecord(view) &&
  (view.truncated === true ||
    (Array.isArray(view.entries) && view.entries.some(entryLeavesOut)));

/** The entry a pointer into a zip view goes into, `none` when it names an entry the view lacks, or undefined when it names none. */
export const zipEntryAt = (
  view: JsonValue | null,
  pointer: string,
): Record<string, JsonValue> | "none" | undefined => {
  const [first, second] = pointer.slice(1).split("/");
  if (first !== "entries" || second === undefined) return undefined;
  const entry = locatePointer(view, `/entries/${second}`, "zip");
  if (entry.kind !== "value") return "none";
  return isRecord(entry.value) ? entry.value : undefined;
};

/** Formats an entry's view is read in; any other entry's `view` is `null` for want of one. */
const VIEW_FORMATS: ReadonlySet<JsonValue> = new Set([
  "text",
  "json",
  "keyfile",
  "xml",
]);

/** Why an entry has no view a check can read: binary, unread, or of a format with none; undefined when it has one. */
export const entryWithoutView = (
  entry: Record<string, JsonValue>,
): string | undefined => {
  if (typeof entry.view_error === "string")
    return `has no view: ${entry.view_error}`;
  if (entry.format === "binary") return "is binary and has no view";
  return VIEW_FORMATS.has(entry.format ?? null) ? undefined : "has no view";
};

/**
 * The entry whose view a pointer goes into when it has none, so its `view` of
 * `null` is no JSON value, and why; `unread` when reading its view failed.
 */
export const viewlessEntryAt = (
  view: JsonValue | null,
  pointer: string,
):
  | { readonly name: string; readonly reason: string; readonly unread: boolean }
  | undefined => {
  const entry = zipEntryAt(view, pointer);
  if (typeof entry !== "object" || pointer.split("/")[3] !== "view")
    return undefined;
  const reason = entryWithoutView(entry);
  return reason === undefined
    ? undefined
    : {
        name: typeof entry.name === "string" ? entry.name : "",
        reason,
        unread: typeof entry.view_error === "string",
      };
};

/**
 * Whether a zip view leaves out what a pointer reaches: for a pointer into one
 * listed entry, only that entry; for an entry not listed, the listing; else anything.
 */
export const zipLeavesOutAt = (
  view: JsonValue | null,
  pointer: string,
): boolean => {
  const entry = zipEntryAt(view, pointer);
  if (entry === undefined) return zipLeavesOut(view);
  return entry === "none"
    ? isRecord(view) && view.truncated === true
    : entryLeavesOut(entry);
};

/** Whether an array in a zip view may lack members: the listing when it is cut, or an array in an entry whose view is. */
export const zipArrayLeavesOut = (
  view: JsonValue | null,
  array: string,
): boolean =>
  array === "/entries"
    ? isRecord(view) && view.truncated === true
    : zipLeavesOutAt(view, array);
