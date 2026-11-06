import type { JsonValue } from "../jsonValue.js";
import { isTimestamp, type DesktopTaskCheckInput } from "./appTask.js";
import {
  ARCHIVE,
  escapeToken,
  innermost,
  namedSuggestions,
  XML_FILE,
} from "./appTaskDraftNamed.js";
import {
  versionAt,
  type DesktopStatePath,
  type StateEnds,
} from "./desktopState.js";
import { countTaskRows } from "./appTaskChecks.js";
import { diffStateViews, sqliteRowIdentity } from "./stateChanges.js";
import { resolvePointer } from "./viewPointer.js";

type Version = DesktopStatePath["versions"][number];
type Suggestion = DesktopTaskCheckInput;

/** Suggestions per file; an author picks among them. */
const MAX_SUGGESTIONS = 10;
const MAX_ITEMS = 200;
const MAX_CHARS = 2000;
/** The most text checks a file gets, and the longest text one compares. */
const LIMIT = { suggestions: MAX_SUGGESTIONS, chars: MAX_CHARS };

/** The views at a file's two ends. */
const versions = (baseline: Version, final: Version) => ({
  baseline: baseline.view,
  final: final.view,
});

const isRecord = (
  value: JsonValue | null | undefined,
): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A JSON value cut to a size an agent can read, and whether anything was cut. */
const bounded = (
  value: JsonValue | null,
): { value: JsonValue | null; cut: boolean } => {
  let cut = false;
  const visit = (node: JsonValue): JsonValue => {
    if (typeof node === "string" && node.length > MAX_CHARS) {
      cut = true;
      return `${node.slice(0, MAX_CHARS)}…`;
    }
    if (Array.isArray(node)) {
      cut ||= node.length > MAX_ITEMS;
      return node.slice(0, MAX_ITEMS).map(visit);
    }
    if (!isRecord(node)) return node;
    const entries = Object.entries(node);
    cut ||= entries.length > MAX_ITEMS;
    return Object.fromEntries(
      entries.slice(0, MAX_ITEMS).map(([key, item]) => [key, visit(item)]),
    );
  };
  return { value: value === null ? null : visit(value), cut };
};

/** A version as the draft shows it; views only for the files the suggestions cover. */
const draftVersion = (version: Version, withView: boolean) => {
  const { value, cut } = bounded(withView ? version.view : null);
  return {
    checkpoint: version.checkpoint,
    present: version.present,
    format: version.format,
    ...(withView ? { view: value, view_cut: cut } : {}),
    view_error: version.view_error,
  };
};

const linesOf = (version: Version): readonly string[] =>
  isRecord(version.view) && Array.isArray(version.view.lines)
    ? version.view.lines.filter((line) => typeof line === "string")
    : [];

const counts = (lines: readonly string[]) => {
  const result = new Map<string, number>();
  for (const line of lines) result.set(line, (result.get(line) ?? 0) + 1);
  return result;
};

/** Lines found at both ends whose number of occurrences changed. */
const lineCounts = (baseline: Version, final: Version) => {
  const before = counts(linesOf(baseline));
  return [...counts(linesOf(final))]
    .filter(([line, n]) => (before.get(line) ?? n) !== n)
    .map(([line, n]) => ({ line, baseline: before.get(line) ?? 0, final: n }));
};

const textSuggestions = (
  file: string,
  baseline: Version,
  final: Version,
): Suggestion[] => {
  const before = new Set(baseline.present ? linesOf(baseline) : []);
  const after = new Set(linesOf(final));
  const added = [...after].filter((line) => !before.has(line));
  const gone = [...before].filter((line) => !after.has(line));
  const suggestions: Suggestion[] = [];
  if (added.length > 0 && added.length <= MAX_SUGGESTIONS)
    suggestions.push({ kind: "lines_present", file, lines: added });
  const truncated = [baseline, final].some(
    (version) => isRecord(version.view) && version.view.truncated === true,
  );
  if (truncated) return suggestions;
  if (gone.length > 0 && gone.length <= MAX_SUGGESTIONS)
    suggestions.push({ kind: "lines_absent", file, lines: gone });
  // A line of digits and punctuation is usually a value a rewrite renumbers, not something the user made.
  for (const { line, final: n } of lineCounts(baseline, final).filter(
    ({ line }) => /\p{L}/u.test(line),
  ))
    suggestions.push({ kind: "line_count", file, exact: line, equals: n });
  return suggestions;
};

/** `group/key` entries of key file views as JSON pointers into the view. */
const keyPointers = (
  views: readonly (JsonValue | null)[],
): ReadonlyMap<string, string> =>
  new Map<string, string>(
    views.flatMap((view) =>
      Object.entries(
        isRecord(view) && isRecord(view.groups) ? view.groups : {},
      ).flatMap(([group, keys]) =>
        Object.keys(isRecord(keys) ? keys : {}).map((key): [string, string] => [
          `${group}/${escapeToken(key)}`,
          `/groups/${escapeToken(group)}/${escapeToken(key)}`,
        ]),
      ),
    ),
  );

const valueSuggestions = (
  file: string,
  baseline: Version,
  final: Version,
): Suggestion[] => {
  const format = final.format;
  if (format === "zip" || format === "xml")
    return namedSuggestions(
      file,
      versions(baseline, final),
      format === "zip" ? ARCHIVE : XML_FILE,
      LIMIT,
    );
  if (format !== "json" && format !== "keyfile") return [];
  const change = diffStateViews(format, baseline.view, final.view);
  const pointers = keyPointers([baseline.view, final.view]);
  const pointer = (entry: string) =>
    format === "keyfile" ? pointers.get(entry) : entry;
  // Key file entries are flat; a group may hold `/`, so prefixes mean nothing there.
  const leaves = (entries: readonly string[]) =>
    format === "keyfile" ? entries : innermost(entries);
  const suggestions: Suggestion[] = [];
  for (const entry of leaves([...change.added, ...change.changed])) {
    const at = pointer(entry);
    const value = at === undefined ? undefined : resolvePointer(final.view, at);
    if (
      at !== undefined &&
      at !== "" &&
      value !== undefined &&
      !isTimestamp(value)
    )
      suggestions.push({ kind: "value_equals", file, pointer: at, value });
  }
  for (const entry of leaves(change.removed)) {
    const at = pointer(entry);
    if (at !== undefined && at !== "")
      suggestions.push({ kind: "value_absent", file, pointer: at });
  }
  return suggestions;
};

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

const rowSuggestions = (
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

/** Checks that express how a file changed from its baseline to its final version. */
const suggestedChecks = (
  file: string,
  baseline: Version,
  final: Version,
): readonly Suggestion[] => {
  if (!final.present) return [{ kind: "file_absent", file }];
  const created: Suggestion[] = baseline.present
    ? []
    : [{ kind: "file_present", file }];
  const content =
    final.format === "text"
      ? textSuggestions(file, baseline, final)
      : !baseline.present
        ? []
        : final.format === "sqlite"
          ? rowSuggestions(file, baseline, final)
          : valueSuggestions(file, baseline, final);
  return [...created, ...content].slice(0, MAX_SUGGESTIONS);
};

/** How a file changed from its baseline to its final version, or undefined when it ends as it began. */
const netChange = (baseline: Version, final: Version) => {
  // A file with one version never changed, however much of it its view holds.
  if (baseline.checkpoint_index === final.checkpoint_index) return undefined;
  if (!baseline.present && !final.present) return undefined;
  // A database's hash leaves out its -wal sidecar, so equal hashes prove nothing about its rows.
  if (
    baseline.present &&
    final.present &&
    final.format !== "sqlite" &&
    baseline.sha256 !== null &&
    baseline.sha256 === final.sha256
  )
    return undefined;
  if (!baseline.present) return { kind: "created" };
  if (!final.present) return { kind: "deleted" };
  if (
    baseline.view_error !== null ||
    final.view_error !== null ||
    baseline.format === null ||
    final.format === null
  )
    return { kind: "unreadable" };
  if (baseline.format !== final.format) return { kind: "format" };
  if (final.format === "binary") return { kind: "content" };
  const difference = diffStateViews(final.format, baseline.view, final.view);
  if (
    difference.added_count +
      difference.removed_count +
      difference.changed_count ===
    0
  )
    // Views that hold only part of their file can match while the rest changed.
    return difference.complete ? undefined : { kind: "content" };
  if (final.format !== "text") return difference;
  // The diff lists text lines as a multiset; the draft lists each line once.
  return {
    ...difference,
    added: [...new Set(difference.added)],
    removed: [...new Set(difference.removed)],
    line_counts: lineCounts(baseline, final).slice(0, 100),
  };
};

/** One changed file an author writes checks about. */
export interface TaskDraftFile {
  readonly file: string;
  readonly role: DesktopStatePath["role"];
  readonly baseline: ReturnType<typeof draftVersion>;
  readonly final: ReturnType<typeof draftVersion>;
  readonly change: NonNullable<ReturnType<typeof netChange>>;
  readonly suggested: readonly Suggestion[];
}

/** Each file `include` takes whose state differs between its versions at the seed and end checkpoints, by home path. */
export const changedStateFiles = (
  files: ReadonlyMap<string, DesktopStatePath>,
  ends: StateEnds,
  include: (home: string) => boolean = () => true,
) =>
  [...files]
    .filter(([home]) => include(home))
    .flatMap(([home, path]) => {
      const baseline = versionAt(path, ends.seed);
      const final = versionAt(path, ends.end);
      const change =
        baseline === undefined || final === undefined
          ? undefined
          : netChange(baseline, final);
      return change === undefined ||
        baseline === undefined ||
        final === undefined
        ? []
        : [{ home, path, baseline, final, change }];
    })
    .sort((left, right) => (left.home < right.home ? -1 : 1));

/**
 * Each file under the owned paths whose state differs between its versions at
 * the seed and end checkpoints, with suggested checks for the files the user
 * worked on: documents, or the app's own state when no document changed.
 */
export const draftTaskFiles = (
  files: ReadonlyMap<string, DesktopStatePath>,
  served: (home: string) => boolean,
  ends: StateEnds,
): readonly TaskDraftFile[] => {
  const changed = changedStateFiles(files, ends, served);
  const role = changed.some(({ path }) => path.role === "document")
    ? "document"
    : "application_state";
  return changed.map(({ home, path, baseline, final, change }) => ({
    file: home,
    role: path.role,
    baseline: draftVersion(baseline, path.role === role),
    final: draftVersion(final, path.role === role),
    change,
    suggested: path.role === role ? suggestedChecks(home, baseline, final) : [],
  }));
};
