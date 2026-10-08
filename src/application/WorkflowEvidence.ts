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
import type { UnknownRegistryPort } from "./investigation/InvestigationRecordPort.js";
import { UnknownRegistryError } from "../domain/unknownRegistryError.js";

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
      : {
          analysisProfile: workflowAnalysisProfile(
            input.upstreamProfile,
            input.operation,
          ),
        }),
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

interface WorkflowUnknownInput {
  readonly name: string;
  readonly result: JsonValue;
  readonly evidenceId: string;
  readonly recordUnknown: UnknownRegistryPort["recordUnknown"] | undefined;
}

/** Retain residual workflow questions using the shared investigation policy. */
export const recordWorkflowUnknowns = ({
  name,
  result,
  evidenceId,
  recordUnknown,
}: WorkflowUnknownInput):
  | ReturnType<UnknownRegistryPort["recordUnknown"]>
  | { readonly ok: true; readonly value: null } => {
  if (
    !["trace_feature", "trace_call_path", "inspect_native_api"].includes(
      name,
    ) ||
    recordUnknown === undefined ||
    typeof result !== "object" ||
    result === null ||
    Array.isArray(result) ||
    !Array.isArray(result.residual_unknowns)
  )
    return { ok: true, value: null };
  for (const question of result.residual_unknowns) {
    if (typeof question !== "string") continue;
    const recorded = recordUnknown({
      question,
      severity: "medium",
      domain: name === "inspect_native_api" ? "native-api" : "control-flow",
      supporting_evidence_ids: [evidenceId],
      contradicting_evidence_ids: [],
      required_authority: "shipped-artifact",
      required_confidence: "observed",
      required_environment: null,
      recommended_probes: [
        {
          operation: name,
          rationale:
            name === "inspect_native_api"
              ? "Confirm the unsupported boundary with a capable provider or ABI probe."
              : "Continue with a focused query or another available provider.",
        },
      ],
      relationships: [],
    });
    if (
      !recorded.ok &&
      !(
        recorded.error instanceof UnknownRegistryError &&
        recorded.error.reason === "already-exists"
      )
    )
      return recorded;
  }
  return { ok: true, value: null };
};
