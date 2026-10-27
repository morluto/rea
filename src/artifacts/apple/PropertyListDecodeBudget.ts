import {
  readBinaryPlistLayout,
  readBinaryPlistUnsigned64,
} from "./BinaryPlistLayout.js";
import { decodeXmlPlistText } from "../../domain/propertyListXmlText.js";
import { hasBinaryPlistSignature } from "../../domain/apple/appleArchiveFormat.js";
import {
  binaryPlistCloneOffsetWidth,
  binaryDateRequiresExactSeconds,
  binaryPlistObjectEnd,
  binaryPlistUidNormalizationWidth,
} from "./PlistScalars.js";

/** Preflight the representation created by the pinned plist decoder. */
export const preflightPropertyListDecode = (
  bytes: Buffer,
  maxBytes: number,
  xmlText?: string,
  options: Pick<
    BinaryPlistExpansionOptions,
    "numberProjection" | "uidProjection" | "budget" | "fail"
  > = {},
): PlistDecodePreflight => {
  const {
    numberProjection = false,
    uidProjection = false,
    budget = "the property list decode budget",
    fail = propertyListDecodeBudgetFailure,
  } = options;
  const expansion = hasBinaryPlistSignature(bytes)
    ? estimateBinaryPlistExpansion(bytes, maxBytes, {
        numberProjection,
        uidProjection,
        budget,
        fail,
      })
    : {
        estimatedBytes: estimateXmlPlistExpansion(
          bytes,
          maxBytes,
          xmlText,
          numberProjection,
          budget,
          fail,
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
  if (expansion.estimatedBytes > maxBytes)
    throw fail("expansion", `plist representation exceeds ${budget}`);
  return expansion;
};

const estimateXmlPlistExpansion = (
  bytes: Buffer,
  maxBytes: number,
  xmlText?: string,
  numberProjection = false,
  budget = "the property list decode budget",
  fail: (
    kind: BinaryPlistExpansionFailure,
    message: string,
  ) => Error = propertyListDecodeBudgetFailure,
): number => {
  const xml = xmlText ?? decodeXmlPlistText(bytes);
  const decodedSourceBytes = xml.length * 2;
  let elementCount = 0;
  // Reserve room for numeric source metadata and the projected attribute copy.
  const elementBytes = numberProjection ? 256 : 128;
  // Value nesting is bounded by the shared plist parser, which counts plist
  // value depth; raw element depth would also count the envelope and keys.
  for (const token of xmlPreflightTokens(xml)) {
    if (token.doctype) {
      // Only a declaration outside opaque text can introduce an internal
      // subset. Brackets in quoted external identifiers are literal text.
      if (token.internalSubset)
        throw fail(
          "expansion",
          `XML plist internal entity expansion exceeds ${budget}`,
        );
      continue;
    }
    elementCount += 1;
    if (decodedSourceBytes * 2 + elementCount * elementBytes > maxBytes)
      return maxBytes + 1;
  }
  return decodedSourceBytes * 2 + elementCount * elementBytes;
};

/** Consume each XML span once; malformed tokens cannot restart suffix scans. */
function* xmlPreflightTokens(xml: string) {
  let cursor = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf("<", cursor);
    if (start < 0) return;
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
      continue;
    }
    const doctype = /^<!DOCTYPE\b/iu.test(xml.slice(start, start + 10));
    const element = /^<\/?[A-Za-z]/u.test(xml.slice(start, start + 4));
    let quote: string | undefined;
    let internalSubset = false;
    let end = start + 1;
    for (; end < xml.length; end += 1) {
      const character = xml[end];
      if (quote !== undefined) {
        if (character === quote) quote = undefined;
      } else if (character === '"' || character === "'") quote = character;
      else if (character === ">") break;
      else if (doctype && character === "[") internalSubset = true;
    }
    if (end === xml.length) return;
    cursor = end + 1;
    if (doctype || element) yield { doctype, internalSubset };
  }
}

/** Deepest binary plist value nesting the reference walk admits. */
export const MAX_BINARY_PLIST_NESTING_DEPTH = 128;

/** Resource or structural failure found while preflighting a plist. */
export type BinaryPlistExpansionFailure = "cycle" | "depth" | "expansion";

/** Typed failure for shared plist preflight resource limits. */
export class PropertyListDecodeBudgetFailure extends Error {
  constructor(
    readonly kind: BinaryPlistExpansionFailure,
    message: string,
  ) {
    super(message);
    this.name = "PropertyListDecodeBudgetFailure";
  }
}

const propertyListDecodeBudgetFailure = (
  kind: BinaryPlistExpansionFailure,
  message: string,
): Error => new PropertyListDecodeBudgetFailure(kind, message);

/** How a caller names and reports binary plist expansion failures. */
export interface BinaryPlistExpansionOptions {
  /** Source-value depth; archive consumers retain the default 128-level allowance. */
  readonly maximumDepth?: number;
  /** Include original number metadata and exact-integer attribute projection. */
  readonly numberProjection?: boolean;
  /** Retain typed UID locations for Foundation archive interpretation. */
  readonly uidProjection?: boolean;
  /** Budget named in failure messages. */
  readonly budget?: string;
  /** Error for budget, depth, and reference-cycle failures. */
  readonly fail?: (kind: BinaryPlistExpansionFailure, message: string) => Error;
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
 * and independent container materialization. Malformed
 * structure throws TypeError; resource and cycle failures use `fail`.
 */
export const estimateBinaryPlistExpansion = (
  bytes: Buffer,
  maxBytes: number,
  {
    budget = "the property list decode budget",
    fail = propertyListDecodeBudgetFailure,
    bounds = "strict",
    numberProjection = false,
    uidProjection = false,
    maximumDepth = MAX_BINARY_PLIST_NESTING_DEPTH,
  }: BinaryPlistExpansionOptions = {},
): PlistDecodePreflight => {
  if (bytes.length < 40)
    throw new TypeError("binary plist trailer is truncated");
  const sourceLayoutResult = readBinaryPlistLayout(bytes);
  if (!sourceLayoutResult.ok)
    throw new TypeError("binary plist trailer is truncated");
  const sourceLayout = sourceLayoutResult.value;
  const {
    trailerOffset: trailer,
    offsetWidth: offsetSize,
    referenceWidth: referenceSize,
  } = sourceLayout;
  if (offsetSize < 1 || referenceSize < 1)
    throw new TypeError("binary plist trailer integer sizes are invalid");
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
    throw new TypeError("binary plist trailer or object table is invalid");
  if (
    (offsetSize < 8 && offsetTable >= 2 ** (offsetSize * 8)) ||
    (referenceSize < 8 && objectCount >= 2 ** (referenceSize * 8))
  )
    throw new TypeError("binary plist table width cannot address its contents");
  const normalizedReferenceSize =
    [1, 2, 4, 8].includes(referenceSize) &&
    (referenceSize === 8 || objectCount < 2 ** (referenceSize * 8))
      ? referenceSize
      : [1, 2, 4, 8].find(
          (width) => width === 8 || objectCount < 2 ** (width * 8),
        );
  if (normalizedReferenceSize === undefined)
    throw new TypeError("binary plist object reference count is invalid");
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
    throw fail("expansion", `binary plist object table exceeds ${budget}`);

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
  const dictionaryKeys = new Map<number, string>();
  const readDictionaryKey = (object: number): string => {
    const prior = dictionaryKeys.get(object);
    if (prior !== undefined) return prior;
    const offset = safeDeclaration(sourceLayout.objectOffset(object));
    if (offset < 8 || offset >= objectsEnd)
      throw new TypeError("binary plist object offset is invalid");
    const marker = bytes[offset] ?? 0;
    const type = marker >> 4;
    if (type !== 5 && type !== 6)
      throw new TypeError("binary plist dictionary key is not a string");
    let size = marker & 0x0f;
    let cursor = offset + 1;
    if (size === 15) {
      const extended = bytes[cursor] ?? 0;
      if (extended >> 4 !== 1 || (extended & 15) > 3)
        throw new TypeError("binary plist extended object size is invalid");
      const width = 1 << (extended & 15);
      size = readInteger(cursor + 1, width);
      cursor += 1 + width;
    }
    if (size < 0 || cursor + size * (type === 6 ? 2 : 1) > objectsEnd)
      throw new TypeError("binary plist scalar object is truncated");
    let key = "";
    for (let index = 0; index < size; index += 1)
      key += String.fromCharCode(
        type === 5
          ? bytes[cursor + index]!
          : bytes.readUInt16BE(cursor + index * 2),
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
      throw fail("depth", `binary plist nesting exceeds ${budget}`);
    if (active.has(entry.object))
      throw fail("cycle", `binary plist reference cycle exceeds ${budget}`);
    estimate += expandedNodeBytes;
    if (estimate > maxBytes)
      throw fail(
        "expansion",
        `binary plist reference expansion exceeds ${budget}`,
      );
    const offset = safeDeclaration(sourceLayout.objectOffset(entry.object));
    if (offset < 8 || offset >= objectsEnd)
      throw new TypeError("binary plist object offset is invalid");
    if (numberProjection) reachableObjectOffsets.add(offset);
    const marker = bytes[offset] ?? 0;
    const type = marker >> 4;
    if (type !== 10 && type !== 13)
      scalarObjects.set(entry.object, {
        object: entry.object,
        uid: type === 8,
      });
    if (entry.dictionaryKey && type !== 5 && type !== 6)
      throw new TypeError("binary plist dictionary key is not a string");
    if (type === 3) {
      if (marker !== 0x33)
        throw new TypeError(
          `binary plist date marker 0x${marker.toString(16)} is invalid`,
        );
      // The offset table and trailer are not part of an encoded object. Keep
      // this scalar boundary even when compatibility mode follows decoder
      // bounds for other object and reference checks.
      if (offset + 9 > offsetTable)
        throw new TypeError("binary plist date object is truncated");
      if (numberProjection) {
        reachableDateOffsets.add(offset);
        reachableDateOccurrences.push(offset);
      }
      continue;
    }
    if (type === 8) {
      const uidWidth = (marker & 0x0f) + 1;
      if (offset + 1 + uidWidth > objectsEnd)
        throw new TypeError("binary plist UID object is truncated");
      const normalizedWidth = binaryPlistUidNormalizationWidth(bytes, offset);
      if (normalizedWidth !== undefined)
        uidWidthsToNormalize.set(offset, normalizedWidth);
      continue;
    }
    if (type === 1 || type === 2) {
      const info = marker & 0x0f;
      if (type === 1 && info > 4)
        throw new TypeError("binary plist integer width is invalid");
      if (type === 2 && info !== 2 && info !== 3)
        throw new TypeError("binary plist real width is invalid");
      const width = 1 << info;
      if (offset + 1 + width > offsetTable)
        throw new TypeError("binary plist numeric scalar is truncated");
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
    const childCount = type === 13 ? size * 2 : size;
    const refsEnd = cursor + childCount * referenceSize;
    if (!Number.isSafeInteger(refsEnd) || refsEnd > objectsEnd)
      throw new TypeError("binary plist reference table is truncated");
    const availableNodes = Math.floor(
      (maxBytes - estimate) / expandedNodeBytes,
    );
    if (childCount > availableNodes - pendingObjectCount)
      throw fail(
        "expansion",
        `binary plist reference expansion exceeds ${budget}`,
      );
    const references = Array.from({ length: childCount }, (_, index) => {
      const reference = readInteger(
        cursor + index * referenceSize,
        referenceSize,
      );
      if (reference < 0 || reference >= objectCount)
        throw new TypeError("binary plist reference is invalid");
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
        throw new TypeError("binary plist reference table is too large");
      return cloneLength;
    },
  );
  const normalizeOffsetWidth = (cloneLengths: readonly number[]) => {
    const width = binaryPlistCloneOffsetWidth(
      offsetSize,
      offsetTable,
      cloneLengths,
    );
    if (width === undefined)
      throw new TypeError("binary plist object offset exceeds supported width");
    return width;
  };
  if (!numberProjection) {
    const cloneLengths = [
      ...uidOffsetsToNormalize.map(({ width }) => width + 1),
      ...containerCloneLengths,
    ];
    const normalizedOffsetSize = normalizeOffsetWidth(cloneLengths);
    if (cloneLengths.length > 0 || normalizedOffsetSize !== offsetSize) {
      const cloneBytes = cloneLengths.reduce((sum, length) => sum + length, 0);
      estimate +=
        2 * (cloneBytes + objectCount * (normalizedOffsetSize - offsetSize));
      if (estimate > maxBytes)
        throw fail(
          "expansion",
          `binary plist UID-copy expansion exceeds ${budget}`,
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
      const seconds = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      ).getFloat64(offset + 1);
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
  if (cloneLengths.length > 0 || normalizedOffsetSize !== offsetSize) {
    const cloneBytes = cloneLengths.reduce((sum, length) => sum + length, 0);
    estimate +=
      2 * (cloneBytes + objectCount * (normalizedOffsetSize - offsetSize));
    if (estimate > maxBytes)
      throw fail(
        "expansion",
        `binary plist scalar-copy expansion exceeds ${budget}`,
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
