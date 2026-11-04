import type { JsonValue } from "../jsonValue.js";
import type { DesktopStateFormat } from "./stateFormats.js";

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

/** Leaves of a JSON value keyed by JSON pointer. */
const flatten = (
  value: JsonValue,
  pointer = "",
  leaves = new Map<string, string>(),
): Map<string, string> => {
  // Empty containers are leaves, so `{}`, `[]` and their changes stay visible.
  if (Array.isArray(value) && value.length > 0)
    value.forEach((item, index) =>
      flatten(item, `${pointer}/${String(index)}`, leaves),
    );
  else if (isRecord(value) && Object.keys(value).length > 0)
    for (const [key, item] of Object.entries(value))
      flatten(item, `${pointer}/${escapePointer(key)}`, leaves);
  else leaves.set(pointer, JSON.stringify(value));
  return leaves;
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

/** `group/key` → value for key files and dconf views. */
const keyEntries = (view: JsonValue): Map<string, string> => {
  const entries = new Map<string, string>();
  const groups = isRecord(view) && isRecord(view.groups) ? view.groups : {};
  for (const [group, keys] of Object.entries(groups))
    if (isRecord(keys))
      for (const [key, value] of Object.entries(keys))
        entries.set(`${group}/${key}`, JSON.stringify(value));
  return entries;
};

/** `table:key` → row for SQLite views, keyed by primary key when there is one. */
const rowEntries = (view: JsonValue): Map<string, string> => {
  const entries = new Map<string, string>();
  const tables = isRecord(view) && isRecord(view.tables) ? view.tables : {};
  for (const [name, table] of Object.entries(tables)) {
    if (!isRecord(table) || !Array.isArray(table.rows)) continue;
    const columns = Array.isArray(table.columns) ? table.columns : [];
    const keyColumns = (
      Array.isArray(table.primary_key) ? table.primary_key : []
    )
      .map((column) => columns.indexOf(column))
      .filter((index) => index >= 0);
    const seen = new Map<string, number>();
    for (const row of table.rows) {
      if (!Array.isArray(row)) continue;
      const identity =
        keyColumns.length > 0
          ? JSON.stringify(keyColumns.map((index) => row[index] ?? null))
          : JSON.stringify(row);
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
    isRecord(view.tables) &&
    Object.values(view.tables).some(
      (table) => isRecord(table) && table.truncated === true,
    )
  );
};

/** Describe how one state file changed between two readable versions. */
export const diffStateViews = (
  format: DesktopStateFormat,
  before: JsonValue,
  after: JsonValue,
): DesktopStateDifference => {
  const difference = compareViews(format, before, after);
  return truncatedView(before) || truncatedView(after)
    ? { ...difference, complete: false }
    : difference;
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
      return compareMaps("values", flatten(before), flatten(after));
    case "keyfile":
    case "dconf":
      return compareMaps("keys", keyEntries(before), keyEntries(after));
    case "sqlite":
      return compareMaps("rows", rowEntries(before), rowEntries(after));
    case "binary":
      return compareMaps("content", new Map(), new Map());
  }
};
