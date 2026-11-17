/**
 * What a JSON parser in `src/` does when an object declares the same member
 * name more than once:
 *
 * - `reject`: refuse the input as malformed when any object repeats a member
 *   name (`findDuplicateJsonMember`).
 * - `last-wins`: keep `JSON.parse`'s last value for a repeated name, when a
 *   format or protocol specifies last-value precedence or when an upstream tool
 *   already deduplicated or emitted the JSON object.
 */
export type JsonDuplicateMemberPolicy = "reject" | "last-wins";

/** Result of parsing JSON with an explicit duplicate-member policy. */
export type ParsedJsonWithPolicy =
  | {
      readonly ok: true;
      readonly value: unknown;
    }
  | {
      readonly ok: false;
      readonly duplicate: JsonDuplicateMember;
      readonly cause?: undefined;
    }
  | {
      readonly ok: false;
      readonly cause: unknown;
      readonly duplicate?: undefined;
    };

/** A member name that occurs more than once in one JSON object. */
export interface JsonDuplicateMember {
  readonly name: string;
  /** UTF-16 offset of the repeated name's opening quote. */
  readonly offset: number;
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;

/**
 * Decode a JSON string literal (`"..."`). A string literal has no object
 * members, so `JSON.parse` has no duplicate-member ambiguity to resolve.
 */
export const parseJsonStringLiteral = (raw: string): unknown =>
  JSON.parse(raw) as unknown;

/**
 * Parse JSON text under an explicit duplicate-member policy, with an optional
 * `JSON.parse` reviver.
 *
 * When `policy` is `"reject"`, `findDuplicateJsonMember` scans the validated
 * JSON text and attaches the first repeated member name as `duplicate` on the
 * returned result so the caller can raise its format-specific error.
 */
export const parseJsonWithDuplicatePolicy = (
  text: string,
  policy: JsonDuplicateMemberPolicy,
  reviver?: (
    key: string,
    value: unknown,
    context?: { readonly source?: string },
  ) => unknown,
): ParsedJsonWithPolicy => {
  let value: unknown;
  try {
    value = JSON.parse(text, reviver) as unknown;
  } catch (cause: unknown) {
    return { ok: false, cause };
  }
  const duplicate =
    policy === "reject" ? findDuplicateJsonMember(text) : undefined;
  return duplicate === undefined
    ? { ok: true, value }
    : { ok: false, duplicate };
};

/**
 * Parse JSON text whose duplicate-member policy is `"last-wins"`, throwing the
 * native `SyntaxError` on invalid JSON.
 */
export const parseLastWinsJson = (
  text: string,
  reviver?: (
    key: string,
    value: unknown,
    context?: { readonly source?: string },
  ) => unknown,
): unknown => JSON.parse(text, reviver) as unknown;

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
      default:
        break;
    }
  }
  return undefined;
};
