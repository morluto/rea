import type { Writable } from "node:stream";

type JsonOutputFormat = "json" | "jsonl";

/** Write ordinary JSON without constructing a document-sized string. */
export const writeJsonOutput = async (
  value: unknown,
  destination: Writable,
  format: JsonOutputFormat = "json",
): Promise<void> => {
  for (const part of bufferedParts(documentParts(value, format)))
    await writePart(destination, part);
};

const writePart = (destination: Writable, part: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = (cause: unknown): void => reject(cause);
    destination.once("error", onError);
    try {
      destination.write(part, (cause) => {
        if (cause) {
          // A Writable can emit its error after invoking the write callback.
          setImmediate(() => destination.off("error", onError));
          reject(cause);
        } else {
          destination.off("error", onError);
          resolve();
        }
      });
    } catch (cause: unknown) {
      destination.off("error", onError);
      reject(cause);
    }
  });

function* documentParts(
  value: unknown,
  format: JsonOutputFormat,
): Generator<string> {
  if (format === "jsonl" && Array.isArray(value)) {
    for (const item of value) {
      yield* encodeValue(item, false, 0, new Set());
      yield "\n";
    }
    return;
  }
  yield* encodeValue(value, format === "json", 0, new Set());
  yield "\n";
}

function* bufferedParts(parts: Iterable<string>): Generator<string> {
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

function* encodeValue(
  value: unknown,
  pretty: boolean,
  depth: number,
  ancestors: Set<object>,
): Generator<string> {
  if (typeof value === "string") {
    yield* encodeString(value);
    return;
  }
  if (value === null || typeof value === "boolean") {
    yield value === null ? "null" : String(value);
    return;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    yield String(value);
    return;
  }
  if (typeof value !== "object" || value === null)
    throw new TypeError("CLI JSON output requires ordinary JSON values");
  if (ancestors.has(value))
    throw new TypeError("CLI JSON output contains a circular reference");
  if (
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) !== "[object Object]"
  )
    throw new TypeError("CLI JSON output requires ordinary JSON objects");
  ancestors.add(value);
  try {
    const array = Array.isArray(value);
    const keys = array
      ? undefined
      : Object.keys(value).filter((key) => {
          const item: unknown = Reflect.get(value, key);
          // Incur's filter can select inherited methods. Match native JSON's
          // omission of fields that have no JSON representation.
          return (
            item !== undefined &&
            typeof item !== "function" &&
            typeof item !== "symbol"
          );
        });
    const count = array ? value.length : (keys?.length ?? 0);
    yield array ? "[" : "{";
    for (let index = 0; index < count; index += 1) {
      if (index > 0) yield ",";
      if (pretty) yield `\n${"  ".repeat(depth + 1)}`;
      let item: unknown;
      if (array) {
        item = value[index];
      } else {
        const key = keys?.[index];
        if (key === undefined)
          throw new TypeError("CLI JSON object changed during serialization");
        yield* encodeString(key);
        yield pretty ? ": " : ":";
        item = Reflect.get(value, key);
      }
      yield* encodeValue(item, pretty, depth + 1, ancestors);
    }
    if (pretty && count > 0) yield `\n${"  ".repeat(depth)}`;
    yield array ? "]" : "}";
  } finally {
    ancestors.delete(value);
  }
}
