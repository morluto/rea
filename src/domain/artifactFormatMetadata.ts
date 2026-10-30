import { z } from "zod";

const offset = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const uint32 = z.number().int().min(0).max(0xffff_ffff);

/** Parsed source fields owned by the PCK adapter, independent of content hashes. */
export const godotPckMetadataSchema = z.strictObject({
  kind: z.literal("godot-pck"),
  format_version: uint32,
  engine_major: uint32,
  engine_minor: uint32,
  engine_patch: uint32,
  pack_start: offset,
  pack_end: offset,
  embedded: z.boolean(),
  pack_flags: uint32,
  file_base: offset,
  directory_start: offset,
  declared_file_count: uint32,
  directory_status: z.enum(["available", "encrypted", "sparse-bundle"]),
});
export type GodotPckMetadata = z.infer<typeof godotPckMetadataSchema>;

export const godotPckEntryMetadataSchema = z.strictObject({
  kind: z.literal("godot-pck-entry"),
  index: uint32,
  source_path: z.string(),
  declared_offset: offset,
  flags: uint32,
  md5_status: z.enum(["declared", "all-zero"]),
});

/** Parsed source fields owned by the UnityFS adapter, independent of member bytes. */
export const unityFsMetadataSchema = z.strictObject({
  kind: z.literal("unityfs"),
  signature: z.string(),
  format_version: uint32,
  player_version: z.string(),
  engine_version: z.string(),
  declared_size: offset,
  flags: uint32,
  blocks_info_compressed_size: uint32,
  blocks_info_uncompressed_size: uint32,
  blocks_info_at_end: z.boolean(),
  data_start: offset.nullable(),
  block_count: uint32.nullable(),
  /** The 16-byte producer hash of the uncompressed block stream, as declared. */
  data_hash: z.string().nullable(),
  directory_status: z.enum([
    "available",
    "encrypted",
    "unsupported-compression",
    "unsupported-layout",
  ]),
});
export type UnityFsMetadata = z.infer<typeof unityFsMetadataSchema>;

export const unityFsEntryMetadataSchema = z.strictObject({
  kind: z.literal("unityfs-entry"),
  index: uint32,
  source_path: z.string(),
  declared_offset: offset,
  flags: uint32,
});

/** Source cookie fields and derived directory counts without Python execution. */
export const pyInstallerMetadataSchema = z.strictObject({
  kind: z.literal("pyinstaller"),
  layout_version: z.enum(["2.0", "2.1"]),
  archive_start: offset,
  archive_size: offset,
  cookie_offset: offset,
  toc_offset: offset,
  toc_size: offset,
  entry_count: offset,
  runtime_option_count: offset,
  external_dependency_count: offset,
  python_version_raw: uint32,
  python_major: uint32.nullable(),
  python_minor: uint32.nullable(),
  python_library: z.string().nullable(),
  encryption_marker_present: z.boolean(),
});
export type PyInstallerMetadata = z.infer<typeof pyInstallerMetadataSchema>;

/** Primitive facts preserve source spelling and keep metadata copies independent. */
export const pyInstallerEntryMetadataSchema = z.strictObject({
  kind: z.literal("pyinstaller-entry"),
  container: z.enum(["carchive", "pyz"]),
  container_name: z.string().nullable(),
  index: offset,
  source_name: z.string(),
  type_code: z.union([z.string().length(1), uint32]),
  relative_offset: offset,
  directory_record_offset: offset.nullable(),
  directory_record_size: offset.nullable(),
  compression_flag: z.union([z.literal(0), z.literal(1)]),
  bytecode_header: z.enum(["not-bytecode", "unknown", "derived"]),
  bytecode_magic: z
    .string()
    .regex(/^[0-9a-f]{8}$/u)
    .nullable(),
  pyz_status: z.enum(["not-pyz", "decoded", "opaque"]),
  pyz_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .nullable(),
  pyz_python_magic: z
    .string()
    .regex(/^[0-9a-f]{8}$/u)
    .nullable(),
  pyz_python_version: z.string().nullable(),
  pyz_entry_count: offset.nullable(),
  encryption_source: z.literal("carchive-marker").nullable(),
  dependency_status: z
    .enum(["unresolved", "invalid-reference"])
    .exactOptional(),
  dependency_archive: z.string().nullable().exactOptional(),
  dependency_member: z.string().nullable().exactOptional(),
});
export type PyInstallerEntryMetadata = z.infer<
  typeof pyInstallerEntryMetadataSchema
>;

/** Ordinary .NET bundle manifest facts, not proof of managed assembly validity. */
export const dotnetBundleEntryMetadataSchema = z.strictObject({
  kind: z.literal("dotnet-bundle-entry"),
  major_version: uint32,
  minor_version: uint32,
  file_type: z.number().int().min(0).max(255),
});

/**
 * Node.js single-executable blob facts. Lengths follow the Node 24 64-bit
 * little-endian `size_t` reader. The fuse sentinel is a separate carrier scan.
 */
export const nodeSeaMetadataSchema = z.strictObject({
  kind: z.literal("node-sea"),
  magic: z.literal(0x143da20),
  flags: uint32,
  disable_experimental_sea_warning: z.boolean(),
  use_snapshot: z.boolean(),
  use_code_cache: z.boolean(),
  include_assets: z.boolean(),
  include_exec_argv: z.boolean(),
  exec_argv_extension: z.enum(["none", "env", "cli"]),
  exec_argv: z.array(z.string()),
  code_path: z.string(),
  carrier: z.enum(["mach-o", "elf", "pe"]),
  blob_offset: offset,
  blob_length: offset,
  fuse_state: z.enum(["set", "unset", "absent", "conflicting"]),
  fuse_sentinel: z.string().nullable(),
  fuse_contradiction: z.string().nullable(),
});
export type NodeSeaMetadata = z.infer<typeof nodeSeaMetadataSchema>;

/** One injected script, snapshot, code cache, or asset. Bytes stay opaque. */
export const nodeSeaEntryMetadataSchema = z.strictObject({
  kind: z.literal("node-sea-entry"),
  role: z.enum(["main-script", "snapshot", "code-cache", "asset"]),
  source_path: z.string(),
  index: uint32,
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
/** Payload interpretation and sharing declarations, independent of FIT placement. */
export const fitImageDeclaration = (metadata: FitImageMetadata) => ({
  type: metadata.type,
  arch: metadata.arch,
  os: metadata.os,
  compression: metadata.compression,
  load: metadata.load,
  entry: metadata.entry,
  image_data: metadata.image_data,
  cipher_present: metadata.cipher_present,
  cipher_algo: metadata.cipher_algo,
});

/** Runtime member identity, independent of blob layout and directory order. */
export const nodeSeaEntryDeclaration = (
  metadata: z.infer<typeof nodeSeaEntryMetadataSchema>,
) => ({ role: metadata.role, source_path: metadata.source_path });

const uint8 = z.number().int().min(0).max(0xff);
const uint16 = z.number().int().min(0).max(0xffff);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/u);
const byteRange = z.strictObject({ offset, length: offset });

/**
 * `esp_app_desc_t` fields, as ESP-IDF names them; strings stop at NUL. A field
 * the file cuts off is null; `observed_length` says where the descriptor ends.
 */
const espAppDescriptorSchema = z.strictObject({
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
const espBootloaderDescriptorSchema = z.strictObject({
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
  chip: z
    .strictObject({
      target: z.string(),
      isa: z.enum(["xtensa", "riscv"]),
      source: z.string(),
    })
    .nullable(),
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

/**
 * What a segment header declares: where its bytes load and how many there
 * are. Header offsets are layout, and the classification is derived.
 */
export const espImageSegmentDeclaration = (
  metadata: EspImageSegmentMetadata,
) => ({ load_addr: metadata.load_addr, data_len: metadata.data_len });

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

/** Declaration identity that is stable across archive layout changes. */
export const pyInstallerEntryDeclaration = (
  metadata: PyInstallerEntryMetadata,
) => ({
  container: metadata.container,
  container_name: metadata.container_name,
  source_name: metadata.source_name,
  type_code: metadata.type_code,
});

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

const bunHex = z
  .string()
  .regex(/^[0-9a-f]+$/u)
  .nullable();

/**
 * Container facts for one Bun standalone module graph. `flags` stays the raw
 * u32 because Bun 1.3 and 1.4 reuse the low bits for different meanings.
 */
export const bunStandaloneMetadataSchema = z.strictObject({
  kind: z.literal("bun-standalone"),
  layout_revision: z.enum(["bun-1.3.3", "bun-1.3.9"]),
  carrier: z.enum([
    "mach-o-section",
    "pe-section",
    "elf-section",
    "appended-trailer",
  ]),
  payload_offset: offset,
  payload_length: offset,
  module_count: uint32,
  entry_point_id: uint32,
  entry_point_source_name: z.string().nullable(),
  entry_point_logical_path: z.string().nullable(),
  compile_exec_argv: z.string().nullable(),
  compile_exec_argv_hex: bunHex,
  flags: uint32,
});
export type BunStandaloneMetadata = z.infer<typeof bunStandaloneMetadataSchema>;

/** One stored region of a Bun module. Siblings repeat the module's source facts. */
export const bunStandaloneEntryMetadataSchema = z.strictObject({
  kind: z.literal("bun-standalone-entry"),
  index: uint32,
  region: z.enum(["contents", "sourcemap", "bytecode", "module-info"]),
  source_name: z.string().nullable(),
  source_name_hex: bunHex,
  encoding: uint32,
  encoding_name: z.enum(["binary", "latin1", "utf8", "utf16"]).nullable(),
  loader: uint32,
  loader_name: z.string().nullable(),
  module_format: uint32,
  module_format_name: z.enum(["none", "esm", "cjs"]).nullable(),
  side: uint32,
  side_name: z.enum(["server", "client"]).nullable(),
  entry_point: z.boolean(),
  sourcemap_bytes: offset,
  bytecode_bytes: offset,
  module_info_bytes: offset,
  bytecode_origin: z.string().nullable(),
  bytecode_origin_hex: bunHex,
});
export type BunStandaloneEntryMetadata = z.infer<
  typeof bunStandaloneEntryMetadataSchema
>;

export const artifactFormatMetadataSchema = z.discriminatedUnion("kind", [
  godotPckMetadataSchema,
  godotPckEntryMetadataSchema,
  unityFsMetadataSchema,
  unityFsEntryMetadataSchema,
  pyInstallerMetadataSchema,
  pyInstallerEntryMetadataSchema,
  dotnetBundleEntryMetadataSchema,
  bunStandaloneMetadataSchema,
  bunStandaloneEntryMetadataSchema,
  nodeSeaMetadataSchema,
  nodeSeaEntryMetadataSchema,
  hexRecordsMetadataSchema,
  hexRecordRegionMetadataSchema,
  uImageMetadataSchema,
  uImageEntryMetadataSchema,
  espImageMetadataSchema,
  espImageSegmentMetadataSchema,
  espImageSignatureBlockMetadataSchema,
  fitMetadataSchema,
  fitImageMetadataSchema,
]);
export type ArtifactFormatMetadata = z.infer<
  typeof artifactFormatMetadataSchema
>;
