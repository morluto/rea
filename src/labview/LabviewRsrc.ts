import { inflateSync } from "node:zlib";
import {
  BinaryFormatFailure,
  BinaryReader,
} from "../domain/binaryContainer.js";

const RSRC_MAGIC = "RSRC\r\n";
const HEADER_BYTES = 32;
const LIST_HEADER_BYTES = 20;
const BLOCK_HEADER_BYTES = 12;
const SECTION_START_BYTES = 20;
const MAX_BLOCKS = 4096;
const MAX_SECTIONS = 4096;

export type LabviewCoding = "none" | "zlib" | "xor" | "unknown";

export interface LabviewSection {
  readonly index: number;
  readonly name: string | null;
  readonly storedBytes: number;
  readonly decodedBytes: number | null;
  readonly coding: LabviewCoding;
}

export interface LabviewBlock {
  readonly identifier: string;
  readonly sections: readonly LabviewSection[];
}

export interface LabviewRsrc {
  readonly formatVersion: number;
  readonly fileType: string;
  readonly creator: string;
  readonly dataOffset: number;
  readonly dataBytes: number;
  readonly infoOffset: number;
  readonly infoBytes: number;
  readonly labviewVersion: string | null;
  readonly blockDiagram: "present" | "absent";
  readonly frontPanel: "present" | "absent";
  readonly blocks: readonly LabviewBlock[];
}

export type LabviewParseResult =
  | { readonly ok: true; readonly value: LabviewRsrc }
  | { readonly ok: false; readonly reason: string };

/** A bounded check that a declared range lies inside the container. */
const inside = (offset: number, length: number, total: number): boolean =>
  offset >= 0 && length >= 0 && offset + length <= total;

/**
 * Whether the stored bytes begin with the four-byte big-endian decoded length
 * followed by a zlib stream. LabVIEW writes that pair for blocks this reader
 * decodes; the declared length is verified before it is reported.
 */
const decodeSection = (
  blockIdentifier: string,
  stored: Buffer,
): { coding: LabviewCoding; decodedBytes: number | null } => {
  // LVzp (the embedded program tree) is XOR-coded, not compressed, and this
  // reader inventories it without materializing its payload.
  if (blockIdentifier === "LVzp") return { coding: "xor", decodedBytes: null };
  if (stored.length < 6) return { coding: "none", decodedBytes: null };
  try {
    const head = new BinaryReader(stored, false, "labview-rsrc");
    const declared = head.u32(0);
    const second = head.u8(5);
    if (
      head.u8(4) !== 0x78 ||
      (second !== 0x01 && second !== 0x9c && second !== 0xda)
    )
      return { coding: "none", decodedBytes: null };
    try {
      const decoded = inflateSync(stored.subarray(4));
      return decoded.length === declared
        ? { coding: "zlib", decodedBytes: decoded.length }
        : { coding: "unknown", decodedBytes: null };
    } catch {
      return { coding: "unknown", decodedBytes: null };
    }
  } catch {
    return { coding: "none", decodedBytes: null };
  }
};

/** Read one Pascal name from a block's name list, bounded by its container. */
const sectionName = (
  reader: BinaryReader,
  nameBase: number,
  nameOffset: number,
): string | null => {
  if (nameOffset === 0xffffffff) return null;
  const at = nameBase + nameOffset;
  if (!inside(at, 1, reader.bytes.length)) return null;
  const length = reader.u8(at);
  if (!inside(at + 1, length, reader.bytes.length)) return null;
  return reader.range(at + 1, length, "section name").toString("latin1");
};

/** The LabVIEW version recorded by a vers section, or null when none is legible. */
const versionOf = (sections: readonly Uint8Array[]): string | null => {
  for (const section of sections) {
    const text = Buffer.from(section).toString("latin1");
    const match = /\d+\.\d+/u.exec(text);
    if (match !== null) return match[0];
  }
  return null;
};

/**
 * Parse one complete RSRC container: header, block-info list, and every block
 * section. Every declared range is bounds-checked; a truncated or malformed
 * container fails rather than returning a partial block list.
 */
export const parseLabviewRsrc = (bytes: Buffer): LabviewParseResult => {
  const reader = new BinaryReader(bytes, false, "labview-rsrc");
  try {
    if (
      bytes.length < HEADER_BYTES ||
      reader.range(0, 6, "RSRC magic").toString("latin1") !== RSRC_MAGIC
    )
      return { ok: false, reason: "not an RSRC container" };
    const formatVersion = reader.u16(6);
    const fileType = reader.range(8, 4, "file type").toString("latin1");
    const creator = reader.range(12, 4, "creator").toString("latin1");
    const infoOffset = reader.u32(16);
    const infoBytes = reader.u32(20);
    const dataOffset = reader.u32(24);
    const dataBytes = reader.u32(28);
    if (
      !inside(dataOffset, dataBytes, bytes.length) ||
      !inside(infoOffset, infoBytes, bytes.length)
    )
      return { ok: false, reason: "RSRC data or info range exceeds the file" };
    if (
      infoBytes < HEADER_BYTES + LIST_HEADER_BYTES ||
      infoOffset < HEADER_BYTES
    )
      return { ok: false, reason: "RSRC info section is too small" };
    const blockInfoOffset = reader.u32(infoOffset + 44);
    if (blockInfoOffset < HEADER_BYTES + LIST_HEADER_BYTES)
      return {
        ok: false,
        reason: "RSRC block-info offset overlaps its header",
      };
    const blockInfo = infoOffset + blockInfoOffset;
    const blockCount = reader.u32(blockInfo) + 1;
    if (blockCount > MAX_BLOCKS)
      return {
        ok: false,
        reason: "RSRC block count exceeds the supported bound",
      };
    const blockHeadersAt = blockInfo + 4;
    if (!inside(blockHeadersAt, blockCount * BLOCK_HEADER_BYTES, bytes.length))
      return { ok: false, reason: "truncated RSRC block headers" };

    const blocks: LabviewBlock[] = [];
    const versionSections: Uint8Array[] = [];
    for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
      const headerAt = blockHeadersAt + blockIndex * BLOCK_HEADER_BYTES;
      const identifier = reader
        .range(headerAt, 4, "block identifier")
        .toString("latin1");
      const sectionCount = reader.u32(headerAt + 4) + 1;
      const sectionStartsOffset = reader.u32(headerAt + 8);
      if (sectionCount > MAX_SECTIONS)
        return {
          ok: false,
          reason: "RSRC section count exceeds the supported bound",
        };
      const startsAt = blockInfo + sectionStartsOffset;
      if (!inside(startsAt, sectionCount * SECTION_START_BYTES, bytes.length))
        return { ok: false, reason: "truncated RSRC section starts" };
      const nameBase = startsAt + sectionCount * SECTION_START_BYTES;
      const sections: LabviewSection[] = [];
      for (let index = 0; index < sectionCount; index += 1) {
        const at = startsAt + index * SECTION_START_BYTES;
        const declaredIndex = reader.i32(at);
        const nameOffset = reader.u32(at + 4);
        const sectionOffset = reader.u32(at + 12);
        const sectionAt = dataOffset + sectionOffset;
        if (!inside(sectionAt, 4, bytes.length))
          return { ok: false, reason: "truncated RSRC section data header" };
        const storedBytes = reader.u32(sectionAt);
        if (!inside(sectionAt + 4, storedBytes, bytes.length))
          return {
            ok: false,
            reason: "RSRC section data exceeds the container",
          };
        const stored = reader.range(sectionAt + 4, storedBytes, "section data");
        const decoded = decodeSection(identifier, stored);
        if (identifier === "vers") versionSections.push(stored);
        sections.push({
          index: declaredIndex >= 0 ? declaredIndex : index,
          name: sectionName(reader, nameBase, nameOffset),
          storedBytes,
          decodedBytes: decoded.decodedBytes,
          coding: decoded.coding,
        });
      }
      blocks.push({ identifier, sections });
    }

    const hasPrefix = (prefix: string): boolean =>
      blocks.some(({ identifier }) => identifier.startsWith(prefix));
    return {
      ok: true,
      value: {
        formatVersion,
        fileType,
        creator,
        dataOffset,
        dataBytes,
        infoOffset,
        infoBytes,
        labviewVersion: versionOf(versionSections),
        blockDiagram: hasPrefix("BDH") ? "present" : "absent",
        frontPanel: hasPrefix("FPH") ? "present" : "absent",
        blocks,
      },
    };
  } catch (cause) {
    return {
      ok: false,
      reason:
        cause instanceof BinaryFormatFailure
          ? cause.message
          : "malformed RSRC container",
    };
  }
};
