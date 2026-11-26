import type {
  Bink2Metadata,
  MediaAssetRegionMetadata,
  OggOpusMetadata,
  RiffXma2Metadata,
  VulkanPipelineCacheMetadata,
} from "../../domain/formatMetadata/mediaAssetMetadata.js";
import { BinaryReader } from "../../domain/binaryContainer.js";
import { decodeStrictUtf8 } from "../../domain/strictUtf8.js";
import {
  malformedInput,
  truncatedInput,
  type ParseFailureError,
} from "../../domain/parseFailure.js";
import {
  OPUS_HEAD,
  VK_PIPELINE_CACHE_HEADER_SIZE,
  VK_PIPELINE_CACHE_HEADER_VERSION_ONE,
  WAVE_FORMAT_XMA2,
} from "../../domain/mediaAssetFormats.js";

/** One declared byte region a media asset header names. */
export interface MediaAssetRegion {
  readonly path: string;
  readonly role: MediaAssetRegionMetadata["role"];
  readonly index: number;
  readonly offset: number;
  readonly length: number;
}

export interface MediaAssetLayout<Metadata> {
  readonly metadata: Metadata;
  readonly regions: readonly MediaAssetRegion[];
  readonly limitations: readonly string[];
  readonly regionsExamined: "complete" | "unknown";
}

/** Bounded positional reads of the carrier. Short reads return fewer bytes. */
export type MediaAssetRead = (
  offset: number,
  length: number,
) => Promise<Buffer>;

type Extent = "consistent" | "truncated" | "trailing-bytes";

/**
 * Pages walked for Ogg Opus identification and comment inventory. OpusHead and
 * OpusTags normally fit in a few pages; the allowance stops a page-flood from
 * unbounded comment continuations. Fixed: RFC 3533 does not bound page count.
 */
const MAX_OGG_PAGES = 64;
/**
 * RIFF chunks walked before the remainder is left unexamined. WAVE files carry
 * a small chunk table; the allowance stops zero-length chunk floods. Fixed:
 * the RIFF form does not bound chunk count.
 */
const MAX_RIFF_CHUNKS = 256;
/**
 * OpusTags vendor string bytes retained for the vendor fact. Longer vendors
 * stay in the comment page regions; only the root fact is capped. Fixed:
 * metadata field representation bound, not a decode of comment payloads.
 */
const MAX_VENDOR_BYTES = 4096;
/** Fmt fields read for WAVEFORMATEX plus XMA2WAVEFORMATEX extras. */
const XMA2_FMT_READ_BYTES = 52;

/**
 * Keep regions that fit the file and name each one that does not. A region
 * past the end is dropped, never clipped, so a listed region always holds
 * exactly its declared bytes.
 */
const fitRegions = (
  format: string,
  regions: readonly MediaAssetRegion[],
  fileSize: number,
  declaredEnd: number,
): {
  readonly regions: MediaAssetRegion[];
  readonly limitations: string[];
  readonly extent: Extent;
} => {
  const kept: MediaAssetRegion[] = [];
  const limitations: string[] = [];
  for (const region of regions)
    if (region.offset + region.length <= fileSize) kept.push(region);
    else
      limitations.push(
        `${format} ${region.role} ${String(region.index)} declares bytes ${String(region.offset)}..${String(region.offset + region.length)} but the file ends at ${String(fileSize)}; the file is truncated and the region was not listed.`,
      );
  if (limitations.length === 0 && declaredEnd > fileSize)
    limitations.push(
      `${format} declares ${String(declaredEnd)} bytes but the file holds ${String(fileSize)}; the file is truncated.`,
    );
  const extent: Extent =
    limitations.length > 0
      ? "truncated"
      : declaredEnd < fileSize
        ? "trailing-bytes"
        : "consistent";
  if (extent === "trailing-bytes")
    limitations.push(
      `${String(fileSize - declaredEnd)} byte(s) follow the last declared ${format} region at offset ${String(declaredEnd)}; they were not interpreted.`,
    );
  return { regions: kept, limitations, extent };
};

const malformed = (
  format: string,
  detail: string,
  offset: number,
): ParseFailureError<"malformed"> => malformedInput(format, detail, { offset });

const OPUS_TAGS = Buffer.from("OpusTags", "latin1");

/** True when the page's last lacing value is 255, so its packet continues. */
const pagePacketContinues = (bytes: Buffer, at: number): boolean => {
  const segments = bytes[at + 26]!;
  if (segments === 0) return false;
  return bytes[at + 27 + segments - 1] === 255;
};

/** One Ogg page's capture header and segment payload extent. */
const readOggPage = (
  bytes: Buffer,
  at: number,
  fileSize: number,
):
  | {
      readonly sequence: number;
      readonly serial: number;
      readonly granule: bigint;
      readonly headerType: number;
      readonly offset: number;
      readonly length: number;
      readonly packet: Buffer;
      readonly continues: boolean;
    }
  | "truncated"
  | "malformed" => {
  if (at + 27 > bytes.length || at + 27 > fileSize) return "truncated";
  if (bytes.toString("latin1", at, at + 4) !== "OggS") return "malformed";
  if (bytes[at + 4] !== 0) return "malformed";
  const headerType = bytes[at + 5]!;
  const fields = new BinaryReader(bytes, true, "ogg-opus");
  const granule = fields.word(at + 6, 64);
  const serial = fields.u32(at + 14);
  const sequence = fields.u32(at + 18);
  const segments = bytes[at + 26]!;
  if (at + 27 + segments > bytes.length) return "truncated";
  let packetBytes = 0;
  for (let index = 0; index < segments; index++)
    packetBytes += bytes[at + 27 + index]!;
  const headerLength = 27 + segments;
  const length = headerLength + packetBytes;
  if (at + length > fileSize) return "truncated";
  if (at + length > bytes.length) return "truncated";
  return {
    sequence,
    serial,
    granule,
    headerType,
    offset: at,
    length,
    packet: bytes.subarray(at + headerLength, at + length),
    continues: pagePacketContinues(bytes, at),
  };
};

/** Ogg Opus: OpusHead / OpusTags pages and remaining examined pages. */
export const oggOpusLayout = async (
  header: Buffer,
  fileSize: number,
  read: MediaAssetRead,
): Promise<MediaAssetLayout<OggOpusMetadata>> => {
  let buffer = header;
  const ensure = async (end: number): Promise<Buffer> => {
    if (buffer.length >= end || buffer.length >= fileSize) return buffer;
    const more = await read(
      buffer.length,
      Math.min(end, fileSize) - buffer.length,
    );
    buffer = Buffer.concat([buffer, more]);
    return buffer;
  };

  const pages: {
    sequence: number;
    serial: number;
    offset: number;
    length: number;
    packet: Buffer;
    continues: boolean;
  }[] = [];
  let at = 0;
  let truncated = false;
  let tagsPacketOpen = false;
  let tagsComplete = false;
  while (at < fileSize && pages.length < MAX_OGG_PAGES) {
    await ensure(Math.min(at + 27 + 255 + 65_536, fileSize));
    const page = readOggPage(buffer, at, fileSize);
    if (page === "malformed")
      throw malformed(
        "ogg-opus",
        pages.length === 0
          ? "Ogg capture pattern is missing or version is not 0"
          : "Ogg page capture pattern is missing or version is not 0",
        at,
      );
    if (page === "truncated") {
      truncated = true;
      break;
    }

    if (pages.length === 0) {
      pages.push(page);
      at = page.offset + page.length;
      continue;
    }

    if (!tagsPacketOpen) {
      if (
        page.packet.length >= OPUS_TAGS.length &&
        page.packet.subarray(0, 8).equals(OPUS_TAGS)
      ) {
        tagsPacketOpen = true;
        pages.push(page);
        at = page.offset + page.length;
        if (!page.continues) {
          tagsComplete = true;
          break;
        }
        continue;
      }
      // No comment header; this page begins the opaque audio stream.
      break;
    }

    pages.push(page);
    at = page.offset + page.length;
    if (!page.continues) {
      tagsComplete = true;
      break;
    }
  }

  if (pages.length === 0) {
    if (truncated)
      throw truncatedInput("ogg-opus", "the first Ogg page is cut off", {
        offset: 0,
        extent: { availableBytes: fileSize, requiredBytes: fileSize + 1 },
      });
    throw malformed("ogg-opus", "no Ogg pages were read", 0);
  }

  if (tagsPacketOpen && !tagsComplete && !truncated && at >= fileSize)
    // A finished page still declared packet continuation past EOF.
    truncated = true;

  const headPacket = pages[0]!.packet;
  if (headPacket.length < 19 || !headPacket.subarray(0, 8).equals(OPUS_HEAD))
    throw malformed(
      "ogg-opus",
      "the first Ogg packet is not OpusHead",
      pages[0]!.offset,
    );
  if (headPacket[8] !== 1)
    throw malformed(
      "ogg-opus",
      "OpusHead version is not 1",
      pages[0]!.offset + 8,
    );

  const head = new BinaryReader(headPacket, true, "ogg-opus");
  const channelCount = head.u8(9);
  const preSkip = head.u16(10);
  const inputSampleRate = head.u32(12);
  const outputGain = head.i16(16);
  const mappingFamily = head.u8(18);

  let vendor: string | null = null;
  const limitations: string[] = [];
  const tagsPages = tagsPacketOpen ? pages.slice(1) : [];
  if (tagsPages.length > 0) {
    const tagsPacket = Buffer.concat(tagsPages.map((page) => page.packet));
    if (
      tagsPacket.length >= 12 &&
      tagsPacket.subarray(0, 8).equals(OPUS_TAGS)
    ) {
      const vendorLength = new BinaryReader(tagsPacket, true, "ogg-opus").u32(
        8,
      );
      if (
        Number.isSafeInteger(vendorLength) &&
        tagsPacket.length >= 12 + vendorLength
      ) {
        if (vendorLength > MAX_VENDOR_BYTES)
          limitations.push(
            `The OpusTags vendor string declares ${String(vendorLength)} bytes; only the first ${String(MAX_VENDOR_BYTES)} would be retained as a root fact, so the vendor fact was omitted. Raise is unavailable: this is a fixed metadata-field bound.`,
          );
        else
          try {
            vendor = decodeStrictUtf8(
              tagsPacket.subarray(12, 12 + vendorLength),
              "preserve",
            );
          } catch {
            vendor = null;
          }
      }
    }
  }

  const pageEnd = pages.reduce(
    (end, page) => Math.max(end, page.offset + page.length),
    0,
  );
  const regions: MediaAssetRegion[] = pages.map((page, index) => ({
    path: `pages/${String(index)}.bin`,
    role: "ogg-page" as const,
    index,
    offset: page.offset,
    length: page.length,
  }));
  let regionsExamined: "complete" | "unknown" = "complete";
  let declaredEnd = pageEnd;
  const hitPageCeiling = pages.length >= MAX_OGG_PAGES && pageEnd < fileSize;
  if (truncated) {
    limitations.push(
      `An Ogg page at offset ${String(at)} is cut off; later pages were not listed.`,
    );
    regionsExamined = "unknown";
  } else if (tagsPacketOpen && !tagsComplete) {
    regionsExamined = "unknown";
    limitations.push(
      hitPageCeiling
        ? `Only the first ${String(MAX_OGG_PAGES)} Ogg pages were examined while OpusTags still continued; ${String(fileSize - pageEnd)} byte(s) remain. Raise is unavailable: this is a fixed inventory walk ceiling.`
        : `OpusTags still continues at offset ${String(pageEnd)}; later bytes were not classified as audio.`,
    );
  } else if (hitPageCeiling) {
    regionsExamined = "unknown";
    limitations.push(
      `Only the first ${String(MAX_OGG_PAGES)} Ogg pages were examined; ${String(fileSize - pageEnd)} byte(s) remain. Raise is unavailable: this is a fixed inventory walk ceiling.`,
    );
  } else if (pageEnd < fileSize) {
    // Bytes after the identification/comment pages are the opaque audio stream.
    regions.push({
      path: "audio.bin",
      role: "ogg-page",
      index: pages.length,
      offset: pageEnd,
      length: fileSize - pageEnd,
    });
    declaredEnd = fileSize;
  }
  const fitted = fitRegions("ogg-opus", regions, fileSize, declaredEnd);
  const extent =
    truncated || fitted.extent === "truncated"
      ? "truncated"
      : fitted.extent === "trailing-bytes" ||
          hitPageCeiling ||
          (tagsPacketOpen && !tagsComplete)
        ? "trailing-bytes"
        : "consistent";
  return {
    metadata: {
      kind: "ogg-opus",
      serials: pages.map((page) => page.serial),
      page_sequences: pages.map((page) => page.sequence),
      channel_count: channelCount,
      pre_skip: preSkip,
      input_sample_rate: inputSampleRate,
      output_gain: outputGain,
      mapping_family: mappingFamily,
      vendor,
      pages_read: pages.length,
      extent_check: extent,
    },
    regions: fitted.regions,
    limitations: [...limitations, ...fitted.limitations],
    regionsExamined,
  };
};

/** RIFF WAVE XMA2: chunk table and declared fmt / XMA2 fields. */
export const riffXma2Layout = async (
  header: Buffer,
  fileSize: number,
  read: MediaAssetRead,
): Promise<MediaAssetLayout<RiffXma2Metadata>> => {
  let buffer = header;
  /** Extend only through `end`; never fill opaque chunk payloads. */
  const ensure = async (end: number): Promise<Buffer> => {
    if (buffer.length >= end || buffer.length >= fileSize) return buffer;
    const more = await read(
      buffer.length,
      Math.min(end, fileSize) - buffer.length,
    );
    buffer = Buffer.concat([buffer, more]);
    return buffer;
  };
  /** Read a bounded range by position without requiring prior bytes in buffer. */
  const readRange = async (
    offset: number,
    length: number,
  ): Promise<Buffer | "truncated"> => {
    if (length <= 0) return Buffer.alloc(0);
    if (offset + length > fileSize) return "truncated";
    if (offset + length <= buffer.length)
      return buffer.subarray(offset, offset + length);
    if (offset < buffer.length) {
      await ensure(offset + length);
      if (buffer.length < offset + length) return "truncated";
      return buffer.subarray(offset, offset + length);
    }
    const bytes = await read(offset, length);
    return bytes.length < length ? "truncated" : bytes;
  };

  await ensure(12);
  if (buffer.length < 12)
    throw truncatedInput("riff-xma2", "RIFF header is cut off", {
      offset: 0,
      extent: {
        availableBytes: buffer.length,
        requiredBytes: 12,
      },
    });
  const root = new BinaryReader(buffer, true, "riff-xma2");
  if (buffer.toString("latin1", 0, 4) !== "RIFF")
    throw malformed("riff-xma2", "RIFF magic is missing", 0);
  const riffDeclaredSize = root.u32(4);
  if (buffer.toString("latin1", 8, 12) !== "WAVE")
    throw malformed("riff-xma2", "WAVE form type is missing", 8);

  const declaredEnd = 8 + riffDeclaredSize;
  const containerEnd = Math.min(fileSize, declaredEnd);
  const chunks: { id: string; offset: number; length: number }[] = [];
  const completeChunks: { id: string; offset: number; length: number }[] = [];
  let at = 12;
  let stopped = false;
  let incompleteFraming = false;
  const limitations: string[] = [];
  while (at + 8 <= containerEnd && chunks.length < MAX_RIFF_CHUNKS) {
    const headerBytes = await readRange(at, 8);
    if (headerBytes === "truncated") {
      stopped = true;
      incompleteFraming = true;
      break;
    }
    const id = headerBytes.toString("latin1", 0, 4);
    const size = new BinaryReader(headerBytes, true, "riff-xma2").u32(4);
    const dataAt = at + 8;
    const payloadEnd = dataAt + size;
    const alignedEnd = payloadEnd + (size & 1);
    const chunk = { id, offset: dataAt, length: size };
    chunks.push(chunk);
    if (payloadEnd > containerEnd || alignedEnd > containerEnd) {
      stopped = true;
      incompleteFraming = true;
      limitations.push(
        `RIFF chunk ${id.trimEnd() || "chunk"} at offset ${String(at)} declares ${String(size)} byte(s) extending past the RIFF form end at ${String(containerEnd)}; its declared range is kept in metadata but omitted from extractable regions.`,
      );
      break;
    }
    completeChunks.push(chunk);
    at = alignedEnd;
  }
  if (at < containerEnd && at + 8 > containerEnd) {
    stopped = true;
    incompleteFraming = true;
    limitations.push(
      `A partial RIFF chunk header remains at offset ${String(at)} before the RIFF form end at ${String(declaredEnd)}; framing is incomplete.`,
    );
  }

  const fmt = chunks.find((chunk) => chunk.id === "fmt ");
  if (fmt === undefined)
    throw malformed("riff-xma2", "WAVE fmt chunk is missing", 12);
  const fmtRead = Math.min(fmt.length, XMA2_FMT_READ_BYTES);
  if (fmt.offset + fmtRead > fileSize)
    throw truncatedInput("riff-xma2", "WAVE fmt chunk is cut off", {
      offset: fmt.offset,
      extent: {
        availableBytes: Math.max(0, fileSize - fmt.offset),
        requiredBytes: fmtRead,
      },
    });
  if (fmt.offset + fmtRead > declaredEnd)
    throw malformed(
      "riff-xma2",
      "WAVE fmt chunk extends past the declared RIFF form end",
      fmt.offset,
    );
  const fmtBytes = await readRange(fmt.offset, fmtRead);
  if (fmtBytes === "truncated")
    throw truncatedInput("riff-xma2", "WAVE fmt chunk is cut off", {
      offset: fmt.offset,
      extent: {
        availableBytes: Math.max(0, fileSize - fmt.offset),
        requiredBytes: fmtRead,
      },
    });
  if (fmtBytes.length < 16)
    throw malformed(
      "riff-xma2",
      "WAVE fmt chunk is shorter than 16 bytes",
      fmt.offset,
    );
  const fmtFields = new BinaryReader(fmtBytes, true, "riff-xma2");
  const formatTag = fmtFields.u16(0);
  if (formatTag !== WAVE_FORMAT_XMA2)
    throw malformed(
      "riff-xma2",
      `WAVE fmt tag is 0x${formatTag.toString(16)}, not 0x166`,
      fmt.offset,
    );
  const channels = fmtFields.u16(2);
  const samplesPerSec = fmtFields.u32(4);
  const avgBytesPerSec = fmtFields.u32(8);
  const blockAlign = fmtFields.u16(12);
  const bitsPerSample = fmtFields.u16(14);
  const extraBytes = fmtRead >= 18 ? fmtFields.u16(16) : 0;
  const xma2 =
    fmtRead >= 52 && extraBytes >= 34
      ? {
          num_streams: fmtFields.u16(18),
          channel_mask: fmtFields.u32(20),
          samples_encoded: fmtFields.u32(24),
          bytes_per_block: fmtFields.u32(28),
          play_begin: fmtFields.u32(32),
          play_length: fmtFields.u32(36),
          loop_begin: fmtFields.u32(40),
          loop_length: fmtFields.u32(44),
          loop_count: fmtFields.u8(48),
          encoder_version: fmtFields.u8(49),
          block_count: fmtFields.u16(50),
        }
      : null;

  const regions: MediaAssetRegion[] = completeChunks.map((chunk, index) => ({
    path: `chunks/${String(index)}.${chunk.id.trimEnd() || "chunk"}`,
    role: "riff-chunk" as const,
    index,
    offset: chunk.offset,
    length: chunk.length,
  }));
  const fitted = fitRegions("riff-xma2", regions, fileSize, declaredEnd);
  const allLimitations = [...limitations, ...fitted.limitations];
  const extent: Extent = incompleteFraming ? "truncated" : fitted.extent;
  let regionsExamined: "complete" | "unknown" = "complete";
  if (stopped || chunks.length >= MAX_RIFF_CHUNKS || incompleteFraming) {
    regionsExamined = "unknown";
    if (chunks.length >= MAX_RIFF_CHUNKS)
      allLimitations.push(
        `Only the first ${String(MAX_RIFF_CHUNKS)} RIFF chunks were examined. Raise is unavailable: this is a fixed inventory walk ceiling.`,
      );
  }

  return {
    metadata: {
      kind: "riff-xma2",
      riff_declared_size: riffDeclaredSize,
      chunks: chunks.map((chunk) => ({
        id: chunk.id,
        offset: chunk.offset,
        length: chunk.length,
      })),
      format_tag: formatTag,
      channels,
      samples_per_sec: samplesPerSec,
      avg_bytes_per_sec: avgBytesPerSec,
      block_align: blockAlign,
      bits_per_sample: bitsPerSample,
      fmt_extra_bytes: extraBytes,
      xma2,
      extent_check: extent,
    },
    regions: fitted.regions,
    limitations: allLimitations,
    regionsExamined,
  };
};

/** Bink 2: revision, leading frame fields and the frame-offset table. */
export const bink2Layout = (
  header: Buffer,
  fileSize: number,
): MediaAssetLayout<Bink2Metadata> => {
  if (header.length < 44)
    throw truncatedInput("bink2", "Bink 2 header is cut off", {
      offset: 0,
      extent: {
        availableBytes: header.length,
        requiredBytes: 44,
      },
    });
  if (header.toString("latin1", 0, 3) !== "KB2")
    throw malformed("bink2", "Bink 2 magic is missing", 0);
  const fields = new BinaryReader(header, true, "bink2");
  const revision = fields.u8(3);
  const revisionChar =
    revision >= 0x20 && revision <= 0x7e ? String.fromCharCode(revision) : null;
  const declaredSizeField = fields.u32(4);
  const frameCount = fields.u32(12);
  const width = fields.u32(24);
  const height = fields.u32(28);
  const fpsNumerator = fields.u32(32);
  const fpsDenominator = fields.u32(36);
  // Frame-offset table length must stay a safe byte count; that is a
  // representation bound, not an inventory policy. Valid counts are listed.
  if (!Number.isSafeInteger(frameCount) || frameCount < 0)
    throw malformed("bink2", "Bink 2 frame count is not a safe table size", 12);
  const tableOffset = 44;
  const tableBytes = (frameCount + 1) * 4;
  if (!Number.isSafeInteger(tableBytes) || tableBytes < 0)
    throw malformed("bink2", "Bink 2 frame-offset table size is not safe", 12);
  const framesOffset = tableOffset + tableBytes;
  const regions: MediaAssetRegion[] = [
    {
      path: "frame-offsets.bin",
      role: "frame-offset-table",
      index: 0,
      offset: tableOffset,
      length: tableBytes,
    },
  ];
  if (framesOffset < fileSize)
    regions.push({
      path: "frames.bin",
      role: "frames",
      index: 0,
      offset: framesOffset,
      length: fileSize - framesOffset,
    });
  // The size field stores fileSize - 8 in the usual layout.
  const declaredEnd = declaredSizeField + 8;
  const fitted = fitRegions("bink2", regions, fileSize, declaredEnd);
  return {
    metadata: {
      kind: "bink2",
      revision,
      revision_char: revisionChar,
      frame_count: frameCount,
      width,
      height,
      fps_numerator: fpsNumerator,
      fps_denominator: fpsDenominator,
      frame_offset_table_offset: tableOffset,
      frame_offset_table_bytes: tableBytes,
      declared_size_field: declaredSizeField,
      extent_check: fitted.extent,
    },
    regions: fitted.regions,
    limitations: fitted.limitations,
    regionsExamined: "complete",
  };
};

/** Vulkan pipeline cache VersionOne header; body is opaque. */
export const vulkanPipelineCacheLayout = (
  header: Buffer,
  fileSize: number,
): MediaAssetLayout<VulkanPipelineCacheMetadata> => {
  if (header.length < VK_PIPELINE_CACHE_HEADER_SIZE)
    throw truncatedInput(
      "vulkan-pipeline-cache",
      "Vulkan pipeline cache header is cut off",
      {
        offset: 0,
        extent: {
          availableBytes: header.length,
          requiredBytes: VK_PIPELINE_CACHE_HEADER_SIZE,
        },
      },
    );
  const fields = new BinaryReader(header, true, "vulkan-pipeline-cache");
  const headerSize = fields.u32(0);
  const headerVersion = fields.u32(4);
  if (headerSize !== VK_PIPELINE_CACHE_HEADER_SIZE)
    throw malformed(
      "vulkan-pipeline-cache",
      `headerSize is ${String(headerSize)}, not 32`,
      0,
    );
  if (headerVersion !== VK_PIPELINE_CACHE_HEADER_VERSION_ONE)
    throw malformed(
      "vulkan-pipeline-cache",
      `headerVersion is ${String(headerVersion)}, not VK_PIPELINE_CACHE_HEADER_VERSION_ONE`,
      4,
    );
  const vendorId = fields.u32(8);
  const deviceId = fields.u32(12);
  const uuid = header.subarray(16, 32).toString("hex");
  const opaqueOffset = headerSize;
  const opaqueBytes = Math.max(0, fileSize - opaqueOffset);
  const regions: MediaAssetRegion[] = [
    {
      path: "header.bin",
      role: "header",
      index: 0,
      offset: 0,
      length: headerSize,
    },
  ];
  if (opaqueBytes > 0)
    regions.push({
      path: "opaque.bin",
      role: "opaque-body",
      index: 0,
      offset: opaqueOffset,
      length: opaqueBytes,
    });
  const fitted = fitRegions(
    "vulkan-pipeline-cache",
    regions,
    fileSize,
    fileSize,
  );
  return {
    metadata: {
      kind: "vulkan-pipeline-cache",
      header_size: headerSize,
      header_version: headerVersion,
      vendor_id: vendorId,
      device_id: deviceId,
      pipeline_cache_uuid: uuid,
      opaque_offset: opaqueOffset,
      opaque_bytes: opaqueBytes,
      extent_check: fitted.extent,
    },
    regions: fitted.regions,
    limitations: fitted.limitations,
    regionsExamined: "complete",
  };
};
