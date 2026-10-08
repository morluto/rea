import { decodeXmlPlistText } from "./XmlPropertyListText.js";

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
): number => {
  const estimate =
    bytes.subarray(0, 8).toString("ascii") === "bplist00"
      ? estimateBinaryPlistExpansion(bytes, maxBytes)
      : estimateXmlPlistExpansion(bytes, maxBytes, xmlText);
  if (estimate > maxBytes)
    throw new InterfaceBuilderDecodeBudgetExceeded(
      "aggregate_decode_budget_exhausted",
      "plist representation exceeds the aggregate Interface Builder decode budget",
    );
  return estimate;
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

/** Count every expanded binary-plist reference before calling plist.parseBinary. */
const estimateBinaryPlistExpansion = (
  bytes: Buffer,
  maxBytes: number,
): number => {
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
  if (
    objectCount < 1 ||
    topObject < 0 ||
    topObject >= objectCount ||
    offsetTable < 8 ||
    offsetTable + objectCount * offsetSize > trailer
  )
    throw new TypeError("binary plist trailer or object table is invalid");
  let estimate = bytes.length * 2 + objectCount * 16;
  if (estimate > maxBytes)
    throw new InterfaceBuilderDecodeBudgetExceeded(
      "aggregate_decode_budget_exhausted",
      "binary plist object table exceeds the aggregate Interface Builder decode budget",
    );

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
      throw new InterfaceBuilderDecodeBudgetExceeded(
        "aggregate_decode_budget_exhausted",
        "binary plist nesting exceeds the aggregate Interface Builder decode budget",
      );
    if (active.has(entry.object))
      throw new InterfaceBuilderDecodeBudgetExceeded(
        "aggregate_decode_budget_exhausted",
        "binary plist reference cycle exceeds the aggregate Interface Builder decode budget",
      );
    estimate += 96;
    if (estimate > maxBytes)
      throw new InterfaceBuilderDecodeBudgetExceeded(
        "aggregate_decode_budget_exhausted",
        "binary plist reference expansion exceeds the aggregate Interface Builder decode budget",
      );
    const offset = readInteger(
      offsetTable + entry.object * offsetSize,
      offsetSize,
    );
    if (offset < 8 || offset >= offsetTable)
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
      if (size < 0 || cursor > offsetTable)
        throw new TypeError("binary plist extended object size is invalid");
    }
    if (type === 4 || type === 5 || type === 6) {
      const byteLength = type === 6 ? size * 2 : size;
      if (cursor + byteLength > offsetTable)
        throw new TypeError("binary plist scalar object is truncated");
      estimate += type === 4 ? Math.ceil((size * 4) / 3) : byteLength * 2;
      if (estimate > maxBytes)
        throw new InterfaceBuilderDecodeBudgetExceeded(
          "aggregate_decode_budget_exhausted",
          "binary plist scalar expansion exceeds the aggregate Interface Builder decode budget",
        );
      continue;
    }
    if (type !== 10 && type !== 13) continue;
    const childCount = type === 13 ? size * 2 : size;
    const refsEnd = cursor + childCount * referenceSize;
    if (!Number.isSafeInteger(refsEnd) || refsEnd > offsetTable)
      throw new TypeError("binary plist reference table is truncated");
    const availableNodes = Math.floor((maxBytes - estimate) / 96);
    if (childCount > availableNodes - pendingObjectCount)
      throw new InterfaceBuilderDecodeBudgetExceeded(
        "aggregate_decode_budget_exhausted",
        "binary plist reference expansion exceeds the aggregate Interface Builder decode budget",
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
  return estimate;
};
