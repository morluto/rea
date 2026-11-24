import { z } from "zod";
import { offset, uint32 } from "./primitives.js";

/**
 * Whether declared extents agree with the file: `consistent`, `truncated`
 * (a declared region ends past the file) or `trailing-bytes` (bytes follow
 * every declared region). A disagreement is a fact, not a refusal.
 */
const extentCheck = z.enum(["consistent", "truncated", "trailing-bytes"]);

/** DDS_HEADER and, when present, DDS_HEADER_DXT10 fields as declared. */
export const ddsMetadataSchema = z.strictObject({
  kind: z.literal("dds"),
  header_flags: uint32,
  height: uint32,
  width: uint32,
  depth: uint32,
  pitch_or_linear_size: uint32,
  mip_map_count: uint32,
  pixel_format_flags: uint32,
  /** Four printable characters, or null when the FOURCC flag is clear. */
  four_cc: z.string().nullable(),
  rgb_bit_count: uint32,
  caps: uint32,
  caps2: uint32,
  dx10: z
    .strictObject({
      dxgi_format: uint32,
      /** Name from the public DXGI_FORMAT enum, when REA lists it. */
      dxgi_format_name: z.string().nullable(),
      resource_dimension: uint32,
      misc_flag: uint32,
      array_size: uint32,
      misc_flags2: uint32,
    })
    .nullable(),
  payload_offset: offset,
  payload_bytes: offset,
  /** Derived from dimensions, mips, faces and block size; null when the format's size is not derived. */
  expected_payload_bytes: offset.nullable(),
  extent_check: extentCheck,
});
export type DdsMetadata = z.infer<typeof ddsMetadataSchema>;

/** The GLB container header, chunk table and counts from its JSON chunk. */
export const glbMetadataSchema = z.strictObject({
  kind: z.literal("glb"),
  version: uint32,
  declared_length: uint32,
  chunks: z.array(
    z.strictObject({
      /** `JSON`, `BIN` or the raw type as eight hex digits. */
      type: z.string(),
      offset,
      length: uint32,
    }),
  ),
  /** `asset.version` and `asset.generator`, as declared. */
  asset_version: z.string().nullable(),
  asset_generator: z.string().nullable(),
  /** Array lengths of the top-level glTF collections that are present. */
  counts: z.record(z.string(), offset),
  extensions_used: z.array(z.string()),
  /** Why the JSON chunk was not read for counts, when it was not. */
  json_status: z.enum(["parsed", "invalid", "limit"]),
  /**
   * Images stored outside the GLB: named by a URI, or in a buffer that has a
   * URI. They are not regions of this file.
   */
  external_images: offset,
  extent_check: extentCheck,
});
export type GlbMetadata = z.infer<typeof glbMetadataSchema>;

/** KTX 1.1 header fields as declared. */
export const ktxMetadataSchema = z.strictObject({
  kind: z.literal("ktx"),
  endianness: z.enum(["little", "big"]),
  gl_type: uint32,
  gl_type_size: uint32,
  gl_format: uint32,
  gl_internal_format: uint32,
  gl_base_internal_format: uint32,
  pixel_width: uint32,
  pixel_height: uint32,
  pixel_depth: uint32,
  array_elements: uint32,
  faces: uint32,
  mip_levels: uint32,
  key_value_bytes: uint32,
  /** Mip levels whose image sizes were read before the file ended. */
  levels_read: uint32,
  extent_check: extentCheck,
});
export type KtxMetadata = z.infer<typeof ktxMetadataSchema>;

const ktx2Range = z.strictObject({ offset, length: offset });

/** KTX 2.0 header and index fields as declared. */
export const ktx2MetadataSchema = z.strictObject({
  kind: z.literal("ktx2"),
  vk_format: uint32,
  type_size: uint32,
  pixel_width: uint32,
  pixel_height: uint32,
  pixel_depth: uint32,
  layer_count: uint32,
  face_count: uint32,
  level_count: uint32,
  supercompression_scheme: uint32,
  /** `none`, `BasisLZ`, `Zstandard` or `ZLIB`; null for a scheme REA does not name. */
  supercompression_name: z.string().nullable(),
  dfd: ktx2Range,
  kvd: ktx2Range,
  sgd: ktx2Range,
  levels: z.array(
    z.strictObject({
      offset,
      length: offset,
      uncompressed_length: offset,
    }),
  ),
  extent_check: extentCheck,
});
export type Ktx2Metadata = z.infer<typeof ktx2MetadataSchema>;

/** One declared region of a GPU asset: its role and position in the declaration. */
export const gpuAssetRegionMetadataSchema = z.strictObject({
  kind: z.literal("gpu-asset-region"),
  role: z.enum([
    "payload",
    "json-chunk",
    "bin-chunk",
    "chunk",
    "image",
    "key-value-data",
    "data-format-descriptor",
    "supercompression-global-data",
    "level",
  ]),
  index: uint32,
});
export type GpuAssetRegionMetadata = z.infer<
  typeof gpuAssetRegionMetadataSchema
>;
