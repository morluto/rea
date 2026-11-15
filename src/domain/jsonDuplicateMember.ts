/** A member name that occurs more than once in one JSON object. */
export interface JsonDuplicateMember {
  readonly name: string;
  /** UTF-16 offset of the repeated name's opening quote. */
  readonly offset: number;
}

/** A checked allowance that bounds the scan's retained state before allocation. */
export interface JsonDuplicateScanLimits {
  /** Maximum simultaneously open containers (nesting depth) the scan retains. */
  readonly maxDepth: number;
  /** Maximum member names retained across all currently open objects. */
  readonly maxRetainedNames: number;
}

/** The bounded scan's outcome: a duplicate, a clean document, or an exhausted allowance. */
export interface JsonDuplicateScanResult {
  /** The first duplicate member found, or undefined when none was. */
  readonly member?: JsonDuplicateMember;
  /** True when a bounded scan stopped at its depth or retained-name allowance. */
  readonly limitReached: boolean;
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;

/**
 * Scan JSON text for the first repeated object member. The text must already be
 * valid JSON; the walk is iterative, so nesting depth is bounded by memory
 * rather than the call stack. When `limits` is given, the scan retains at most
 * `maxDepth` open containers and `maxRetainedNames` live names and stops with
 * `limitReached` once either would be exceeded — so representation growth is
 * checked before allocation rather than scaling with the document.
 */
const scan = (
  text: string,
  limits?: JsonDuplicateScanLimits,
): JsonDuplicateScanResult => {
  // One entry per open container: the names seen so far for an object, or null
  // for an array. `expectName` marks the next string as a member name.
  const open: (Set<string> | null)[] = [];
  let expectName = false;
  let retainedNames = 0;
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
      if (names.has(name))
        return { member: { name, offset: start }, limitReached: false };
      names.add(name);
      retainedNames++;
      if (limits !== undefined && retainedNames > limits.maxRetainedNames)
        return { limitReached: true };
      continue;
    }
    switch (text[index]) {
      case "{":
        open.push(new Set());
        expectName = true;
        if (limits !== undefined && open.length > limits.maxDepth)
          return { limitReached: true };
        break;
      case "[":
        open.push(null);
        if (limits !== undefined && open.length > limits.maxDepth)
          return { limitReached: true };
        break;
      case "}":
      case "]": {
        const closed = open.pop();
        // Names in a closed object are no longer retained, so free them from the
        // live count that the allowance bounds.
        if (closed instanceof Set) retainedNames -= closed.size;
        expectName = false;
        break;
      }
      case ",":
        expectName = open.at(-1) instanceof Set;
        break;
    }
  }
  return { limitReached: false };
};

/**
 * Find the first object member name that repeats within its object.
 *
 * `JSON.parse` keeps only the last value for a repeated name, so callers that
 * must not lose a declaration check the source text with this. The scan is
 * unbounded; callers over untrusted, size-bounded input should prefer
 * {@link findDuplicateJsonMemberBounded}.
 */
export const findDuplicateJsonMember = (
  text: string,
): JsonDuplicateMember | undefined => scan(text).member;

/**
 * Find the first repeated member, bounding the scan's retained state to the
 * supplied allowance and reporting when that allowance stops the scan.
 */
export const findDuplicateJsonMemberBounded = (
  text: string,
  limits: JsonDuplicateScanLimits,
): JsonDuplicateScanResult => scan(text, limits);
