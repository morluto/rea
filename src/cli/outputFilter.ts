/**
 * The `--filter-output` path grammar: comma-separated paths of dot-separated
 * keys, each optionally followed by a `[start,end]` array slice, such as
 * `foo,bar.baz,a[0,3].name`. Commas inside brackets belong to the slice.
 * Projection of a result through these paths is owned by the CLI result
 * writer and the JSON Lines selector.
 */
import { err, ok, type Result } from "../domain/result.js";

/** One step of a filter path: an object key or an array slice. */
export type OutputFilterSegment =
  | { readonly key: string }
  | { readonly start: number; readonly end: number };

export type OutputFilterPath = readonly OutputFilterSegment[];

/** A `[` with no later `]` in its path: the slice has no end. */
export interface UnclosedOutputFilterSlice {
  readonly kind: "unclosed_slice";
}

/** Split on commas outside `[...]`; an empty last path is dropped. */
const splitPaths = (expression: string): string[] => {
  const paths: string[] = [];
  let current = "";
  let depth = 0;
  for (const character of expression) {
    if (character === "[") depth += 1;
    else if (character === "]") depth -= 1;
    if (character === "," && depth === 0) {
      paths.push(current);
      current = "";
    } else current += character;
  }
  if (current !== "") paths.push(current);
  return paths;
};

const keySegments = (text: string): OutputFilterSegment[] =>
  text
    .split(".")
    .filter((key) => key !== "")
    .map((key) => ({ key }));

const parsePath = (
  text: string,
): Result<OutputFilterSegment[], UnclosedOutputFilterSlice> => {
  const segments: OutputFilterSegment[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    const open = remaining.indexOf("[");
    if (open === -1) {
      segments.push(...keySegments(remaining));
      break;
    }
    const close = remaining.indexOf("]", open);
    if (close === -1) return err({ kind: "unclosed_slice" });
    segments.push(...keySegments(remaining.slice(0, open)));
    const [start, end] = remaining.slice(open + 1, close).split(",");
    segments.push({ start: Number(start), end: Number(end) });
    remaining = remaining.slice(close + 1);
    if (remaining.startsWith(".")) remaining = remaining.slice(1);
  }
  return ok(segments);
};

/** Parse a `--filter-output` expression into its paths. */
export const parseOutputFilter = (
  expression: string,
): Result<OutputFilterPath[], UnclosedOutputFilterSlice> => {
  const paths: OutputFilterPath[] = [];
  for (const text of splitPaths(expression)) {
    const path = parsePath(text);
    if (!path.ok) return path;
    paths.push(path.value);
  }
  return ok(paths);
};
