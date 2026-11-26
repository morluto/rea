import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { ok, type Result } from "../../domain/result.js";
import {
  admitInvestigationAuthentication,
  type RecoveryAdmission,
} from "../investigation/InvestigationRetention.js";
import {
  withSessionExecutionProvenance,
  carrySessionExecutionProvenance,
  sessionExecutionEvidenceMetadata,
} from "./SessionEvidenceReuse.js";
import {
  createEvidence,
  evidenceEnvelopeForAdmission,
  type Evidence,
  type EvidenceSubjectInput,
} from "../../domain/evidence.js";
import type { AnalysisExecution } from "../../ports/AnalysisProvider.js";
import { isRecord } from "../../kernel/isRecord.js";

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
  admit?: RecoveryAdmission,
): Result<Evidence, AnalysisError> => {
  const observation = {
    operation: "health",
    parameters: SESSION_LIMITATIONS_FACET,
    ...(execution.analysisProfile === undefined
      ? {}
      : { analysisProfile: execution.analysisProfile }),
    result: { limitations: sessionLimitations },
    confidence: "observed" as const,
    limitations: sessionLimitations,
  };
  const envelope = {
    ...evidenceEnvelopeForAdmission(target, execution.provider, observation),
    ...sessionExecutionEvidenceMetadata(execution),
  };
  const admitted =
    admit === undefined
      ? admitInvestigationAuthentication(envelope, "health", {})
      : admit(envelope, "health", { valueBytes: 0, serializedUtf16Bytes: 0 });
  if (!admitted.ok) return admitted;
  return ok(
    withSessionExecutionProvenance(
      execution,
      createEvidence(target, execution.provider, observation, {
        immutable: true,
      }),
    ),
  );
};

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
  admit?: RecoveryAdmission,
): Result<AnalysisExecution, AnalysisError> => {
  const { sessionLimitations, ...rest } = execution;
  if (sessionLimitations === undefined) return ok(execution);
  if (delivery === "inline" || sessionLimitations.length === 0)
    return ok(carrySessionExecutionProvenance(execution, rest));
  const materialized = sessionLimitationContextEvidence(
    execution,
    sessionLimitations,
    target,
    admit,
  );
  if (!materialized.ok) return materialized;
  const context = materialized.value;
  const shared = new Set(sessionLimitations);
  return ok(
    carrySessionExecutionProvenance(execution, {
      ...rest,
      limitations: [
        ...execution.limitations.filter((entry) => !shared.has(entry)),
        sessionLimitationReference(context, sessionLimitations.length),
      ],
      sourceEvidence: [...(execution.sourceEvidence ?? []), context],
    }),
  );
};

const isSessionLimitationContext = (source: Evidence): boolean =>
  source.operation === "health" &&
  isRecord(source.parameters) &&
  source.parameters.facet === SESSION_LIMITATIONS_FACET.facet;

/**
 * Restore the full text of session limitations that a result references, from
 * the context record it links. Writers whose output outlives the session, such
 * as a decompile_all directory, use this so their files stay self-describing.
 */
export const inlineLinkedSessionLimitations = (
  execution: AnalysisExecution,
): AnalysisExecution => {
  const contexts = new Map<string, readonly string[]>();
  for (const source of execution.sourceEvidence ?? [])
    if (isSessionLimitationContext(source))
      contexts.set(
        sessionLimitationReference(source, source.limitations.length),
        source.limitations,
      );
  if (contexts.size === 0) return execution;
  return carrySessionExecutionProvenance(execution, {
    ...execution,
    limitations: execution.limitations.flatMap(
      (entry) => contexts.get(entry) ?? [entry],
    ),
  });
};
