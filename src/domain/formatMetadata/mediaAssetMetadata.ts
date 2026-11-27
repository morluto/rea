import { z } from "zod";
import { offset, uint16, uint32, uint8 } from "./primitives.js";

/**
 * Whether declared extents agree with the file: `consistent`, `truncated`
 * (a declared region ends past the file) or `trailing-bytes` (bytes follow
 * every declared region). A disagreement is a fact, not a refusal.
 */
const extentCheck = z.enum(["consistent", "truncated", "trailing-bytes"]);

/** Ogg Opus identification and comment headers as declared (RFC 7845). */
export const oggOpusMetadataSchema = z.strictObject({
  kind: z.literal("ogg-opus"),
  /** Bitstream serial numbers seen on examined pages, in page order. */
  serials: z.array(uint32),
  /** Page sequence numbers of examined pages, in file order. */
  page_sequences: z.array(uint32),
  channel_count: uint8,
  pre_skip: uint16,
  input_sample_rate: uint32,
  output_gain: z.number().int().min(-0x8000).max(0x7fff),
  mapping_family: uint8,
  /** OpusTags vendor string, when that page was examined and valid. */
  vendor: z.string().nullable(),
  pages_read: uint32,
  extent_check: extentCheck,
});
export type OggOpusMetadata = z.infer<typeof oggOpusMetadataSchema>;

/** RIFF WAVE with fmt tag 0x166 (XMA2WAVEFORMATEX) as declared. */
export const riffXma2MetadataSchema = z.strictObject({
  kind: z.literal("riff-xma2"),
  riff_declared_size: uint32,
  chunks: z.array(
    z.strictObject({
      /** Four printable characters of the chunk FourCC. */
      id: z.string(),
      offset,
      length: uint32,
    }),
  ),
  format_tag: uint16,
  channels: uint16,
  samples_per_sec: uint32,
  avg_bytes_per_sec: uint32,
  block_align: uint16,
  bits_per_sample: uint16,
  /**
   * WAVEFORMATEX cbSize; XMA2 declares 34. Null when the fmt chunk is shorter
   * than WAVEFORMATEX and so holds no cbSize.
   */
  fmt_extra_bytes: uint16.nullable(),
  /** XMA2WAVEFORMATEX fields after WAVEFORMATEX, when the fmt holds them. */
  xma2: z
    .strictObject({
      num_streams: uint16,
      channel_mask: uint32,
      samples_encoded: uint32,
      bytes_per_block: uint32,
      play_begin: uint32,
      play_length: uint32,
      loop_begin: uint32,
      loop_length: uint32,
      loop_count: uint8,
      encoder_version: uint8,
      block_count: uint16,
    })
    .nullable(),
  extent_check: extentCheck,
});
export type RiffXma2Metadata = z.infer<typeof riffXma2MetadataSchema>;

/**
 * Bink 2 header fields at the offsets FFmpeg's demuxer reads, the audio
 * track tables and the frame-offset table extent. The word at offset 16 and
 * the revision `i`..`k` word after the track count stay unnamed.
 */
export const bink2MetadataSchema = z.strictObject({
  kind: z.literal("bink2"),
  /** The byte after `KB2`. */
  revision: uint8,
  /** Printable form of the revision byte when it is, otherwise null. */
  revision_char: z.string().nullable(),
  frame_count: uint32,
  largest_frame_size: uint32,
  width: uint32,
  height: uint32,
  fps_numerator: uint32,
  fps_denominator: uint32,
  /** Raw video flags word at offset 36. */
  video_flags: uint32,
  audio_track_count: uint32,
  /**
   * Declared audio tracks in table order; null when the revision is unknown
   * and the tables could not be located.
   */
  audio_tracks: z
    .array(
      z.strictObject({
        max_decoded_size: uint32,
        sample_rate: uint16,
        /** Raw track flags as declared; not decoded. */
        flags: uint16,
        track_id: uint32,
      }),
    )
    .nullable(),
  /** Null when the revision is unknown and the table could not be located. */
  frame_offset_table_offset: offset.nullable(),
  frame_offset_table_bytes: offset.nullable(),
  /** File size the header stores at offset 4, as declared. */
  declared_size_field: uint32,
  extent_check: extentCheck,
});
export type Bink2Metadata = z.infer<typeof bink2MetadataSchema>;

/** `VkPipelineCacheHeaderVersionOne` fields; the body stays opaque. */
export const vulkanPipelineCacheMetadataSchema = z.strictObject({
  kind: z.literal("vulkan-pipeline-cache"),
  header_size: uint32,
  header_version: uint32,
  vendor_id: uint32,
  device_id: uint32,
  /** 16-byte pipelineCacheUUID as 32 lowercase hex digits. */
  pipeline_cache_uuid: z.string().regex(/^[0-9a-f]{32}$/u),
  opaque_offset: offset,
  opaque_bytes: offset,
  extent_check: extentCheck,
});
export type VulkanPipelineCacheMetadata = z.infer<
  typeof vulkanPipelineCacheMetadataSchema
>;

/** One declared region of a media asset: its role and position. */
export const mediaAssetRegionMetadataSchema = z.strictObject({
  kind: z.literal("media-asset-region"),
  role: z.enum([
    "ogg-page",
    "riff-chunk",
    "frame-offset-table",
    "frames",
    "header",
    "opaque-body",
  ]),
  index: uint32,
});
export type MediaAssetRegionMetadata = z.infer<
  typeof mediaAssetRegionMetadataSchema
>;
