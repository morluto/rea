import {
  createEvidence,
  type Evidence,
  type EvidenceSubjectInput,
} from "../../domain/evidence.js";
import type { AnalysisExecution } from "../../ports/AnalysisProvider.js";

/**
 * How a session delivers the limitations its provider session shares across
 * calls. `inline` keeps them in every result, which suits a one-call session.
 * `reference` states them once in a retained record that each result links.
 */
export type SessionLimitationDelivery = "inline" | "reference";

/** Parameters naming the retained record of a session's shared limitations. */
const SESSION_LIMITATIONS_FACET = { facet: "session-limitations" } as const;

/**
 * The retained record of limitations a provider session shares across calls.
 * Equal facts produce the same record, so its identity names them.
 */
export const sessionLimitationContextEvidence = (
  execution: AnalysisExecution,
  sessionLimitations: readonly string[],
  target: EvidenceSubjectInput,
): Evidence =>
  createEvidence(
    target,
    execution.provider,
    {
      operation: "health",
      parameters: SESSION_LIMITATIONS_FACET,
      ...(execution.analysisProfile === undefined
        ? {}
        : { analysisProfile: execution.analysisProfile }),
      result: { limitations: [...sessionLimitations] },
      confidence: "observed",
      limitations: [...sessionLimitations],
    },
    { immutable: true },
  );

/** The one limitation that stands in for the session's shared facts. */
export const sessionLimitationReference = (
  context: Evidence,
  count: number,
): string =>
  `${String(count)} session limitations also apply; they are stated once in linked Evidence ${context.evidence_id}. Read them with get_evidence_bundle detail records.`;

/**
 * Deliver a provider session's shared limitations as the session selects. In
 * `reference` mode the entries are replaced by one reference to a retained
 * record that the result links, so the full text stays reachable and a bundle
 * that follows links stays self-describing. Equal session facts give every
 * result the same record, so a repeated observation keeps its Evidence.
 */
export const deliverSessionLimitations = (
  execution: AnalysisExecution,
  target: EvidenceSubjectInput,
  delivery: SessionLimitationDelivery,
): AnalysisExecution => {
  const { sessionLimitations, ...rest } = execution;
  if (sessionLimitations === undefined) return execution;
  if (delivery === "inline" || sessionLimitations.length === 0) return rest;
  const context = sessionLimitationContextEvidence(
    execution,
    sessionLimitations,
    target,
  );
  const shared = new Set(sessionLimitations);
  return {
    ...rest,
    limitations: [
      ...execution.limitations.filter((entry) => !shared.has(entry)),
      sessionLimitationReference(context, sessionLimitations.length),
    ],
    sourceEvidence: [...(execution.sourceEvidence ?? []), context],
  };
};
