import {
  REA_WORKFLOW_PROVIDER,
  workflowAnalysisProfile,
} from "./InvestigationProviders.js";
import type { AnalysisOperation } from "./AnalysisProvider.js";
import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import type { WorkflowSnapshotRecordInput } from "./binary/BinarySessionRecords.js";
import {
  analysisProfileSchema,
  committedProviderSchema,
} from "../domain/analysisProfile.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import type { JsonValue } from "../domain/jsonValue.js";

/** Build the shared Evidence record for a successful composed binary workflow. */
export const createWorkflowEvidence = (input: {
  readonly target: BinaryTarget | undefined;
  readonly operation: AnalysisOperation;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly result: JsonValue;
  readonly upstreamProfile: AnalysisProfileCommitment | undefined;
}): Evidence =>
  createEvidence(input.target, REA_WORKFLOW_PROVIDER, {
    operation: input.operation,
    parameters: input.parameters,
    result: input.result,
    ...(input.upstreamProfile === undefined
      ? {}
      : { analysisProfile: workflowAnalysisProfile(input.upstreamProfile) }),
    confidence: "derived",
    limitations: ["Derived by an REA composed workflow."],
  });

/** Convert workflow Evidence into its exact replay binding, when it has a profile. */
export const workflowSnapshotRecord = (
  evidence: Evidence,
  operation: AnalysisOperation,
): WorkflowSnapshotRecordInput | undefined => {
  if (!("analysis_profile" in evidence)) return undefined;
  return {
    operation,
    parameters: evidence.parameters,
    execution: {
      result: evidence.normalized_result,
      rawResult: evidence.raw_result,
      provider: committedProviderSchema.parse(evidence.provider),
      analysisProfile: analysisProfileSchema.parse(evidence.analysis_profile),
      limitations: evidence.limitations,
      locations: evidence.locations,
      subject:
        evidence.subject === null
          ? null
          : {
              path: evidence.subject.local_path,
              sha256: evidence.subject.digest.sha256,
              format: evidence.subject.format,
              ...(evidence.subject.architecture === null
                ? {}
                : { architecture: evidence.subject.architecture }),
            },
    },
  };
};
