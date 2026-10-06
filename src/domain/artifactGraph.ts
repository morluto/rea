import { z } from "zod";
import { prefixedDigestSchema } from "./../domain/digests.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const artifactIdSchema = prefixedDigestSchema("art");
const occurrenceIdSchema = prefixedDigestSchema("occ");
const edgeIdSchema = prefixedDigestSchema("edge");
const manifestIdSchema = prefixedDigestSchema("agm");
const extractionIdSchema = prefixedDigestSchema("aex");
const contradictionIdSchema = prefixedDigestSchema("ic");
const boundedRelativePathSchema = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      path.split("/").every((part) => part !== "" && part !== ".."),
    "Expected a normalized relative POSIX path without traversal",
  );

/** Closed artifact categories used to traverse application containers. */
const artifactKindSchema = z.enum([
  "container",
  "executable",
  "dynamic-library",
  "framework",
  "native-addon",
  "javascript",
  "source-map",
  "plist",
  "entitlements",
  "resource",
  "universal-slice",
  "package-metadata",
  "unknown",
]);

/** Recognized storage or application formats; unknown bytes remain explicit. */
const artifactFormatSchema = z.enum([
  "dmg",
  "zip",
  "pkg",
  "asar",
  "javascript-bundle",
  "source-map",
  "mach-o-universal",
  "mach-o",
  "elf",
  "pe",
  "dos-mz",
  "dos-com",
  "hopper",
  "analysis-database",
  "ipa",
  "apk",
  "msix",
  "appx",
  "plist",
  "entitlements",
  "directory",
  "file",
  "unknown",
]);

/** File byte interval for an artifact derived without writing it to disk. */
const artifactByteRangeSchema = z.object({
  offset: z.number().int().min(0),
  length: z.number().int().min(0),
});

/** External command provenance, including observable side effects. */
const artifactCommandSchema = z.object({
  tool: z.string().min(1),
  arguments: z.array(z.string()),
  tool_version: z.string().nullable(),
  executable_sha256: sha256Schema.nullable(),
  exit_code: z.number().int().nullable(),
  effects: z.array(z.enum(["read", "write", "mount"])),
});

/** Parsed artifact-producing command provenance. */
export type ArtifactCommand = z.infer<typeof artifactCommandSchema>;

/** One content-addressed application artifact in deterministic manifest order. */
const artifactNodeSchema = z.object({
  artifact_id: artifactIdSchema,
  kind: artifactKindSchema,
  format: artifactFormatSchema,
  sha256: sha256Schema,
  size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  media_type: z.string().min(1).nullable(),
  architecture: z.string().min(1).nullable(),
  executable: z.boolean(),
  content_state: z.enum(["materialized", "embedded", "virtual"]),
  limitations: z.array(z.string()),
});

/** One path or virtual location where an artifact occurs in its parent. */
const artifactOccurrenceSchema = z.object({
  occurrence_id: occurrenceIdSchema,
  artifact_id: artifactIdSchema.nullable(),
  parent_occurrence_id: occurrenceIdSchema.nullable(),
  logical_path: boundedRelativePathSchema,
  entry_kind: z.enum(["file", "directory", "symlink", "slice"]),
  declared_size: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .nullable(),
  compressed_size: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .nullable(),
  executable: z.boolean(),
  encrypted: z.boolean(),
  hash_status: z.enum(["verified", "mismatched", "not-hashed", "unavailable"]),
  source_location: artifactByteRangeSchema.nullable(),
  limitations: z.array(z.string()),
});

/** Observed bytes that contradict a container's declared integrity identity. */
const integrityContradictionSchema = z.object({
  contradiction_id: contradictionIdSchema,
  occurrence_id: occurrenceIdSchema,
  parent_artifact_id: artifactIdSchema,
  logical_path: boundedRelativePathSchema,
  declared_sha256: sha256Schema,
  observed_sha256: sha256Schema,
  entry_kind: z.enum(["file", "slice"]),
  unpacked: z.boolean(),
  trust: z.literal("observed-untrusted"),
  provenance: z.literal("container-integrity-metadata-versus-observed-bytes"),
  limitations: z.array(z.string()).min(1),
});

/** Parent-child derivation relation between two content-addressed artifacts. */
const artifactEdgeSchema = z.object({
  edge_id: edgeIdSchema,
  ordinal: z.number().int().min(0),
  parent_artifact_id: artifactIdSchema,
  child_artifact_id: artifactIdSchema,
  relation: z.enum([
    "contains",
    "extracts",
    "slice-of",
    "embeds",
    "loads",
    "maps-source",
    "derived-from",
  ]),
  occurrence_id: occurrenceIdSchema,
  logical_path: boundedRelativePathSchema.nullable(),
  producer: artifactCommandSchema.nullable(),
});

/** Stable cryptographic commitment and counts for a complete artifact graph. */
const artifactGraphManifestSchema = z.object({
  manifest_id: manifestIdSchema,
  root_artifact_id: artifactIdSchema,
  root_sha256: sha256Schema,
  root_format: artifactFormatSchema,
  graph_sha256: sha256Schema,
  node_count: z.number().int().min(1),
  occurrence_count: z.number().int().min(1),
  edge_count: z.number().int().min(0),
});

/** Complete inventory observation containing the stable artifact graph. */
export const artifactInventoryResultSchema = z.object({
  manifest: artifactGraphManifestSchema,
  nodes: z.array(artifactNodeSchema),
  occurrences: z.array(artifactOccurrenceSchema),
  edges: z.array(artifactEdgeSchema),
  provenance: z.array(artifactCommandSchema),
  integrity_contradictions: z.array(integrityContradictionSchema).default([]),
  limitations: z.array(z.string()),
});

/** One safely materialized artifact beneath caller-approved output root. */
const extractedArtifactSchema = z.object({
  artifact_id: artifactIdSchema,
  relative_path: boundedRelativePathSchema,
  sha256: sha256Schema,
  bytes_written: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  created: z.boolean(),
});

/** Path-independent commitment to one selected extraction operation. */
const artifactExtractionManifestSchema = z.object({
  extraction_id: extractionIdSchema,
  source_manifest_id: manifestIdSchema,
  selected_occurrence_ids: z.array(occurrenceIdSchema).min(1),
  files_sha256: sha256Schema,
  output_root_alias: z.literal("$OUTPUT_ROOT"),
});

/** Safe extraction observation with containment and cleanup verification. */
export const artifactExtractionResultSchema = z.object({
  manifest: artifactGraphManifestSchema,
  extraction_manifest: artifactExtractionManifestSchema,
  output_root: z.string().min(1),
  artifacts: z.array(extractedArtifactSchema),
  containment_verified: z.boolean(),
  cleanup: z.object({
    attempted: z.boolean(),
    verified: z.boolean(),
    residual_paths: z.array(boundedRelativePathSchema),
  }),
  provenance: z.array(artifactCommandSchema),
  limitations: z.array(z.string()),
});

/** Parsed artifact graph node. */
export type ArtifactNode = z.infer<typeof artifactNodeSchema>;

/** Parsed artifact derivation edge. */
export type ArtifactEdge = z.infer<typeof artifactEdgeSchema>;

/** Parsed artifact occurrence. */
export type ArtifactOccurrence = z.infer<typeof artifactOccurrenceSchema>;
export type IntegrityContradiction = z.infer<
  typeof integrityContradictionSchema
>;

/** Parsed deterministic artifact graph manifest. */
export type ArtifactGraphManifest = z.infer<typeof artifactGraphManifestSchema>;

/** Parsed paginated inventory result. */
export type ArtifactInventoryResult = z.infer<
  typeof artifactInventoryResultSchema
>;

/** Parsed paginated extraction result. */
export type ArtifactExtractionResult = z.infer<
  typeof artifactExtractionResultSchema
>;
