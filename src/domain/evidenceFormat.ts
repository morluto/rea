import { z } from "zod";

import { isRecord } from "../kernel/isRecord.js";
import { ParseFailureError, unsupportedInput } from "./parseFailure.js";

/**
 * The Evidence format revision this REA release writes and reads.
 *
 * This module owns Evidence format evolution. A bundle and each record declare
 * their revision in `evidence_format`, and readers admit only the current one;
 * anything older is refused with {@link RECREATE_EVIDENCE_GUIDANCE} rather
 * than admitted one optional field at a time. A field added after a revision
 * is optional only while its revision note below names it, and becomes
 * required when the revision advances.
 *
 * Revision 1: the first marked format. Bundles without `evidence_format`
 * (REA 6.x and earlier) are refused, and the 6.7-era artifact inventory
 * summary identities are no longer rebuilt.
 *
 * Revision 2: the Evidence subject names its target identity
 * (`subject.identity`, docs/adr/evidence/target-identity.md). The Evidence ID
 * commits to that identity, including its kind and selection, instead of the
 * subject's digest, format and architecture, so every Evidence ID changes.
 * Each record also declares `evidence_format`, so a standalone record names
 * its format too.
 */
export const EVIDENCE_FORMAT_REVISION = 2;

/** The single recovery for Evidence from an earlier format. */
export const RECREATE_EVIDENCE_GUIDANCE =
  "Recreate observations with the current REA release; re-exporting an earlier bundle does not update its format or identities.";

/** A bundle or record member naming the format revision it was written in. */
export const evidenceFormatSchema = z.literal(EVIDENCE_FORMAT_REVISION, {
  error: `evidence_format must be ${String(EVIDENCE_FORMAT_REVISION)}. ${RECREATE_EVIDENCE_GUIDANCE}`,
});

/** The ParseFailure format names for an Evidence bundle and a standalone record. */
const EVIDENCE_BUNDLE_FORMAT = "evidence-bundle";
const EVIDENCE_RECORD_FORMAT = "evidence-record";

/** A bundle or record written in a format this release does not read. */
export type UnsupportedEvidenceFormat = ParseFailureError<"unsupported">;

/** Recognize this module's refusal of Evidence from another format. */
export const isUnsupportedEvidenceFormat = (
  cause: unknown,
): cause is UnsupportedEvidenceFormat =>
  cause instanceof ParseFailureError &&
  cause.kind === "unsupported" &&
  (cause.failure.format === EVIDENCE_BUNDLE_FORMAT ||
    cause.failure.format === EVIDENCE_RECORD_FORMAT);

const admitFormat = (
  input: object,
  format: typeof EVIDENCE_BUNDLE_FORMAT | typeof EVIDENCE_RECORD_FORMAT,
  noun: string,
): void => {
  const found: unknown = Reflect.get(input, "evidence_format");
  if (found === EVIDENCE_FORMAT_REVISION) return;
  throw unsupportedInput(
    format,
    `${
      found === undefined
        ? `This ${noun} predates format revision ${String(EVIDENCE_FORMAT_REVISION)}`
        : `${noun} format ${JSON.stringify(found)} is not format ${String(EVIDENCE_FORMAT_REVISION)}`
    }, which this REA release reads. ${RECREATE_EVIDENCE_GUIDANCE}`,
    { field: "evidence_format", undecodedContent: true },
  );
};

/** Members every Evidence record has carried, in every release and revision. */
const RECORD_MEMBERS = [
  "evidence_id",
  "provider",
  "predicate_type",
  "operation",
  "normalized_result",
] as const;

/**
 * Refuse a standalone Evidence record from another format before reading its
 * shape, with the same single decision as a bundle. A record declares its
 * revision; an unmarked object is an earlier record only when it has every
 * member records have always carried. Anything else is left to the record
 * schema, so a malformed record reports its schema issues.
 */
export const admitEvidenceRecordFormat = (input: unknown): void => {
  if (!isRecord(input) || !Object.hasOwn(input, "evidence_id")) return;
  if (
    Object.hasOwn(input, "evidence_format") ||
    RECORD_MEMBERS.every((member) => Object.hasOwn(input, member))
  )
    admitFormat(input, EVIDENCE_RECORD_FORMAT, "Evidence record");
};

/**
 * Refuse a bundle, or a record it carries, from another format before reading its shape, so an earlier
 * bundle is reported as one format decision instead of per-field schema
 * failures. Input without a `records` member is not a bundle and is left to
 * the bundle schema (including a standalone Evidence record).
 */
export const admitEvidenceBundleFormat = (input: unknown): void => {
  if (!isRecord(input) || !Object.hasOwn(input, "records")) return;
  admitFormat(input, EVIDENCE_BUNDLE_FORMAT, "Evidence bundle");
  // A current bundle may still carry a record copied from an earlier one.
  if (Array.isArray(input.records))
    for (const record of input.records) admitEvidenceRecordFormat(record);
};
