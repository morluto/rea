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

/** Declaration identity that is stable across archive layout changes. */
export const pyInstallerEntryDeclaration = (
  metadata: PyInstallerEntryMetadata,
) => ({
  container: metadata.container,
  container_name: metadata.container_name,
  source_name: metadata.source_name,
  type_code: metadata.type_code,
});

export const artifactFormatMetadataSchema = z.discriminatedUnion("kind", [
  godotPckMetadataSchema,
  godotPckEntryMetadataSchema,
  pyInstallerMetadataSchema,
  pyInstallerEntryMetadataSchema,
  nodeSeaMetadataSchema,
  nodeSeaEntryMetadataSchema,
]);
export type ArtifactFormatMetadata = z.infer<
  typeof artifactFormatMetadataSchema
>;
