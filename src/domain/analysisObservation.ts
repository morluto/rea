import {
  createEvidence,
  evidenceEnvelopeForAdmission,
  type Evidence,
  type EvidenceCreationOptions,
  type EvidenceLocation,
  type EvidenceProvider,
  type EvidenceSubjectTarget,
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
  locations: execution.locations,
  confidence,
});

/** Borrow the Evidence envelope with links left empty for incremental admission accounting. */
export const analysisExecutionEnvelopeForAdmission = (
  operation: string,
  input: unknown,
  execution: AnalysisObservation,
  confidence: "observed" | "derived",
) =>
  evidenceEnvelopeForAdmission(
    execution.subject ?? undefined,
    execution.provider,
    analysisExecutionEvidenceInput(operation, input, execution, confidence),
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
    execution.subject ?? undefined,
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
    options,
  );
