import { invariantViolation } from "../internalInvariant.js";
import { readBinaryPlistLayout } from "./binaryPlistLayout.js";
import { parseBinary } from "plist";
import { markPlistDictionary } from "./plistUid.js";
import {
  createPlistDuplicateKeyCollector,
  type PlistDuplicateKeys,
} from "./plistDuplicateKeys.js";
import { isStrictUtf8 } from "../strictUtf8.js";
import { byteOrderMarkEncoding } from "../textByteOrderMark.js";
import type { ParsedPropertyList } from "../propertyListKeys.js";
import {
  binaryPlistObjectEnd,
  decodeBinaryPlistScalars,
  scanBinaryPlistScalars,
  type BinaryPlistScalarMetadata,
} from "./plistScalars.js";
import {
  preflightPropertyListDecode,
  type PlistDecodePreflight,
} from "./propertyListDecodeBudget.js";

/** Build one array of source scalar references; upstream never constructs a dictionary. */
const scalarArrayInput = (
  bytes: Buffer,
  objects: readonly number[],
): Buffer => {
  // Normalization may relocate objects and change both widths. These facts
  // belong to the compatible decoder copy, not the original source plan.
  const compatibleLayoutResult = readBinaryPlistLayout(bytes);
  if (!compatibleLayoutResult.ok)
    throw invariantViolation("binary plist decoder copy lost its trailer");
  const compatibleLayout = compatibleLayoutResult.value;
  const referenceWidth = compatibleLayout.referenceWidth;
  const objectCount = Number(compatibleLayout.objectCount);
  const rootOffset = bytes.length;
  const rootLength = 10 + objects.length * referenceWidth;
  const tableOffset = rootOffset + rootLength;
  const output = Buffer.alloc(tableOffset + (objectCount + 1) * 8 + 32);
  bytes.copy(output);
  output[rootOffset] = 0xaf;
  output[rootOffset + 1] = 0x13;
  output.writeBigUInt64BE(BigInt(objects.length), rootOffset + 2);
  for (const [index, object] of objects.entries()) {
    let reference = BigInt(object);
    const offset = rootOffset + 10 + index * referenceWidth;
    for (let byte = referenceWidth - 1; byte >= 0; byte -= 1) {
      output[offset + byte] = Number(reference & 0xffn);
      reference >>= 8n;
    }
  }
  let object = 0;
  for (const offset of compatibleLayout.objectOffsets()) {
    output.writeBigUInt64BE(offset, tableOffset + object * 8);
    object += 1;
  }
  output.writeBigUInt64BE(BigInt(rootOffset), tableOffset + objectCount * 8);
  const nextTrailer = output.length - 32;
  output[nextTrailer + 6] = 8;
  output[nextTrailer + 7] = referenceWidth;
  output.writeBigUInt64BE(BigInt(objectCount + 1), nextTrailer + 8);
  output.writeBigUInt64BE(BigInt(objectCount), nextTrailer + 16);
  output.writeBigUInt64BE(BigInt(tableOffset), nextTrailer + 24);
  return output;
};

/** Preserve each source reference's scalar identity while retaining upstream scalar semantics. */
const scalarOccurrence = (
  value: unknown,
  uid: boolean,
  identity: boolean,
): unknown => {
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof Uint8Array)
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (uid && value !== null && typeof value === "object") {
    const copy = { ...value };
    if (identity) markPlistDictionary(copy, (value as { UID: number }).UID);
    return copy;
  }
  return value;
};

/**
 * Keys each stored dictionary declares more than once. The decoded value
 * keeps one property per key, the last, so this reads the planned source keys.
 */
export const binaryPlistDuplicateKeys = (
  plan: PlistDecodePreflight,
): PlistDuplicateKeys => {
  const duplicates = createPlistDuplicateKeyCollector();
  for (const container of plan.binaryValuePlan?.containers ?? [])
    if (container.kind === "dictionary" && container.keys !== undefined)
      duplicates.dictionary(container.keys);
  return duplicates.result();
};

/**
 * A binary plist decoded with the source facts an XML or OpenStep decode
 * carries: number literals and the keys a dictionary repeats.
 */
export const decodeBinaryPropertyList = (
  bytes: Buffer,
  plan: PlistDecodePreflight,
  metadata: BinaryPlistScalarMetadata = scanBinaryPlistScalars(bytes, plan),
  options: { readonly exactIntegers?: boolean } = {},
): ParsedPropertyList => ({
  value: decodeBinaryPlistValue(bytes, plan, metadata, options),
  numberLiterals: metadata.literals,
  duplicateKeys: binaryPlistDuplicateKeys(plan),
});

/**
 * Decode validated source containers without losing dictionary keys or alias occurrence identity.
 * With `exactIntegers`, an integer object beyond the exact range of a JSON number decodes as its
 * exact `bigint` source value instead of the pinned decoder's rounded number.
 */
export const decodeBinaryPlistValue = (
  bytes: Buffer,
  plan: PlistDecodePreflight,
  metadata: BinaryPlistScalarMetadata = scanBinaryPlistScalars(bytes, plan),
  { exactIntegers = false }: { readonly exactIntegers?: boolean } = {},
): unknown => {
  const source = plan.binaryValuePlan;
  if (source === undefined)
    throw invariantViolation("Binary plist source plan is missing");
  const compatible = decodeBinaryPlistScalars(bytes, metadata, plan);
  const scalars = parseBinary(
    scalarArrayInput(
      compatible,
      source.scalars.map(({ object }) => object),
    ),
  ) as unknown[];
  if (exactIntegers && metadata.exactIntegers.length > 0) {
    const layout = readBinaryPlistLayout(bytes);
    if (!layout.ok) throw new RangeError("binary plist trailer is truncated");
    const exact = new Map(
      metadata.exactIntegers.map(({ offset, value }) => [offset, value]),
    );
    source.scalars.forEach(({ object }, index) => {
      const value = exact.get(Number(layout.value.objectOffset(object)));
      if (value !== undefined) scalars[index] = value;
    });
  }
  const scalarIndex = new Map(
    source.scalars.map((scalar, index) => [scalar.object, index]),
  );
  const containers = new Map(
    source.containers.map((container) => [container.object, container]),
  );
  const root: { value?: unknown } = {};
  const pending: { object: number; parent: object; key: string | number }[] = [
    { object: source.topObject, parent: root, key: "value" },
  ];
  while (pending.length > 0) {
    const entry = pending.pop()!;
    const container = containers.get(entry.object);
    let value: unknown;
    if (container === undefined) {
      const index = scalarIndex.get(entry.object);
      if (index === undefined)
        throw invariantViolation("Binary plist scalar source is missing");
      value = scalarOccurrence(
        scalars[index],
        source.scalars[index]!.uid,
        source.uidIdentity,
      );
    } else {
      value = container.kind === "array" ? [] : {};
      if (container.kind === "dictionary" && source.uidIdentity)
        markPlistDictionary(value as object);
      for (let index = container.references.length - 1; index >= 0; index -= 1)
        pending.push({
          object: container.references[index]!,
          parent: value as object,
          key: container.keys?.[index] ?? index,
        });
    }
    Object.defineProperty(entry.parent, entry.key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return root.value;
};

/** The payload of one stored string or data object, or null for any other type. */
const storedPlistPayload = (
  bytes: Buffer,
  offset: number,
  objectEnd: number,
  referenceWidth: number,
):
  | { readonly type: number; readonly payload: Buffer }
  | "unreadable"
  | null => {
  if (offset < 8 || offset >= objectEnd) return "unreadable";
  const marker = bytes[offset];
  if (marker === undefined) return "unreadable";
  const type = marker >> 4;
  if (type !== 4 && type !== 5 && type !== 6 && type !== 7) return null;
  const end = binaryPlistObjectEnd(bytes, offset, objectEnd, referenceWidth);
  if (end === undefined) return "unreadable";
  const start =
    (marker & 0x0f) === 0x0f
      ? offset + 2 + (1 << (bytes[offset + 1]! & 0x0f))
      : offset + 1;
  return { type, payload: bytes.subarray(start, end) };
};

const WIDE_DECODERS = {
  "utf-16le": {
    strip: {
      fatal: new TextDecoder("utf-16le", { fatal: true, ignoreBOM: false }),
      lossy: new TextDecoder("utf-16le", { fatal: false, ignoreBOM: false }),
    },
    keep: {
      fatal: new TextDecoder("utf-16le", { fatal: true, ignoreBOM: true }),
      lossy: new TextDecoder("utf-16le", { fatal: false, ignoreBOM: true }),
    },
  },
  "utf-16be": {
    strip: {
      fatal: new TextDecoder("utf-16be", { fatal: true, ignoreBOM: false }),
      lossy: new TextDecoder("utf-16be", { fatal: false, ignoreBOM: false }),
    },
    keep: {
      fatal: new TextDecoder("utf-16be", { fatal: true, ignoreBOM: true }),
      lossy: new TextDecoder("utf-16be", { fatal: false, ignoreBOM: true }),
    },
  },
} as const;

/** Decode declared wide text while preserving readable portions on a malformed input. */
const storedWideText = (
  payload: Buffer,
  encoding: "utf-16le" | "utf-16be",
  ignoreBOM: boolean,
): BinaryPlistText => {
  const decoders = WIDE_DECODERS[encoding][ignoreBOM ? "keep" : "strip"];
  try {
    const text = decoders.fatal.decode(payload);
    return { text, complete: true };
  } catch (cause: unknown) {
    if (!(cause instanceof TypeError)) throw cause;
    return {
      text: decoders.lossy.decode(payload),
      complete: false,
    };
  }
};

/** Scan data bytes as before unless a byte order mark names a specific encoding. */
const storedDataText = (payload: Buffer): BinaryPlistText | null => {
  const encoding = byteOrderMarkEncoding(payload);
  if (encoding === "utf-32") return null;
  if (encoding !== null) return storedWideText(payload, encoding, false);
  const text = payload.toString("utf8");
  // This decode preserves a UTF-8 BOM. It declares text just as a wide
  // mark does; unmarked data remains eligible for best-effort raw scanning.
  return {
    text,
    complete: !text.startsWith("\ufeff") || isStrictUtf8(payload),
  };
};

/** Decode a stored payload after its byte budget is admitted. */
const storedPlistText = (
  type: number,
  payload: Buffer,
): BinaryPlistText | null => {
  switch (type) {
    case 4:
      return storedDataText(payload);
    case 5:
      return { text: payload.toString("latin1"), complete: true };
    case 6:
      return storedWideText(payload, "utf-16be", true);
    default:
      return {
        text: payload.toString("utf8"),
        complete: isStrictUtf8(payload),
      };
  }
};

/** The text a binary plist stores; `complete` is false when part of it went unread. */
export interface BinaryPlistText {
  readonly text: string;
  readonly complete: boolean;
}

/**
 * Decode every string, dictionary key and data payload a binary plist stores.
 * Its strings are stored per object as ASCII, UTF-16BE or UTF-8, so the raw
 * bytes do not show them all. This reads the object table rather than the
 * decoded value, because a value drops objects its root no longer references
 * and entries a later duplicate key replaced, and those bytes still ship.
 * A stored object it cannot read, or text past `maxBytes` from table entries
 * that overlap, leaves the result incomplete and keeps the text already read.
 * Throws on a plist that cannot be decoded within `maxBytes`.
 */
export const decodeBinaryPlistText = (
  bytes: Buffer,
  maxBytes: number,
): BinaryPlistText => {
  decodeBinaryPlistValue(bytes, preflightPropertyListDecode(bytes, maxBytes));
  const layout = readBinaryPlistLayout(bytes);
  if (!layout.ok)
    throw invariantViolation(
      "binary plist trailer was not validated by its preflight",
    );
  const texts: string[] = [];
  let decoded = 0;
  let complete = true;
  // Strict preflight admitted the offset-table position. The table begins
  // immediately after the object area and is separate from the trailer.
  const objectEnd = Number(layout.value.offsetTable);
  for (const offset of new Set(layout.value.objectOffsets())) {
    const stored = storedPlistPayload(
      bytes,
      Number(offset),
      objectEnd,
      layout.value.referenceWidth,
    );
    if (stored === null) continue;
    if (stored === "unreadable" || decoded + stored.payload.length > maxBytes) {
      complete = false;
      continue;
    }
    decoded += stored.payload.length;
    const text = storedPlistText(stored.type, stored.payload);
    if (text?.complete !== true) complete = false;
    if (text !== null) texts.push(text.text);
  }
  return { text: texts.join("\n"), complete };
};
