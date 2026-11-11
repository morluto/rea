import { FIXUP_SECTOR_BYTES, type MftRecord } from "./ntfsMft.js";
import type { UsnRecord } from "./ntfsUsnJournal.js";

type RecordIdentity = Pick<
  MftRecord,
  "index" | "sequenceNumber" | "fileOffset"
>;

type CorrelatableRecord = RecordIdentity &
  Pick<
    MftRecord,
    | "baseRecordReference"
    | "declaredRecordNumber"
    | "recordNumberMatchesSlot"
    | "fixups"
    | "totalBytes"
    | "extentValid"
  >;
type JournalReferences = Pick<
  UsnRecord,
  "fileReference" | "parentReference"
> & { readonly referenceBytes?: 8 | 16 };

export type MftJournalMatch =
  | { readonly kind: "matched"; readonly record: RecordIdentity }
  | { readonly kind: "unresolved" | "ambiguous" };

export interface UsnMftMatches {
  readonly file: MftJournalMatch;
  readonly parent: MftJournalMatch;
}

/** Build one lookup for a selected MFT, then reuse it for each journal entry. */
export const createUsnMftCorrelator = (
  records: Iterable<CorrelatableRecord>,
): ((entry: JournalReferences) => UsnMftMatches) => {
  const byReference = new Map<bigint, RecordIdentity | null>();
  for (const record of records) {
    // The stream ordinal is the segment number in an acquisition of the
    // logical MFT stream. Extension records do not identify separate files.
    if (
      record.baseRecordReference !== null ||
      record.sequenceNumber === 0 ||
      !record.extentValid ||
      record.fixups.verifiedSectors * FIXUP_SECTOR_BYTES !== record.totalBytes
    )
      continue;
    if (record.recordNumberMatchesSlot === false) continue;

    const reference =
      (BigInt(record.sequenceNumber) << 48n) | BigInt(record.index);
    byReference.set(
      reference,
      byReference.has(reference)
        ? null
        : {
            index: record.index,
            sequenceNumber: record.sequenceNumber,
            fileOffset: record.fileOffset,
          },
    );
  }

  const lookup = (reference: bigint): MftJournalMatch => {
    const record = byReference.get(reference);
    if (record === undefined) return { kind: "unresolved" };
    if (record === null) return { kind: "ambiguous" };
    return { kind: "matched", record };
  };

  return (entry) =>
    entry.referenceBytes === 16
      ? { file: { kind: "unresolved" }, parent: { kind: "unresolved" } }
      : {
          file: lookup(entry.fileReference),
          parent: lookup(entry.parentReference),
        };
};
