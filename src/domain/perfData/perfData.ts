import { z } from "zod";
import { digestSchema, prefixedDigestSchema } from "../digests.js";
import { localPathStringSchema } from "../localPath.js";

/** Resource allowances, not `perf.data` format limits. */
export const PERF_DATA_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const PERF_DATA_MAX_EVENTS = 20_000;
/**
 * One malformed attribute can consume an arbitrary share of the file, so the
 * count — not the byte allowance — is what bounds the reply.
 */
export const PERF_DATA_MAX_DIAGNOSTICS = 10_000;
export const PERF_DATA_OPERATION = "inspect_perf_data" as const;
export const PERF_DATA_PROVIDER = {
  id: "rea-perf-data",
  name: "REA offline Linux perf recording inventory",
  version: "1",
} as const;

export const perfDataArtifactSchema = z.strictObject({
  path: localPathStringSchema,
  sha256: digestSchema,
  bytes: z.int().nonnegative(),
});
export type PerfDataArtifact = z.output<typeof perfDataArtifactSchema>;

export const perfFileSectionSchema = z.strictObject({
  offset: z.int().nonnegative(),
  size: z.int().nonnegative(),
  /** Whether the declared range lies inside the file. */
  within_file: z.boolean(),
});

/**
 * One event attribute group as its entry states it. Samples, callchains and
 * symbol resolution belong to later steps, so these are the declared sampling
 * settings — not an execution or CPU-time count.
 */
export const perfEventSchema = z.strictObject({
  event_id: prefixedDigestSchema("perf_event"),
  ordinal: z.int().nonnegative(),
  /** Attribute type as the entry states it (`PERF_TYPE_*`). */
  type: z.int().nonnegative(),
  /** `config` value; its meaning depends on `type`; null when it exceeds a safe integer. */
  config: z.int().nonnegative().nullable(),
  /** Declared sample type bitmask; null when the entry is too short. */
  sample_type: z.int().nonnegative().nullable(),
  /** Declared read format bitmask; null when the entry is too short. */
  read_format: z.int().nonnegative().nullable(),
  /** Declared period or frequency; the unit follows `sample_freq`. */
  sample_period: z.int().nonnegative().nullable(),
  /** True when `sample_period` is a frequency in Hz rather than a period. */
  sample_freq: z.boolean().nullable(),
  /** Bytes the attribute itself declares; the entry stride also carries ids. */
  attr_bytes: z.int().nonnegative(),
  /** Where this group's event identifiers are stored, per its entry. */
  ids_section: perfFileSectionSchema.nullable(),
  /** Event identifiers read from `ids_section`, in file order. */
  ids: z.array(z.int().nonnegative()),
  /** The ids extent held more identifiers than the reply budget admitted. */
  ids_truncated: z.boolean(),
  /** Byte offset of the attribute entry inside the file. */
  file_offset: z.int().nonnegative(),
});
export type PerfEvent = z.output<typeof perfEventSchema>;

export const perfDiagnosticSchema = z.strictObject({
  diagnostic_id: prefixedDigestSchema("perf_diagnostic"),
  /** Event ordinal the diagnostic concerns; null for file-wide facts. */
  ordinal: z.int().nullable(),
  code: z.enum([
    "not-a-perf-data-file",
    "truncated-header",
    "invalid-attribute-section",
    "attribute-section-overlap",
    "empty-attribute-section",
    "unsupported-attribute-size",
    "truncated-event-attribute",
    "invalid-ids-section",
    "identifier-inventory-truncated",
    "unsafe-identifier",
    "event-limit-reached",
    "diagnostic-limit-reached",
    "header-attribute-overlap",
    "unsafe-attribute-size",
    "unsafe-section-extent",
  ]),
  message: z.string(),
});

export const perfDataSchema = z.strictObject({
  recording_id: prefixedDigestSchema("perf_data"),
  format: z.literal("perf-data"),
  artifact: perfDataArtifactSchema,
  file_header: z.strictObject({
    magic: z.literal("PERFILE2"),
    byte_order: z.enum(["little-endian", "big-endian"]),
    /** Header extent the file states in its own `size` field. */
    header_bytes: z.int().nonnegative(),
    /**
     * Per-attribute entry stride the writer used (`attr_size`); null when the
     * recorded value exceeds Number.MAX_SAFE_INTEGER and cannot be represented.
     */
    attribute_bytes: z.int().nonnegative().nullable(),
    /** Whether this file states the feature bitmap the newest writers append. */
    feature_bitmap: z.literal("present").or(z.literal("absent")),
  }),
  /** Event attribute region, as the file header states it. */
  attribute_section: perfFileSectionSchema,
  /** Sampled data region, as the file header states it. */
  data_section: perfFileSectionSchema,
  events: z.array(perfEventSchema),
  diagnostics: z.array(perfDiagnosticSchema),
  summary: z.strictObject({
    events: z.int().nonnegative(),
    identifiers: z.int().nonnegative(),
    identifiers_present: z.boolean(),
    diagnostics: z.int().nonnegative(),
  }),
  /** What this inventory did and did not examine, stated rather than implied. */
  source_coverage: z.strictObject({
    scope: z.literal("header-and-event-attributes"),
    status: z.enum(["complete-within-scope", "partial"]),
    features: z.literal("not-decoded"),
    sample_records: z.literal("not-decoded"),
    sample_attribution: z.literal("not-derived"),
    callchains: z.literal("not-decoded"),
    symbols: z.literal("not-resolved"),
    build_ids: z.literal("not-decoded"),
    network: z.literal("not-contacted"),
  }),
  limitations: z.array(z.string()),
});
export type PerfData = z.output<typeof perfDataSchema>;
