import { z } from "zod";
import { constants as bufferConstants } from "node:buffer";

const bytes = z.int().min(1).max(Number.MAX_SAFE_INTEGER);
const count = z.int().min(1).max(0x7fffffff);
const representedBytes = bytes.max(bufferConstants.MAX_STRING_LENGTH);

export const DEFAULT_BUN_READER_LIMITS = {
  payload_bytes: 256 * 1024 * 1024,
  module_count: 100_000,
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
  entry_count: 100_000,
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
  asset_count: 100_000,
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
  expanded_bytes: bytes.exactOptional(),
});
export type ArtifactReaderLimits = z.output<typeof artifactReaderLimitsSchema>;

export const resolveArtifactReaderLimits = (
  selected?: ArtifactReaderLimitsInput,
): ArtifactReaderLimits => ({
  bun: { ...DEFAULT_BUN_READER_LIMITS, ...selected?.bun },
  dotnet_bundle: {
    ...DEFAULT_DOTNET_BUNDLE_READER_LIMITS,
    ...selected?.dotnet_bundle,
  },
  node_sea: { ...DEFAULT_NODE_SEA_READER_LIMITS, ...selected?.node_sea },
  godot: { ...DEFAULT_GODOT_READER_LIMITS, ...selected?.godot },
  ...(selected?.expanded_bytes === undefined
    ? {}
    : { expanded_bytes: selected.expanded_bytes }),
});

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
  readonly rea_restart_required: false;
}

/** Runtime representation ceilings differ from aggregate plaintext-work budgets. */
export const artifactReaderLimitMaximum = (
  parameter: string,
  unit: ArtifactReaderLimitFact["unit"],
): number =>
  unit === "count"
    ? 0x7fffffff
    : [
          "artifact_limits.bun.representation_bytes",
          "artifact_limits.dotnet_bundle.string_bytes",
          "artifact_limits.godot.directory_bytes",
        ].includes(parameter)
      ? bufferConstants.MAX_STRING_LENGTH
      : Number.MAX_SAFE_INTEGER;
