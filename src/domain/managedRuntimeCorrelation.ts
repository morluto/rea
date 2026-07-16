import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import { z } from "zod";

import { evidenceSchema, parseEvidence } from "./evidence.js";
import { managedMemberInspectionSchema } from "./managedArtifact.js";
import type { JsonValue } from "./jsonValue.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{64}$/u);
const tokenSchema = z.string().regex(/^0x[0-9a-f]{8}$/u);
const boundedTextSchema = z.string().min(1).max(4_096);

const managedRuntimeEffectSchema = z.enum([
  "attach",
  "load",
  "debugger",
  "reflection",
  "instrumentation",
]);

const managedRuntimeHostSchema = z.strictObject({
  os: z.enum(["linux", "macos", "windows"]),
  clr_family: z.enum(["dotnet", "dotnet-framework", "mono", "unknown"]),
  architecture: z.enum(["x86", "x86_64", "arm", "arm64"]),
});

const managedRuntimeBoundsSchema = z.strictObject({
  timeout_ms: z.number().int().min(1).max(60_000).default(5_000),
  max_threads: z.number().int().min(1).max(256).default(32),
  max_output_bytes: z.number().int().min(0).max(1_048_576).default(65_536),
  allow_network: z.literal(false).default(false),
  allow_ui: z.literal(false).default(false),
});

export const managedRuntimeCorrelationInputSchema = z.strictObject({
  static_members: evidenceSchema,
  method: z.strictObject({
    token: tokenSchema,
    signature_sha256: digestSchema,
    normalized_il_sha256: digestSchema.nullable(),
  }),
  requested_effect: managedRuntimeEffectSchema,
  host: managedRuntimeHostSchema,
  bounds: managedRuntimeBoundsSchema.default({
    timeout_ms: 5_000,
    max_threads: 32,
    max_output_bytes: 65_536,
    allow_network: false,
    allow_ui: false,
  }),
  unknown_registry_approved: z.literal(true).optional(),
});

export const managedRuntimeCorrelationResultSchema = z.strictObject({
  schema_version: z.literal(1),
  correlation_id: z.string().regex(/^mrc_[a-f0-9]{64}$/u),
  phase: z.literal("admission-plan"),
  executed: z.literal(false),
  authority_model: z.strictObject({
    capability: z.literal("managed_runtime"),
    permission_grant_id: z.string().min(1),
    default_enabled: z.literal(false),
    per_call_approval_required: z.literal(true),
  }),
  static_observation: z.strictObject({
    evidence_id: evidenceIdSchema,
    artifact_sha256: digestSchema,
    artifact_path: z.string().min(1),
    byte_length: z.number().int().min(0),
    module_name: z.string().nullable(),
    mvid: z.string().uuid().nullable(),
    metadata_status: z.enum(["absent", "complete", "partial", "malformed"]),
  }),
  method_lock: z.strictObject({
    token: tokenSchema,
    declaring_type: z.string().nullable(),
    name: z.string(),
    signature_sha256: digestSchema,
    normalized_il_sha256: digestSchema.nullable(),
    body_sha256: digestSchema.nullable(),
    il_size: z.number().int().min(0),
    body_status: z.enum(["present", "absent", "malformed", "too-large"]),
    exact_build_required: z.literal(true),
  }),
  requested_runtime: z.strictObject({
    effect: managedRuntimeEffectSchema,
    host: managedRuntimeHostSchema,
    executable_path: z.string().min(1),
    network: z.literal("none"),
    filesystem: z.literal("owned-artifacts-only"),
  }),
  effect_taxonomy: z.strictObject({
    attaches_process: z.boolean(),
    loads_target: z.boolean(),
    uses_debugger: z.boolean(),
    uses_reflection: z.boolean(),
    instruments_code: z.boolean(),
    invokes_target_code: z.literal(false),
  }),
  bounds: managedRuntimeBoundsSchema,
  unsupported_until_executor_exists: z.literal(true),
  evidence_links: z.array(evidenceIdSchema).length(1),
  limitations: z.array(boundedTextSchema).max(1_000),
});

export type ManagedRuntimeCorrelationInput = z.infer<
  typeof managedRuntimeCorrelationInputSchema
>;
export type ManagedRuntimeCorrelationResult = z.infer<
  typeof managedRuntimeCorrelationResultSchema
>;

const sha256 = (value: JsonValue): string => {
  const serialized = canonicalize(value);
  if (serialized === undefined)
    throw new TypeError("Managed runtime correlation canonicalization failed");
  return createHash("sha256").update(serialized).digest("hex");
};

/** Authenticate static managed Evidence and build a non-executing runtime plan. */
export const planManagedRuntimeCorrelation = (
  input: ManagedRuntimeCorrelationInput,
  executablePath: string,
  permissionGrantId: string,
): ManagedRuntimeCorrelationResult => {
  const staticEvidence = parseEvidence(input.static_members);
  if (staticEvidence.operation !== "inspect_managed_members")
    throw new TypeError("Evidence operation is not inspect_managed_members");
  const members = managedMemberInspectionSchema.parse(
    staticEvidence.normalized_result,
  );
  const method = members.methods.items.find(
    (item) =>
      item.token === input.method.token &&
      item.signature.raw_sha256 === input.method.signature_sha256 &&
      item.body.normalized_il_sha256 === input.method.normalized_il_sha256,
  );
  if (method === undefined)
    throw new TypeError(
      "Requested method lock does not match a static managed member observation",
    );
  const withoutId = {
    schema_version: 1 as const,
    phase: "admission-plan" as const,
    executed: false as const,
    authority_model: {
      capability: "managed_runtime" as const,
      permission_grant_id: permissionGrantId,
      default_enabled: false as const,
      per_call_approval_required: true as const,
    },
    static_observation: {
      evidence_id: staticEvidence.evidence_id,
      artifact_sha256: members.artifact.sha256,
      artifact_path: members.artifact.path,
      byte_length: members.artifact.byte_length,
      module_name: members.module?.name ?? null,
      mvid: members.module?.mvid ?? null,
      metadata_status: members.metadata.status,
    },
    method_lock: {
      token: method.token,
      declaring_type: method.declaring_type,
      name: method.name,
      signature_sha256: method.signature.raw_sha256,
      normalized_il_sha256: method.body.normalized_il_sha256,
      body_sha256: method.body.il_sha256,
      il_size: method.body.il_size,
      body_status: method.body.status,
      exact_build_required: true as const,
    },
    requested_runtime: {
      effect: input.requested_effect,
      host: input.host,
      executable_path: executablePath,
      network: "none" as const,
      filesystem: "owned-artifacts-only" as const,
    },
    effect_taxonomy: effectTaxonomy(input.requested_effect),
    bounds: input.bounds,
    unsupported_until_executor_exists: true as const,
    evidence_links: [staticEvidence.evidence_id],
    limitations: [
      "This operation admits and records a runtime-correlation plan only; it did not attach, load, debug, reflect, instrument, invoke, or execute target code.",
      "Runtime agreement would be a separate runtime observation and would not retroactively turn static inference into a byte observation.",
      "The exact artifact SHA-256, MVID, method signature, and normalized IL shape must match before any future executor can run.",
      "Network and UI effects are not admitted by this contract.",
    ],
  };
  return managedRuntimeCorrelationResultSchema.parse({
    ...withoutId,
    correlation_id: `mrc_${sha256(withoutId)}`,
  });
};

const effectTaxonomy = (
  effect: ManagedRuntimeCorrelationInput["requested_effect"],
): ManagedRuntimeCorrelationResult["effect_taxonomy"] => ({
  attaches_process: effect === "attach",
  loads_target: effect === "load" || effect === "reflection",
  uses_debugger: effect === "debugger",
  uses_reflection: effect === "reflection",
  instruments_code: effect === "instrumentation",
  invokes_target_code: false,
});
