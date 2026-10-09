/** Encode ordinary JSON as bounded string parts without a document-sized allocation. */
export function* jsonParts(value: unknown, pretty = false): Generator<string> {
  yield* encodeValue(value, pretty, false);
}

/** Encode validated JSON with canonical key ordering without allocating the whole document. */
export function* canonicalJsonParts(value: unknown): Generator<string> {
  yield* encodeValue(value, false, true);
}

/** Buffer JSON parts while preserving complete UTF-16 surrogate pairs. */
export function* bufferedJsonParts(parts: Iterable<string>): Generator<string> {
  let buffer = "";
  for (const part of parts) {
    if (buffer.length + part.length > 64 * 1024 && buffer !== "") {
      yield buffer;
      buffer = "";
    }
    buffer += part;
  }
  if (buffer !== "") yield buffer;
}

function* encodeString(value: string): Generator<string> {
  if (value.length <= 8192) {
    yield JSON.stringify(value);
    return;
  }
  yield '"';
  for (let start = 0; start < value.length;) {
    let end = Math.min(start + 8192, value.length);
    const last = value.charCodeAt(end - 1);
    const next = value.charCodeAt(end);
    // Keep a surrogate pair in the same JSON.stringify and UTF-8 write.
    if (
      end < value.length &&
      last >= 0xd800 &&
      last <= 0xdbff &&
      next >= 0xdc00 &&
      next <= 0xdfff
    )
      end -= 1;
    yield JSON.stringify(value.slice(start, end)).slice(1, -1);
    start = end;
  }
  yield '"';
}

/** Encoded text accumulated before it is yielded as one part. */
const PART_CHARACTERS = 16 * 1024;

const indentation: string[] = [];
const indent = (depth: number): string =>
  (indentation[depth] ??= `\n${"  ".repeat(depth)}`);

interface ContainerFrame {
  readonly value: object;
  readonly array: boolean;
  readonly keys: readonly string[] | undefined;
  readonly count: number;
  readonly depth: number;
  index: number;
  written: number;
}

/** Encoded text of a scalar, or undefined for a container or a long string. */
const scalarText = (value: unknown): string | undefined => {
  if (typeof value === "string")
    return value.length <= 8192 ? JSON.stringify(value) : undefined;
  if (value === null) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
};

const openContainer = (
  value: unknown,
  depth: number,
  ancestors: Set<object>,
  canonical: boolean,
): ContainerFrame => {
  if (typeof value !== "object" || value === null)
    throw new TypeError("JSON output requires ordinary JSON values");
  if (ancestors.has(value))
    throw new TypeError("JSON output contains a circular reference");
  const array = Array.isArray(value);
  if (!array && Object.prototype.toString.call(value) !== "[object Object]")
    throw new TypeError("JSON output requires ordinary JSON objects");
  ancestors.add(value);
  const keys = array ? undefined : Object.keys(value);
  if (canonical) keys?.sort();
  const count = array ? value.length : (keys?.length ?? 0);
  return { value, array, keys, count, depth, index: 0, written: 0 };
};

/** The next written member of a container, skipping values JSON omits. */
const nextMember = (
  frame: ContainerFrame,
): { readonly key: string | undefined; readonly item: unknown } | undefined => {
  while (frame.index < frame.count) {
    const index = frame.index;
    frame.index += 1;
    if (frame.array)
      return { key: undefined, item: Reflect.get(frame.value, index) };
    const key = frame.keys?.[index];
    if (key === undefined)
      throw new TypeError("JSON object changed during serialization");
    const item: unknown = Reflect.get(frame.value, key);
    // Incur's filter can select inherited methods. Match native JSON's
    // omission without eagerly reading the rest of a bounded result.
    if (
      item !== undefined &&
      typeof item !== "function" &&
      typeof item !== "symbol"
    )
      return { key, item };
  }
  return undefined;
};

/**
 * Encode iteratively into bounded parts. Recursive `yield*` delegation passed
 * every token through one generator frame per nesting level, which dominated
 * the cost of writing large nested results.
 */
function* encodeValue(
  root: unknown,
  pretty: boolean,
  canonical: boolean,
): Generator<string> {
  const ancestors = new Set<object>();
  const stack: ContainerFrame[] = [];
  let buffer = "";
  let pending: unknown = root;
  let hasPending = true;
  while (true) {
    if (hasPending) {
      hasPending = false;
      const text = scalarText(pending);
      if (text !== undefined) buffer += text;
      else if (typeof pending === "string") {
        // A long string is split into surrogate-safe parts of its own.
        if (buffer !== "") yield buffer;
        buffer = "";
        yield* encodeString(pending);
      } else {
        const frame = openContainer(
          pending,
          stack.length,
          ancestors,
          canonical,
        );
        stack.push(frame);
        buffer += frame.array ? "[" : "{";
      }
    }
    if (buffer.length >= PART_CHARACTERS) {
      yield buffer;
      buffer = "";
    }
    const frame = stack.at(-1);
    if (frame === undefined) break;
    const member = nextMember(frame);
    if (member === undefined) {
      if (pretty && frame.written > 0) buffer += indent(frame.depth);
      buffer += frame.array ? "]" : "}";
      ancestors.delete(frame.value);
      stack.pop();
      continue;
    }
    if (frame.written > 0) buffer += ",";
    if (pretty) buffer += indent(frame.depth + 1);
    if (member.key !== undefined) {
      const key = scalarText(member.key);
      if (key !== undefined) buffer += key;
      else {
        if (buffer !== "") yield buffer;
        buffer = "";
        yield* encodeString(member.key);
      }
      buffer += pretty ? ": " : ":";
    }
    frame.written += 1;
    pending = member.item;
    hasPending = true;
  }
  if (buffer !== "") yield buffer;
}
