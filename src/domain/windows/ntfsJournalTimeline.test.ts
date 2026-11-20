import { expect, it } from "vitest";

import { composeNtfsJournalTimeline } from "./ntfsJournalTimeline.js";
import { parseMftIndex } from "./ntfsMft.js";

it("keeps exact USN values and coverage rows on bounded source-order pages", () => {
  const record = Buffer.alloc(1024);
  record.write("FILE");
  record.writeUInt16LE(48, 4);
  record.writeUInt16LE(3, 6);
  record.writeUInt16LE(1, 48);
  record.writeUInt16LE(1, 510);
  record.writeUInt16LE(1, 1022);
  record.writeUInt16LE(2, 16);
  record.writeUInt16LE(56, 20);
  record.writeUInt32LE(64, 24);
  record.writeUInt32LE(1024, 28);
  record.writeUInt32LE(0xffff_ffff, 56);
  const mft = parseMftIndex(record);
  if (!mft.ok) throw new Error(mft.error.message);

  const journal = Buffer.alloc(72);
  journal.writeUInt32LE(64, 8);
  journal.writeUInt16LE(2, 12);
  journal.writeBigUInt64LE(0x0002_0000_0000_0000n, 16);
  journal.writeBigInt64LE(9007199254740993n, 32);
  journal.writeBigUInt64LE(133000000000000001n, 40);
  journal.writeUInt16LE(60, 66);

  const first = composeNtfsJournalTimeline(mft.value, journal, {
    startFileOffset: 0,
    maxRows: 1,
  });
  expect(first).toEqual({
    rows: [
      { kind: "coverage", issue: { kind: "padding", fileOffset: 0, bytes: 8 } },
    ],
    historyCompleteness: "unknown",
    nextFileOffset: 8,
    mftLimitations: [],
  });

  const second = composeNtfsJournalTimeline(mft.value, journal, {
    startFileOffset: first.nextFileOffset ?? 0,
    maxRows: 1,
  });
  expect(second).toMatchObject({
    rows: [
      {
        kind: "event",
        event: {
          fileOffset: 8,
          usn: "9007199254740993",
          timestampFileTime: "133000000000000001",
          mft: {
            file: { kind: "matched", record: { index: 0, sequenceNumber: 2 } },
            parent: { kind: "unresolved" },
          },
        },
      },
    ],
    nextFileOffset: null,
  });
  const changedPrefix = Buffer.from(journal);
  changedPrefix.writeUInt32LE(1, 0);
  expect(
    composeNtfsJournalTimeline(mft.value, changedPrefix, {
      startFileOffset: 8,
      maxRows: 1,
    }),
  ).toEqual(second);
});
