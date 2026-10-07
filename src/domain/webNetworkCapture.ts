import { z } from "zod";
import { jsonValueSchema } from "./jsonValue.js";

/** Complete historical evidence budgets; exceeding a budget returns no partial capture. */
export const WEB_NETWORK_CAPTURE_LIMITS = {
  inputBytes: 32 * 1024 * 1024,
  outputBytes: 96 * 1024 * 1024,
  timeoutMs: 30_000,
  depth: 64,
} as const;

/** Inspect an explicit retained capture without contacting its recorded destinations. */
export const inspectWebNetworkCaptureInputSchema = z.strictObject({
  capture_path: z
    .string()
    .min(1)
    .describe("Absolute local HAR or mitmproxy capture path."),
  format: z.enum(["har", "mitmproxy"]),
  record_ordinals: z
    .array(z.number().int().nonnegative())
    .min(1)
    .optional()
    .describe(
      "Zero-based producer record ordinals, in caller-selected order. Omit to inspect every record.",
    ),
  sensitive_values: z
    .array(z.string().min(1))
    .default([])
    .describe(
      "Literal values explicitly marked sensitive. Values are never persisted in Evidence parameters.",
    ),
});

const pointerSchema = z
  .string()
  .describe("RFC 6901 pointer in the producer's reported object.");
const redactionSchema = z.union([
  z.strictObject({
    pointer: pointerSchema,
    reason: z.enum(["transport-credential", "explicit-sensitive-value"]),
  }),
  z.strictObject({
    pointer: pointerSchema,
    reason: z.literal("explicit-sensitive-value"),
    scope: z
      .literal("property-name")
      .describe(
        "An omitted property name; pointer identifies its actual parent, not an invented child coordinate.",
      ),
  }),
]);
const binaryBase = {
  pointer: pointerSchema,
  representation: z.enum(["producer-bytes", "har-base64-content"]),
};
const binarySchema = z.discriminatedUnion("state", [
  z.strictObject({
    ...binaryBase,
    state: z.literal("retained"),
    content_base64: z.string(),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  z.strictObject({
    ...binaryBase,
    state: z.literal("redacted"),
    content_base64: z.null(),
    bytes: z.null(),
    sha256: z.null(),
  }),
]);
const numberSchema = z.strictObject({
  pointer: pointerSchema,
  producer_type: z.enum(["json-number", "integer", "float"]),
  literal: z.string(),
});

/** Preserve producer representations with independent sidecars rather than invented browser IDs. */
export const webNetworkCaptureRecordSchema = z.strictObject({
  ordinal: z.number().int().nonnegative(),
  location: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("unknown"),
      reason: z.literal("explicit-sensitive-value"),
    }),
    z.strictObject({ kind: z.literal("json-pointer"), pointer: pointerSchema }),
    z.strictObject({
      kind: z.literal("byte-range"),
      offset: z.number().int().nonnegative(),
      bytes: z.number().int().positive(),
    }),
  ]),
  reported: jsonValueSchema,
  binary_fields: z.array(binarySchema),
  numeric_literals: z.array(numberSchema),
  redactions: z.array(redactionSchema),
  limitations: z.array(z.string()),
});

/** Historical capture inspection has file identity, producer provenance and explicit unknowns. */
export const webNetworkCaptureSchema = z.strictObject({
  artifact: z.strictObject({
    path: z
      .string()
      .describe(
        "Selected artifact path; empty when explicitly excluded from Evidence.",
      ),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.number().int().nonnegative(),
  }),
  format: z.enum(["har", "mitmproxy"]),
  decoder: z.strictObject({
    id: z.string().min(1),
    name: z.string().min(1),
    version: z.string().min(1),
  }),
  container: z.strictObject({
    reported: jsonValueSchema,
    numeric_literals: z.array(numberSchema),
    redactions: z.array(redactionSchema),
    records_pointer: pointerSchema.nullable(),
  }),
  total_records: z.number().int().nonnegative(),
  records: z.array(webNetworkCaptureRecordSchema),
  runtime_attribution: z.literal("unknown"),
  limitations: z.array(z.string()),
});

export type InspectWebNetworkCaptureInput = z.output<
  typeof inspectWebNetworkCaptureInputSchema
>;
export type WebNetworkCapture = z.output<typeof webNetworkCaptureSchema>;
export type WebNetworkCaptureRecord = z.output<
  typeof webNetworkCaptureRecordSchema
>;
