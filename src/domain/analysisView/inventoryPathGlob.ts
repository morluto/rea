import { z } from "zod";

/**
 * Whole-path glob over recorded inventory logical paths. `*` and `?` stay
 * within one segment; a `**` segment spans zero or more segments, or at the
 * end every path below. Other characters are literal and case-sensitive.
 */
export const inventoryPathGlobSchema = z
  .string()
  .min(1)
  .refine(
    (glob) =>
      glob
        .split("/")
        .every(
          (segment) =>
            segment !== "" && (segment === "**" || !segment.includes("**")),
        ),
    "Expected a relative glob without empty segments; ** must be a whole segment",
  );

/**
 * Match one segment with `*` and `?` over code points. The single retry
 * point bounds work to pattern length times segment length.
 */
const matchSegment = (
  pattern: readonly string[],
  text: readonly string[],
): boolean => {
  let at = 0;
  let cursor = 0;
  let star = -1;
  let resume = 0;
  while (cursor < text.length) {
    const token = pattern[at];
    if (token === "*") {
      star = at++;
      resume = cursor;
    } else if (
      token !== undefined &&
      (token === "?" || token === text[cursor])
    ) {
      at++;
      cursor++;
    } else if (star >= 0) {
      at = star + 1;
      cursor = ++resume;
    } else return false;
  }
  while (pattern[at] === "*") at++;
  return at === pattern.length;
};

/** Compile a parsed glob to a matcher whose work is polynomial in its inputs. */
export const compileInventoryPathGlob = (
  glob: string,
): ((path: string) => boolean) => {
  const segments = glob
    .split("/")
    .map((segment): "**" | readonly string[] =>
      segment === "**" ? segment : Array.from(segment),
    );
  return (path) => {
    const parts = path.split("/").map((part) => Array.from(part));
    // reached[j]: the glob segments so far match the first j path segments.
    let reached = parts.map(() => false).concat(false);
    reached[0] = true;
    for (const [index, segment] of segments.entries()) {
      const next = reached.map(() => false);
      if (segment === "**") {
        // Zero or more segments, except at the end, where it needs one.
        const minimum = index === segments.length - 1 ? 1 : 0;
        const earliest = reached.indexOf(true);
        if (earliest < 0) return false;
        for (let end = earliest + minimum; end <= parts.length; end++)
          next[end] = true;
      } else
        for (let end = 1; end <= parts.length; end++)
          next[end] =
            reached[end - 1]! && matchSegment(segment, parts[end - 1]!);
      reached = next;
    }
    return reached[parts.length]!;
  };
};
