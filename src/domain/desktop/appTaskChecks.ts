import type { JsonValue } from "../jsonValue.js";
import { countComparison, type DesktopTaskCheck } from "./appTask.js";
import type { DesktopStatePath } from "./desktopState.js";
import { locatePointer, type Located } from "./viewPointer.js";
import {
  viewlessEntryAt,
  zipArrayLeavesOut,
  zipLeavesOutAt,
} from "./zipView.js";

/** One file as the app's data/get reports it: its view, or why it has none. An absent file has no entry. */
export interface TaskFileView {
  readonly format: string | null;
  readonly view: JsonValue | null;
  readonly error?: string | null;
}

/**
 * How one check came out against one set of views. `undecided` marks a failure
 * that shows nothing about the task: its file or table could not be read, or
 * its view holds only part of what the check needs.
 */
export type TaskCheckOutcome = {
  readonly id: string;
  readonly passed: boolean;
  readonly description: string;
  readonly undecided?: true;
};

type Verdict = Omit<TaskCheckOutcome, "id">;
type Check<Kind extends DesktopTaskCheck["kind"]> = Extract<
  DesktopTaskCheck,
  { kind: Kind }
>;

const pass = (description: string): Verdict => ({ passed: true, description });
const fail = (description: string): Verdict => ({
  passed: false,
  description,
});
const shown = (value: JsonValue): string => {
  const text = JSON.stringify(value);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
};
/** A failure for want of a readable or whole view, not for what the view holds. */
const unread = (description: string): Verdict => ({
  ...fail(description),
  undecided: true,
});
const undecided = (file: string): Verdict =>
  unread(`the view of ${file} is truncated, so what it leaves out is unknown`);

const isRecord = (
  value: JsonValue | null | undefined,
): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** JSON equality: numbers by value, objects by their keys, arrays in order. */
export const sameJson = (
  actual: JsonValue | undefined,
  expected: JsonValue,
): boolean => {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, index) => sameJson(actual[index], item))
    );
  if (isRecord(expected))
    return (
      isRecord(actual) &&
      Object.keys(actual).length === Object.keys(expected).length &&
      Object.entries(expected).every(
        ([key, item]) =>
          Object.hasOwn(actual, key) && sameJson(actual[key], item),
      )
    );
  return actual === expected;
};

/** A decimal numeral as FreeCAD and other apps write numbers in text, such as `5.0000000000000000`. */
const NUMERAL = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/u;

/** A number, or a numeral string read as one; undefined for anything else or a numeral past the doubles. */
const numberOf = (value: JsonValue): number | undefined => {
  if (typeof value === "number") return value;
  if (typeof value !== "string" || !NUMERAL.test(value)) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};

/** A file's version as the app's data/get serves it, or undefined when it is absent. */
export const versionView = (
  version: DesktopStatePath["versions"][number],
): TaskFileView | undefined =>
  !version.present
    ? undefined
    : version.view_error === null
      ? { format: version.format, view: version.view }
      : { format: version.format, view: null, error: version.view_error };

/** Whether a view says it holds only part of its file, as REA's own readers flag it. */
const truncatedView = (format: string | null, view: JsonValue | null) => {
  if (!isRecord(view)) return false;
  if (format === "text" || format === "xml") return view.truncated === true;
  if (format !== "sqlite") return false;
  const tables = isRecord(view.tables) ? Object.values(view.tables) : [];
  return (
    view.tables_truncated === true ||
    tables.some(
      (table) =>
        isRecord(table) &&
        (table.truncated === true || typeof table.error === "string"),
    )
  );
};

/** A file's view of one format, or why the check cannot read it; an absent file reads as empty. */
const viewOf = (
  check: DesktopTaskCheck,
  entry: TaskFileView | undefined,
  format: string | undefined,
): { view: JsonValue | null; truncated: boolean } | Verdict => {
  if (entry === undefined) return { view: null, truncated: false };
  if (typeof entry.error === "string")
    return unread(`${check.file} has no view: ${entry.error}`);
  if (entry.format === null || entry.format === "binary")
    return fail(`${check.file} is binary and has no view`);
  if (format !== undefined && entry.format !== format)
    return fail(`${check.file} is read as ${entry.format}, not ${format}`);
  return {
    view: entry.view,
    truncated: truncatedView(entry.format, entry.view),
  };
};

const compared = (
  check: Check<"line_count" | "row_count">,
  n: number,
  what: string,
): Verdict => {
  const { operator, n: expected } = countComparison(check) ?? {
    operator: "equals",
    n: Number.NaN,
  };
  const met =
    operator === "equals"
      ? n === expected
      : operator === "at_least"
        ? n >= expected
        : n <= expected;
  const description = `${String(n)} ${what}, expected ${operator.replace("_", " ")} ${String(expected)}`;
  return met ? pass(description) : fail(description);
};

const lineVerdict = (
  check: Check<"lines_present" | "lines_absent" | "line_count">,
  entry: TaskFileView | undefined,
): Verdict => {
  const read = viewOf(check, entry, "text");
  if ("passed" in read) return read;
  const lines =
    isRecord(read.view) && Array.isArray(read.view.lines)
      ? read.view.lines.filter((line) => typeof line === "string")
      : [];
  const file = check.file;
  if (check.kind === "lines_present") {
    const missing = check.lines.find((line) => !lines.includes(line));
    return missing === undefined
      ? pass(`${file} has the line(s) ${shown(check.lines)}`)
      : fail(`${file} has no line ${shown(missing)}`);
  }
  if (read.truncated) return undecided(file);
  if (check.kind === "lines_absent") {
    const found = check.lines.find((line) => lines.includes(line));
    return found === undefined
      ? pass(`${file} has none of the lines ${shown(check.lines)}`)
      : fail(`${file} still has the line ${shown(found)}`);
  }
  const { exact, contains } = check;
  const n = lines.filter((line) =>
    contains === undefined ? line === exact : line.includes(contains),
  ).length;
  return compared(
    check,
    n,
    contains === undefined
      ? `line(s) of ${file} match ${shown(exact ?? "")}`
      : `line(s) of ${file} contain ${shown(contains)}`,
  );
};

/** A value compared within a tolerance: numbers, and numeral strings, by their difference. */
const nearVerdict = (
  at: string,
  found: JsonValue,
  expected: number,
  tolerance: number,
): Verdict => {
  const number = numberOf(found);
  const within = `within ${shown(tolerance)} of ${shown(expected)}`;
  if (number === undefined)
    return fail(`${at} is ${shown(found)}, not a number`);
  return Math.abs(number - expected) <= tolerance
    ? pass(`${at} is ${shown(found)}, ${within}`)
    : fail(`${at} is ${shown(found)}, not ${within}`);
};

/**
 * Why a value check cannot be decided on what the view holds: the entry whose
 * view its pointer goes into has none, or a selector searched an array the view
 * may hold only part of. Undefined when it can be.
 */
const unreadOrPartial = (
  check: Check<"value_equals" | "value_absent">,
  format: string | null | undefined,
  read: { readonly view: JsonValue | null; readonly truncated: boolean },
  located: Located,
): Verdict | undefined => {
  const zip = format === "zip";
  const viewless = zip ? viewlessEntryAt(read.view, check.pointer) : undefined;
  if (viewless !== undefined) {
    const description = `${check.file} entry ${viewless.name} ${viewless.reason}`;
    return viewless.unread ? unread(description) : fail(description);
  }
  // A selector tells one member from several only in an array the view holds whole.
  const partial = (array: string) =>
    zip ? zipArrayLeavesOut(read.view, array) : read.truncated;
  return located.searched.some(partial) ? undecided(check.file) : undefined;
};

const valueVerdict = (
  check: Check<"value_equals" | "value_absent">,
  entry: TaskFileView | undefined,
): Verdict => {
  const read = viewOf(check, entry, undefined);
  if ("passed" in read) return read;
  const located: Located =
    entry === undefined
      ? { kind: "none", searched: [], byPosition: [] }
      : locatePointer(read.view, check.pointer);
  const at = `${check.file} at ${check.pointer}`;
  const unknown = unreadOrPartial(check, entry?.format, read, located);
  if (unknown !== undefined) return unknown;
  if (located.kind === "unresolved") return fail(`${at}: ${located.problem}`);
  // A zip view's truncation that matters is the entry the pointer goes into.
  const truncated =
    entry?.format === "zip"
      ? zipLeavesOutAt(read.view, check.pointer)
      : read.truncated;
  // A whole object or array equals the expected one only if nothing of it was left out.
  const whole =
    check.kind === "value_equals" &&
    typeof check.value === "object" &&
    check.value !== null;
  if (whole && truncated) return undecided(check.file);
  if (check.kind === "value_equals") {
    if (located.kind === "none")
      return fail(
        located.reason === undefined
          ? `${at} has no value`
          : `${at}: ${located.reason}`,
      );
    if (check.tolerance !== undefined && typeof check.value === "number")
      return nearVerdict(at, located.value, check.value, check.tolerance);
    return sameJson(located.value, check.value)
      ? pass(`${at} is ${shown(check.value)}`)
      : fail(`${at} is ${shown(located.value)}, not ${shown(check.value)}`);
  }
  if (truncated) return undecided(check.file);
  return located.kind === "none"
    ? pass(`${at} has no value`)
    : fail(`${at} is ${shown(located.value)}`);
};

/** A table's columns and rows; a table the view lacks has none, unless the view left tables out. */
const tableOf = (
  check: Check<"row_present" | "row_absent" | "row_count">,
  view: JsonValue | null,
):
  | { columns: JsonValue[]; rows: JsonValue[]; truncated: boolean }
  | Verdict => {
  const sqlite = isRecord(view) ? view : {};
  const tables = isRecord(sqlite.tables) ? sqlite.tables : {};
  const table = Object.hasOwn(tables, check.table)
    ? tables[check.table]
    : undefined;
  if (table === undefined && sqlite.tables_truncated === true)
    return undecided(check.file);
  const read = isRecord(table) ? table : {};
  if (typeof read.error === "string")
    return unread(
      `${check.file} table ${check.table} could not be read: ${read.error}`,
    );
  return {
    columns: Array.isArray(read.columns) ? read.columns : [],
    rows: Array.isArray(read.rows) ? read.rows : [],
    truncated: read.truncated === true,
  };
};

const rowVerdict = (
  check: Check<"row_present" | "row_absent" | "row_count">,
  entry: TaskFileView | undefined,
): Verdict => {
  const read = viewOf(check, entry, "sqlite");
  if ("passed" in read) return read;
  const table = tableOf(check, read.view);
  if ("passed" in table) return table;
  const { columns, rows } = table;
  const name = `${check.file} table ${check.table}`;
  const matches = (row: JsonValue) =>
    Array.isArray(row) &&
    Object.entries(check.where ?? {}).every(([column, value]) => {
      const index = columns.indexOf(column);
      return index >= 0 && sameJson(row[index], value);
    });
  const n = rows.filter(matches).length;
  if (check.kind === "row_present")
    return n > 0
      ? pass(`${name} has a row with ${shown(check.where)}`)
      : fail(`${name} has no row with ${shown(check.where)}`);
  if (table.truncated) return undecided(check.file);
  if (check.kind === "row_absent")
    return n === 0
      ? pass(`${name} has no row with ${shown(check.where)}`)
      : fail(`${name} has ${String(n)} row(s) with ${shown(check.where)}`);
  return compared(
    check,
    n,
    `row(s) of ${name}${check.where === undefined ? "" : ` with ${shown(check.where)}`}`,
  );
};

const verdict = (
  check: DesktopTaskCheck,
  entry: TaskFileView | undefined,
): Verdict => {
  switch (check.kind) {
    case "file_present":
      return entry === undefined
        ? fail(`${check.file} does not exist`)
        : pass(`${check.file} exists`);
    case "file_absent":
      return entry === undefined
        ? pass(`${check.file} does not exist`)
        : fail(`${check.file} exists`);
    case "lines_present":
    case "lines_absent":
    case "line_count":
      return lineVerdict(check, entry);
    case "value_equals":
    case "value_absent":
      return valueVerdict(check, entry);
    case "row_present":
    case "row_absent":
    case "row_count":
      return rowVerdict(check, entry);
  }
};

/** Evaluate each check against views by home path, as the exported verifier does. */
export const evaluateTaskChecks = (
  checks: readonly DesktopTaskCheck[],
  views: ReadonlyMap<string, TaskFileView>,
): readonly TaskCheckOutcome[] =>
  checks.map((check) => ({
    id: check.id,
    ...verdict(check, views.get(check.file)),
  }));
