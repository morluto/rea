import { z } from "zod";
import {
  ntfsFileReferenceSchema,
  ntfsFileNameSchema,
  ntfsAttributeSchema,
  ntfsAttributeIssueSchema,
  ntfsAttributeListResolutionSchema,
} from "../windows/ntfsMftAttributes.js";
import { MFT_INLINE_HEADER_LIMIT } from "../windows/ntfsMft.js";
import { offset, uint32 } from "./primitives.js";

const ntfsRecordHeaderSchema = z.strictObject({
  index: offset,
  fileOffset: offset,
  sequenceNumber: offset,
  hardLinkCount: offset,
  flags: z.strictObject({
    raw: offset,
    names: z.array(z.string()),
    unknownMask: offset,
  }),
  inUse: z.boolean(),
  directory: z.boolean(),
  usedBytes: offset,
  totalBytes: offset,
  extentValid: z.boolean(),
  baseRecordReference: ntfsFileReferenceSchema.nullable(),
  declaredRecordNumber: offset.nullable(),
  recordNumberMatchesSlot: z.boolean().nullable(),
  logFileSequenceNumber: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
  firstAttributeOffset: offset,
  nextAttributeId: offset,
  fileNames: z.array(ntfsFileNameSchema).exactOptional(),
  attributes: z.array(ntfsAttributeSchema).exactOptional(),
  // domain-vocabulary: whether the physical MFT record's attribute stream reached its 0xffffffff end marker without a malformed attribute.
  attributeCoverage: z.enum(["complete", "incomplete"]).exactOptional(),
  attributeIssue: ntfsAttributeIssueSchema.nullable().exactOptional(),
  // domain-vocabulary: whether resident FILE_NAME attributes come from a complete local attribute stream with no $ATTRIBUTE_LIST.
  fileNameCoverage: z.enum(["complete", "incomplete"]).exactOptional(),
  attributeListResolution: ntfsAttributeListResolutionSchema.exactOptional(),
  fixups: z.strictObject({
    sequenceNumber: offset,
    entries: offset,
    verifiedSectors: offset,
    coveredSectors: offset,
    mismatchSector: offset.nullable(),
    malformed: z.boolean(),
  }),
});

/** NTFS $MFT record-header and resident file-name coverage facts. */
export const ntfsMftMetadataSchema = z.strictObject({
  kind: z.literal("ntfs-mft"),
  record_bytes: offset,
  record_count: offset,
  in_use_record_count: offset,
  directory_record_count: offset,
  extension_record_count: offset,
  fixup_mismatch_count: offset,
  fixup_unverified_record_count: offset,
  truncated_tail_bytes: offset,
  record_headers: z.array(ntfsRecordHeaderSchema).max(MFT_INLINE_HEADER_LIMIT),
  omitted_record_headers: offset,
  record_header_start_index: offset.exactOptional(),
  next_record_header_index: offset.nullable().exactOptional(),
  file_name_count: offset.exactOptional(),
  file_name_incomplete_record_count: offset.exactOptional(),
  attribute_incomplete_record_count: offset.exactOptional(),
});

const androidOtaHash = z
  .string()
  .regex(/^[0-9a-f]*$/u)
  .nullable();

const androidOtaPartitionInfoSchema = z.strictObject({
  size: offset.nullable(),
  hash_hex: androidOtaHash,
});

const androidOtaOperationCountSchema = z.strictObject({
  type: z.string(),
  type_code: z.number().int().min(0),
  count: uint32,
});

/**
 * CrAU v2 DeltaArchiveManifest facts. Signatures are counted, not verified.
 * Partition images are reconstructed only from REPLACE, ZERO and REPLACE_ZSTD.
 */
export const androidOtaPayloadMetadataSchema = z.strictObject({
  kind: z.literal("android-ota-payload"),
  magic: z.literal("CrAU"),
  major_version: z.literal(2),
  manifest_size: offset,
  metadata_signature_size: uint32,
  manifest_offset: offset,
  blob_offset: offset,
  block_size: offset,
  minor_version: uint32,
  payload_kind: z.enum(["full", "delta"]),
  max_timestamp: z.number().int().nullable(),
  partial_update: z.boolean().nullable(),
  security_patch_level: z.string().nullable(),
  signatures_offset: offset.nullable(),
  signatures_size: offset.nullable(),
  metadata_signature_blob_size: uint32,
  metadata_signature_count: uint32.nullable(),
  payload_signature_blob_size: offset.nullable(),
  payload_signature_count: uint32.nullable(),
  signatures_verified: z.literal(false),
  snapshot_enabled: z.boolean().nullable(),
  vabc_enabled: z.boolean().nullable(),
  vabc_compression_param: z.string().nullable(),
  blob_truncated: z.boolean(),
  partitions: z.array(
    z.strictObject({
      index: uint32,
      name: z.string(),
      path: z.string(),
      new_partition_info: androidOtaPartitionInfoSchema,
      old_partition_info: androidOtaPartitionInfoSchema.nullable(),
      version: z.string().nullable(),
      run_postinstall: z.boolean().nullable(),
      postinstall_path: z.string().nullable(),
      filesystem_type: z.string().nullable(),
      operation_counts: z.array(androidOtaOperationCountSchema),
      total_data_length: offset,
      merge_operation_count: uint32,
      estimate_cow_size: offset.nullable(),
      extractable: z.boolean(),
    }),
  ),
  dynamic_partition_groups: z.array(
    z.strictObject({
      name: z.string(),
      size: offset.nullable(),
      partition_names: z.array(z.string()),
    }),
  ),
  apex_info: z.array(
    z.strictObject({
      package_name: z.string().nullable(),
      version: z.number().int().nullable(),
      is_compressed: z.boolean().nullable(),
      decompressed_size: z.number().int().nullable(),
    }),
  ),
});
export type AndroidOtaPayloadMetadata = z.infer<
  typeof androidOtaPayloadMetadataSchema
>;

/** One partition the payload writes; reconstructed bytes are not a file range. */
export const androidOtaPartitionMetadataSchema = z.strictObject({
  kind: z.literal("android-ota-partition"),
  index: uint32,
  name: z.string(),
  extractable: z.boolean(),
  new_partition_info: androidOtaPartitionInfoSchema,
  old_partition_info: androidOtaPartitionInfoSchema.nullable(),
  version: z.string().nullable(),
  run_postinstall: z.boolean().nullable(),
  postinstall_path: z.string().nullable(),
  filesystem_type: z.string().nullable(),
  operation_counts: z.array(androidOtaOperationCountSchema),
  total_data_length: offset,
  merge_operation_count: uint32,
  estimate_cow_size: offset.nullable(),
});
export type AndroidOtaPartitionMetadata = z.infer<
  typeof androidOtaPartitionMetadataSchema
>;

const androidSparseChunkCountsSchema = z.strictObject({
  raw: uint32,
  fill: uint32,
  dont_care: uint32,
  crc32: uint32,
});

/**
 * Android sparse image header and chunk-table facts. The stored image checksum
 * and CRC32 chunk values are recorded, not verified. Fill patterns list the
 * first 16 distinct values and CRC32 chunks the first 16 chunks.
 */
export const androidSparseImageMetadataSchema = z.strictObject({
  kind: z.literal("android-sparse-image"),
  magic: z.literal("0xed26ff3a"),
  major_version: z.literal(1),
  minor_version: z.number().int().min(0).max(0xffff),
  file_header_size: z.number().int().min(28).max(0xffff),
  chunk_header_size: z.number().int().min(12).max(0xffff),
  block_size: uint32,
  total_blocks: uint32,
  total_chunks: uint32,
  expanded_size: offset,
  image_checksum: uint32,
  checksums_verified: z.literal(false),
  chunk_counts: androidSparseChunkCountsSchema,
  /** Expanded output bytes each chunk type covers; CRC32 chunks cover none. */
  covered_bytes: z.strictObject({
    raw: offset,
    fill: offset,
    dont_care: offset,
  }),
  fill_patterns: z.array(z.string().regex(/^[0-9a-f]{8}$/u)).max(16),
  crc32_chunks: z
    .array(z.strictObject({ file_offset: offset, value: uint32 }))
    .max(16),
  undecoded_file_header_bytes: uint32,
  undecoded_file_header_hex: z.string().regex(/^[0-9a-f]*$/u),
  undecoded_chunk_header_bytes: uint32,
  trailing_bytes: offset,
});
export type AndroidSparseImageMetadata = z.infer<
  typeof androidSparseImageMetadataSchema
>;

/**
 * Android boot and vendor_boot header facts. Addresses, names, and the
 * command line are declarations from the image. The digest, v4 signature,
 * and AVB footer are recorded and not verified.
 */
export const androidBootImageMetadataSchema = z.strictObject({
  kind: z.literal("android-boot-image"),
  image_kind: z.enum(["boot", "vendor-boot"]),
  magic: z.enum(["ANDROID!", "VNDRBOOT"]),
  header_version: z.number().int().min(0).max(4),
  page_size: z.number().int().min(2048).max(65536),
  header_size: offset,
  os_version_raw: uint32.nullable(),
  os_version: z
    .string()
    .regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/u)
    .nullable(),
  security_patch_level: z
    .string()
    .regex(/^\d{4}-\d{2}$/u)
    .nullable(),
  name: z.string().nullable(),
  name_bytes_hex: z
    .string()
    .regex(/^[0-9a-f]{32}$/u)
    .nullable(),
  cmdline: z.string().nullable(),
  cmdline_bytes_hex: z
    .string()
    .regex(/^(?:[0-9a-f]{1024}|[0-9a-f]{3072}|[0-9a-f]{4096})$/u),
  extra_cmdline: z.string().nullable(),
  extra_cmdline_bytes_hex: z
    .string()
    .regex(/^[0-9a-f]{2048}$/u)
    .nullable(),
  command_line: z.string().nullable(),
  header_digest_hex: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .nullable(),
  kernel_addr: uint32.nullable(),
  ramdisk_addr: uint32.nullable(),
  second_addr: uint32.nullable(),
  tags_addr: uint32.nullable(),
  dtb_addr: offset.nullable(),
  kernel_size: uint32.nullable(),
  ramdisk_size: uint32.nullable(),
  second_size: uint32.nullable(),
  recovery_dtbo_size: uint32.nullable(),
  recovery_dtbo_offset: offset.nullable(),
  dtb_size: uint32.nullable(),
  signature_size: uint32.nullable(),
  vendor_ramdisk_size: uint32.nullable(),
  vendor_ramdisk_table_entry_count: uint32.nullable(),
  vendor_ramdisk_table_entry_size: uint32.nullable(),
  bootconfig_size: uint32.nullable(),
  avb_footer_present: z.boolean(),
  avb_footer_size: z.literal(64).nullable(),
  avb_version_major: uint32.nullable(),
  avb_version_minor: uint32.nullable(),
  avb_original_image_size: offset.nullable(),
  avb_vbmeta_offset: offset.nullable(),
  avb_vbmeta_size: offset.nullable(),
  component_count: uint32,
});
export type AndroidBootImageMetadata = z.infer<
  typeof androidBootImageMetadataSchema
>;

/** One stored boot-image component. Compression is a leading-magic observation. */
export const androidBootImageEntryMetadataSchema = z.strictObject({
  kind: z.literal("android-boot-image-entry"),
  role: z.enum([
    "kernel",
    "ramdisk",
    "second",
    "recovery-dtbo",
    "dtb",
    "vendor-ramdisk",
    "bootconfig",
    "signature",
  ]),
  index: uint32,
  compression: z.enum(["gzip", "lz4", "zstd"]).nullable(),
  ramdisk_type: uint32.nullable(),
  ramdisk_type_name: z.string().nullable(),
  load_address: offset.nullable(),
  name_bytes_hex: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .nullable(),
  board_id_hex: z
    .string()
    .regex(/^[0-9a-f]{128}$/u)
    .nullable(),
});
export type AndroidBootImageEntryMetadata = z.infer<
  typeof androidBootImageEntryMetadataSchema
>;

const vbmetaHex = z.string().regex(/^[0-9a-f]*$/u);
/** An unsigned 64-bit value that is metadata only, as a decimal string. */
const vbmetaU64Decimal = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);
const vbmetaSha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const vbmetaAlgorithmName = z.enum([
  "NONE",
  "SHA256_RSA2048",
  "SHA256_RSA4096",
  "SHA256_RSA8192",
  "SHA512_RSA2048",
  "SHA512_RSA4096",
  "SHA512_RSA8192",
  "UNKNOWN",
]);

const vbmetaDescriptorCommon = {
  offset: offset,
  num_bytes_following: offset,
};

const androidVbmetaPropertyDescriptorSchema = z.strictObject({
  ...vbmetaDescriptorCommon,
  tag: z.literal(0),
  tag_name: z.literal("PROPERTY"),
  key: z.string().nullable(),
  key_bytes_hex: vbmetaHex,
  value: z.string().nullable(),
  value_bytes_hex: vbmetaHex,
});

const androidVbmetaHashtreeDescriptorSchema = z.strictObject({
  ...vbmetaDescriptorCommon,
  tag: z.literal(1),
  tag_name: z.literal("HASHTREE"),
  partition_name: z.string().nullable(),
  partition_name_bytes_hex: vbmetaHex,
  dm_verity_version: uint32,
  image_size: vbmetaU64Decimal,
  tree_offset: vbmetaU64Decimal,
  tree_size: vbmetaU64Decimal,
  data_block_size: uint32,
  hash_block_size: uint32,
  fec_num_roots: uint32,
  fec_offset: vbmetaU64Decimal,
  fec_size: vbmetaU64Decimal,
  hash_algorithm: z.string().nullable(),
  hash_algorithm_bytes_hex: z.string().regex(/^[0-9a-f]{64}$/u),
  salt_hex: vbmetaHex,
  root_digest_hex: vbmetaHex,
  flags: uint32,
  flag_names: z.array(z.string()),
});

const androidVbmetaHashDescriptorSchema = z.strictObject({
  ...vbmetaDescriptorCommon,
  tag: z.literal(2),
  tag_name: z.literal("HASH"),
  partition_name: z.string().nullable(),
  partition_name_bytes_hex: vbmetaHex,
  image_size: vbmetaU64Decimal,
  hash_algorithm: z.string().nullable(),
  hash_algorithm_bytes_hex: z.string().regex(/^[0-9a-f]{64}$/u),
  salt_hex: vbmetaHex,
  digest_hex: vbmetaHex,
  flags: uint32,
  flag_names: z.array(z.string()),
});

const androidVbmetaKernelCmdlineDescriptorSchema = z.strictObject({
  ...vbmetaDescriptorCommon,
  tag: z.literal(3),
  tag_name: z.literal("KERNEL_CMDLINE"),
  flags: uint32,
  flag_names: z.array(z.string()),
  cmdline: z.string().nullable(),
  cmdline_bytes_hex: vbmetaHex,
});

const androidVbmetaChainPartitionDescriptorSchema = z.strictObject({
  ...vbmetaDescriptorCommon,
  tag: z.literal(4),
  tag_name: z.literal("CHAIN_PARTITION"),
  rollback_index_location: uint32,
  partition_name: z.string().nullable(),
  partition_name_bytes_hex: vbmetaHex,
  public_key_size: offset,
  public_key_sha256: vbmetaSha256,
  flags: uint32,
  flag_names: z.array(z.string()),
});

const androidVbmetaUnknownDescriptorSchema = z.strictObject({
  ...vbmetaDescriptorCommon,
  tag: vbmetaU64Decimal,
  tag_name: z.literal("UNKNOWN"),
});

/** One vbmeta descriptor. Unknown tags keep their tag, size, and file offset. */
export const androidVbmetaDescriptorSchema = z.discriminatedUnion("tag_name", [
  androidVbmetaPropertyDescriptorSchema,
  androidVbmetaHashtreeDescriptorSchema,
  androidVbmetaHashDescriptorSchema,
  androidVbmetaKernelCmdlineDescriptorSchema,
  androidVbmetaChainPartitionDescriptorSchema,
  androidVbmetaUnknownDescriptorSchema,
]);
export type AndroidVbmetaDescriptor = z.infer<
  typeof androidVbmetaDescriptorSchema
>;

/**
 * Android Verified Boot vbmeta header and descriptors. Range fields are the
 * header's own block-relative values. Descriptor `offset` is a file offset.
 * Signatures and digests are recorded and not verified.
 */
export const androidVbmetaMetadataSchema = z.strictObject({
  kind: z.literal("android-vbmeta"),
  magic: z.literal("AVB0"),
  required_libavb_version_major: uint32,
  required_libavb_version_minor: uint32,
  algorithm_type: uint32,
  algorithm_name: vbmetaAlgorithmName,
  authentication_data_block_size: offset,
  auxiliary_data_block_size: offset,
  hash_offset: offset,
  hash_size: offset,
  signature_offset: offset,
  signature_size: offset,
  public_key_offset: offset,
  public_key_size: offset,
  public_key_sha256: vbmetaSha256.nullable(),
  public_key_metadata_offset: offset,
  public_key_metadata_size: offset,
  descriptors_offset: offset,
  descriptors_size: offset,
  rollback_index: vbmetaU64Decimal,
  rollback_index_location: uint32,
  flags: uint32,
  flag_names: z.array(z.string()),
  release_string: z.string().nullable(),
  release_string_bytes_hex: z.string().regex(/^[0-9a-f]{96}$/u),
  image_size: offset,
  trailing_bytes: offset,
  signatures_verified: z.literal(false),
  descriptors: z.array(androidVbmetaDescriptorSchema),
  /**
   * Null when every descriptor decoded. Otherwise the malformed descriptor
   * that stopped the walk; `descriptors` holds the decoded prefix.
   */
  descriptor_failure: z
    .strictObject({
      kind: z.enum(["malformed", "truncated"]),
      detail: z.string(),
      field: z.string().nullable(),
      offset,
      descriptor_offset: offset,
      unexamined_bytes: offset,
    })
    .nullable(),
});
export type AndroidVbmetaMetadata = z.infer<typeof androidVbmetaMetadataSchema>;

/** One stored vbmeta range. The role restates the child path. */
export const androidVbmetaEntryMetadataSchema = z.strictObject({
  kind: z.literal("android-vbmeta-entry"),
  role: z.enum(["authentication-block", "public-key", "public-key-metadata"]),
});
export type AndroidVbmetaEntryMetadata = z.infer<
  typeof androidVbmetaEntryMetadataSchema
>;

/** A complete stored descriptor, including its 16-byte header. */
export const androidVbmetaDescriptorEntryMetadataSchema = z.strictObject({
  kind: z.literal("android-vbmeta-descriptor"),
  index: uint32,
  tag: vbmetaU64Decimal,
  tag_name: z.enum([
    "PROPERTY",
    "HASHTREE",
    "HASH",
    "KERNEL_CMDLINE",
    "CHAIN_PARTITION",
    "UNKNOWN",
  ]),
  descriptor_size: offset,
});
export type AndroidVbmetaDescriptorEntryMetadata = z.infer<
  typeof androidVbmetaDescriptorEntryMetadataSchema
>;

/**
 * ISO 9660 primary volume descriptor facts, with what the rest of the
 * descriptor set declares. The identifiers, sizes, set and sequence numbers,
 * dates, `root_directory_extent` and `boot_catalog_sector` are observed
 * declarations from the image (dates that are unrecorded or not valid
 * calendar times are null). `volume_descriptor_count`,
 * `el_torito_boot_record`, `joliet_level`, `name_source`, `directory_count`
 * and `file_count` are derived from the descriptors present and the walked
 * tree. Rock Ridge, UDF and El Torito boot images are not decoded.
 */
export const iso9660MetadataSchema = z.strictObject({
  kind: z.literal("iso9660"),
  system_identifier: z.string(),
  volume_identifier: z.string(),
  volume_set_identifier: z.string(),
  publisher_identifier: z.string(),
  data_preparer_identifier: z.string(),
  application_identifier: z.string(),
  volume_space_size: uint32,
  logical_block_size: z.literal(2048),
  volume_set_size: uint32,
  volume_sequence_number: uint32,
  path_table_size: uint32,
  root_directory_extent: uint32,
  creation_date: z.string().nullable(),
  modification_date: z.string().nullable(),
  expiration_date: z.string().nullable(),
  effective_date: z.string().nullable(),
  volume_descriptor_count: uint32,
  el_torito_boot_record: z.boolean(),
  boot_catalog_sector: uint32.nullable(),
  joliet_level: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullable(),
  name_source: z.enum(["primary", "joliet"]),
  directory_count: uint32,
  file_count: uint32,
});
export type Iso9660Metadata = z.infer<typeof iso9660MetadataSchema>;

/**
 * One ISO 9660 directory member, from its directory record or records.
 * `identifier`, `extent_location`, `extended_attribute_length`, `file_flags`,
 * `recording_date`, `file_unit_size` and `interleave_gap_size` are observed in
 * the member's first record. `index`, `extent_count`, `extent_layout`,
 * `hidden` and `associated` are derived.
 */
export const iso9660EntryMetadataSchema = z.strictObject({
  kind: z.literal("iso9660-entry"),
  index: uint32,
  identifier: z.string(),
  extent_location: uint32,
  extended_attribute_length: uint32,
  extent_count: uint32,
  extent_layout: z.enum(["contiguous", "fragmented", "interleaved"]),
  file_flags: uint32,
  hidden: z.boolean(),
  associated: z.boolean(),
  recording_date: z.string().nullable(),
  file_unit_size: uint32,
  interleave_gap_size: uint32,
});
export type Iso9660EntryMetadata = z.infer<typeof iso9660EntryMetadataSchema>;
