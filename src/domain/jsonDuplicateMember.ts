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
      /** First source member of a root object scanned under the reject policy. */
      readonly firstObjectMember?: string;
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
 * Decode a JSON string literal (`"..."`). A string literal has no object
 * members, so `JSON.parse` has no duplicate-member ambiguity to resolve.
 */
export const parseJsonStringLiteral = (raw: string): unknown =>
  JSON.parse(raw) as unknown;

type JsonReviver = (
  key: string,
  value: unknown,
  context?: { readonly source?: string },
) => unknown;

/** Observe decimal or exponent spellings in objects reached through object keys, outside arrays. */
export interface JsonObjectNumberSource {
  readonly name: string;
  readonly read: (
    owner: Record<string, unknown>,
    value: number,
    source: string,
  ) => void;
}

type JsonNumberObservation = JsonObjectNumberSource & {
  readonly root: unknown;
};

/**
 * Parse JSON with an explicit duplicate-member policy and optional reviver.
 * The reject-policy scan preserves the first root object's member name in
 * source order. For a plain decode it can also observe a named number's
 * decimal spelling without enabling JSON.parse's recursive reviver.
 */
export function parseJsonWithDuplicatePolicy(
  text: string,
  policy: JsonDuplicateMemberPolicy,
  reviver?: JsonReviver,
): ParsedJsonWithPolicy;
export function parseJsonWithDuplicatePolicy(
  text: string,
  policy: "reject",
  observation: JsonObjectNumberSource,
): ParsedJsonWithPolicy;
export function parseJsonWithDuplicatePolicy(
  text: string,
  policy: JsonDuplicateMemberPolicy,
  read?: JsonReviver | JsonObjectNumberSource,
): ParsedJsonWithPolicy {
  const reviver = typeof read === "function" ? read : undefined;
  const observation = typeof read === "object" ? read : undefined;
  let value: unknown;
  try {
    value = JSON.parse(text, reviver) as unknown;
  } catch (cause: unknown) {
    return { ok: false, cause };
  }
  if (policy === "last-wins") return { ok: true, value };
  const members = observeJsonMembers(
    text,
    observation === undefined ? undefined : { ...observation, root: value },
  );
  if (members.duplicate !== undefined)
    return { ok: false, duplicate: members.duplicate };
  return members.firstObjectMember === undefined
    ? { ok: true, value }
    : { ok: true, value, firstObjectMember: members.firstObjectMember };
}

/**
 * Parse JSON text whose duplicate-member policy is `"last-wins"`, throwing the
 * native `SyntaxError` on invalid JSON.
 */
export const parseLastWinsJson = (
  text: string,
  reviver?: JsonReviver,
): unknown => JSON.parse(text, reviver) as unknown;

const objectRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const decimalMemberPrefix = String.raw`:[\t\r\n ]*-?\d+[.Ee]`;
// A match inside a string can do extra scanning, but cannot hide a numeric member.
const mayHaveDecimalMember = new RegExp(decimalMemberPrefix, "u");
const decimalMemberValue =
  /[\t\r\n ]*:[\t\r\n ]*(-?\d+(?:\.\d+(?:[Ee][+-]?\d+)?|[Ee][+-]?\d+))/y;

class JsonNumberSourceCursor {
  readonly #objects: (Record<string, unknown> | undefined)[] = [];
  #next: Record<string, unknown> | undefined;

  constructor(private readonly observation: JsonNumberObservation) {
    this.#next = objectRecord(observation.root);
  }

  enter(object: boolean): void {
    this.#objects.push(object ? this.#next : undefined);
    this.#next = undefined;
  }

  leave(): void {
    this.#objects.pop();
  }

  member(name: string, source: string, end: number): void {
    const owner = this.#objects.at(-1);
    if (owner === undefined) return;
    const value = owner[name];
    this.#next = objectRecord(value);
    if (name !== this.observation.name || typeof value !== "number") return;
    decimalMemberValue.lastIndex = end;
    const raw = decimalMemberValue.exec(source)?.[1];
    if (raw !== undefined) this.observation.read(owner, value, raw);
  }
}

/**
 * Walk valid JSON text once, reporting the first root object member in source
 * order, the first repeated object member, and — when `observation` is given —
 * a named number's decimal spelling. The walk is iterative, so nesting depth is
 * bounded by memory rather than the call stack. When `limits` is given, the
 * walk retains at most `maxDepth` open containers and `maxRetainedNames` live
 * names and stops with `limitReached` once either would be exceeded — so
 * representation growth is checked before allocation rather than scaling with
 * the document.
 */
const observeJsonMembers = (
  text: string,
  observation?: JsonNumberObservation,
  limits?: JsonDuplicateScanLimits,
) => {
  const cursor =
    observation !== undefined && mayHaveDecimalMember.test(text)
      ? new JsonNumberSourceCursor(observation)
      : undefined;
  // One entry per open container: the names seen so far for an object, or
  // null for an array. `expectName` marks the next string as a member name.
  const open: (Set<string> | null)[] = [];
  let expectName = false;
  let firstObjectMember: string | undefined;
  let retainedNames = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === QUOTE) {
      const start = index;
      // Walk short strings directly. For longer runs, jump to candidate
      // closing quotes and use escape parity to distinguish literal quotes.
      const shortEnd = start + 32;
      for (
        index++;
        index < shortEnd && text.charCodeAt(index) !== QUOTE;
        index++
      )
        if (text.charCodeAt(index) === BACKSLASH) index++;
      if (index >= shortEnd) {
        let quote = text.indexOf('"', index);
        while (quote >= 0) {
          let escapeStart = quote;
          while (
            escapeStart > index &&
            text.charCodeAt(escapeStart - 1) === BACKSLASH
          )
            escapeStart--;
          if ((quote - escapeStart) % 2 === 0) break;
          index = quote + 1;
          quote = text.indexOf('"', index);
        }
        index = quote < 0 ? text.length : quote;
      }
      if (!expectName) continue;
      expectName = false;
      const names = open.at(-1);
      if (names === null || names === undefined) continue;
      const raw = text.slice(start, index + 1);
      const name = raw.includes("\\")
        ? (JSON.parse(raw) as string)
        : raw.slice(1, -1);
      if (open.length === 1) firstObjectMember ??= name;
      if (names.has(name))
        return {
          firstObjectMember,
          duplicate: { name, offset: start },
          limitReached: false,
        };
      names.add(name);
      cursor?.member(name, text, index + 1);
      retainedNames++;
      if (limits !== undefined && retainedNames > limits.maxRetainedNames)
        return { firstObjectMember, duplicate: undefined, limitReached: true };
      continue;
    }
    switch (text[index]) {
      case "{":
        cursor?.enter(true);
        open.push(new Set());
        expectName = true;
        if (limits !== undefined && open.length > limits.maxDepth)
          return { firstObjectMember, duplicate: undefined, limitReached: true };
        break;
      case "[":
        cursor?.enter(false);
        open.push(null);
        if (limits !== undefined && open.length > limits.maxDepth)
          return { firstObjectMember, duplicate: undefined, limitReached: true };
        break;
      case "}":
      case "]": {
        cursor?.leave();
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
      default:
        break;
    }
  }
  return { firstObjectMember, duplicate: undefined, limitReached: false };
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
): JsonDuplicateMember | undefined => observeJsonMembers(text).duplicate;

/**
 * Find the first repeated member, bounding the scan's retained state to the
 * supplied allowance and reporting when that allowance stops the scan.
 */
export const findDuplicateJsonMemberBounded = (
  text: string,
  limits: JsonDuplicateScanLimits,
): JsonDuplicateScanResult => {
  const members = observeJsonMembers(text, undefined, limits);
  // `member` is an exact-optional property, so omit it rather than set it to
  // undefined when no duplicate was found.
  return members.duplicate === undefined
    ? { limitReached: members.limitReached }
    : { member: members.duplicate, limitReached: members.limitReached };
};
