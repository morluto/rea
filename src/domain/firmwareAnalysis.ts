import { z } from "zod";
import { digestSchema } from "./digests.js";
import { jsonValueSchema } from "./jsonValue.js";

const bytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const range = z.strictObject({ offset: bytes, length: bytes.positive() });
const target = {
  path: z.string().min(1).describe("Local firmware file; never executed"),
};

/** Explicit firmware inspection and extraction intent, independent of engines. */
export const firmwareInputSchemas = {
  inspect_firmware_regions: z.strictObject(target),
  extract_firmware: z.strictObject({
    ...target,
    output_directory: z
      .string()
      .min(1)
      .describe("Absolute, absent output directory; parent must exist"),
    range: range
      .optional()
      .describe("Explicit file-byte interval; omit to extract the whole file"),
    max_depth: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(3)
      .describe("Extraction depth; reaching it yields partial analysis"),
    max_output_bytes: z
      .number()
      .int()
      .min(1)
      .max(512 * 1024 * 1024)
      .default(256 * 1024 * 1024)
      .describe(
        "Staging file-byte budget, checked during extraction; transient overshoot is possible",
      ),
    max_output_files: z
      .number()
      .int()
      .min(1)
      .max(100_000)
      .default(10_000)
      .describe("Staging entry budget, including directories and links"),
  }),
} as const;

/** Supported firmware operations. */
export type FirmwareOperation = keyof typeof firmwareInputSchemas;
/** Correlated, validated firmware request. */
export type FirmwareRequest = {
  [Name in FirmwareOperation]: {
    operation: Name;
    input: z.infer<(typeof firmwareInputSchemas)[Name]>;
  };
}[FirmwareOperation];
/** Validate the operation with its exact input contract. */
export const firmwareRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("inspect_firmware_regions"),
    input: firmwareInputSchemas.inspect_firmware_regions,
  }),
  z.strictObject({
    operation: z.literal("extract_firmware"),
    input: firmwareInputSchemas.extract_firmware,
  }),
]);

const engine = z.strictObject({
  name: z.string(),
  version: z.string(),
  executable_path: z.string(),
  executable_sha256: digestSchema,
  source_revision: z.null(),
  worker_count: z.literal(1),
});
const selection = z.strictObject({ ...range.shape, sha256: digestSchema });
const chunk = z.strictObject({
  input_path: z.string(),
  provider_id: z.string(),
  range,
  handler: z.string().nullable(),
  encrypted: z.boolean().nullable(),
  root_file_range: range.nullable(),
});

/** Portable results retain reported boundaries, unknowns and extraction lineage. */
export const firmwareResultSchemas = {
  inspect_firmware_regions: z.strictObject({
    engine,
    input_size: bytes,
    regions: z.array(
      z.strictObject({
        provider_id: z.string(),
        offset: bytes,
        reported_size: bytes,
        signature: z.string(),
        description: z.string(),
        reported_confidence: z.number().int().min(0).max(255),
        size_basis: z.literal("provider_reported_validation_unknown"),
      }),
    ),
    coverage: z.literal("signature_scan"),
  }),
  extract_firmware: z.strictObject({
    engine,
    selection,
    output_directory: z.string(),
    coverage: z.enum(["complete", "partial"]),
    files: z.array(
      z.strictObject({
        relative_path: z.string(),
        path: z.string(),
        size: bytes,
        sha256: digestSchema,
        reported_sha256: digestSchema.nullable(),
        mime_type: z.string().nullable(),
        analysis_depth: bytes.nullable(),
        runtime_address: z.null(),
        original_file_range: z.null(),
      }),
    ),
    unpublished_entries: z.array(
      z.strictObject({
        relative_path: z.string(),
        kind: z.enum(["symlink", "special"]),
        link_target: z.string().nullable(),
      }),
    ),
    chunks: z.array(chunk),
    derivations: z.array(
      z.strictObject({
        parent_path: z.string(),
        child_path: z.string(),
        provider_blob_id: z.string(),
        handler: z.string().nullable(),
        parent_file_range: range.nullable(),
      }),
    ),
    depth_limited_paths: z.array(z.string()),
    diagnostics: z.array(jsonValueSchema),
    published_bytes: bytes,
  }),
} as const;
