import { UEFI_FIRMWARE_LIMITS } from "../domain/uefi/uefiLimits.js";
/**
 * AMI NVRAM variable-store cartography for UEFI flash images.
 *
 * Vendor AMI images carry factory defaults (and other setup state) in a
 * proprietary variable store whose entries are chained by the ASCII magic
 * "NVAR". This module finds those chains inside a raw image and reports their
 * structure as observations; it never interprets the variable data and never
 * executes anything.
 *
 * Observed entry layout (little-endian):
 *
 *   "NVAR"           4-byte magic
 *   u16 total_size   total entry size, header + name + data
 *   u32 attributes   observed 0x82FFFFFF / 0x83FFFFFF
 *   u8  state        vendor state byte
 *   char name[]      printable ASCII, NUL-terminated
 *   u8  data[]       total_size - header - name - 1 bytes
 *
 * The factory-default store is itself one such entry (name "StdDefaults") whose
 * data holds a nested NVAR chain of the individual setup variables. The scan
 * therefore recurses into entries whose data starts with another valid entry,
 * so the result is a flat list with `depth` and `parent_offset` describing the
 * nesting instead of hiding the children behind an opaque data range.
 */

/** "NVAR" stored as a little-endian uint32. */
const NVAR_MAGIC = 0x5241564e;
/** Fixed prefix bytes of an AMI NVRAM entry (magic + size + attributes + state). */
const NVAR_HEADER_BYTES = 11;
/** Shortest plausible entry: header plus a one-character name and its NUL. */
const NVAR_MIN_ENTRY_BYTES = NVAR_HEADER_BYTES + 2;
/** Attribute high bytes observed on vendor NVRAM entries. */
const NVAR_ATTRIBUTE_HIGH_BYTES: ReadonlySet<number> = new Set([0x82, 0x83]);
/** The 24-bit tail shared by every observed AMI variable attribute value. */
const NVAR_ATTRIBUTE_TAIL = 0xffffff;
/** ASCII search needle for locating candidate chains. */
const NVAR_BYTES = Buffer.from("NVAR", "ascii");

const isPrintableAscii = (byte: number): boolean =>
  byte >= 0x20 && byte <= 0x7e;

/** One parsed entry, before nesting metadata is attached. */
interface ParsedNvramEntry {
  readonly offset: number;
  readonly name: string;
  readonly attributes: number;
  readonly state: number;
  readonly dataOffset: number;
  readonly dataLength: number;
  /** Byte just past this entry; the next sibling entry starts here. */
  readonly endOffset: number;
}

/** One parsed AMI NVRAM variable entry with its nesting position. */
export interface AmiNvramVariable extends ParsedNvramEntry {
  /** 0 for a top-level entry, 1 for a variable inside a container, and so on. */
  readonly depth: number;
  /** Offset of the enclosing container entry, or null at the top level. */
  readonly parentOffset: number | null;
}

/** One top-level AMI NVRAM chain and its flattened nested variables. */
export interface AmiNvramStore {
  /** Offset of the first top-level entry. */
  readonly offset: number;
  /** Name of the first top-level entry (for example "StdDefaults"). */
  readonly name: string | null;
  /** Flattened entries across all depths, ordered by offset. */
  readonly variables: readonly AmiNvramVariable[];
  /** Count of trailing 0xFF padding bytes after the top-level chain, if any. */
  readonly trailingPadding: number | null;
}

/** Outcome of scanning an image for AMI NVRAM stores. */
export interface AmiNvramScan {
  readonly stores: readonly AmiNvramStore[];
  readonly coverage: "complete" | "partial";
  readonly limitations: readonly string[];
}

/**
 * Parse one AMI NVRAM variable entry at `offset`, or return null when the bytes
 * do not satisfy the vendor signature. The name must be printable ASCII
 * terminated inside the declared size, and the attribute tail must match, which
 * keeps random "NVAR" byte runs out of the result.
 */
export const probeNvramEntry = (
  image: Buffer,
  offset: number,
  endOffset = image.length,
): ParsedNvramEntry | null => {
  if (offset < 0 || offset + NVAR_MIN_ENTRY_BYTES > endOffset) return null;
  if (image.readUInt32LE(offset) !== NVAR_MAGIC) return null;
  const totalSize = image.readUInt16LE(offset + 4);
  if (totalSize < NVAR_MIN_ENTRY_BYTES || offset + totalSize > endOffset)
    return null;
  const attributes = image.readUInt32LE(offset + 6);
  if (
    !NVAR_ATTRIBUTE_HIGH_BYTES.has(attributes >>> 24) ||
    (attributes & NVAR_ATTRIBUTE_TAIL) !== NVAR_ATTRIBUTE_TAIL
  )
    return null;
  const state = image.readUInt8(offset + 10);
  const nameStart = offset + NVAR_HEADER_BYTES;
  const nameTerminator = image
    .subarray(nameStart, offset + totalSize)
    .indexOf(0);
  const nameEnd = nameTerminator < 0 ? -1 : nameStart + nameTerminator;
  if (nameEnd < 0 || nameEnd >= offset + totalSize) return null;
  for (let i = nameStart; i < nameEnd; i += 1) {
    if (!isPrintableAscii(image.readUInt8(i))) return null;
  }
  if (nameEnd === nameStart) return null;
  const dataOffset = nameEnd + 1;
  return {
    offset,
    name: image.toString("ascii", nameStart, nameEnd),
    attributes,
    state,
    dataOffset,
    dataLength: offset + totalSize - dataOffset,
    endOffset: offset + totalSize,
  };
};

/**
 * Walk one sibling chain at `depth`, bounded by `endOffset` (the enclosing
 * container's data end), appending each entry and recursing into entries whose
 * data begins with another valid NVAR entry. Returns the end of the last
 * sibling and whether a valid nested chain was cut by the depth budget.
 */
const collectChain = (
  image: Buffer,
  startOffset: number,
  endOffset: number,
  depth: number,
  parentOffset: number | null,
  maxDepth: number,
  out: AmiNvramVariable[],
  reserve: () => boolean,
): { lastEnd: number; depthLimitedAt: number | null } => {
  let cursor = startOffset;
  let lastEnd = startOffset;
  let depthLimitedAt: number | null = null;
  while (cursor + NVAR_MIN_ENTRY_BYTES <= endOffset) {
    const entry = probeNvramEntry(image, cursor, endOffset);
    if (entry === null) break;
    if (!reserve()) break;
    out.push({ ...entry, depth, parentOffset });
    lastEnd = entry.endOffset;
    if (
      entry.dataLength >= NVAR_MIN_ENTRY_BYTES &&
      probeNvramEntry(image, entry.dataOffset, entry.endOffset) !== null
    ) {
      if (depth < maxDepth) {
        const nested = collectChain(
          image,
          entry.dataOffset,
          entry.endOffset,
          depth + 1,
          entry.offset,
          maxDepth,
          out,
          reserve,
        );
        depthLimitedAt ??= nested.depthLimitedAt;
      } else {
        // A valid nested chain exists below the depth budget.
        depthLimitedAt ??= entry.offset;
      }
    }
    cursor = entry.endOffset;
  }
  return { lastEnd, depthLimitedAt };
};

/** Scan a raw image for chained AMI NVRAM variable stores. */
export const scanAmiNvramStores = (
  image: Buffer,
  maxStores: number,
  maxDepth: number,
  checkpoint: () => void = () => {},
): AmiNvramScan => {
  const stores: AmiNvramStore[] = [];
  const limitations: string[] = [];
  let depthLimitedAt: number | null = null;
  let remaining: number = UEFI_FIRMWARE_LIMITS.scanRecords;
  let recordLimited = false;
  const reserve = (): boolean => {
    checkpoint();
    if (remaining === 0) {
      recordLimited = true;
      return false;
    }
    remaining -= 1;
    return true;
  };
  let searchFrom = 0;
  while (searchFrom + NVAR_MIN_ENTRY_BYTES <= image.length) {
    checkpoint();
    const firstOffset = image.indexOf(NVAR_BYTES, searchFrom);
    if (firstOffset < 0) break;
    const first = probeNvramEntry(image, firstOffset);
    if (first === null) {
      searchFrom = firstOffset + 1;
      continue;
    }
    if (stores.length >= maxStores) {
      limitations.push(
        `Stopped after ${maxStores} AMI NVRAM stores; additional stores exist.`,
      );
      return { stores, coverage: "partial", limitations };
    }
    const variables: AmiNvramVariable[] = [];
    const walk = collectChain(
      image,
      firstOffset,
      image.length,
      0,
      null,
      maxDepth,
      variables,
      reserve,
    );
    depthLimitedAt ??= walk.depthLimitedAt;
    const lastEnd = walk.lastEnd;
    let padding = 0;
    while (
      lastEnd + padding < image.length &&
      image.readUInt8(lastEnd + padding) === 0xff
    ) {
      if (padding % 65536 === 0) checkpoint();
      padding += 1;
    }
    if (variables.length > 0)
      stores.push({
        offset: firstOffset,
        name: first.name,
        variables,
        trailingPadding: padding > 0 ? padding : null,
      });
    searchFrom = lastEnd;
    if (recordLimited) {
      limitations.push(
        `Structural record limit ${UEFI_FIRMWARE_LIMITS.scanRecords} reached in the NVAR chain at 0x${firstOffset.toString(16)}.`,
      );
      return { stores, coverage: "partial", limitations };
    }
  }
  if (stores.length === 0)
    limitations.push(
      "No AMI NVRAM variable stores (NVAR chains) were found in the image.",
    );
  if (depthLimitedAt !== null)
    limitations.push(
      `Nested NVAR chains exist below max_depth ${maxDepth} (first omitted under variable at 0x${depthLimitedAt.toString(16)}); coverage is partial.`,
    );
  return {
    stores,
    coverage: depthLimitedAt === null ? "complete" : "partial",
    limitations,
  };
};
