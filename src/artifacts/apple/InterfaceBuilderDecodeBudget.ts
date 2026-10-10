import { decodeXmlPlistText } from "../../domain/propertyListXmlText.js";

/** Reason reported when an archive would exceed the shared decoding budget. */
export type InterfaceBuilderBudgetReason = "aggregate_decode_budget_exhausted";

/** A named resource-limit failure that keeps budget exhaustion out of decode errors. */
export class InterfaceBuilderDecodeBudgetExceeded extends Error {
  constructor(
    readonly reason: InterfaceBuilderBudgetReason,
    message: string,
  ) {
    super(message);
    this.name = "InterfaceBuilderDecodeBudgetExceeded";
  }
}

/** Shared byte budget for decoder records and projected archive data. */
export class InterfaceBuilderDecodeBudget {
  readonly #initialBytes: number;
  #remainingBytes: number;

  constructor(maxBytes: number) {
    this.#initialBytes = maxBytes;
    this.#remainingBytes = maxBytes;
  }

  /** Representation bytes still available for the current inspection. */
  get remainingBytes(): number {
    return this.#remainingBytes;
  }

  /** Representation bytes reserved so far. */
  get usedBytes(): number {
    return this.#initialBytes - this.#remainingBytes;
  }

  /** Reserve representation bytes before allocation, or report exhaustion. */
  reserve(bytes: number, message: string): void {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > this.#remainingBytes
    )
      throw new InterfaceBuilderDecodeBudgetExceeded(
        "aggregate_decode_budget_exhausted",
        message,
      );
    this.#remainingBytes -= bytes;
  }

  /** Reserve an upper bound for one JSON-serialized string occurrence. */
  reserveJsonStringOccurrence(value: string): void {
    // JSON escaping uses at most six ASCII bytes per UTF-16 code unit, plus
    // quotes. Count occurrences even when the source string is shared.
    this.reserve(
      value.length * 6 + 2,
      "projected JSON strings exceed the aggregate Interface Builder decode budget",
    );
  }

  /** Reserve the exact JSON string length for a base64 value from Buffer. */
  reserveBase64JsonStringOccurrence(value: string): void {
    // Buffer's base64 alphabet contains no JSON-escaped characters.
    this.reserve(
      value.length + 2,
      "projected NIB base64 values exceed the aggregate Interface Builder decode budget",
    );
  }

  /** Reserve an upper bound for one JSON object property name occurrence. */
  reserveJsonPropertyNameOccurrence(value: string): void {
    this.reserve(
      value.length * 6 + 3,
      "projected JSON property names exceed the aggregate Interface Builder decode budget",
    );
  }

  /** Reserve bytes for an optional projection without throwing on exhaustion. */
  tryReserve(bytes: number): boolean {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > this.#remainingBytes
    )
      return false;
    this.#remainingBytes -= bytes;
    return true;
  }
}

/** Preflight the representation created by the pinned plist decoder. */
export const estimatePropertyListDecodeBytes = (
  bytes: Buffer,
  maxBytes: number,
  xmlText?: string,
): BinaryPlistExpansion => {
  if (bytes.subarray(0, 8).toString("ascii") === "bplist00") {
    const expansion = estimateBinaryPlistExpansion(bytes, maxBytes);
    if (expansion.estimatedBytes > maxBytes)
      throw new InterfaceBuilderDecodeBudgetExceeded(
        "aggregate_decode_budget_exhausted",
        "plist representation exceeds the aggregate Interface Builder decode budget",
      );
    return expansion;
  }
  const estimate = estimateXmlPlistExpansion(bytes, maxBytes, xmlText);
  if (estimate > maxBytes)
    throw new InterfaceBuilderDecodeBudgetExceeded(
      "aggregate_decode_budget_exhausted",
      "plist representation exceeds the aggregate Interface Builder decode budget",
    );
  return { estimatedBytes: estimate, omittedPrototypeKeys: 0 };
};

const estimateXmlPlistExpansion = (
  bytes: Buffer,
  maxBytes: number,
  xmlText?: string,
): number => {
  const xml = xmlText ?? decodeXmlPlistText(bytes);
  if (/<!DOCTYPE\b[^>]*\[/iu.test(xml))
    throw new InterfaceBuilderDecodeBudgetExceeded(
      "aggregate_decode_budget_exhausted",
      "XML plist internal entity expansion exceeds the aggregate Interface Builder decode budget",
    );
  const elementPattern =
    /<!--[^]*?-->|<!\[CDATA\[[^]*?\]\]>|<!DOCTYPE[^>]*>|<\?[^]*?\?>|<\/?[A-Za-z][^>]*>/giu;
  const decodedSourceBytes = xml.length * 2;
  let elementCount = 0;
  let xmlDepth = 0;
  for (const match of xml.matchAll(elementPattern)) {
    const token = match[0] ?? "";
    if (
      token.startsWith("<!--") ||
      token.startsWith("<![CDATA[") ||
      token.startsWith("<!DOCTYPE") ||
      token.startsWith("<?")
    )
      continue;
    elementCount += 1;
    if (token.startsWith("</")) xmlDepth -= 1;
    else if (!token.endsWith("/>")) {
      xmlDepth += 1;
      if (xmlDepth > 128)
        throw new InterfaceBuilderDecodeBudgetExceeded(
          "aggregate_decode_budget_exhausted",
          "XML plist nesting exceeds the aggregate Interface Builder decode budget",
        );
    }
    if (decodedSourceBytes * 2 + elementCount * 128 > maxBytes)
      return maxBytes + 1;
  }
  return decodedSourceBytes * 2 + elementCount * 128;
};

const PROTOTYPE_KEY_ASCII = Buffer.from("__proto__");
const PROTOTYPE_KEY_UTF16BE = Buffer.alloc(PROTOTYPE_KEY_ASCII.length * 2);
for (let index = 0; index < PROTOTYPE_KEY_ASCII.length; index += 1)
  PROTOTYPE_KEY_UTF16BE.writeUInt16BE(
    PROTOTYPE_KEY_ASCII[index] ?? 0,
    index * 2,
  );

/** Byte estimate and dictionary keys the JSON projection cannot retain. */
export interface BinaryPlistExpansion {
  readonly estimatedBytes: number;
  readonly omittedPrototypeKeys: number;
}

/** Resource a binary plist preflight found over its budget, or a malformed reference cycle. */
export type BinaryPlistExpansionFailure = "cycle" | "depth" | "expansion";

const interfaceBuilderBudgetFailure = (
  _kind: BinaryPlistExpansionFailure,
  message: string,
): Error =>
  new InterfaceBuilderDecodeBudgetExceeded(
    "aggregate_decode_budget_exhausted",
    message,
  );

/** How a caller names and reports binary plist expansion failures. */
export interface BinaryPlistExpansionOptions {
  /** Budget named in failure messages. */
  readonly budget?: string;
  /** Error for budget, depth, and reference-cycle failures. */
  readonly fail?: (kind: BinaryPlistExpansionFailure, message: string) => Error;
  /**
   * Structural bounds: "strict" keeps objects and the offset table before the
   * trailer; "decoder" admits exactly what plist.parseBinary can read, so
   * expansion is bounded without rejecting archives that decoder accepts.
   */
  readonly bounds?: "strict" | "decoder";
}

/**
 * Count every expanded binary-plist reference before calling plist.parseBinary,
 * which recurses on each reference and copies shared containers. Malformed
 * structure throws TypeError; budget, depth, and cycle failures use `fail`.
 */
export const estimateBinaryPlistExpansion = (
  bytes: Buffer,
  maxBytes: number,
  {
    budget = "the aggregate Interface Builder decode budget",
    fail = interfaceBuilderBudgetFailure,
    bounds = "strict",
  }: BinaryPlistExpansionOptions = {},
): BinaryPlistExpansion => {
  if (bytes.length < 40)
    throw new TypeError("binary plist trailer is truncated");
  const trailer = bytes.length - 32;
  const offsetSize = bytes[trailer + 6] ?? 0;
  const referenceSize = bytes[trailer + 7] ?? 0;
  if (
    ![1, 2, 4, 8].includes(offsetSize) ||
    ![1, 2, 4, 8].includes(referenceSize)
  )
    throw new TypeError("binary plist trailer integer sizes are invalid");
  const readInteger = (offset: number, size: number): number => {
    if (offset < 0 || size < 1 || offset + size > bytes.length) return -1;
    let value = 0;
    for (let index = 0; index < size; index += 1)
      value = value * 256 + (bytes[offset + index] ?? 0);
    return Number.isSafeInteger(value) ? value : -1;
  };
  const objectCount = readInteger(trailer + 8, 8);
  const topObject = readInteger(trailer + 16, 8);
  const offsetTable = readInteger(trailer + 24, 8);
  const tableEnd = bounds === "strict" ? trailer : bytes.length;
  const objectsEnd = bounds === "strict" ? offsetTable : bytes.length;
  if (
    objectCount < 1 ||
    topObject < 0 ||
    topObject >= objectCount ||
    offsetTable < 8 ||
    offsetTable + objectCount * offsetSize > tableEnd
  )
    throw new TypeError("binary plist trailer or object table is invalid");
  let omittedPrototypeKeys = 0;
  const readObjectBytes = (object: number): Buffer | undefined => {
    const objectOffset = readInteger(
      offsetTable + object * offsetSize,
      offsetSize,
    );
    if (objectOffset < 8 || objectOffset >= objectsEnd) return undefined;
    const objectMarker = bytes[objectOffset] ?? 0;
    const objectType = objectMarker >> 4;
    if (objectType !== 5 && objectType !== 6) return undefined;
    let objectSize = objectMarker & 0x0f;
    let cursor = objectOffset + 1;
    if (objectSize === 0x0f) {
      const extended = bytes[cursor] ?? 0;
      if (extended >> 4 !== 1 || (extended & 0x0f) > 3) return undefined;
      cursor += 1;
      const integerSize = 1 << (extended & 0x0f);
      objectSize = readInteger(cursor, integerSize);
      cursor += integerSize;
      if (objectSize < 0) return undefined;
    }
    const byteLength = objectType === 6 ? objectSize * 2 : objectSize;
    if (!Number.isSafeInteger(byteLength) || cursor + byteLength > objectsEnd)
      return undefined;
    return bytes.subarray(cursor, cursor + byteLength);
  };
  const isPrototypeKey = (object: number): boolean => {
    const text = readObjectBytes(object);
    return (
      text !== undefined &&
      ((text.length === PROTOTYPE_KEY_ASCII.length &&
        text.equals(PROTOTYPE_KEY_ASCII)) ||
        (text.length === PROTOTYPE_KEY_UTF16BE.length &&
          text.equals(PROTOTYPE_KEY_UTF16BE)))
    );
  };
  let estimate = bytes.length * 2 + objectCount * 16;
  if (estimate > maxBytes)
    throw fail("expansion", `binary plist object table exceeds ${budget}`);

  const active = new Set<number>();
  const pending: Array<{ object: number; depth: number; exit: boolean }> = [
    { object: topObject, depth: 0, exit: false },
  ];
  let pendingObjectCount = 1;
  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === undefined) break;
    if (entry.exit) {
      active.delete(entry.object);
      continue;
    }
    pendingObjectCount -= 1;
    if (entry.depth > 128)
      throw fail("depth", `binary plist nesting exceeds ${budget}`);
    if (active.has(entry.object))
      throw fail("cycle", `binary plist reference cycle exceeds ${budget}`);
    estimate += 96;
    if (estimate > maxBytes)
      throw fail(
        "expansion",
        `binary plist reference expansion exceeds ${budget}`,
      );
    const offset = readInteger(
      offsetTable + entry.object * offsetSize,
      offsetSize,
    );
    if (offset < 8 || offset >= objectsEnd)
      throw new TypeError("binary plist object offset is invalid");
    const marker = bytes[offset] ?? 0;
    const type = marker >> 4;
    let size = marker & 0x0f;
    let cursor = offset + 1;
    if (size === 0x0f && type !== 0 && type !== 8) {
      const extMarker = bytes[cursor] ?? 0;
      if (extMarker >> 4 !== 1 || (extMarker & 0x0f) > 3)
        throw new TypeError("binary plist extended object size is invalid");
      cursor += 1;
      const integerSize = 1 << (extMarker & 0x0f);
      size = readInteger(cursor, integerSize);
      cursor += integerSize;
      if (size < 0 || cursor > objectsEnd)
        throw new TypeError("binary plist extended object size is invalid");
    }
    if (type === 4 || type === 5 || type === 6) {
      const byteLength = type === 6 ? size * 2 : size;
      if (cursor + byteLength > objectsEnd)
        throw new TypeError("binary plist scalar object is truncated");
      estimate += type === 4 ? size + 4 * Math.ceil(size / 3) : byteLength * 2;
      if (estimate > maxBytes)
        throw fail(
          "expansion",
          `binary plist scalar expansion exceeds ${budget}`,
        );
      continue;
    }
    if (type !== 10 && type !== 13) continue;
    if (type === 13) {
      for (let index = 0; index < size; index += 1) {
        const key = readInteger(cursor + index * referenceSize, referenceSize);
        if (key >= 0 && key < objectCount && isPrototypeKey(key))
          omittedPrototypeKeys += 1;
      }
    }
    const childCount = type === 13 ? size * 2 : size;
    const refsEnd = cursor + childCount * referenceSize;
    if (!Number.isSafeInteger(refsEnd) || refsEnd > objectsEnd)
      throw new TypeError("binary plist reference table is truncated");
    const availableNodes = Math.floor((maxBytes - estimate) / 96);
    if (childCount > availableNodes - pendingObjectCount)
      throw fail(
        "expansion",
        `binary plist reference expansion exceeds ${budget}`,
      );
    active.add(entry.object);
    pending.push({ object: entry.object, depth: entry.depth, exit: true });
    for (let index = childCount - 1; index >= 0; index -= 1) {
      const reference = readInteger(
        cursor + index * referenceSize,
        referenceSize,
      );
      if (reference < 0 || reference >= objectCount)
        throw new TypeError("binary plist reference is invalid");
      pending.push({ object: reference, depth: entry.depth + 1, exit: false });
    }
    pendingObjectCount += childCount;
  }
  return { estimatedBytes: estimate, omittedPrototypeKeys };
};
