import type { JsonValue } from "../jsonValue.js";
import { isTimestamp, type DesktopTaskCheckInput } from "./appTask.js";
import { countTaskRows } from "./appTaskChecks.js";
import type { DesktopStatePath } from "./desktopState.js";
import { sqliteRowIdentity } from "./stateChanges.js";

type Version = DesktopStatePath["versions"][number];
type Suggestion = DesktopTaskCheckInput;

const isRecord = (
  value: JsonValue | null | undefined,
): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface TableView {
  readonly columns: readonly string[];
  readonly key: readonly string[];
  readonly rows: readonly (readonly JsonValue[])[];
}

/** Keep unread tables distinct from absence in a complete table inventory. */
const tableViews = (version: Version) => {
  const tables = new Map<string, TableView | undefined>();
  const view = version.present ? version.view : null;
  if (!isRecord(view) || !isRecord(view.tables))
    return { tables, complete: false };
  for (const [name, table] of Object.entries(view.tables)) {
    tables.set(name, undefined);
    if (!isRecord(table) || table.truncated !== false) continue;
    const strings = (value: JsonValue | undefined) =>
      Array.isArray(value)
        ? value.filter((item) => typeof item === "string")
        : [];
    tables.set(name, {
      columns: strings(table.columns),
      key: strings(table.primary_key),
      rows: Array.isArray(table.rows) ? table.rows.filter(Array.isArray) : [],
    });
  }
  return { tables, complete: view.tables_truncated === false };
};

/** Column values of a row, without volatile values or the columns left out. */
const rowWhere = (
  table: TableView,
  row: readonly JsonValue[],
  keep: (column: string) => boolean,
): Record<string, JsonValue> =>
  Object.fromEntries(
    table.columns.flatMap((column, index) => {
      const value = row[index] ?? null;
      return keep(column) && !isTimestamp(value) ? [[column, value]] : [];
    }),
  );

/** Match uniquely keyed rows separately from multiset row conditions. */
const keyedRows = (table: TableView) =>
  new Map(
    table.rows.flatMap((row) => {
      const identity = sqliteRowIdentity(table.columns, table.key, row);
      return identity.keyed ? [[identity.value, row] as const] : [];
    }),
  );

/** The predicates a task can express after volatile values are omitted. */
const rowConditions = (table: TableView) => {
  const conditions = new Map<string, Record<string, JsonValue>>();
  for (const row of table.rows) {
    if (sqliteRowIdentity(table.columns, table.key, row).keyed) continue;
    const where = rowWhere(table, row, () => true);
    if (Object.keys(where).length === 0) continue;
    conditions.set(JSON.stringify(where), where);
  }
  return conditions;
};

const unkeyedRowSuggestions = (
  file: string,
  table: string,
  baseline: TableView,
  final: TableView,
): Suggestion[] => {
  const conditions = new Map([
    ...rowConditions(final),
    ...rowConditions(baseline),
  ]);
  const suggestions: Suggestion[] = [];
  for (const where of conditions.values()) {
    const previous = countTaskRows(baseline.columns, baseline.rows, where);
    const count = countTaskRows(final.columns, final.rows, where);
    if (previous === count) continue;
    if (count === 0)
      suggestions.push({ kind: "row_absent", file, table, where });
    else if (previous === 0)
      suggestions.push({ kind: "row_present", file, table, where });
    else
      suggestions.push({
        kind: "row_count",
        file,
        table,
        where,
        equals: count,
      });
  }
  return suggestions;
};

/** Rows a database's tables gained, changed and lost, and new row counts, without volatile values. */
export const rowSuggestions = (
  file: string,
  baseline: Version,
  final: Version,
): Suggestion[] => {
  const before = tableViews(baseline);
  const suggestions: Suggestion[] = [];
  for (const [name, table] of tableViews(final).tables) {
    if (table === undefined) continue;
    const previousTable = before.tables.get(name);
    if (
      previousTable === undefined &&
      (before.tables.has(name) || !before.complete)
    )
      continue;
    const old = previousTable ?? { ...table, rows: [] };
    // Judge the predicate after volatile values are omitted, using the same
    // matching semantics as the evaluator rather than raw row positions.
    const push = (
      kind: "row_present" | "row_absent",
      where: Record<string, JsonValue>,
      previousRow?: readonly JsonValue[],
    ) => {
      if (Object.keys(where).length === 0) return;
      // A paired row is sufficient only while the predicate retains its
      // complete key. Omitted timestamp keys can let siblings match too.
      const previousRows =
        previousRow !== undefined &&
        old.key.every((column) => Object.hasOwn(where, column))
          ? [previousRow]
          : old.rows;
      if (
        kind === "row_present"
          ? countTaskRows(old.columns, previousRows, where) === 0
          : countTaskRows(table.columns, table.rows, where) === 0
      )
        suggestions.push({ kind, file, table: name, where });
    };
    const oldRows = keyedRows(old);
    const newRows = keyedRows(table);
    for (const [id, row] of newRows) {
      const previous = oldRows.get(id);
      if (previous === undefined)
        push(
          "row_present",
          rowWhere(table, row, (column) => !table.key.includes(column)),
        );
      else
        push(
          "row_present",
          rowWhere(
            table,
            row,
            (column) =>
              table.key.includes(column) ||
              JSON.stringify(row[table.columns.indexOf(column)]) !==
                JSON.stringify(previous[old.columns.indexOf(column)]),
          ),
          previous,
        );
    }
    for (const [id, row] of oldRows)
      if (!newRows.has(id))
        push(
          "row_absent",
          rowWhere(old, row, (column) => old.key.includes(column)),
        );
    suggestions.push(...unkeyedRowSuggestions(file, name, old, table));
    if (old.rows.length !== table.rows.length)
      suggestions.push({
        kind: "row_count",
        file,
        table: name,
        equals: table.rows.length,
      });
  }
  return suggestions;
};
