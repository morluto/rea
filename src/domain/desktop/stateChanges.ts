import type { JsonValue } from "../jsonValue.js";
import type { DesktopStateFormat } from "./stateFormats.js";
import { holdsTagOnly, pairMembers } from "./memberPairing.js";
import { memberLookup } from "./viewPointer.js";
import { zipEntryAt, zipLeavesOut } from "./zipView.js";

const MAX_LISTED = 100;

/** What changed between two readable versions of one state file. */
export interface DesktopStateDifference {
  readonly kind: "lines" | "values" | "keys" | "rows" | "content";
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
  readonly added_count: number;
  readonly removed_count: number;
  readonly changed_count: number;
  /** False when either view was truncated, so absences may be outside the sample. */
  readonly complete: boolean;
}

const isRecord = (
  value: JsonValue | undefined,
): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const escapePointer = (segment: string) =>
  segment.replaceAll("~", "~0").replaceAll("/", "~1");

/** Longest JSON pointer listed; a longer one is only counted, so deep paths never fill the lists. */
const MAX_LISTED_POINTER = 4096;

/** Values found so far of one kind: the first pointers, and how many. */
interface Found {
  readonly listed: string[];
  count: number;
}

/** The pointer being walked, as escaped segments and its length in characters. */
interface PointerPath {
  readonly segments: string[];
  length: number;
}

const found = (): Found => ({ listed: [], count: 0 });

/** Count a value, building its pointer only when it is listed. */
const note = (into: Found, path: PointerPath): void => {
  into.count += 1;
  if (into.listed.length < MAX_LISTED && path.length <= MAX_LISTED_POINTER)
    into.listed.push(path.segments.map((segment) => `/${segment}`).join(""));
};

/**
 * A value's own entry: a scalar as JSON, a container as `[]` or `{}`, so an
 * array that becomes an object with the same members is still a change.
 */
const ownEntry = (value: JsonValue): string => {
  if (Array.isArray(value)) return "[]";
  return isRecord(value) ? "{}" : JSON.stringify(value);
};

/** How a walk matches array members: by selector rather than position, and whether it notes a missing value's members too. */
interface WalkOptions {
  readonly keyed?: boolean;
  readonly outermost?: boolean;
  readonly format?: (
    pointer: string,
    older: boolean,
  ) => string | null | undefined;
}

/** What a walk notes, and how; `older` when it walks the earlier version against the later one. */
interface Noting extends WalkOptions {
  readonly missing: Found;
  readonly changed?: Found;
  readonly older?: boolean;
}

/** Each member's key and the other version's member it pairs with, one to one, both walks pairing alike. */
const keyedMembers = (
  from: readonly JsonValue[],
  other: JsonValue | undefined,
  at: {
    readonly older: boolean;
    readonly list: string;
    readonly format: string | null | undefined;
    readonly otherFormat: string | null | undefined;
  },
) => {
  const others = Array.isArray(other) ? other : [];
  // Different entry formats cannot share selector semantics. Preserve each
  // side's resolvable positions instead of inventing cross-format identities.
  if (
    Array.isArray(other) &&
    at.format !== at.otherFormat &&
    at.format != null &&
    at.otherFormat != null
  )
    return from.map((_item, index) => ({
      key: String(index),
      counterpart: others[index],
    }));
  const hold = holdsTagOnly(at.list);
  const pairing = at.older
    ? pairMembers(others, from, hold, at.format)
    : pairMembers(from, others, hold, at.format);
  const older = at.older;
  const side = older ? pairing.older : pairing.newer;
  const lookup = memberLookup(other, [], at.otherFormat);
  return side.keys.map((key, index) => {
    const partner = side.partners[index];
    // Once the array became another type, a member's counterpart is what its pointer names there.
    if (!Array.isArray(other)) return { key, counterpart: lookup(key) };
    return {
      key,
      counterpart: partner === undefined ? undefined : others[partner],
    };
  });
};

/**
 * Walk `from` in document order against `other`, noting each value `other`
 * lacks in `missing` and, when given, each whose own entry differs in
 * `changed`. One path is shared, so memory follows depth, not the document;
 * a keyed walk also holds the member keys of the arrays along it.
 */
const walk = (
  from: JsonValue,
  other: JsonValue | undefined,
  path: PointerPath,
  into: Noting,
): void => {
  if (other === undefined) {
    note(into.missing, path);
    if (into.outermost === true) return;
  } else if (into.changed !== undefined && ownEntry(from) !== ownEntry(other))
    note(into.changed, path);
  const visit = (key: string, item: JsonValue, counterpart?: JsonValue) => {
    const segment = escapePointer(key);
    path.segments.push(segment);
    path.length += segment.length + 1;
    walk(item, counterpart, path, into);
    path.segments.pop();
    path.length -= segment.length + 1;
  };
  if (Array.isArray(from) && into.keyed === true) {
    const members = keyedMembers(from, other, {
      older: into.older === true,
      list: path.segments.map((segment) => `/${segment}`).join(""),
      format: into.format?.(
        path.segments.map((segment) => `/${segment}`).join(""),
        into.older === true,
      ),
      otherFormat: into.format?.(
        path.segments.map((segment) => `/${segment}`).join(""),
        into.older !== true,
      ),
    });
    from.forEach((item, index) => {
      const member = members[index];
      if (member !== undefined) visit(member.key, item, member.counterpart);
    });
  } else if (Array.isArray(from)) {
    const lookup = memberLookup(
      other,
      [],
      into.format?.(
        path.segments.map((segment) => `/${segment}`).join(""),
        into.older !== true,
      ),
    );
    from.forEach((item, index) =>
      visit(String(index), item, lookup(String(index))),
    );
  } else if (isRecord(from)) {
    // The keys go to the lookup together, so an array compared with an object is searched once per field set.
    const lookup = memberLookup(
      other,
      Object.keys(from),
      into.format?.(
        path.segments.map((segment) => `/${segment}`).join(""),
        into.older !== true,
      ),
    );
    for (const [key, item] of Object.entries(from))
      visit(key, item, lookup(key));
  }
};

/**
 * Values added, removed and changed between two JSON documents, by JSON
 * pointer; keyed, array members are paired one to one by the selectors naming
 * them, so an inserted member does not shift the ones after it.
 */
const compareTrees = (
  before: JsonValue,
  after: JsonValue,
  options: WalkOptions = {},
): DesktopStateDifference => {
  const [added, removed, changed] = [found(), found(), found()];
  const start = () => ({ segments: [], length: 0 });
  walk(after, before, start(), { ...options, missing: added, changed });
  walk(before, after, start(), { ...options, missing: removed, older: true });
  return {
    kind: "values",
    added: added.listed,
    removed: removed.listed,
    changed: changed.listed,
    added_count: added.count,
    removed_count: removed.count,
    changed_count: changed.count,
    complete: true,
  };
};

const compareMaps = (
  kind: DesktopStateDifference["kind"],
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): DesktopStateDifference => {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [key, value] of after) {
    const previous = before.get(key);
    if (previous === undefined) added.push(key);
    else if (previous !== value) changed.push(key);
  }
  for (const key of before.keys()) if (!after.has(key)) removed.push(key);
  return {
    kind,
    added: added.slice(0, MAX_LISTED),
    removed: removed.slice(0, MAX_LISTED),
    changed: changed.slice(0, MAX_LISTED),
    added_count: added.length,
    removed_count: removed.length,
    changed_count: changed.length,
    complete: true,
  };
};

/** Lines whose count differs between versions, as a multiset difference. */
const lineDifference = (
  before: JsonValue,
  after: JsonValue,
): DesktopStateDifference => {
  const lines = (view: JsonValue) =>
    isRecord(view) && Array.isArray(view.lines)
      ? view.lines.filter((line): line is string => typeof line === "string")
      : [];
  const counts = new Map<string, number>();
  for (const line of lines(before))
    counts.set(line, (counts.get(line) ?? 0) - 1);
  for (const line of lines(after))
    counts.set(line, (counts.get(line) ?? 0) + 1);
  const added: string[] = [];
  const removed: string[] = [];
  for (const [line, count] of counts) {
    for (let index = 0; index < count; index += 1) added.push(line);
    for (let index = 0; index > count; index -= 1) removed.push(line);
  }
  return {
    kind: "lines",
    added: added.slice(0, MAX_LISTED),
    removed: removed.slice(0, MAX_LISTED),
    changed: [],
    added_count: added.length,
    removed_count: removed.length,
    changed_count: 0,
    complete: true,
  };
};

/**
 * `group/key` → value for key files and dconf views. The key is escaped as a
 * JSON pointer segment, so the last `/` always ends the group: `[a/b]` `c` and
 * `[a]` `b/c` stay apart.
 */
const keyEntries = (view: JsonValue): Map<string, string> => {
  const entries = new Map<string, string>();
  const groups = isRecord(view) && isRecord(view.groups) ? view.groups : {};
  for (const [group, keys] of Object.entries(groups))
    if (isRecord(keys))
      for (const [key, value] of Object.entries(keys))
        entries.set(`${group}/${escapePointer(key)}`, JSON.stringify(value));
  return entries;
};

const tablesOf = (view: JsonValue): Record<string, JsonValue> =>
  isRecord(view) && isRecord(view.tables) ? view.tables : {};

/** Tables a SQLite view records as failed to read. */
const unreadTables = (view: JsonValue): string[] =>
  Object.entries(tablesOf(view))
    .filter(([, table]) => isRecord(table) && typeof table.error === "string")
    .map(([name]) => name);

/** A nullable SQLite primary key cannot identify a row on its own. */
export const sqliteRowIdentity = (
  columns: readonly JsonValue[],
  key: readonly JsonValue[],
  row: readonly JsonValue[],
): { value: string; keyed: boolean } => {
  const indexes = key.map((column) => columns.indexOf(column));
  const keyed =
    indexes.length > 0 &&
    indexes.every(
      (index) => index >= 0 && row[index] !== null && row[index] !== undefined,
    );
  return {
    value: JSON.stringify(keyed ? indexes.map((index) => row[index]) : row),
    keyed,
  };
};

/**
 * `table:key` → row for SQLite views, keyed by primary key when there is one.
 * Tables unread in either version are skipped, so their rows are not misreported.
 */
const rowEntries = (
  view: JsonValue,
  skipped: ReadonlySet<string>,
): Map<string, string> => {
  const entries = new Map<string, string>();
  for (const [name, table] of Object.entries(tablesOf(view))) {
    if (skipped.has(name) || !isRecord(table) || !Array.isArray(table.rows))
      continue;
    const columns = Array.isArray(table.columns) ? table.columns : [];
    const keyColumns = Array.isArray(table.primary_key)
      ? table.primary_key
      : [];
    const seen = new Map<string, number>();
    for (const row of table.rows) {
      if (!Array.isArray(row)) continue;
      const identity = sqliteRowIdentity(columns, keyColumns, row).value;
      // Rows without a key are compared as a multiset of whole rows.
      const occurrence = seen.get(identity) ?? 0;
      seen.set(identity, occurrence + 1);
      entries.set(
        `${name}:${identity}${occurrence === 0 ? "" : `#${String(occurrence)}`}`,
        JSON.stringify(row),
      );
    }
  }
  return entries;
};

/** Whether a view says it holds only part of its file. */
const truncatedView = (view: JsonValue): boolean => {
  if (!isRecord(view)) return false;
  if (view.truncated === true || view.tables_truncated === true) return true;
  return (
    unreadTables(view).length > 0 ||
    Object.values(tablesOf(view)).some(
      (table) => isRecord(table) && table.truncated === true,
    )
  );
};

/**
 * Describe how one state file changed between two readable versions. With
 * `named`, XML members are listed by the selectors naming them, as a check
 * names them, and by position only where nothing names them or where only
 * their order changed, which no selector shows.
 */
export const diffStateViews = (
  format: DesktopStateFormat,
  before: JsonValue,
  after: JsonValue,
  options: { readonly named?: boolean } = {},
): DesktopStateDifference => {
  const difference =
    (format === "xml" || format === "json") && options.named === true
      ? namedOrPositional(before, after, format)
      : compareViews(format, before, after);
  // Only REA's own readers write coverage flags; JSON and key files are data.
  const flagged = format === "text" || format === "xml" || format === "sqlite";
  const partial =
    format === "zip"
      ? zipLeavesOut(before) || zipLeavesOut(after)
      : flagged && (truncatedView(before) || truncatedView(after));
  return partial ? { ...difference, complete: false } : difference;
};

/** An XML change keyed by selector, or by position when keying shows none, as when siblings only moved. */
const namedOrPositional = (
  before: JsonValue,
  after: JsonValue,
  format: "xml" | "json",
): DesktopStateDifference => {
  const named = compareTrees(before, after, {
    keyed: true,
    format: () => format,
  });
  return named.added_count + named.removed_count + named.changed_count > 0
    ? named
    : compareTrees(before, after);
};

const compareViews = (
  format: DesktopStateFormat,
  before: JsonValue,
  after: JsonValue,
): DesktopStateDifference => {
  switch (format) {
    case "text":
      return lineDifference(before, after);
    case "json":
    case "xml":
      return compareTrees(before, after);
    case "zip":
      return compareTrees(before, after, {
        keyed: true,
        format: archiveFormat(after, before),
      });
    case "keyfile":
    case "dconf":
      return compareMaps("keys", keyEntries(before), keyEntries(after));
    case "sqlite": {
      const unread = new Set([...unreadTables(before), ...unreadTables(after)]);
      return compareMaps(
        "rows",
        rowEntries(before, unread),
        rowEntries(after, unread),
      );
    }
    case "binary":
      return compareMaps("content", new Map(), new Map());
  }
};

/**
 * How two views differ by name-addressed pointer, a member added or removed
 * whole noted once, without its contents: an archive's entries, or an XML tree.
 */
export const diffNamedMembers = (
  before: JsonValue,
  after: JsonValue,
  format: "json" | "xml" | "zip" = "xml",
): DesktopStateDifference =>
  compareTrees(before, after, {
    keyed: true,
    outermost: true,
    format: format === "zip" ? archiveFormat(after, before) : () => format,
  });

const archiveFormat =
  (after: JsonValue, before: JsonValue) =>
  (pointer: string, older: boolean): string | undefined => {
    const entry = zipEntryAt(older ? before : after, pointer);
    return typeof entry === "object" &&
      entry !== null &&
      typeof entry.format === "string"
      ? entry.format
      : undefined;
  };
