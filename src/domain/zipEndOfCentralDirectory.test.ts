import { expect, it } from "vitest";
import { zipEndOfCentralDirectoryCandidates } from "./zipEndOfCentralDirectory.js";

// Wire sizes for the fixture and its expectations are independent of the reader.
const CLASSIC_END_RECORD_BYTES = 22;
const MAXIMUM_COMMENT_BYTES = 65_535;

const record = (
  bytes: Uint8Array,
  offset: number,
  commentLength: number,
): DataView => {
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset + offset,
    CLASSIC_END_RECORD_BYTES,
  );
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(20, commentLength, true);
  return view;
};

it("preserves raw disk/count/Zip64 sentinel declarations from a nonzero byte window", () => {
  const backing = Buffer.alloc(51, 0xa5);
  const window = backing.subarray(7, 44);
  const view = record(window, 12, 3);
  view.setUint16(4, 0xffff, true);
  view.setUint16(6, 0x1234, true);
  view.setUint16(8, 0xabcd, true);
  view.setUint16(10, 0xffff, true);
  view.setUint32(12, 0xffffffff, true);
  view.setUint32(16, 0xffffffff, true);
  const before = Buffer.from(backing);
  const candidates = [...zipEndOfCentralDirectoryCandidates(window)];
  expect(backing.equals(before)).toBe(true);
  backing.fill(0);
  expect(candidates).toEqual([
    {
      offset: 12,
      disk: 0xffff,
      directoryDisk: 0x1234,
      entriesOnDisk: 0xabcd,
      totalEntries: 0xffff,
      directorySize: 0xffffffff,
      directoryOffset: 0xffffffff,
      commentLength: 3,
    },
  ]);
});

it("observes every exact-ending candidate latest first without resolving ambiguity", () => {
  const bytes = Buffer.alloc(CLASSIC_END_RECORD_BYTES * 2);
  record(bytes, 0, CLASSIC_END_RECORD_BYTES);
  record(bytes, CLASSIC_END_RECORD_BYTES, 0);
  expect(
    [...zipEndOfCentralDirectoryCandidates(bytes)].map(({ offset }) => offset),
  ).toEqual([CLASSIC_END_RECORD_BYTES, 0]);
});

it("includes the oldest candidate permitted by the maximum ZIP comment", () => {
  const bytes = Buffer.alloc(
    CLASSIC_END_RECORD_BYTES + MAXIMUM_COMMENT_BYTES + 9,
    0xa5,
  );
  record(bytes, 9, MAXIMUM_COMMENT_BYTES);
  expect(
    [...zipEndOfCentralDirectoryCandidates(bytes)].map(
      ({ offset, commentLength }) => ({ offset, commentLength }),
    ),
  ).toEqual([{ offset: 9, commentLength: MAXIMUM_COMMENT_BYTES }]);
});

it("does not promote short records or non-ending EOCD-like bytes to candidates", () => {
  const bytes = Buffer.alloc(CLASSIC_END_RECORD_BYTES + 3);
  record(bytes, 0, 0);
  expect([...zipEndOfCentralDirectoryCandidates(bytes)]).toEqual([]);
  for (let observed = 0; observed < CLASSIC_END_RECORD_BYTES; observed++)
    expect([
      ...zipEndOfCentralDirectoryCandidates(bytes.subarray(0, observed)),
    ]).toEqual([]);
  bytes[0] = 0;
  expect([
    ...zipEndOfCentralDirectoryCandidates(
      bytes.subarray(0, CLASSIC_END_RECORD_BYTES),
    ),
  ]).toEqual([]);
});
