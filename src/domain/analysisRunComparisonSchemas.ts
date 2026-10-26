import { z } from "zod";

import { digestSchema, prefixedDigestSchema } from "./digests.js";
import { jsonObjectSchema, type JsonValue } from "./jsonValue.js";

export const evidenceIdSchema = prefixedDigestSchema("ev");
export const comparisonIdSchema = prefixedDigestSchema("arcr");

/** Default incidental/presentation fields stripped during semantic finding comparison. */
export const DEFAULT_ANALYSIS_RUN_IGNORED_FIELDS = Object.freeze([
  "caller_input_path",
  "created_at",
  "display_label",
  "duration_ms",
  "elapsed_ms",
  "local_path",
  "presentation_note",
  "recorded_at",
  "timestamp",
  "updated_at",
] as const);

export const analysisRunCoverageStatusSchema = z.enum([
  "complete",
  "partial",
  "unknown",
]);

export const analysisRunCoverageSchema = z.strictObject({
  status: analysisRunCoverageStatusSchema,
  truncated: z.boolean().optional(),
  omitted_count: z.int().min(0).optional(),
  limitations: z.array(z.string().min(1)).optional(),
  reason: z.string().min(1).nullable().optional(),
});

export type AnalysisRunCoverage = z.infer<typeof analysisRunCoverageSchema>;

export const supportedAnalysisRunResultTypeSchema = z.enum([
  "binary-analysis",
  "function-analysis",
  "artifact-inspection",
  "application-analysis",
  "evidence-bundle-run",
]);

export type SupportedAnalysisRunResultType = z.infer<
  typeof supportedAnalysisRunResultTypeSchema
>;

export const analysisRunSubjectSchema = z.strictObject({
  sha256: digestSchema,
  format: z.string().min(1),
  architecture: z.string().min(1).nullable(),
  local_path: z.string().min(1).nullable().optional(),
});

export const analysisRunProviderSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1).nullable(),
});

export const analysisRunProcedureRecordSchema = z.strictObject({
  address: z.string().min(1),
  name: z.string().min(1),
  signature: z.string().min(1).nullable().optional(),
  size_bytes: z.int().min(0).nullable().optional(),
  callees: z.array(z.string().min(1)).optional(),
  callers: z.array(z.string().min(1)).optional(),
  pseudocode_sha256: digestSchema.nullable().optional(),
  evidence_id: evidenceIdSchema.optional(),
  metadata: jsonObjectSchema.optional(),
});

export type AnalysisRunProcedureRecord = z.infer<
  typeof analysisRunProcedureRecordSchema
>;

export const analysisRunFindingRecordSchema = z.strictObject({
  finding_id: z.string().min(1),
  category: z.string().min(1),
  severity: z.enum(["info", "low", "medium", "high", "critical"]),
  confidence: z.enum(["inferred", "derived", "observed"]),
  title: z.string().min(1),
  summary: z.string().min(1),
  locations: z.array(z.string().min(1)).optional(),
  attributes: jsonObjectSchema.optional(),
  evidence_id: evidenceIdSchema.optional(),
  metadata: jsonObjectSchema.optional(),
});

export type AnalysisRunFindingRecord = z.infer<
  typeof analysisRunFindingRecordSchema
>;

export const analysisRunObligationStatusSchema = z.enum([
  "verified",
  "open",
  "unsatisfied",
  "contradicted",
]);

export type AnalysisRunObligationStatus = z.infer<
  typeof analysisRunObligationStatusSchema
>;

export const analysisRunObligationRecordSchema = z.strictObject({
  obligation_id: z.string().min(1),
  category: z.string().min(1),
  description: z.string().min(1),
  status: analysisRunObligationStatusSchema,
  evidence_ids: z.array(evidenceIdSchema).optional(),
  metadata: jsonObjectSchema.optional(),
});

export type AnalysisRunObligationRecord = z.infer<
  typeof analysisRunObligationRecordSchema
>;

export const analysisRunUnknownRecordSchema = z.strictObject({
  unknown_id: z.string().min(1),
  question: z.string().min(1),
  status: z.enum([
    "open",
    "investigating",
    "blocked",
    "contradicted",
    "resolved",
  ]),
  disposition: z.string().min(1).nullable().optional(),
  revision: z.int().min(1).optional(),
  evidence_ids: z.array(evidenceIdSchema).optional(),
  metadata: jsonObjectSchema.optional(),
});

export type AnalysisRunUnknownRecord = z.infer<
  typeof analysisRunUnknownRecordSchema
>;

export const analysisRunEnvelopeSchema = z.strictObject({
  run_id: z.string().min(1),
  evidence_id: evidenceIdSchema,
  result_type: supportedAnalysisRunResultTypeSchema,
  operation: z.string().min(1),
  predicate_type: z.string().min(1),
  subject: analysisRunSubjectSchema.nullable(),
  provider: analysisRunProviderSchema,
  analysis_profile_digest: digestSchema.nullable().optional(),
  relationship_coverage: analysisRunCoverageSchema.nullable().optional(),
  procedures: z.array(analysisRunProcedureRecordSchema).optional(),
  findings: z.array(analysisRunFindingRecordSchema).optional(),
  obligations: z.array(analysisRunObligationRecordSchema).optional(),
  unknowns: z.array(analysisRunUnknownRecordSchema).optional(),
  limitations: z.array(z.string().min(1)).optional(),
  metadata: jsonObjectSchema.optional(),
});

export type AnalysisRunEnvelope = z.infer<typeof analysisRunEnvelopeSchema>;

export const analysisRunIncompatibilityCodeSchema = z.enum([
  "invalid_run_schema",
  "unsupported_result_type",
  "incompatible_result_type",
  "incompatible_operation",
  "incompatible_predicate_type",
  "incompatible_subject_format",
  "incompatible_subject_architecture",
  "incompatible_provider",
  "duplicate_item_identity",
]);

export type AnalysisRunIncompatibilityCode = z.infer<
  typeof analysisRunIncompatibilityCodeSchema
>;

const runSummarySchema = z
  .strictObject({
    run_id: z.string().nullable(),
    result_type: z.string().nullable(),
    operation: z.string().nullable(),
    predicate_type: z.string().nullable(),
    subject_format: z.string().nullable(),
    subject_architecture: z.string().nullable(),
    provider_id: z.string().nullable(),
  })
  .nullable();

export const analysisRunIncompatibilitySchema = z.strictObject({
  compatible: z.literal(false),
  code: analysisRunIncompatibilityCodeSchema,
  explanation: z.string().min(1),
  left_summary: runSummarySchema,
  right_summary: runSummarySchema,
});

export type AnalysisRunIncompatibility = z.infer<
  typeof analysisRunIncompatibilitySchema
>;

export interface CompareAnalysisRunsOptions {
  readonly ignore_fields?: readonly string[];
  readonly require_same_provider?: boolean;
}

export const analysisRunItemKindSchema = z.enum([
  "procedure",
  "finding",
  "obligation",
  "residual_unknown",
]);

export type AnalysisRunItemKind = z.infer<typeof analysisRunItemKindSchema>;

export const analysisRunMatchingRuleSchema = z.enum([
  "procedure-address",
  "finding-id",
  "obligation-id",
  "unknown-id",
]);

export type AnalysisRunMatchingRule = z.infer<
  typeof analysisRunMatchingRuleSchema
>;

export const analysisRunItemStatusSchema = z.enum([
  "unchanged",
  "changed",
  "added",
  "removed",
  "unknown",
]);

export type AnalysisRunItemStatus = z.infer<typeof analysisRunItemStatusSchema>;

export const analysisRunRecordReferenceSchema = z.strictObject({
  run_id: z.string().min(1),
  evidence_id: evidenceIdSchema,
  record_pointer: z.string().min(1),
});

export type AnalysisRunRecordReference = z.infer<
  typeof analysisRunRecordReferenceSchema
>;

export const analysisRunItemDeltaSchema = z.strictObject({
  item_kind: analysisRunItemKindSchema,
  item_key: z.string().min(1),
  matching_rule: analysisRunMatchingRuleSchema,
  status: analysisRunItemStatusSchema,
  conclusion_kind: z.enum(["derived_relationship", "unresolved_branch"]),
  presentation_only_change: z.boolean(),
  changed_fields: z.array(z.string().min(1)),
  presentation_fields_changed: z.array(z.string().min(1)),
  unknown_reason: z
    .enum(["left_run_incomplete", "right_run_incomplete"])
    .nullable(),
  left_semantic_digest: digestSchema.nullable(),
  right_semantic_digest: digestSchema.nullable(),
  left_record_ref: analysisRunRecordReferenceSchema.nullable(),
  right_record_ref: analysisRunRecordReferenceSchema.nullable(),
  evidence_links: z.array(evidenceIdSchema).min(1),
});

export type AnalysisRunItemDelta = z.infer<typeof analysisRunItemDeltaSchema>;

export const analysisRunCoverageDeltaSchema = z.strictObject({
  left_status: analysisRunCoverageStatusSchema,
  right_status: analysisRunCoverageStatusSchema,
  left_complete: z.boolean(),
  right_complete: z.boolean(),
  left_omitted_count: z.int().min(0),
  right_omitted_count: z.int().min(0),
  omitted_count_delta: z.int(),
  transition: z.enum(["unchanged", "improved", "regressed"]),
});

export type AnalysisRunCoverageDelta = z.infer<
  typeof analysisRunCoverageDeltaSchema
>;

export const analysisRunObligationTransitionsSchema = z.strictObject({
  improved: z.int().min(0),
  regressed: z.int().min(0),
  unchanged: z.int().min(0),
  added: z.int().min(0),
  removed: z.int().min(0),
  unknown: z.int().min(0),
});

export const analysisRunUnknownTransitionsSchema = z.strictObject({
  resolved: z.int().min(0),
  reopened: z.int().min(0),
  unchanged: z.int().min(0),
  added: z.int().min(0),
  removed: z.int().min(0),
  unknown: z.int().min(0),
});

export const analysisRunComparisonSummarySchema = z.strictObject({
  total_items: z.int().min(0),
  unchanged: z.int().min(0),
  presentation_only: z.int().min(0),
  changed: z.int().min(0),
  added: z.int().min(0),
  removed: z.int().min(0),
  unknown: z.int().min(0),
  by_kind: z.strictObject({
    procedure: z.strictObject({
      unchanged: z.int().min(0),
      changed: z.int().min(0),
      added: z.int().min(0),
      removed: z.int().min(0),
      unknown: z.int().min(0),
    }),
    finding: z.strictObject({
      unchanged: z.int().min(0),
      changed: z.int().min(0),
      added: z.int().min(0),
      removed: z.int().min(0),
      unknown: z.int().min(0),
    }),
    obligation: analysisRunObligationTransitionsSchema,
    residual_unknown: analysisRunUnknownTransitionsSchema,
  }),
});

export const analysisRunComparisonReportSchema = z.strictObject({
  comparison_id: comparisonIdSchema,
  status: z.enum(["unchanged", "changed", "unknown"]),
  result_type: supportedAnalysisRunResultTypeSchema,
  operation: z.string().min(1),
  predicate_type: z.string().min(1),
  same_artifact_sha256: z.boolean().nullable(),
  left_run: z.strictObject({
    run_id: z.string().min(1),
    evidence_id: evidenceIdSchema,
    subject_sha256: digestSchema.nullable(),
    provider_id: z.string().min(1),
  }),
  right_run: z.strictObject({
    run_id: z.string().min(1),
    evidence_id: evidenceIdSchema,
    subject_sha256: digestSchema.nullable(),
    provider_id: z.string().min(1),
  }),
  ignored_presentation_fields: z.array(z.string().min(1)),
  coverage_delta: analysisRunCoverageDeltaSchema,
  summary: analysisRunComparisonSummarySchema,
  changes: z.array(analysisRunItemDeltaSchema),
  items: z.array(analysisRunItemDeltaSchema),
  limitations: z.array(z.string().min(1)),
});

export type AnalysisRunComparisonReport = z.infer<
  typeof analysisRunComparisonReportSchema
>;

export interface NormalizedComparisonItem {
  readonly item_kind: AnalysisRunItemKind;
  readonly item_key: string;
  readonly matching_rule: AnalysisRunMatchingRule;
  readonly record_pointer: string;
  readonly evidence_ids: readonly string[];
  readonly semantic_fields: Readonly<Record<string, JsonValue>>;
  readonly presentation_fields: Readonly<Record<string, JsonValue>>;
  readonly semantic_digest: string;
  readonly obligation_status?: AnalysisRunObligationStatus;
  readonly unknown_status?:
    | "open"
    | "investigating"
    | "blocked"
    | "contradicted"
    | "resolved";
}
