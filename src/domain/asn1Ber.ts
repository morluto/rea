import { ParseFailureError } from "./parseFailure.js";

export type Asn1TagClass = "universal" | "application" | "context" | "private";

/** A bounded BER value tree shared by binary format owners. */
export interface Asn1BerNode {
  /** First identifier octet: class, constructed bit and low tag number. */
  readonly tag: number;
  readonly tagClass: Asn1TagClass;
  /** Tag number, decoded from the high-tag-number form when it is used. */
  readonly tagNumber: number;
  readonly constructed: boolean;
  readonly lengthForm: "definite" | "indefinite";
  readonly start: number;
  readonly contentStart: number;
  readonly contentEnd: number;
  readonly end: number;
  readonly content: Buffer;
  readonly children: readonly Asn1BerNode[];
}

/** One decoded identifier and length. Content bounds are not checked. */
export interface Asn1BerHeader {
  readonly tag: number;
  readonly tagClass: Asn1TagClass;
  readonly tagNumber: number;
  readonly constructed: boolean;
  /** Identifier octets, including high-tag-number continuation octets. */
  readonly identifierLength: number;
  /** Identifier and length octets; content starts this far past the value. */
  readonly headerLength: number;
  /** Content length, or null for an indefinite length. */
  readonly length: number | null;
}

/**
 * Subsequent identifier octets accepted in one high-tag-number form. Five
 * octets carry 35 bits, enough for a 32-bit four-character code such as the
 * private tags Apple Image4 manifests use.
 */
export const ASN1_MAX_TAG_NUMBER_OCTETS = 5;

const TAG_CLASSES: readonly Asn1TagClass[] = [
  "universal",
  "application",
  "context",
  "private",
];

/** The fixed parser allowance that prevented examining more BER structure. */
export interface Asn1BerConstraint {
  readonly resource: "nodes" | "depth";
  readonly limit: number;
}

export class Asn1BerFailure extends ParseFailureError<"malformed" | "limit"> {
  /**
   * @param truncated True when the input ended before the structure it
   *   declares: a cut tag, length or content, or an indefinite value with no
   *   end-of-contents marker. Callers read this instead of the message text.
   */
  constructor(
    message: string,
    readonly constraint: Asn1BerConstraint | null = null,
    readonly truncated = false,
  ) {
    super(
      constraint === null
        ? { kind: "malformed", format: "asn1-ber", detail: message }
        : {
            kind: "limit",
            format: "asn1-ber",
            detail: message,
            limit: {
              name:
                constraint.resource === "nodes" ? "asn1_nodes" : "asn1_depth",
              maximum: constraint.limit,
            },
          },
    );
    this.name = "Asn1BerFailure";
  }
}

interface Budget {
  remaining: number;
}

const fail = (
  message: string,
  constraint: Asn1BerConstraint | null = null,
): never => {
  throw new Asn1BerFailure(message, constraint);
};

const truncated = (message: string): never => {
  throw new Asn1BerFailure(message, null, true);
};

const readTagNumber = (
  bytes: Uint8Array,
  offset: number,
  end: number,
): { tagNumber: number; next: number } => {
  let tagNumber = 0;
  let cursor = offset + 1;
  for (let count = 0; ; count += 1) {
    if (count >= ASN1_MAX_TAG_NUMBER_OCTETS)
      return fail(
        `High-tag-number form at byte ${String(offset)} exceeds ${String(ASN1_MAX_TAG_NUMBER_OCTETS)} octets.`,
      );
    const byte = cursor < end ? bytes[cursor] : undefined;
    if (byte === undefined)
      return truncated("Truncated ASN.1 high tag number.");
    if (count === 0 && byte === 0x80)
      return fail(
        `High-tag-number form at byte ${String(offset)} has a leading zero octet.`,
      );
    tagNumber = tagNumber * 128 + (byte & 0x7f);
    cursor += 1;
    if ((byte & 0x80) === 0) break;
  }
  if (tagNumber < 0x1f)
    return fail(
      `High-tag-number form at byte ${String(offset)} encodes tag number ${String(tagNumber)}, which needs the low-tag form.`,
    );
  return { tagNumber, next: cursor };
};

/**
 * Decodes the identifier and length octets at `offset` without reading past
 * `end`. The caller checks the declared content against its own bounds.
 */
export const readAsn1BerHeader = (
  bytes: Uint8Array,
  offset = 0,
  end: number = bytes.length,
): Asn1BerHeader => {
  if (offset >= end || offset + 2 > end)
    return truncated("Truncated ASN.1 tag or length.");
  const tag = bytes[offset];
  if (tag === undefined) return truncated("Truncated ASN.1 tag.");
  if (tag === 0)
    return fail(
      "Unexpected end-of-contents marker outside an indefinite value.",
    );
  const constructed = (tag & 0x20) !== 0;
  const tagClass = TAG_CLASSES[tag >> 6] ?? "universal";
  let tagNumber = tag & 0x1f;
  let cursor = offset + 1;
  if (tagNumber === 0x1f)
    ({ tagNumber, next: cursor } = readTagNumber(bytes, offset, end));
  const identifierLength = cursor - offset;
  const lengthByte = cursor < end ? bytes[cursor] : undefined;
  if (lengthByte === undefined) return truncated("Truncated ASN.1 length.");
  cursor += 1;
  const base = { tag, tagClass, tagNumber, constructed, identifierLength };
  if (lengthByte === 0x80) {
    if (!constructed)
      return fail("Primitive ASN.1 values cannot use indefinite length.");
    return { ...base, headerLength: cursor - offset, length: null };
  }
  let length = 0;
  if ((lengthByte & 0x80) === 0) length = lengthByte;
  else {
    const width = lengthByte & 0x7f;
    if (width > 4) return fail("Unsupported ASN.1 long-form length width.");
    if (cursor + width > end) return truncated("Truncated ASN.1 long length.");
    for (let index = 0; index < width; index += 1) {
      const byte = bytes[cursor];
      if (byte === undefined) return truncated("Truncated ASN.1 length.");
      // Bitwise shifts sign-extend a four-octet length with bit 31 set.
      length = length * 256 + byte;
      cursor += 1;
    }
  }
  return { ...base, headerLength: cursor - offset, length };
};

/**
 * Reads one BER TLV and its constructed children. A reader shares its node
 * budget across separately encoded nested values, such as X.509 extnValue.
 */
export class Asn1BerReader {
  readonly #budget: Budget;

  constructor(
    readonly bytes: Buffer,
    readonly maxNodes: number,
    readonly maxDepth = 32,
  ) {
    this.#budget = { remaining: maxNodes };
  }

  read(offset = 0, end = this.bytes.length, depth = 0): Asn1BerNode {
    if (depth > this.maxDepth)
      return fail(`ASN.1 nesting exceeds ${String(this.maxDepth)} levels.`, {
        resource: "depth",
        limit: this.maxDepth,
      });
    if (this.#budget.remaining <= 0)
      return fail(
        `ASN.1 value count exceeds the ${String(this.maxNodes)}-node budget.`,
        { resource: "nodes", limit: this.maxNodes },
      );
    this.#budget.remaining -= 1;
    const header = readAsn1BerHeader(this.bytes, offset, end);
    const { tag, tagClass, tagNumber, constructed } = header;
    const indefinite = header.length === null;
    const contentStart = offset + header.headerLength;
    const children: Asn1BerNode[] = [];
    let contentEnd = contentStart;
    let encodedEnd = contentStart;
    if (indefinite) {
      let at = contentStart;
      let terminated = false;
      while (at < end) {
        if (at + 1 < end && this.bytes[at] === 0 && this.bytes[at + 1] === 0) {
          contentEnd = at;
          encodedEnd = at + 2;
          terminated = true;
          break;
        }
        const child = this.read(at, end, depth + 1);
        children.push(child);
        at = child.end;
      }
      if (!terminated)
        return truncated(
          "Indefinite ASN.1 value has no end-of-contents marker.",
        );
    } else {
      contentEnd = contentStart + (header.length ?? 0);
      if (contentEnd > end) return truncated("ASN.1 value exceeds its parent.");
      encodedEnd = contentEnd;
    }
    if (constructed && !indefinite) {
      let at = contentStart;
      while (at < contentEnd) {
        const child = this.read(at, contentEnd, depth + 1);
        children.push(child);
        at = child.end;
      }
    }
    return {
      tag,
      tagClass,
      tagNumber,
      constructed,
      lengthForm: indefinite ? "indefinite" : "definite",
      start: offset,
      contentStart,
      contentEnd,
      end: encodedEnd,
      content: this.bytes.subarray(contentStart, contentEnd),
      children,
    };
  }
}
