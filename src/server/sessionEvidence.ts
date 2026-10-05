import type { BinarySessionPort } from "../application/BinarySession.js";
import { EvidenceIntegrityError } from "../domain/evidenceErrors.js";
import type { Evidence } from "../domain/evidence.js";
import { ok, type Result } from "../domain/result.js";

/** Record source evidence in order, stopping at the first session rejection. */
export const recordSessionEvidenceSources = (
  recordEvidence: BinarySessionPort["recordEvidence"] | undefined,
  sources: readonly Evidence[],
): Result<null, EvidenceIntegrityError> => {
  for (const source of sources) {
    const recorded = recordEvidence?.(source);
    if (recorded !== undefined && !recorded.ok) return recorded;
  }
  return ok(null);
};
