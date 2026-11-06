import { z } from "zod";
import { digestSchema, prefixedDigestSchema } from "../digests.js";
import { localPathStringSchema } from "../localPath.js";
import { jsonValueSchema } from "../jsonValue.js";

export const PLAYWRIGHT_TRACE_OPERATION = "inspect_playwright_trace" as const;
export const PLAYWRIGHT_TRACE_PROVIDER = {
  id: "rea-playwright-trace",
  name: "REA offline Playwright trace inventory",
  version: "1",
} as const;
/** Resource policies; these are not Playwright format limits. */
export const PLAYWRIGHT_TRACE_LIMITS = {
  archiveBytes: 256 * 1024 * 1024,
  decodedBytes: 32 * 1024 * 1024,
  factsBytes: 32 * 1024 * 1024,
  metadataBytes: 4 * 1024 * 1024,
  lineBytes: 4 * 1024 * 1024,
} as const;

export const traceMemberSchema = z.strictObject({
  member_id: prefixedDigestSchema("trace_member"),
  path: z.string(),
  kind: z.enum(["file", "directory", "symlink", "slice", "metadata"]),
  declared_bytes: z.int().nonnegative().nullable(),
  declared_compressed_bytes: z.int().nonnegative().nullable(),
  encrypted: z.boolean(),
  decoded: z.boolean(),
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
