import { z } from "zod";
import { jsonRecordSchema } from "../jsonRecord.js";
import { jsonValueSchema } from "../jsonValue.js";
import { offset, uint32 } from "./primitives.js";

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

/** Parsed source fields owned by the wxapkg adapter, independent of member bytes. */
export const wxapkgMetadataSchema = z.strictObject({
  kind: z.literal("wxapkg"),
  info: uint32.nullable(),
  index_length: uint32.nullable(),
  data_length: uint32.nullable(),
  file_count: uint32.nullable(),
  directory_status: z.enum(["available", "encrypted"]),
});
export type WxapkgMetadata = z.infer<typeof wxapkgMetadataSchema>;

export const wxapkgEntryMetadataSchema = z.strictObject({
  kind: z.literal("wxapkg-entry"),
  index: uint32,
  source_path: z.string(),
  declared_offset: offset,
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
 * Node.js single-executable blob facts. Lengths use 64-bit little-endian
 * `size_t`. The fuse sentinel is a separate carrier scan.
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
  main_code_format: z.enum(["commonjs", "module"]).exactOptional(),
  code_path: z.string(),
  carrier: z.enum(["mach-o", "elf", "pe"]),
  blob_offset: offset,
  blob_length: offset,
  fuse_state: z.enum(["set", "unset", "absent", "conflicting"]),
  fuse_sentinel: z.string().nullable(),
  fuse_contradiction: z.string().nullable(),
});
export type NodeSeaMetadata = z.infer<typeof nodeSeaMetadataSchema>;
export type NodeSeaMainCodeFormat = NonNullable<
  NodeSeaMetadata["main_code_format"]
>;

/** One injected script, snapshot, code cache, or asset. Bytes stay opaque. */
export const nodeSeaEntryMetadataSchema = z.strictObject({
  kind: z.literal("node-sea-entry"),
  role: z.enum(["main-script", "snapshot", "code-cache", "asset"]),
  source_path: z.string(),
  index: uint32,
});

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

const denoListingSchema = z.enum(["listed", "unsupported"]);

const denoEnvVarSchema = z.strictObject({
  name: z.string(),
  value: z.string(),
  value_byte_length: offset,
});

/**
 * Container facts for one Deno compile section. The metadata JSON has no Deno
 * version field. Environment-file values and CA bytes are retained as local evidence.
 */
export const denoStandaloneMetadataSchema = z.strictObject({
  kind: z.literal("deno-standalone"),
  carrier: z.enum(["mach-o", "elf", "pe"]),
  embedding: z.enum([
    "mach-o-section",
    "mach-o-intel-trailer",
    "elf-note",
    "pe-resource",
  ]),
  section_offset: offset,
  section_length: offset,
  entrypoint_key: z.string(),
  argv: z.array(z.string()).nullable(),
  v8_flags: z.array(z.string()).nullable(),
  permissions: jsonRecordSchema(jsonValueSchema).nullable(),
  unstable_config: jsonRecordSchema(jsonValueSchema).nullable(),
  app_name: z.string().nullable(),
  self_extracting: z.string().nullable(),
  npm_snapshot_byte_length: offset,
  env_var_count: uint32.nullable(),
  env_vars: z.array(denoEnvVarSchema).nullable(),
  ca_data: z.array(z.number().int().min(0).max(255)).nullable(),
  ca_data_byte_length: offset.nullable(),
  specifier_count: uint32,
  specifier_byte_length: offset,
  specifier_listing: denoListingSchema,
  redirect_count: uint32,
  redirect_byte_length: offset,
  redirect_listing: denoListingSchema,
  remote_module_count: uint32,
  remote_module_byte_length: offset,
  remote_module_listing: denoListingSchema,
  vfs_header_byte_length: offset,
  vfs_file_data_byte_length: offset,
  vfs_listing: denoListingSchema,
  vfs_case_sensitivity: z.enum(["sensitive", "insensitive"]).nullable(),
});
export type DenoStandaloneMetadata = z.infer<
  typeof denoStandaloneMetadataSchema
>;

/** One stored region of a Deno virtual file, symlink, or remote module. */
export const denoStandaloneEntryMetadataSchema = z.strictObject({
  kind: z.literal("deno-standalone-entry"),
  role: z.enum([
    "vfs-file",
    "vfs-transpiled",
    "vfs-cjs-export-analysis",
    "vfs-source-map",
    "vfs-symlink",
    "remote-module",
    "remote-transpiled",
    "remote-source-map",
    "remote-cjs-export-analysis",
  ]),
  index: uint32,
  source_path: z.string().nullable(),
  entry_point: z.boolean(),
  executable: z.boolean(),
  is_valid_utf8: z.boolean().nullable(),
  symlink_dest_parts: z.array(z.string()).nullable(),
  media_type: z.number().int().min(0).max(255).nullable(),
  media_type_name: z.string().nullable(),
});
export type DenoStandaloneEntryMetadata = z.infer<
  typeof denoStandaloneEntryMetadataSchema
>;

/** What the tar walk observed about the archive, independent of member bytes. */
export const tarMetadataSchema = z.strictObject({
  kind: z.literal("tar"),
  /** `gzip` when the tar stream is the RFC 1952 decompression of the file. */
  compression: z.enum(["none", "gzip"]),
  /** Header dialects seen, from each header's magic: POSIX ustar or GNU. */
  dialects: z.array(z.enum(["gnu", "ustar"])),
  pax_headers: offset,
  member_count: offset,
  /** Bytes of the tar stream examined; for gzip, the decompressed bytes. */
  tar_stream_bytes: offset,
  /**
   * `end-marker`: a zero block ended the archive. `eof`: the stream ended at a
   * header boundary without one. `malformed` and `truncated` stopped the walk.
   */
  end_state: z.enum(["end-marker", "eof", "malformed", "truncated"]),
  /** Tar-stream offset of the end marker or of the failure. */
  end_offset: offset,
  trailing_nonzero_bytes: offset,
});
export type TarMetadata = z.infer<typeof tarMetadataSchema>;

/** One tar header's declared fields after pax and GNU long-name records apply. */
export const tarEntryMetadataSchema = z.strictObject({
  kind: z.literal("tar-entry"),
  /** Tar-stream offsets; for gzip, offsets in the decompressed stream. */
  header_offset: offset,
  data_offset: offset,
  typeflag: z.string().length(1),
  /** Permission bits, including set-ID and sticky bits. */
  mode: z.int().min(0).max(0o7777),
  uid: offset.nullable(),
  gid: offset.nullable(),
  /** Seconds since the epoch, negative before 1970; null past a safe integer. */
  mtime: z.int().nullable(),
  uname: z.string().nullable(),
  gname: z.string().nullable(),
  link_name: z.string().nullable(),
});
