import {
  ASN1_MAX_TAG_NUMBER_OCTETS,
  Asn1BerFailure,
  Asn1BerReader,
  readAsn1BerHeader,
  type Asn1BerHeader,
  type Asn1BerNode,
  type Asn1TagClass,
} from "../asn1Ber.js";
import { BinaryReader } from "../binaryContainer.js";
import { Budget } from "../budget.js";
import {
  decodeLimit,
  malformedInput,
  truncatedInput,
  ParseFailureError,
} from "../parseFailure.js";
import { byteToHex } from "../../kernel/byteToHex.js";

/** Image4 DER nesting. Real containers sit well under this. */
export const IMAGE4_MAX_DEPTH = 32;
/** TLV values, including one unparsed payload octet string. */
export const IMAGE4_MAX_ELEMENTS = 4096;
/** Manifest and restore property rows retained on one container. */
export const IMAGE4_MAX_PROPERTIES = 256;
/** One IA5, UTF-8 or PrintableString retained as text. */
export const IMAGE4_MAX_STRING_BYTES = 4096;
/** Octet properties rendered as hex. Longer values are omitted. */
export const IMAGE4_MAX_OCTET_HEX_BYTES = 64;
/** INTEGER contents decoded as a decimal string. */
export const IMAGE4_MAX_INTEGER_BYTES = 16;
/**
 * Largest definite DER value parsed as a tree. Larger values are walked by
 * header so a payload octet string is a range, not a loaded buffer. This is
 * a parse strategy, not a refusal.
 */
export const IMAGE4_MAX_NESTED_BYTES = 256 * 1024;

export const IMAGE4_DER_DEPTH_LIMIT = "image4_der_depth";
export const IMAGE4_DER_ELEMENTS_LIMIT = "image4_der_elements";
export const IMAGE4_PROPERTIES_LIMIT = "image4_properties";
export const IMAGE4_STRING_BYTES_LIMIT = "image4_string_bytes";

const FORMAT = "apple-img4";

export type Image4Magic = "IMG4" | "IM4P" | "IM4M";
/**
 * LZFSE block magics. `bvx2` is v2, `bvx1` is v1, `bvxn` is LZVN, and `bvx-`
 * is a raw block. Each one is compressed storage, not plain payload bytes.
 */
export const IMAGE4_LZFSE_MAGICS = ["bvx2", "bvx1", "bvxn", "bvx-"] as const;
export type Image4LzfseMagic = (typeof IMAGE4_LZFSE_MAGICS)[number];
export const IMAGE4_COMPRESSIONS = [
  "none",
  ...IMAGE4_LZFSE_MAGICS,
  "complzss",
] as const;
export const IMAGE4_PAYLOAD_MAGICS = [
  ...IMAGE4_LZFSE_MAGICS,
  "complzss",
] as const;
export type Image4Compression = (typeof IMAGE4_COMPRESSIONS)[number];
export type Image4PayloadMagic = (typeof IMAGE4_PAYLOAD_MAGICS)[number];

export interface Image4PropertyValueInteger {
  readonly type: "integer";
  readonly decimal: string;
}
export interface Image4PropertyValueBoolean {
  readonly type: "boolean";
  readonly value: boolean;
}
export interface Image4PropertyValueOctet {
  readonly type: "octet";
  readonly hex: string;
}
export interface Image4PropertyValueOmitted {
  readonly type: "omitted";
  readonly byte_length: number;
}
export type Image4PropertyValue =
  | Image4PropertyValueInteger
  | Image4PropertyValueBoolean
  | Image4PropertyValueOctet
  | Image4PropertyValueOmitted;

export interface Image4Property {
  name: string;
  value: Image4PropertyValue;
}

export interface Image4ObjectFacts {
  name: string;
  digest_hex: string | null;
  properties: Image4Property[];
}

export interface Image4PayloadFacts {
  type: string;
  description: string;
  offset: number;
  length: number;
  compression: Image4Compression;
  uncompressed_size: number | null;
  payload_magic: Image4PayloadMagic | null;
  encrypted: boolean;
  keybag_count: number;
  keybag_types: number[];
}

export interface Image4ManifestFacts {
  /** Unsigned decimal, or null when the version element was not one. */
  version: string | null;
  properties: Image4Property[];
  objects: Image4ObjectFacts[];
  signature_size: number | null;
  certificate_chain_size: number | null;
}

export interface Image4RestoreFacts {
  properties_present: string[];
  values: "redacted";
}

export interface Image4Facts {
  kind: "apple-img4";
  magic: Image4Magic;
  payload: Image4PayloadFacts | null;
  manifest: Image4ManifestFacts | null;
  restore_info: Image4RestoreFacts | null;
  /** Bytes after a container whose end was found, or null when it was not. */
  trailing_bytes: number | null;
}

export interface Image4EntryFact {
  readonly role: "payload" | "manifest" | "restore-info";
  readonly path: "payload" | "manifest.der" | "restore-info.der";
  readonly offset: number;
  readonly length: number;
  readonly encrypted: boolean;
  readonly compression: Image4Compression;
}

export type Image4Inspection =
  | { readonly kind: "unrecognized"; readonly detail: string }
  | {
      readonly kind: "image4";
      readonly facts: Image4Facts;
      readonly entries: readonly Image4EntryFact[];
      readonly limitations: readonly string[];
    };

/** Random-access bytes. A short read is truncation. */
export interface Image4ByteSource {
  readonly length: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

const MAGICS = new Set<string>(["IMG4", "IM4P", "IM4M"]);

/**
 * True when `prefix` begins with a DER SEQUENCE whose first element is the
 * IA5String `IMG4`, `IM4P` or `IM4M`.
 */
export const image4PrefixMagic = (
  prefix: Uint8Array,
): Image4Magic | undefined => {
  if (prefix.length < 8 || prefix[0] !== 0x30) return undefined;
  const lengthByte = prefix[1];
  if (lengthByte === undefined) return undefined;
  let cursor = 2;
  if (lengthByte !== 0x80 && (lengthByte & 0x80) !== 0) {
    const width = lengthByte & 0x7f;
    if (width < 1 || width > 4) return undefined;
    cursor += width;
  }
  if (cursor + 6 > prefix.length) return undefined;
  if (prefix[cursor] !== 0x16 || prefix[cursor + 1] !== 4) return undefined;
  const magic = String.fromCharCode(
    prefix[cursor + 2] ?? 0,
    prefix[cursor + 3] ?? 0,
    prefix[cursor + 4] ?? 0,
    prefix[cursor + 5] ?? 0,
  );
  return MAGICS.has(magic) ? (magic as Image4Magic) : undefined;
};

/** @see image4PrefixMagic */
export const hasImage4Prefix = (prefix: Uint8Array): boolean =>
  image4PrefixMagic(prefix) !== undefined;

const depthLimit = (): never => {
  throw decodeLimit(
    FORMAT,
    `Image4 DER nesting exceeds ${IMAGE4_MAX_DEPTH} levels. This release has no runtime override.`,
    { name: IMAGE4_DER_DEPTH_LIMIT, maximum: IMAGE4_MAX_DEPTH },
  );
};

const elementLimit = (): never => {
  throw decodeLimit(
    FORMAT,
    `Image4 DER element count exceeds ${IMAGE4_MAX_ELEMENTS}. This release has no runtime override.`,
    { name: IMAGE4_DER_ELEMENTS_LIMIT, maximum: IMAGE4_MAX_ELEMENTS },
  );
};

const propertyLimit = (): never => {
  throw decodeLimit(
    FORMAT,
    `Image4 property count exceeds ${IMAGE4_MAX_PROPERTIES}. This release has no runtime override.`,
    { name: IMAGE4_PROPERTIES_LIMIT, maximum: IMAGE4_MAX_PROPERTIES },
  );
};

const stringLimit = (offset: number, length: number): never => {
  throw decodeLimit(
    FORMAT,
    `Image4 string at offset ${offset} is ${length} bytes, above the ${IMAGE4_MAX_STRING_BYTES}-byte allowance. This release has no runtime override.`,
    { name: IMAGE4_STRING_BYTES_LIMIT, maximum: IMAGE4_MAX_STRING_BYTES },
    { offset },
  );
};

class Notes {
  readonly items: string[] = [];
  readonly #seen = new Set<string>();

  add(message: string): void {
    if (this.#seen.has(message)) return;
    this.#seen.add(message);
    this.items.push(message);
  }
}

class PropertyCounter {
  readonly #rows = new Budget(IMAGE4_MAX_PROPERTIES);

  charge(): void {
    this.#rows.charge(1, propertyLimit);
  }
}

interface TlvHeader {
  readonly tag: number;
  readonly tagClass: Asn1TagClass;
  readonly tagNumber: number;
  readonly constructed: boolean;
  readonly indefinite: boolean;
  readonly start: number;
  readonly contentStart: number;
  readonly contentEnd: number;
  readonly end: number;
  readonly nonMinimal: boolean;
}

type DerValue =
  | {
      readonly kind: "node";
      readonly node: Asn1BerNode;
      readonly base: number;
      readonly end: number;
    }
  | { readonly kind: "span"; readonly header: TlvHeader }
  | { readonly kind: "stopped"; readonly offset: number };

const readExact = async (
  source: Image4ByteSource,
  offset: number,
  length: number,
): Promise<Buffer> => {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > source.length
  )
    throw truncatedInput(
      FORMAT,
      `Image4 value at offset ${offset} extends past the ${source.length}-byte file.`,
      { offset },
    );
  if (length === 0) return Buffer.alloc(0);
  const chunk = await source.read(offset, length);
  if (chunk.length !== length)
    throw truncatedInput(
      FORMAT,
      `Image4 read at offset ${offset} returned ${chunk.length} of ${length} bytes.`,
      { offset },
    );
  return Buffer.from(chunk);
};

const countNodes = (node: Asn1BerNode): number => {
  let count = 1;
  for (const child of node.children) count += countNodes(child);
  return count;
};

const minimalWidth = (length: number): number =>
  length < 0x100 ? 1 : length < 0x10000 ? 2 : length < 0x1000000 ? 3 : 4;

/** True when the length octets are not the DER minimum for the content. */
const nonMinimalLengthOctets = (
  lengthOctets: number,
  contentLength: number,
): boolean =>
  contentLength < 0x80
    ? lengthOctets !== 1
    : lengthOctets - 1 !== minimalWidth(contentLength);

/** Identifier octets plus up to four long-form length octets. */
const MAX_HEADER_BYTES = 1 + ASN1_MAX_TAG_NUMBER_OCTETS + 1 + 4;

const berFailure = (cause: Asn1BerFailure, offset: number): never => {
  if (cause.truncated)
    throw truncatedInput(FORMAT, cause.message, { offset, cause });
  throw malformedInput(FORMAT, cause.message, { offset, cause });
};

/**
 * Reads one identifier and length through the shared BER header decoder so a
 * large payload is ranged without loading its content.
 */
const readHeader = async (
  source: Image4ByteSource,
  offset: number,
  limit: number,
): Promise<TlvHeader> => {
  if (offset >= limit || offset + 2 > limit)
    throw truncatedInput(
      FORMAT,
      `Image4 value at offset ${offset} is truncated.`,
      { offset },
    );
  const peek = await readExact(
    source,
    offset,
    Math.min(MAX_HEADER_BYTES, limit - offset),
  );
  let header: Asn1BerHeader;
  try {
    header = readAsn1BerHeader(peek, 0, peek.length);
  } catch (cause: unknown) {
    if (!(cause instanceof Asn1BerFailure)) throw cause;
    return berFailure(cause, offset);
  }
  const contentStart = offset + header.headerLength;
  if (header.length === null)
    return {
      ...header,
      indefinite: true,
      start: offset,
      contentStart,
      contentEnd: limit,
      end: limit,
      nonMinimal: false,
    };
  const contentEnd = contentStart + header.length;
  if (!Number.isSafeInteger(contentEnd) || contentEnd > limit)
    throw truncatedInput(
      FORMAT,
      `Image4 value at offset ${offset} extends past its parent.`,
      { offset },
    );
  return {
    ...header,
    indefinite: false,
    start: offset,
    contentStart,
    contentEnd,
    end: contentEnd,
    nonMinimal: nonMinimalLengthOctets(
      header.headerLength - header.identifierLength,
      header.length,
    ),
  };
};

const parseDer = (
  bytes: Buffer,
  maxNodes: number,
  maxDepth: number,
): Asn1BerNode => {
  try {
    return new Asn1BerReader(bytes, maxNodes, maxDepth).read();
  } catch (cause: unknown) {
    if (!(cause instanceof Asn1BerFailure)) throw cause;
    if (cause.constraint?.resource === "depth") depthLimit();
    if (cause.constraint?.resource === "nodes") elementLimit();
    if (cause.truncated) throw truncatedInput(FORMAT, cause.message, { cause });
    throw malformedInput(FORMAT, cause.message, { cause });
  }
};

const identifierOctets = (node: Asn1BerNode): number => {
  if ((node.tag & 0x1f) !== 0x1f) return 1;
  let octets = 1;
  for (let rest = node.tagNumber; rest > 0; rest = Math.floor(rest / 128))
    octets += 1;
  return octets;
};

const nonMinimalLength = (node: Asn1BerNode): boolean =>
  node.lengthForm === "definite" &&
  nonMinimalLengthOctets(
    node.contentStart - node.start - identifierOctets(node),
    node.contentEnd - node.contentStart,
  );

const isNonMinimalInteger = (bytes: Uint8Array): boolean => {
  if (bytes.length <= 1) return false;
  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;
  return (
    (first === 0x00 && (second & 0x80) === 0) ||
    (first === 0xff && (second & 0x80) !== 0)
  );
};

const noteStructure = (node: Asn1BerNode, notes: Notes, base: number): void => {
  const offset = base + node.start;
  if (node.lengthForm === "indefinite")
    notes.add(`Image4 value at offset ${offset} uses indefinite length.`);
  else if (nonMinimalLength(node))
    notes.add(`Image4 value at offset ${offset} uses a non-minimal length.`);
  if (
    node.constructed &&
    (node.tag === 0x16 ||
      node.tag === 0x0c ||
      node.tag === 0x13 ||
      node.tag === 0x04)
  )
    notes.add(
      `Image4 value at offset ${offset} is a constructed string or octet.`,
    );
  if (node.tag === 0x01 && !node.constructed) {
    const byte = node.content[0];
    if (node.content.length !== 1 || (byte !== 0x00 && byte !== 0xff))
      notes.add(`Image4 boolean at offset ${offset} is not canonical.`);
  }
  if (
    node.tag === 0x02 &&
    !node.constructed &&
    isNonMinimalInteger(node.content)
  )
    notes.add(`Image4 integer at offset ${offset} is not minimally encoded.`);
  for (const child of node.children) noteStructure(child, notes, base);
};

class Walk {
  readonly #elements = new Budget(IMAGE4_MAX_ELEMENTS);

  constructor(
    readonly source: Image4ByteSource,
    readonly notes: Notes,
  ) {}

  charge(count: number): void {
    this.#elements.charge(count, elementLimit);
  }

  adopt(bytes: Buffer, base: number, depth: number): DerValue {
    const remaining = this.#elements.remaining;
    const node = parseDer(bytes, remaining, IMAGE4_MAX_DEPTH - depth);
    this.charge(countNodes(node));
    noteStructure(node, this.notes, base);
    return { kind: "node", node, base, end: base + node.end };
  }

  async readValue(
    offset: number,
    depth: number,
    limit: number,
  ): Promise<DerValue> {
    if (depth > IMAGE4_MAX_DEPTH) depthLimit();
    const header = await readHeader(this.source, offset, limit);
    if (header.indefinite) {
      const span = limit - offset;
      if (span > IMAGE4_MAX_NESTED_BYTES) {
        this.notes.add(
          `Image4 value at offset ${offset} uses indefinite length and is not bounded within ${IMAGE4_MAX_NESTED_BYTES} bytes.`,
        );
        this.charge(1);
        return { kind: "stopped", offset };
      }
      return this.adopt(
        await readExact(this.source, offset, span),
        offset,
        depth,
      );
    }
    if (header.nonMinimal)
      this.notes.add(
        `Image4 value at offset ${offset} uses a non-minimal length.`,
      );
    const contentLength = header.contentEnd - header.contentStart;
    if (
      !header.constructed &&
      (header.tag === 0x16 || header.tag === 0x0c || header.tag === 0x13) &&
      contentLength > IMAGE4_MAX_STRING_BYTES
    )
      stringLimit(header.contentStart, contentLength);
    const encoded = header.end - header.start;
    if (encoded <= IMAGE4_MAX_NESTED_BYTES)
      return this.adopt(
        await readExact(this.source, offset, encoded),
        offset,
        depth,
      );
    this.charge(1);
    if (
      header.constructed &&
      (header.tag === 0x16 ||
        header.tag === 0x0c ||
        header.tag === 0x13 ||
        header.tag === 0x04)
    )
      this.notes.add(
        `Image4 value at offset ${offset} is a constructed string or octet.`,
      );
    return { kind: "span", header };
  }
}

const endOf = (value: DerValue): number => {
  if (value.kind === "node") return value.end;
  if (value.kind === "span") return value.header.end;
  return value.offset;
};

const fileOffset = (value: DerValue): number => {
  if (value.kind === "node") return value.base + value.node.start;
  if (value.kind === "span") return value.header.start;
  return value.offset;
};

const tagOf = (value: DerValue): number | undefined => {
  if (value.kind === "node") return value.node.tag;
  if (value.kind === "span") return value.header.tag;
  return undefined;
};

const tagNumberOf = (value: DerValue): number | undefined => {
  if (value.kind === "node") return value.node.tagNumber;
  if (value.kind === "span") return value.header.tagNumber;
  return undefined;
};

const isPrivateTagged = (value: DerValue): boolean => {
  if (value.kind === "node")
    return value.node.tagClass === "private" && value.node.constructed;
  if (value.kind === "span")
    return value.header.tagClass === "private" && value.header.constructed;
  return false;
};

const isConstructed = (value: DerValue): boolean => {
  if (value.kind === "node") return value.node.constructed;
  if (value.kind === "span") return value.header.constructed;
  return false;
};

const contentRange = (
  value: DerValue,
): { offset: number; length: number } | undefined => {
  if (value.kind === "node")
    return {
      offset: value.base + value.node.contentStart,
      length: value.node.contentEnd - value.node.contentStart,
    };
  if (value.kind === "span" && !value.header.indefinite)
    return {
      offset: value.header.contentStart,
      length: value.header.contentEnd - value.header.contentStart,
    };
  return undefined;
};

const encodedRange = (
  value: DerValue,
): { offset: number; length: number } | undefined => {
  if (value.kind === "stopped") return undefined;
  const offset = fileOffset(value);
  const end = endOf(value);
  if (end < offset) return undefined;
  return { offset, length: end - offset };
};

const childrenOf = async (
  value: DerValue,
  walk: Walk,
  depth: number,
): Promise<DerValue[]> => {
  if (value.kind === "stopped") return [];
  if (value.kind === "node")
    return value.node.children.map((child) => ({
      kind: "node" as const,
      node: child,
      base: value.base,
      end: value.base + child.end,
    }));
  if (!value.header.constructed) return [];
  const children: DerValue[] = [];
  let cursor = value.header.contentStart;
  while (cursor < value.header.contentEnd) {
    const child = await walk.readValue(
      cursor,
      depth + 1,
      value.header.contentEnd,
    );
    if (child.kind === "stopped") {
      children.push(child);
      break;
    }
    const end = endOf(child);
    if (end <= cursor)
      throw malformedInput(FORMAT, "DER value did not advance.", {
        offset: cursor,
      });
    children.push(child);
    cursor = end;
  }
  return children;
};

const hexTag = (tag: number | undefined): string => byteToHex(tag ?? 0);

/** A 32-bit tag number as four printable ASCII characters, such as `MANB`. */
const fourCharCode = (tagNumber: number | undefined): string | undefined => {
  if (
    tagNumber === undefined ||
    !Number.isSafeInteger(tagNumber) ||
    tagNumber < 0 ||
    tagNumber > 0xffffffff
  )
    return undefined;
  const text = String.fromCharCode(
    Math.floor(tagNumber / 0x1000000) & 0xff,
    (tagNumber >>> 16) & 0xff,
    (tagNumber >>> 8) & 0xff,
    tagNumber & 0xff,
  );
  return /^[\x20-\x7e]{4}$/u.test(text) ? text : undefined;
};

const unknownTag = (value: DerValue, notes: Notes): void => {
  const tag = tagOf(value);
  const highTag = tag !== undefined && (tag & 0x1f) === 0x1f;
  const number = tagNumberOf(value);
  const label = highTag
    ? ` number ${String(number ?? 0)}${fourCharCode(number) === undefined ? "" : ` (${fourCharCode(number) ?? ""})`}`
    : "";
  notes.add(
    `Unknown Image4 tag 0x${hexTag(tag)}${label} at offset ${fileOffset(value)}`,
  );
};

const ia5Text = (value: DerValue | undefined): string | undefined => {
  if (value === undefined || value.kind !== "node") return undefined;
  const { node, base } = value;
  if (node.tag !== 0x16 && node.tag !== 0x0c && node.tag !== 0x13)
    return undefined;
  if (node.constructed) return undefined;
  if (node.content.length > IMAGE4_MAX_STRING_BYTES)
    stringLimit(base + node.contentStart, node.content.length);
  return node.content.toString("latin1");
};

/**
 * Image4 manifest and restore entries are a SEQUENCE { IA5String name, value }
 * wrapped in a constructed PRIVATE-class tag whose number is the same name as
 * a big-endian four-character code. Returns the inner SEQUENCE, or the value
 * itself when it is not so wrapped.
 */
const unwrapPrivate = async (
  value: DerValue,
  walk: Walk,
  depth: number,
  notes: Notes,
): Promise<DerValue> => {
  if (!isPrivateTagged(value)) return value;
  const kids = await childrenOf(value, walk, depth);
  const inner = kids[0];
  if (kids.length !== 1 || inner === undefined || tagOf(inner) !== 0x30)
    return value;
  const code = fourCharCode(tagNumberOf(value));
  const name = ia5Text((await childrenOf(inner, walk, depth + 1))[0]);
  if (name !== undefined && code !== name)
    notes.add(
      `Image4 entry ${printable(name) ?? "with an unprintable name"} at offset ${fileOffset(value)} has a private tag that does not match its name.`,
    );
  return inner;
};

const integerDecimal = (bytes: Uint8Array): string => {
  let magnitude = 0n;
  for (const byte of bytes) magnitude = (magnitude << 8n) | BigInt(byte);
  if (((bytes[0] ?? 0) & 0x80) !== 0)
    magnitude -= 1n << (BigInt(bytes.length) * 8n);
  return magnitude.toString(10);
};

const UNSIGNED_DECIMAL = /^(?:0|[1-9]\d{0,39})$/u;

const decodeInteger = (value: DerValue, notes: Notes): Image4PropertyValue => {
  const range = contentRange(value);
  const length = range?.length ?? 0;
  const offset = range?.offset ?? fileOffset(value);
  if (
    value.kind !== "node" ||
    value.node.constructed ||
    length === 0 ||
    length > IMAGE4_MAX_INTEGER_BYTES
  ) {
    notes.add(
      `Image4 integer at offset ${offset} is ${length} bytes; the value is omitted.`,
    );
    return { type: "omitted", byte_length: length };
  }
  return { type: "integer", decimal: integerDecimal(value.node.content) };
};

const decodeOctet = (value: DerValue, notes: Notes): Image4PropertyValue => {
  const range = contentRange(value);
  const length = range?.length ?? 0;
  if (
    value.kind !== "node" ||
    value.node.constructed ||
    length > IMAGE4_MAX_OCTET_HEX_BYTES
  ) {
    notes.add(
      `Image4 octet property is ${length} bytes; the value is omitted.`,
    );
    return { type: "omitted", byte_length: length };
  }
  return { type: "octet", hex: value.node.content.toString("hex") };
};

const decodeBoolean = (value: DerValue, notes: Notes): Image4PropertyValue => {
  if (value.kind !== "node" || value.node.content.length !== 1) {
    notes.add(
      `Image4 boolean at offset ${fileOffset(value)} is not canonical.`,
    );
    return {
      type: "omitted",
      byte_length: contentRange(value)?.length ?? 0,
    };
  }
  const byte = value.node.content[0] ?? 0;
  if (byte !== 0x00 && byte !== 0xff)
    notes.add(
      `Image4 boolean at offset ${fileOffset(value)} is not canonical.`,
    );
  return { type: "boolean", value: byte !== 0 };
};

const isScalar = (value: DerValue): boolean => {
  const tag = tagOf(value);
  return (
    !isConstructed(value) && (tag === 0x02 || tag === 0x01 || tag === 0x04)
  );
};

const scalarSlot = async (
  value: DerValue,
  walk: Walk,
  depth: number,
): Promise<DerValue | undefined> => {
  if (isScalar(value)) return value;
  const tag = tagOf(value);
  if ((tag !== 0x31 && tag !== 0x30) || !isConstructed(value)) return undefined;
  const kids = await childrenOf(value, walk, depth + 1);
  const only = kids[0];
  return kids.length === 1 && only !== undefined && isScalar(only)
    ? only
    : undefined;
};

const decodeScalar = (value: DerValue, notes: Notes): Image4PropertyValue => {
  const tag = tagOf(value);
  if (tag === 0x02) return decodeInteger(value, notes);
  if (tag === 0x01) return decodeBoolean(value, notes);
  if (tag === 0x04) return decodeOctet(value, notes);
  unknownTag(value, notes);
  return { type: "omitted", byte_length: contentRange(value)?.length ?? 0 };
};

type PropertyAttempt = "no" | "ignored" | Image4Property;

const tryProperty = async (
  value: DerValue,
  walk: Walk,
  depth: number,
  notes: Notes,
  counter: PropertyCounter,
): Promise<PropertyAttempt> => {
  const entry = await unwrapPrivate(value, walk, depth, notes);
  if (tagOf(entry) !== 0x30) return "no";
  const kids = await childrenOf(entry, walk, depth + 1);
  const name = ia5Text(kids[0]);
  if (name === undefined) return "no";
  if (name === "MANB" || name === "MANP" || name === "IM4M") return "no";
  const slot = kids[1];
  if (slot === undefined) return "no";
  const scalar = await scalarSlot(slot, walk, depth);
  if (scalar === undefined) return "no";
  if (name.length === 0) {
    notes.add(
      `Image4 property at offset ${fileOffset(value)} has an empty name.`,
    );
    return "ignored";
  }
  counter.charge();
  return { name, value: decodeScalar(scalar, notes) };
};

const takeProperties = async (
  value: DerValue,
  walk: Walk,
  depth: number,
  notes: Notes,
  counter: PropertyCounter,
  into: Image4Property[],
): Promise<void> => {
  const kids = await childrenOf(value, walk, depth);
  for (const kid of kids) {
    const attempt = await tryProperty(kid, walk, depth + 1, notes, counter);
    if (attempt === "no") unknownTag(kid, notes);
    else if (attempt !== "ignored") into.push(attempt);
  }
};

const uint32Integer = (value: DerValue | undefined): number | undefined => {
  if (value === undefined || value.kind !== "node" || value.node.constructed)
    return undefined;
  const bytes = value.node.content;
  if (bytes.length === 0 || bytes.length > 4) return undefined;
  if (((bytes[0] ?? 0) & 0x80) !== 0) return undefined;
  let number = 0;
  for (const byte of bytes) number = number * 256 + byte;
  return number;
};

const looksLikeKeybagEntry = (kids: readonly DerValue[]): boolean => {
  const type = kids[0];
  const iv = kids[1];
  const key = kids[2];
  return (
    type !== undefined &&
    iv !== undefined &&
    key !== undefined &&
    tagOf(type) === 0x02 &&
    !isConstructed(type) &&
    tagOf(iv) === 0x04 &&
    !isConstructed(iv) &&
    tagOf(key) === 0x04 &&
    !isConstructed(key)
  );
};

interface KeybagFacts {
  readonly count: number;
  readonly types: number[];
}

/** An octet string in the keybag slot that is not a decodable keybag. */
type KeybagAttempt = KeybagFacts | "unrecognized";

const finishKeybag = (
  entries: readonly (readonly DerValue[])[],
  notes: Notes,
): KeybagFacts => {
  const types: number[] = [];
  for (const entry of entries) {
    const type = uint32Integer(entry[0]);
    if (type === undefined) {
      notes.add(
        `Image4 keybag type at offset ${entry[0] === undefined ? 0 : fileOffset(entry[0])} does not fit in an unsigned 32-bit integer.`,
      );
      continue;
    }
    types.push(type);
  }
  return { count: types.length, types };
};

/** SEQUENCE OF SEQUENCE { INTEGER type, OCTET STRING iv, OCTET STRING key }. */
const keybagEntries = async (
  value: DerValue,
  walk: Walk,
  depth: number,
): Promise<DerValue[][] | undefined> => {
  if (tagOf(value) !== 0x30 || !isConstructed(value)) return undefined;
  const entries: DerValue[][] = [];
  for (const kid of await childrenOf(value, walk, depth)) {
    if (tagOf(kid) !== 0x30) return undefined;
    const inner = await childrenOf(kid, walk, depth + 1);
    if (!looksLikeKeybagEntry(inner)) return undefined;
    entries.push(inner);
  }
  return entries;
};

/**
 * An IM4P keybag is an OCTET STRING after the payload whose contents are DER
 * for a SEQUENCE of keybags. Anything else in that slot is reported as an
 * unrecognized keybag so the payload is never presented as plain.
 */
const asKeybag = async (
  value: DerValue,
  walk: Walk,
  depth: number,
  notes: Notes,
): Promise<KeybagAttempt | undefined> => {
  if (tagOf(value) !== 0x04 || isConstructed(value)) return undefined;
  const offset = fileOffset(value);
  if (value.kind !== "node") {
    notes.add(
      `Image4 keybag at offset ${offset} is larger than ${IMAGE4_MAX_NESTED_BYTES} bytes and was not decoded.`,
    );
    return "unrecognized";
  }
  const { node, base } = value;
  if (node.content[0] !== 0x30) {
    notes.add(
      `Image4 keybag at offset ${offset} does not hold a DER SEQUENCE.`,
    );
    return "unrecognized";
  }
  let inner: DerValue;
  try {
    inner = walk.adopt(node.content, base + node.contentStart, depth + 1);
  } catch (cause: unknown) {
    if (!(cause instanceof ParseFailureError) || cause.kind === "limit")
      throw cause;
    notes.add(`Image4 keybag at offset ${offset} is not valid DER.`);
    return "unrecognized";
  }
  if (endOf(inner) !== base + node.contentEnd)
    notes.add(
      `Image4 keybag at offset ${offset} has bytes after its DER SEQUENCE.`,
    );
  const entries = await keybagEntries(inner, walk, depth + 1);
  if (entries === undefined) {
    notes.add(`Image4 keybag at offset ${offset} has an unrecognized layout.`);
    return "unrecognized";
  }
  if (entries.length === 0)
    notes.add(`Image4 keybag at offset ${offset} is empty.`);
  return finishKeybag(entries, notes);
};

const printable = (text: string): string | undefined => {
  if (text.length === 0 || text.length > 64) return undefined;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return undefined;
  }
  return text;
};

/** IM4P compression algorithm 1 is LZFSE ({@link IMAGE4_LZFSE_MAGICS}). */
const IMAGE4_COMPRESSION_LZFSE = 1;
/**
 * `complzss` layout: magic, big-endian adler32 at offset 8, big-endian
 * uncompressed size at offset 12, big-endian compressed size at offset 16.
 */
const COMPLZSS_UNCOMPRESSED_SIZE_OFFSET = 12;
const COMPLZSS_UNCOMPRESSED_SIZE_BYTES = 16;

interface CompressionInfo {
  readonly algorithm: number | undefined;
  readonly size: number | null;
}

/** SEQUENCE { INTEGER algorithm, INTEGER uncompressed size }. */
const asCompression = async (
  value: DerValue,
  walk: Walk,
  depth: number,
  notes: Notes,
): Promise<CompressionInfo | undefined> => {
  if (tagOf(value) !== 0x30 || !isConstructed(value)) return undefined;
  const kids = await childrenOf(value, walk, depth);
  const algorithmValue = kids[0];
  const sizeValue = kids[1];
  if (
    kids.length !== 2 ||
    algorithmValue === undefined ||
    sizeValue === undefined ||
    tagOf(algorithmValue) !== 0x02 ||
    isConstructed(algorithmValue) ||
    tagOf(sizeValue) !== 0x02 ||
    isConstructed(sizeValue)
  )
    return undefined;
  const algorithm = uint32Integer(algorithmValue);
  const decoded = decodeInteger(sizeValue, notes);
  if (decoded.type !== "integer" || !UNSIGNED_DECIMAL.test(decoded.decimal))
    return { algorithm, size: null };
  const size = Number(decoded.decimal);
  return { algorithm, size: Number.isSafeInteger(size) ? size : null };
};

const startsWith = (bytes: Uint8Array, text: string): boolean => {
  if (bytes.length < text.length) return false;
  for (let index = 0; index < text.length; index += 1)
    if (bytes[index] !== text.charCodeAt(index)) return false;
  return true;
};

const isLzfseMagic = (magic: string): magic is Image4LzfseMagic =>
  (IMAGE4_LZFSE_MAGICS as readonly string[]).includes(magic);

const lzfseBlockMagic = (bytes: Uint8Array): Image4LzfseMagic | undefined => {
  for (const magic of IMAGE4_LZFSE_MAGICS)
    if (startsWith(bytes, magic)) return magic;
  return undefined;
};

const sniffPayload = async (
  source: Image4ByteSource,
  offset: number,
  length: number,
  notes: Notes,
): Promise<{
  magic: Image4PayloadMagic | null;
  uncompressed: number | null;
}> => {
  if (length <= 0) return { magic: null, uncompressed: null };
  const wanted = Math.min(COMPLZSS_UNCOMPRESSED_SIZE_BYTES, length);
  const bytes = await readExact(source, offset, wanted);
  const lzfse = lzfseBlockMagic(bytes);
  if (lzfse !== undefined) return { magic: lzfse, uncompressed: null };
  if (startsWith(bytes, "bvx")) {
    const label = printable(bytes.subarray(0, 4).toString("latin1"));
    notes.add(
      label === undefined
        ? "Image4 payload begins with an unknown bvx magic."
        : `Image4 payload magic ${label} is an unrecognized bvx prefix.`,
    );
  }
  if (!startsWith(bytes, "complzss"))
    return { magic: null, uncompressed: null };
  if (length < COMPLZSS_UNCOMPRESSED_SIZE_BYTES) {
    notes.add(
      "Image4 complzss payload is shorter than 16 bytes; uncompressed size is unknown.",
    );
    return { magic: "complzss", uncompressed: null };
  }
  return {
    magic: "complzss",
    uncompressed: new BinaryReader(bytes, false, FORMAT).u32(
      COMPLZSS_UNCOMPRESSED_SIZE_OFFSET,
    ),
  };
};

interface PayloadBuild {
  payload: Image4PayloadFacts | null;
  entry: Image4EntryFact | null;
}

const buildPayload = async (
  kids: readonly DerValue[],
  walk: Walk,
  depth: number,
  source: Image4ByteSource,
  notes: Notes,
): Promise<PayloadBuild> => {
  const strings: DerValue[] = [];
  let payloadValue: DerValue | undefined;
  const extras: DerValue[] = [];
  for (const kid of kids.slice(1)) {
    if (kid.kind === "stopped") break;
    const tag = tagOf(kid);
    if (payloadValue === undefined && tag === 0x04) {
      payloadValue = kid;
      continue;
    }
    if (strings.length < 2 && (tag === 0x16 || tag === 0x0c || tag === 0x13)) {
      strings.push(kid);
      continue;
    }
    extras.push(kid);
  }
  const type = ia5Text(strings[0]) ?? "";
  const description = ia5Text(strings[1]) ?? "";
  if (type.length === 0) notes.add("Image4 payload type is absent.");
  else if (type.length !== 4)
    notes.add(`Image4 payload type is ${type.length} characters.`);
  if (strings[1] === undefined)
    notes.add("Image4 payload description is absent.");
  let keybag: KeybagAttempt | undefined;
  let compression: CompressionInfo | undefined;
  for (const extra of extras) {
    if (keybag === undefined) {
      const parsed = await asKeybag(extra, walk, depth + 1, notes);
      if (parsed !== undefined) {
        keybag = parsed;
        continue;
      }
    }
    if (compression === undefined) {
      const parsed = await asCompression(extra, walk, depth + 1, notes);
      if (parsed !== undefined) {
        compression = parsed;
        continue;
      }
    }
    unknownTag(extra, notes);
  }
  if (payloadValue === undefined || type.length === 0) {
    notes.add("Image4 payload octet string is absent.");
    return { payload: null, entry: null };
  }
  const range = contentRange(payloadValue);
  if (range === undefined) {
    notes.add("Image4 payload octet string is absent.");
    return { payload: null, entry: null };
  }
  const sniffed = await sniffPayload(source, range.offset, range.length, notes);
  let algorithm: Image4Compression = sniffed.magic ?? "none";
  let uncompressed = sniffed.magic === "complzss" ? sniffed.uncompressed : null;
  if (compression !== undefined) {
    if (compression.algorithm !== IMAGE4_COMPRESSION_LZFSE)
      notes.add(
        compression.algorithm === undefined
          ? "Image4 compression algorithm does not fit in an unsigned 32-bit integer."
          : `Image4 compression algorithm ${compression.algorithm} is not LZFSE (1).`,
      );
    else {
      if (sniffed.magic !== null && !isLzfseMagic(sniffed.magic))
        notes.add(
          `Image4 compression bvx2 disagrees with payload magic ${sniffed.magic}.`,
        );
      algorithm = "bvx2";
      uncompressed = compression.size;
    }
  }
  // Any value in the keybag slot means the payload may be encrypted, even
  // when the keybag is empty or its layout is not recognized.
  const encrypted = keybag !== undefined;
  const bag = keybag === "unrecognized" ? undefined : keybag;
  return {
    payload: {
      type,
      description,
      offset: range.offset,
      length: range.length,
      compression: algorithm,
      uncompressed_size: uncompressed,
      payload_magic: sniffed.magic,
      encrypted,
      keybag_count: bag?.count ?? 0,
      keybag_types: bag?.types ?? [],
    },
    entry: {
      role: "payload",
      path: "payload",
      offset: range.offset,
      length: range.length,
      encrypted,
      compression: algorithm,
    },
  };
};

const parseManifestKids = async (
  kids: readonly DerValue[],
  walk: Walk,
  depth: number,
  notes: Notes,
  counter: PropertyCounter,
): Promise<Image4ManifestFacts | undefined> => {
  if (ia5Text(kids[0]) !== "IM4M") return undefined;
  let version: string | null = null;
  const versionValue = kids[1];
  if (versionValue === undefined || tagOf(versionValue) !== 0x02)
    notes.add("Image4 manifest version is absent.");
  else {
    const decoded = decodeInteger(versionValue, notes);
    if (decoded.type === "integer" && UNSIGNED_DECIMAL.test(decoded.decimal))
      version = decoded.decimal;
    else notes.add("Image4 manifest version is not an unsigned decimal.");
  }
  const properties: Image4Property[] = [];
  const objects: Image4ObjectFacts[] = [];
  const body = kids[2];
  if (body === undefined) notes.add("Image4 manifest body is absent.");
  else
    await consumeManifest(
      body,
      walk,
      depth + 1,
      notes,
      counter,
      properties,
      objects,
    );
  let signatureSize: number | null = null;
  const signature = kids[3];
  if (signature === undefined)
    notes.add("Image4 manifest signature is absent.");
  else if (tagOf(signature) === 0x04)
    signatureSize = contentRange(signature)?.length ?? null;
  else unknownTag(signature, notes);
  let certificateChainSize: number | null = null;
  const certificates = kids[4];
  if (certificates !== undefined)
    certificateChainSize = contentRange(certificates)?.length ?? null;
  for (const extra of kids.slice(5)) unknownTag(extra, notes);
  return {
    version,
    properties,
    objects,
    signature_size: signatureSize,
    certificate_chain_size: certificateChainSize,
  };
};

const consumeManifest = async (
  value: DerValue,
  walk: Walk,
  depth: number,
  notes: Notes,
  counter: PropertyCounter,
  properties: Image4Property[],
  objects: Image4ObjectFacts[],
): Promise<void> => {
  if (value.kind === "stopped") return;
  if (isPrivateTagged(value)) {
    const inner = await unwrapPrivate(value, walk, depth, notes);
    if (inner !== value) {
      await consumeManifest(
        inner,
        walk,
        depth + 1,
        notes,
        counter,
        properties,
        objects,
      );
      return;
    }
  }
  const kids = await childrenOf(value, walk, depth);
  const name = ia5Text(kids[0]);
  if (name === undefined) {
    if (tagOf(value) === 0x30 || tagOf(value) === 0x31) {
      for (const kid of kids)
        await consumeManifest(
          kid,
          walk,
          depth + 1,
          notes,
          counter,
          properties,
          objects,
        );
      return;
    }
    unknownTag(value, notes);
    return;
  }
  if (name === "MANB") {
    for (const kid of kids.slice(1))
      await consumeManifest(
        kid,
        walk,
        depth + 1,
        notes,
        counter,
        properties,
        objects,
      );
    return;
  }
  if (name === "MANP") {
    const body = kids[1];
    if (body !== undefined)
      await takeProperties(body, walk, depth + 1, notes, counter, properties);
    return;
  }
  if (name.length === 0) {
    notes.add(
      `Image4 object at offset ${fileOffset(value)} has an empty name.`,
    );
    return;
  }
  const body = kids[1];
  if (body === undefined) {
    unknownTag(value, notes);
    return;
  }
  const objectProperties: Image4Property[] = [];
  await takeProperties(body, walk, depth + 1, notes, counter, objectProperties);
  let digest: string | null = null;
  for (const property of objectProperties)
    if (property.name === "DGST" && property.value.type === "octet")
      digest = property.value.hex;
  objects.push({ name, digest_hex: digest, properties: objectProperties });
};

const collectRestoreNames = async (
  value: DerValue,
  walk: Walk,
  depth: number,
  counter: PropertyCounter,
  names: string[],
): Promise<void> => {
  if (value.kind === "stopped") return;
  if (isPrivateTagged(value)) {
    const inner = await unwrapPrivate(value, walk, depth, walk.notes);
    if (inner !== value) {
      await collectRestoreNames(inner, walk, depth + 1, counter, names);
      return;
    }
  }
  const kids = await childrenOf(value, walk, depth);
  const name = ia5Text(kids[0]);
  if (
    name !== undefined &&
    name !== "IM4R" &&
    name.length > 0 &&
    kids.length >= 2 &&
    tagOf(value) === 0x30
  ) {
    counter.charge();
    names.push(name);
    return;
  }
  if (name === undefined && (tagOf(value) === 0x30 || tagOf(value) === 0x31)) {
    for (const kid of kids)
      await collectRestoreNames(kid, walk, depth + 1, counter, names);
    return;
  }
  if (name === "IM4R") {
    for (const kid of kids.slice(1))
      await collectRestoreNames(kid, walk, depth + 1, counter, names);
  }
};

const parseRestore = async (
  value: DerValue,
  walk: Walk,
  depth: number,
  counter: PropertyCounter,
): Promise<Image4RestoreFacts | undefined> => {
  const kids = await childrenOf(value, walk, depth);
  if (ia5Text(kids[0]) !== "IM4R") return undefined;
  const names: string[] = [];
  for (const kid of kids.slice(1))
    await collectRestoreNames(kid, walk, depth + 1, counter, names);
  return { properties_present: names, values: "redacted" };
};

const manifestEntry = (range: {
  offset: number;
  length: number;
}): Image4EntryFact => ({
  role: "manifest",
  path: "manifest.der",
  offset: range.offset,
  length: range.length,
  encrypted: false,
  compression: "none",
});

const restoreEntry = (range: {
  offset: number;
  length: number;
}): Image4EntryFact => ({
  role: "restore-info",
  path: "restore-info.der",
  offset: range.offset,
  length: range.length,
  encrypted: false,
  compression: "none",
});

const wrappedSequence = async (
  value: DerValue,
  walk: Walk,
  depth: number,
): Promise<DerValue | undefined> => {
  const kids = await childrenOf(value, walk, depth);
  return kids.find((kid) => tagOf(kid) === 0x30 && kid.kind !== "stopped");
};

/**
 * Decode an Image4 DER container. Payload bodies are not loaded when the
 * encoded value exceeds {@link IMAGE4_MAX_NESTED_BYTES}. Keybag IV and key
 * bytes are never copied into the result.
 */
export const inspectImage4 = async (
  source: Image4ByteSource,
): Promise<Image4Inspection> => {
  if (source.length <= 0)
    return {
      kind: "unrecognized",
      detail: "Image4 magic is not IM4P, IMG4, or IM4M.",
    };
  const prefix = await readExact(source, 0, Math.min(source.length, 16));
  const magic = image4PrefixMagic(prefix);
  if (magic === undefined)
    return {
      kind: "unrecognized",
      detail: "Image4 magic is not IM4P, IMG4, or IM4M.",
    };
  const notes = new Notes();
  const counter = new PropertyCounter();
  const walk = new Walk(source, notes);
  const root = await walk.readValue(0, 0, source.length);
  if (root.kind === "stopped")
    return {
      kind: "image4",
      facts: {
        kind: "apple-img4",
        magic,
        payload: null,
        manifest: null,
        restore_info: null,
        trailing_bytes: null,
      },
      entries: [],
      limitations: notes.items,
    };
  const rootEnd = endOf(root);
  const trailing = source.length > rootEnd ? source.length - rootEnd : 0;
  if (trailing > 0)
    notes.add(
      `Image4 container ends at ${rootEnd}; ${trailing} trailing bytes were not decoded.`,
    );
  if (tagOf(root) !== 0x30)
    throw malformedInput(FORMAT, "Image4 root is not a SEQUENCE.", {
      offset: 0,
    });
  const kids = await childrenOf(root, walk, 0);
  const rootMagic = ia5Text(kids[0]);
  if (rootMagic !== "IMG4" && rootMagic !== "IM4P" && rootMagic !== "IM4M")
    throw malformedInput(FORMAT, "Image4 magic is not IM4P, IMG4, or IM4M.", {
      offset: fileOffset(kids[0] ?? root),
    });
  const entries: Image4EntryFact[] = [];
  let payload: Image4PayloadFacts | null = null;
  let manifest: Image4ManifestFacts | null = null;
  let restore: Image4RestoreFacts | null = null;
  if (rootMagic === "IM4P") {
    const built = await buildPayload(kids, walk, 0, source, notes);
    payload = built.payload;
    if (built.entry !== null) entries.push(built.entry);
  } else if (rootMagic === "IM4M") {
    manifest = (await parseManifestKids(kids, walk, 0, notes, counter)) ?? null;
    const range = encodedRange(root);
    if (manifest !== null && range !== undefined)
      entries.push(manifestEntry(range));
  } else {
    let payloadKids: readonly DerValue[] | undefined;
    for (const child of kids.slice(1)) {
      if (child.kind === "stopped") break;
      const tag = tagOf(child);
      if (tag === 0x30 && payloadKids === undefined) {
        const inner = await childrenOf(child, walk, 1);
        if (ia5Text(inner[0]) === "IM4P") {
          payloadKids = inner;
          continue;
        }
      }
      if (tag === 0xa0 && manifest === null) {
        const inner = await wrappedSequence(child, walk, 1);
        if (inner !== undefined) {
          const innerKids = await childrenOf(inner, walk, 2);
          const parsed = await parseManifestKids(
            innerKids,
            walk,
            2,
            notes,
            counter,
          );
          if (parsed !== undefined) {
            manifest = parsed;
            const range = encodedRange(inner);
            if (range !== undefined) entries.push(manifestEntry(range));
            continue;
          }
        }
      }
      if (tag === 0xa1 && restore === null) {
        const inner = await wrappedSequence(child, walk, 1);
        if (inner !== undefined) {
          const parsed = await parseRestore(inner, walk, 2, counter);
          if (parsed !== undefined) {
            restore = parsed;
            const range = encodedRange(inner);
            if (range !== undefined) entries.push(restoreEntry(range));
            continue;
          }
        }
      }
      unknownTag(child, notes);
    }
    if (payloadKids === undefined)
      notes.add("Image4 container has no IM4P payload.");
    else {
      const built = await buildPayload(payloadKids, walk, 1, source, notes);
      payload = built.payload;
      if (built.entry !== null) entries.unshift(built.entry);
    }
  }
  return {
    kind: "image4",
    facts: {
      kind: "apple-img4",
      magic: rootMagic,
      payload,
      manifest,
      restore_info: restore,
      trailing_bytes: trailing,
    },
    entries,
    limitations: notes.items,
  };
};
