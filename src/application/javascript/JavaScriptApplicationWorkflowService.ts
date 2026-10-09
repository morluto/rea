import { z } from "zod";

import {
  AnalysisInputError,
  AnalysisProtocolError,
} from "../../domain/analysisErrorCore.js";
import { type AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Evidence } from "../../domain/evidence.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { compareJavaScriptApplicationVersions } from "../../domain/javascript/javascriptApplicationVersionComparison.js";
import { compareApplicationVersionsInputSchema } from "../../domain/javascript/javascriptApplicationVersionComparisonSchemas.js";
import { compareJavaScriptExportShapes } from "../../domain/javascript/javascriptExportShapeComparison.js";
import { compareJavaScriptExportShapesInputSchema } from "../../domain/javascript/javascriptExportShapeComparisonSchemas.js";
import { traceApplicationFeature } from "../../domain/javascript/javascriptFeatureTrace.js";
import { traceApplicationFeatureInputSchema } from "../../domain/javascript/javascriptFeatureTraceSchemas.js";
import { err, ok, type Result } from "../../domain/result.js";
import { compareSourceToBundle } from "../../domain/javascript/sourceToBundleComparison.js";
import { compareSourceToBundleInputSchema } from "../../domain/javascript/sourceToBundleComparisonSchemas.js";
import {
  applicationGraphEvidenceInputError,
  parseApplicationGraphEvidence,
  parseNativeApplicationEvidence,
} from "./JavaScriptApplicationEvidenceGraph.js";
import {
  createApplicationFeatureTraceEvidence,
  createApplicationVersionComparisonEvidence,
  createJavaScriptExportShapeComparisonEvidence,
  createSourceToBundleComparisonEvidence,
} from "./JavaScriptApplicationWorkflowEvidence.js";

/** Authenticate Evidence and derive one bounded cross-layer feature trace. */
export const traceApplicationFeatureEvidence = (
  rawInput: unknown,
): Result<Evidence, AnalysisError> => {
  const operation = "trace_application_feature";
  const parsed = traceApplicationFeatureInputSchema.safeParse(rawInput);
  if (!parsed.success)
    return err(
      analysisInputErrorFromIssues(operation, parsed.error.issues, rawInput),
    );
  return traceApplicationFeatureEvidenceValidated(parsed.data);
};

/** Derive one feature trace from input parsed by a trusted adapter. */
export const traceApplicationFeatureEvidenceValidated = (
  input: z.output<typeof traceApplicationFeatureInputSchema>,
): Result<Evidence, AnalysisError> => {
  const operation = "trace_application_feature";
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
  try {
    const source = sourceResult.value;
    const nativeEvidence = nativeResult.value;
    const result = traceApplicationFeature({
      sourceEvidenceId: source.evidence.evidence_id,
      graph: source.graph,
      nativeEvidence,
      seed: input.seed,
      direction: input.direction,
    });
    return ok(
      createApplicationFeatureTraceEvidence(
        {
          application_evidence_id: source.evidence.evidence_id,
          native_evidence_ids: nativeEvidence.map(({ evidence_id: id }) => id),
          seed: input.seed,
          direction: input.direction,
        },
        result,
      ),
    );
  } catch (cause: unknown) {
    return workflowFailure(operation, cause);
  }
};

/** Authenticate both graphs and derive a tiered cross-version change graph. */
export const compareApplicationVersionsEvidence = (
  rawInput: unknown,
): Result<Evidence, AnalysisError> => {
  const operation = "compare_application_versions";
  const parsed = compareApplicationVersionsInputSchema.safeParse(rawInput);
  if (!parsed.success)
    return err(
      analysisInputErrorFromIssues(operation, parsed.error.issues, rawInput),
    );
  return compareApplicationVersionsEvidenceValidated(parsed.data);
};

/** Compare versions from input parsed by a trusted adapter. */
export const compareApplicationVersionsEvidenceValidated = (
  input: z.output<typeof compareApplicationVersionsInputSchema>,
): Result<Evidence, AnalysisError> => {
  const operation = "compare_application_versions";
  const leftResult = parseApplicationGraphEvidence(input.left, ["left"]);
  if (!leftResult.ok)
    return err(applicationGraphEvidenceInputError(operation, leftResult.error));
  const rightResult = parseApplicationGraphEvidence(input.right, ["right"]);
  if (!rightResult.ok)
    return err(
      applicationGraphEvidenceInputError(operation, rightResult.error),
    );
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
  try {
    const left = leftResult.value;
    const right = rightResult.value;
    const leftNative = leftNativeResult.value;
    const rightNative = rightNativeResult.value;
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
    return ok(
      createApplicationVersionComparisonEvidence(
        {
          left_evidence_id: left.evidence.evidence_id,
          right_evidence_id: right.evidence.evidence_id,
          left_native_evidence_ids: leftNative.map(({ evidence_id: id }) => id),
          right_native_evidence_ids: rightNative.map(
            ({ evidence_id: id }) => id,
          ),
        },
        result,
      ),
    );
  } catch (cause: unknown) {
    return workflowFailure(operation, cause);
  }
};

/** Compare source and bundle inputs already parsed by a trusted adapter. */
export const compareSourceToBundleEvidenceValidated = (
  input: z.output<typeof compareSourceToBundleInputSchema>,
): Result<Evidence, AnalysisError> => {
  const operation = "compare_source_to_bundle";
  const applicationResult = parseApplicationGraphEvidence(input.application, [
    "application",
  ]);
  if (!applicationResult.ok)
    return err(
      applicationGraphEvidenceInputError(operation, applicationResult.error),
    );
  try {
    const application = applicationResult.value;
    const result = compareSourceToBundle({
      reference: input.reference,
      application: {
        evidenceId: application.evidence.evidence_id,
        rootArtifactSha256: application.rootArtifactSha256,
        graph: application.graph,
      },
    });
    return ok(
      createSourceToBundleComparisonEvidence(
        {
          reference_root_sha256: input.reference.root_sha256,
          application_evidence_id: application.evidence.evidence_id,
        },
        result,
      ),
    );
  } catch (cause: unknown) {
    return workflowFailure(operation, cause);
  }
};

/**
 * Authenticate both graphs and compare one exact export return shape.
 * @public
 */
export const compareJavaScriptExportShapesEvidence = (
  rawInput: unknown,
): Result<Evidence, AnalysisError> => {
  const operation = "compare_javascript_export_shapes";
  const parsed = compareJavaScriptExportShapesInputSchema.safeParse(rawInput);
  if (!parsed.success)
    return err(
      analysisInputErrorFromIssues(operation, parsed.error.issues, rawInput),
    );
  return compareJavaScriptExportShapesEvidenceValidated(parsed.data);
};

/** Compare exact export shapes from input parsed by a trusted adapter. */
export const compareJavaScriptExportShapesEvidenceValidated = (
  input: z.output<typeof compareJavaScriptExportShapesInputSchema>,
): Result<Evidence, AnalysisError> => {
  const operation = "compare_javascript_export_shapes";
  const leftResult = parseApplicationGraphEvidence(input.left, ["left"]);
  if (!leftResult.ok)
    return err(applicationGraphEvidenceInputError(operation, leftResult.error));
  const rightResult = parseApplicationGraphEvidence(input.right, ["right"]);
  if (!rightResult.ok)
    return err(
      applicationGraphEvidenceInputError(operation, rightResult.error),
    );
  try {
    const left = leftResult.value;
    const right = rightResult.value;
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
    return ok(
      createJavaScriptExportShapeComparisonEvidence(
        {
          left_evidence_id: left.evidence.evidence_id,
          right_evidence_id: right.evidence.evidence_id,
          left_module_path: input.left_module_path,
          left_export_name: input.left_export_name,
          right_module_path: input.right_module_path,
          right_export_name: input.right_export_name,
        },
        result,
      ),
    );
  } catch (cause: unknown) {
    return workflowFailure(operation, cause);
  }
};

const workflowFailure = (
  operation: string,
  cause: unknown,
): Result<never, AnalysisError> =>
  err(
    new AnalysisProtocolError(
      `JavaScript application workflow failed while producing ${operation}`,
      { cause },
    ),
  );
