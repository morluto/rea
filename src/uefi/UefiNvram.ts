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

type FramedNvarRecord =
  | { kind: "inactive" | "malformed"; endOffset: number }
  | { kind: "active"; entry: ParsedNvramEntry };

type NvarRecord =
  | { kind: "end" }
  | { kind: "invalid-frame" }
  | FramedNvarRecord;

function readNvarRecord(
  reader: BinaryReader,
  offset: number,
  endOffset: number,
): NvarRecord {
  if (
    offset < 0 ||
    offset + NVAR_BYTES.length > endOffset ||
    reader.u32(offset) !== NVAR_MAGIC
  )
    return { kind: "end" };
  if (offset + NVAR_HEADER_BYTES > endOffset) return { kind: "invalid-frame" };
  const totalSize = reader.u16(offset + 4);
  const entryEnd = offset + totalSize;
  if (totalSize < NVAR_HEADER_BYTES || entryEnd > endOffset)
    return { kind: "invalid-frame" };

  const attributes = reader.u8(offset + 9);
  if ((attributes & NVAR_ATTRIBUTES.valid) === 0)
    return { kind: "inactive", endOffset: entryEnd };
  const entry = parseActiveRecord(reader, offset, entryEnd, attributes);
  return entry === null
    ? { kind: "malformed", endOffset: entryEnd }
    : { kind: "active", entry };
}

function parseActiveRecord(
  reader: BinaryReader,
  offset: number,
  entryEnd: number,
  attributes: number,
): ParsedNvramEntry | null {
  if (entryEnd - offset < NVAR_MIN_ENTRY_BYTES) return null;
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
    if (inlineGuid) guid = formatGuidLittleEndian(reader.bytes, bodyStart);
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
}

/** Walk a confirmed chain without using record bodies to advance its cursor. */
function collectChain(
  reader: BinaryReader,
  first: { offset: number; record: FramedNvarRecord },
  endOffset: number,
  depth: number,
  parentOffset: number | null,
  maxDepth: number,
  out: AmiNvramVariable[],
  reserve: () => boolean,
  noteOmission: (detail: string) => void,
): number {
  let cursor = first.offset;
  let record: NvarRecord = first.record;
  while (record.kind !== "end") {
    if (!reserve()) break;
    if (record.kind === "invalid-frame") {
      noteOmission(
        `NVAR record at 0x${cursor.toString(16)} has an incomplete or invalid extent.`,
      );
      break;
    }
    if (record.kind !== "active") {
      if (record.kind === "malformed")
        noteOmission(
          `NVAR record at 0x${cursor.toString(16)} has malformed variable data.`,
        );
      cursor = record.endOffset;
      record = readNvarRecord(reader, cursor, endOffset);
      continue;
    }

    const { entry } = record;
    out.push({ ...entry, depth, parentOffset });
    const dataEnd = entry.dataOffset + entry.dataLength;
    const nested = readNvarRecord(reader, entry.dataOffset, dataEnd);
    // Framing can establish a nested chain even if its first body is unusable.
    if (nested.kind !== "end" && nested.kind !== "invalid-frame") {
      if (depth < maxDepth) {
        collectChain(
          reader,
          { offset: entry.dataOffset, record: nested },
          dataEnd,
          depth + 1,
          entry.offset,
          maxDepth,
          out,
          reserve,
          noteOmission,
        );
      } else {
        noteOmission(
          `Nested NVAR chain below max_depth ${maxDepth} under variable at 0x${entry.offset.toString(16)}.`,
        );
      }
    }
    cursor = entry.endOffset;
    record = readNvarRecord(reader, cursor, endOffset);
  }
  return cursor;
}

/** Scan a raw image for chained AMI NVRAM variable stores. */
export const scanAmiNvramStores = (
  image: Buffer,
  maxStores: number,
  maxDepth: number,
  checkpoint: () => void = () => {},
): AmiNvramScan => {
  const stores: AmiNvramStore[] = [];
  const limitations: string[] = [];
  const reader = new BinaryReader(image, true, "AMI NVAR");
  let partial = false;
  const noteOmission = (detail: string): void => {
    partial = true;
    if (limitations.length < 512) limitations.push(detail);
  };
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
    const first = readNvarRecord(reader, firstOffset, image.length);
    if (first.kind !== "active") {
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
    const lastEnd = collectChain(
      reader,
      { offset: firstOffset, record: first },
      image.length,
      0,
      null,
      maxDepth,
      variables,
      reserve,
      noteOmission,
    );
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
        name: first.entry.name,
        variables,
        trailingPadding: padding > 0 ? padding : null,
      });
    searchFrom = Math.max(firstOffset + 1, lastEnd);
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
  return {
    stores,
    coverage: partial ? "partial" : "complete",
    limitations,
  };
};
