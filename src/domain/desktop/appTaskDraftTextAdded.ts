import type { DesktopTaskCheckInput } from "./appTask.js";
import { isStamp } from "./appTaskDraftNoise.js";

/** The shortest added text a check looks for: shorter text is too likely to be found elsewhere. */
const MIN_ADDED_CHARS = 3;
/** Guards of the lines an addition kept, as many as a file's draft offers. */
const MAX_KEPT_GUARDS = 4;

/**
 * The lines an addition kept that a guard looks for, one each: distinct
 * lines of three or more characters with a letter or digit in them, nearest
 * the insertion first, at most four, in text order, so a correct edit that
 * puts the new line elsewhere among them still passes every one.
 */
const keptLines = (head: string, tail: string): string[] => {
  const lines = (text: string) =>
    text.split(/\r?\n/u).filter((line) => line.trim() !== "");
  const above = lines(head).toReversed();
  const below = lines(tail);
  const near = Array.from(
    { length: Math.max(above.length, below.length) },
    (_, index) => [
      { line: above[index], order: -index },
      { line: below[index], order: index + 1 },
    ],
  ).flat();
  const seen = new Set<string>();
  return near
    .flatMap(({ line, order }) => {
      const kept = line?.trim() ?? "";
      if (
        kept.length < MIN_ADDED_CHARS ||
        !/[\p{L}\d]/u.test(kept) ||
        isStamp(kept) ||
        seen.has(kept)
      )
        return [];
      seen.add(kept);
      return [{ kept, order }];
    })
    .slice(0, MAX_KEPT_GUARDS)
    .toSorted((left, right) => left.order - right.order)
    .map(({ kept }) => kept);
};

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
 * passes; and guards that the lines it kept are still there, one per line
 * (`keptLines`), so a correct edit that inserts the line mid-list passes
 * them too. Undefined
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
  return {
    check: { kind: "text_contains", file, pointer, value: added },
    guards: keptLines(grown.head, grown.tail).map((value) => ({
      kind: "text_contains",
      file,
      pointer,
      value,
    })),
  };
};
