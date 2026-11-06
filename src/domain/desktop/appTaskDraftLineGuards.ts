import type { DesktopTaskCheckInput } from "./appTask.js";
import { isVolatileValue } from "./appTaskDraftNoise.js";
import type { FileNote } from "./appTaskDraftFileNotes.js";

/** Lines a text file's guard names, and how far from the added line it looks for them when it has no like sibling. */
const MAX_GUARD_LINES = 2;
const NEIGHBOURHOOD = 6;

/** A list item's marker, as Zim's `[ ]` checkbox, a `*` bullet or `1.`; undefined for a line that is no list item. */
const markerOf = (line: string): string | undefined =>
  /^\s*(?<marker>\[[ xX*>]?\]|[-*+•]|\d+[.)])\s/u.exec(line)?.groups?.marker;

/** Whether a line is a command, as LyX's `\begin_layout Section` or `\end_layout`. */
const isCommand = (line: string) => /^\s*\\[\p{L}_]+\b/u.test(line);

/** Whether a line is only markup: a command, or a lone closing tag, as `</node>`. */
const isMarkup = (line: string) =>
  isCommand(line) || /^\s*<\/[^>]*>\s*$/u.test(line);

/** What kind of line a line is, for its like siblings: a list item's marker, or the command opening it, as `\begin_layout Section` opens a LyX heading. */
const kindOf = (lines: readonly string[], index: number) => {
  const marker = markerOf(lines[index] ?? "");
  const opener = lines[index - 1];
  return marker === undefined
    ? opener !== undefined && isCommand(opener)
      ? `opens\u0000${opener.trim()}`
      : undefined
    : `marker\u0000${marker}`;
};

/** How many times each line occurs. */
const tally = (lines: readonly string[]) => {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
};

/**
 * A `lines_present` guard of a text file's unchanged lines beside the first
 * line an edit added, for an author to add by choice: the nearest lines of
 * its kind (`kindOf`), as the other `[ ]` action items around a new one or
 * the other headings a LyX command opens, kept in file order; or, when it
 * has no such sibling, the nearest lines with words in them. Each is text
 * the seed and the end both hold once: never a line of markup alone, nor one
 * that repeats, as LyX's `\end_layout`. None when nothing was added.
 */
export const lineGuards = (
  file: string,
  before: readonly string[],
  after: readonly string[],
): DesktopTaskCheckInput[] => {
  const [seed, end] = [tally(before), tally(after)];
  const at = after.findIndex((line) => !seed.has(line));
  if (at < 0) return [];
  const kind = kindOf(after, at);
  const kept = after
    .map((line, index) => ({ line, index }))
    .filter(
      ({ line, index }) =>
        index !== at &&
        seed.get(line) === 1 &&
        end.get(line) === 1 &&
        /[\p{L}\d]/u.test(line) &&
        !isMarkup(line),
    )
    .toSorted(
      (left, right) =>
        Math.abs(left.index - at) - Math.abs(right.index - at) ||
        left.index - right.index,
    );
  const siblings = kept.filter(
    ({ index }) => kind !== undefined && kindOf(after, index) === kind,
  );
  const near = kept.filter(
    ({ index }) => Math.abs(index - at) <= NEIGHBOURHOOD,
  );
  const lines = (siblings.length > 0 ? siblings : near)
    .slice(0, MAX_GUARD_LINES)
    .toSorted((left, right) => left.index - right.index)
    .map(({ line }) => line);
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
 * where that number changed and both views hold the whole file (`counted`);
 * a note on a line no such text names.
 */
export const addedLineChecks = (
  file: string,
  lines: {
    readonly before: readonly string[];
    readonly after: readonly string[];
  },
  {
    added,
    counted,
  }: { readonly added: readonly string[]; readonly counted: boolean },
): { readonly checks: DesktopTaskCheckInput[]; readonly notes: FileNote[] } => {
  const holding = (all: readonly string[], text: string) =>
    all.filter((line) => line.includes(text)).length;
  const whole = added.filter((line) => volatileAt(line) < 0);
  const prefixes = new Set<string>();
  let unnamed = 0;
  for (const line of added.filter((text) => counted && volatileAt(text) >= 0)) {
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
