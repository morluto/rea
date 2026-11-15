import type { Evidence } from "../../src/domain/evidence.js";

type EvidenceSubject = NonNullable<Evidence["subject"]>;

/** Declaration members a test may change on an Evidence subject. */
interface EvidenceSubjectChange {
  readonly digest?: { readonly sha256: string };
  readonly format?: string;
  readonly architecture?: string | null;
}

/**
 * Change an Evidence subject's declaration together with the target identity
 * it duplicates, so a test of a mismatched subject changes what readers see.
 * The result is deliberately not validated: tests use it for refused parents.
 */
export const changedEvidenceSubject = (
  subject: EvidenceSubject,
  change: EvidenceSubjectChange,
): EvidenceSubject =>
  ({
    ...subject,
    ...change,
    identity: {
      ...subject.identity,
      ...(change.digest === undefined ? {} : { sha256: change.digest.sha256 }),
      ...(change.format === undefined ? {} : { format: change.format }),
      ...(change.architecture === undefined
        ? {}
        : { architecture: change.architecture }),
    },
  }) as EvidenceSubject;
