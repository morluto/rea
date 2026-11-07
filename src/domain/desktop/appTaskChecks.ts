import type { JsonValue } from "../jsonValue.js";
import {
  collapseWhitespace,
  countComparison,
  type CountCheck,
  type DesktopTaskCheck,
  type PointerCheck,
} from "./appTask.js";
import type { DesktopStatePath } from "./desktopState.js";
import {
  elementText,
  isXmlElement,
  locatePointer,
  selectorTest,
  type Located,
} from "./viewPointer.js";
import {
  viewlessEntryAt,
  zipArrayLeavesOut,
  zipEntryAt,
  zipLeavesOutAt,
} from "./zipView.js";

/** One file as the app's data/get reports it: its view, or why it has none. An absent file has no entry. */
export interface TaskFileView {
  readonly format: string | null;
  /** Present when the view is of the document inside a gzip file, which checks read as the document. */
  readonly compression?: string;
  readonly view: JsonValue | null;
  readonly error?: string | null;
}

/**
 * How one check came out against one set of views. `undecided` marks a failure
 * that shows nothing about the task: its file or table could not be read, or
 * what would turn it may lie in what its view left out.
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
/** A failure to find what a check looks for, undecided when its view is cut, since it may lie past what the view kept. */
const notFound = (description: string, cut: boolean): Verdict =>
  cut ? unread(description) : fail(description);

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
export const numberOf = (value: JsonValue): number | undefined => {
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

const compared = (check: CountCheck, n: number, what: string): Verdict => {
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
      : notFound(`${file} has no line ${shown(missing)}`, read.truncated);
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

/**
 * Whether `value` is an XML element whose joined text is the number: an XML
 * file, or an XML entry inside a zip. A JSON object with the same shape is
 * the value itself, not a cell.
 */
const joinsElementText = (
  format: string | null | undefined,
  view: JsonValue | null,
  pointer: string,
  value: JsonValue,
): boolean => {
  if (!isXmlElement(value)) return false;
  if (format === "xml") return true;
  if (format !== "zip") return false;
  const entry = zipEntryAt(view, pointer);
  return typeof entry === "object" && entry.format === "xml";
};

/** A value compared within a tolerance: numbers, and numeral strings, by their difference. An XML element's text is joined only when `join` says the view is XML. */
const nearVerdict = (
  at: string,
  found: JsonValue,
  expected: number,
  tolerance: number,
  join: boolean,
): Verdict => {
  const number = numberOf(join ? elementText(found) : found);
  const within = `within ${shown(tolerance)} of ${shown(expected)}`;
  if (number === undefined)
    return fail(`${at} is ${shown(found)}, not a number`);
  return Math.abs(number - expected) <= tolerance
    ? pass(`${at} is ${shown(found)}, ${within}`)
    : fail(`${at} is ${shown(found)}, not ${within}`);
};

/**
 * Why a pointer check cannot be decided on what the view holds: the entry whose
 * view its pointer goes into has none, or a selector searched an array the view
 * may hold only part of. Undefined when it can be.
 */
const unreadOrPartial = (
  check: PointerCheck,
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

const NOTHING: Located = { kind: "none", searched: [], byPosition: [] };

/** Why a pointer names no value, undecided when its view is cut, since the value may lie past what the view kept. */
const noValue = (
  at: string,
  located: Located & { kind: "none" },
  cut: boolean,
): Verdict =>
  notFound(
    located.reason === undefined
      ? `${at} has no value`
      : `${at}: ${located.reason}`,
    cut,
  );

const valueVerdict = (
  check: Check<"value_equals" | "value_absent">,
  entry: TaskFileView | undefined,
): Verdict => {
  const read = viewOf(check, entry, undefined);
  if ("passed" in read) return read;
  const located =
    entry === undefined ? NOTHING : locatePointer(read.view, check.pointer);
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
    if (located.kind === "none") return noValue(at, located, truncated);
    if (check.tolerance !== undefined && typeof check.value === "number") {
      // A cut element's kept runs can join into a number the file never held.
      const join = joinsElementText(
        entry?.format,
        read.view,
        check.pointer,
        located.value,
      );
      if (join && truncated) return undecided(check.file);
      return nearVerdict(at, located.value, check.value, check.tolerance, join);
    }
    return sameJson(located.value, check.value)
      ? pass(`${at} is ${shown(check.value)}`)
      : fail(`${at} is ${shown(located.value)}, not ${shown(check.value)}`);
  }
  if (truncated) return undecided(check.file);
  return located.kind === "none"
    ? pass(`${at} has no value`)
    : fail(`${at} is ${shown(located.value)}`);
};

/**
 * Whether a string a pointer reaches is text of the document: a member of an
 * element's `children` (a text node) or `attributes` (an attribute's value),
 * rather than an element's name or a field of the DOCTYPE.
 */
const isTextAt = (view: JsonValue | null, pointer: string): boolean => {
  const segments = pointer.split("/");
  const field = segments.at(-2);
  if (field !== "children" && field !== "attributes") return false;
  const owner = locatePointer(view, segments.slice(0, -2).join("/"));
  return owner.kind === "value" && isXmlElement(owner.value);
};

/** Why a text check's pointer into an archive goes into no XML entry's view, or undefined when it does or names an entry not listed. */
const notXmlEntry = (
  check: Check<"text_equals" | "text_contains">,
  view: JsonValue | null,
): string | undefined => {
  if (check.pointer.split("/")[3] !== "view")
    return `${check.file} at ${check.pointer} does not point into an entry's view`;
  const entry = zipEntryAt(view, check.pointer);
  if (typeof entry !== "object" || entry.format === "xml") return undefined;
  // An entry without a view failed before this, so its format is one with a view.
  const text = (value: JsonValue | undefined) =>
    typeof value === "string" ? value : "";
  return `${check.file} entry ${text(entry.name)} is read as ${text(entry.format)}, not xml`;
};

/** A text found at `at` compared with the check's value or searched for it, both collapsed when it asks. */
const comparedText = (
  check: Check<"text_equals" | "text_contains">,
  at: string,
  found: string,
): Verdict => {
  const collapse = check.normalize_whitespace === true;
  const text = collapse ? collapseWhitespace(found) : found;
  const value = collapse ? collapseWhitespace(check.value) : check.value;
  const read =
    check.text_attribute === undefined
      ? ""
      : ` in its ${check.text_attribute} values`;
  const how = `${read}${collapse ? " with whitespace collapsed" : ""}`;
  if (check.kind === "text_equals")
    return text === value
      ? pass(`${at} has the text ${shown(value)}${how}`)
      : fail(`${at} has the text ${shown(text)}${how}, not ${shown(value)}`);
  return text.includes(value)
    ? pass(`${at} has text containing ${shown(value)}${how}`)
    : fail(`${at} has the text ${shown(text)}${how}, without ${shown(value)}`);
};

/** An element's whole text, or a text node's, compared with `value` or searched for it. */
const textVerdict = (
  check: Check<"text_equals" | "text_contains">,
  entry: TaskFileView | undefined,
): Verdict => {
  const read = viewOf(check, entry, undefined);
  if ("passed" in read) return read;
  const at = `${check.file} at ${check.pointer}`;
  if (entry === undefined) return fail(`${at} has no value`);
  const zip = entry.format === "zip";
  if (!zip && entry.format !== "xml")
    return fail(`${check.file} is read as ${String(entry.format)}, not xml`);
  const located = locatePointer(read.view, check.pointer);
  const unknown = unreadOrPartial(check, entry.format, read, located);
  if (unknown !== undefined) return unknown;
  const problem = zip ? notXmlEntry(check, read.view) : undefined;
  if (problem !== undefined) return fail(problem);
  if (located.kind === "unresolved") return fail(`${at}: ${located.problem}`);
  // A zip view's truncation that matters is the entry the pointer goes into.
  // A child past the kept nodes of a cut view may still hold the text.
  const truncated = zip
    ? zipLeavesOutAt(read.view, check.pointer)
    : read.truncated;
  // A missing child of a cut view is the same undecided result in both evaluators.
  if (located.kind === "none")
    return truncated
      ? unread(
          `the view of ${check.file} is truncated, so what it leaves out is unknown (${check.pointer})`,
        )
      : noValue(at, located, false);
  const found = located.value;
  // Only an element has attributes of its own and of its descendants to join.
  const attribute = check.text_attribute;
  if (
    typeof found === "string"
      ? attribute !== undefined || !isTextAt(read.view, check.pointer)
      : !isXmlElement(found)
  )
    return fail(
      `${at} is ${shown(found)}, not ${attribute === undefined ? "an element, a text node or an attribute value" : "an element"}`,
    );
  // A text node is whole. An element's text in a cut view may lack what the cut
  // dropped from its middle, so its kept runs can read as text it never had.
  if (typeof found !== "string" && truncated) return undecided(check.file);
  return comparedText(check, at, elementText(found, attribute));
};

/** How many members of the array at a pointer, or of those a selector matches, compared with the expected number. */
const memberVerdict = (
  check: Check<"member_count">,
  entry: TaskFileView | undefined,
): Verdict => {
  const { matching, pointer } = check;
  const read = viewOf(check, entry, undefined);
  if ("passed" in read) return read;
  // The empty pointer names the whole view, as a JSON file whose top level is an array.
  const located: Located =
    entry === undefined
      ? NOTHING
      : pointer === ""
        ? { kind: "value", value: read.view, searched: [], byPosition: [] }
        : locatePointer(read.view, pointer);
  const at = pointer === "" ? check.file : `${check.file} at ${pointer}`;
  const unknown = unreadOrPartial(check, entry?.format, read, located);
  if (unknown !== undefined) return unknown;
  if (located.kind === "unresolved") return fail(`${at}: ${located.problem}`);
  const cut =
    entry?.format === "zip"
      ? zipArrayLeavesOut(read.view, pointer)
      : read.truncated;
  if (located.kind === "none") return noValue(at, located, cut);
  const items = located.value;
  if (!Array.isArray(items))
    return fail(`${at} is ${shown(items)}, not an array`);
  // A count is decided only on an array the view holds whole.
  if (cut) return undecided(check.file);
  // The parser refuses a `matching` that is no selector.
  const meets =
    matching === undefined
      ? () => true
      : (selectorTest(matching) ?? (() => false));
  return compared(
    check,
    items.filter(meets).length,
    `member(s) of ${at}${matching === undefined ? "" : ` matching ${matching}`}`,
  );
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

/** Count every row satisfying a task predicate, including overlapping predicates. */
export const countTaskRows = (
  columns: readonly JsonValue[],
  rows: readonly (readonly JsonValue[])[],
  where: Readonly<Record<string, JsonValue>>,
): number => {
  const conditions = Object.entries(where).map(
    ([column, value]) => [columns.indexOf(column), value] as const,
  );
  let count = 0;
  for (const row of rows)
    if (
      conditions.every(
        ([index, value]) => index >= 0 && sameJson(row[index], value),
      )
    )
      count += 1;
  return count;
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
  const n = countTaskRows(
    columns,
    rows.filter(Array.isArray),
    check.where ?? {},
  );
  if (check.kind === "row_present")
    return n > 0
      ? pass(`${name} has a row with ${shown(check.where)}`)
      : notFound(
          `${name} has no row with ${shown(check.where)}`,
          table.truncated,
        );
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
    case "text_equals":
    case "text_contains":
      return textVerdict(check, entry);
    case "row_present":
    case "row_absent":
    case "row_count":
      return rowVerdict(check, entry);
    case "member_count":
      return memberVerdict(check, entry);
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
