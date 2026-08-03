import { z } from "zod";

import { evidenceBundleSchema } from "./evidenceBundle.js";
import { reconstructionObligationLedgerSchema } from "./reconstructionObligationLedgerSchemas.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{64}$/u);
const stableIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9._:/-]{0,199}$/u);
const boundedTextSchema = z.string().trim().min(1).max(4_096);

export const readinessStatusSchema = z.enum([
  "pass",
  "fail",
  "unknown",
  "unsupported",
  "truncated",
  "skipped",
]);

export const readinessStageIdSchema = z.enum([
  "discover-classify",
  "diagnose-environment",
  "acquire-authority",
  "static-analysis",
  "reactive-scenarios",
  "compare-authority-candidate",
  "preserve-contradictions",
  "verify-reconstruction-closure",
  "export-replay",
]);

const versionObservationSchema = z.strictObject({
  component: stableIdSchema,
  version: boundedTextSchema.nullable(),
  digest: digestSchema.nullable(),
  state: z.enum(["current", "stale", "unavailable"]),
  remediation: boundedTextSchema.nullable(),
});

const providerIdentitySchema = z.strictObject({
  provider_id: stableIdSchema,
  version: boundedTextSchema.nullable(),
  digest: digestSchema.nullable(),
  state: z.enum(["available", "unavailable", "incompatible", "broken-host"]),
  reason_code: stableIdSchema.nullable(),
});

const limitSchema = z.strictObject({
  name: stableIdSchema,
  value: z.number().finite().nonnegative(),
  unit: z.enum(["count", "bytes", "milliseconds", "ratio"]),
});

const capabilitySchema = z.strictObject({
  capability_id: stableIdSchema,
  available: z.boolean(),
  bounded: z.boolean(),
  side_effect: z.enum([
    "none",
    "reads-target",
    "launches-process",
    "writes-workspace",
    "network-observation",
  ]),
  authority_scopes: z.array(stableIdSchema).max(100),
  limits: z.array(limitSchema).max(100),
  unavailable_reason: boundedTextSchema.nullable(),
});

const fixtureSchema = z.strictObject({
  fixture_id: stableIdSchema,
  kind: z.enum([
    "native",
    "javascript-cli",
    "electron",
    "incomplete-reconstruction",
    "broken-runtime",
  ]),
  artifact_sha256: digestSchema,
  environment_id: stableIdSchema,
  deliberate_faults: z.array(stableIdSchema).min(1).max(100),
});

const workflowCandidateSchema = z.strictObject({
  fixture_id: stableIdSchema,
  workflow_id: stableIdSchema,
  provider_id: stableIdSchema.nullable(),
  selected: z.boolean(),
  invoked: z.boolean(),
  compatibility: z.enum(["compatible", "incompatible", "unavailable"]),
  reason_code: stableIdSchema,
});

const grantSchema = z.strictObject({
  grant_id: stableIdSchema,
  scope: stableIdSchema,
  decision: z.enum(["granted", "denied", "cancelled", "restart-required"]),
  launched_process: z.boolean(),
  evidence_ids: z.array(evidenceIdSchema).max(100),
});

const comparisonSchema = z.strictObject({
  comparison_id: stableIdSchema,
  verdict: z.enum(["equivalent", "different", "unknown"]),
  schedule_semantics: z.enum(["total-order", "partial-order", "finite-traces"]),
  concurrent: z.boolean(),
  truncated: z.boolean(),
  unavailable_authority: z.boolean(),
  unstable: z.boolean(),
  deliberate_divergence_ref: boundedTextSchema.nullable(),
  divergence_refs: z.array(boundedTextSchema).max(100),
  contradiction_ids: z.array(stableIdSchema).max(100),
  evidence_ids: z.array(evidenceIdSchema).min(1).max(1_000),
});

const contradictionSchema = z.strictObject({
  contradiction_id: stableIdSchema,
  declared_sha256: digestSchema,
  observed_sha256: digestSchema,
  policy: z.literal("record-and-continue"),
  affected_comparison_ids: z.array(stableIdSchema).min(1).max(100),
  evidence_ids: z.array(evidenceIdSchema).min(2).max(100),
});

const operationOutcomeSchema = z.strictObject({
  sequence: z.number().int().min(0),
  operation: stableIdSchema,
  surface: z.enum(["cli", "mcp"]),
  call_kind: z.enum([
    "valid",
    "malformed",
    "over-limit",
    "incompatible-provider",
    "setup",
    "permission",
    "operation",
  ]),
  expected_success: z.boolean(),
  cli_exit_code: z.number().int().min(0).nullable(),
  mcp_status: z.enum(["success", "non-success"]).nullable(),
  error_code: stableIdSchema.nullable(),
  recovered: z.boolean(),
  evidence_ids: z.array(evidenceIdSchema).max(100),
});

const cleanupSchema = z.strictObject({
  run_id: stableIdSchema,
  cancelled: z.boolean(),
  owned_resources_remaining: z.number().int().min(0),
  diagnostic_evidence_ids: z.array(evidenceIdSchema).max(100),
});

const closureObservationSchema = z.strictObject({
  sequence: z.number().int().min(0),
  ledger_digest: digestSchema,
  status: z.enum(["ready", "open", "failed", "unknown"]),
  required_open: z.number().int().min(0),
  newly_verified_obligation_ids: z.array(stableIdSchema).max(10_000),
  evidence_ids: z.array(evidenceIdSchema).min(1).max(1_000),
});

const delegationCheckSchema = z.strictObject({
  candidate_id: stableIdSchema,
  delegates_to_authority: z.boolean(),
  evidence_ids: z.array(evidenceIdSchema).min(1).max(100),
});

const stageCheckSchema = z.strictObject({
  check_id: stableIdSchema,
  status: readinessStatusSchema,
  detail: boundedTextSchema,
  evidence_ids: z.array(evidenceIdSchema).max(100),
});

const stageSchema = z.strictObject({
  stage_id: readinessStageIdSchema,
  required: z.boolean(),
  status: readinessStatusSchema,
  capability_issue: stableIdSchema.nullable(),
  next_action: boundedTextSchema.nullable(),
  evidence_ids: z.array(evidenceIdSchema).max(1_000),
  checks: z.array(stageCheckSchema).max(100),
});

const replaySchema = z.strictObject({
  expected_source_digest: digestSchema.nullable(),
  deterministic: z.boolean(),
  tamper_detected: z.boolean(),
  stale_input_detected: z.boolean(),
  evidence_ids: z.array(evidenceIdSchema).max(100),
});

export const reconstructionReadinessInputSchema = z.strictObject({
  schema_version: z.literal(1),
  identity: z.strictObject({
    cli_version: boundedTextSchema,
    server_version: boundedTextSchema,
    catalog_digest: digestSchema,
    skill_digest: digestSchema.nullable(),
    versions: z.array(versionObservationSchema).min(1).max(100),
    providers: z.array(providerIdentitySchema).max(100),
  }),
  client: z.strictObject({
    name: boundedTextSchema,
    version: boundedTextSchema,
    negotiated_capabilities: z.array(stableIdSchema).max(100),
  }),
  capabilities: z.array(capabilitySchema).min(1).max(1_000),
  fixtures: z.array(fixtureSchema).min(1).max(100),
  workflow_candidates: z.array(workflowCandidateSchema).min(1).max(1_000),
  grants: z.array(grantSchema).max(1_000),
  evidence_bundle: evidenceBundleSchema,
  comparisons: z.array(comparisonSchema).max(1_000),
  contradictions: z.array(contradictionSchema).max(1_000),
  obligation_ledger: reconstructionObligationLedgerSchema,
  operation_outcomes: z.array(operationOutcomeSchema).max(10_000),
  cleanup: z.array(cleanupSchema).max(1_000),
  closure_history: z.array(closureObservationSchema).min(2).max(1_000),
  delegation_checks: z.array(delegationCheckSchema).min(1).max(1_000),
  replay: replaySchema,
  stages: z
    .array(stageSchema)
    .length(9)
    .superRefine((stages, context) => {
      const seen = new Set<string>();
      stages.forEach((stage, index) => {
        if (seen.has(stage.stage_id))
          context.addIssue({
            code: "custom",
            path: [index, "stage_id"],
            message: "Readiness stage IDs must be unique",
          });
        seen.add(stage.stage_id);
      });
    }),
});

const findingSchema = z.strictObject({
  code: stableIdSchema,
  stage_id: readinessStageIdSchema,
  status: z.enum(["fail", "unknown"]),
  detail: boundedTextSchema,
  evidence_ids: z.array(evidenceIdSchema).max(100),
});

export const reconstructionReadinessReportSchema = z.strictObject({
  schema: z.literal("ReconstructionReadinessReport"),
  schema_version: z.literal(1),
  report_id: z.string().regex(/^rr_[a-f0-9]{64}$/u),
  source_digest: digestSchema,
  report_digest: digestSchema,
  status: readinessStatusSchema,
  summary: z.strictObject({
    stages: z.number().int().min(0),
    required_stages: z.number().int().min(0),
    passed_required_stages: z.number().int().min(0),
    findings: z.number().int().min(0),
    failed_findings: z.number().int().min(0),
    unknown_findings: z.number().int().min(0),
  }),
  metrics: z.strictObject({
    first_valid_workflow_selection_rate: z.number().min(0).max(1),
    malformed_or_over_limit_call_rate: z.number().min(0).max(1),
    incompatible_provider_invocations: z.number().int().min(0),
    failed_calls_before_prerequisites: z.number().int().min(0),
    recovery_rate: z.number().min(0).max(1),
    divergence_localization_precision: z.number().min(0).max(1),
    false_equivalence_count: z.number().int().min(0),
    unowned_obligation_count: z.number().int().min(0),
    cleanup_leak_count: z.number().int().min(0),
    nondeterministic_replay_count: z.number().int().min(0),
  }),
  stages: z
    .array(stageSchema)
    .length(9)
    .superRefine((stages, context) => {
      const seen = new Set<string>();
      stages.forEach((stage, index) => {
        if (seen.has(stage.stage_id))
          context.addIssue({
            code: "custom",
            path: [index, "stage_id"],
            message: "Readiness stage IDs must be unique",
          });
        seen.add(stage.stage_id);
      });
    }),
  findings: z.array(findingSchema).max(10_000),
  evidence_links: z.array(evidenceIdSchema).max(100_000),
  snapshot: reconstructionReadinessInputSchema,
});

export type ReconstructionReadinessInput = z.infer<
  typeof reconstructionReadinessInputSchema
>;
export type ReconstructionReadinessReport = z.infer<
  typeof reconstructionReadinessReportSchema
>;
export type ReadinessStageId = z.infer<typeof readinessStageIdSchema>;
export type ReadinessFinding = z.infer<typeof findingSchema>;
