import { z } from "zod";
import { constants as bufferConstants } from "node:buffer";

const bytes = z.int().min(1).max(Number.MAX_SAFE_INTEGER);
/** The largest count field any reader group accepts. */
export const MAXIMUM_ARTIFACT_READER_COUNT = 0x7fffffff;

/**
 * `artifact.member_count`: the session default for the member, entry, module
 * and asset count each archive reader admits from one container. An explicit
 * `artifact_limits` field wins for that call; otherwise a runtime override,
 * then the `REA_ARTIFACT_MEMBER_COUNT` launch seed, then this default.
 */
export const ARTIFACT_MEMBER_COUNT_SETTING = "artifact.member_count" as const;
export const DEFAULT_ARTIFACT_MEMBER_COUNT = 100_000;

/** Where the session member count came from. */
export type ArtifactMemberCountSource = "default" | "setting" | "runtime";
export interface ArtifactMemberCount {
  readonly value: number;
  readonly source: ArtifactMemberCountSource;
}
const count = z.int().min(1).max(MAXIMUM_ARTIFACT_READER_COUNT);
const representedBytes = bytes.max(bufferConstants.MAX_STRING_LENGTH);

export const DEFAULT_BUN_READER_LIMITS = {
  payload_bytes: 256 * 1024 * 1024,
  module_count: DEFAULT_ARTIFACT_MEMBER_COUNT,
  representation_bytes: 256 * 1024 * 1024,
  metadata_read_bytes: 256 * 1024 * 1024,
  recognition_table_bytes: 1024 * 1024,
  recognition_load_command_bytes: 16 * 1024 * 1024,
  path_parts: 256,
  path_nodes: 250_000,
};
export const bunReaderLimitsSchema = z.strictObject({
  payload_bytes: bytes,
  module_count: count,
  representation_bytes: representedBytes,
  metadata_read_bytes: bytes,
  recognition_table_bytes: bytes,
  recognition_load_command_bytes: bytes,
  path_parts: count,
  path_nodes: count,
});
export type BunReaderLimits = z.output<typeof bunReaderLimitsSchema>;

export const DEFAULT_DOTNET_BUNDLE_READER_LIMITS = {
  metadata_bytes: 16 * 1024 * 1024,
  entry_count: DEFAULT_ARTIFACT_MEMBER_COUNT,
  string_bytes: 64 * 1024,
  path_parts: 256,
  path_nodes: 250_000,
  member_bytes: 512 * 1024 * 1024,
  expanded_bytes: 2 * 1024 * 1024 * 1024,
};
export const dotnetBundleReaderLimitsSchema = z.strictObject({
  metadata_bytes: bytes,
  entry_count: count,
  string_bytes: representedBytes,
  path_parts: count,
  path_nodes: count,
  member_bytes: bytes,
  expanded_bytes: bytes,
});
export type DotnetBundleReaderLimits = z.output<
  typeof dotnetBundleReaderLimitsSchema
>;

export const DEFAULT_NODE_SEA_READER_LIMITS = {
  blob_bytes: 256 * 1024 * 1024,
  asset_count: DEFAULT_ARTIFACT_MEMBER_COUNT,
  asset_name_bytes: 8 * 1024 * 1024,
  argument_count: 4096,
  argument_bytes: 1024 * 1024,
  recognition_header_count: 4096,
  recognition_load_command_bytes: 8 * 1024 * 1024,
};
export const nodeSeaReaderLimitsSchema = z.strictObject({
  blob_bytes: bytes,
  asset_count: count,
  asset_name_bytes: bytes,
  argument_count: count,
  argument_bytes: bytes,
  recognition_header_count: count,
  recognition_load_command_bytes: bytes,
});
export type NodeSeaReaderLimits = z.output<typeof nodeSeaReaderLimitsSchema>;

export const DEFAULT_GODOT_READER_LIMITS = {
  directory_bytes: 64 * 1024 * 1024,
};
export const godotReaderLimitsSchema = z.strictObject({
  directory_bytes: representedBytes,
});
export type GodotReaderLimits = z.output<typeof godotReaderLimitsSchema>;

export const DEFAULT_ISO9660_READER_LIMITS = {
  descriptor_count: 64,
  directory_depth: 64,
  record_count: 262_144,
  directory_bytes: 64 * 1024 * 1024,
  path_bytes: 64 * 1024 * 1024,
};
export const iso9660ReaderLimitsSchema = z.strictObject({
  descriptor_count: count,
  directory_depth: count,
  record_count: count,
  directory_bytes: bytes,
  path_bytes: bytes,
});
export type Iso9660ReaderLimits = z.output<typeof iso9660ReaderLimitsSchema>;

export const DEFAULT_DENO_READER_LIMITS = {
  metadata_json_bytes: 8 * 1024 * 1024,
  vfs_header_json_bytes: 32 * 1024 * 1024,
  table_records: 100_000,
  specifier_text_bytes: 8 * 1024 * 1024,
  remote_body_bytes: 256 * 1024 * 1024,
  vfs_entries: DEFAULT_ARTIFACT_MEMBER_COUNT,
  vfs_name_units: 32 * 1024 * 1024,
  retained_bytes: 256 * 1024 * 1024,
  path_parts: 256,
  path_nodes: 250_000,
};
export const denoReaderLimitsSchema = z.strictObject({
  metadata_json_bytes: representedBytes,
  vfs_header_json_bytes: representedBytes,
  table_records: count,
  specifier_text_bytes: bytes,
  remote_body_bytes: bytes,
  vfs_entries: count,
  vfs_name_units: count,
  retained_bytes: bytes,
  /**
   * Indexed fallbacks live under a reserved top-level namespace directory
   * (`deno-vfs/<index>`, `deno-remote/<index>`) that keeps them collision-free,
   * so the smallest representable logical path has two parts.
   */
  path_parts: count.min(2),
  path_nodes: count,
});
export type DenoReaderLimits = z.output<typeof denoReaderLimitsSchema>;

export const DEFAULT_WXAPKG_READER_LIMITS = {
  table_bytes: 16 * 1024 * 1024,
  directory_bytes: 64 * 1024 * 1024,
};
export const wxapkgReaderLimitsSchema = z.strictObject({
  table_bytes: bytes,
  directory_bytes: bytes,
});
export type WxapkgReaderLimits = z.output<typeof wxapkgReaderLimitsSchema>;

export const DEFAULT_TAR_READER_LIMITS = {
  extended_header_bytes: 1024 * 1024,
  metadata_bytes: 64 * 1024 * 1024,
};
export const tarReaderLimitsSchema = z.strictObject({
  extended_header_bytes: representedBytes,
  metadata_bytes: bytes,
});
export type TarReaderLimits = z.output<typeof tarReaderLimitsSchema>;

/** Input selections preserve omission; only the producing operation resolves defaults. */
export const artifactReaderLimitsInputSchema = z.strictObject({
  bun: z
    .strictObject({
      payload_bytes: bunReaderLimitsSchema.shape.payload_bytes.exactOptional(),
      module_count: bunReaderLimitsSchema.shape.module_count.exactOptional(),
      representation_bytes:
        bunReaderLimitsSchema.shape.representation_bytes.exactOptional(),
      metadata_read_bytes:
        bunReaderLimitsSchema.shape.metadata_read_bytes.exactOptional(),
      recognition_table_bytes:
        bunReaderLimitsSchema.shape.recognition_table_bytes.exactOptional(),
      recognition_load_command_bytes:
        bunReaderLimitsSchema.shape.recognition_load_command_bytes.exactOptional(),
      path_parts: bunReaderLimitsSchema.shape.path_parts.exactOptional(),
      path_nodes: bunReaderLimitsSchema.shape.path_nodes.exactOptional(),
    })
    .exactOptional()
    .describe(
      `Bun admission; omitted fields use ${JSON.stringify(DEFAULT_BUN_READER_LIMITS)}. Recognition limits precede graph decoding; payload, retained representation and physical metadata-read work are independent.`,
    ),
  dotnet_bundle: z
    .strictObject({
      metadata_bytes:
        dotnetBundleReaderLimitsSchema.shape.metadata_bytes.exactOptional(),
      entry_count:
        dotnetBundleReaderLimitsSchema.shape.entry_count.exactOptional(),
      string_bytes:
        dotnetBundleReaderLimitsSchema.shape.string_bytes.exactOptional(),
      path_parts:
        dotnetBundleReaderLimitsSchema.shape.path_parts.exactOptional(),
      path_nodes:
        dotnetBundleReaderLimitsSchema.shape.path_nodes.exactOptional(),
      member_bytes:
        dotnetBundleReaderLimitsSchema.shape.member_bytes.exactOptional(),
      expanded_bytes:
        dotnetBundleReaderLimitsSchema.shape.expanded_bytes.exactOptional(),
    })
    .exactOptional()
    .describe(
      `.NET bundle admission; omitted fields use ${JSON.stringify(DEFAULT_DOTNET_BUNDLE_READER_LIMITS)}. String bytes apply to paths and bundle IDs; member bytes bound stored and expanded members; expanded bytes bound aggregate work.`,
    ),
  node_sea: z
    .strictObject({
      blob_bytes: nodeSeaReaderLimitsSchema.shape.blob_bytes.exactOptional(),
      asset_count: nodeSeaReaderLimitsSchema.shape.asset_count.exactOptional(),
      asset_name_bytes:
        nodeSeaReaderLimitsSchema.shape.asset_name_bytes.exactOptional(),
      argument_count:
        nodeSeaReaderLimitsSchema.shape.argument_count.exactOptional(),
      argument_bytes:
        nodeSeaReaderLimitsSchema.shape.argument_bytes.exactOptional(),
      recognition_header_count:
        nodeSeaReaderLimitsSchema.shape.recognition_header_count.exactOptional(),
      recognition_load_command_bytes:
        nodeSeaReaderLimitsSchema.shape.recognition_load_command_bytes.exactOptional(),
    })
    .exactOptional()
    .describe(
      `Node SEA admission; omitted fields use ${JSON.stringify(DEFAULT_NODE_SEA_READER_LIMITS)}. Asset-name and argument bytes are aggregate decoded text budgets. Recognition limits apply before blob decoding.`,
    ),
  godot: z
    .strictObject({
      directory_bytes:
        godotReaderLimitsSchema.shape.directory_bytes.exactOptional(),
    })
    .exactOptional()
    .describe(
      `Godot directory representation admission; omitted fields use ${JSON.stringify(DEFAULT_GODOT_READER_LIMITS)}. Applies before path allocation and again to retained metadata.`,
    ),
  iso9660: z
    .strictObject({
      descriptor_count:
        iso9660ReaderLimitsSchema.shape.descriptor_count.exactOptional(),
      directory_depth:
        iso9660ReaderLimitsSchema.shape.directory_depth.exactOptional(),
      record_count:
        iso9660ReaderLimitsSchema.shape.record_count.exactOptional(),
      directory_bytes:
        iso9660ReaderLimitsSchema.shape.directory_bytes.exactOptional(),
      path_bytes: iso9660ReaderLimitsSchema.shape.path_bytes.exactOptional(),
    })
    .exactOptional()
    .describe(
      `ISO 9660 admission; omitted fields use ${JSON.stringify(DEFAULT_ISO9660_READER_LIMITS)}. Descriptor count bounds the volume descriptor set; directory depth, record count, directory bytes and path bytes bound directory-tree traversal.`,
    ),
  deno: z
    .strictObject({
      metadata_json_bytes:
        denoReaderLimitsSchema.shape.metadata_json_bytes.exactOptional(),
      vfs_header_json_bytes:
        denoReaderLimitsSchema.shape.vfs_header_json_bytes.exactOptional(),
      table_records: denoReaderLimitsSchema.shape.table_records.exactOptional(),
      specifier_text_bytes:
        denoReaderLimitsSchema.shape.specifier_text_bytes.exactOptional(),
      remote_body_bytes:
        denoReaderLimitsSchema.shape.remote_body_bytes.exactOptional(),
      vfs_entries: denoReaderLimitsSchema.shape.vfs_entries.exactOptional(),
      vfs_name_units:
        denoReaderLimitsSchema.shape.vfs_name_units.exactOptional(),
      retained_bytes:
        denoReaderLimitsSchema.shape.retained_bytes.exactOptional(),
      path_parts: denoReaderLimitsSchema.shape.path_parts.exactOptional(),
      path_nodes: denoReaderLimitsSchema.shape.path_nodes.exactOptional(),
    })
    .exactOptional()
    .describe(
      `Deno compile admission; omitted fields use ${JSON.stringify(DEFAULT_DENO_READER_LIMITS)}. Table records apply to each specifier, redirect and remote-module table; VFS name units are retained UTF-16 path units; path parts (at least 2, the depth of an indexed fallback path) also select indexed fallback paths.`,
    ),
  wxapkg: z
    .strictObject({
      table_bytes: wxapkgReaderLimitsSchema.shape.table_bytes.exactOptional(),
      directory_bytes:
        wxapkgReaderLimitsSchema.shape.directory_bytes.exactOptional(),
    })
    .exactOptional()
    .describe(
      `wxapkg admission; omitted fields use ${JSON.stringify(DEFAULT_WXAPKG_READER_LIMITS)}. Table bytes bound the member table read; directory bytes bound its retained representation.`,
    ),
  tar: z
    .strictObject({
      extended_header_bytes:
        tarReaderLimitsSchema.shape.extended_header_bytes.exactOptional(),
      metadata_bytes:
        tarReaderLimitsSchema.shape.metadata_bytes.exactOptional(),
    })
    .exactOptional()
    .describe(
      `tar admission; omitted fields use ${JSON.stringify(DEFAULT_TAR_READER_LIMITS)}. Extended-header bytes bound one pax or GNU long-name record; metadata bytes bound retained member metadata.`,
    ),
  expanded_bytes: bytes
    .exactOptional()
    .describe(
      "Aggregate plaintext work for archive-backed readers; omitted retains the encoded-size-derived allowance. Includes repeated readable logical occurrences.",
    ),
});
export type ArtifactReaderLimitsInput = z.output<
  typeof artifactReaderLimitsInputSchema
>;
export const artifactReaderLimitsSchema = z.strictObject({
  bun: bunReaderLimitsSchema,
  dotnet_bundle: dotnetBundleReaderLimitsSchema,
  node_sea: nodeSeaReaderLimitsSchema,
  godot: godotReaderLimitsSchema,
  iso9660: iso9660ReaderLimitsSchema,
  deno: denoReaderLimitsSchema,
  wxapkg: wxapkgReaderLimitsSchema,
  tar: tarReaderLimitsSchema,
  expanded_bytes: bytes.exactOptional(),
});
export type ArtifactReaderLimits = z.output<typeof artifactReaderLimitsSchema>;

/**
 * The per-call fields that `artifact.member_count` backs. Each counts the
 * members one reader admits from a single container.
 */
export const ARTIFACT_MEMBER_COUNT_PARAMETERS = [
  "artifact_limits.bun.module_count",
  "artifact_limits.dotnet_bundle.entry_count",
  "artifact_limits.node_sea.asset_count",
  "artifact_limits.deno.vfs_entries",
] as const satisfies readonly ArtifactReaderLimitParameter[];

export const resolveArtifactReaderLimits = (
  selected?: ArtifactReaderLimitsInput,
  memberCount: number = DEFAULT_ARTIFACT_MEMBER_COUNT,
): ArtifactReaderLimits => ({
  bun: {
    ...DEFAULT_BUN_READER_LIMITS,
    module_count: memberCount,
    ...selected?.bun,
  },
  dotnet_bundle: {
    ...DEFAULT_DOTNET_BUNDLE_READER_LIMITS,
    entry_count: memberCount,
    ...selected?.dotnet_bundle,
  },
  node_sea: {
    ...DEFAULT_NODE_SEA_READER_LIMITS,
    asset_count: memberCount,
    ...selected?.node_sea,
  },
  godot: { ...DEFAULT_GODOT_READER_LIMITS, ...selected?.godot },
  iso9660: { ...DEFAULT_ISO9660_READER_LIMITS, ...selected?.iso9660 },
  deno: {
    ...DEFAULT_DENO_READER_LIMITS,
    vfs_entries: memberCount,
    ...selected?.deno,
  },
  wxapkg: { ...DEFAULT_WXAPKG_READER_LIMITS, ...selected?.wxapkg },
  tar: { ...DEFAULT_TAR_READER_LIMITS, ...selected?.tar },
  ...(selected?.expanded_bytes === undefined
    ? {}
    : { expanded_bytes: selected.expanded_bytes }),
});

/**
 * Whether the caller's own selection set this member-count field; otherwise
 * the session setting supplied it.
 */
export const artifactMemberCountSelected = (
  selected: ArtifactReaderLimitsInput | undefined,
  parameter: (typeof ARTIFACT_MEMBER_COUNT_PARAMETERS)[number],
): boolean => {
  switch (parameter) {
    case "artifact_limits.bun.module_count":
      return selected?.bun?.module_count !== undefined;
    case "artifact_limits.dotnet_bundle.entry_count":
      return selected?.dotnet_bundle?.entry_count !== undefined;
    case "artifact_limits.node_sea.asset_count":
      return selected?.node_sea?.asset_count !== undefined;
    case "artifact_limits.deno.vfs_entries":
      return selected?.deno?.vfs_entries !== undefined;
  }
};

/** Every group's resolved schema; the source of each field's supported range. */
const READER_LIMIT_GROUPS = {
  bun: bunReaderLimitsSchema,
  dotnet_bundle: dotnetBundleReaderLimitsSchema,
  node_sea: nodeSeaReaderLimitsSchema,
  godot: godotReaderLimitsSchema,
  iso9660: iso9660ReaderLimitsSchema,
  deno: denoReaderLimitsSchema,
  wxapkg: wxapkgReaderLimitsSchema,
  tar: tarReaderLimitsSchema,
} as const;
type ReaderLimitGroup = keyof typeof READER_LIMIT_GROUPS;

/** The exact contract field a reader admission names on refusal. */
export type ArtifactReaderLimitParameter =
  | {
      [
        Group in ReaderLimitGroup
      ]: `artifact_limits.${Group}.${keyof z.output<(typeof READER_LIMIT_GROUPS)[Group]> & string}`;
    }[ReaderLimitGroup]
  | "artifact_limits.expanded_bytes";

/** A per-call reader admission, independent of runtime-setting registry membership. */
export interface ArtifactReaderLimitFact {
  readonly parameter: string;
  readonly effective_value: number;
  readonly unit: "bytes" | "count";
  readonly minimum: 1;
  readonly maximum: number;
  readonly required_value?: number | string;
  readonly applies_at: "next_operation";
  readonly agent_editable: true;
  readonly can_increase: boolean;
  readonly update_mode: "parameter";
  readonly pending_restart: false;
}

/**
 * The supported maximum of a reader admission, read from the schema the next
 * call is validated against, so the reported range cannot drift from it.
 */
export const artifactReaderLimitMaximum = (
  parameter: ArtifactReaderLimitParameter,
): number => {
  const [, group, field] = parameter.split(".");
  const schema =
    field === undefined
      ? bytes
      : (
          READER_LIMIT_GROUPS[group as ReaderLimitGroup].shape as Record<
            string,
            typeof bytes
          >
        )[field];
  const maximum = schema?.maxValue;
  if (maximum === undefined || maximum === null || !Number.isFinite(maximum))
    throw new TypeError(`${parameter} names no bounded reader admission`);
  return maximum;
};
