import type { DesktopTaskCheckInput } from "./appTask.js";

/** The shortest added text a check looks for: shorter text is too likely to be found elsewhere. */
const MIN_ADDED_CHARS = 3;
/** Guards of the lines an addition kept. Each line stands alone, so an insertion elsewhere still passes. */
const MAX_KEPT_GUARDS = 8;

/** Whether a character starts or ends a line: none, or a line break. */
const edge = (character: string | undefined) =>
  character === undefined || character === "\n" || character === "\r";

/**
 * How a text grew by lines inserted whole that kept the rest of it, as a note
 * gains a line: the text before and after the insertion point and the
 * inserted text, or undefined when the text changed otherwise or the
 * insertion starts or ends inside a line, as `Meeting at ` growing to
 * `Meeting at 3:30` does, where a check of the whole text also fails `13:30`.
 */
const insertionOf = (before: string, after: string) => {
  const length = after.length - before.length;
  if (length <= 0) return undefined;
  let same = 0;
  while (same < before.length && before[same] === after[same]) same += 1;
  let tail = 0;
  while (
    tail < before.length &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail += 1;
  // Every point from the first the shared tail allows to the last the shared head does inserts the same text; take the last at a line's edges.
  for (let at = same; at >= before.length - tail; at -= 1) {
    const inserted = after.slice(at, at + length);
    if (
      (edge(after[at - 1]) || edge(inserted[0])) &&
      (edge(after[at + length]) || edge(inserted.at(-1)))
    )
      return { head: before.slice(0, at), inserted, tail: before.slice(at) };
  }
  return undefined;
};

/**
 * For an element whose text grew by lines, as a note gains `olive oil` on a
 * line of its own: a `text_contains` of the added text, so another
 * correct edit, with a blank line after it or the line elsewhere, still
 * passes; and guards that the text it kept is still there, whole when the
 * addition went before or after it, otherwise each side of it. Undefined
 * when the seed text was empty, or the text changed otherwise, or the added
 * text is short or found in the seed text already, where a check of the
 * whole text says more.
 */
export const addedTextChecks = (
  file: string,
  pointer: string,
  before: string,
  after: string,
):
  | {
      readonly check: DesktopTaskCheckInput;
      readonly guards: readonly DesktopTaskCheckInput[];
    }
  | undefined => {
  if (before.trim() === "") return undefined;
  const grown = insertionOf(before, after);
  const added = grown?.inserted.trim() ?? "";
  if (
    grown === undefined ||
    added.length < MIN_ADDED_CHARS ||
    !/[\p{L}\d]/u.test(added) ||
    before.includes(added)
  )
    return undefined;
  const kept = [
    ...new Set(
      before
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length >= MIN_ADDED_CHARS),
    ),
  ].slice(0, MAX_KEPT_GUARDS);
  return {
    check: { kind: "text_contains", file, pointer, value: added },
    guards: kept.map((value) => ({
      kind: "text_contains",
      file,
      pointer,
      value,
    })),
  };
};
