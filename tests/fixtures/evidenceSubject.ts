import type { Evidence } from "../../src/domain/evidence.js";

type EvidenceSubject = NonNullable<Evidence["subject"]>;

/** Target identity members a test may change on an Evidence subject. */
interface EvidenceSubjectChange {
  readonly sha256?: string;
  readonly format?: string;
  readonly architecture?: string | null;
}

/**
 * Change an Evidence subject's target identity, so a test of a mismatched
 * subject changes what readers see. The result is deliberately not
 * validated: tests use it for refused parents.
 */
export const changedEvidenceSubject = (
  subject: EvidenceSubject,
  change: EvidenceSubjectChange,
): EvidenceSubject =>
  ({
    ...subject,
    identity: { ...subject.identity, ...change },
  }) as EvidenceSubject;
