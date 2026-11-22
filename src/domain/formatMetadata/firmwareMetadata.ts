import { z } from "zod";
import { completeOrUnknownCoverageSchema } from "../coverage.js";
import {
  byteRange,
  offset,
  sha256Hex,
  uint8,
  uint16,
  uint32,
} from "./primitives.js";

/**
 * UF2 facts derived from every 512-byte block. Regions hold only valid
 * main-flash payloads; block numbering is grouped by familyID and block count.
 */
export const uf2MetadataSchema = z.strictObject({
  kind: z.literal("uf2"),
  block_count: offset,
  trailing_bytes: offset,
  invalid_block_count: offset,
  flash_block_count: offset,
  not_main_flash_block_count: offset,
  file_container_block_count: offset,
  md5_block_count: offset,
  extension_tag_block_count: offset,
  family_count: offset,
  /** The registry revision REA's region `family_name` values come from. */
  family_name_registry: z.string(),
  numbering_group_count: offset,
  missing_block_count: offset,
  ambiguous_numbering_group_count: offset,
  repeated_block_count: offset,
  out_of_order_block_count: offset,
  block_number_out_of_range_count: offset,
  region_count: offset,
  data_bytes: offset,
  duplicate_bytes: offset,
});
export type Uf2Metadata = z.infer<typeof uf2MetadataSchema>;

/** One family's address-contiguous region; file blocks are zero-based positions. */
export const uf2RegionMetadataSchema = z.strictObject({
  kind: z.literal("uf2-region"),
  family_id: uint32.nullable(),
  /** REA's label for `family_id`, from `family_name_registry`; not file content. */
  family_name: z.string().nullable(),
  start_address: uint32,
  end_address: uint32,
  length: offset,
  block_count: offset,
  first_file_block: offset,
  last_file_block: offset,
});

/** DfuSe prefix and DFU suffix facts; both CRCs use the suffix's stored form. */
export const dfuSeMetadataSchema = z.strictObject({
  kind: z.literal("dfuse"),
  image_size: uint32,
  target_count: uint32,
  element_count: offset,
  empty_element_count: offset,
  overlapping_element_count: offset,
  data_bytes: offset,
  device_version: uint32,
  product_id: uint32,
  vendor_id: uint32,
  suffix_crc: uint32,
  computed_crc: uint32,
});
export type DfuSeMetadata = z.infer<typeof dfuSeMetadataSchema>;

/** One DfuSe element with its target's alternate setting and name. */
export const dfuSeElementMetadataSchema = z.strictObject({
  kind: z.literal("dfuse-element"),
  target_index: uint32,
  alternate_setting: uint32,
  target_name: z.string().nullable(),
  element_index: uint32,
  start_address: uint32,
  end_address: uint32,
  length: offset,
});

/**
 * Intel HEX or Motorola S-record facts derived from every record. Start
 * addresses are declared values, not proven entry points.
 */
export const hexRecordsMetadataSchema = z.strictObject({
  kind: z.literal("hex-records"),
  encoding: z.enum(["intel-hex", "srec"]),
  variant: z
    .enum(["I8HEX", "I16HEX", "I32HEX", "S19", "S28", "S37", "mixed"])
    .nullable(),
  line_count: offset,
  record_count: offset,
  data_record_count: offset,
  data_bytes: offset,
  duplicate_bytes: offset,
  region_count: offset,
  lowest_address: uint32.nullable(),
  highest_address: uint32.nullable(),
  termination: z.enum(["present", "absent"]),
  start_address: uint32.nullable(),
  start_address_record: z.enum(["05", "S7", "S8", "S9"]).nullable(),
  start_segment_cs: uint32.nullable(),
  start_segment_ip: uint32.nullable(),
  header_hex: z
    .string()
    .regex(/^(?:[0-9a-f]{2}){0,252}$/u)
    .nullable(),
  header_text: z.string().nullable(),
  declared_data_record_count: uint32.nullable(),
});
export type HexRecordsMetadata = z.infer<typeof hexRecordsMetadataSchema>;

/** One address-contiguous region; lines span its contributing data records. */
export const hexRecordRegionMetadataSchema = z.strictObject({
  kind: z.literal("hex-record-region"),
  start_address: uint32,
  end_address: uint32,
  length: offset,
  record_count: offset,
  first_line: offset,
  last_line: offset,
});

/**
 * U-Boot FIT root facts. Configuration references are declared names; a
 * reference that names no image is reported as a limitation, not removed.
 */
export const fitMetadataSchema = z.strictObject({
  kind: z.literal("fit"),
  fdt_version: uint32,
  fdt_totalsize: offset,
  external_data_base: offset,
  description: z.string().nullable(),
  timestamp: uint32.nullable(),
  address_cells: uint32.nullable(),
  default_configuration: z.string().nullable(),
  configurations: z.array(
    z.strictObject({
      name: z.string(),
      description: z.string().nullable(),
      kernel: z.array(z.string()),
      firmware: z.array(z.string()),
      fdt: z.array(z.string()),
      ramdisk: z.array(z.string()),
      loadables: z.array(z.string()),
      signature_count: uint32,
      signatures_unreadable: uint32,
      unresolved_reference_count: uint32,
      signature_algorithms: z.array(z.string()),
    }),
  ),
});
export type FitMetadata = z.infer<typeof fitMetadataSchema>;

/**
 * One /images node's facts. Null fields are absent unless unreadable_fields
 * identifies an interpretation failure. Load and entry are declarations;
 * stored bytes may be compressed or ciphered.
 */
export const fitImageMetadataSchema = z.strictObject({
  kind: z.literal("fit-image"),
  index: uint32,
  name: z.string(),
  description: z.string().nullable(),
  type: z.string().nullable(),
  arch: z.string().nullable(),
  os: z.string().nullable(),
  compression: z.string().nullable(),
  load: z.string().nullable(),
  entry: z.string().nullable(),
  data_source: z.enum(["embedded", "data-offset", "data-position"]),
  declared_offset: uint32.nullable(),
  image_data: z.string().nullable(),
  /** Presence is independent of whether the declared algorithm is readable. */
  cipher_present: z.boolean(),
  cipher_algo: z.string().nullable(),
  unreadable_fields: z.array(
    z.enum([
      "description",
      "type",
      "arch",
      "os",
      "compression",
      "load",
      "entry",
      "cipher_algo",
    ]),
  ),
  hash_algorithms: z.array(z.string()),
  hashes_verified: uint32,
  hashes_unverified: uint32,
  signature_count: uint32,
  signatures_unreadable: uint32,
  signature_algorithms: z.array(z.string()),
});
export type FitImageMetadata = z.infer<typeof fitImageMetadataSchema>;

/** Derived from `chip_id` through the cited table. */
const espChipFactsSchema = z.strictObject({
  target: z.string(),
  isa: z.enum(["xtensa", "riscv"]),
  source: z.string(),
});

/**
 * `esp_app_desc_t` fields, as ESP-IDF names them; strings stop at NUL. A field
 * the file cuts off is null; `observed_length` says where the descriptor ends.
 */
export const espAppDescriptorSchema = z.strictObject({
  kind: z.literal("app"),
  offset,
  /** Descriptor bytes the file holds, at most the 256 of `esp_app_desc_t`. */
  observed_length: z.int().min(4).max(256),
  secure_version: uint32.nullable(),
  version: z.string().nullable(),
  project_name: z.string().nullable(),
  time: z.string().nullable(),
  date: z.string().nullable(),
  idf_ver: z.string().nullable(),
  app_elf_sha256: sha256Hex.nullable(),
  min_efuse_blk_rev_full: uint16.nullable(),
  max_efuse_blk_rev_full: uint16.nullable(),
  /**
   * ESP-IDF's value: the MMU page size as a base-2 logarithm (16 is 64 KiB);
   * 0 in images built before ESP-IDF v5.4.
   */
  mmu_page_size: uint8.nullable(),
  /**
   * The byte ESP-IDF v6.1 names `spi_flash_mode`, as stored; REA does not
   * interpret it. Releases that reserve this byte leave it zero.
   */
  spi_flash_mode: uint8.nullable(),
});

/** `esp_bootloader_desc_t` fields, as ESP-IDF names them. */
export const espBootloaderDescriptorSchema = z.strictObject({
  kind: z.literal("bootloader"),
  offset,
  secure_version: uint8,
  version: uint32,
  idf_ver: z.string().nullable(),
  date_time: z.string().nullable(),
});

/**
 * ESP32-family image facts. `header` and the descriptor fields are observed;
 * the descriptor kind, `chip`, the integrity statuses and the trailing-byte
 * ranges are derived.
 */
export const espImageMetadataSchema = z.strictObject({
  kind: z.literal("esp-image"),
  /** `esp_image_header_t` fields, as ESP-IDF names them. */
  header: z.strictObject({
    segment_count: uint8,
    spi_mode: uint8,
    spi_speed: uint8,
    spi_size: uint8,
    entry_addr: uint32,
    wp_pin: uint8,
    spi_pin_drv: z.string().regex(/^[0-9a-f]{6}$/u),
    chip_id: uint16,
    min_chip_rev: uint8,
    min_chip_rev_full: uint16,
    max_chip_rev_full: uint16,
    reserved: z.string().regex(/^[0-9a-f]{8}$/u),
    hash_appended: z.boolean(),
  }),
  /** Derived from `chip_id` through the cited table; null for unknown IDs. */
  chip: espChipFactsSchema.nullable(),
  checksum: z.strictObject({
    offset: offset.nullable(),
    stored: uint8.nullable(),
    computed: uint8.nullable(),
    status: z.enum(["valid", "invalid", "unavailable"]),
  }),
  /** The SHA-256 the header's `hash_appended` adds after the checksum. */
  appended_sha256: z.strictObject({
    offset: offset.nullable(),
    stored: sha256Hex.nullable(),
    computed: sha256Hex.nullable(),
    status: z.enum(["valid", "invalid", "unavailable", "not-appended"]),
  }),
  /** End of the checksum block and any digest; null when truncated before it. */
  image_end: offset.nullable(),
  signature_sector_offset: offset.nullable(),
  /** Bytes after the image that no padding, signature or erased flash describes. */
  undescribed_trailing: z.array(byteRange),
  /** Its kind classifies the image as an app or a bootloader. */
  descriptor: z
    .discriminatedUnion("kind", [
      espAppDescriptorSchema,
      espBootloaderDescriptorSchema,
    ])
    .nullable(),
  /**
   * Set when the file is a flash dump read from a later flash address: this
   * image is not an app, its chip's ROM loads the bootloader from
   * `flash_offset`, and a partition table sits at `table_file_offset`, where
   * that origin puts the default `0x8000`. Reopen the file as
   * `esp-flash-image` with that `flash_offset`. Null otherwise, and in the
   * nested facts of a flash layout.
   */
  flash_dump: z
    .strictObject({ flash_offset: uint32, table_file_offset: offset })
    .nullable(),
});
export type EspImageMetadata = z.infer<typeof espImageMetadataSchema>;

/** One header-declared segment; `data_len` is declared, not available. */
export const espImageSegmentMetadataSchema = z.strictObject({
  kind: z.literal("esp-image-segment"),
  index: uint8,
  load_addr: uint32,
  data_len: uint32,
  header_offset: offset,
  /** ESP-IDF's cold-boot `should_map` and `should_load`; derived. */
  classification: z.enum(["mapped", "loaded", "not-loaded", "unknown"]),
});
export type EspImageSegmentMetadata = z.infer<
  typeof espImageSegmentMetadataSchema
>;

/** One Secure Boot v2 block with its 0xE7 magic and a matching CRC32. */
export const espImageSignatureBlockMetadataSchema = z.strictObject({
  kind: z.literal("esp-image-signature-block"),
  /** Slot in the signature sector, 0 to 2. */
  index: uint8,
  version: uint8,
  scheme: z.enum(["rsa", "ecdsa"]).nullable(),
  /** Third block byte for ECDSA: 0 selects SHA-256, 1 SHA-384. */
  sha_version: uint8.nullable(),
  curve_id: uint8.nullable(),
  digest_algorithm: z.enum(["sha256", "sha384"]).nullable(),
  image_digest: z
    .string()
    .regex(/^(?:[0-9a-f]{64}|[0-9a-f]{96})$/u)
    .nullable(),
  /** Whether `image_digest` equals the digest of the bytes before the sector. */
  image_digest_matches: z.boolean().nullable(),
  /** SHA-256 of the block's public key, the value eFuse key digests hold. */
  public_key_sha256: sha256Hex.nullable(),
  /** REA checks no key, signature or eFuse. */
  signature_status: z.literal("unverified"),
});
export type EspImageSignatureBlockMetadata = z.infer<
  typeof espImageSignatureBlockMetadataSchema
>;

/** One partition table entry as declared, with ESP-IDF's type names. */
export const espFlashPartitionMetadataSchema = z.strictObject({
  kind: z.literal("esp-flash-partition"),
  /** Position among the table's partition entries. */
  index: uint8,
  /** The label up to its first NUL; null when it is not UTF-8. */
  label: z.string().nullable(),
  /** The label's bytes up to its first NUL in hex, when it is not UTF-8. */
  label_hex: z
    .string()
    .regex(/^(?:[0-9a-f]{2}){1,16}$/u)
    .nullable(),
  type: uint8,
  subtype: uint8,
  /** `gen_esp32part.py` names; null for values it does not name. */
  type_name: z.string().nullable(),
  subtype_name: z.string().nullable(),
  flash_address: uint32,
  size: uint32,
  encrypted: z.boolean(),
  readonly: z.boolean(),
  /** Flag bits other than `encrypted` and `readonly`, which ESP-IDF ignores. */
  unknown_flags: uint32,
  /**
   * Observed in the bytes the dump holds, from the partition's start: the
   * first byte that is not 0xFF and just past the last, null when every byte
   * is erased, and how many bytes are not 0xFF. All null for a partition the
   * dump holds none of.
   */
  written_offset: uint32.nullable(),
  written_end: uint32.nullable(),
  written_bytes: uint32.nullable(),
});

/** ESP image facts for a region of a dump; offsets are relative to the region. */
export const espFlashImageFactsSchema = z.strictObject({
  /** An ESP image, erased flash, or bytes that are not one, such as ciphertext. */
  status: z.enum(["esp-image", "erased", "unrecognized"]),
  image: espImageMetadataSchema.nullable(),
  segments: z.array(espImageSegmentMetadataSchema),
  signature_blocks: z.array(espImageSignatureBlockMetadataSchema),
  coverage: completeOrUnknownCoverageSchema.nullable(),
  limitations: z.array(z.string()),
});

const espOtaRecordSchema = z.strictObject({
  index: z.union([z.literal(0), z.literal(1)]),
  ota_seq: uint32,
  seq_label: z.string().regex(/^[0-9a-f]{40}$/u),
  ota_state: uint32,
  state_name: z
    .enum(["new", "pending-verify", "valid", "invalid", "aborted", "undefined"])
    .nullable(),
  crc: uint32,
  /** CRC-32 of `ota_seq` seeded with 0xFFFFFFFF, as the bootloader checks it. */
  crc_matches: z.boolean(),
  valid: z.boolean(),
});

/**
 * An ESP flash dump: where it sits in flash, its bootloader, partition table,
 * partitions and OTA data. Entries are the table's partitions; app and
 * bootloader regions carry their ESP image facts here.
 */
export const espFlashImageMetadataSchema = z.strictObject({
  kind: z.literal("esp-flash-image"),
  /** Flash address of the file's first byte: 0 unless the caller gave one. */
  flash_offset: z.strictObject({
    value: uint32,
    source: z.enum(["default", "caller"]),
  }),
  /** From the bootloader's `chip_id`; null without a located bootloader. */
  chip: espChipFactsSchema.nullable(),
  /**
   * The image at its chip's ROM offset, through the partition table; `path`
   * is its entry.
   */
  bootloader: z
    .strictObject({
      path: z.string(),
      flash_address: uint32,
      region_size: offset,
      facts: espFlashImageFactsSchema,
    })
    .nullable(),
  partition_table: z.strictObject({
    flash_address: uint32,
    /** 0x8000, the caller's offset, or a scan for a verified MD5 (derived). */
    method: z.enum(["default", "caller", "scan"]),
    partition_count: uint8,
    md5: z.strictObject({
      status: z.enum(["valid", "invalid", "absent"]),
      stored: z
        .string()
        .regex(/^[0-9a-f]{32}$/u)
        .nullable(),
      computed: z
        .string()
        .regex(/^[0-9a-f]{32}$/u)
        .nullable(),
      /**
       * Partition entries after the MD5 record, outside its digest. New
       * inventories emit 0 when the record is absent or every partition
       * entry precedes it. Omission is Evidence saved before this field
       * and leaves the count unknown.
       */
      entries_after_checksum: uint8.exactOptional(),
    }),
  }),
  /**
   * Declared partitions that begin before the dump's first byte, which have
   * no entry. A partition past the dump's end is an entry with no bytes.
   */
  partitions_outside_dump: z.array(espFlashPartitionMetadataSchema),
  /** ESP image facts for each app partition the dump holds, by its entry. */
  apps: z.array(
    z.strictObject({
      path: z.string(),
      partition_index: uint8,
      facts: espFlashImageFactsSchema,
    }),
  ),
  /** The otadata partition the bootloader uses: the last one declared. */
  otadata: z
    .strictObject({
      partition_index: uint8,
      /** The records the dump holds, at most one per sector. */
      records: z.array(espOtaRecordSchema).max(2),
    })
    .nullable(),
  /**
   * The app the bootloader would select, derived for every table under the
   * stated assumptions. `basis` names the branch: `otadata`,
   * `factory-fallback` and `ota_0-fallback` from the otadata records,
   * `no-otadata` for a table without otadata (the factory index), `none`
   * for the bootloader's INVALID_INDEX, after which it resets, and
   * `unknown` when the dump lacks a record the bootloader reads.
   * `partition_index` is null when the table declares no partition for the
   * selected slot or fallback.
   */
  boot_selection: z.strictObject({
    basis: z.enum([
      "otadata",
      "factory-fallback",
      "ota_0-fallback",
      "no-otadata",
      "none",
      "unknown",
    ]),
    active_record: z.union([z.literal(0), z.literal(1)]).nullable(),
    slot: uint8.nullable(),
    partition_index: uint8.nullable(),
    assumptions: z.array(z.string()),
    /** Rollback, anti-rollback and load fallback decide it at boot. */
    running_partition: z.literal("unknown"),
  }),
  /**
   * Ranges outside every described region, each from a byte that is not
   * erased flash to the end of its gap.
   */
  undescribed: z.array(byteRange),
});
export type EspFlashImageMetadata = z.infer<typeof espFlashImageMetadataSchema>;

/**
 * U-Boot legacy uImage header facts. Declared addresses are facts from the
 * header, not proven entry points; CRCs are verified before inventory.
 */
export const uImageMetadataSchema = z.strictObject({
  kind: z.literal("uimage"),
  magic: z.literal(0x27051956),
  timestamp: uint32,
  timestamp_iso: z.string(),
  payload_size: uint32,
  load_address: uint32,
  entry_point: uint32,
  header_crc32: uint32,
  data_crc32: uint32,
  crc_verified: z.literal(true),
  os: z.number().int().min(0).max(255),
  os_name: z.string(),
  arch: z.number().int().min(0).max(255),
  arch_name: z.string(),
  type: z.number().int().min(0).max(255),
  type_name: z.string(),
  compression: z.number().int().min(0).max(255),
  compression_name: z.string(),
  name: z.string().nullable(),
  name_bytes_hex: z.string().regex(/^[0-9a-f]{64}$/u),
  sub_image_count: uint32,
});
export type UImageMetadata = z.infer<typeof uImageMetadataSchema>;

/** One stored payload, or one multi-image sub-image, as stored bytes. */
export const uImageEntryMetadataSchema = z.strictObject({
  kind: z.literal("uimage-entry"),
  role: z.enum(["payload", "sub-image"]),
  index: uint32,
});
export type UImageEntryMetadata = z.infer<typeof uImageEntryMetadataSchema>;

/** One UBI volume table record and how its logical eraseblocks map. */
const ubiVolumeFacts = {
  id: z.number().int().min(0).max(127),
  name: z.string(),
  /** The stored name bytes when UTF-8 decoding replaced invalid sequences. */
  name_bytes_hex: z
    .string()
    .regex(/^(?:[0-9a-f]{2}){1,127}$/u)
    .nullable(),
  type: z.enum(["dynamic", "static"]),
  reserved_pebs: uint32,
  alignment: uint32,
  data_pad: uint32,
  update_marker: z.boolean(),
  flags: z.number().int().min(0).max(255),
  autoresize: z.boolean(),
  usable_leb_size: uint32,
  used_ebs: uint32.nullable(),
  mapped_leb_count: uint32,
  stale_leb_copy_count: uint32,
  missing_leb_count: uint32,
  first_missing_leb: uint32.nullable(),
  data_bytes: offset.nullable(),
  extractable: z.boolean(),
};

/**
 * UBI erase-counter header layout, eraseblock counts and the volume table.
 * Header CRCs are verified; LEB data CRCs are not.
 */
export const ubiImageMetadataSchema = z.strictObject({
  kind: z.literal("ubi-image"),
  magic: z.literal("UBI#"),
  version: z.literal(1),
  peb_size: offset,
  leb_size: offset,
  vid_header_offset: uint32,
  data_offset: uint32,
  image_seq: uint32,
  peb_count: uint32,
  mapped_peb_count: uint32,
  free_peb_count: uint32,
  erased_peb_count: uint32,
  corrupt_peb_count: uint32,
  layout_peb_count: uint32,
  stale_leb_copy_count: uint32,
  ignored_leb_count: uint32,
  min_erase_counter: offset.nullable(),
  max_erase_counter: offset.nullable(),
  volume_table_slots: z.number().int().min(0).max(128),
  volume_table_copies_found: z.number().int().min(0).max(2),
  volume_table_copies_valid: z.number().int().min(0).max(2),
  volume_table_copies_agree: z.boolean().nullable(),
  volume_table_source_leb: z.union([z.literal(0), z.literal(1)]),
  data_crc_verified: z.literal(false),
  volumes: z.array(z.strictObject({ ...ubiVolumeFacts, path: z.string() })),
});
export type UbiImageMetadata = z.infer<typeof ubiImageMetadataSchema>;

/** One reassembled volume; its bytes come from many PEBs, not one file range. */
export const ubiVolumeMetadataSchema = z.strictObject({
  kind: z.literal("ubi-volume"),
  ...ubiVolumeFacts,
  /**
   * Where each chosen LEB's data sits in the image, in LEB order, so saved
   * Evidence can cite the PEB bytes behind the volume. Empty when refused.
   */
  source_ranges: z.array(
    z.strictObject({
      lnum: uint32,
      peb: uint32,
      offset,
      length: uint32,
    }),
  ),
});
export type UbiVolumeMetadata = z.infer<typeof ubiVolumeMetadataSchema>;
