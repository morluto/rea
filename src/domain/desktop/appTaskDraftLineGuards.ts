import type { DesktopTaskCheckInput } from "./appTask.js";

/** Lines a text file's guard names, and how far from the added line it looks for them. */
const MAX_GUARD_LINES = 2;
const NEIGHBOURHOOD = 6;
/** A guard line longer than this is not copied into the task. */
const MAX_GUARD_TEXT = 2000;

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
        line.length <= MAX_GUARD_TEXT &&
        /[\p{L}\d]/u.test(line),
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
