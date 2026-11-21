import type { MftIndex } from "./ntfsMft.js";
import {
  createUsnMftCorrelator,
  type UsnMftMatches,
} from "./ntfsJournalCorrelation.js";
import {
  readUsnJournal,
  type UsnRecordIssue,
  type UsnRecord,
} from "./ntfsUsnJournal.js";

type JournalEvent = Omit<
  UsnRecord,
  | "fileReference"
  | "parentReference"
  | "usn"
  | "timestampFileTime"
  | "extentSample"
> & {
  readonly fileReference: string;
  readonly parentReference: string;
  readonly usn: string;
  readonly timestampFileTime: string | null;
  readonly extentSample?: readonly {
    readonly fileOffset: number;
    readonly offset: string;
    readonly length: string;
  }[];
  readonly mft: UsnMftMatches;
};

type TimelineRow =
  | { readonly kind: "event"; readonly event: JournalEvent }
  | { readonly kind: "coverage"; readonly issue: UsnRecordIssue };

export interface NtfsJournalTimeline {
  readonly rows: readonly TimelineRow[];
  readonly historyCompleteness: "unknown";
  /** First source offset left out of the delivery window. */
  readonly nextFileOffset: number | null;
  readonly mftLimitations: readonly string[];
}

/** Compose a bounded source-order page for an explicitly paired acquisition. */
export const composeNtfsJournalTimeline = (
  mft: MftIndex,
  journal: Buffer,
  window: { readonly startFileOffset: number; readonly maxRows: number },
  correlate = createUsnMftCorrelator(mft.records),
): NtfsJournalTimeline => {
  const rows: TimelineRow[] = [];
  let nextFileOffset: number | null = null;

  for (const result of readUsnJournal(journal, window.startFileOffset)) {
    const fileOffset = result.ok
      ? result.value.fileOffset
      : result.error.fileOffset;
    if (rows.length >= window.maxRows) {
      nextFileOffset = fileOffset;
      break;
    }
    if (!result.ok) {
      rows.push({ kind: "coverage", issue: result.error });
      continue;
    }

    const entry = result.value;
    const { extentSample, ...fields } = entry;
    rows.push({
      kind: "event",
      event: {
        ...fields,
        fileReference: entry.fileReference.toString(),
        parentReference: entry.parentReference.toString(),
        usn: entry.usn.toString(),
        timestampFileTime: entry.timestampFileTime?.toString() ?? null,
        ...(extentSample === undefined
          ? {}
          : {
              extentSample: extentSample.map((extent) => ({
                fileOffset: extent.fileOffset,
                offset: extent.offset.toString(),
                length: extent.length.toString(),
              })),
            }),
        mft: correlate(entry),
      },
    });
  }

  return {
    rows,
    historyCompleteness: "unknown",
    nextFileOffset,
    mftLimitations: mft.limitations,
  };
};
