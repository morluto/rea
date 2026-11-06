import type { JsonValue } from "../jsonValue.js";
import { isTimestamp, type DesktopTaskCheckInput } from "./appTask.js";
import type { DesktopStatePath } from "./desktopState.js";

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
    const identity = (view: TableView, row: readonly JsonValue[]) =>
      JSON.stringify(
        view.key.length === 0
          ? row
          : view.key.map((column) => row[view.columns.indexOf(column)] ?? null),
      );
    const oldRows = new Map(old.rows.map((row) => [identity(old, row), row]));
    const newRows = new Map(
      table.rows.map((row) => [identity(table, row), row]),
    );
    const keyed = (column: string) => table.key.includes(column);
    for (const [id, row] of newRows) {
      const previous = oldRows.get(id);
      if (previous === undefined)
        push(
          "row_present",
          name,
          rowWhere(
            table,
            row,
            (column) => table.key.length === 0 || !keyed(column),
          ),
        );
      else if (JSON.stringify(previous) !== JSON.stringify(row))
        push(
          "row_present",
          name,
          rowWhere(
            table,
            row,
            (column) =>
              keyed(column) ||
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
          rowWhere(
            old,
            row,
            (column) => old.key.length === 0 || old.key.includes(column),
          ),
        );
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
