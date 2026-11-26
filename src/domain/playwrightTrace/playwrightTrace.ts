import { z } from "zod";
import { constants as bufferConstants } from "node:buffer";
import { digestSchema, prefixedDigestSchema } from "../digests.js";
import { localPathStringSchema } from "../localPath.js";
import { MAX_JSON_DEPTH, jsonValueSchema } from "../jsonValue.js";
import type { AnalysisParameterLimit } from "../analysisSettings.js";

export const PLAYWRIGHT_TRACE_OPERATION = "inspect_playwright_trace" as const;
export const PLAYWRIGHT_TRACE_PROVIDER = {
  id: "rea-playwright-trace",
  name: "REA offline Playwright trace inventory",
  version: "1",
} as const;
/**
 * Retained events nest a record's `reported` value under
 * normalized_result.events[n].reported, so four JSON levels enclose it.
 */
const TRACE_REPORTED_RECORD_DEPTH = 4;

/**
 * Per-call `trace_limits`: resource policies, not Playwright format limits.
 * Each field's omitted value and the maximum the schema accepts. A trace line
 * is decoded to one string, so `line_bytes` stops at the string length a
 * runtime can hold; record nesting stops where a retained record still fits
 * the Evidence JSON depth.
 */
export const PLAYWRIGHT_TRACE_LIMIT_BOUNDS = {
  archive_bytes: {
    default_value: 256 * 1024 * 1024,
    maximum: Number.MAX_SAFE_INTEGER,
    unit: "bytes",
  },
  decoded_bytes: {
    default_value: 32 * 1024 * 1024,
    maximum: Number.MAX_SAFE_INTEGER,
    unit: "bytes",
  },
  facts_bytes: {
    default_value: 32 * 1024 * 1024,
    maximum: Number.MAX_SAFE_INTEGER,
    unit: "bytes",
  },
  metadata_bytes: {
    default_value: 4 * 1024 * 1024,
    maximum: Number.MAX_SAFE_INTEGER,
    unit: "bytes",
  },
  line_bytes: {
    default_value: 4 * 1024 * 1024,
    maximum: bufferConstants.MAX_STRING_LENGTH,
    unit: "bytes",
  },
  nesting_depth: {
    default_value: 64,
    maximum: MAX_JSON_DEPTH - TRACE_REPORTED_RECORD_DEPTH,
    unit: "count",
  },
} as const;
export type PlaywrightTraceLimitField =
  keyof typeof PLAYWRIGHT_TRACE_LIMIT_BOUNDS;
export type PlaywrightTraceLimits = Readonly<
  Record<PlaywrightTraceLimitField, number>
>;

const traceLimitField = (field: PlaywrightTraceLimitField) =>
  z.int().min(1).max(PLAYWRIGHT_TRACE_LIMIT_BOUNDS[field].maximum).optional();
export const playwrightTraceLimitsSchema = z.strictObject({
  archive_bytes: traceLimitField("archive_bytes"),
  decoded_bytes: traceLimitField("decoded_bytes"),
  facts_bytes: traceLimitField("facts_bytes"),
  metadata_bytes: traceLimitField("metadata_bytes"),
  line_bytes: traceLimitField("line_bytes"),
  nesting_depth: traceLimitField("nesting_depth"),
});

/** Omitted fields resolve to their defaults; explicit values are kept. */
export const playwrightTraceLimits = (
  selected?: z.infer<typeof playwrightTraceLimitsSchema>,
): PlaywrightTraceLimits => {
  const resolved: Record<string, number> = {};
  for (const field of Object.keys(
    PLAYWRIGHT_TRACE_LIMIT_BOUNDS,
  ) as PlaywrightTraceLimitField[])
    resolved[field] =
      selected?.[field] ?? PLAYWRIGHT_TRACE_LIMIT_BOUNDS[field].default_value;
  return resolved as PlaywrightTraceLimits;
};

/** The per-call control that stopped a trace import. */
export const playwrightTraceLimit = (
  field: PlaywrightTraceLimitField,
  limits: PlaywrightTraceLimits,
): AnalysisParameterLimit => ({
  control_kind: "parameter",
  parameter: `trace_limits.${field}`,
  effective_value: limits[field],
  unit: PLAYWRIGHT_TRACE_LIMIT_BOUNDS[field].unit,
  minimum: 1,
  maximum: PLAYWRIGHT_TRACE_LIMIT_BOUNDS[field].maximum,
  default_value: PLAYWRIGHT_TRACE_LIMIT_BOUNDS[field].default_value,
  applies_at: "next_call",
});

/** The refusal options for an exhausted `trace_limits` field. */
export const playwrightTraceLimitRecovery = (
  field: PlaywrightTraceLimitField,
  limits: PlaywrightTraceLimits,
) => ({
  retryable: false as const,
  limit: playwrightTraceLimit(field, limits),
  remediationAction:
    limits[field] < PLAYWRIGHT_TRACE_LIMIT_BOUNDS[field].maximum
      ? `Pass a larger trace_limits.${field} (up to ${String(PLAYWRIGHT_TRACE_LIMIT_BOUNDS[field].maximum)}) on the next call for the same complete trace; no restart is required. Reply paging does not raise it.`
      : `trace_limits.${field} is at its maximum of ${String(limits[field])}; select a smaller complete recorder chunk.`,
});

export const traceMemberSchema = z.strictObject({
  member_id: prefixedDigestSchema("trace_member"),
  path: z.string().describe("Original ZIP member name reported by the reader"),
  logical_path: z.string().describe("Separate reader-normalized logical path"),
  kind: z.enum(["file", "directory", "symlink", "slice", "metadata"]),
  declared_bytes: z.int().nonnegative().nullable(),
  declared_compressed_bytes: z.int().nonnegative().nullable(),
  encrypted: z.boolean(),
  decoded: z.boolean(),
  limitations: z.array(z.string()),
});
export const traceSourceSchema = z.strictObject({
  member_id: prefixedDigestSchema("trace_member"),
  line: z.int().positive(),
  record_pointer: z.string(),
});
export const traceResourceReferenceSchema = z.strictObject({
  path: z.string(),
  source_pointer: z.string(),
  state: z.enum(["present-unread", "missing", "ambiguous", "unavailable"]),
  member_id: traceMemberSchema.shape.member_id.nullable(),
  matching_members: z.int().nonnegative(),
});
export const traceEventSchema = z.strictObject({
  event_id: prefixedDigestSchema("trace_event"),
  stream_id: prefixedDigestSchema("trace_stream"),
  ordinal: z.int().nonnegative(),
  source: traceSourceSchema,
  kind: z.enum([
    "action-before",
    "action-after",
    "console",
    "network",
    "screenshot",
  ]),
  call_id: z.string().nullable(),
  page_id: z.string().nullable(),
  time: z.number().finite().nullable(),
  method: z.string().nullable(),
  url: z.string().nullable(),
  status: z.number().finite().nullable(),
  text: z.string().nullable(),
  selector: z.string().nullable(),
  resource_references: z.array(traceResourceReferenceSchema),
  credential_redacted: z.boolean(),
  reported: jsonValueSchema,
  numeric_literals: z.array(
    z.strictObject({ pointer: z.string(), literal: z.string() }),
  ),
  redactions: z.array(
    z.strictObject({ pointer: z.string(), reason: z.string() }),
  ),
});
export const traceDiagnosticSchema = z.strictObject({
  diagnostic_id: prefixedDigestSchema("trace_diagnostic"),
  member_id: traceMemberSchema.shape.member_id.nullable(),
  line: z.int().positive().nullable(),
  code: z.string(),
  message: z.string(),
});
export const traceStreamSchema = z.strictObject({
  stream_id: traceEventSchema.shape.stream_id,
  member_id: traceMemberSchema.shape.member_id,
  role: z.enum(["trace", "network"]),
  version: z.literal(10).nullable(),
  state: z.enum(["supported", "unknown", "unavailable"]),
  lines: z.int().nonnegative(),
  supported_events: z.int().nonnegative(),
  omitted_event_types: z.array(
    z.strictObject({ type: z.string(), count: z.int().nonnegative() }),
  ),
  producer: z
    .strictObject({
      playwright_version: z.string().nullable(),
      browser_name: z.string().nullable(),
      origin: z.string().nullable(),
    })
    .nullable(),
});
export const playwrightTraceSchema = z.strictObject({
  kind: z.literal("playwright-trace"),
  trace_id: prefixedDigestSchema("playwright_trace"),
  decoder_profile: z.literal("playwright-trace-v10"),
  artifact: z.strictObject({
    path: localPathStringSchema,
    sha256: digestSchema,
    bytes: z.int().nonnegative(),
  }),
  ordering: z.literal("per-stream-source-order-only"),
  streams: z.array(traceStreamSchema),
  members: z.array(traceMemberSchema),
  events: z.array(traceEventSchema),
  diagnostics: z.array(traceDiagnosticSchema),
  summary: z.strictObject({
    events: z.int().nonnegative(),
    action_before: z.int().nonnegative(),
    action_after: z.int().nonnegative(),
    console: z.int().nonnegative(),
    network: z.int().nonnegative(),
    screenshots: z.int().nonnegative(),
    unavailable_references: z.int().nonnegative(),
  }),
  source_coverage: z.strictObject({
    recording_completeness: z.literal("unknown"),
    interpretation: z.enum(["scoped", "partial"]),
    resource_contents: z.literal("not-decoded"),
  }),
  limitations: z.array(z.string()),
});
export type PlaywrightTrace = z.output<typeof playwrightTraceSchema>;
export type TraceEvent = z.output<typeof traceEventSchema>;
export type TraceMember = z.output<typeof traceMemberSchema>;
export type TraceStream = z.output<typeof traceStreamSchema>;
