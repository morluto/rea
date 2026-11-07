import { expect, it } from "vitest";
import {
  isElfNotePadding,
  readElfNoteHeader,
  readElfNoteRecord,
} from "./elfNoteLayout.js";

const note = (namesz: number, descsz: number, type: number) => {
  const bytes = Buffer.alloc(12);
  bytes.writeUInt32LE(namesz, 0);
  bytes.writeUInt32LE(descsz, 4);
  bytes.writeUInt32LE(type, 8);
  return bytes;
};

// Offsets are stream offsets; each note starts at stream offset 4.
it.each([
  { namesz: 4, descsz: 4, alignment: 4, descriptor: 20, next: 24 },
  // A GNU property note: the descriptor starts at 16 from the note, not 20.
  { namesz: 4, descsz: 4, alignment: 8, descriptor: 20, next: 28 },
  // binutils' Xtensa_Info note.
  { namesz: 12, descsz: 32, alignment: 4, descriptor: 28, next: 60 },
])(
  "locates namesz $namesz descsz $descsz alignment $alignment from the note start",
  ({ alignment, ...expected }) => {
    const stream = Buffer.concat([
      Buffer.alloc(4),
      note(expected.namesz, expected.descsz, 5),
      Buffer.alloc(64),
    ]);
    expect(readElfNoteRecord(stream, 4, true, alignment)).toEqual({
      ok: true,
      value: { ...expected, type: 5 },
    });
  },
);

it("refuses a note whose aligned extent leaves the stream", () => {
  // The 31-byte descriptor ends at the stream end; its padding does not fit.
  const stream = Buffer.concat([
    Buffer.alloc(8),
    note(12, 31, 1),
    Buffer.alloc(43),
  ]);
  expect(readElfNoteRecord(stream, 8, true, 4)).toEqual({
    ok: false,
    error: { kind: "malformed", message: "ELF note entry exceeds its table." },
  });
  expect(readElfNoteRecord(Buffer.alloc(64), 60, true, 4)).toMatchObject({
    ok: false,
    error: { message: "ELF note header is truncated" },
  });
});

it("treats only a zero tail shorter than a note header as padding", () => {
  expect(isElfNotePadding(Buffer.alloc(0))).toBe(true);
  expect(isElfNotePadding(Buffer.alloc(11))).toBe(true);
  expect(isElfNotePadding(Buffer.alloc(12))).toBe(false);
  expect(isElfNotePadding(Buffer.from([0, 1]))).toBe(false);
});

it.each([false, true])(
  "preserves raw note sizes and type without admission (littleEndian=%s)",
  (littleEndian) => {
    const backing = Buffer.alloc(31, 0xa5);
    const bytes = backing.subarray(7, 19);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(0, 0xffffffff, littleEndian);
    view.setUint32(4, 0x80000001, littleEndian);
    view.setUint32(8, 0xfedcba98, littleEndian);
    const before = Buffer.from(backing);
    const parsed = readElfNoteHeader(backing.subarray(7), littleEndian);
    expect(backing.equals(before)).toBe(true);
    backing.fill(0);
    expect(parsed).toEqual({
      ok: true,
      value: { namesz: 0xffffffff, descsz: 0x80000001, type: 0xfedcba98 },
    });
  },
);

it.each([false, true])(
  "refuses incomplete note headers (littleEndian=%s)",
  (littleEndian) => {
    const bytes = Buffer.alloc(19);
    for (let observed = 0; observed < 12; observed++)
      expect(
        readElfNoteHeader(bytes.subarray(7, 7 + observed), littleEndian),
      ).toEqual({
        ok: false,
        error: { kind: "malformed", message: "ELF note header is truncated" },
      });
  },
);
