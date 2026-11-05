import type { JsonValue } from "../jsonValue.js";
import { isTimestamp, type DesktopTaskCheckInput } from "./appTask.js";
import {
  versionAt,
  type DesktopStatePath,
  type StateEnds,
} from "./desktopState.js";
import { diffStateViews, diffZipMembers } from "./stateChanges.js";
import { locatePointer, pairMembers, resolvePointer } from "./viewPointer.js";
import { entryWithoutView, zipArrayLeavesOut, zipEntryAt } from "./zipView.js";

type Version = DesktopStatePath["versions"][number];
type Suggestion = DesktopTaskCheckInput;

/** Suggestions per file; an author picks among them. */
const MAX_SUGGESTIONS = 10;
const MAX_ITEMS = 200;
const MAX_CHARS = 2000;

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

const escapeToken = (token: string) =>
  token.replaceAll("~", "~0").replaceAll("/", "~1");

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

/** Pointers without a listed descendant: a container listed with its members is suggested through them. */
const innermost = (pointers: readonly string[]): readonly string[] =>
  pointers.filter(
    (pointer) => !pointers.some((other) => other.startsWith(`${pointer}/`)),
  );

/**
 * The entry a pointer into a zip view goes into, when it has a view and both
 * evaluators read it alike: JSON, a key file or XML. A binary or unread
 * entry also holds a `null` view, which is no JSON `null`.
 */
const readableEntry = (view: JsonValue | null, pointer: string) => {
  const entry = zipEntryAt(view, pointer);
  return typeof entry === "object" &&
    entryWithoutView(entry) === undefined &&
    (entry.format === "json" ||
      entry.format === "keyfile" ||
      entry.format === "xml")
    ? entry
    : undefined;
};

/**
 * Where checks for a pointer the diff lists start: the view of an entry it
 * names whole, or its root element for XML; the pointer itself inside that;
 * undefined for an entry neither evaluator reads alike, or the entry's fields.
 */
const checkRoot = (
  view: JsonValue | null,
  pointer: string,
): string | undefined => {
  const entry = readableEntry(view, pointer);
  const [entryPointer] = /^\/entries\/[^/]+/u.exec(pointer) ?? [];
  if (entry === undefined || entryPointer === undefined) return undefined;
  const inner = pointer.slice(entryPointer.length).split("/").slice(1);
  const root = entry.format === "xml" ? ["view", "root"] : ["view"];
  const prefix = (short: readonly string[], long: readonly string[]) =>
    short.length <= long.length &&
    short.every((part, index) => long[index] === part);
  if (prefix(inner, root)) return `${entryPointer}/${root.join("/")}`;
  return prefix(root, inner) ? pointer : undefined;
};

/** Whether a check at a pointer is decided by name: no object or array reached by position, no array searched that the view may cut. */
const byName = (view: JsonValue | null, pointer: string) => {
  const located = locatePointer(view, pointer);
  return (
    located.kind !== "unresolved" &&
    located.byPosition.length === 0 &&
    !located.searched.some((array) => zipArrayLeavesOut(view, array))
  );
};

/** An element of REA's XML view, by its tag name, or undefined for any other value. */
const elementName = (value: JsonValue | undefined): string | undefined =>
  isRecord(value) &&
  typeof value.name === "string" &&
  isRecord(value.attributes) &&
  Array.isArray(value.children)
    ? value.name
    : undefined;

/**
 * Checks on the entries of an archive, by the selectors its diff names
 * members with: elements added or removed whole first, as the likeliest
 * record of what the user did, then values changed, added and removed. A
 * JSON value or an entry added whole is checked through its members.
 */
const zipSuggestions = (
  file: string,
  baseline: Version,
  final: Version,
): Suggestion[] => {
  const change = diffZipMembers(baseline.view, final.view);
  const elements: Suggestion[] = [];
  const values: Suggestion[] = [];
  const equals = (pointer: string, value: JsonValue | undefined) => {
    if (
      values.length < MAX_SUGGESTIONS &&
      value !== undefined &&
      !(isRecord(value) && Object.keys(value).length > 0) &&
      !isTimestamp(value) &&
      byName(final.view, pointer)
    )
      values.push({ kind: "value_equals", file, pointer, value });
  };
  const added = (pointer: string, value: JsonValue | undefined): void => {
    if (elements.length >= MAX_SUGGESTIONS && values.length >= MAX_SUGGESTIONS)
      return;
    const name = elementName(value);
    if (name !== undefined) {
      if (
        elements.length < MAX_SUGGESTIONS &&
        byName(final.view, `${pointer}/name`)
      )
        elements.push({
          kind: "value_equals",
          file,
          pointer: `${pointer}/name`,
          value: name,
        });
    } else if (Array.isArray(value) && value.length > 0) {
      const { keys } = pairMembers(value, []).newer;
      value.forEach((item, index) =>
        added(`${pointer}/${escapeToken(keys[index] ?? String(index))}`, item),
      );
    } else if (isRecord(value) && Object.keys(value).length > 0)
      for (const [key, item] of Object.entries(value))
        added(`${pointer}/${escapeToken(key)}`, item);
    // A scalar, or an empty array or object, is checked as it is.
    else equals(pointer, value);
  };
  for (const pointer of change.added) {
    const root = checkRoot(final.view, pointer);
    if (root !== undefined) added(root, resolvePointer(final.view, root));
  }
  for (const pointer of innermost(change.changed))
    if (checkRoot(final.view, pointer) === pointer)
      equals(pointer, resolvePointer(final.view, pointer));
  // An absence is checked only where the entry still has a view to lack it in.
  for (const pointer of change.removed)
    if (
      checkRoot(baseline.view, pointer) === pointer &&
      checkRoot(final.view, pointer) === pointer &&
      byName(baseline.view, pointer) &&
      byName(final.view, pointer)
    )
      (elementName(resolvePointer(baseline.view, pointer)) === undefined
        ? values
        : elements
      ).push({ kind: "value_absent", file, pointer });
  return [...elements, ...values];
};

const valueSuggestions = (
  file: string,
  baseline: Version,
  final: Version,
): Suggestion[] => {
  const format = final.format;
  if (format === "zip") return zipSuggestions(file, baseline, final);
  if (format !== "json" && format !== "xml" && format !== "keyfile") return [];
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
  const changed = [...files]
    .filter(([home]) => served(home))
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
