import { unknownTarget } from "./targetIdentity.js";
import {
  createEvidence,
  evidenceEnvelopeForAdmission,
  type Evidence,
  type EvidenceAuthority,
  type EvidenceCreationOptions,
  type EvidenceLocation,
  type EvidenceProvider,
  type EvidenceSubjectTarget,
  type ExecutionEnvironment,
} from "./evidence.js";
import type { AnalysisProfileCommitment } from "./analysisProfile.js";
import type { JsonValue } from "./jsonValue.js";
import type { RelationshipCoverage } from "./relationshipCoverage.js";

/** Provider observations that can be committed to Evidence. */
export interface AnalysisObservation {
  readonly result: JsonValue;
  readonly rawResult: JsonValue | null;
  readonly provider: EvidenceProvider;
  readonly analysisProfile?: AnalysisProfileCommitment;
  readonly limitations: readonly string[];
  /** Provider-owned completeness assessment for caller/callee observations. */
  readonly relationshipCoverage?: RelationshipCoverage;
  readonly locations: readonly EvidenceLocation[];
  /** Atomic source records supplied by the producer, with links derived from their identities. */
  readonly sourceEvidence?: readonly Evidence[];
  /**
   * Missing means the selected operation's default subject should be bound by
   * its caller. Explicit null means the observation has no file subject.
   */
  readonly subject?: EvidenceSubjectTarget | null;
  /**
   * The authority the observation itself supports. Missing derives it from the
   * subject, which a service REA does not own cannot name.
   */
  readonly authority?: EvidenceAuthority;
  /** Execution environment descriptor; null means no environment is claimed. */
  readonly environment?: ExecutionEnvironment | null;
  /** Reason the subject identity is unavailable, when no target is supplied. */
  readonly subjectUnavailableReason?: string;
}

/** Build the single borrowed observation used for admission and commitment. */
const analysisExecutionEvidenceInput = (
  operation: string,
  input: unknown,
  execution: AnalysisObservation,
  confidence: "observed" | "derived",
) => ({
  operation,
  parameters: input,
  result: execution.result,
  rawResult: execution.rawResult,
  limitations: execution.limitations,
  ...(execution.analysisProfile === undefined
    ? {}
    : { analysisProfile: execution.analysisProfile }),
  ...(execution.relationshipCoverage === undefined
    ? {}
    : { relationshipCoverage: execution.relationshipCoverage }),
  ...(execution.authority === undefined
    ? {}
    : { authority: execution.authority }),
  locations: execution.locations,
  confidence,
});

/** Borrow the Evidence envelope with links left empty for incremental admission accounting. */
export const analysisExecutionEnvelopeForAdmission = (
  operation: string,
  input: unknown,
  execution: AnalysisObservation,
  callerTarget?: EvidenceCreationOptions["callerTarget"],
) =>
  evidenceEnvelopeForAdmission(
    execution.subject ?? unknownTarget("not-observed"),
    execution.provider,
    analysisExecutionEvidenceInput(operation, input, execution, "observed"),
    callerTarget,
  );

/** Commit identical facts on success and when retaining a completed observation after cancellation. */
export const createAnalysisExecutionEvidence = (
  operation: string,
  input: unknown,
  execution: AnalysisObservation,
  confidence: "observed" | "derived",
  options?: EvidenceCreationOptions,
): Evidence =>
  createEvidence(
    execution.subject ?? unknownTarget("not-observed"),
    execution.provider,
    {
      ...analysisExecutionEvidenceInput(
        operation,
        input,
        execution,
        confidence,
      ),
      evidenceLinks:
        execution.sourceEvidence?.map(({ evidence_id }) => evidence_id) ?? [],
    },
    {
      ...options,
      ...(execution.authority === undefined
        ? {}
        : { authority: execution.authority }),
      ...(execution.environment === undefined
        ? {}
        : { environment: execution.environment }),
      ...(execution.subjectUnavailableReason === undefined
        ? {}
        : { subjectUnavailableReason: execution.subjectUnavailableReason }),
    },
  );
