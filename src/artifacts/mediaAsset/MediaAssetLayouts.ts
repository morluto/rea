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

/** Pages walked for Ogg Opus identification and comment inventory. */
const MAX_OGG_PAGES = 64;
/** RIFF chunks walked before the remainder is left unexamined. */
const MAX_RIFF_CHUNKS = 256;
/** OpusTags vendor string bytes read for the vendor fact. */
const MAX_VENDOR_BYTES = 4096;

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
  }[] = [];
  let at = 0;
  let truncated = false;
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
    pages.push(page);
    at = page.offset + page.length;
    if (pages.length >= 2) {
      const head = pages[0]!.packet;
      const tags = pages[1]!.packet;
      if (
        head.length >= OPUS_HEAD.length &&
        head.subarray(0, 8).equals(OPUS_HEAD) &&
        tags.length >= OPUS_TAGS.length &&
        tags.subarray(0, 8).equals(OPUS_TAGS)
      )
        break;
    }
  }

  if (pages.length === 0)
    throw malformed("ogg-opus", "no Ogg pages were read", 0);
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
  const tagsPage = pages[1];
  if (
    tagsPage !== undefined &&
    tagsPage.packet.length >= 12 &&
    tagsPage.packet.subarray(0, 8).equals(OPUS_TAGS)
  ) {
    const vendorLength = new BinaryReader(
      tagsPage.packet,
      true,
      "ogg-opus",
    ).u32(8);
    if (
      Number.isSafeInteger(vendorLength) &&
      vendorLength <= MAX_VENDOR_BYTES &&
      tagsPage.packet.length >= 12 + vendorLength
    ) {
      try {
        vendor = decodeStrictUtf8(
          tagsPage.packet.subarray(12, 12 + vendorLength),
          "preserve",
        );
      } catch {
        vendor = null;
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
  const limitations: string[] = [];
  let regionsExamined: "complete" | "unknown" = "complete";
  let declaredEnd = pageEnd;
  if (truncated) {
    limitations.push(
      `An Ogg page at offset ${String(at)} is cut off; later pages were not listed.`,
    );
    regionsExamined = "unknown";
  } else if (pageEnd < fileSize && pages.length >= MAX_OGG_PAGES) {
    regionsExamined = "unknown";
    limitations.push(
      `Only the first ${String(MAX_OGG_PAGES)} Ogg pages were examined; ${String(fileSize - pageEnd)} byte(s) remain.`,
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
          (pageEnd < fileSize && pages.length >= MAX_OGG_PAGES)
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
  const ensure = async (end: number): Promise<Buffer> => {
    if (buffer.length >= end || buffer.length >= fileSize) return buffer;
    const more = await read(
      buffer.length,
      Math.min(end, fileSize) - buffer.length,
    );
    buffer = Buffer.concat([buffer, more]);
    return buffer;
  };

  await ensure(12);
  if (buffer.length < 12)
    throw malformed("riff-xma2", "RIFF header is shorter than 12 bytes", 0);
  const root = new BinaryReader(buffer, true, "riff-xma2");
  if (buffer.toString("latin1", 0, 4) !== "RIFF")
    throw malformed("riff-xma2", "RIFF magic is missing", 0);
  const riffDeclaredSize = root.u32(4);
  if (buffer.toString("latin1", 8, 12) !== "WAVE")
    throw malformed("riff-xma2", "WAVE form type is missing", 8);

  const chunks: { id: string; offset: number; length: number }[] = [];
  let at = 12;
  let stopped = false;
  while (at + 8 <= fileSize && chunks.length < MAX_RIFF_CHUNKS) {
    await ensure(at + 8);
    if (buffer.length < at + 8) {
      stopped = true;
      break;
    }
    const id = buffer.toString("latin1", at, at + 4);
    const size = new BinaryReader(buffer, true, "riff-xma2").u32(at + 4);
    const dataAt = at + 8;
    if (dataAt + size > fileSize) {
      chunks.push({ id, offset: dataAt, length: size });
      stopped = true;
      break;
    }
    await ensure(dataAt + size);
    chunks.push({ id, offset: dataAt, length: size });
    at = dataAt + size + (size & 1);
  }

  const fmt = chunks.find((chunk) => chunk.id === "fmt ");
  if (fmt === undefined)
    throw malformed("riff-xma2", "WAVE fmt chunk is missing", 12);
  await ensure(fmt.offset + Math.min(fmt.length, 52));
  if (buffer.length < fmt.offset + 16)
    throw malformed("riff-xma2", "WAVE fmt chunk is cut off", fmt.offset);
  const fmtFields = new BinaryReader(buffer, true, "riff-xma2");
  const formatTag = fmtFields.u16(fmt.offset);
  if (formatTag !== WAVE_FORMAT_XMA2)
    throw malformed(
      "riff-xma2",
      `WAVE fmt tag is 0x${formatTag.toString(16)}, not 0x166`,
      fmt.offset,
    );
  const channels = fmtFields.u16(fmt.offset + 2);
  const samplesPerSec = fmtFields.u32(fmt.offset + 4);
  const avgBytesPerSec = fmtFields.u32(fmt.offset + 8);
  const blockAlign = fmtFields.u16(fmt.offset + 12);
  const bitsPerSample = fmtFields.u16(fmt.offset + 14);
  const extraBytes = fmt.length >= 18 ? fmtFields.u16(fmt.offset + 16) : 0;
  const xma2 =
    fmt.length >= 52 && extraBytes >= 34
      ? {
          num_streams: fmtFields.u16(fmt.offset + 18),
          channel_mask: fmtFields.u32(fmt.offset + 20),
          samples_encoded: fmtFields.u32(fmt.offset + 24),
          bytes_per_block: fmtFields.u32(fmt.offset + 28),
          play_begin: fmtFields.u32(fmt.offset + 32),
          play_length: fmtFields.u32(fmt.offset + 36),
          loop_begin: fmtFields.u32(fmt.offset + 40),
          loop_length: fmtFields.u32(fmt.offset + 44),
          loop_count: fmtFields.u8(fmt.offset + 48),
          encoder_version: fmtFields.u8(fmt.offset + 49),
          block_count: fmtFields.u16(fmt.offset + 50),
        }
      : null;

  const regions: MediaAssetRegion[] = chunks.map((chunk, index) => ({
    path: `chunks/${String(index)}.${chunk.id.trimEnd() || "chunk"}`,
    role: "riff-chunk" as const,
    index,
    offset: chunk.offset,
    length: chunk.length,
  }));
  const declaredEnd = 8 + riffDeclaredSize;
  const fitted = fitRegions("riff-xma2", regions, fileSize, declaredEnd);
  const limitations = [...fitted.limitations];
  let extent = fitted.extent;
  let regionsExamined: "complete" | "unknown" = "complete";
  if (stopped || chunks.length >= MAX_RIFF_CHUNKS) {
    regionsExamined = "unknown";
    if (chunks.length >= MAX_RIFF_CHUNKS)
      limitations.push(
        `Only the first ${String(MAX_RIFF_CHUNKS)} RIFF chunks were examined.`,
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
    limitations,
    regionsExamined,
  };
};

/** Bink 2: revision, leading frame fields and the frame-offset table. */
export const bink2Layout = (
  header: Buffer,
  fileSize: number,
): MediaAssetLayout<Bink2Metadata> => {
  if (header.length < 44)
    throw malformed("bink2", "Bink 2 header is shorter than 44 bytes", 0);
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
  if (!Number.isSafeInteger(frameCount) || frameCount > 1_000_000)
    throw malformed("bink2", "Bink 2 frame count is not a safe table size", 12);
  const tableOffset = 44;
  const tableBytes = (frameCount + 1) * 4;
  if (!Number.isSafeInteger(tableBytes))
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
    throw malformed(
      "vulkan-pipeline-cache",
      "Vulkan pipeline cache header is shorter than 32 bytes",
      0,
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
