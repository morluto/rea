import { z } from "zod";

import {
  AnalysisInputError,
  AnalysisProtocolError,
  type AnalysisError,
} from "../domain/errors.js";
import type { Evidence } from "../domain/evidence.js";
import { projectInputIssues } from "../domain/inputIssueProjection.js";
import { compareJavaScriptApplicationVersions } from "../domain/javascriptApplicationVersionComparison.js";
import { compareApplicationVersionsInputSchema } from "../domain/javascriptApplicationVersionComparisonSchemas.js";
import { traceApplicationFeature } from "../domain/javascriptFeatureTrace.js";
import { traceApplicationFeatureInputSchema } from "../domain/javascriptFeatureTraceSchemas.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  parseApplicationGraphEvidence,
  parseNativeApplicationEvidence,
} from "./JavaScriptApplicationEvidenceGraph.js";
import {
  createApplicationFeatureTraceEvidence,
  createApplicationVersionComparisonEvidence,
} from "./JavaScriptApplicationWorkflowEvidence.js";

/** Authenticate Evidence and derive one bounded cross-layer feature trace. */
export const traceApplicationFeatureEvidence = (
  rawInput: unknown,
): Result<Evidence, AnalysisError> => {
  const operation = "trace_application_feature";
  const parsed = traceApplicationFeatureInputSchema.safeParse(rawInput);
  if (!parsed.success)
    return err(
      new AnalysisInputError(
        operation,
        undefined,
        projectInputIssues(parsed.error.issues, rawInput),
      ),
    );
  return traceApplicationFeatureEvidenceValidated(parsed.data);
};

/** Derive one feature trace from input parsed by a trusted adapter. */
export const traceApplicationFeatureEvidenceValidated = (
  input: z.output<typeof traceApplicationFeatureInputSchema>,
): Result<Evidence, AnalysisError> => {
  const operation = "trace_application_feature";
  try {
    const source = parseApplicationGraphEvidence(input.application);
    const nativeEvidence = parseNativeApplicationEvidence(
      input.native_observations,
    );
    const result = traceApplicationFeature({
      sourceEvidenceId: source.evidence.evidence_id,
      graph: source.graph,
      nativeEvidence,
      seed: input.seed,
      direction: input.direction,
      limits: input.limits,
    });
    return ok(
      createApplicationFeatureTraceEvidence(
        {
          application_evidence_id: source.evidence.evidence_id,
          native_evidence_ids: nativeEvidence.map(({ evidence_id: id }) => id),
          seed: input.seed,
          direction: input.direction,
          limits: input.limits,
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
      new AnalysisInputError(
        operation,
        undefined,
        projectInputIssues(parsed.error.issues, rawInput),
      ),
    );
  return compareApplicationVersionsEvidenceValidated(parsed.data);
};

/** Compare versions from input parsed by a trusted adapter. */
export const compareApplicationVersionsEvidenceValidated = (
  input: z.output<typeof compareApplicationVersionsInputSchema>,
): Result<Evidence, AnalysisError> => {
  const operation = "compare_application_versions";
  try {
    const left = parseApplicationGraphEvidence(input.left);
    const right = parseApplicationGraphEvidence(input.right);
    const leftNative = parseNativeApplicationEvidence(
      input.left_native_observations,
    );
    const rightNative = parseNativeApplicationEvidence(
      input.right_native_observations,
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
      limits: input.limits,
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
          limits: input.limits,
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
    cause instanceof z.ZodError || cause instanceof TypeError
      ? new AnalysisInputError(operation)
      : new AnalysisProtocolError(
          "JavaScript application workflow produced an invalid result",
          { cause },
        ),
  );
