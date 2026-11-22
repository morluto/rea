import { z } from "zod";

import { digestSchema } from "../digests.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";
import { coverageStatusSchema } from "../coverage.js";

/** Format identity for typed OCI image-layout parse failures. */
export const OCI_IMAGE_LAYOUT_FORMAT = "oci-image-layout";

const uint = z.number().int().min(0).max(0xffffffff);
/** Declared and observed blob sizes; the hash budget bounds reading, not reporting. */
const byteSize = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/**
 * Cumulative bytes across every JSON document read; the service bounds it by
 * max_json_bytes * (2 + 2 * max_descriptors), which can exceed 32 bits.
 */
const cumulativeByteCount = z.number().int().nonnegative().safe();

/** Hard ceiling on one JSON document (oci-layout, index, manifest, or config). */
export const MAX_INSPECT_OCI_IMAGE_LAYOUT_JSON_BYTES = 16 * 1024 * 1024;
/** Hard ceiling on one hashed blob. */
export const MAX_INSPECT_OCI_IMAGE_LAYOUT_BLOB_BYTES = 512 * 1024 * 1024;
/** Hard ceiling on directory entries examined in one layout. */
export const MAX_INSPECT_OCI_IMAGE_LAYOUT_ENTRIES = 65536;
/** Hard ceiling on decoded index, manifest and layer descriptors in one layout. */
export const MAX_INSPECT_OCI_IMAGE_LAYOUT_DESCRIPTORS = 1048576;
/** Hard ceiling on config bytes expanded into image facts across one layout. */
export const MAX_INSPECT_OCI_IMAGE_LAYOUT_CONFIG_BYTES = 512 * 1024 * 1024;
/** Hard ceiling on descriptor text retained in the report across one layout. */
export const MAX_INSPECT_OCI_IMAGE_LAYOUT_DESCRIPTOR_BYTES = 512 * 1024 * 1024;
/** Hard ceiling on nested index depth. */
export const MAX_INSPECT_OCI_IMAGE_LAYOUT_INDEX_DEPTH = 8;

export const OCI_IMAGE_LAYOUT_LIMIT_MAXIMA = {
  max_json_bytes: MAX_INSPECT_OCI_IMAGE_LAYOUT_JSON_BYTES,
  max_blob_bytes: MAX_INSPECT_OCI_IMAGE_LAYOUT_BLOB_BYTES,
  max_entries: MAX_INSPECT_OCI_IMAGE_LAYOUT_ENTRIES,
  max_descriptors: MAX_INSPECT_OCI_IMAGE_LAYOUT_DESCRIPTORS,
  max_config_bytes: MAX_INSPECT_OCI_IMAGE_LAYOUT_CONFIG_BYTES,
  max_descriptor_bytes: MAX_INSPECT_OCI_IMAGE_LAYOUT_DESCRIPTOR_BYTES,
  max_index_depth: MAX_INSPECT_OCI_IMAGE_LAYOUT_INDEX_DEPTH,
} as const;

/** Descriptor media types this reader inventories without treating as unknown. */
export const OCI_KNOWN_MEDIA_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.oci.image.config.v1+json",
  "application/vnd.oci.image.layer.v1.tar",
  "application/vnd.oci.image.layer.v1.tar+gzip",
  "application/vnd.oci.image.layer.v1.tar+zstd",
  "application/vnd.oci.image.layer.nondistributable.v1.tar",
  "application/vnd.oci.image.layer.nondistributable.v1.tar+gzip",
  "application/vnd.oci.image.layer.nondistributable.v1.tar+zstd",
  "application/vnd.oci.empty.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.docker.container.image.v1+json",
  "application/vnd.docker.image.rootfs.diff.tar",
  "application/vnd.docker.image.rootfs.diff.tar.gzip",
] as const;

const INDEX_MEDIA_TYPES = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);

const MANIFEST_MEDIA_TYPES = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);

const CONFIG_MEDIA_TYPES = new Set([
  "application/vnd.oci.image.config.v1+json",
  "application/vnd.docker.container.image.v1+json",
]);

const KNOWN_MEDIA_TYPES = new Set<string>(OCI_KNOWN_MEDIA_TYPES);

/** Whether a descriptor media type is an image index (possibly nested). */
export const isOciIndexMediaType = (mediaType: string): boolean =>
  INDEX_MEDIA_TYPES.has(mediaType);

/** Whether a descriptor media type is an image manifest. */
export const isOciManifestMediaType = (mediaType: string): boolean =>
  MANIFEST_MEDIA_TYPES.has(mediaType);

/** Whether a descriptor media type is an image config. */
export const isOciConfigMediaType = (mediaType: string): boolean =>
  CONFIG_MEDIA_TYPES.has(mediaType);

/** Whether a descriptor media type is in this reader's known set. */
export const isOciKnownMediaType = (mediaType: string): boolean =>
  KNOWN_MEDIA_TYPES.has(mediaType);

const SHA512_HEX_PATTERN = /^[a-f0-9]{128}$/u;

type OciDigestAlgorithm = "sha256" | "sha512";

/** Parsed descriptor digest, or undefined when the spelling is unsupported. */
export const parseOciDigest = (
  value: string,
):
  | { readonly algorithm: OciDigestAlgorithm; readonly hex: string }
  | undefined => {
  const colon = value.indexOf(":");
  if (colon <= 0) return undefined;
  const algorithm = value.slice(0, colon);
  const hex = value.slice(colon + 1).toLowerCase();
  if (algorithm === "sha256" && digestSchema.safeParse(hex).success)
    return { algorithm, hex };
  if (algorithm === "sha512" && SHA512_HEX_PATTERN.test(hex))
    return { algorithm, hex };
  return undefined;
};

/** Layout-relative blob path for a parsed digest. */
export const ociBlobPath = (
  digest: Readonly<{ algorithm: string; hex: string }>,
): string => `blobs/${digest.algorithm}/${digest.hex}`;

export const OCI_IMAGE_LAYOUT_FINDING_KINDS = [
  "missing_blob",
  "digest_mismatch",
  "size_mismatch",
  "unreferenced_blob",
  "unknown_media_type",
  "unsupported_digest_algorithm",
  "symlink_blob",
  "nested_index_depth_exceeded",
  "malformed_blob_json",
  "blob_oversize",
] as const;

/** Bounded inspection of one OCI image-layout directory. */
export const inspectOciImageLayoutInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute filesystem path to an OCI image-layout directory",
  ),
  include_env_values: z
    .boolean()
    .default(true)
    .describe(
      "Include config Env values (default true); false leaves each value null and keeps only the names",
    ),
  max_json_bytes: z
    .number()
    .int()
    .min(16)
    .max(MAX_INSPECT_OCI_IMAGE_LAYOUT_JSON_BYTES)
    .default(1048576)
    .describe(
      "Maximum bytes to decode for one JSON document (oci-layout, index, manifest, or config; default 1 MiB)",
    ),
  max_blob_bytes: z
    .number()
    .int()
    .min(16)
    .max(MAX_INSPECT_OCI_IMAGE_LAYOUT_BLOB_BYTES)
    .default(67108864)
    .describe("Maximum bytes to hash for one referenced blob (default 64 MiB)"),
  max_entries: z
    .number()
    .int()
    .min(1)
    .max(MAX_INSPECT_OCI_IMAGE_LAYOUT_ENTRIES)
    .default(4096)
    .describe(
      "Maximum directory entries to examine; exceeding the budget fails without partial success",
    ),
  max_descriptors: z
    .number()
    .int()
    .min(1)
    .max(MAX_INSPECT_OCI_IMAGE_LAYOUT_DESCRIPTORS)
    .default(65536)
    .describe(
      "Maximum index, manifest and layer descriptors to decode across the layout, counted per reference so shared layers count once per manifest; exceeding the budget fails without partial success",
    ),
  max_config_bytes: z
    .number()
    .int()
    .min(16)
    .max(MAX_INSPECT_OCI_IMAGE_LAYOUT_CONFIG_BYTES)
    .default(67108864)
    .describe(
      "Maximum serialized bytes of config-derived image facts across the layout, counted once per image so a shared config counts once per manifest that uses it (default 64 MiB); exceeding the budget fails without partial success",
    ),
  max_descriptor_bytes: z
    .number()
    .int()
    .min(16)
    .max(MAX_INSPECT_OCI_IMAGE_LAYOUT_DESCRIPTOR_BYTES)
    .default(67108864)
    .describe(
      "Maximum UTF-8 bytes of descriptor text retained across the layout: index entry digests, media types, platforms and annotations, accepted subject, config and layer digests and media types counted once per referencing manifest or index, and the digest text findings retain for rejected descriptors (default 64 MiB); exceeding the budget fails without partial success",
    ),
  max_index_depth: z
    .number()
    .int()
    .min(1)
    .max(MAX_INSPECT_OCI_IMAGE_LAYOUT_INDEX_DEPTH)
    .default(4)
    .describe(
      "Maximum nested index depth, counting the top-level index.json as depth 0",
    ),
});

const nullableText = z.string().min(1).nullable();

// Annotation and label keys are reported as written; OCI does not forbid an
// empty key, so one must not fail the whole report.
const annotationSchema = z.strictObject({
  name: z.string(),
  value: z.string(),
});

const platformSchema = z.strictObject({
  os: nullableText,
  architecture: nullableText,
  variant: nullableText,
  os_version: nullableText,
});

const descriptorSchema = z.strictObject({
  media_type: z.string().min(1),
  digest: z.string().min(1),
  size: byteSize.nullable(),
  platform: platformSchema.nullable(),
  annotations: z.array(annotationSchema),
});

const envBindingSchema = z.strictObject({
  name: z.string().min(1),
  value: z.string().nullable(),
});

const historyEntrySchema = z.strictObject({
  created: nullableText,
  created_by: z.string().nullable(),
  empty_layer: z.boolean().nullable(),
  comment: z.string().nullable(),
});

const layerSchema = z.strictObject({
  media_type: z.string().min(1),
  digest: z.string().min(1),
  size: byteSize.nullable(),
  present: z.boolean(),
});

const imageSchema = z.strictObject({
  digest: z.string().min(1),
  media_type: z.string().min(1),
  config_digest: z.string().min(1).nullable(),
  architecture: nullableText,
  os: nullableText,
  variant: nullableText,
  created: nullableText,
  author: nullableText,
  user: nullableText,
  env: z.array(envBindingSchema),
  entrypoint: z.array(z.string()).nullable(),
  cmd: z.array(z.string()).nullable(),
  working_dir: nullableText,
  exposed_ports: z.array(z.string().min(1)),
  volumes: z.array(z.string().min(1)),
  labels: z.array(annotationSchema),
  stop_signal: nullableText,
  rootfs_diff_ids: z.array(z.string().min(1)),
  history: z.array(historyEntrySchema),
  layers: z.array(layerSchema),
});

const indexSchema = z.strictObject({
  digest: z.string().min(1),
  media_type: z.string().min(1),
  schema_version: z.number().int().nullable(),
  depth: uint,
  entries: z.array(descriptorSchema),
});

const blobSchema = z.strictObject({
  digest: z.string().min(1),
  path: z.string().min(1),
  media_type: z.string().min(1).nullable(),
  declared_size: byteSize.nullable(),
  observed_size: byteSize.nullable(),
  present: z.boolean(),
  hashed: z.boolean(),
  sha256: digestSchema.nullable(),
  sha512: z.string().regex(SHA512_HEX_PATTERN).nullable(),
  referenced: z
    .boolean()
    .nullable()
    .describe(
      "Whether the reference graph names this blob; null when the graph was not fully examined",
    ),
  kind: z.enum(["file", "symlink", "missing", "other"]),
});

const findingSchema = z.strictObject({
  kind: z.enum(OCI_IMAGE_LAYOUT_FINDING_KINDS),
  digest: z.string().min(1).nullable(),
  path: z.string().min(1).nullable(),
  message: z.string().min(1),
});

/** Observed OCI image-layout inventory; digest mismatches stay findings. */
export const ociImageLayoutSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    format: z.literal("directory"),
    snapshot_sha256: digestSchema,
    layout_version: nullableText,
    oci_layout_digest: digestSchema.nullable(),
    index_digest: digestSchema.nullable(),
  }),
  indexes: z.array(indexSchema),
  images: z.array(imageSchema),
  blobs: z.array(blobSchema),
  findings: z.array(findingSchema),
  coverage: z.strictObject({
    status: coverageStatusSchema,
    entries_examined: uint,
    blobs_hashed: uint,
    json_bytes_read: cumulativeByteCount,
  }),
  limitations: z.array(z.string().min(1)).min(1),
});

export type OciImageLayout = z.infer<typeof ociImageLayoutSchema>;
export type InspectOciImageLayoutInput = z.infer<
  typeof inspectOciImageLayoutInputSchema
>;
export type OciImageLayoutFinding = z.infer<typeof findingSchema>;
export type OciImageLayoutBlob = z.infer<typeof blobSchema>;
export type OciImageLayoutImage = z.infer<typeof imageSchema>;
export type OciImageLayoutIndex = z.infer<typeof indexSchema>;
