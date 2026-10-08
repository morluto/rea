/** Encode ordinary JSON as bounded string parts without a document-sized allocation. */
export function* jsonParts(value: unknown, pretty = false): Generator<string> {
  yield* encodeValue(value, pretty, 0, new Set(), false);
}

/** Encode validated JSON with canonical key ordering without allocating the whole document. */
export function* canonicalJsonParts(value: unknown): Generator<string> {
  yield* encodeValue(value, false, 0, new Set(), true);
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

function* encodeValue(
  value: unknown,
  pretty: boolean,
  depth: number,
  ancestors: Set<object>,
  canonical: boolean,
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
    throw new TypeError("JSON output requires ordinary JSON values");
  if (ancestors.has(value))
    throw new TypeError("JSON output contains a circular reference");
  if (
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) !== "[object Object]"
  )
    throw new TypeError("JSON output requires ordinary JSON objects");
  ancestors.add(value);
  try {
    const array = Array.isArray(value);
    const keys = array ? undefined : Object.keys(value);
    if (canonical) keys?.sort();
    const count = array ? value.length : (keys?.length ?? 0);
    let written = 0;
    yield array ? "[" : "{";
    for (let index = 0; index < count; index += 1) {
      let item: unknown;
      let key: string | undefined;
      if (array) {
        item = value[index];
      } else {
        key = keys?.[index];
        if (key === undefined)
          throw new TypeError("JSON object changed during serialization");
        item = Reflect.get(value, key);
        // Incur's filter can select inherited methods. Match native JSON's
        // omission without eagerly reading the rest of a bounded result.
        if (
          item === undefined ||
          typeof item === "function" ||
          typeof item === "symbol"
        )
          continue;
      }
      if (written > 0) yield ",";
      if (pretty) yield `\n${"  ".repeat(depth + 1)}`;
      if (key !== undefined) {
        yield* encodeString(key);
        yield pretty ? ": " : ":";
      }
      yield* encodeValue(item, pretty, depth + 1, ancestors, canonical);
      written += 1;
    }
    if (pretty && written > 0) yield `\n${"  ".repeat(depth)}`;
    yield array ? "]" : "}";
  } finally {
    ancestors.delete(value);
  }
}
