import { BinaryReader } from "../binaryContainer.js";
import {
  readBinaryPlistLayout,
  readBinaryPlistUnsigned64,
} from "./binaryPlistLayout.js";
import { decodeXmlPlistText } from "../propertyListXmlText.js";
import { hasBinaryPlistSignature } from "./appleArchiveFormat.js";
import { PlistNestingLimitError } from "./plistValue.js";
import {
  decodeLimit,
  malformedInput,
  ParseFailureError,
  truncatedInput,
  unsupportedInput,
} from "../parseFailure.js";
import {
  binaryPlistCloneOffsetWidth,
  binaryDateRequiresExactSeconds,
  binaryPlistObjectEnd,
  binaryPlistUidNormalizationWidth,
} from "./plistScalars.js";

const DEFAULT_PLIST_DECODE_BUDGET = "the property list decode budget";

/** Preflight the representation created by the pinned plist decoder. */
export const preflightPropertyListDecode = (
  bytes: Buffer,
  maxBytes: number,
  xmlText?: string,
  options: Pick<
    BinaryPlistExpansionOptions,
    "numberProjection" | "uidProjection" | "budget"
  > = {},
): PlistDecodePreflight => {
  const {
    numberProjection = false,
    uidProjection = false,
    budget = DEFAULT_PLIST_DECODE_BUDGET,
  } = options;
  if (hasBinaryPlistSignature(bytes))
    return estimateBinaryPlistExpansion(bytes, maxBytes, {
      numberProjection,
      uidProjection,
      budget,
    });
  return {
    estimatedBytes: preflightXmlPropertyListDecode(
      xmlText ?? decodeXmlPlistText(bytes),
      maxBytes,
      { numberProjection, budget },
    ),
    datePrecisionOverlapCount: 0,
    reachableDateOffsets: [],
    overlappingDateOffsets: [],
    reachableWideIntegerOffsets: [],
    overlappingWideIntegerOffsets: [],
    reachableNumericOffsets: [],
    uidOffsetsToNormalize: [],
    containersToNormalize: [],
    normalizedOffsetSize: 1,
    normalizedReferenceSize: 1,
  };
};

/** Refuse an XML plist whose decoded representation exceeds the byte allowance. */
export const preflightXmlPropertyListDecode = (
  xml: string,
  maxBytes: number,
  {
    numberProjection = false,
    budget = DEFAULT_PLIST_DECODE_BUDGET,
  }: Pick<BinaryPlistExpansionOptions, "numberProjection" | "budget"> = {},
): number => {
  const estimatedBytes = estimateXmlPlistExpansion(
    xml,
    maxBytes,
    numberProjection,
    budget,
  );
  if (estimatedBytes > maxBytes)
    throw decodeBudgetExceeded(
      `plist representation exceeds ${budget}`,
      maxBytes,
    );
  return estimatedBytes;
};

/**
 * Peak heap of the XML decoder's DOM: each element measured 1,000–1,160
 * bytes, each text, comment, CDATA or attribute node up to 240 bytes, and
 * each entity or character reference about 26 bytes beyond its characters,
 * with @xmldom/xmldom on 64-bit Node. Number projection adds literal metadata.
 */
const XML_ELEMENT_BYTES = 1280;
const XML_NUMBER_PROJECTION_ELEMENT_BYTES = 256;
const XML_NODE_BYTES = 384;
const XML_REFERENCE_BYTES = 64;

const estimateXmlPlistExpansion = (
  xml: string,
  maxBytes: number,
  numberProjection: boolean,
  budget: string,
): number => {
  // The decoded text and the DOM's copies of its character data.
  let estimate = xml.length * 4;
  const elementBytes =
    XML_ELEMENT_BYTES +
    (numberProjection ? XML_NUMBER_PROJECTION_ELEMENT_BYTES : 0);
  // Value nesting is bounded by the shared plist parser, which counts plist
  // value depth; raw element depth would also count the envelope and keys.
  for (const token of xmlPreflightTokens(xml)) {
    if (token.internalSubset)
      // Only a declaration outside opaque text can introduce an internal
      // subset. Brackets in quoted external identifiers are literal text.
      throw decodeBudgetExceeded(
        `XML plist internal entity expansion exceeds ${budget}`,
        maxBytes,
      );
    if (token.text) estimate += XML_NODE_BYTES;
    estimate += token.references * XML_REFERENCE_BYTES;
    if (token.kind === "element")
      estimate += elementBytes + token.attributes * XML_NODE_BYTES;
    else if (token.kind === "node") estimate += XML_NODE_BYTES;
    if (estimate > maxBytes) return maxBytes + 1;
  }
  return estimate;
};

/**
 * Index of the "]" closing an empty DOCTYPE internal subset opened at
 * `open`, allowing only XML whitespace between the brackets. An empty subset
 * declares nothing, so nothing in it can expand.
 */
const emptyInternalSubsetEnd = (
  xml: string,
  open: number,
): number | undefined => {
  let close = open + 1;
  while (close < xml.length && " \t\r\n".includes(xml[close] ?? "x"))
    close += 1;
  return xml[close] === "]" ? close : undefined;
};

/**
 * Consume each XML span once; malformed tokens cannot restart suffix scans.
 * Each token reports the DOM node it creates (none for an end tag), whether
 * character data, which becomes a text node, precedes it, and the references
 * the parser expands in that text and in the tag's attribute values. Opaque
 * comment, CDATA, PI and declaration content holds no references.
 */
function* xmlPreflightTokens(xml: string): Generator<{
  readonly kind: "element" | "node" | "none";
  readonly text: boolean;
  /** Unquoted "=" signs; each attribute of a well-formed tag has one. */
  readonly attributes: number;
  /** "&" in the preceding text and in this start tag's attribute values. */
  readonly references: number;
  readonly internalSubset: boolean;
}> {
  const textReferences = (from: number, to: number): number => {
    let count = 0;
    for (let index = from; index < to; index += 1)
      if (xml.charCodeAt(index) === 0x26) count += 1;
    return count;
  };
  let cursor = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf("<", cursor);
    if (start < 0) {
      yield {
        kind: "none",
        text: true,
        attributes: 0,
        references: textReferences(cursor, xml.length),
        internalSubset: false,
      };
      return;
    }
    const text = start > cursor;
    const references = textReferences(cursor, start);
    const opaqueEnd = xml.startsWith("<!--", start)
      ? "-->"
      : xml.startsWith("<![CDATA[", start)
        ? "]]>"
        : xml.startsWith("<?", start)
          ? "?>"
          : undefined;
    if (opaqueEnd !== undefined) {
      const end = xml.indexOf(opaqueEnd, start + 2);
      if (end < 0) return;
      cursor = end + opaqueEnd.length;
      yield {
        kind: "node",
        text,
        attributes: 0,
        references,
        internalSubset: false,
      };
      continue;
    }
    // Classify by the character after "<" rather than a name pattern: any
    // other markup starts an element, whatever its name's script. Saxes
    // rejects malformed markup before the DOM is built, so over-counting it
    // is harmless.
    const doctype = /^<!DOCTYPE\b/iu.test(xml.slice(start, start + 10));
    const declaration = xml[start + 1] === "!";
    const endTag = xml[start + 1] === "/";
    const element = !declaration && !endTag;
    let quote: string | undefined;
    let internalSubset = false;
    let attributes = 0;
    let attributeReferences = 0;
    let end = start + 1;
    for (; end < xml.length; end += 1) {
      const character = xml[end];
      if (quote !== undefined) {
        if (character === quote) quote = undefined;
        else if (element && character === "&") attributeReferences += 1;
      } else if (character === '"' || character === "'") quote = character;
      else if (character === ">") break;
      else if (character === "=") attributes += 1;
      else if (doctype && character === "[") {
        const emptySubsetEnd = emptyInternalSubsetEnd(xml, end);
        if (emptySubsetEnd === undefined) internalSubset = true;
        else end = emptySubsetEnd;
      }
    }
    if (end === xml.length) return;
    cursor = end + 1;
    yield {
      kind: element ? "element" : declaration ? "node" : "none",
      text,
      attributes,
      references: references + attributeReferences,
      internalSubset,
    };
  }
}

/** Deepest binary plist value nesting the reference walk admits. */
export const MAX_BINARY_PLIST_NESTING_DEPTH = 128;

/** Limit name of the decoded-representation budget a plist preflight enforces. */
export const PLIST_DECODE_BYTES_LIMIT = "plist-decode-bytes";

/** The decoded representation would exceed the caller's byte budget. */
const decodeBudgetExceeded = (
  detail: string,
  maximum: number,
): ParseFailureError<"limit"> =>
  decodeLimit("plist", detail, { name: PLIST_DECODE_BYTES_LIMIT, maximum });

/** Whether a plist preflight refused the decode for its byte budget. */
export const isPlistDecodeBudgetFailure = (
  cause: unknown,
): cause is ParseFailureError<"limit"> =>
  cause instanceof ParseFailureError &&
  cause.failure.kind === "limit" &&
  cause.failure.limit.name === PLIST_DECODE_BYTES_LIMIT;

/** How a caller names its budget and selects binary plist projection. */
export interface BinaryPlistExpansionOptions {
  /** Source-value depth; archive consumers retain the default 128-level allowance. */
  readonly maximumDepth?: number;
  /** Include original number metadata and exact-integer attribute projection. */
  readonly numberProjection?: boolean;
  /** Retain typed UID locations for Foundation archive interpretation. */
  readonly uidProjection?: boolean;
  /** Budget named in failure messages. */
  readonly budget?: string;
  /**
   * Structural bounds: "strict" keeps objects and the offset table before the
   * trailer; "decoder" follows the decoder's object-table boundary policy
   * while still rejecting structures whose coercion would lose plist facts.
   */
  readonly bounds?: "strict" | "decoder";
}

export interface BinaryPlistContainer {
  readonly object: number;
  readonly kind: "array" | "dictionary";
  readonly references: readonly number[];
  readonly keys?: readonly string[];
}

/** Validated source references, separate from upstream scalar conversion. */
export interface BinaryPlistValuePlan {
  readonly topObject: number;
  readonly scalars: readonly { object: number; uid: boolean }[];
  readonly containers: readonly BinaryPlistContainer[];
  readonly uidIdentity: boolean;
}

/** Preflight size and binary-key observations; XML keys are inspected by decode. */
export interface PlistDecodePreflight {
  readonly binaryValuePlan?: BinaryPlistValuePlan;
  readonly estimatedBytes: number;
  /** Number of expanded references to precision-unknown overlapping dates. */
  readonly datePrecisionOverlapCount: number;
  /** Unique reachable date records in the selected value graph. */
  readonly reachableDateOffsets: readonly number[];
  /** Precision-unknown date offsets requiring decoder-copy isolation. */
  readonly overlappingDateOffsets: readonly number[];
  /** Unique reachable 16-byte integer records in the selected value graph. */
  readonly reachableWideIntegerOffsets: readonly number[];
  /** Source offsets requiring isolated decoder-compatible scalar records. */
  readonly overlappingWideIntegerOffsets: readonly number[];
  /** Reachable integer and real source records for exact number association. */
  readonly reachableNumericOffsets: readonly number[];
  /** Reachable UID records cloned to one of plist@5's supported widths. */
  readonly uidOffsetsToNormalize: readonly { offset: number; width: number }[];
  /** Validated container headers and references needed for decoder-copy normalization. */
  readonly containersToNormalize: readonly {
    readonly offset: number;
    readonly headerLength: number;
    readonly references: readonly number[];
  }[];
  /** Decoder-supported width selected for the source offset table. */
  readonly normalizedOffsetSize: number;
  /** Decoder-supported width selected for array and dictionary references. */
  readonly normalizedReferenceSize: number;
}

type BinaryObjectSpan = { readonly offset: number; readonly end: number };

const findOverlappingScalarOffsets = (
  spans: readonly BinaryObjectSpan[],
  scalarOffsets: ReadonlySet<number>,
): Set<number> => {
  let maxPriorEnd = -1;
  const overlappingOffsets = new Set<number>();
  const activeScalars = new Map<number, number>();
  for (const span of spans) {
    for (const [offset, end] of activeScalars)
      if (end <= span.offset) activeScalars.delete(offset);
    if (scalarOffsets.has(span.offset)) {
      if (maxPriorEnd > span.offset) {
        overlappingOffsets.add(span.offset);
        for (const activeOffset of activeScalars.keys())
          overlappingOffsets.add(activeOffset);
        activeScalars.clear();
      } else activeScalars.set(span.offset, span.end);
    } else {
      for (const activeOffset of activeScalars.keys())
        overlappingOffsets.add(activeOffset);
      activeScalars.clear();
    }
    maxPriorEnd = Math.max(maxPriorEnd, span.end);
  }
  return overlappingOffsets;
};

/**
 * Validate and budget every expanded source reference before scalar decoding
 * and independent container materialization. Malformed structure throws
 * TypeError, and a reference cycle a malformed parse failure; a budget throws
 * a `limit` parse failure ({@link PLIST_DECODE_BYTES_LIMIT}, or the
 * nesting-depth limit of {@link PlistNestingLimitError}).
 */
export const estimateBinaryPlistExpansion = (
  bytes: Buffer,
  maxBytes: number,
  {
    budget = DEFAULT_PLIST_DECODE_BUDGET,
    bounds = "strict",
    numberProjection = false,
    uidProjection = false,
    maximumDepth = MAX_BINARY_PLIST_NESTING_DEPTH,
  }: BinaryPlistExpansionOptions = {},
): PlistDecodePreflight => {
  if (bytes.length < 40)
    throw truncatedInput("plist", "binary plist trailer is truncated");
  const sourceLayoutResult = readBinaryPlistLayout(bytes);
  if (!sourceLayoutResult.ok)
    throw truncatedInput("plist", "binary plist trailer is truncated");
  const sourceLayout = sourceLayoutResult.value;
  const {
    trailerOffset: trailer,
    offsetWidth: offsetSize,
    referenceWidth: referenceSize,
  } = sourceLayout;
  if (offsetSize < 1 || referenceSize < 1)
    throw malformedInput(
      "plist",
      "binary plist trailer integer sizes are invalid",
    );
  const safeDeclaration = (value: bigint): number =>
    value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : -1;
  const readInteger = (offset: number, size: number): number => {
    if (offset < 0 || size < 1 || offset + size > bytes.length) return -1;
    return safeDeclaration(readBinaryPlistUnsigned64(bytes, offset, size));
  };
  const objectCount = safeDeclaration(sourceLayout.objectCount);
  const topObject = safeDeclaration(sourceLayout.topObject);
  const offsetTable = safeDeclaration(sourceLayout.offsetTable);
  const tableEnd = bounds === "strict" ? trailer : bytes.length;
  const objectsEnd = bounds === "strict" ? offsetTable : bytes.length;
  if (
    objectCount < 1 ||
    topObject < 0 ||
    topObject >= objectCount ||
    offsetTable < 8 ||
    !Number.isSafeInteger(objectCount * offsetSize) ||
    !Number.isSafeInteger(offsetTable + objectCount * offsetSize) ||
    offsetTable + objectCount * offsetSize > tableEnd
  )
    throw malformedInput(
      "plist",
      "binary plist trailer or object table is invalid",
    );
  if (
    (offsetSize < 8 && offsetTable >= 2 ** (offsetSize * 8)) ||
    (referenceSize < 8 && objectCount >= 2 ** (referenceSize * 8))
  )
    throw malformedInput(
      "plist",
      "binary plist table width cannot address its contents",
    );
  const normalizedReferenceSize =
    [1, 2, 4, 8].includes(referenceSize) &&
    (referenceSize === 8 || objectCount < 2 ** (referenceSize * 8))
      ? referenceSize
      : [1, 2, 4, 8].find(
          (width) => width === 8 || objectCount < 2 ** (width * 8),
        );
  if (normalizedReferenceSize === undefined)
    throw malformedInput(
      "plist",
      "binary plist object reference count is invalid",
    );
  // Reserve source container/reference facts, scalar indexing, and the scalar
  // array/table overhead; projection also retains numeric/UID source metadata.
  const objectBytes = numberProjection || uidProjection ? 512 : 256;
  const expandedNodeBytes = numberProjection || uidProjection ? 224 : 96;
  // Scalar projection may require a same-sized parser-compatible input copy
  // for wide integers and sub-millisecond dates. The scalar array decoder keeps
  // another input-sized copy; reserve both before allocation.
  let estimate =
    bytes.length * (numberProjection ? 4 : 3) + objectCount * objectBytes;
  if (estimate > maxBytes)
    throw decodeBudgetExceeded(
      `binary plist object table exceeds ${budget}`,
      maxBytes,
    );

  const active = new Set<number>();
  const pending: Array<{
    object: number;
    depth: number;
    exit: boolean;
    dictionaryKey: boolean;
  }> = [
    {
      object: topObject,
      depth: 0,
      exit: false,
      dictionaryKey: false,
    },
  ];
  const scalarObjects = new Map<number, { object: number; uid: boolean }>();
  const sourceContainers = new Map<number, BinaryPlistContainer>();
  const reader = new BinaryReader(
    bytes.subarray(0, objectsEnd),
    false,
    "binary-plist",
  );
  const dictionaryKeys = new Map<number, string>();
  const readDictionaryKey = (object: number): string => {
    const prior = dictionaryKeys.get(object);
    if (prior !== undefined) return prior;
    const offset = safeDeclaration(sourceLayout.objectOffset(object));
    if (offset < 8 || offset >= objectsEnd)
      throw malformedInput("plist", "binary plist object offset is invalid");
    const marker = bytes[offset] ?? 0;
    const type = marker >> 4;
    if (type !== 5 && type !== 6)
      throw malformedInput(
        "plist",
        "binary plist dictionary key is not a string",
      );
    let size = marker & 0x0f;
    let cursor = offset + 1;
    if (size === 15) {
      const extended = bytes[cursor] ?? 0;
      if (extended >> 4 !== 1 || (extended & 15) > 3)
        throw malformedInput(
          "plist",
          "binary plist extended object size is invalid",
        );
      const width = 1 << (extended & 15);
      size = readInteger(cursor + 1, width);
      cursor += 1 + width;
      if (cursor > objectsEnd)
        throw truncatedInput(
          "plist",
          "binary plist extended object size is truncated",
        );
      if (size < 0)
        throw malformedInput(
          "plist",
          "binary plist extended object size is invalid",
        );
    }
    if (cursor + size * (type === 6 ? 2 : 1) > objectsEnd)
      throw truncatedInput("plist", "binary plist scalar object is truncated");
    let key = "";
    for (let index = 0; index < size; index += 1)
      key += String.fromCharCode(
        type === 5 ? bytes[cursor + index]! : reader.u16(cursor + index * 2),
      );
    dictionaryKeys.set(object, key);
    return key;
  };
  let pendingObjectCount = 1;
  const reachableObjectOffsets = new Set<number>();
  const reachableDateOffsets = new Set<number>();
  const reachableWideIntegerOffsets = new Set<number>();
  const reachableNumericOffsets = new Set<number>();
  const uidWidthsToNormalize = new Map<number, number>();
  const containersToNormalize = new Map<
    number,
    {
      readonly offset: number;
      readonly headerLength: number;
      readonly references: readonly number[];
    }
  >();
  const reachableDateOccurrences: number[] = [];
  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === undefined) break;
    if (entry.exit) {
      active.delete(entry.object);
      continue;
    }
    pendingObjectCount -= 1;
    if (entry.depth > maximumDepth)
      throw new PlistNestingLimitError(maximumDepth);
    if (active.has(entry.object))
      throw malformedInput(
        "plist",
        "binary plist object references form a cycle, which a property list cannot represent",
      );
    estimate += expandedNodeBytes;
    if (estimate > maxBytes)
      throw decodeBudgetExceeded(
        `binary plist reference expansion exceeds ${budget}`,
        maxBytes,
      );
    const offset = safeDeclaration(sourceLayout.objectOffset(entry.object));
    if (offset < 8 || offset >= objectsEnd)
      throw malformedInput("plist", "binary plist object offset is invalid");
    if (numberProjection) reachableObjectOffsets.add(offset);
    const marker = bytes[offset] ?? 0;
    const type = marker >> 4;
    if (type !== 10 && type !== 13)
      scalarObjects.set(entry.object, {
        object: entry.object,
        uid: type === 8,
      });
    if (entry.dictionaryKey && type !== 5 && type !== 6)
      throw malformedInput(
        "plist",
        "binary plist dictionary key is not a string",
      );
    if (type === 3) {
      if (marker !== 0x33)
        throw malformedInput(
          "plist",
          `binary plist date marker 0x${marker.toString(16)} is invalid`,
        );
      // The offset table and trailer are not part of an encoded object. Keep
      // this scalar boundary even when compatibility mode follows decoder
      // bounds for other object and reference checks.
      if (offset + 9 > offsetTable)
        throw truncatedInput("plist", "binary plist date object is truncated");
      if (numberProjection) {
        reachableDateOffsets.add(offset);
        reachableDateOccurrences.push(offset);
      }
      continue;
    }
    if (type === 8) {
      const uidWidth = (marker & 0x0f) + 1;
      if (offset + 1 + uidWidth > objectsEnd)
        throw truncatedInput("plist", "binary plist UID object is truncated");
      const normalizedWidth = binaryPlistUidNormalizationWidth(bytes, offset);
      if (normalizedWidth !== undefined)
        uidWidthsToNormalize.set(offset, normalizedWidth);
      continue;
    }
    if (type === 1 || type === 2) {
      const info = marker & 0x0f;
      if (type === 1 && info > 4)
        throw malformedInput("plist", "binary plist integer width is invalid");
      if (type === 2 && info !== 2 && info !== 3)
        throw malformedInput("plist", "binary plist real width is invalid");
      const width = 1 << info;
      if (offset + 1 + width > offsetTable)
        throw truncatedInput(
          "plist",
          "binary plist numeric scalar is truncated",
        );
      if (numberProjection) {
        reachableNumericOffsets.add(offset);
        if (type === 1 && width === 16) reachableWideIntegerOffsets.add(offset);
      }
      continue;
    }
    let size = marker & 0x0f;
    let cursor = offset + 1;
    if (size === 0x0f && type !== 0 && type !== 8) {
      const extMarker = bytes[cursor] ?? 0;
      if (extMarker >> 4 !== 1 || (extMarker & 0x0f) > 3)
        throw malformedInput(
          "plist",
          "binary plist extended object size is invalid",
        );
      cursor += 1;
      const integerSize = 1 << (extMarker & 0x0f);
      size = readInteger(cursor, integerSize);
      cursor += integerSize;
      // The length record crossing the object area is missing bytes; a
      // complete record whose value is not a safe length is invalid.
      if (cursor > objectsEnd)
        throw truncatedInput(
          "plist",
          "binary plist extended object size is truncated",
        );
      if (size < 0)
        throw malformedInput(
          "plist",
          "binary plist extended object size is invalid",
        );
    }
    if (type === 4 || type === 5 || type === 6) {
      const byteLength = type === 6 ? size * 2 : size;
      if (cursor + byteLength > objectsEnd)
        throw truncatedInput(
          "plist",
          "binary plist scalar object is truncated",
        );
      estimate += type === 4 ? size + 4 * Math.ceil(size / 3) : byteLength * 2;
      if (estimate > maxBytes)
        throw decodeBudgetExceeded(
          `binary plist scalar expansion exceeds ${budget}`,
          maxBytes,
        );
      continue;
    }
    if (type !== 10 && type !== 13) continue;
    const childCount = type === 13 ? size * 2 : size;
    const refsEnd = cursor + childCount * referenceSize;
    if (!Number.isSafeInteger(refsEnd) || refsEnd > objectsEnd)
      throw truncatedInput(
        "plist",
        "binary plist reference table is truncated",
      );
    const availableNodes = Math.floor(
      (maxBytes - estimate) / expandedNodeBytes,
    );
    if (childCount > availableNodes - pendingObjectCount)
      throw decodeBudgetExceeded(
        `binary plist reference expansion exceeds ${budget}`,
        maxBytes,
      );
    const references = Array.from({ length: childCount }, (_, index) => {
      const reference = readInteger(
        cursor + index * referenceSize,
        referenceSize,
      );
      if (reference < 0 || reference >= objectCount)
        throw malformedInput("plist", "binary plist reference is invalid");
      return reference;
    });
    if (!sourceContainers.has(entry.object))
      sourceContainers.set(entry.object, {
        object: entry.object,
        kind: type === 13 ? "dictionary" : "array",
        references: type === 13 ? references.slice(size) : references,
        ...(type === 13
          ? { keys: references.slice(0, size).map(readDictionaryKey) }
          : {}),
      });
    active.add(entry.object);
    pending.push({
      object: entry.object,
      depth: entry.depth,
      exit: true,
      dictionaryKey: false,
    });
    for (let index = childCount - 1; index >= 0; index -= 1) {
      const reference = references[index]!;
      pending.push({
        object: reference,
        depth: entry.depth + 1,
        exit: false,
        dictionaryKey: type === 13 && index < size,
      });
    }
    if (
      referenceSize !== normalizedReferenceSize &&
      !containersToNormalize.has(offset)
    )
      containersToNormalize.set(offset, {
        offset,
        headerLength: cursor - offset,
        references,
      });
    pendingObjectCount += childCount;
  }
  const uidOffsetsToNormalize = [...uidWidthsToNormalize]
    .map(([offset, width]) => ({ offset, width }))
    .sort((left, right) => left.offset - right.offset);
  const normalizedContainers = [...containersToNormalize.values()].sort(
    (left, right) => left.offset - right.offset,
  );
  const containerCloneLengths = normalizedContainers.map(
    ({ headerLength, references }) => {
      const cloneLength =
        headerLength + references.length * normalizedReferenceSize;
      if (!Number.isSafeInteger(cloneLength))
        throw unsupportedInput(
          "plist",
          "binary plist reference table is too large",
        );
      return cloneLength;
    },
  );
  const normalizeOffsetWidth = (cloneLengths: readonly number[]) => {
    if (cloneLengths.length === 0 && [1, 2, 4, 8].includes(offsetSize))
      return offsetSize;
    const width = binaryPlistCloneOffsetWidth(
      offsetSize,
      trailer,
      cloneLengths,
    );
    if (width === undefined)
      throw unsupportedInput(
        "plist",
        "binary plist object offset exceeds supported width",
      );
    return width;
  };
  if (!numberProjection) {
    const cloneLengths = [
      ...uidOffsetsToNormalize.map(({ width }) => width + 1),
      ...containerCloneLengths,
    ];
    const normalizedOffsetSize = normalizeOffsetWidth(cloneLengths);
    if (
      cloneLengths.length > 0 ||
      normalizedOffsetSize !== offsetSize ||
      normalizedReferenceSize !== referenceSize
    ) {
      const cloneBytes = cloneLengths.reduce((sum, length) => sum + length, 0);
      estimate += 2 * (cloneBytes + objectCount * normalizedOffsetSize);
      if (estimate > maxBytes)
        throw decodeBudgetExceeded(
          `binary plist UID-copy expansion exceeds ${budget}`,
          maxBytes,
        );
    }
    return {
      estimatedBytes: estimate,
      binaryValuePlan: {
        topObject,
        scalars: [...scalarObjects.values()],
        containers: [...sourceContainers.values()],
        uidIdentity: uidProjection,
      },
      datePrecisionOverlapCount: 0,
      reachableDateOffsets: [],
      overlappingDateOffsets: [],
      reachableWideIntegerOffsets: [],
      overlappingWideIntegerOffsets: [],
      reachableNumericOffsets: [],
      uidOffsetsToNormalize,
      containersToNormalize: normalizedContainers,
      normalizedOffsetSize,
      normalizedReferenceSize,
    };
  }

  // Distinct objects can legally overlap in binary plists. Rewriting a date or
  // wide integer in place could change another reachable value, so isolate
  // affected scalar records in the decoder copy. Track both overlap directions
  // using the same bounded span parser as scalar collection.
  const reachableSpans = [...reachableObjectOffsets]
    .map((offset) => ({
      offset,
      end: binaryPlistObjectEnd(bytes, offset, objectsEnd, referenceSize),
    }))
    .filter(
      (span): span is { offset: number; end: number } => span.end !== undefined,
    )
    .sort((left, right) => left.offset - right.offset);
  const overlappingDateOffsets = findOverlappingScalarOffsets(
    reachableSpans,
    reachableDateOffsets,
  );
  const overlappingWideIntegerOffsets = findOverlappingScalarOffsets(
    reachableSpans,
    reachableWideIntegerOffsets,
  );
  const precisionUnknownDateOffsets = [...overlappingDateOffsets]
    .filter((offset) => {
      const seconds = reader.f64(offset + 1);
      return binaryDateRequiresExactSeconds(seconds);
    })
    .sort((left, right) => left - right);
  const cloneOffsets = new Set([
    ...precisionUnknownDateOffsets,
    ...overlappingWideIntegerOffsets,
  ]);
  const cloneLengths = [
    ...uidOffsetsToNormalize.map(({ width }) => width + 1),
    ...containerCloneLengths,
    ...Array.from(cloneOffsets, () => 9),
  ];
  const normalizedOffsetSize = normalizeOffsetWidth(cloneLengths);
  if (
    cloneLengths.length > 0 ||
    normalizedOffsetSize !== offsetSize ||
    normalizedReferenceSize !== referenceSize
  ) {
    const cloneBytes = cloneLengths.reduce((sum, length) => sum + length, 0);
    estimate += 2 * (cloneBytes + objectCount * normalizedOffsetSize);
    if (estimate > maxBytes)
      throw decodeBudgetExceeded(
        `binary plist scalar-copy expansion exceeds ${budget}`,
        maxBytes,
      );
  }
  const precisionUnknownOffsets = new Set(precisionUnknownDateOffsets);
  const datePrecisionOverlapCount = reachableDateOccurrences.filter((offset) =>
    precisionUnknownOffsets.has(offset),
  ).length;
  return {
    estimatedBytes: estimate,
    binaryValuePlan: {
      topObject,
      scalars: [...scalarObjects.values()],
      containers: [...sourceContainers.values()],
      uidIdentity: uidProjection,
    },
    datePrecisionOverlapCount,
    reachableDateOffsets: [...reachableDateOffsets].sort(
      (left, right) => left - right,
    ),
    overlappingDateOffsets: precisionUnknownDateOffsets,
    reachableWideIntegerOffsets: [...reachableWideIntegerOffsets].sort(
      (left, right) => left - right,
    ),
    overlappingWideIntegerOffsets: [...overlappingWideIntegerOffsets].sort(
      (left, right) => left - right,
    ),
    reachableNumericOffsets: [...reachableNumericOffsets].sort(
      (left, right) => left - right,
    ),
    uidOffsetsToNormalize,
    containersToNormalize: normalizedContainers,
    normalizedOffsetSize,
    normalizedReferenceSize,
  };
};
