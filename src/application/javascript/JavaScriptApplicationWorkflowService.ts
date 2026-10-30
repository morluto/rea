import {
  resolveEvidenceInput,
  type EvidenceLookup,
} from "../EvidenceInputResolver.js";
import { retainedEvidenceReferenceSchema } from "../../domain/evidenceReference.js";
import { parseAnalysisInput } from "../AnalysisInput.js";
import type { ResolvedSourceToBundleReference } from "./SourceToBundleReference.js";
import { z } from "zod";

import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Evidence } from "../../domain/evidence.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { compareJavaScriptApplicationVersions } from "../../domain/javascript/javascriptApplicationVersionComparison.js";
import {
  compareApplicationVersionsInputSchema,
  applicationVersionIdentitiesSchema,
  type ApplicationVersionComparisonResult,
} from "../../domain/javascript/javascriptApplicationVersionComparisonSchemas.js";
import { compareJavaScriptExportShapes } from "../../domain/javascript/javascriptExportShapeComparison.js";
import {
  compareJavaScriptExportShapesInputSchema,
  javaScriptExportShapeIdentitiesSchema,
  type JavaScriptExportShapeComparisonResult,
} from "../../domain/javascript/javascriptExportShapeComparisonSchemas.js";
import { traceApplicationFeature } from "../../domain/javascript/javascriptFeatureTrace.js";
import {
  traceApplicationFeatureInputSchema,
  applicationTraceIdentitiesSchema,
  type ApplicationFeatureTraceResult,
} from "../../domain/javascript/javascriptFeatureTraceSchemas.js";
import { err, ok, type Result } from "../../domain/result.js";
import { compareSourceToBundle } from "../../domain/javascript/sourceToBundleComparison.js";
import {
  compareSourceToBundleInputSchema,
  type SourceToBundleComparisonResult,
} from "../../domain/javascript/sourceToBundleComparisonSchemas.js";
import {
  applicationGraphEvidenceInputError,
  parseApplicationGraphEvidence,
  parseNativeApplicationEvidence,
  type ApplicationGraphEvidenceSource,
} from "./JavaScriptApplicationEvidenceGraph.js";
import {
  createApplicationFeatureTraceEvidence,
  createApplicationVersionComparisonEvidence,
  createJavaScriptExportShapeComparisonEvidence,
  createSourceToBundleComparisonEvidence,
} from "./JavaScriptApplicationWorkflowEvidence.js";

/** Completed workflow facts and authenticated sources retained for adapter delivery. */
export interface ApplicationWorkflowExecution<Projection> {
  readonly evidence: Evidence;
  readonly result: Projection;
  readonly sources: readonly Evidence[];
}

// Validate the request frame without cloning source payloads before their owner reads them.
const featureTraceFrameSchema = z.strictObject({
  ...traceApplicationFeatureInputSchema.shape,
  application: z.unknown().nonoptional(),
  native_observations: z.array(z.unknown()).default([]),
});
const versionComparisonFrameSchema = z.strictObject({
  ...compareApplicationVersionsInputSchema.shape,
  left: z.unknown().nonoptional(),
  right: z.unknown().nonoptional(),
  left_native_observations: z.array(z.unknown()).default([]),
  right_native_observations: z.array(z.unknown()).default([]),
});
const exportShapeFrameSchema = z.strictObject({
  ...compareJavaScriptExportShapesInputSchema.shape,
  left: z.unknown().nonoptional(),
  right: z.unknown().nonoptional(),
});

const resolveWorkflowEvidence = (
  raw: unknown,
  lookup: EvidenceLookup | undefined,
): Result<unknown, AnalysisError> => {
  const reference = retainedEvidenceReferenceSchema.safeParse(raw);
  return reference.success
    ? resolveEvidenceInput(reference.data, lookup)
    : ok(raw);
};

/** Resolve both selections before authenticating either graph, retaining diagnostic inputs. */
const resolveApplicationGraphPair = (
  operation: string,
  input: { readonly left: unknown; readonly right: unknown },
  lookup: EvidenceLookup | undefined,
): Result<
  {
    readonly left: ApplicationGraphEvidenceSource;
    readonly right: ApplicationGraphEvidenceSource;
    readonly selected: { readonly left: unknown; readonly right: unknown };
  },
  AnalysisError
> => {
  const selectedLeft = resolveWorkflowEvidence(input.left, lookup);
  if (!selectedLeft.ok) return selectedLeft;
  const selectedRight = resolveWorkflowEvidence(input.right, lookup);
  if (!selectedRight.ok) return selectedRight;
  const left = parseApplicationGraphEvidence(selectedLeft.value, ["left"]);
  if (!left.ok)
    return err(applicationGraphEvidenceInputError(operation, left.error));
  const right = parseApplicationGraphEvidence(selectedRight.value, ["right"]);
  if (!right.ok)
    return err(applicationGraphEvidenceInputError(operation, right.error));
  return ok({
    left: left.value,
    right: right.value,
    selected: { left: selectedLeft.value, right: selectedRight.value },
  });
};

/** Authenticate Evidence and derive one bounded cross-layer feature trace. */
export const traceApplicationFeatureEvidence = (
  rawInput: unknown,
  lookup?: EvidenceLookup,
): Result<
  ApplicationWorkflowExecution<ApplicationFeatureTraceResult>,
  AnalysisError
> => {
  const operation = "trace_application_feature";
  const request = parseAnalysisInput(
    operation,
    rawInput,
    featureTraceFrameSchema,
  );
  if (!request.ok) return request;
  const selected = resolveWorkflowEvidence(request.value.application, lookup);
  if (!selected.ok) return selected;
  const input = { ...request.value, application: selected.value };
  const sourceResult = parseApplicationGraphEvidence(input.application, [
    "application",
  ]);
  if (!sourceResult.ok)
    return err(
      applicationGraphEvidenceInputError(operation, sourceResult.error),
    );
  const nativeResult = parseNativeApplicationEvidence(
    input.native_observations,
    ["native_observations"],
  );
  if (!nativeResult.ok)
    return err(
      applicationGraphEvidenceInputError(operation, nativeResult.error),
    );
  const source = sourceResult.value;
  const nativeEvidence = nativeResult.value;
  const identities = applicationTraceIdentitiesSchema.safeParse({
    native_observations: nativeEvidence,
  });
  if (!identities.success)
    return err(
      analysisInputErrorFromIssues(operation, identities.error.issues, input),
    );
  const result = traceApplicationFeature({
    sourceEvidenceId: source.evidence.evidence_id,
    graph: source.graph,
    semanticGraph: source.semanticGraph,
    ...(input.semantic_page === undefined
      ? {}
      : { semanticPage: input.semantic_page }),
    nativeEvidence,
    seed: input.seed,
    direction: input.direction,
  });
  const evidence = createApplicationFeatureTraceEvidence(
    {
      application_evidence_id: source.evidence.evidence_id,
      native_evidence_ids: nativeEvidence.map(({ evidence_id: id }) => id),
      seed: input.seed,
      direction: input.direction,
      ...(input.semantic_page === undefined
        ? {}
        : { semantic_page: input.semantic_page }),
    },
    result,
  );
  return ok({
    evidence,
    result,
    sources: [source.evidence, ...nativeEvidence],
  });
};

/** Authenticate both graphs and derive a tiered cross-version change graph. */
export const compareApplicationVersionsEvidence = (
  rawInput: unknown,
  lookup?: EvidenceLookup,
): Result<
  ApplicationWorkflowExecution<ApplicationVersionComparisonResult>,
  AnalysisError
> => {
  const operation = "compare_application_versions";
  const request = parseAnalysisInput(
    operation,
    rawInput,
    versionComparisonFrameSchema,
  );
  if (!request.ok) return request;
  const pair = resolveApplicationGraphPair(operation, request.value, lookup);
  if (!pair.ok) return pair;
  const { left, right } = pair.value;
  const input = { ...request.value, ...pair.value.selected };
  const leftNativeResult = parseNativeApplicationEvidence(
    input.left_native_observations,
    ["left_native_observations"],
  );
  if (!leftNativeResult.ok)
    return err(
      applicationGraphEvidenceInputError(operation, leftNativeResult.error),
    );
  const rightNativeResult = parseNativeApplicationEvidence(
    input.right_native_observations,
    ["right_native_observations"],
  );
  if (!rightNativeResult.ok)
    return err(
      applicationGraphEvidenceInputError(operation, rightNativeResult.error),
    );
  const leftNative = leftNativeResult.value;
  const rightNative = rightNativeResult.value;
  const identities = applicationVersionIdentitiesSchema.safeParse({
    left: left.evidence,
    right: right.evidence,
    left_native_observations: leftNative,
    right_native_observations: rightNative,
  });
  if (!identities.success)
    return err(
      analysisInputErrorFromIssues(operation, identities.error.issues, input),
    );
  const result = compareJavaScriptApplicationVersions({
    left: {
      evidenceId: left.evidence.evidence_id,
      rootArtifactSha256: left.rootArtifactSha256,
      graph: left.graph,
    },
    right: {
      evidenceId: right.evidence.evidence_id,
      rootArtifactSha256: right.rootArtifactSha256,
      graph: right.graph,
    },
    leftNativeEvidence: leftNative,
    rightNativeEvidence: rightNative,
  });
  const evidence = createApplicationVersionComparisonEvidence(
    {
      left_evidence_id: left.evidence.evidence_id,
      right_evidence_id: right.evidence.evidence_id,
      left_native_evidence_ids: leftNative.map(({ evidence_id: id }) => id),
      right_native_evidence_ids: rightNative.map(({ evidence_id: id }) => id),
    },
    result,
  );
  return ok({
    evidence,
    result,
    sources: [left.evidence, right.evidence, ...leftNative, ...rightNative],
  });
};

/** Compare source and bundle inputs already parsed by a trusted adapter. */
export const compareSourceToBundleEvidence = (
  input: ResolvedSourceToBundleReference &
    Pick<z.output<typeof compareSourceToBundleInputSchema>, "application">,
): Result<
  ApplicationWorkflowExecution<SourceToBundleComparisonResult>,
  AnalysisError
> => {
  const operation = "compare_source_to_bundle";
  const applicationResult = parseApplicationGraphEvidence(input.application, [
    "application",
  ]);
  if (!applicationResult.ok)
    return err(
      applicationGraphEvidenceInputError(operation, applicationResult.error),
    );
  const application = applicationResult.value;
  const result = compareSourceToBundle({
    reference: input.reference,
    application: {
      evidenceId: application.evidence.evidence_id,
      rootArtifactSha256: application.rootArtifactSha256,
      graph: application.graph,
    },
  });
  const evidence = createSourceToBundleComparisonEvidence(
    {
      reference_root_sha256: input.reference.root_sha256,
      application_evidence_id: application.evidence.evidence_id,
      ...(input.reference_source === undefined
        ? {}
        : { reference_source: input.reference_source }),
    },
    result,
  );
  return ok({ evidence, result, sources: [application.evidence] });
};

/**
 * Authenticate both graphs and compare one exact export return shape.
 * @public
 */
export const compareJavaScriptExportShapesEvidence = (
  rawInput: unknown,
  lookup?: EvidenceLookup,
): Result<
  ApplicationWorkflowExecution<JavaScriptExportShapeComparisonResult>,
  AnalysisError
> => {
  const operation = "compare_javascript_export_shapes";
  const request = parseAnalysisInput(
    operation,
    rawInput,
    exportShapeFrameSchema,
  );
  if (!request.ok) return request;
  const pair = resolveApplicationGraphPair(operation, request.value, lookup);
  if (!pair.ok) return pair;
  const { left, right } = pair.value;
  const input = { ...request.value, ...pair.value.selected };
  const identities = javaScriptExportShapeIdentitiesSchema.safeParse({
    left: left.evidence,
    right: right.evidence,
  });
  if (!identities.success)
    return err(
      analysisInputErrorFromIssues(operation, identities.error.issues, input),
    );
  const result = compareJavaScriptExportShapes({
    left: {
      evidenceId: left.evidence.evidence_id,
      graph: left.graph,
      modulePath: input.left_module_path,
      exportName: input.left_export_name,
    },
    right: {
      evidenceId: right.evidence.evidence_id,
      graph: right.graph,
      modulePath: input.right_module_path,
      exportName: input.right_export_name,
    },
  });
  const evidence = createJavaScriptExportShapeComparisonEvidence(
    {
      left_evidence_id: left.evidence.evidence_id,
      right_evidence_id: right.evidence.evidence_id,
      left_module_path: input.left_module_path,
      left_export_name: input.left_export_name,
      right_module_path: input.right_module_path,
      right_export_name: input.right_export_name,
    },
    result,
  );
  return ok({ evidence, result, sources: [left.evidence, right.evidence] });
};
