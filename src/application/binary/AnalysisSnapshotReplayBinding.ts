import type { Evidence } from "../../domain/evidence.js";
import { createInvestigationEvidenceClosureChecker } from "../investigation/InvestigationEvidence.js";

/** Authenticated observation identity and its immediate source records. */
export interface SnapshotReplayBinding {
  readonly evidenceId: string;
  readonly sourceEvidence?: readonly Evidence[];
}

/** Preserve direct links using the snapshot's authenticated immutable records. */
export const snapshotReplayBinding = (
  evidence: Evidence,
  lookup: (id: string) => Evidence | undefined,
  checkClosure = createInvestigationEvidenceClosureChecker({
    evidenceForAnalysis: lookup,
  }),
): SnapshotReplayBinding | null => {
  if (!checkClosure(evidence.evidence_links)) return null;
  const sources: Evidence[] = [];
  for (const id of evidence.evidence_links) {
    const source = lookup(id);
    // An external link without its source cannot be represented by sourceEvidence.
    if (source === undefined) return null;
    sources.push(source);
  }
  // The replay is a new observation with its own replay limitation. Retain
  // its original record as well as the original's immediate sources.
  sources.push(evidence);
  return {
    evidenceId: evidence.evidence_id,
    sourceEvidence: Object.freeze(sources),
  };
};
