import { z } from "zod";

import {
  compareApplicationVersionsRequestSchema,
  compareJavaScriptExportShapesRequestSchema,
  traceApplicationFeatureRequestSchema,
  type CompareApplicationVersionsRequest,
  type CompareJavaScriptExportShapesRequest,
  type TraceApplicationFeatureRequest,
} from "../contracts/applicationWorkflowInputContracts.js";
import { AnalysisInputError, type AnalysisError } from "../domain/errors.js";
import { projectInputIssues } from "../domain/inputIssueProjection.js";
import { compareApplicationVersionsInputSchema } from "../domain/javascriptApplicationVersionComparisonSchemas.js";
import { compareJavaScriptExportShapesInputSchema } from "../domain/javascriptExportShapeComparisonSchemas.js";
import { traceApplicationFeatureInputSchema } from "../domain/javascriptFeatureTraceSchemas.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  resolveEvidenceReferences,
  type EvidenceLookup,
  type EvidenceSemanticIdentity,
} from "./EvidenceReferenceResolver.js";

const APPLICATION_GRAPH_IDENTITIES = [
  {
    operation: "analyze_javascript_application",
    predicate: "rea.javascript-application-analysis/v1",
  },
  {
    operation: "reconcile_javascript_runtime",
    predicate: "rea.javascript-runtime-reconciliation/v1",
  },
  {
    operation: "project_managed_application_graph",
    predicate: "rea.managed-application-graph/v1",
  },
] as const satisfies readonly EvidenceSemanticIdentity[];

type TraceInput = z.output<typeof traceApplicationFeatureInputSchema>;
type ComparisonInput = z.output<typeof compareApplicationVersionsInputSchema>;
type ExportShapeComparisonInput = z.output<
  typeof compareJavaScriptExportShapesInputSchema
>;

/** Parse and resolve one trace adapter request into its canonical domain input. */
export const resolveTraceApplicationFeatureRequest = (
  input: unknown,
  lookup?: EvidenceLookup,
): Result<TraceInput, AnalysisError> => {
  const parsed = traceApplicationFeatureRequestSchema.safeParse(input);
  return parsed.success
    ? resolveTraceApplicationFeatureRequestValidated(parsed.data, lookup)
    : invalid("trace_application_feature", parsed.error, input);
};

/** Resolve a trace request already parsed by the caller-facing contract. */
export const resolveTraceApplicationFeatureRequestValidated = (
  input: TraceApplicationFeatureRequest,
  lookup?: EvidenceLookup,
): Result<TraceInput, AnalysisError> => {
  const application =
    input.application === undefined
      ? resolveEvidenceReferences(
          lookup,
          input.application_evidence_id === undefined
            ? []
            : [input.application_evidence_id],
          APPLICATION_GRAPH_IDENTITIES,
        )
      : ok([input.application]);
  if (!application.ok) return application;
  const native = resolveEvidenceReferences(
    lookup,
    input.native_observation_evidence_ids,
  );
  if (!native.ok) return native;
  const raw = {
    application: application.value[0],
    native_observations: [...input.native_observations, ...native.value],
    seed: input.seed,
    direction: input.direction,
    limits: input.limits,
  };
  const parsed = traceApplicationFeatureInputSchema.safeParse(raw);
  return parsed.success
    ? ok(parsed.data)
    : invalid("trace_application_feature", parsed.error, raw);
};

/** Parse and resolve one comparison adapter request into canonical input. */
export const resolveCompareApplicationVersionsRequest = (
  input: unknown,
  lookup?: EvidenceLookup,
): Result<ComparisonInput, AnalysisError> => {
  const parsed = compareApplicationVersionsRequestSchema.safeParse(input);
  return parsed.success
    ? resolveCompareApplicationVersionsRequestValidated(parsed.data, lookup)
    : invalid("compare_application_versions", parsed.error, input);
};

/** Resolve a comparison request parsed by the caller-facing contract. */
export const resolveCompareApplicationVersionsRequestValidated = (
  input: CompareApplicationVersionsRequest,
  lookup?: EvidenceLookup,
): Result<ComparisonInput, AnalysisError> => {
  const left = graphEvidence(input.left, input.left_evidence_id, lookup);
  if (!left.ok) return left;
  const right = graphEvidence(input.right, input.right_evidence_id, lookup);
  if (!right.ok) return right;
  const leftNative = resolveEvidenceReferences(
    lookup,
    input.left_native_observation_evidence_ids,
  );
  if (!leftNative.ok) return leftNative;
  const rightNative = resolveEvidenceReferences(
    lookup,
    input.right_native_observation_evidence_ids,
  );
  if (!rightNative.ok) return rightNative;
  const raw = {
    left: left.value,
    right: right.value,
    left_native_observations: [
      ...input.left_native_observations,
      ...leftNative.value,
    ],
    right_native_observations: [
      ...input.right_native_observations,
      ...rightNative.value,
    ],
    limits: input.limits,
    ...(input.unknown_registry_approved === undefined
      ? {}
      : { unknown_registry_approved: input.unknown_registry_approved }),
  };
  const parsed = compareApplicationVersionsInputSchema.safeParse(raw);
  return parsed.success
    ? ok(parsed.data)
    : invalid("compare_application_versions", parsed.error, raw);
};

/** Parse and resolve an export-shape adapter request into canonical input. */
export const resolveCompareJavaScriptExportShapesRequest = (
  input: unknown,
  lookup?: EvidenceLookup,
): Result<ExportShapeComparisonInput, AnalysisError> => {
  const parsed = compareJavaScriptExportShapesRequestSchema.safeParse(input);
  return parsed.success
    ? resolveCompareJavaScriptExportShapesRequestValidated(parsed.data, lookup)
    : invalid("compare_javascript_export_shapes", parsed.error, input);
};

/** Resolve an export-shape request already parsed by the adapter contract. */
export const resolveCompareJavaScriptExportShapesRequestValidated = (
  input: CompareJavaScriptExportShapesRequest,
  lookup?: EvidenceLookup,
): Result<ExportShapeComparisonInput, AnalysisError> => {
  const left = graphEvidence(input.left, input.left_evidence_id, lookup);
  if (!left.ok) return left;
  const right = graphEvidence(input.right, input.right_evidence_id, lookup);
  if (!right.ok) return right;
  const raw = {
    left: left.value,
    right: right.value,
    left_module_path: input.left_module_path,
    left_export_name: input.left_export_name,
    right_module_path: input.right_module_path,
    right_export_name: input.right_export_name,
    limits: input.limits,
    ...(input.unknown_registry_approved === undefined
      ? {}
      : { unknown_registry_approved: input.unknown_registry_approved }),
  };
  const parsed = compareJavaScriptExportShapesInputSchema.safeParse(raw);
  return parsed.success
    ? ok(parsed.data)
    : invalid("compare_javascript_export_shapes", parsed.error, raw);
};

const graphEvidence = (
  evidence:
    | CompareApplicationVersionsRequest["left"]
    | CompareJavaScriptExportShapesRequest["left"],
  evidenceId: string | undefined,
  lookup: EvidenceLookup | undefined,
) => {
  if (evidence !== undefined) return ok(evidence);
  const resolved = resolveEvidenceReferences(
    lookup,
    evidenceId === undefined ? [] : [evidenceId],
    APPLICATION_GRAPH_IDENTITIES,
  );
  return resolved.ok ? ok(resolved.value[0]) : resolved;
};

const invalid = <Value>(
  operation: string,
  cause: z.ZodError,
  input: unknown,
): Result<Value, AnalysisInputError> =>
  err(
    new AnalysisInputError(
      operation,
      undefined,
      projectInputIssues(cause.issues, input),
    ),
  );
