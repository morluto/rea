import { inflateSync } from "node:zlib";
import { BinaryReader } from "../domain/binaryContainer.js";
import { LABVIEW_RSRC_MAGIC } from "../domain/labview/labviewArtifact.js";
import {
  decodeLimit,
  malformedInput,
  ParseFailureError,
  truncatedInput,
  type LimitRef,
} from "../domain/parseFailure.js";

const FORMAT = "labview-rsrc";
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

/** Whether a `vers` record was read, absent, or present but undecodable. */
export type LabviewVersionCoverage = "observed" | "absent" | "unknown";

export interface LabviewRsrc {
  readonly formatVersion: number;
  readonly fileType: string;
  readonly creator: string;
  readonly dataOffset: number;
  readonly dataBytes: number;
  readonly infoOffset: number;
  readonly infoBytes: number;
  readonly labviewVersion: string | null;
  readonly versionCoverage: LabviewVersionCoverage;
  /** Whether the container carries an embedded program tree (`LVzp`). */
  readonly programTree: boolean;
  readonly blockDiagram: LabviewPresence;
  readonly frontPanel: LabviewPresence;
  readonly blocks: readonly LabviewBlock[];
  /** Recognized zlib sections left undecoded, counted by reason. */
  readonly decodeOmissions: Readonly<
    Partial<Record<LabviewDecodeOmission, number>>
  >;
}

/** The fixed per-container decode allowances, named for recovery text. */
export const LABVIEW_DECODE_ALLOWANCES = {
  compressed_allowance: MAX_COMPRESSED_BYTES,
  decoded_allowance: MAX_DECODED_BYTES,
} as const;

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

/** RFC 1950 section 2.2: CM 8 is deflate, CINFO 7 is a 32 KiB window. */
const ZLIB_DEFLATE_METHOD = 8;
const ZLIB_MAX_WINDOW_INFO = 7;
/** RFC 1950 FLG bit 5: a preset dictionary identifier follows the header. */
const ZLIB_FDICT = 0x20;

/**
 * zlib's two-byte header, checked by its format rule rather than by a list of
 * pairs: the low nibble of CMF is the deflate method and CMF/FLG as a
 * big-endian word is a multiple of 31. This admits every level Node produces,
 * including the `78 5e` pair of level 3. A header that also sets FDICT is
 * still zlib; only its dictionary is unavailable to this reader.
 */
const zlibHeader = (
  cmf: number,
  flg: number,
): { readonly presetDictionary: boolean } | undefined =>
  (cmf & 0x0f) === ZLIB_DEFLATE_METHOD &&
  cmf >> 4 <= ZLIB_MAX_WINDOW_INFO &&
  ((cmf << 8) | flg) % 31 === 0
    ? { presetDictionary: (flg & ZLIB_FDICT) !== 0 }
    : undefined;

/** Why a recognized zlib section was not decoded. */
export type LabviewDecodeOmission =
  | "preset_dictionary"
  | "compressed_allowance"
  | "decoded_allowance"
  | "inflate_failed";

interface DecodeBudget {
  decodedRemaining: number;
  inputRemaining: number;
}

interface SectionDecoding {
  readonly coding: LabviewCoding;
  /** Set when a recognized zlib section was not decoded, with the reason. */
  readonly omission?: LabviewDecodeOmission;
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
  const unknown = (omission: LabviewDecodeOmission): SectionDecoding => ({
    coding: "unknown",
    omission,
    decodedBytes: null,
    decoded: undefined,
  });
  const result = (): SectionDecoding => {
    // LVzp (the embedded program tree) is XOR-coded, not compressed, and this
    // reader inventories it without materializing its payload.
    if (blockIdentifier === "LVzp")
      return { coding: "xor", decodedBytes: null, decoded: undefined };
    if (stored.length < 6)
      return { coding: "none", decodedBytes: null, decoded: undefined };
    const head = new BinaryReader(stored, false, FORMAT);
    const declared = head.u32(0);
    const zlib = zlibHeader(head.u8(4), head.u8(5));
    if (zlib === undefined)
      return { coding: "none", decodedBytes: null, decoded: undefined };
    // Recognized zlib whose dictionary is not in the container: the stored
    // bytes are compressed, so they are neither raw content nor decodable.
    if (zlib.presetDictionary) return unknown("preset_dictionary");
    // Charge both the compressed input and the declared output: a stream with
    // a tiny declared length can still make the inflater traverse megabytes,
    // and several section records may point at the same stored bytes.
    if (stored.length > budget.inputRemaining)
      return unknown("compressed_allowance");
    if (declared > budget.decodedRemaining) return unknown("decoded_allowance");
    budget.inputRemaining -= stored.length;
    budget.decodedRemaining -= declared;
    try {
      const decoded = inflateSync(stored.subarray(4), {
        // Bound the allocation by the declared length, not by the input size.
        maxOutputLength: Math.max(1, declared),
      });
      if (decoded.length !== declared) return unknown("inflate_failed");
      return {
        coding: "zlib",
        decodedBytes: decoded.length,
        decoded: blockIdentifier === "vers" ? decoded : undefined,
      };
    } catch {
      return unknown("inflate_failed");
    }
  };
  const value = result();
  cache.set(cacheKey, value);
  return value;
};

/** Read one Pascal name from a block's name list, bounded by the info section. */
const sectionName = (
  reader: BinaryReader,
  nameBase: number,
  nameOffset: number,
  infoEnd: number,
): string | null => {
  // Only the sentinel means "this section has no name". A name that leaves
  // the info section is malformed input, not an observed omission.
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

/**
 * The LabVIEW version packed big-endian into the first four bytes of a `vers`
 * record: bits 31-24 hold two decimal major digits, bits 23-20 the minor
 * digit and bits 19-16 the bugfix digit (pylabview `LVmisc.decodeVersion`,
 * matching the classic Mac `NumVersion` layout `vers` mirrors). Only
 * `major.minor` is reported, so only those nibbles are validated.
 *
 * The stage (bits 15-13) and build (bits 12-0) fields are not read: pylabview
 * decodes the build as decimal digit nibbles, while `NumVersion` keeps its
 * non-release revision as a plain binary count. The references disagree, so
 * a build nibble above 9 neither validates nor invalidates the record.
 */
const decodeVersion = (content: Uint8Array): string | null => {
  if (content.length < 4) return null;
  const majorHigh = (content[0] ?? 0) >>> 4;
  const majorLow = (content[0] ?? 0) & 0x0f;
  const minor = (content[1] ?? 0) >>> 4;
  // A decimal digit above 9 is a damaged record, so its version is unknown.
  if ([majorHigh, majorLow, minor].some((digit) => digit > 9)) return null;
  return `${String(majorHigh * 10 + majorLow)}.${String(minor)}`;
};

/** The LabVIEW version recorded by the first decodable `vers` record. */
const versionOf = (sections: readonly Uint8Array[]): string | null => {
  for (const section of sections) {
    const version = decodeVersion(section);
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
 *
 * `origin` is where the container starts in the selected file (0 for a direct
 * RSRC file). A successful result keeps container-relative ranges, which the
 * caller maps with `container.file_offset`; a failure has no such result, so
 * its offset is reported in the selected file's coordinates.
 */
export const parseLabviewRsrc = (
  bytes: Buffer,
  origin = 0,
): LabviewParseResult => {
  const reader = new BinaryReader(bytes, false, FORMAT);
  try {
    if (
      bytes.length < HEADER_BYTES ||
      reader
        .range(0, LABVIEW_RSRC_MAGIC.length, "RSRC magic")
        .toString("latin1") !== LABVIEW_RSRC_MAGIC
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
    // Section data follows the fixed 32-byte header; a data range that
    // starts inside it would read header words as section lengths.
    if (dataOffset < HEADER_BYTES)
      throw malformedInput(
        FORMAT,
        "RSRC data section overlaps the fixed header",
        { offset: 24, field: "data offset" },
      );
    // The data and info sections are separate regions (pylabview writes the
    // info section, which begins with its own header copy, after the data);
    // an intersection would read list metadata as section data.
    if (
      dataBytes > 0 &&
      dataOffset < infoOffset + infoBytes &&
      infoOffset < dataOffset + dataBytes
    )
      throw malformedInput(FORMAT, "RSRC data and info sections overlap", {
        offset: 24,
        field: "data offset",
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
    // The word at infoOffset + 48 is an offset from the info header. It ends
    // where the name list begins; the block headers and section-start tables
    // are the records inside that extent.
    const blockInfoBytes = reader.u32(infoOffset + 48);
    // Real containers can declare a list extent that runs past the resource
    // payload's own end, so the declared extent and the container both bound
    // the records: neither may be exceeded.
    if (blockInfoBytes < 4)
      throw truncatedInput(FORMAT, "RSRC block-info list declares no records", {
        offset: infoOffset + 48,
      });
    const listEnd = Math.min(infoOffset + blockInfoBytes, infoEnd);
    const blockCount = reader.u32(blockInfo) + 1;
    const blockHeadersAt = blockInfo + 4;
    const headersEnd = blockHeadersAt + blockCount * BLOCK_HEADER_BYTES;
    // A table that cannot fit is damaged input, not a capacity question:
    // frame it before applying the count allowance.
    if (!inside(blockHeadersAt, blockCount * BLOCK_HEADER_BYTES, listEnd))
      throw truncatedInput(FORMAT, "truncated RSRC block headers", {
        offset: blockHeadersAt,
      });
    if (blockCount > MAX_BLOCKS)
      throw decodeLimit(
        FORMAT,
        "RSRC block count exceeds the supported bound",
        limit("labview_rsrc_blocks", MAX_BLOCKS, blockCount),
        { offset: blockInfo },
      );

    const blocks: LabviewBlock[] = [];
    const versionSections: Uint8Array[] = [];
    let sawVersionSection = false;
    const budget: DecodeBudget = {
      decodedRemaining: MAX_DECODED_BYTES,
      inputRemaining: MAX_COMPRESSED_BYTES,
    };
    const decodedSections = new Map<string, SectionDecoding>();
    const decodeOmissions: Partial<Record<LabviewDecodeOmission, number>> = {};
    // First pass: validate every block's start table and locate the one name
    // list that all section-name offsets address, after every start table.
    let totalSections = 0;
    let namesBase = blockInfo;
    for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
      const headerAt = blockHeadersAt + blockIndex * BLOCK_HEADER_BYTES;
      const identifier = reader
        .range(headerAt, 4, "block identifier")
        .toString("latin1");
      const sectionCount = reader.u32(headerAt + 4) + 1;
      const startsAt = blockInfo + reader.u32(headerAt + 8);
      // Section-start tables follow the count word and every block header;
      // blocks may share one later table, but none may reuse header rows.
      if (startsAt < headersEnd)
        throw malformedInput(
          FORMAT,
          "RSRC section-start table overlaps the block headers",
          { offset: headerAt + 8, field: identifier },
        );
      if (!inside(startsAt, sectionCount * SECTION_START_BYTES, listEnd))
        throw truncatedInput(FORMAT, "truncated RSRC section starts", {
          offset: startsAt,
          field: identifier,
        });
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
      namesBase = Math.max(
        namesBase,
        startsAt + sectionCount * SECTION_START_BYTES,
      );
    }
    if (namesBase > listEnd)
      throw truncatedInput(
        FORMAT,
        "RSRC section-name list exceeds the declared list",
        { offset: namesBase },
      );

    for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
      const headerAt = blockHeadersAt + blockIndex * BLOCK_HEADER_BYTES;
      const identifier = reader
        .range(headerAt, 4, "block identifier")
        .toString("latin1");
      const sectionCount = reader.u32(headerAt + 4) + 1;
      const startsAt = blockInfo + reader.u32(headerAt + 8);
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
        if (decoded.omission !== undefined)
          decodeOmissions[decoded.omission] =
            (decodeOmissions[decoded.omission] ?? 0) + 1;
        // Only content this reader actually read can report a version: a
        // failed or skipped decode leaves compressed bytes that can contain
        // digit-like binary values.
        if (identifier === "vers") {
          sawVersionSection = true;
          if (decoded.coding === "none" || decoded.coding === "zlib")
            versionSections.push(decoded.decoded ?? stored);
        }
        sections.push({
          index: declaredIndex,
          // LabVIEW counts the declared extent from the info header, so it
          // ends where the name list begins; the names run to the info end.
          name: sectionName(reader, namesBase, nameOffset, infoEnd),
          storedBytes,
          decodedBytes: decoded.decodedBytes,
          coding: decoded.coding,
        });
      }
      blocks.push({ identifier, sections });
    }

    const labviewVersion = versionOf(versionSections);
    // One pass derives every block fact the caller and report need.
    let blockDiagram: LabviewPresence = "absent";
    let frontPanel: LabviewPresence = "absent";
    let programTree = false;
    for (const { identifier } of blocks) {
      if (identifier.startsWith("BDH")) blockDiagram = "present";
      else if (identifier.startsWith("FPH")) frontPanel = "present";
      if (identifier === "LVzp") programTree = true;
    }
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
        labviewVersion,
        versionCoverage:
          labviewVersion !== null
            ? "observed"
            : sawVersionSection
              ? "unknown"
              : "absent",
        blockDiagram,
        frontPanel,
        programTree,
        blocks,
        decodeOmissions,
      },
    };
  } catch (cause) {
    if (cause instanceof ParseFailureError)
      return { ok: false, failure: inSelectedFile(cause, origin) };
    throw cause;
  }
};

/** Move a container-relative failure offset into the selected file. */
const inSelectedFile = (
  cause: ParseFailureError,
  origin: number,
): ParseFailureError => {
  const { offset } = cause.failure;
  if (origin === 0 || offset === undefined) return cause;
  return new ParseFailureError(
    { ...cause.failure, offset: origin + offset },
    { cause },
  );
};
