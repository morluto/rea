import { z } from "zod";
import { digestSchema, prefixedDigestSchema } from "../digests.js";
import { localPathStringSchema } from "../localPath.js";
import { jsonValueSchema } from "../jsonValue.js";

/** Resource allowances, not OTLP format limits. */
export const OTLP_TRACE_MAX_FILE_BYTES = 32 * 1024 * 1024;
export const OTLP_TRACE_MAX_SPANS = 50_000;

/** Bounded so a file of malformed groups cannot turn into an unbounded result. */
export const OTLP_TRACE_MAX_DIAGNOSTICS = 1_000;

/** Per-span attribute allowance; a span never loses attributes silently. */
export const OTLP_TRACE_MAX_ATTRIBUTES_PER_SPAN = 128;
export const OTLP_TRACE_OPERATION = "inspect_otlp_trace" as const;
export const OTLP_TRACE_PROVIDER = {
  id: "rea-otlp-trace",
  name: "REA offline OTLP trace inventory",
  version: "1",
} as const;

/** Identifies one caller-supplied export rather than any live collector. */
export const otlpTraceArtifactSchema = z.strictObject({
  path: localPathStringSchema,
  sha256: digestSchema,
  bytes: z.int().nonnegative(),
});
export type OtlpTraceArtifact = z.output<typeof otlpTraceArtifactSchema>;

/**
 * A recorded attribute value. Only scalar kinds are retained; array and
 * key-value kinds are reported without their contents so an unbounded nested
 * structure cannot expand into the result.
 */
export const otlpAttributeSchema = z.strictObject({
  key: z.string(),
  value_kind: z.enum([
    "string",
    "bool",
    "int",
    "double",
    "bytes",
    "array",
    "key-value-list",
    "empty",
  ]),
  string_value: z.string().nullable(),
  bool_value: z.boolean().nullable(),
  int_value: z.string().nullable(),
  double_value: z.number().finite().nullable(),
  bytes_length: z.int().nonnegative().nullable(),
  /** The recorded base64 payload, kept so equal-length values stay distinct. */
  bytes_base64: z.string().nullable(),
  element_count: z.int().nonnegative().nullable(),
});

/** Timestamp facts stay separate from the duration derived from them. */
export const otlpSpanSchema = z.strictObject({
  span_id: z.string(),
  trace_id: z.string(),
  parent_span_id: z.string().nullable(),
  /** Invalid recorded values are not equivalent to a declared root. */
  parent_span_id_state: z.enum(["absent", "valid", "invalid"]),
  parent_span_id_raw: jsonValueSchema.nullable(),
  name: z.string(),
  kind: z.enum([
    "unspecified",
    "internal",
    "server",
    "client",
    "producer",
    "consumer",
    "unknown-kind",
  ]),
  start_time_unix_nano: z.string().nullable(),
  end_time_unix_nano: z.string().nullable(),
  duration_nano: z.string().nullable(),
  status_code: z.enum(["unset", "ok", "error", "unknown-code"]),
  status_message: z.string().nullable(),
  /** Indexes identify the recorded resource and scope group in this inventory. */
  resource_index: z.int().nonnegative(),
  scope_index: z.int().nonnegative(),
  attributes: z.array(otlpAttributeSchema),
  event_count: z.int().nonnegative(),
  link_count: z.int().nonnegative(),
  source_pointer: z.string(),
});
export type OtlpSpan = z.output<typeof otlpSpanSchema>;

export const otlpDiagnosticSchema = z.strictObject({
  diagnostic_id: prefixedDigestSchema("otlp_diagnostic"),
  source_pointer: z.string(),
  code: z.enum([
    "invalid-json",
    "unsupported-envelope",
    "invalid-record",
    "duplicate-span-id",
    "missing-parent",
    "self-parent",
    "cycle",
    "invalid-time-interval",
    "span-limit-exceeded",
    "attribute-limit-exceeded",
  ]),
  message: z.string(),
});

export const otlpResourceSchema = z.strictObject({
  source_pointer: z.string(),
  service_name: z.string().nullable(),
  attributes: z.array(otlpAttributeSchema),
});
export type OtlpResource = z.output<typeof otlpResourceSchema>;

export const otlpScopeSchema = z.strictObject({
  source_pointer: z.string(),
  resource_index: z.int().nonnegative(),
  name: z.string().nullable(),
  version: z.string().nullable(),
});
export type OtlpScope = z.output<typeof otlpScopeSchema>;

export const otlpTraceSchema = z.strictObject({
  trace_import_id: prefixedDigestSchema("otlp_trace"),
  format: z.literal("otlp-json"),
  artifact: otlpTraceArtifactSchema,
  resources: z.array(otlpResourceSchema),
  scopes: z.array(otlpScopeSchema),
  spans: z.array(otlpSpanSchema),
  /** Parent identifiers that no recorded span declares. */
  orphan_span_ids: z.array(z.string()),
  roots: z.array(z.string()),
  diagnostics: z.array(otlpDiagnosticSchema),
  summary: z.strictObject({
    spans: z.int().nonnegative(),
    roots: z.int().nonnegative(),
    orphans: z.int().nonnegative(),
    error_status: z.int().nonnegative(),
    with_parent: z.int().nonnegative(),
    distinct_traces: z.int().nonnegative(),
    distinct_services: z.int().nonnegative(),
    diagnostics: z.int().nonnegative(),
  }),
  source_coverage: z.strictObject({
    scope: z.literal("single-caller-supplied-export"),
    encoding: z.literal("otlp-json"),
    protobuf_encodings: z.literal("not-supported"),
    recording_completeness: z.literal("unknown"),
    live_collector: z.literal("not-contacted"),
    clock_skew: z.literal("not-corrected"),
  }),
  limitations: z.array(z.string()),
});
export type OtlpTrace = z.output<typeof otlpTraceSchema>;
export type OtlpDiagnostic = z.output<typeof otlpDiagnosticSchema>;
