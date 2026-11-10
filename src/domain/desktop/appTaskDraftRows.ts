import type { JsonValue } from "../jsonValue.js";
import { appendAll } from "../arrayAppend.js";
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

const tableViews = (version: Version): ReadonlyMap<string, TableView> => {
  const tables = new Map<string, TableView>();
  const view = version.present ? version.view : null;
  if (!isRecord(view) || !isRecord(view.tables)) return tables;
  for (const [name, table] of Object.entries(view.tables)) {
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
  return tables;
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
  const push = (
    kind: "row_present" | "row_absent",
    table: string,
    where: Record<string, JsonValue>,
  ) => {
    if (Object.keys(where).length > 0)
      suggestions.push({ kind, file, table, where });
  };
  for (const [name, table] of tableViews(final)) {
    const old = before.get(name) ?? { ...table, rows: [] };
    const oldRows = keyedRows(old);
    const newRows = keyedRows(table);
    for (const [id, row] of newRows) {
      const previous = oldRows.get(id);
      if (previous === undefined)
        push(
          "row_present",
          name,
          rowWhere(table, row, (column) => !table.key.includes(column)),
        );
      else if (JSON.stringify(previous) !== JSON.stringify(row))
        push(
          "row_present",
          name,
          rowWhere(
            table,
            row,
            (column) =>
              table.key.includes(column) ||
              JSON.stringify(row[table.columns.indexOf(column)]) !==
                JSON.stringify(previous[old.columns.indexOf(column)]),
          ),
        );
    }
    for (const [id, row] of oldRows)
      if (!newRows.has(id))
        push(
          "row_absent",
          name,
          rowWhere(old, row, (column) => old.key.includes(column)),
        );
    appendAll(suggestions, unkeyedRowSuggestions(file, name, old, table));
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
