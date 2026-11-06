import type { DesktopTaskCheckInput } from "./appTask.js";
import { isVolatileValue } from "./appTaskDraftNoise.js";
import type { FileNote } from "./appTaskDraftFileNotes.js";

/** Lines a text file's guard names, and how far from the added line it looks for them. */
const MAX_GUARD_LINES = 2;
const NEIGHBOURHOOD = 6;

/** A list item's marker, as Zim's `[ ]` checkbox, a `*` bullet or `1.`; undefined for a line that is no list item. */
const markerOf = (line: string): string | undefined =>
  /^\s*(?<marker>\[[ xX*>]?\]|[-*+•]|\d+[.)])\s/u.exec(line)?.groups?.marker;

/**
 * A `lines_present` guard of a text file's unchanged lines beside the first
 * line an edit added, for an author to add by choice: the list items next to
 * it with the same marker, as the other `[ ]` action items around a new one,
 * nearest first and kept in file order; or, when it is no list item or has no
 * such sibling, the nearest lines with words in them. Each is a line the
 * seed and the end both hold. None when nothing was added.
 */
export const lineGuards = (
  file: string,
  before: readonly string[],
  after: readonly string[],
): DesktopTaskCheckInput[] => {
  const seed = new Set(before);
  const at = after.findIndex((line) => !seed.has(line));
  const added = after[at];
  if (added === undefined) return [];
  const near = after
    .map((line, index) => ({ line, index }))
    .filter(
      ({ line, index }) =>
        index !== at &&
        Math.abs(index - at) <= NEIGHBOURHOOD &&
        seed.has(line) &&
        /[\p{L}\d]/u.test(line) &&
        // A lone closing tag, as `</node>`, is in any such file.
        !/^\s*<\/[^>]*>\s*$/u.test(line),
    )
    .toSorted(
      (left, right) =>
        Math.abs(left.index - at) - Math.abs(right.index - at) ||
        left.index - right.index,
    );
  const marker = markerOf(added);
  const siblings = near.filter(
    ({ line }) => marker !== undefined && markerOf(line) === marker,
  );
  const lines = [
    ...new Set(
      (siblings.length > 0 ? siblings : near)
        .slice(0, MAX_GUARD_LINES)
        .toSorted((left, right) => left.index - right.index)
        .map(({ line }) => line),
    ),
  ];
  return lines.length === 0 ? [] : [{ kind: "lines_present", file, lines }];
};

/** A run of letters, digits, `_` and `-`, a token a line may hold. */
const TOKEN = /[\p{L}\d_-]+/gu;

/** Where a line's first value the app generates starts: a UUID, an epoch time, or an id such as Freeplane's `ID_329023692`; -1 when it holds none. */
const volatileAt = (line: string): number => {
  for (const { 0: token, index } of line.matchAll(TOKEN))
    if (isVolatileValue(token) || /^\p{L}+_\d{6,}$/u.test(token)) return index;
  return -1;
};

/**
 * Checks of the lines a text file gained: a `lines_present` of those whole,
 * and, for a line holding a value the app generates, as a Freeplane map's
 * `ID="ID_329023692" CREATED="1793955250671"`, which a later save of the same
 * edit would not repeat, a `line_count` of the lines holding its text up to
 * that value, as `<node TEXT="Water filter" ID="`, at the end's number,
 * where that number changed; a note on a line no such text names.
 */
export const addedLineChecks = (
  file: string,
  lines: {
    readonly before: readonly string[];
    readonly after: readonly string[];
  },
  added: readonly string[],
): { readonly checks: DesktopTaskCheckInput[]; readonly notes: FileNote[] } => {
  const holding = (all: readonly string[], text: string) =>
    all.filter((line) => line.includes(text)).length;
  const whole = added.filter((line) => volatileAt(line) < 0);
  const prefixes = new Set<string>();
  let unnamed = 0;
  for (const line of added.filter((text) => volatileAt(text) >= 0)) {
    const prefix = line.slice(0, volatileAt(line)).trimStart();
    const equals = holding(lines.after, prefix);
    if (
      prefix.trim().length >= 3 &&
      /\p{L}/u.test(prefix) &&
      equals !== holding(lines.before, prefix)
    )
      prefixes.add(prefix);
    else unnamed += 1;
  }
  return {
    checks: [
      ...(whole.length > 0
        ? [{ kind: "lines_present" as const, file, lines: whole }]
        : []),
      ...[...prefixes].map((contains) => ({
        kind: "line_count" as const,
        file,
        contains,
        equals: holding(lines.after, contains),
      })),
    ],
    notes:
      unnamed === 0
        ? []
        : [
            {
              code: "volatile_lines",
              file,
              message: `${String(unnamed)} line(s) ~/${file} gained hold a value the app generates, an id or a time, and no text before it tells them apart, so no check of them is suggested: check what the line says with line_count and contains.`,
            },
          ],
  };
};
