import { expect, it } from "vitest";
import { readElfNoteHeader } from "./elfNoteLayout.js";

it("keeps byte order and view offsets independent across repeated reads", () => {
  const backing = new Uint8Array(13);
  const first = backing.subarray(0, 12);
  const second = backing.subarray(1);
  backing.set([1, 2]);
  const header = (namesz: number) => ({
    ok: true,
    value: { namesz, descsz: 0, type: 0 },
  });
  expect(readElfNoteHeader(first, true)).toEqual(header(0x0201));
  expect(readElfNoteHeader(first, false)).toEqual(header(0x01020000));
  expect(readElfNoteHeader(second, true)).toEqual(header(2));
  backing[1] = 3;
  expect(readElfNoteHeader(first, true)).toEqual(header(0x0301));
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
    const prefix = new Uint8Array(
      backing.buffer,
      backing.byteOffset + 7,
      backing.byteLength - 7,
    );
    const parsed = readElfNoteHeader(prefix, littleEndian);
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
        error: {
          kind: "malformed",
          message: expect.stringContaining("truncated"),
        },
      });
  },
);

it.each([false, true])(
  "reads note headers at an explicit offset within a shared buffer (littleEndian=%s)",
  (littleEndian) => {
    const table = Buffer.alloc(32, 0);
    const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
    view.setUint32(16, 4, littleEndian);
    view.setUint32(20, 16, littleEndian);
    view.setUint32(24, 3, littleEndian);
    expect(readElfNoteHeader(table, littleEndian, 16)).toEqual({
      ok: true,
      value: { namesz: 4, descsz: 16, type: 3 },
    });
    expect(readElfNoteHeader(table, littleEndian, 24)).toEqual({
      ok: false,
      error: {
        kind: "malformed",
        message: expect.stringContaining("truncated"),
      },
    });
  },
);
