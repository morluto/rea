import { BinaryReader } from "../domain/binaryContainer.js";
import { formatGuidLittleEndian, GUID_LENGTH } from "./UefiGuid.js";
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
 * The fixed prefix contains magic, size, a 24-bit Next displacement and an
 * 8-bit attribute field. Body framing follows the attributes. See the
 * AMI NVAR format definition in UEFITool (common/ksy/ami_nvar.ksy).
 *
 * The factory-default store is itself one such entry (name "StdDefaults") whose
 * data holds a nested NVAR chain of the individual setup variables. The scan
 * therefore recurses into entries whose data starts with another valid entry,
 * so the result is a flat list with `depth` and `parent_offset` describing the
 * nesting instead of hiding the children behind an opaque data range.
 */

/** "NVAR" stored as a little-endian uint32. */
const NVAR_MAGIC = 0x5241564e;
const NVAR_HEADER_BYTES = 10;
const NVAR_MIN_ENTRY_BYTES = NVAR_HEADER_BYTES + 1;
const NVAR_ATTRIBUTES = {
  valid: 0x80,
  extendedHeader: 0x10,
  dataOnly: 0x08,
  localGuid: 0x04,
  asciiName: 0x02,
} as const;
/** ASCII search needle for locating candidate chains. */
const NVAR_BYTES = Buffer.from("NVAR", "ascii");

const isPrintableAscii = (byte: number): boolean =>
  byte >= 0x20 && byte <= 0x7e;

/** One parsed entry, before nesting metadata is attached. */
interface ParsedNvramEntry {
  readonly offset: number;
  readonly name: string | null;
  readonly next: number;
  readonly attributes: number;
  readonly guidIndex: number | null;
  readonly guid: string | null;
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

/** Locate a nonempty, terminated name within the framed record body. */
const readNvarName = (
  reader: BinaryReader,
  start: number,
  end: number,
  ascii: boolean,
): { name: string; dataOffset: number } | null => {
  const width = ascii ? 1 : 2;
  for (let cursor = start; cursor + width <= end; cursor += width) {
    const unit = ascii ? reader.u8(cursor) : reader.u16(cursor);
    if (unit === 0) {
      if (cursor === start) return null;
      return {
        name: reader.bytes.toString(ascii ? "ascii" : "utf16le", start, cursor),
        dataOffset: cursor + width,
      };
    }
    if (
      ascii
        ? !isPrintableAscii(unit)
        : unit < 0x20 || (unit >= 0xd800 && unit <= 0xdfff)
    )
      return null;
  }
  return null;
};

/** Parse one active record without following its declared link or resolving its GUID table. */
export const probeNvramEntry = (
  image: Buffer,
  offset: number,
  endOffset = image.length,
): ParsedNvramEntry | null => {
  if (offset < 0 || offset + NVAR_MIN_ENTRY_BYTES > endOffset) return null;
  const reader = new BinaryReader(image, true, "AMI NVAR");
  if (reader.u32(offset) !== NVAR_MAGIC) return null;
  const totalSize = reader.u16(offset + 4);
  const entryEnd = offset + totalSize;
  if (totalSize < NVAR_MIN_ENTRY_BYTES || entryEnd > endOffset) return null;

  const attributes = reader.u8(offset + 9);
  if ((attributes & NVAR_ATTRIBUTES.valid) === 0) return null;
  const next = reader.u16(offset + 6) | (reader.u8(offset + 8) << 16);
  const bodyStart = offset + NVAR_HEADER_BYTES;
  let dataEnd = entryEnd;
  if ((attributes & NVAR_ATTRIBUTES.extendedHeader) !== 0) {
    if (entryEnd - bodyStart < 3) return null;
    const extensionSize = reader.u16(entryEnd - 2);
    if (extensionSize < 3 || extensionSize > entryEnd - bodyStart) return null;
    dataEnd -= extensionSize;
  }

  let dataOffset = bodyStart;
  let name: string | null = null;
  let guidIndex: number | null = null;
  let guid: string | null = null;
  if ((attributes & NVAR_ATTRIBUTES.dataOnly) === 0) {
    const inlineGuid = (attributes & NVAR_ATTRIBUTES.localGuid) !== 0;
    const nameStart = bodyStart + (inlineGuid ? GUID_LENGTH : 1);
    const parsedName = readNvarName(
      reader,
      nameStart,
      dataEnd,
      (attributes & NVAR_ATTRIBUTES.asciiName) !== 0,
    );
    if (parsedName === null) return null;
    ({ name, dataOffset } = parsedName);
    if (inlineGuid) guid = formatGuidLittleEndian(image, bodyStart);
    else guidIndex = reader.u8(bodyStart);
  }

  return {
    offset,
    name,
    next,
    attributes,
    guidIndex,
    guid,
    dataOffset,
    dataLength: dataEnd - dataOffset,
    endOffset: entryEnd,
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
      probeNvramEntry(
        image,
        entry.dataOffset,
        entry.dataOffset + entry.dataLength,
      ) !== null
    ) {
      if (depth < maxDepth) {
        const nested = collectChain(
          image,
          entry.dataOffset,
          entry.dataOffset + entry.dataLength,
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
      image[lastEnd + padding] === 0xff
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
