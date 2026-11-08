import type { JsonValue } from "../jsonValue.js";
import { leftOutFiles } from "./appExportUnowned.js";
import { isTimestamp, type DesktopTaskCheckInput } from "./appTask.js";
import { fileNotes, type FileNote } from "./appTaskDraftFileNotes.js";
import { lineGuards } from "./appTaskDraftLineGuards.js";
import {
  ARCHIVE,
  innermost,
  namedDraft,
  presenceValues,
  XML_FILE,
  type NamedFacts,
} from "./appTaskDraftNamed.js";
import { rowSuggestions } from "./appTaskDraftRows.js";
import {
  draftValues,
  oneEnd,
  withinDraftBudget,
  type DraftValue,
} from "./appTaskDraftValues.js";
import {
  versionAt,
  type DesktopStatePath,
  type StateEnds,
} from "./desktopState.js";
import { diffNamedMembers, diffStateViews } from "./stateChanges.js";
import { escapeToken, resolvePointer } from "./viewPointer.js";

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

/** A file's draft: its suggested checks, the values its change holds, guards, and the facts its notes rest on. */
interface FileDraft {
  readonly suggested: readonly Suggestion[];
  readonly values: readonly DraftValue[];
  readonly valuesCut: boolean;
  readonly guards: readonly Suggestion[];
  readonly facts?: NamedFacts;
}

const NO_VALUES = { values: [], valuesCut: false, guards: [] } as const;

/** A JSON or key file's change at pointers into its view, an absent end's view null; a key file's diff names `group/key`. */
const plainChange = (
  format: "json" | "keyfile",
  baseline: Version,
  final: Version,
) => {
  if (format === "json") return diffNamedMembers(baseline.view, final.view);
  const change = diffStateViews(format, baseline.view, final.view);
  const pointers = keyPointers([baseline.view, final.view]);
  const at = (entries: readonly string[]) =>
    entries.flatMap((entry) => pointers.get(entry) ?? []);
  return {
    ...change,
    added: at(change.added),
    changed: at(change.changed),
    removed: at(change.removed),
  };
};

/** The values a JSON or key file's change holds; every pointer is the document's, and none is noise. */
const plainValues = (
  change: ReturnType<typeof plainChange>,
  baseline: Version,
  final: Version,
) =>
  draftValues(change, {
    ends: versions(baseline, final),
    listed: () => true,
    noise: () => undefined,
    format: () => "json",
    referenceRoots: () => [],
  });

/**
 * The values of a file created or deleted, apart from the check of its
 * presence: what its one end holds, added or removed, in an XML file,
 * archive, JSON or key file, within the limits a changed file's have.
 */
const presenceOnly = (
  baseline: Version,
  final: Version,
): Pick<FileDraft, "values" | "valuesCut"> => {
  const created = !baseline.present;
  const format = (created ? final : baseline).format;
  const listed =
    format === "zip" || format === "xml"
      ? presenceValues(
          versions(baseline, final),
          format === "zip" ? ARCHIVE : XML_FILE,
          created,
        )
      : format === "json" || format === "keyfile"
        ? plainValues(
            oneEnd(plainChange(format, baseline, final), created),
            baseline,
            final,
          )
        : { values: [], cut: false };
  return { values: listed.values, valuesCut: listed.cut };
};

const valueSuggestions = (
  file: string,
  baseline: Version,
  final: Version,
  document: boolean,
): FileDraft => {
  const format = final.format;
  if (format === "zip" || format === "xml") {
    return namedDraft(
      file,
      versions(baseline, final),
      format === "zip" ? ARCHIVE : XML_FILE,
      { limit: LIMIT, document },
    );
  }
  if (format !== "json" && format !== "keyfile")
    return { suggested: [], ...NO_VALUES };
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
  const { values, cut } = plainValues(
    plainChange(format, baseline, final),
    baseline,
    final,
  );
  return { suggested: suggestions, values, valuesCut: cut, guards: [] };
};

/** Checks that express how a file changed from its baseline to its final version, with the values, guards and facts beside them. */
const suggestedChecks = (
  file: string,
  baseline: Version,
  final: Version,
  document: boolean,
): FileDraft => {
  if (!final.present)
    return {
      suggested: [{ kind: "file_absent", file }],
      ...NO_VALUES,
      ...presenceOnly(baseline, final),
    };
  const created: Suggestion[] = baseline.present
    ? []
    : [{ kind: "file_present", file }];
  const content: FileDraft =
    final.format === "text"
      ? {
          ...NO_VALUES,
          suggested: textSuggestions(file, baseline, final),
          guards: baseline.present
            ? lineGuards(file, linesOf(baseline), linesOf(final))
            : [],
        }
      : !baseline.present
        ? { suggested: [], ...NO_VALUES, ...presenceOnly(baseline, final) }
        : final.format === "sqlite"
          ? { suggested: rowSuggestions(file, baseline, final), ...NO_VALUES }
          : valueSuggestions(file, baseline, final, document);
  return {
    ...content,
    suggested: [...created, ...content.suggested].slice(0, MAX_SUGGESTIONS),
  };
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
  // XML members are listed by the selectors naming them, as checks name them.
  const difference = diffStateViews(final.format, baseline.view, final.view, {
    named: true,
  });
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
  /** The values the change added, changed and removed, at the pointers a check names them by. */
  readonly values: readonly DraftValue[];
  /** Whether a limit left values out. */
  readonly values_cut: boolean;
  /** Checks that the rest stays as it was, for an author to add by choice. */
  readonly guards: readonly Suggestion[];
  /** Why the file's suggestions are thin, when they are. */
  readonly notes: readonly FileNote[];
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

/** The format a change's file has at its end, for its notes. */
const changeShape = (change: TaskDraftFile["change"], final: Version) => ({
  kind: "kind" in change ? change.kind : "values",
  complete: "complete" in change ? change.complete : undefined,
  format: final.format,
});

/**
 * Each file under the owned paths whose state differs between its versions at
 * the seed and end checkpoints, with suggested checks, values, guards and
 * notes for the files the user worked on: documents, or the app's own state
 * when no document changed. Values stay within the draft's byte budget, in
 * file order.
 */
export const draftTaskFiles = (
  files: ReadonlyMap<string, DesktopStatePath>,
  served: (home: string) => boolean,
  ends: StateEnds,
  /** Home paths the export selected exactly, as `exportedStateFiles` spells them. */
  selected: readonly string[] = [],
): readonly TaskDraftFile[] => {
  const changed = changedStateFiles(files, ends, served);
  const { isLeftOut } = leftOutFiles(files, [], selected, selected);
  // A lock the seed leaves out is not the document the user worked on.
  const considered = changed.filter(
    ({ home, path }) => !(path.role === "document" && isLeftOut(home)),
  );
  const role = considered.some(({ path }) => path.role === "document")
    ? "document"
    : "application_state";
  return withinDraftBudget(
    changed.map(({ home, path, baseline, final, change }) => {
      const drafted = path.role === role;
      const draft: FileDraft = drafted
        ? suggestedChecks(home, baseline, final, role === "document")
        : { suggested: [], ...NO_VALUES };
      return {
        file: home,
        role: path.role,
        baseline: draftVersion(baseline, drafted),
        final: draftVersion(final, drafted),
        change,
        suggested: draft.suggested,
        values: draft.values,
        values_cut: draft.valuesCut,
        guards: draft.guards,
        notes: drafted
          ? fileNotes(home, changeShape(change, final), draft.facts)
          : [],
      };
    }),
  );
};
