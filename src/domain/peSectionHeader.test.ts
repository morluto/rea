import { expect, it } from "vitest";
import { readPeSectionHeader } from "./peSectionHeader.js";

it("reads unsigned COFF fields inside the supplied 40-byte view", () => {
  const header = Buffer.alloc(48, 0xff).subarray(4, 44);
  header.fill(0);
  header.write("section8", "latin1");
  header.writeUInt32LE(0xfedcba98, 8);
  header.writeUInt32LE(0x87654321, 12);
  header.writeUInt32LE(0x10203040, 16);
  header.writeUInt32LE(0xabcdef01, 20);
  header.writeUInt32LE(0x80000040, 36);
  expect(readPeSectionHeader(header)).toEqual({
    ok: true,
    value: {
      name: "section8",
      virtual_size: 0xfedcba98,
      virtual_address: 0x87654321,
      raw_size: 0x10203040,
      offset: 0xabcdef01,
      characteristics: 0x80000040,
      size: 0x10203040,
    },
  });
  for (let size = 0; size < header.length; size++)
    expect(readPeSectionHeader(header.subarray(0, size))).toMatchObject({
      ok: false,
      error: { kind: "malformed" },
    });
});
