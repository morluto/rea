import { z } from "zod";

const categorySchema = z.enum([
  "invalid_input",
  "permission_required",
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
    restart_required: z.boolean(),
    elicitation_supported: z.boolean().optional(),
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

const scopeSchema = z
  .object({
    capability: z.string(),
    roots: z.array(z.string()),
    executables: z.array(z.string()),
    environment_names: z.array(z.string()),
    origins: z.array(z.string()).optional(),
    network: z.enum(["none", "loopback", "external"]),
    mount: z.boolean(),
  })
  .strict();
const missingScopeSchema = z
  .object({
    roots: z.array(z.string()).optional(),
    executables: z.array(z.string()).optional(),
    environment_names: z.array(z.string()).optional(),
    origins: z.array(z.string()).optional(),
    network: z.enum(["none", "loopback", "external"]).optional(),
    mount: z.literal(true).optional(),
  })
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
  z
    .object({
      code: z.literal("permission_required"),
      ...common,
      details: z
        .object({
          capability: z.string(),
          requested: scopeSchema,
          missing: missingScopeSchema,
          ceiling: scopeSchema.nullable(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  generic("process_capture_failed"),
  generic("cleanup_incomplete"),
  generic("revision_conflict"),
  generic("outside_approved_root"),
  generic("configuration_invalid"),
  generic("target_unavailable"),
  generic("execution_failure"),
  generic("plan_stale"),
]);

/** JSON Schema document used by generated API documentation and clients. */
export const analysisErrorJsonSchema = z.toJSONSchema(
  analysisErrorProjectionSchema,
);
