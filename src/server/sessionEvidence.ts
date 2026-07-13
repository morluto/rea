import canonicalize from "canonicalize";

import type { BinarySessionPort } from "../application/BinarySession.js";
import { EvidenceIntegrityError } from "../domain/errors.js";
import { parseEvidence, type Evidence } from "../domain/evidence.js";
import { err, ok, type Result } from "../domain/result.js";

type EvidenceAuthorityResult = Result<Evidence[], EvidenceIntegrityError>;

/** Resolve caller-supplied records to their immutable session-owned values. */
export const resolveSessionEvidence = (
  session: BinarySessionPort,
  input: Evidence | readonly Evidence[],
): EvidenceAuthorityResult => {
  const supplied = Array.isArray(input) ? input : [input];
  const authoritative: Evidence[] = [];
  for (const item of supplied) {
    const parsed = parseEvidence(item);
    const owned = session.evidenceById(parsed.evidence_id);
    if (owned === undefined || canonicalize(owned) !== canonicalize(parsed))
      return err(
        new EvidenceIntegrityError(
          "Comparison input does not match its session-owned Evidence",
        ),
      );
    authoritative.push(owned);
  }
  return ok(authoritative);
};

/** Check exact ownership for a single Evidence record. */
export const isSessionEvidence = (
  session: BinarySessionPort,
  input: Evidence,
): boolean => {
  const owned = session.evidenceById(input.evidence_id);
  return owned !== undefined && canonicalize(owned) === canonicalize(input);
};
