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
import { decodeUtf8PreservingBomOrNull } from "../strictUtf8.js";
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
/**
 * Largest primitive value read when it is walked on its own. Nothing larger
 * is ever decoded (text, scalars and keybags are all smaller), so a bigger
 * primitive stays a range and its bytes are not loaded. A parse strategy.
 */
export const IMAGE4_MAX_DECODED_PRIMITIVE_BYTES = IMAGE4_MAX_STRING_BYTES;
/**
 * Encoded bytes tree-parsed and kept in memory for one inspection. Past this,
 * values are walked by header only: structure is still checked, but their
 * bytes are not retained. A parse strategy, not a refusal.
 */
export const IMAGE4_MAX_RETAINED_BYTES = 8 * 1024 * 1024;

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
  /** Neither a known compression field nor readable stored bytes decide it. */
  "unknown",
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
  /** Null when the field is absent or its text could not be decoded. */
  description: string | null;
  offset: number;
  length: number;
  compression: Image4Compression;
  uncompressed_size: number | null;
  payload_magic: Image4PayloadMagic | null;
  encrypted: boolean;
  /** Keybag entries; null when a keybag is present but was not decoded. */
  keybag_count: number | null;
  /** Types that fit in 32 bits; null when the keybag was not decoded. */
  keybag_types: number[] | null;
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
const UNIVERSAL_SEQUENCE = 16;
const UNIVERSAL_IA5_STRING = 22;
/**
 * Bytes recognition reads: a SEQUENCE header with up to four length octets,
 * an IA5String header with up to four length octets, and the four-byte magic.
 */
export const IMAGE4_PREFIX_BYTES = 16;

/**
 * True when `prefix` begins with a DER SEQUENCE whose first element is the
 * IA5String `IMG4`, `IM4P` or `IM4M`.
 */
export const image4PrefixMagic = (
  prefix: Uint8Array,
): Image4Magic | undefined => {
  // Recognition reads both headers with the same decoder inspection uses, so
  // a length form inspection tolerates, such as 81 04, is also recognized.
  let outer: Asn1BerHeader;
  let inner: Asn1BerHeader;
  try {
    outer = readAsn1BerHeader(prefix, 0, prefix.length);
    if (
      outer.tagClass !== "universal" ||
      outer.tagNumber !== UNIVERSAL_SEQUENCE ||
      !outer.constructed
    )
      return undefined;
    inner = readAsn1BerHeader(prefix, outer.headerLength, prefix.length);
  } catch (cause: unknown) {
    if (cause instanceof Asn1BerFailure) return undefined;
    throw cause;
  }
  if (
    inner.tagClass !== "universal" ||
    inner.tagNumber !== UNIVERSAL_IA5_STRING ||
    inner.constructed ||
    inner.length !== 4
  )
    return undefined;
  const at = outer.headerLength + inner.headerLength;
  if (at + 4 > prefix.length) return undefined;
  const magic = String.fromCharCode(
    prefix[at] ?? 0,
    prefix[at + 1] ?? 0,
    prefix[at + 2] ?? 0,
    prefix[at + 3] ?? 0,
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
  /**
   * A value whose extent could not be bounded. Its identifier is still known,
   * so a slot it occupies keeps its role; its content was not examined.
   */
  | {
      readonly kind: "stopped";
      readonly offset: number;
      readonly header: TlvHeader;
    };

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
  if (isConstructedString(node.tagClass, node.tagNumber, node.constructed))
    notes.add(
      `Image4 value at offset ${offset} is a constructed string or octet.`,
    );
  const universal = node.tagClass === "universal";
  if (universal && node.tagNumber === UNIVERSAL.boolean && !node.constructed) {
    const byte = node.content[0];
    if (node.content.length !== 1 || (byte !== 0x00 && byte !== 0xff))
      notes.add(`Image4 boolean at offset ${offset} is not canonical.`);
  }
  if (
    universal &&
    node.tagNumber === UNIVERSAL.integer &&
    !node.constructed &&
    isNonMinimalInteger(node.content)
  )
    notes.add(`Image4 integer at offset ${offset} is not minimally encoded.`);
  for (const child of node.children) noteStructure(child, notes, base);
};

class Walk {
  readonly #elements = new Budget(IMAGE4_MAX_ELEMENTS);
  /** Encoded bytes this walk may load and retain as parsed trees. */
  readonly #retained = new Budget(IMAGE4_MAX_RETAINED_BYTES);
  /** Children of a header-walked value, read and charged exactly once. */
  readonly #spanChildren = new WeakMap<TlvHeader, DerValue[]>();

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
      if (span > IMAGE4_MAX_NESTED_BYTES || !this.#retain(span)) {
        this.notes.add(
          `Image4 value at offset ${offset} uses indefinite length and is not bounded within ${IMAGE4_MAX_NESTED_BYTES} bytes.`,
        );
        this.charge(1);
        return { kind: "stopped", offset, header };
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
    const encoded = header.end - header.start;
    // Load a value only when its bytes may be decoded and fit what this walk
    // retains; otherwise walk it by header so memory stays bounded.
    const opaque =
      !header.constructed &&
      header.contentEnd - header.contentStart >
        IMAGE4_MAX_DECODED_PRIMITIVE_BYTES;
    // A small primitive is always loaded: the element allowance bounds how
    // many there are, and reading names and scalars must not depend on how
    // much of the retained budget earlier opaque structure used.
    // Reserve tree bytes only for a value that will actually be tree-parsed,
    // so a ranged wrapper never uses budget for bytes it does not load.
    const parseable = encoded <= IMAGE4_MAX_NESTED_BYTES && !opaque;
    if (parseable && (!header.constructed || this.#retain(encoded)))
      return this.adopt(
        await readExact(this.source, offset, encoded),
        offset,
        depth,
      );
    this.charge(1);
    if (
      isConstructedString(header.tagClass, header.tagNumber, header.constructed)
    )
      this.notes.add(
        `Image4 value at offset ${offset} is a constructed string or octet.`,
      );
    const span: DerValue = { kind: "span", header };
    // Walk every constructed value once, even when no consumer decodes its
    // meaning, so its structure, depth and element count are always checked.
    if (header.constructed) await this.childrenOf(span, depth);
    return span;
  }

  /** Reserve `bytes` of retained tree before loading them. */
  #retain(bytes: number): boolean {
    return this.#retained.tryCharge(bytes);
  }

  /**
   * The children of a constructed value. A tree-parsed node already holds its
   * charged children; a header-walked value reads its children on first use
   * and returns the same values afterwards, so asking twice charges nothing.
   */
  async childrenOf(value: DerValue, depth: number): Promise<DerValue[]> {
    if (value.kind === "stopped") return [];
    if (value.kind === "node")
      return value.node.children.map((child) => ({
        kind: "node" as const,
        node: child,
        base: value.base,
        end: value.base + child.end,
      }));
    if (!value.header.constructed) return [];
    const cached = this.#spanChildren.get(value.header);
    if (cached !== undefined) return cached;
    const children: DerValue[] = [];
    let cursor = value.header.contentStart;
    while (cursor < value.header.contentEnd) {
      const child = await this.readValue(
        cursor,
        depth + 1,
        value.header.contentEnd,
      );
      if (child.kind === "stopped") {
        children.push(child);
        if (child.header.contentStart < value.header.contentEnd)
          this.notes.add(
            `Image4 values after offset ${child.offset} in the value at offset ${value.header.start} were not examined.`,
          );
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
    this.#spanChildren.set(value.header, children);
    return children;
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

/** First identifier octet, for diagnostics only. Never compare it to a type. */
const rawTagOf = (value: DerValue): number => {
  if (value.kind === "node") return value.node.tag;
  return value.header.tag;
};

const tagClassOf = (value: DerValue): Asn1TagClass => {
  if (value.kind === "node") return value.node.tagClass;
  return value.header.tagClass;
};

/** Universal tag numbers Image4 uses. The constructed bit is separate. */
const UNIVERSAL = {
  boolean: 1,
  integer: 2,
  octetString: 4,
  utf8String: 12,
  sequence: UNIVERSAL_SEQUENCE,
  set: 17,
  printableString: 19,
  ia5String: UNIVERSAL_IA5_STRING,
} as const;

const STRING_TAGS: ReadonlySet<number> = new Set([
  UNIVERSAL.utf8String,
  UNIVERSAL.printableString,
  UNIVERSAL.ia5String,
]);

/**
 * The universal tag number of a value, or undefined for any other class. A
 * constructed OCTET STRING (identifier 0x24) is universal 4 and constructed.
 */
const universalTag = (value: DerValue | undefined): number | undefined =>
  value !== undefined && tagClassOf(value) === "universal"
    ? tagNumberOf(value)
    : undefined;

/** A universal value of `tag` in primitive form. */
const isPrimitive = (
  value: DerValue | undefined,
  tag: number,
): value is DerValue =>
  value !== undefined && universalTag(value) === tag && !isConstructed(value);

const isSequence = (value: DerValue | undefined): value is DerValue =>
  value !== undefined &&
  universalTag(value) === UNIVERSAL.sequence &&
  isConstructed(value);

const isSet = (value: DerValue | undefined): value is DerValue =>
  value !== undefined &&
  universalTag(value) === UNIVERSAL.set &&
  isConstructed(value);

/** A universal string or OCTET STRING sent in constructed (segmented) form. */
const isConstructedString = (
  tagClass: Asn1TagClass,
  tagNumber: number,
  constructed: boolean,
): boolean =>
  constructed &&
  tagClass === "universal" &&
  (STRING_TAGS.has(tagNumber) || tagNumber === UNIVERSAL.octetString);

const tagNumberOf = (value: DerValue): number => {
  if (value.kind === "node") return value.node.tagNumber;
  return value.header.tagNumber;
};

/** A readable private-tagged entry; a stopped one cannot be unwrapped. */
const isPrivateTagged = (value: DerValue): boolean =>
  value.kind !== "stopped" &&
  tagClassOf(value) === "private" &&
  isConstructed(value);

const isConstructed = (value: DerValue): boolean => {
  if (value.kind === "node") return value.node.constructed;
  return value.header.constructed;
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
  const tag = rawTagOf(value);
  const highTag = tag !== undefined && (tag & 0x1f) === 0x1f;
  const number = tagNumberOf(value);
  const label = highTag
    ? ` number ${String(number ?? 0)}${fourCharCode(number) === undefined ? "" : ` (${fourCharCode(number) ?? ""})`}`
    : "";
  notes.add(
    `Unknown Image4 tag 0x${hexTag(tag)}${label} at offset ${fileOffset(value)}`,
  );
};

/** PrintableString's repertoire (X.680): letters, digits and ` '()+,-./:=?`. */
const PRINTABLE_STRING = /^[A-Za-z0-9 '()+,\-./:=?]*$/u;

/**
 * Decodes a primitive IA5String, PrintableString or UTF8String by its own
 * encoding. Bytes outside that encoding are reported and the text is treated
 * as absent rather than returned altered.
 */
const ia5Text = (
  value: DerValue | undefined,
  notes?: Notes,
): string | undefined => {
  if (value === undefined || value.kind === "stopped") return undefined;
  if (!STRING_TAGS.has(universalTag(value) ?? -1) || isConstructed(value))
    return undefined;
  // This is the one owner of the retained-text allowance. A string too large
  // to be tree-parsed is refused here rather than reported as absent.
  const range = contentRange(value);
  if (range !== undefined && range.length > IMAGE4_MAX_STRING_BYTES)
    stringLimit(range.offset, range.length);
  if (value.kind !== "node") return undefined;
  const { node, base } = value;
  const offset = base + node.start;
  if (node.tagNumber === UNIVERSAL.utf8String) {
    // A BOM is part of the field's value, not an encoding signature.
    const text = decodeUtf8PreservingBomOrNull(node.content);
    if (text === null)
      notes?.add(`Image4 UTF8String at offset ${offset} is not valid UTF-8.`);
    return text ?? undefined;
  }
  for (const byte of node.content)
    if (byte > 0x7f) {
      notes?.add(
        `Image4 ${node.tagNumber === UNIVERSAL.ia5String ? "IA5String" : "PrintableString"} at offset ${offset} has a byte outside ASCII.`,
      );
      return undefined;
    }
  const text = node.content.toString("latin1");
  if (
    node.tagNumber === UNIVERSAL.printableString &&
    !PRINTABLE_STRING.test(text)
  )
    notes?.add(
      `Image4 PrintableString at offset ${offset} has characters outside its repertoire.`,
    );
  return text;
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
  const kids = await walk.childrenOf(value, depth);
  const inner = kids[0];
  if (kids.length !== 1 || inner === undefined || !isSequence(inner))
    return value;
  const code = fourCharCode(tagNumberOf(value));
  const name = ia5Text((await walk.childrenOf(inner, depth + 1))[0]);
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
  // noteStructure owns the canonical-encoding check for every BOOLEAN.
  const byte = value.node.content[0] ?? 0;
  return { type: "boolean", value: byte !== 0 };
};

const isScalar = (value: DerValue): boolean =>
  isPrimitive(value, UNIVERSAL.integer) ||
  isPrimitive(value, UNIVERSAL.boolean) ||
  isPrimitive(value, UNIVERSAL.octetString);

const scalarSlot = async (
  value: DerValue,
  walk: Walk,
  depth: number,
): Promise<DerValue | undefined> => {
  if (isScalar(value)) return value;
  if (!isSet(value) && !isSequence(value)) return undefined;
  const kids = await walk.childrenOf(value, depth + 1);
  const only = kids[0];
  return kids.length === 1 && only !== undefined && isScalar(only)
    ? only
    : undefined;
};

const decodeScalar = (value: DerValue, notes: Notes): Image4PropertyValue => {
  const tag = universalTag(value);
  if (tag === UNIVERSAL.integer) return decodeInteger(value, notes);
  if (tag === UNIVERSAL.boolean) return decodeBoolean(value, notes);
  if (tag === UNIVERSAL.octetString) return decodeOctet(value, notes);
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
  if (!isSequence(entry)) return "no";
  const kids = await walk.childrenOf(entry, depth + 1);
  const name = ia5Text(kids[0], notes);
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
  // A property is { name, value }; anything after the value is not decoded.
  for (const extra of kids.slice(2)) unknownTag(extra, notes);
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
  // A property body is a SET of properties (img4tool builds a SET); a
  // SEQUENCE is tolerated. Anything else is unsupported structure, reported
  // rather than read as an empty property set.
  if (value.kind === "stopped" || (!isSet(value) && !isSequence(value))) {
    unknownTag(value, notes);
    return;
  }
  const kids = await walk.childrenOf(value, depth);
  for (const kid of kids) {
    const attempt = await tryProperty(kid, walk, depth + 1, notes, counter);
    if (attempt === "no") unknownTag(kid, notes);
    else if (attempt !== "ignored") into.push(attempt);
  }
};

const uint32Integer = (value: DerValue | undefined): number | undefined => {
  if (value === undefined || value.kind !== "node" || value.node.constructed)
    return undefined;
  const content = value.node.content;
  if (content.length === 0 || ((content[0] ?? 0) & 0x80) !== 0)
    return undefined;
  // DER prefixes a zero octet when the high bit of a positive value is set,
  // so 0xffffffff is five octets: 00 ff ff ff ff.
  const bytes =
    content.length > 1 && content[0] === 0 ? content.subarray(1) : content;
  if (bytes.length > 4) return undefined;
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
    kids.length === 3 &&
    isPrimitive(type, UNIVERSAL.integer) &&
    isPrimitive(iv, UNIVERSAL.octetString) &&
    isPrimitive(key, UNIVERSAL.octetString)
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
  return { count: entries.length, types };
};

/** SEQUENCE OF SEQUENCE { INTEGER type, OCTET STRING iv, OCTET STRING key }. */
const keybagEntries = async (
  value: DerValue,
  walk: Walk,
  depth: number,
): Promise<DerValue[][] | undefined> => {
  if (!isSequence(value)) return undefined;
  const entries: DerValue[][] = [];
  for (const kid of await walk.childrenOf(value, depth)) {
    if (!isSequence(kid)) return undefined;
    const inner = await walk.childrenOf(kid, depth + 1);
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
  if (universalTag(value) !== UNIVERSAL.octetString) return undefined;
  const offset = fileOffset(value);
  if (isConstructed(value)) {
    notes.add(
      `Image4 keybag at offset ${offset} is a constructed OCTET STRING and was not decoded.`,
    );
    return "unrecognized";
  }
  if (value.kind !== "node") {
    notes.add(
      `Image4 keybag at offset ${offset} is larger than ${IMAGE4_MAX_DECODED_PRIMITIVE_BYTES} bytes and was not decoded.`,
    );
    return "unrecognized";
  }
  const { node, base } = value;
  let inner: DerValue;
  try {
    inner = walk.adopt(node.content, base + node.contentStart, depth + 1);
  } catch (cause: unknown) {
    if (!(cause instanceof ParseFailureError) || cause.kind === "limit")
      throw cause;
    notes.add(`Image4 keybag at offset ${offset} is not valid DER.`);
    return "unrecognized";
  }
  if (!isSequence(inner)) {
    notes.add(
      `Image4 keybag at offset ${offset} does not hold a DER SEQUENCE.`,
    );
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

/** IM4M version img4tool's `isIM4M` accepts; no other version is described. */
const IMAGE4_MANIFEST_VERSION = "0";

/**
 * IM4P compression algorithm 1 is LZFSE ({@link IMAGE4_LZFSE_MAGICS}): the
 * only number img4lib, img4tool and pyimg4 decode in the compression field.
 */
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
  if (!isSequence(value)) return undefined;
  const kids = await walk.childrenOf(value, depth);
  const algorithmValue = kids[0];
  const sizeValue = kids[1];
  if (
    kids.length !== 2 ||
    algorithmValue === undefined ||
    sizeValue === undefined ||
    !isPrimitive(algorithmValue, UNIVERSAL.integer) ||
    !isPrimitive(sizeValue, UNIVERSAL.integer)
  )
    return undefined;
  const algorithm = uint32Integer(algorithmValue);
  const decoded = decodeInteger(sizeValue, notes);
  const offset = fileOffset(sizeValue);
  // decodeInteger already notes an omitted value; a decoded one that is not a
  // usable size is noted here so the unknown size is explained.
  if (decoded.type !== "integer") return { algorithm, size: null };
  if (!UNSIGNED_DECIMAL.test(decoded.decimal)) {
    notes.add(
      `Image4 uncompressed size at offset ${offset} is negative (${decoded.decimal}); the size is unknown.`,
    );
    return { algorithm, size: null };
  }
  const size = Number(decoded.decimal);
  if (!Number.isSafeInteger(size)) {
    notes.add(
      `Image4 uncompressed size at offset ${offset} (${decoded.decimal}) exceeds the largest exact integer; the size is unknown.`,
    );
    return { algorithm, size: null };
  }
  return { algorithm, size };
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
  // IM4P is SEQUENCE { "IM4P", type, [description], payload OCTET STRING,
  // [keybag OCTET STRING], [compression SEQUENCE] }. Each field is read from
  // its position, so a later sibling never takes a slot it does not fill.
  let index = 1;
  const isText = (value: DerValue | undefined): value is DerValue =>
    value !== undefined && STRING_TAGS.has(universalTag(value) ?? -1);
  const typeValue = isText(kids[index]) ? kids[index++] : undefined;
  const descriptionValue = isText(kids[index]) ? kids[index++] : undefined;
  const slot = kids[index];
  const extras: DerValue[] = [];
  let payloadValue: DerValue | undefined;
  let unsupportedPayload = false;
  if (slot !== undefined) {
    index += 1;
    if (slot.kind === "stopped") {
      // The payload slot is occupied but its extent is unknown: keep the slot
      // and expose nothing rather than letting a later field take its place.
      unsupportedPayload = true;
      notes.add(
        `Image4 payload at offset ${slot.offset} was not bounded; its bytes are not exposed.`,
      );
    } else if (isPrimitive(slot, UNIVERSAL.octetString)) payloadValue = slot;
    else if (universalTag(slot) === UNIVERSAL.octetString) {
      unsupportedPayload = true;
      notes.add(
        `Image4 payload at offset ${fileOffset(slot)} is a constructed OCTET STRING; its bytes are not exposed.`,
      );
    } else extras.push(slot);
  }
  // A stopped value still occupies its slot; childrenOf ends the list there.
  for (const kid of kids.slice(index)) extras.push(kid);
  const type = ia5Text(typeValue, notes) ?? "";
  // Absent or undecodable text is unknown (null), never an empty string.
  const description = ia5Text(descriptionValue, notes) ?? null;
  if (type.length === 0) notes.add("Image4 payload type is absent.");
  else if (type.length !== 4)
    notes.add(`Image4 payload type is ${type.length} characters.`);
  if (descriptionValue === undefined)
    notes.add("Image4 payload description is absent.");
  // After the payload, img4lib and img4tool place an optional keybag OCTET
  // STRING first, then an optional compression SEQUENCE, then optional PAYP
  // properties in [0]. A field is decoded only in its own slot.
  let keybag: KeybagAttempt | undefined;
  let compression: CompressionInfo | undefined;
  let slotIndex = 0;
  const keybagSlot = extras[slotIndex];
  if (
    keybagSlot !== undefined &&
    universalTag(keybagSlot) === UNIVERSAL.octetString
  ) {
    keybag = await asKeybag(keybagSlot, walk, depth + 1, notes);
    slotIndex += 1;
  }
  const compressionSlot = extras[slotIndex];
  if (isSequence(compressionSlot)) {
    compression = await asCompression(compressionSlot, walk, depth + 1, notes);
    if (compression === undefined) unknownTag(compressionSlot, notes);
    slotIndex += 1;
  }
  for (const extra of extras.slice(slotIndex)) {
    if (tagClassOf(extra) === "context" && tagNumberOf(extra) === 0)
      notes.add(
        `Image4 payload properties (PAYP) at offset ${fileOffset(extra)} were not decoded.`,
      );
    else unknownTag(extra, notes);
  }
  if (payloadValue === undefined || type.length === 0) {
    if (!unsupportedPayload)
      notes.add("Image4 payload octet string is absent.");
    return { payload: null, entry: null };
  }
  const range = contentRange(payloadValue);
  if (range === undefined) {
    notes.add("Image4 payload octet string is absent.");
    return { payload: null, entry: null };
  }
  // Any value in the keybag slot means the payload may be encrypted, even
  // when the keybag is empty or its layout is not recognized.
  const encrypted = keybag !== undefined;
  const sniffed = await sniffPayload(source, range.offset, range.length, notes);
  // Encrypted bytes carry no readable magic, so only the compression field
  // can describe them; without it the compression is unknown, not "none".
  let algorithm: Image4Compression = encrypted
    ? "unknown"
    : (sniffed.magic ?? "none");
  let uncompressed =
    !encrypted && sniffed.magic === "complzss" ? sniffed.uncompressed : null;
  if (compression !== undefined) {
    if (compression.algorithm !== IMAGE4_COMPRESSION_LZFSE) {
      notes.add(
        compression.algorithm === undefined
          ? "Image4 compression algorithm does not fit in an unsigned 32-bit integer."
          : `Image4 compression algorithm ${compression.algorithm} is not LZFSE (1).`,
      );
      // A declared algorithm REA cannot name leaves the compression unknown
      // unless the stored bytes show a known magic.
      if (encrypted || sniffed.magic === null) algorithm = "unknown";
    } else {
      if (sniffed.magic !== null && !isLzfseMagic(sniffed.magic))
        notes.add(
          `Image4 compression bvx2 disagrees with payload magic ${sniffed.magic}.`,
        );
      algorithm = "bvx2";
      uncompressed = compression.size;
    }
  }
  if (encrypted && compression === undefined)
    notes.add(
      "Image4 payload is encrypted and has no compression field; its compression is unknown.",
    );
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
      // No keybag means zero; a keybag that was not decoded is unknown.
      keybag_count: keybag === undefined ? 0 : (bag?.count ?? null),
      keybag_types: keybag === undefined ? [] : (bag?.types ?? null),
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
  if (ia5Text(kids[0], notes) !== "IM4M") return undefined;
  let version: string | null = null;
  const versionValue = kids[1];
  if (!isPrimitive(versionValue, UNIVERSAL.integer))
    notes.add("Image4 manifest version is absent.");
  else {
    const decoded = decodeInteger(versionValue, notes);
    if (decoded.type === "integer" && UNSIGNED_DECIMAL.test(decoded.decimal)) {
      version = decoded.decimal;
      if (version !== IMAGE4_MANIFEST_VERSION)
        notes.add(
          `Image4 manifest version ${version} is not ${IMAGE4_MANIFEST_VERSION}, the only version the reference implementations describe; its layout is assumed unchanged.`,
        );
    } else notes.add("Image4 manifest version is not an unsigned decimal.");
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
  else if (isPrimitive(signature, UNIVERSAL.octetString))
    signatureSize = contentRange(signature)?.length ?? null;
  else unknownTag(signature, notes);
  let certificateChainSize: number | null = null;
  // The certificate chain is a SEQUENCE of certificates. Its contents are not
  // decoded, but the walker has examined their structure.
  const certificates = kids[4];
  if (isSequence(certificates))
    certificateChainSize = contentRange(certificates)?.length ?? null;
  else if (certificates !== undefined) unknownTag(certificates, notes);
  for (const extra of kids.slice(5)) unknownTag(extra, notes);
  return {
    version,
    properties,
    objects,
    signature_size: signatureSize,
    certificate_chain_size: certificateChainSize,
  };
};

/**
 * How a manifest or restore value names itself. An entry is a SEQUENCE whose
 * first field is a string; when that string cannot be read the entry is
 * still an entry, so its value is never walked as further entries.
 */
type EntryName =
  | { readonly kind: "named"; readonly name: string }
  | { readonly kind: "unreadable" }
  | { readonly kind: "container" };

const entryName = (kids: readonly DerValue[], notes: Notes): EntryName => {
  const first = kids[0];
  if (first === undefined || !STRING_TAGS.has(universalTag(first) ?? -1))
    return { kind: "container" };
  const name = ia5Text(first, notes);
  return name === undefined ? { kind: "unreadable" } : { kind: "named", name };
};

const unreadableEntry = (value: DerValue, notes: Notes): void => {
  notes.add(
    `Image4 entry at offset ${fileOffset(value)} has a name that could not be read; its value was not decoded.`,
  );
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
  if (value.kind === "stopped") {
    unknownTag(value, notes);
    return;
  }
  if (isPrivateTagged(value)) {
    const inner = await unwrapPrivate(value, walk, depth, notes);
    // A PRIVATE value is one manifest entry and must name itself. When its
    // name cannot be read, its value is reported and never interpreted as
    // manifest facts.
    if (
      inner !== value &&
      entryName(await walk.childrenOf(inner, depth + 1), notes).kind !== "named"
    ) {
      unreadableEntry(value, notes);
      return;
    }
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
  const kids = await walk.childrenOf(value, depth);
  const named = entryName(kids, notes);
  if (named.kind === "unreadable") {
    unreadableEntry(value, notes);
    return;
  }
  if (named.kind === "container") {
    if (isSequence(value) || isSet(value)) {
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
  // A named manifest entry is a universal SEQUENCE { name, body }, after any
  // PRIVATE wrapper. A context-, application- or other-tagged value that
  // happens to start with a name is unsupported structure, not an entry.
  if (!isSequence(value)) {
    unknownTag(value, notes);
    return;
  }
  const { name } = named;
  // MANB, MANP and IM4R each hold their contents after the name. A name with
  // nothing after it is a missing body, not a confirmed-empty one.
  if ((name === "MANB" || name === "MANP") && kids.length < 2)
    notes.add(
      `Image4 ${name} entry at offset ${fileOffset(value)} has no body after its name.`,
    );
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
    for (const extra of kids.slice(2)) unknownTag(extra, notes);
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
  // An object is { name, SET of properties }; later fields are not decoded.
  for (const extra of kids.slice(2)) unknownTag(extra, notes);
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
  if (value.kind === "stopped") {
    unknownTag(value, walk.notes);
    return;
  }
  // A PRIVATE-tagged value is one restore property. Its boundary is kept
  // whatever it holds: only its name may be reported, and its value is never
  // walked for further names, even when the name is unreadable or is IM4R.
  if (isPrivateTagged(value)) {
    const inner = await unwrapPrivate(value, walk, depth, walk.notes);
    const kids = inner === value ? [] : await walk.childrenOf(inner, depth + 1);
    const named = entryName(kids, walk.notes);
    if (named.kind !== "named" || named.name.length === 0 || kids.length < 2) {
      unreadableEntry(value, walk.notes);
      return;
    }
    if (kids.length > 2)
      walk.notes.add(
        `Image4 restore entry at offset ${fileOffset(value)} has ${kids.length - 2} fields after its value that were not decoded.`,
      );
    counter.charge();
    names.push(named.name);
    return;
  }
  const kids = await walk.childrenOf(value, depth);
  const named = entryName(kids, walk.notes);
  // An entry whose name cannot be read stays one unknown entry: its value is
  // redacted and is never walked for further names.
  if (named.kind === "unreadable") {
    unreadableEntry(value, walk.notes);
    return;
  }
  // IM4R holds its properties in one SET (img4tool). Only a SET is walked as
  // a container: any other unnamed value is reported and its contents, which
  // may be restore values, are never searched for names.
  if (named.kind === "container") {
    if (isSet(value)) {
      for (const kid of kids)
        await collectRestoreNames(kid, walk, depth + 1, counter, names);
      return;
    }
    unknownTag(value, walk.notes);
    return;
  }
  // IM4R is the magic of the top-level restore SEQUENCE only (parseRestore);
  // a nested value that names itself IM4R is an ordinary entry.
  const { name } = named;
  if (name.length > 0 && kids.length >= 2 && isSequence(value)) {
    // Only the name is reported; restore values stay redacted. Fields after
    // the value are noted by position without exposing them.
    if (kids.length > 2)
      walk.notes.add(
        `Image4 restore entry at offset ${fileOffset(value)} has ${kids.length - 2} fields after its value that were not decoded.`,
      );
    counter.charge();
    names.push(name);
    return;
  }
  // A named value this reader does not recognize: tag and position only.
  unknownTag(value, walk.notes);
};

const parseRestore = async (
  value: DerValue,
  walk: Walk,
  depth: number,
  counter: PropertyCounter,
): Promise<Image4RestoreFacts | undefined> => {
  const kids = await walk.childrenOf(value, depth);
  if (ia5Text(kids[0], walk.notes) !== "IM4R") return undefined;
  if (kids.length < 2)
    walk.notes.add(
      `Image4 IM4R entry at offset ${fileOffset(value)} has no body after its name.`,
    );
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
  // An EXPLICIT tag wraps exactly one value; anything after it is reported.
  const kids = await walk.childrenOf(value, depth);
  const [first, ...rest] = kids;
  for (const extra of rest)
    if (extra.kind !== "stopped") unknownTag(extra, walk.notes);
  return isSequence(first) && first.kind !== "stopped" ? first : undefined;
};

interface Img4Slots {
  readonly payloadKids: readonly DerValue[] | undefined;
  readonly manifest:
    | { readonly facts: Image4ManifestFacts; readonly range: ByteRange }
    | undefined;
  readonly restore:
    | { readonly facts: Image4RestoreFacts; readonly range: ByteRange }
    | undefined;
}

interface ByteRange {
  readonly offset: number;
  readonly length: number;
}

/** The IMG4 payload, manifest and restore slots, each read in its position. */
/** One position in a structure: untagged, or identified by a context tag. */
interface SlotSpec<Key extends string> {
  readonly key: Key;
  readonly context?: number;
}

/**
 * Assign a structure's values to its ordered slots. A context-tagged value
 * fills the slot with its tag number, skipping earlier optional slots. Any
 * other value occupies the next slot in position, even when it cannot fill
 * it, so an unsupported value never shifts a later sibling out of its slot.
 * Values that fit no remaining slot are returned as extras.
 */
const assignSlots = <Key extends string>(
  values: readonly DerValue[],
  layout: readonly SlotSpec<Key>[],
): { readonly slots: Map<Key, DerValue>; readonly extras: DerValue[] } => {
  const slots = new Map<Key, DerValue>();
  const extras: DerValue[] = [];
  let next = 0;
  for (const value of values) {
    const context =
      tagClassOf(value) === "context" ? tagNumberOf(value) : undefined;
    const at =
      context === undefined
        ? next < layout.length
          ? next
          : -1
        : layout.findIndex(
            (slot, index) => index >= next && slot.context === context,
          );
    const slot = at < 0 ? undefined : layout[at];
    if (slot === undefined) extras.push(value);
    else {
      slots.set(slot.key, value);
      next = at + 1;
    }
  }
  return { slots, extras };
};

/** IMG4 after its magic: IM4P, [0] IM4M, [1] IM4R (img4tool, img4lib). */
const IMG4_LAYOUT = [
  { key: "payload" },
  { key: "manifest", context: 0 },
  { key: "restore", context: 1 },
] as const satisfies readonly SlotSpec<string>[];

/** The IMG4 payload, manifest and restore slots, each read in its position. */
const img4Slots = async (
  kids: readonly DerValue[],
  walk: Walk,
  notes: Notes,
  counter: PropertyCounter,
): Promise<Img4Slots> => {
  const { slots, extras } = assignSlots(kids.slice(1), IMG4_LAYOUT);
  let payloadKids: readonly DerValue[] | undefined;
  const payloadSlot = slots.get("payload");
  if (payloadSlot !== undefined) {
    const inner = isSequence(payloadSlot)
      ? await walk.childrenOf(payloadSlot, 1)
      : [];
    if (ia5Text(inner[0], notes) === "IM4P") payloadKids = inner;
    else unknownTag(payloadSlot, notes);
  }
  let manifest: Img4Slots["manifest"];
  const manifestSlot = slots.get("manifest");
  if (manifestSlot !== undefined) {
    const inner = isContextWrapper(manifestSlot)
      ? await wrappedSequence(manifestSlot, walk, 1)
      : undefined;
    const innerKids =
      inner === undefined ? [] : await walk.childrenOf(inner, 2);
    const facts = await parseManifestKids(innerKids, walk, 2, notes, counter);
    const range = inner === undefined ? undefined : encodedRange(inner);
    if (facts !== undefined && range !== undefined) manifest = { facts, range };
    else unknownTag(manifestSlot, notes);
  }
  let restore: Img4Slots["restore"];
  const restoreSlot = slots.get("restore");
  if (restoreSlot !== undefined) {
    const inner = isContextWrapper(restoreSlot)
      ? await wrappedSequence(restoreSlot, walk, 1)
      : undefined;
    const facts =
      inner === undefined
        ? undefined
        : await parseRestore(inner, walk, 2, counter);
    const range = inner === undefined ? undefined : encodedRange(inner);
    if (facts !== undefined && range !== undefined) restore = { facts, range };
    else unknownTag(restoreSlot, notes);
  }
  for (const extra of extras) unknownTag(extra, notes);
  return { payloadKids, manifest, restore };
};

/** An EXPLICIT context wrapper that can be read: constructed, not stopped. */
const isContextWrapper = (value: DerValue): boolean =>
  value.kind !== "stopped" &&
  tagClassOf(value) === "context" &&
  isConstructed(value);

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
  const prefix = await readExact(
    source,
    0,
    Math.min(source.length, IMAGE4_PREFIX_BYTES),
  );
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
  if (!isSequence(root))
    throw malformedInput(FORMAT, "Image4 root is not a SEQUENCE.", {
      offset: 0,
    });
  const kids = await walk.childrenOf(root, 0);
  const rootMagic = ia5Text(kids[0], notes);
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
    // IMG4 is SEQUENCE { "IMG4", IM4P, [0] IM4M, [1] IM4R } (img4tool,
    // img4lib). Each slot is read from its position; a value that does not
    // fill its slot is reported and does not shift the later slots.
    const slots = await img4Slots(kids, walk, notes, counter);
    const payloadKids = slots.payloadKids;
    manifest = slots.manifest?.facts ?? null;
    restore = slots.restore?.facts ?? null;
    if (slots.manifest !== undefined)
      entries.push(manifestEntry(slots.manifest.range));
    if (slots.restore !== undefined)
      entries.push(restoreEntry(slots.restore.range));
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
