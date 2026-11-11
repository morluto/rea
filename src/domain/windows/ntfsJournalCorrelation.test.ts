import { expect, it } from "vitest";

import { createUsnMftCorrelator } from "./ntfsJournalCorrelation.js";

const baseRecord = {
  index: 7,
  sequenceNumber: 2,
  fileOffset: 7168,
  totalBytes: 1024,
  baseRecordReference: null,
  declaredRecordNumber: 7,
  fixups: {
    sequenceNumber: 5,
    entries: 3,
    verifiedSectors: 2,
    coveredSectors: 2,
    mismatchSector: null,
    malformed: false,
  },
};

it("keeps a reused record number unresolved while resolving a full parent reference", () => {
  const correlate = createUsnMftCorrelator([baseRecord]);
  expect(
    correlate({
      fileReference: 0x0001_0000_0000_0007n,
      parentReference: 0x0002_0000_0000_0007n,
    }),
  ).toEqual({
    file: { kind: "unresolved" },
    parent: {
      kind: "matched",
      record: { index: 7, sequenceNumber: 2, fileOffset: 7168 },
    },
  });
});

it("keeps duplicates ambiguous and skips extensions and unverified records", () => {
  const correlate = createUsnMftCorrelator([
    baseRecord,
    { ...baseRecord, fileOffset: 8192 },
    {
      ...baseRecord,
      index: 9,
      declaredRecordNumber: 9,
      baseRecordReference: { recordNumber: 7, sequenceNumber: 2 },
    },
    {
      ...baseRecord,
      index: 9,
      declaredRecordNumber: 9,
      fixups: { ...baseRecord.fixups, verifiedSectors: 1, mismatchSector: 1 },
    },
  ]);
  expect(
    correlate({
      fileReference: 0x0002_0000_0000_0007n,
      parentReference: 0x0002_0000_0000_0009n,
    }),
  ).toEqual({ file: { kind: "ambiguous" }, parent: { kind: "unresolved" } });
});
