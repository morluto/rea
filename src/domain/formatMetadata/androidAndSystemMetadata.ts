import { z } from "zod";
import {
  ntfsFileReferenceSchema,
  ntfsFileNameSchema,
  ntfsAttributeSchema,
  ntfsAttributeIssueSchema,
  ntfsAttributeListResolutionSchema,
} from "../windows/ntfsMftAttributes.js";
import { MFT_INLINE_HEADER_LIMIT } from "../windows/ntfsMft.js";
import { JOURNAL_INLINE_OBJECT_LIMIT } from "../linux/systemdJournal.js";
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

/** systemd journal header and object-table facts. */
export const systemdJournalHeaderSchema = z.strictObject({
  compatible_flags: uint32,
  compatible_flag_names: z.array(z.string()),
  incompatible_flags: uint32,
  incompatible_flag_names: z.array(z.string()),
  state: z.string(),
  file_id: z.string(),
  machine_id: z.string(),
  tail_entry_boot_id: z.string(),
  seqnum_id: z.string(),
  header_size: offset,
  arena_size: offset,
  data_hash_table_offset: offset,
  data_hash_table_size: offset,
  field_hash_table_offset: offset,
  field_hash_table_size: offset,
  tail_object_offset: offset,
  n_objects: offset,
  n_entries: offset,
  tail_entry_seqnum: offset,
  head_entry_seqnum: offset,
  entry_array_offset: offset,
  head_entry_realtime: offset,
  tail_entry_realtime: offset,
  tail_entry_monotonic: offset,
  // Null when the declared header predates the field's introduction.
  n_data: offset.nullable(),
  n_fields: offset.nullable(),
  n_tags: offset.nullable(),
  n_entry_arrays: offset.nullable(),
  data_hash_chain_depth: offset.nullable(),
  field_hash_chain_depth: offset.nullable(),
  tail_entry_array_offset: uint32.nullable(),
  tail_entry_array_n_entries: uint32.nullable(),
  tail_entry_offset: offset.nullable(),
  // Fields whose declared value exceeded 2^53-1 and report that ceiling.
  overflowed_fields: z.array(z.string()),
});

export const systemdJournalObjectHeaderSchema = z.strictObject({
  offset: offset,
  type: z.string(),
  raw_type: uint32,
  flags: uint32,
  flag_names: z.array(z.string()),
  size: offset,
  compressed: z.boolean(),
});

export const systemdJournalMetadataSchema = z.strictObject({
  kind: z.literal("systemd-journal"),
  header: systemdJournalHeaderSchema,
  object_count: offset,
  valid_object_count: offset,
  truncated_object_count: offset,
  unknown_type_object_count: offset,
  object_type_counts: z.array(
    z.strictObject({ type: z.string(), count: offset }),
  ),
  object_headers: z
    .array(systemdJournalObjectHeaderSchema)
    .max(JOURNAL_INLINE_OBJECT_LIMIT),
  omitted_object_headers: offset,
  object_header_start_index: offset,
  next_object_header_index: offset.nullable(),
  trailing_bytes: offset,
});
