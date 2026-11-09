import { readArtifactInspectionSources } from "../domain/artifactInspection.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { tryParseEvidence, type Evidence } from "../domain/evidence.js";
import { jsonValueByteLength } from "../domain/jsonValueByteLength.js";
import { err, ok, type Result } from "../domain/result.js";

/** Resolve the embedded publication closure without reinterpreting it in delivery adapters. */
export const analysisEvidenceSources = (
  complete: Evidence,
): Result<Evidence[], AnalysisError> => {
  const embedded =
    complete.operation === "inspect_artifact"
      ? readArtifactInspectionSources(complete.normalized_result)
      : ok([]);
  if (!embedded.ok)
    return err(embedded.error.retainPartialObservation(complete));
  return ok([...embedded.value, complete]);
};

/** Matches the diagnostics allowance retained for other finalized one-shot work. */
const SOURCE_CLOSURE_INLINE_BYTES = 64 * 1024;
/** Identities beyond this stay counted; direct links remain on the observation. */
const SOURCE_CLOSURE_LISTED_OMISSIONS = 64;
const SOURCE_CLOSURE_RECOVERY =
  "No bundle was written and this invocation retains nothing after exit. Keep any records shown here, or run the operation again after following remediation; that is a new observation and may differ.";

/** What a failed one-shot delivery holds for one record its observation cites. */
export type SourceClosureOmission = {
  readonly evidence_id: string;
  /**
   * `not_captured`: this invocation holds no such record, so none can be shown.
   * `not_inlined`: captured, but not part of this bounded failure response.
   */
  readonly reason: "not_captured" | "not_inlined";
};

/** Bounded failure handoff for a completed observation whose bundle never committed. */
export type UndeliveredSourceClosure = {
  readonly publication: "not_published";
  /** Every cited record is in `records` or embedded in the observation itself. */
  readonly complete: boolean;
  readonly records: Evidence[];
  readonly omitted_count: number;
  readonly omitted: SourceClosureOmission[];
  readonly recovery: string;
};

/** The closure state is unknown because examining it failed. */
export type UnavailableSourceClosure = {
  readonly publication: "not_published";
  readonly complete: false;
  readonly collection_failure: string;
  readonly recovery: string;
};

const collectSourceClosure = (
  observation: Evidence,
  captured: readonly Evidence[],
  options: { readonly inlineRecords: boolean },
): UndeliveredSourceClosure | undefined => {
  const inspection = analysisEvidenceSources(observation);
  const embedded = new Map(
    (inspection.ok ? inspection.value : []).map((record) => [
      record.evidence_id,
      record,
    ]),
  );
  const held = new Map(captured.map((record) => [record.evidence_id, record]));
  // Set iteration reaches entries added while it runs, which makes this a
  // deduplicating breadth-first queue: directly cited records spend the
  // allowance first, and each link costs one lookup however often it repeats.
  const closure = new Set([observation.evidence_id]);
  for (const evidenceId of observation.evidence_links) closure.add(evidenceId);
  for (const evidenceId of held.keys()) closure.add(evidenceId);
  const records: Evidence[] = [];
  const omitted: SourceClosureOmission[] = [];
  let omittedCount = 0;
  let inlineBytes = options.inlineRecords ? SOURCE_CLOSURE_INLINE_BYTES : 0;
  const omit = (
    evidenceId: string,
    reason: SourceClosureOmission["reason"],
  ) => {
    omittedCount += 1;
    if (omitted.length < SOURCE_CLOSURE_LISTED_OMISSIONS)
      omitted.push({ evidence_id: evidenceId, reason });
  };
  for (const evidenceId of closure) {
    if (evidenceId === observation.evidence_id) continue;
    const inObservation = embedded.get(evidenceId);
    const record = inObservation ?? held.get(evidenceId);
    if (record === undefined) {
      omit(evidenceId, "not_captured");
      continue;
    }
    for (const link of record.evidence_links) closure.add(link);
    if (inObservation !== undefined) continue;
    const bytes = jsonValueByteLength(record, inlineBytes);
    if (bytes > inlineBytes) {
      omit(evidenceId, "not_inlined");
      continue;
    }
    records.push(record);
    inlineBytes -= bytes;
  }
  if (closure.size === 1) return undefined;
  return {
    publication: "not_published",
    complete: omittedCount === 0,
    records,
    omitted_count: omittedCount,
    omitted,
    recovery: SOURCE_CLOSURE_RECOVERY,
  };
};

/**
 * Describe the source closure of a completed observation after delivery failed
 * before commit. Only already captured records are reported, so an unresolved
 * link stays an explicit omission and its own ancestors remain unknown.
 *
 * This annotates a failure that must reach the caller, so it never throws. If
 * examining the closure fails, the state is reported as unknown, naming only
 * the bounded error type rather than a message that could quote analyzed data.
 */
export const undeliveredSourceClosure = (
  partialObservation: unknown,
  captured: readonly Evidence[],
  options: { readonly inlineRecords: boolean },
): UndeliveredSourceClosure | UnavailableSourceClosure | undefined => {
  try {
    const observation = tryParseEvidence(partialObservation);
    return observation === undefined
      ? undefined
      : collectSourceClosure(observation, captured, options);
  } catch (cause: unknown) {
    return {
      publication: "not_published",
      complete: false,
      collection_failure: cause instanceof Error ? cause.name : "unknown",
      recovery: SOURCE_CLOSURE_RECOVERY,
    };
  }
};
