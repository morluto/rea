import type {
  NativeInitializerCoverage,
  NativeInitializerEntry,
  NativeInitializerInspection,
  NativeInitializerKind,
  NativeInitializerName,
  NativeInitializerResolution,
} from "../../domain/native/nativeInitializers.js";
import {
  MAX_NATIVE_INITIALIZER_NAME_BYTES,
  NATIVE_INITIALIZER_LIMITATIONS,
} from "../../domain/native/nativeInitializers.js";
import type { InitializerNotes } from "./initializerNotes.js";

/** Page requested by the caller after schema defaults. */
export interface InitializerPage {
  readonly offset: number;
  readonly limit: number;
}

/** One collected slot before paging. `index` is assigned from file order. */
export interface CollectedInitializer {
  readonly index: number;
  readonly kind: NativeInitializerKind;
  /** Null for DT_INIT / DT_FINI when the dynamic value field is outside every load segment. */
  readonly slotVa: bigint | null;
  readonly slotFileOffset: number | null;
  readonly slotBytes: 4 | 8;
  readonly valueVa: bigint | null;
  readonly valueFileOffset: number | null;
  readonly slotSection: string | null;
  readonly section: string | null;
  readonly symbol: string | null;
  readonly resolution: NativeInitializerResolution;
  readonly detail: string | null;
}

/** Lowercase `0x` hex without leading zeros other than `0x0`. */
export const hexAddress = (value: bigint): string => `0x${value.toString(16)}`;

const fitsName = (name: string | null): name is string =>
  name !== null &&
  name.length > 0 &&
  name.length <= MAX_NATIVE_INITIALIZER_NAME_BYTES;

/** Target-derived text. Empty and over-long names are not reported. */
const untrustedName = (name: string | null): NativeInitializerName | null =>
  fitsName(name) ? { name, trust: "observed-untrusted" } : null;

const pageOf = (
  entries: readonly CollectedInitializer[],
  examined: number,
  page: InitializerPage,
  incomplete: boolean,
): {
  readonly entries: CollectedInitializer[];
  readonly coverage: NativeInitializerCoverage;
} => {
  const returned = entries.slice(page.offset, page.offset + page.limit);
  return {
    entries: returned,
    coverage: {
      status: incomplete ? "incomplete" : "complete",
      examined_entries: examined,
      total_entries: incomplete ? null : entries.length,
      returned_entries: returned.length,
      offset: page.offset,
      limit: page.limit,
    },
  };
};

/** Project one entry after completeness has accounted for all collected names. */
const toEntry = (entry: CollectedInitializer): NativeInitializerEntry => ({
  index: entry.index,
  kind: entry.kind,
  slot_va: entry.slotVa === null ? null : hexAddress(entry.slotVa),
  slot_file_offset: entry.slotFileOffset,
  slot_bytes: entry.slotBytes,
  value_va: entry.valueVa === null ? null : hexAddress(entry.valueVa),
  value_file_offset: entry.valueFileOffset,
  slot_section: untrustedName(entry.slotSection),
  section: untrustedName(entry.section),
  symbol: untrustedName(entry.symbol),
  resolution: entry.resolution,
  detail: untrustedName(entry.detail)?.name ?? null,
});

/**
 * Standing limitations first, then observations from this image. `examined`
 * counts every slot read, including omitted sentinels.
 */
export const finishInitializerReport = (
  body: Omit<
    NativeInitializerInspection,
    "status" | "coverage" | "entries" | "limitations" | "applicability"
  >,
  entries: readonly CollectedInitializer[],
  examined: number,
  notes: InitializerNotes,
  page: InitializerPage,
  incomplete: boolean,
): NativeInitializerInspection => {
  let withheld = 0;
  for (const entry of entries)
    for (const name of [
      entry.slotSection,
      entry.section,
      entry.symbol,
      entry.detail,
    ])
      if (name !== null && name.length > MAX_NATIVE_INITIALIZER_NAME_BYTES)
        withheld += 1;
  const incompleteReport = incomplete || withheld > 0;
  const paged = pageOf(entries, examined, page, incompleteReport);
  const returned = paged.entries.map(toEntry);
  return {
    ...body,
    applicability: "applicable",
    status: incompleteReport ? "incomplete" : "parsed",
    coverage: paged.coverage,
    entries: returned,
    limitations: [
      ...NATIVE_INITIALIZER_LIMITATIONS,
      ...notes.list(),
      ...(withheld === 0
        ? []
        : [
            `${String(withheld)} section, symbol or detail name(s) exceeded the ${String(MAX_NATIVE_INITIALIZER_NAME_BYTES)}-byte name budget and were reported as null.`,
          ]),
    ],
  };
};
