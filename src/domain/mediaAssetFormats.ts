import { BinaryReader } from "./binaryContainer.js";

/** The little-endian word at `offset`, when the prefix holds it. */
const leU32 = (prefix: Uint8Array, offset: number): number | undefined =>
  prefix.length < offset + 4
    ? undefined
    : new BinaryReader(
        Buffer.from(prefix.buffer, prefix.byteOffset, prefix.length),
        true,
        "media-asset",
      ).u32(offset);

const leU16 = (prefix: Uint8Array, offset: number): number | undefined =>
  prefix.length < offset + 2
    ? undefined
    : new BinaryReader(
        Buffer.from(prefix.buffer, prefix.byteOffset, prefix.length),
        true,
        "media-asset",
      ).u16(offset);

const startsWith = (prefix: Uint8Array, magic: Uint8Array): boolean =>
  prefix.length >= magic.length &&
  magic.every((byte, index) => prefix[index] === byte);

/**
 * Leading signatures of media and GPU-cache containers with public headers:
 *
 * - Ogg Opus: RFC 3533 pages whose first packet is RFC 7845 OpusHead.
 * - RIFF WAVE with fmt tag 0x166 (XMA2WAVEFORMATEX).
 * - Bink 2: `KB2` plus a revision byte.
 * - Vulkan pipeline cache: `VK_PIPELINE_CACHE_HEADER_VERSION_ONE`.
 */
export const OGG_CAPTURE = Buffer.from("OggS", "latin1");
export const OPUS_HEAD = Buffer.from("OpusHead", "latin1");
export const RIFF_MAGIC = Buffer.from("RIFF", "latin1");
export const WAVE_MAGIC = Buffer.from("WAVE", "latin1");
export const BINK2_MAGIC = Buffer.from("KB2", "latin1");
/** `WAVE_FORMAT_XMA2` in the public Windows SDK headers. */
export const WAVE_FORMAT_XMA2 = 0x166;
/** `VK_PIPELINE_CACHE_HEADER_VERSION_ONE` and its 32-byte header. */
export const VK_PIPELINE_CACHE_HEADER_VERSION_ONE = 1;
export const VK_PIPELINE_CACHE_HEADER_SIZE = 32;

/**
 * An Ogg capture pattern whose first page packet begins with OpusHead.
 * The segment table must fit the prefix so the packet start is visible.
 */
export const hasOggOpusHeader = (prefix: Uint8Array): boolean => {
  if (!startsWith(prefix, OGG_CAPTURE) || prefix.length < 28) return false;
  if (prefix[4] !== 0) return false;
  const segments = prefix[26];
  if (segments === undefined || prefix.length < 27 + segments) return false;
  let packet = 0;
  for (let index = 0; index < segments; index++) {
    const size = prefix[27 + index];
    if (size === undefined) return false;
    packet += size;
    if (size < 255) break;
  }
  const dataAt = 27 + segments;
  return (
    prefix.length >= dataAt + OPUS_HEAD.length &&
    startsWith(prefix.subarray(dataAt), OPUS_HEAD) &&
    packet >= OPUS_HEAD.length
  );
};

/**
 * `RIFF` / `WAVE` whose first `fmt ` chunk declares tag 0x166. Only the
 * contiguous leading WAVE layout (fmt at offset 12) is claimed here. The
 * claim needs only the bytes through that tag (offset 22), so a file cut off
 * inside the fmt fields is still recognized and its reader reports it as
 * truncated.
 */
const RIFF_XMA2_SIGNATURE_BYTES = 22;
export const hasRiffXma2Header = (prefix: Uint8Array): boolean => {
  if (!startsWith(prefix, RIFF_MAGIC)) return false;
  if (prefix.length < RIFF_XMA2_SIGNATURE_BYTES) return false;
  if (!startsWith(prefix.subarray(8), WAVE_MAGIC)) return false;
  if (
    prefix[12] !== 0x66 ||
    prefix[13] !== 0x6d ||
    prefix[14] !== 0x74 ||
    prefix[15] !== 0x20
  )
    return false;
  const fmtSize = leU32(prefix, 16);
  if (fmtSize === undefined || fmtSize < 16) return false;
  return leU16(prefix, 20) === WAVE_FORMAT_XMA2;
};

/**
 * `KB2` plus a lowercase revision letter, the signature form Bink 2 files
 * use. A shorter-than-header file is still claimed so that inspection can
 * report it as truncated instead of unrecognized.
 */
export const hasBink2Header = (prefix: Uint8Array): boolean => {
  const revision = prefix[3];
  return (
    startsWith(prefix, BINK2_MAGIC) &&
    revision !== undefined &&
    revision >= 0x61 &&
    revision <= 0x7a
  );
};

/**
 * `VkPipelineCacheHeaderVersionOne`: header size 32 and version 1. There is
 * no magic; only this exact VersionOne size and version pair is claimed. The
 * pair is the signature, so a file cut off after it is still recognized and
 * its reader reports the header as truncated.
 */
export const hasVulkanPipelineCacheHeader = (prefix: Uint8Array): boolean =>
  leU32(prefix, 0) === VK_PIPELINE_CACHE_HEADER_SIZE &&
  leU32(prefix, 4) === VK_PIPELINE_CACHE_HEADER_VERSION_ONE;
