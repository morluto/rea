import { inflateSync } from "node:zlib";
import { BinaryReader } from "../domain/binaryContainer.js";
import {
  decodeLimit,
  malformedInput,
  ParseFailureError,
  truncatedInput,
  type LimitRef,
} from "../domain/parseFailure.js";

const FORMAT = "labview-rsrc";
const RSRC_MAGIC = "RSRC\r\n";
const HEADER_BYTES = 32;
const LIST_HEADER_BYTES = 20;
const BLOCK_HEADER_BYTES = 12;
const SECTION_START_BYTES = 20;
const MAX_BLOCKS = 4096;
const MAX_SECTIONS_PER_BLOCK = 4096;
/**
 * Blocks may share one section-start table, so per-block limits alone would
 * admit 4096^2 section objects from a container far smaller than the file
 * bound. One total allowance bounds the report the reader retains and maps.
 */
const MAX_TOTAL_SECTIONS = 4096;
/** Decoded work one container may spend, independent of its compressed size. */
const MAX_DECODED_BYTES = 64 * 1024 * 1024;
/** Compressed bytes one container may attempt, independent of its declared output. */
const MAX_COMPRESSED_BYTES = 64 * 1024 * 1024;

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

export type LabviewPresence = "present" | "absent" | "unknown";

export interface LabviewRsrc {
  readonly formatVersion: number;
  readonly fileType: string;
  readonly creator: string;
  readonly dataOffset: number;
  readonly dataBytes: number;
  readonly infoOffset: number;
  readonly infoBytes: number;
  readonly labviewVersion: string | null;
  readonly blockDiagram: LabviewPresence;
  readonly frontPanel: LabviewPresence;
  readonly blocks: readonly LabviewBlock[];
}

export type LabviewParseResult =
  | { readonly ok: true; readonly value: LabviewRsrc }
  | { readonly ok: false; readonly failure: ParseFailureError };

/** A bounded check that a declared range lies inside the container. */
const inside = (offset: number, length: number, total: number): boolean =>
  offset >= 0 && length >= 0 && offset + length <= total;

const limit = (name: string, maximum: number, required?: number): LimitRef => ({
  name,
  maximum,
  ...(required === undefined ? {} : { required }),
});

/**
 * zlib's two-byte header, checked by its format rule rather than by a list of
 * pairs: the low nibble of CMF is the deflate method, CMF/FLG as a big-endian
 * word is a multiple of 31, and FDICT is unsupported here. This admits every
 * level Node produces, including the `78 5e` pair of level 3.
 */
const zlibHeaderValid = (cmf: number, flg: number): boolean =>
  (cmf & 0x0f) === 8 &&
  cmf >> 4 <= 7 &&
  ((cmf << 8) | flg) % 31 === 0 &&
  (flg & 0x20) === 0;

interface DecodeBudget {
  decodedRemaining: number;
  inputRemaining: number;
}

interface SectionDecoding {
  readonly coding: LabviewCoding;
  readonly decodedBytes: number | null;
  /** The decoded payload, kept only for blocks whose content is read back. */
  readonly decoded: Buffer | undefined;
}

/**
 * Classify one stored section. A zlib section is decoded only to its declared
 * byte count: the declared length bounds the allocation before inflation, and
 * the container's remaining decode budget bounds the total work.
 */
const decodeSection = (
  blockIdentifier: string,
  stored: Buffer,
  budget: DecodeBudget,
  cacheKey: string,
  cache: Map<string, SectionDecoding>,
): SectionDecoding => {
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;
  const unknown: SectionDecoding = {
    coding: "unknown",
    decodedBytes: null,
    decoded: undefined,
  };
  const result = (): SectionDecoding => {
    // LVzp (the embedded program tree) is XOR-coded, not compressed, and this
    // reader inventories it without materializing its payload.
    if (blockIdentifier === "LVzp")
      return { coding: "xor", decodedBytes: null, decoded: undefined };
    if (stored.length < 6)
      return { coding: "none", decodedBytes: null, decoded: undefined };
    const head = new BinaryReader(stored, false, FORMAT);
    const declared = head.u32(0);
    if (!zlibHeaderValid(head.u8(4), head.u8(5)))
      return { coding: "none", decodedBytes: null, decoded: undefined };
    // Charge both the compressed input and the declared output: a stream with
    // a tiny declared length can still make the inflater traverse megabytes,
    // and several section records may point at the same stored bytes.
    if (stored.length > budget.inputRemaining) return unknown;
    if (declared > budget.decodedRemaining) return unknown;
    budget.inputRemaining -= stored.length;
    budget.decodedRemaining -= declared;
    try {
      const decoded = inflateSync(stored.subarray(4), {
        // Bound the allocation by the declared length, not by the input size.
        maxOutputLength: Math.max(1, declared),
      });
      if (decoded.length !== declared) return unknown;
      return {
        coding: "zlib",
        decodedBytes: decoded.length,
        decoded: blockIdentifier === "vers" ? decoded : undefined,
      };
    } catch {
      return unknown;
    }
  };
  const value = result();
  cache.set(cacheKey, value);
  return value;
};

/** Read one Pascal name from a block's name list, bounded by the declared list. */
const sectionName = (
  reader: BinaryReader,
  nameBase: number,
  nameOffset: number,
  infoEnd: number,
): string | null => {
  // Only the sentinel means "this section has no name". A name that leaves
  // the declared list is malformed input, not an observed omission.
  if (nameOffset === 0xffffffff) return null;
  const at = nameBase + nameOffset;
  if (!inside(at, 1, infoEnd))
    throw truncatedInput(FORMAT, "RSRC section name leaves the info section", {
      offset: at,
      field: "section name",
    });
  const length = reader.u8(at);
  if (!inside(at + 1, length, infoEnd))
    throw truncatedInput(FORMAT, "RSRC section name exceeds the info section", {
      offset: at,
      field: "section name",
    });
  return reader.range(at + 1, length, "section name").toString("latin1");
};

/** Bytes of a `vers` section searched for a version; the value is at its start. */
const MAX_VERSION_SCAN_BYTES = 64 * 1024;

const isDecimalDigit = (code: number): boolean => code >= 0x30 && code <= 0x39;

/**
 * The first `major.minor` decimal pair in one bounded, single pass. A regex
 * backtracks over a long digit run (quadratic on a digit-only section), so this
 * scan advances once per byte and never revisits them.
 */
const firstVersion = (section: Uint8Array): string | null => {
  const text = Buffer.from(
    section.subarray(0, MAX_VERSION_SCAN_BYTES),
  ).toString("latin1");
  for (let index = 0; index < text.length; index += 1) {
    if (!isDecimalDigit(text.charCodeAt(index))) continue;
    let majorEnd = index;
    while (majorEnd < text.length && isDecimalDigit(text.charCodeAt(majorEnd)))
      majorEnd += 1;
    if (text.charCodeAt(majorEnd) !== 0x2e) {
      index = majorEnd - 1;
      continue;
    }
    let minorEnd = majorEnd + 1;
    const minorStart = minorEnd;
    while (minorEnd < text.length && isDecimalDigit(text.charCodeAt(minorEnd)))
      minorEnd += 1;
    if (minorEnd > minorStart) return text.slice(index, minorEnd);
    index = majorEnd;
  }
  return null;
};

/** The LabVIEW version recorded by a vers section, or null when none is legible. */
const versionOf = (sections: readonly Uint8Array[]): string | null => {
  for (const section of sections) {
    const version = firstVersion(section);
    if (version !== null) return version;
  }
  return null;
};

/**
 * Parse one complete RSRC container: header, block-info list, and every block
 * section. Every declared range is checked against the section that owns it,
 * not merely the file, and every allocation is bounded before it happens. A
 * truncated or malformed container fails with its parse facts rather than
 * returning a partial block list.
 */
export const parseLabviewRsrc = (bytes: Buffer): LabviewParseResult => {
  const reader = new BinaryReader(bytes, false, FORMAT);
  try {
    if (
      bytes.length < HEADER_BYTES ||
      reader.range(0, 6, "RSRC magic").toString("latin1") !== RSRC_MAGIC
    )
      throw malformedInput(FORMAT, "not an RSRC container", { offset: 0 });
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
      throw truncatedInput(FORMAT, "RSRC data or info range exceeds the file", {
        offset: infoOffset,
      });
    if (
      infoBytes < HEADER_BYTES + LIST_HEADER_BYTES ||
      infoOffset < HEADER_BYTES
    )
      throw truncatedInput(FORMAT, "RSRC info section is too small", {
        offset: infoOffset,
      });
    // Every nested record is checked against the section that declares it, so
    // a container whose data/info ranges do not cover its structure fails.
    const infoEnd = infoOffset + infoBytes;
    const dataEnd = dataOffset + dataBytes;
    const blockInfoOffset = reader.u32(infoOffset + 44);
    if (blockInfoOffset < HEADER_BYTES + LIST_HEADER_BYTES)
      throw malformedInput(
        FORMAT,
        "RSRC block-info offset overlaps its header",
        { offset: infoOffset + 44 },
      );
    const blockInfo = infoOffset + blockInfoOffset;
    if (!inside(blockInfo, 4, infoEnd))
      throw truncatedInput(
        FORMAT,
        "RSRC block-info list is outside the info section",
        {
          offset: blockInfo,
        },
      );
    // The list declares its own extent at infoOffset + 48; records outside it
    // are not part of this container, so it owns the records that follow.
    const blockInfoBytes = reader.u32(infoOffset + 48);
    // Real containers can declare a list extent that runs past the resource
    // payload's own end, so the declared extent and the container both bound
    // the records: neither may be exceeded.
    if (blockInfoBytes < 4)
      throw truncatedInput(FORMAT, "RSRC block-info list declares no records", {
        offset: infoOffset + 48,
      });
    const listEnd = Math.min(blockInfo + blockInfoBytes, infoEnd);
    const blockCount = reader.u32(blockInfo) + 1;
    if (blockCount > MAX_BLOCKS)
      throw decodeLimit(
        FORMAT,
        "RSRC block count exceeds the supported bound",
        limit("labview_rsrc_blocks", MAX_BLOCKS, blockCount),
        { offset: blockInfo },
      );
    const blockHeadersAt = blockInfo + 4;
    if (!inside(blockHeadersAt, blockCount * BLOCK_HEADER_BYTES, listEnd))
      throw truncatedInput(FORMAT, "truncated RSRC block headers", {
        offset: blockHeadersAt,
      });

    const blocks: LabviewBlock[] = [];
    const versionSections: Uint8Array[] = [];
    const budget: DecodeBudget = {
      decodedRemaining: MAX_DECODED_BYTES,
      inputRemaining: MAX_COMPRESSED_BYTES,
    };
    const decodedSections = new Map<string, SectionDecoding>();
    let totalSections = 0;
    for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
      const headerAt = blockHeadersAt + blockIndex * BLOCK_HEADER_BYTES;
      const identifier = reader
        .range(headerAt, 4, "block identifier")
        .toString("latin1");
      const sectionCount = reader.u32(headerAt + 4) + 1;
      if (sectionCount > MAX_SECTIONS_PER_BLOCK)
        throw decodeLimit(
          FORMAT,
          "RSRC section count exceeds the supported bound",
          limit(
            "labview_rsrc_sections_per_block",
            MAX_SECTIONS_PER_BLOCK,
            sectionCount,
          ),
          { offset: headerAt + 4, field: identifier },
        );
      totalSections += sectionCount;
      if (totalSections > MAX_TOTAL_SECTIONS)
        throw decodeLimit(
          FORMAT,
          "RSRC total section count exceeds the supported bound",
          limit(
            "labview_rsrc_total_sections",
            MAX_TOTAL_SECTIONS,
            totalSections,
          ),
          { offset: headerAt + 4, field: identifier },
        );
      const sectionStartsOffset = reader.u32(headerAt + 8);
      const startsAt = blockInfo + sectionStartsOffset;
      if (!inside(startsAt, sectionCount * SECTION_START_BYTES, listEnd))
        throw truncatedInput(FORMAT, "truncated RSRC section starts", {
          offset: startsAt,
          field: identifier,
        });
      const nameBase = startsAt + sectionCount * SECTION_START_BYTES;
      const sections: LabviewSection[] = [];
      for (let index = 0; index < sectionCount; index += 1) {
        const at = startsAt + index * SECTION_START_BYTES;
        const declaredIndex = reader.i32(at);
        const nameOffset = reader.u32(at + 4);
        const sectionOffset = reader.u32(at + 12);
        const sectionAt = dataOffset + sectionOffset;
        if (!inside(sectionAt, 4, dataEnd))
          throw truncatedInput(FORMAT, "truncated RSRC section data header", {
            offset: sectionAt,
            field: identifier,
          });
        const storedBytes = reader.u32(sectionAt);
        if (!inside(sectionAt + 4, storedBytes, dataEnd))
          throw truncatedInput(
            FORMAT,
            "RSRC section data exceeds the container's data section",
            { offset: sectionAt, field: identifier },
          );
        const stored = reader.range(sectionAt + 4, storedBytes, "section data");
        const decoded = decodeSection(
          identifier,
          stored,
          budget,
          `${identifier}:${String(sectionOffset)}`,
          decodedSections,
        );
        if (identifier === "vers")
          versionSections.push(decoded.decoded ?? stored);
        sections.push({
          index: declaredIndex >= 0 ? declaredIndex : index,
          name: sectionName(reader, nameBase, nameOffset, listEnd),
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
        // Whether a heap exists is decided by the caller, which also knows
        // what it did not examine.
        blockDiagram: hasPrefix("BDH") ? "present" : "absent",
        frontPanel: hasPrefix("FPH") ? "present" : "absent",
        blocks,
      },
    };
  } catch (cause) {
    if (cause instanceof ParseFailureError)
      return { ok: false, failure: cause };
    throw cause;
  }
};
