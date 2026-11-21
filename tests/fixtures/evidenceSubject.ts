import {
  evidenceSubject,
  evidenceSubjectDisplay,
  evidenceSubjectTarget,
  type Evidence,
  type EvidenceSubjectTarget,
} from "../../src/domain/evidence.js";
import { unknownTarget } from "../../src/domain/targetIdentity.js";

type EvidenceSubject = Evidence["subject"];

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

/** Change a subject's display facts without validating the result. */
export const displayedEvidenceSubject = (
  subject: EvidenceSubject,
  display: { readonly name?: string; readonly local_path?: string },
): EvidenceSubject => ({ ...subject, ...display }) as EvidenceSubject;

/** The file identity of a subject a test expects to name a file. */
export const fileIdentity = (
  subject: EvidenceSubject | undefined,
): Extract<EvidenceSubject["identity"], { kind: "file" }> => {
  if (subject?.identity.kind !== "file")
    throw new Error("Expected an Evidence subject that names a file");
  return subject.identity;
};

/** The display facts of a subject a test expects to name a file. */
export const fileSubjectDisplay = (
  subject: EvidenceSubject | undefined,
): { readonly name: string; readonly local_path: string } => {
  const display = evidenceSubjectDisplay({ subject });
  if (display === undefined)
    throw new Error("Expected an Evidence subject that names a file");
  return display;
};

/** A producer target for the file a subject names, without its display name. */
export const fileSubjectTarget = (
  subject: EvidenceSubject | undefined,
): EvidenceSubjectTarget => {
  const target = evidenceSubjectTarget(subject);
  if (target === undefined)
    throw new Error("Expected an Evidence subject that names a file");
  const { name: _name, ...withoutName } = target;
  return withoutName;
};

/** The architecture member of the file target a subject names, when it has one. */
export const fileSubjectArchitecture = (
  subject: EvidenceSubject | undefined,
): Pick<EvidenceSubjectTarget, "architecture"> => {
  const { architecture } = fileSubjectTarget(subject);
  return architecture === undefined ? {} : { architecture };
};

/** A subject whose target identity was not observed. */
export const UNKNOWN_EVIDENCE_SUBJECT: EvidenceSubject = evidenceSubject(
  unknownTarget("not-observed"),
);
