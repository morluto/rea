/** A member name that occurs more than once in one JSON object. */
export interface JsonDuplicateMember {
  readonly name: string;
  /** UTF-16 offset of the repeated name's opening quote. */
  readonly offset: number;
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;

/**
 * Find the first object member name that repeats within its object.
 *
 * `JSON.parse` keeps only the last value for a repeated name, so callers that
 * must not lose a declaration check the source text with this. The text must
 * already be valid JSON; the scan is iterative, so nesting depth is bounded by
 * memory rather than the call stack.
 */
export const findDuplicateJsonMember = (
  text: string,
): JsonDuplicateMember | undefined => {
  // One entry per open container: the names seen so far for an object, or
  // null for an array. `expectName` marks the next string as a member name.
  const open: (Set<string> | null)[] = [];
  let expectName = false;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === QUOTE) {
      const start = index;
      for (index++; text.charCodeAt(index) !== QUOTE; index++)
        if (text.charCodeAt(index) === BACKSLASH) index++;
      if (!expectName) continue;
      expectName = false;
      const names = open.at(-1);
      if (names === null || names === undefined) continue;
      const raw = text.slice(start, index + 1);
      const name = raw.includes("\\")
        ? (JSON.parse(raw) as string)
        : raw.slice(1, -1);
      if (names.has(name)) return { name, offset: start };
      names.add(name);
      continue;
    }
    switch (text[index]) {
      case "{":
        open.push(new Set());
        expectName = true;
        break;
      case "[":
        open.push(null);
        break;
      case "}":
      case "]":
        open.pop();
        expectName = false;
        break;
      case ",":
        expectName = open.at(-1) instanceof Set;
        break;
    }
  }
  return undefined;
};
