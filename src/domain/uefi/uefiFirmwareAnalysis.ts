import { knownCoverageStatusSchema } from "../coverage.js";
import { z } from "zod";
import { isAbsolute } from "node:path";
import type { JsonValue } from "../jsonValue.js";
import { digestSchema } from "../digests.js";
import { localPathStringSchema } from "../localPath.js";
import { UEFI_FIRMWARE_LIMITS } from "./uefiLimits.js";

const bytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const range = z.strictObject({ offset: bytes, length: bytes.positive() });
const target = {
  path: localPathStringSchema
    .refine(isAbsolute, {
      message:
        "path must be an absolute local firmware image path (for example /tmp/firmware.bin)",
    })
    .describe(
      "Absolute local UEFI firmware image; never executed. Relative paths are rejected.",
    ),
};

/** Canonical display form of a UEFI GUID or the raw parse failure kind. */
export const guidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);

/** FFS file type names; the numeric code is retained alongside every name. */
export const ffsTypeNameSchema = z.enum([
  "raw",
  "freeform",
  "security-core",
  "pei-core",
  "dxe-core",
  "peim",
  "driver",
  "combined-peim-driver",
  "application",
  "smm",
  "firmware-volume-image",
  "combined-smm-dxe",
  "smm-core",
  "mm-standalone",
  "mm-core-standalone",
  "pad",
  "unknown",
]);
/** FFS file state observations after erase-polarity normalization. */
export const ffsStateFlagSchema = z.enum([
  "header-construction",
  "header-valid",
  "data-valid",
  "marked-for-update",
  "deleted",
  "header-invalid",
]);
/** Declared FFS integrity observations; mismatches are observations, not verdicts. */
export const ffsChecksumVerdictSchema = z.enum([
  "valid",
  "invalid",
  "pad-file-unchecked",
  "unchecked",
]);
/** FFS file types that carry sections in FFS2 layout. */
export const sectionedFfsTypeNameSchema = ffsTypeNameSchema.exclude([
  "raw",
  "freeform",
]);
const alignmentSchema = z.enum([
  "1",
  "16",
  "128",
  "512",
  "1024",
  "4096",
  "32768",
  "65536",
  "131072",
  "262144",
  "524288",
  "1048576",
  "2097152",
  "4194304",
  "8388608",
  "16777216",
]);

/** Section type names retained alongside their numeric codes. */
export const uefiSectionTypeNameSchema = z.enum([
  "compression",
  "guid-defined",
  "disposable",
  "pe32",
  "pic",
  "te",
  "dxe-depex",
  "version",
  "user-interface",
  "compatibility16",
  "firmware-volume-image",
  "freeform-subtype-guid",
  "raw",
  "pei-depex",
  "mm-depex",
  "unknown",
]);
/**
 * Compression classification for guided or uncompressed sections; kinds that
 * cannot be decoded are reported as gaps, never silently skipped.
 */
export const uefiCompressionSchema = z.union([
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({
    kind: z.enum([
      "lzma-custom",
      "lzmaf86",
      "ami-zlib",
      "tiano",
      "efi-standard",
      "unknown-compression",
      "crc32-guided",
      "unknown-guid",
    ]),
    guid: guidSchema.nullable(),
    data_offset: bytes,
    attributes: bytes.nullable(),
  }),
]);

/** null denotes the original image. A decoded stream is identified by its carrier. */
const sourceStream = z.string().nullable();

/** One flat FFS section record; sub volumes stay linked by logical path. */
export const uefiSectionRecordSchema = z.strictObject({
  logical_path: z.string(),
  parent_logical_path: z.string(),
  source_stream: sourceStream,
  declared_length: bytes,
  truncated: z.boolean(),
  malformed: z.boolean(),
  offset: bytes,
  header_length: bytes,
  length: bytes,
  type_code: bytes,
  type_name: uefiSectionTypeNameSchema,
  sha256: digestSchema,
  compression: uefiCompressionSchema,
  sub_volumes: z.array(z.string()),
});
/** One flat FFS file record inside its owning volume. */
export const uefiFfsFileRecordSchema = z.strictObject({
  source_stream: sourceStream,
  declared_length: bytes,
  offset: bytes,
  header_length: bytes,
  length: bytes,
  guid: guidSchema,
  type_code: bytes,
  type_name: ffsTypeNameSchema,
  attributes: bytes,
  alignment: alignmentSchema,
  state: bytes,
  state_flags: z.array(ffsStateFlagSchema),
  checksum: ffsChecksumVerdictSchema,
  ui_string: z.string().nullable(),
  logical_path: z.string(),
  volume_offset: bytes,
  sha256: digestSchema,
  sections: z.array(uefiSectionRecordSchema),
});

const firmwareScanLimits = {
  max_depth: z
    .number()
    .int()
    .min(1)
    .max(UEFI_FIRMWARE_LIMITS.maxDepth)
    .default(UEFI_FIRMWARE_LIMITS.defaultMaxDepth)
    .describe(
      "Nesting depth for sections and volumes inside compressed payloads",
    ),
  max_volumes: z
    .number()
    .int()
    .min(1)
    .max(UEFI_FIRMWARE_LIMITS.maxVolumes)
    .default(UEFI_FIRMWARE_LIMITS.defaultMaxVolumes)
    .describe("Maximum firmware volumes mapped before partial coverage"),
  max_files: z
    .number()
    .int()
    .min(1)
    .max(UEFI_FIRMWARE_LIMITS.maxFiles)
    .default(UEFI_FIRMWARE_LIMITS.defaultMaxFiles)
    .describe("Maximum FFS files mapped before partial coverage"),
} as const;

/** Explicit UEFI firmware inspection and extraction intent, engine-independent. */
export const uefiInputSchemas = {
  inspect_uefi_firmware: z.strictObject({
    ...target,
    ...firmwareScanLimits,
  }),
  extract_uefi_firmware: z.strictObject({
    ...target,
    output_directory: localPathStringSchema
      .refine(isAbsolute, {
        message: "output_directory must be an absolute local filesystem path",
      })
      .describe("Absolute, absent output directory; parent must exist"),
    target: z
      .discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("whole-image") }),
        z.strictObject({
          kind: z.literal("volume"),
          offset: bytes,
          source_stream: sourceStream.optional(),
        }),
        z.strictObject({
          kind: z.literal("ffs-file"),
          offset: bytes,
          source_stream: sourceStream.optional(),
        }),
        z.strictObject({
          kind: z.literal("section"),
          offset: bytes,
          source_stream: sourceStream.optional(),
        }),
      ])
      .default({ kind: "whole-image" }),
    ...firmwareScanLimits,
    max_output_bytes: z
      .number()
      .int()
      .min(1)
      .max(UEFI_FIRMWARE_LIMITS.maxOutputBytes)
      .default(UEFI_FIRMWARE_LIMITS.defaultMaxOutputBytes)
      .describe("Maximum total bytes of published files"),
    max_output_files: z
      .number()
      .int()
      .min(1)
      .max(UEFI_FIRMWARE_LIMITS.maxOutputFiles)
      .default(UEFI_FIRMWARE_LIMITS.defaultMaxOutputFiles)
      .describe("Maximum number of published files"),
    include_compressed: z
      .boolean()
      .default(true)
      .describe(
        "Publish recognized-but-undecodable compressed payloads as raw blobs; decoding gaps stay explicit",
      ),
  }),
  inspect_uefi_nvram: z.strictObject({
    ...target,
    max_stores: z
      .number()
      .int()
      .min(1)
      .max(1024)
      .default(64)
      .describe(
        "Maximum AMI NVRAM variable stores reported before coverage turns partial",
      ),
    max_depth: z
      .number()
      .int()
      .min(1)
      .max(4)
      .default(2)
      .describe(
        "Nesting depth for NVAR chains embedded in variable data (StdDefaults holds one nested chain)",
      ),
  }),
} as const;

/** Supported UEFI firmware operations. */
export type UefiOperation = keyof typeof uefiInputSchemas;
/** Correlated, validated UEFI firmware request. */
export type UefiRequest = {
  [Name in UefiOperation]: {
    operation: Name;
    input: z.infer<(typeof uefiInputSchemas)[Name]>;
  };
}[UefiOperation];
/** Validate the operation with its exact input contract. */
export const uefiRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("inspect_uefi_firmware"),
    input: uefiInputSchemas.inspect_uefi_firmware,
  }),
  z.strictObject({
    operation: z.literal("extract_uefi_firmware"),
    input: uefiInputSchemas.extract_uefi_firmware,
  }),
  z.strictObject({
    operation: z.literal("inspect_uefi_nvram"),
    input: uefiInputSchemas.inspect_uefi_nvram,
  }),
]);

const parserSchema = z.strictObject({
  name: z.literal("rea-uefi"),
  version: z.string(),
});

/** Completed UEFI result retained when cleanup cannot be confirmed. */
export interface UefiPartialObservation {
  readonly kind: "uefi";
  readonly result: JsonValue;
  /** Completed producer data, artifact identity and analysis metadata. */
  readonly provenance?: JsonValue;
}

/** How the flash image entry point was established for cartography. */
const entryBasisSchema = z.enum([
  "fv-at-zero",
  "amd-psp-first",
  "scanned",
  "unknown",
]);

/** One mapped firmware volume with its flat FFS file records. */
export const uefiVolumeRecordSchema = z.strictObject({
  source_stream: sourceStream,
  parent_logical_path: z.string().nullable(),
  logical_path: z.string(),
  offset: bytes,
  length: z.number().int().positive(),
  declared_length: bytes,
  depth: z.number().int().min(0),
  parent_offset: bytes.nullable(),
  sha256: digestSchema,
  file_system_guid: guidSchema.nullable(),
  signature: z.literal("_FVH"),
  header_length: bytes,
  attributes: bytes,
  revision: z.number().int().min(0).max(255),
  ext_header_offset: bytes.nullable(),
  block_map: z.array(z.strictObject({ num_blocks: bytes, length: bytes })),
  ffs_files: z.array(uefiFfsFileRecordSchema),
});
/** One undecoded image region; classification stays an observation. */
export const uefiUnknownRegionSchema = z.strictObject({
  source_stream: sourceStream,
  offset: bytes,
  length: z.number().int().positive(),
  sha256: digestSchema.nullable(),
  classification: z.enum([
    "no-fv-magic",
    "unsupported-file-system",
    "erased-ff",
    "erased-00",
    "sparse",
    "unparsed-table",
    "truncated",
  ]),
  erasure: z.enum(["0xff", "0x00", "none"]),
});
/** One integrity observation; mismatches are recorded, never smoothed away. */
export const uefiIntegrityRecordSchema = z.strictObject({
  kind: z.enum([
    "fv-checksum-mismatch",
    "ffs-header-checksum-mismatch",
    "ffs-file-checksum-mismatch",
    "size-truncation",
    "block-map-truncation",
    "guid-parse-failure",
    "declared-length-overflow",
  ]),
  logical_path: z.string(),
  source_stream: sourceStream,
  range,
  detail: z.string(),
});

/** One AMI NVRAM variable entry; data bytes are referenced, never interpreted. */
export const uefiNvramVariableRecordSchema = z.strictObject({
  offset: bytes,
  name: z.string().nullable(),
  attributes: z.number().int().min(0).max(0xff),
  next: z
    .number()
    .int()
    .min(0)
    .max(0xffffff)
    .describe(
      "Raw record-relative link displacement. 0xffffff marks the end of the link chain.",
    ),
  guid_index: z.number().int().min(0).max(0xff).nullable(),
  guid: guidSchema.nullable(),
  depth: z.number().int().min(0),
  parent_offset: bytes.nullable(),
  data_offset: bytes,
  data_length: bytes,
  data_sha256: digestSchema,
});
/** One top-level AMI NVRAM chain with its flattened nested variables. */
export const uefiNvramStoreRecordSchema = z.strictObject({
  offset: bytes,
  name: z.string().nullable(),
  variables: z.array(uefiNvramVariableRecordSchema),
  trailing_padding: bytes.nullable(),
});

/** Portable results retain observed boundaries, unknowns and integrity notes. */
export const uefiResultSchemas = {
  inspect_uefi_firmware: z.strictObject({
    parser: parserSchema,
    input_size: bytes,
    flash_image: z.strictObject({
      sha256: digestSchema,
      size: bytes,
      entry_basis: entryBasisSchema,
    }),
    firmware_volumes: z.array(uefiVolumeRecordSchema),
    psp_tables: z.array(
      z.strictObject({
        offset: bytes,
        length: bytes,
        table_magic: z.enum(["$PSP", "$PL2", "unknown"]),
        total_entries: bytes.nullable(),
        entries: z.array(
          z.strictObject({
            type: bytes.nullable(),
            declared_location: bytes.nullable(),
            declared_location_raw: z.string(),
            address_mode: z.number().int().min(0).max(3),
            declared_size: bytes.nullable(),
            image_offset: bytes.nullable(),
            sha256: digestSchema.nullable(),
            location_basis: z.literal("declared-unverified"),
          }),
        ),
        entry_stride_basis: z.enum(["header-declared", "psp-16", "unknown"]),
      }),
    ),
    psp_candidates: z.array(
      z.strictObject({
        offset: bytes,
        magic: z.string(),
        reason: z.string(),
      }),
    ),
    unknown_regions: z.array(uefiUnknownRegionSchema),
    integrity: z.array(uefiIntegrityRecordSchema),
    coverage: knownCoverageStatusSchema,
    limitations: z.array(z.string()),
  }),
  extract_uefi_firmware: z.strictObject({
    parser: parserSchema,
    selection: z.strictObject({
      offset: bytes,
      length: bytes,
      source_stream: sourceStream,
      target_kind: z.enum(["whole-image", "volume", "ffs-file", "section"]),
    }),
    output_directory: z.string(),
    coverage: knownCoverageStatusSchema,
    files: z.array(
      z.strictObject({
        relative_path: z.string(),
        path: z.string(),
        size: bytes,
        sha256: digestSchema,
        original_file_range: range.nullable(),
        source_stream: sourceStream,
        source_range: range,
        runtime_address: z.null(),
        media_type: z.string().nullable(),
        source: z.enum([
          "raw-section",
          "decompressed-lzma",
          "decompressed-lzmaf86",
          "decompressed-zlib",
          "uncompressed-payload",
          "compressed-passthrough",
        ]),
        parent_logical_path: z.string().nullable(),
      }),
    ),
    derivations: z.array(
      z.strictObject({
        parent_path: z.string(),
        child_path: z.string().nullable(),
        child_stream: z.string(),
        parent_file_range: range.nullable(),
        parent_stream: sourceStream,
        parent_stream_range: range,
        handler: z.string(),
      }),
    ),
    extraction_gaps: z.array(
      z.strictObject({
        kind: z.enum([
          "unsupported-compression",
          "unknown-guid-handler",
          "depth-limited",
          "unparsed-region",
          "size-truncated",
          "pad-file",
        ]),
        logical_path: z.string(),
        source_stream: sourceStream,
        range: range.nullable(),
        detail: z.string(),
      }),
    ),
    diagnostics: z.string(),
    published_bytes: bytes,
  }),
  inspect_uefi_nvram: z.strictObject({
    parser: parserSchema,
    input_size: bytes,
    image_sha256: digestSchema,
    stores: z.array(uefiNvramStoreRecordSchema),
    coverage: knownCoverageStatusSchema,
    limitations: z.array(z.string()),
  }),
} as const;

/** Inferred record and result types shared by the engine, provider and contracts. */
export type UefiVolumeRecord = z.infer<typeof uefiVolumeRecordSchema>;
export type UefiFfsFileRecord = z.infer<typeof uefiFfsFileRecordSchema>;
export type UefiSectionRecord = z.infer<typeof uefiSectionRecordSchema>;
export type UefiUnknownRegion = z.infer<typeof uefiUnknownRegionSchema>;
export type UefiIntegrityRecord = z.infer<typeof uefiIntegrityRecordSchema>;
export type UefiInspectResult = z.infer<
  (typeof uefiResultSchemas)["inspect_uefi_firmware"]
>;
export type UefiExtractResult = z.infer<
  (typeof uefiResultSchemas)["extract_uefi_firmware"]
>;
export type UefiNvramVariableRecord = z.infer<
  typeof uefiNvramVariableRecordSchema
>;
export type UefiNvramStoreRecord = z.infer<typeof uefiNvramStoreRecordSchema>;
export type UefiNvramInspectResult = z.infer<
  (typeof uefiResultSchemas)["inspect_uefi_nvram"]
>;
