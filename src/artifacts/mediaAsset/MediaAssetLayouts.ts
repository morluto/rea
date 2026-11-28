import type {
  Bink2Metadata,
  MediaAssetRegionMetadata,
  OggOpusMetadata,
  RiffXma2Metadata,
  VulkanPipelineCacheMetadata,
} from "../../domain/formatMetadata/mediaAssetMetadata.js";
import { BinaryReader } from "../../domain/binaryContainer.js";
import { decodeStrictUtf8 } from "../../domain/strictUtf8.js";
import type { MediaAssetReaderLimits } from "../../domain/artifactReaderLimits.js";
import { artifactReaderLimitFailure } from "../../resources/index.js";
import { byteToHex } from "../../kernel/byteToHex.js";
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
 * Admit one more listed region against `artifact_limits.media_asset.
 * region_count`. RFC 3533 bounds neither the pages that carry the Opus
 * header packets nor RIFF the chunk count, so the walk stops here with a
 * typed refusal the caller can raise.
 */
export const admitMediaAssetRegions = (
  count: number,
  limits: MediaAssetReaderLimits,
  requiredValue?: number,
): void => {
  if (count > limits.region_count)
    throw artifactReaderLimitFailure(
      "artifact_limits.media_asset.region_count",
      limits.region_count,
      "count",
      requiredValue,
    );
};
/**
 * OpusTags vendor bytes delivered inline as the root `vendor` fact. This is a
 * delivery bound, not an admission: a longer vendor is omitted from the root
 * with a limitation and stays complete in the extractable comment pages.
 */
const MAX_VENDOR_BYTES = 4096;
/**
 * `sizeof(XMA2WAVEFORMATEX)` in the public xma2defs.h: an 18-byte
 * WAVEFORMATEX whose cbSize is 34, followed by the XMA2 fields.
 */
const XMA2_FMT_READ_BYTES = 52;
const XMA2WAVEFORMATEX_EXTRA_BYTES = 34;
/** WAVEFORMATEX through cbSize. */
const WAVEFORMATEX_BYTES = 18;

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
const OPUS_HEAD_BYTES = 19;
const TAGS_PREFIX_LIMIT = 12 + MAX_VENDOR_BYTES;

/** RFC 3533 header_type bits. */
const OGG_CONTINUED_PACKET = 0x01;
const OGG_BEGINNING_OF_STREAM = 0x02;

/** A page that ends past the file, with the end it declares when known. */
interface OggPageCutOff {
  readonly kind: "truncated";
  readonly requiredEnd: number;
}

/**
 * One examined Ogg page's framing metadata and the extent of the first packet
 * (or packet continuation) it carries. RFC 3533 lacing: a packet's segments
 * run until the first lacing value below 255, so one page can end one packet
 * and start others. Header reads stay inside `packetLength`, never the whole
 * page payload.
 */
interface OggPageRecord {
  readonly sequence: number;
  readonly serial: number;
  readonly headerType: number;
  readonly offset: number;
  readonly length: number;
  /** Start of the page payload, which is the start of its first packet. */
  readonly packetOffset: number;
  /** Bytes of the first packet (or continuation) on this page. */
  readonly packetLength: number;
  /** The first packet does not end on this page: every lacing value is 255. */
  readonly continues: boolean;
  /** Payload bytes after the first packet ends: further packets on the page. */
  readonly bytesAfterFirstPacket: number;
}

type ReadBoundedRange = (
  offset: number,
  length: number,
) => Promise<Buffer | "truncated">;

/** One Ogg page's capture header and segment payload extent, read by position. */
const readOggPage = async (
  readRange: ReadBoundedRange,
  at: number,
  fileSize: number,
): Promise<OggPageRecord | OggPageCutOff | "malformed"> => {
  const pageHead = await readRange(at, 27);
  if (pageHead === "truncated")
    return { kind: "truncated", requiredEnd: at + 27 };
  if (pageHead.toString("latin1", 0, 4) !== "OggS") return "malformed";
  if (pageHead[4] !== 0) return "malformed";
  const headerType = pageHead[5]!;
  const fields = new BinaryReader(pageHead, true, "ogg-opus");
  const serial = fields.u32(14);
  const sequence = fields.u32(18);
  const segments = pageHead[26]!;
  const segmentTable = await readRange(at + 27, segments);
  if (segmentTable === "truncated")
    return { kind: "truncated", requiredEnd: at + 27 + segments };
  let payloadBytes = 0;
  let firstPacketBytes = 0;
  let firstPacketEnded = false;
  for (let index = 0; index < segments; index++) {
    const lacing = segmentTable[index]!;
    payloadBytes += lacing;
    if (!firstPacketEnded) {
      firstPacketBytes += lacing;
      if (lacing < 255) firstPacketEnded = true;
    }
  }
  const headerLength = 27 + segments;
  const length = headerLength + payloadBytes;
  if (at + length > fileSize)
    return { kind: "truncated", requiredEnd: at + length };
  return {
    sequence,
    serial,
    headerType,
    offset: at,
    length,
    packetOffset: at + headerLength,
    packetLength: firstPacketBytes,
    continues: !firstPacketEnded,
    bytesAfterFirstPacket: payloadBytes - firstPacketBytes,
  };
};

/** Ogg Opus: OpusHead / OpusTags pages and remaining examined pages. */
export const oggOpusLayout = async (
  header: Buffer,
  fileSize: number,
  read: MediaAssetRead,
  limits: MediaAssetReaderLimits,
): Promise<MediaAssetLayout<OggOpusMetadata>> => {
  /** Read a bounded range by position without growing a prefix buffer across pages. */
  const readRange: ReadBoundedRange = async (offset, length) => {
    if (length <= 0) return Buffer.alloc(0);
    if (offset + length > fileSize) return "truncated";
    if (offset + length <= header.length)
      return header.subarray(offset, offset + length);
    const bytes = await read(offset, length);
    return bytes.length < length ? "truncated" : bytes;
  };

  const pages: OggPageRecord[] = [];
  /** Pages of the Opus stream that carry the OpusTags packet, in order. */
  const tagsPages: OggPageRecord[] = [];
  const tagsPrefixChunks: Buffer[] = [];
  let tagsPrefixBytes = 0;
  let headPacket: Buffer | undefined;
  const limitations: string[] = [];
  let at = 0;
  let cutOff: OggPageCutOff | undefined;
  let tagsPacketOpen = false;
  let tagsComplete = false;
  let otherStreamPages = 0;
  let secondPacketNotTags = false;
  while (at < fileSize) {
    admitMediaAssetRegions(pages.length + 1, limits);
    const page = await readOggPage(readRange, at, fileSize);
    if (page === "malformed")
      throw malformed(
        "ogg-opus",
        pages.length === 0
          ? "Ogg capture pattern is missing or version is not 0"
          : "Ogg page capture pattern is missing or version is not 0",
        at,
      );
    if ("kind" in page) {
      cutOff = page;
      break;
    }

    if (pages.length === 0) {
      const headBytes = await readRange(
        page.packetOffset,
        Math.min(page.packetLength, OPUS_HEAD_BYTES),
      );
      if (headBytes === "truncated") {
        cutOff = { kind: "truncated", requiredEnd: page.offset + page.length };
        break;
      }
      headPacket = headBytes;
      pages.push(page);
      at = page.offset + page.length;
      continue;
    }

    // RFC 3533 multiplexing: pages of other logical streams may sit between
    // the Opus stream's header pages. opusfile skips them while it waits for
    // OpusTags from the OpusHead serial; they are listed as pages here.
    if (page.serial !== pages[0]!.serial) {
      otherStreamPages += 1;
      pages.push(page);
      at = page.offset + page.length;
      continue;
    }

    if (!tagsPacketOpen) {
      const probeLength =
        page.packetLength >= OPUS_TAGS.length
          ? Math.min(page.packetLength, TAGS_PREFIX_LIMIT)
          : 0;
      const probe =
        probeLength > 0
          ? await readRange(page.packetOffset, probeLength)
          : Buffer.alloc(0);
      if (probe === "truncated") {
        cutOff = { kind: "truncated", requiredEnd: page.offset + page.length };
        break;
      }
      if (
        probe.length >= OPUS_TAGS.length &&
        probe.subarray(0, OPUS_TAGS.length).equals(OPUS_TAGS)
      ) {
        tagsPacketOpen = true;
        pages.push(page);
        tagsPages.push(page);
        tagsPrefixChunks.push(probe);
        tagsPrefixBytes += probe.length;
        at = page.offset + page.length;
        if (!page.continues) {
          tagsComplete = true;
          break;
        }
        continue;
      }
      // RFC 7845 section 3 requires OpusTags as the stream's second packet.
      secondPacketNotTags = true;
      limitations.push(
        `The Opus stream's second packet, on the page at offset ${String(page.offset)}, is not OpusTags; no comment header was read.`,
      );
      break;
    }

    if (tagsPrefixBytes < TAGS_PREFIX_LIMIT && page.packetLength > 0) {
      const chunk = await readRange(
        page.packetOffset,
        Math.min(page.packetLength, TAGS_PREFIX_LIMIT - tagsPrefixBytes),
      );
      if (chunk === "truncated") {
        cutOff = { kind: "truncated", requiredEnd: page.offset + page.length };
        break;
      }
      tagsPrefixChunks.push(chunk);
      tagsPrefixBytes += chunk.length;
    }
    if ((page.headerType & OGG_CONTINUED_PACKET) === 0)
      limitations.push(
        `The OpusTags packet continues onto the page at offset ${String(page.offset)}, but that page does not set the continued-packet flag.`,
      );
    pages.push(page);
    tagsPages.push(page);
    at = page.offset + page.length;
    if (!page.continues) {
      tagsComplete = true;
      break;
    }
  }

  if (pages.length === 0) {
    if (cutOff !== undefined)
      throw truncatedInput("ogg-opus", "the first Ogg page is cut off", {
        offset: 0,
        extent: { availableBytes: fileSize, requiredBytes: cutOff.requiredEnd },
      });
    throw malformed("ogg-opus", "no Ogg pages were read", 0);
  }
  let truncated = cutOff !== undefined;
  // RFC 7845 section 3: OpusHead is alone on its page, and the audio data
  // begins on a fresh page after OpusTags. Bytes that break this are not read
  // as header fields; they are named here.
  const headPageRecord = pages[0]!;
  if (headPageRecord.continues || headPageRecord.bytesAfterFirstPacket > 0)
    limitations.push(
      "The OpusHead page carries more than the single OpusHead packet RFC 7845 allows; only the OpusHead packet was read.",
    );
  const lastTagsPage = tagsComplete ? tagsPages.at(-1) : undefined;
  if (lastTagsPage !== undefined && lastTagsPage.bytesAfterFirstPacket > 0)
    limitations.push(
      `The page at offset ${String(lastTagsPage.offset)} that ends OpusTags also starts another packet; RFC 7845 requires audio to begin on a fresh page.`,
    );
  if ((pages[0]!.headerType & OGG_BEGINNING_OF_STREAM) === 0)
    limitations.push(
      "The OpusHead page does not set the beginning-of-stream flag that RFC 7845 requires.",
    );
  if (otherStreamPages > 0)
    limitations.push(
      `${String(otherStreamPages)} examined page(s) belong to other logical streams; they are listed as pages and not interpreted.`,
    );

  if (tagsPacketOpen && !tagsComplete && !truncated && at >= fileSize)
    // A finished page still declared packet continuation past EOF.
    truncated = true;

  const headPage = pages[0]!;
  if (
    headPacket === undefined ||
    headPacket.length < OPUS_HEAD_BYTES ||
    !headPacket.subarray(0, 8).equals(OPUS_HEAD)
  )
    throw malformed(
      "ogg-opus",
      "the first Ogg packet is not OpusHead",
      headPage.offset,
    );
  if (headPacket[8] !== 1)
    throw malformed(
      "ogg-opus",
      "OpusHead version is not 1",
      headPage.offset + 8,
    );

  const head = new BinaryReader(headPacket, true, "ogg-opus");
  const channelCount = head.u8(9);
  const preSkip = head.u16(10);
  const inputSampleRate = head.u32(12);
  const outputGain = head.i16(16);
  const mappingFamily = head.u8(18);

  let vendor: string | null = null;
  if (tagsPages.length > 0) {
    // Only the packet prefix that holds the vendor is assembled; comment
    // payloads, which may be large pictures, stay in their page regions.
    const tagsPrefix = Buffer.concat(tagsPrefixChunks, tagsPrefixBytes);
    if (tagsPrefix.length < 12)
      limitations.push(
        "The OpusTags packet ends before its vendor length; the vendor was not read.",
      );
    else {
      const vendorLength = new BinaryReader(tagsPrefix, true, "ogg-opus").u32(
        8,
      );
      if (vendorLength > MAX_VENDOR_BYTES)
        limitations.push(
          `The OpusTags vendor string declares ${String(vendorLength)} bytes, above the ${String(MAX_VENDOR_BYTES)}-byte vendor fact bound; the vendor fact was omitted and its bytes stay in the comment page regions.`,
        );
      else if (tagsPrefix.length < 12 + vendorLength)
        limitations.push(
          `The OpusTags vendor string declares ${String(vendorLength)} bytes, but only ${String(tagsPrefix.length - 12)} were examined; the vendor was not read.`,
        );
      else
        try {
          vendor = decodeStrictUtf8(
            tagsPrefix.subarray(12, 12 + vendorLength),
            "preserve",
          );
        } catch {
          limitations.push(
            "The OpusTags vendor string is not valid UTF-8, which RFC 7845 requires; the vendor fact was omitted.",
          );
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
  // RFC 7845 requires an OpusTags packet; a file that ends before it holds
  // an incomplete header, not a complete stream.
  const endedBeforeTags =
    !truncated && !tagsPacketOpen && !secondPacketNotTags && at >= fileSize;
  if (endedBeforeTags) {
    truncated = true;
    regionsExamined = "unknown";
    limitations.push(
      `The file ends at offset ${String(fileSize)} before the OpusTags packet RFC 7845 requires after OpusHead.`,
    );
  } else if (truncated) {
    limitations.push(
      `An Ogg page at offset ${String(at)} is cut off; later pages were not listed.`,
    );
    regionsExamined = "unknown";
  } else if (tagsPacketOpen && !tagsComplete) {
    regionsExamined = "unknown";
    limitations.push(
      `OpusTags still continues at offset ${String(pageEnd)}; later bytes were not classified as audio.`,
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
      : fitted.extent === "trailing-bytes" || (tagsPacketOpen && !tagsComplete)
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

/**
 * A FourCC is four arbitrary bytes. Entry paths use it only when it is
 * alphanumeric after trailing spaces, so a crafted ID cannot add separators,
 * dot segments or control characters; the exact ID stays in `chunks[].id`.
 */
const chunkFileSuffix = (id: string): string => {
  const trimmed = id.replace(/ +$/u, "");
  return /^[A-Za-z0-9]{1,4}$/u.test(trimmed) ? trimmed : "bin";
};

/** A FourCC for messages, with non-printable bytes escaped. */
const chunkLabel = (id: string): string =>
  JSON.stringify(id).slice(1, -1) || "chunk";

/** RIFF WAVE XMA2: chunk table and declared fmt / XMA2 fields. */
export const riffXma2Layout = async (
  header: Buffer,
  fileSize: number,
  read: MediaAssetRead,
  limits: MediaAssetReaderLimits,
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
  while (at + 8 <= containerEnd) {
    admitMediaAssetRegions(chunks.length + 1, limits);
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
    if (payloadEnd <= containerEnd && alignedEnd > containerEnd) {
      // Writers commonly omit the pad byte after an odd-sized final chunk.
      // The chunk's own bytes are all present, so it stays listed.
      completeChunks.push(chunk);
      limitations.push(
        `RIFF chunk ${chunkLabel(id)} at offset ${String(at)} has an odd size and ends at the RIFF form end ${String(containerEnd)} without its pad byte.`,
      );
      at = payloadEnd;
      break;
    }
    if (payloadEnd > containerEnd) {
      stopped = true;
      incompleteFraming = true;
      limitations.push(
        `RIFF chunk ${chunkLabel(id)} at offset ${String(at)} declares ${String(size)} byte(s) extending past the RIFF form end at ${String(containerEnd)}; its declared range is kept in metadata but omitted from extractable regions.`,
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

  // Recognition claims only a WAVE whose first chunk is `fmt `; this is that
  // chunk. Like FFmpeg's wavdec, a later fmt chunk is not interpreted.
  const fmt = chunks[0];
  if (fmt?.id !== "fmt ")
    throw malformed("riff-xma2", "the first WAVE chunk is not fmt", 12);
  const laterFmt = chunks.slice(1).filter((chunk) => chunk.id === "fmt ");
  if (laterFmt.length > 0)
    limitations.push(
      `${String(laterFmt.length)} further fmt chunk(s) follow the first; only the first was interpreted.`,
    );
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
  // A 16-byte PCMWAVEFORMAT-style fmt has no cbSize: unknown, not zero.
  const extraBytes = fmtRead >= WAVEFORMATEX_BYTES ? fmtFields.u16(16) : null;
  const hasXma2Fields =
    fmtRead >= XMA2_FMT_READ_BYTES &&
    extraBytes !== null &&
    extraBytes >= XMA2WAVEFORMATEX_EXTRA_BYTES;
  if (!hasXma2Fields)
    limitations.push(
      `The fmt chunk declares tag 0x166 but holds ${String(fmt.length)} byte(s), not the ${String(XMA2_FMT_READ_BYTES)}-byte XMA2WAVEFORMATEX; the XMA2 fields were not read.`,
    );
  const xma2 = hasXma2Fields
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
    path: `chunks/${String(index)}.${chunkFileSuffix(chunk.id)}`,
    role: "riff-chunk" as const,
    index,
    offset: chunk.offset,
    length: chunk.length,
  }));
  const fitted = fitRegions("riff-xma2", regions, fileSize, declaredEnd);
  const allLimitations = [...limitations, ...fitted.limitations];
  const extent: Extent = incompleteFraming ? "truncated" : fitted.extent;
  let regionsExamined: "complete" | "unknown" = "complete";
  if (stopped || incompleteFraming) regionsExamined = "unknown";

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

/**
 * The fixed Bink header through the audio track count. Layout as read by
 * FFmpeg's demuxer (libavformat/bink.c `read_header`): signature, file size
 * minus 8, frame count, largest frame size, an unnamed word, width, height,
 * frame-rate numerator and denominator, video flags, audio track count.
 */
const BINK2_FIXED_HEADER_BYTES = 44;
/**
 * Revisions FFmpeg's probe accepts for `KB2`. Revisions `i`, `j` and `k`
 * carry one further word after the audio track count; for any other byte the
 * position of the tables that follow is unknown.
 */
const BINK2_KNOWN_REVISIONS = new Set("adfghijk");
const BINK2_EXTRA_WORD_REVISIONS = new Set("ijk");
/**
 * Audio track count FFmpeg rejects above as an invalid header
 * (`BINK_MAX_AUDIO_TRACKS`); each track adds 12 table bytes.
 */
const BINK_MAX_AUDIO_TRACKS = 256;
/**
 * Video flag bits after which vgmstream (src/meta/bik.c) reads further header
 * words (6 or 12 16-bit values) before the audio tables, and FFmpeg reads
 * none. The references disagree, so the table position stays unknown.
 */
const BINK2_UNSETTLED_VIDEO_FLAGS = 0x0000_0004 | 0x0001_0000;

/** Bink 2: header fields, audio track tables and the frame-offset table. */
export const bink2Layout = (
  header: Buffer,
  fileSize: number,
): MediaAssetLayout<Bink2Metadata> => {
  const cutOff = (requiredBytes: number, what: string) =>
    truncatedInput("bink2", what, {
      offset: 0,
      extent: { availableBytes: header.length, requiredBytes },
    });
  if (header.length < BINK2_FIXED_HEADER_BYTES)
    throw cutOff(BINK2_FIXED_HEADER_BYTES, "Bink 2 header is cut off");
  if (header.toString("latin1", 0, 3) !== "KB2")
    throw malformed("bink2", "Bink 2 magic is missing", 0);
  const fields = new BinaryReader(header, true, "bink2");
  const revision = fields.u8(3);
  const revisionChar =
    revision >= 0x20 && revision <= 0x7e ? String.fromCharCode(revision) : null;
  const declaredSizeField = fields.u32(4);
  const frameCount = fields.u32(8);
  const largestFrameSize = fields.u32(12);
  const width = fields.u32(20);
  const height = fields.u32(24);
  const fpsNumerator = fields.u32(28);
  const fpsDenominator = fields.u32(32);
  const videoFlags = fields.u32(36);
  const audioTrackCount = fields.u32(40);
  if (audioTrackCount > BINK_MAX_AUDIO_TRACKS)
    throw malformed(
      "bink2",
      `Bink header declares ${String(audioTrackCount)} audio tracks; Bink demuxers accept at most ${String(BINK_MAX_AUDIO_TRACKS)}`,
      40,
    );
  // The size field stores the file size minus 8.
  const declaredEnd = declaredSizeField + 8;
  const known =
    revisionChar !== null && BINK2_KNOWN_REVISIONS.has(revisionChar);
  const unplaced = !known
    ? `Bink 2 revision byte 0x${byteToHex(revision)} is not a revision FFmpeg's Bink demuxer reads; the audio track and frame-offset tables after offset ${String(BINK2_FIXED_HEADER_BYTES)} were not located.`
    : (videoFlags & BINK2_UNSETTLED_VIDEO_FLAGS) !== 0
      ? `Bink 2 video flags 0x${videoFlags.toString(16)} set a bit after which reference readers disagree about further header words; the audio track and frame-offset tables after offset ${String(BINK2_FIXED_HEADER_BYTES)} were not located.`
      : undefined;
  const metadataBase = {
    kind: "bink2" as const,
    revision,
    revision_char: revisionChar,
    frame_count: frameCount,
    largest_frame_size: largestFrameSize,
    width,
    height,
    fps_numerator: fpsNumerator,
    fps_denominator: fpsDenominator,
    video_flags: videoFlags,
    audio_track_count: audioTrackCount,
    declared_size_field: declaredSizeField,
  };
  if (unplaced !== undefined) {
    // Without the revision's layout the track and frame tables cannot be
    // placed; nothing after the fixed header is listed or interpreted.
    const fitted = fitRegions("bink2", [], fileSize, declaredEnd);
    return {
      metadata: {
        ...metadataBase,
        audio_tracks: null,
        frame_offset_table_offset: null,
        frame_offset_table_bytes: null,
        extent_check: fitted.extent,
      },
      regions: [],
      limitations: [
        unplaced,
        ...fitted.limitations.filter(
          (line) => !line.includes("follow the last declared"),
        ),
      ],
      regionsExamined: "unknown",
    };
  }
  const tracksOffset =
    BINK2_FIXED_HEADER_BYTES +
    (revisionChar !== null && BINK2_EXTRA_WORD_REVISIONS.has(revisionChar)
      ? 4
      : 0);
  // Per track: max decoded size words, then (sample rate, flags) pairs, then
  // track IDs, each as one 32-bit word per track.
  const tracksEnd = tracksOffset + 12 * audioTrackCount;
  if (tracksEnd > declaredEnd) {
    const fitted = fitRegions("bink2", [], fileSize, declaredEnd);
    return {
      metadata: {
        ...metadataBase,
        audio_tracks: null,
        frame_offset_table_offset: null,
        frame_offset_table_bytes: null,
        extent_check:
          fitted.extent === "consistent" ? "truncated" : fitted.extent,
      },
      regions: [],
      limitations: [
        `Bink 2 audio track tables end at offset ${String(tracksEnd)} but the file declares only ${String(declaredEnd)} bytes; the audio track tables, frame-offset table and frames were not listed.`,
        ...fitted.limitations.filter(
          (line) => !line.includes("follow the last declared"),
        ),
      ],
      regionsExamined: "unknown",
    };
  }
  if (header.length < tracksEnd)
    throw cutOff(tracksEnd, "Bink 2 audio track tables are cut off");
  const audioTracks = Array.from({ length: audioTrackCount }, (_, index) => {
    const pair = tracksOffset + 4 * audioTrackCount + 4 * index;
    return {
      max_decoded_size: fields.u32(tracksOffset + 4 * index),
      sample_rate: fields.u16(pair),
      flags: fields.u16(pair + 2),
      track_id: fields.u32(tracksOffset + 8 * audioTrackCount + 4 * index),
    };
  });
  const tableOffset = tracksEnd;
  // frame_count + 1 offsets; a u32 count keeps this a safe integer.
  const tableBytes = (frameCount + 1) * 4;
  const framesOffset = tableOffset + tableBytes;
  if (framesOffset > declaredEnd) {
    const fitted = fitRegions(
      "bink2",
      [
        {
          path: "frame-offsets.bin",
          role: "frame-offset-table",
          index: 0,
          offset: tableOffset,
          length: tableBytes,
        },
      ],
      fileSize,
      declaredEnd,
    );
    return {
      metadata: {
        ...metadataBase,
        audio_tracks: audioTracks,
        frame_offset_table_offset: tableOffset,
        frame_offset_table_bytes: tableBytes,
        extent_check: fitted.extent,
      },
      regions: [],
      limitations: [
        `Bink 2 header tables end at offset ${String(framesOffset)} but the file declares only ${String(declaredEnd)} bytes; the frame-offset table and frames were not listed.`,
        ...fitted.limitations.filter(
          (line) =>
            !line.includes("follow the last declared") &&
            !line.includes("was not listed"),
        ),
      ],
      regionsExamined: "unknown",
    };
  }
  const regions: MediaAssetRegion[] = [
    {
      path: "frame-offsets.bin",
      role: "frame-offset-table",
      index: 0,
      offset: tableOffset,
      length: tableBytes,
    },
  ];
  if (framesOffset < declaredEnd)
    regions.push({
      path: "frames.bin",
      role: "frames",
      index: 0,
      offset: framesOffset,
      length: declaredEnd - framesOffset,
    });
  const fitted = fitRegions("bink2", regions, fileSize, declaredEnd);
  return {
    metadata: {
      ...metadataBase,
      audio_tracks: audioTracks,
      frame_offset_table_offset: tableOffset,
      frame_offset_table_bytes: tableBytes,
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
