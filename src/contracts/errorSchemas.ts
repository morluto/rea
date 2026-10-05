import { z } from "zod";

const categorySchema = z.enum([
  "invalid_input",
  "unsupported_provider",
  "integrity_mismatch",
  "truncated",
  "cancelled",
  "timeout",
  "unavailable",
  "execution_failure",
]);
const remediationSchema = z
  .object({
    action: z.string().min(1),
  })
  .strict();
const common = {
  category: categorySchema,
  message: z.string().min(1),
  retryable: z.boolean(),
  remediation: remediationSchema,
};
const genericDetails = z.record(z.string(), z.json()).optional();
const generic = <Code extends string>(code: Code) =>
  z
    .object({ code: z.literal(code), ...common, details: genericDetails })
    .strict();

/** Stable discriminated schema shared by every CLI and MCP error surface. */
export const analysisErrorProjectionSchema = z.discriminatedUnion("code", [
  generic("invalid_request"),
  generic("unreadable_output"),
  generic("capability_unavailable"),
  generic("provider_unavailable"),
  generic("provider_timeout"),
  generic("cancelled"),
  z
    .object({
      code: z.literal("artifact_integrity_mismatch"),
      ...common,
      details: z
        .object({
          logical_path: z.string(),
          declared_sha256: z.string().nullable(),
          calculated_sha256: z.string().nullable(),
          unpacked: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  generic("artifact_operation_failed"),
  generic("evidence_integrity_mismatch"),
  generic("truncated"),
  generic("process_capture_failed"),
  generic("cleanup_incomplete"),
  generic("revision_conflict"),
  generic("configuration_invalid"),
  generic("target_unavailable"),
  generic("execution_failure"),
]);

/** Legacy CLI envelope: a human label plus the canonical projected error fields. */
export const analysisCliErrorEnvelopeSchema = z
  .object({
    error: z.string().min(1),
  })
  .passthrough()
  .superRefine((value, context) => {
    const { error: _label, ...projection } = value;
    const parsed = analysisErrorProjectionSchema.safeParse(projection);
    if (!parsed.success) {
      context.addIssue({
        code: "custom",
        message:
          "CLI error envelope must contain a canonical analysis error projection",
      });
    }
  });

/** JSON Schema document used by generated API documentation and clients. */
export const analysisErrorJsonSchema = z.toJSONSchema(
  analysisErrorProjectionSchema,
);
