import { describe, expect, it } from "vitest";

import { parseXtensaInfoAbi } from "./xtensaInfo.js";

/** One ELF note padded to 4-byte words, as GNU as and ld lay it out. */
const elfNote = (
  owner: string,
  type: number,
  descriptor: Buffer,
  little = true,
): Buffer => {
  const name = Buffer.from(`${owner}\0`, "latin1");
  const words = (length: number) => Math.ceil(length / 4) * 4;
  const bytes = Buffer.alloc(
    12 + words(name.length) + words(descriptor.length),
  );
  const write = (value: number, offset: number) =>
    little
      ? bytes.writeUInt32LE(value, offset)
      : bytes.writeUInt32BE(value, offset);
  write(name.length, 0);
  write(descriptor.length, 4);
  write(type, 8);
  name.copy(bytes, 12);
  descriptor.copy(bytes, 12 + words(name.length));
  return bytes;
};

// `.xtensa.info` as GNU ld 2.43.1 (Espressif esp-14.2.0_20251107) writes it for
// a windowed ESP32 link; Espressif's ESP32, ESP32-S2 and ESP32-S3 ROM ELFs carry
// the same 56 bytes.
const BINUTILS_WINDOWED = Buffer.from(
  "0c00000020000000010000005874656e73615f496e666f00" +
    "5553455f4142534f4c5554455f4c4954455241" +
    "4c533d300a4142493d300a0000",
  "hex",
);

const info = (descriptor: string, little = true): Buffer =>
  elfNote("Xtensa_Info", 1, Buffer.from(`${descriptor}\0`, "latin1"), little);

describe(".xtensa.info ABI declarations", () => {
  it("reads the windowed declaration binutils writes", () => {
    expect(BINUTILS_WINDOWED).toHaveLength(56);
    expect(parseXtensaInfoAbi(BINUTILS_WINDOWED, true)).toEqual({
      status: "declared",
      abi: "windowed",
    });
  });

  it.each([
    ["USE_ABSOLUTE_LITERALS=0\nABI=1\n", true, { abi: "call0" }],
    ["USE_ABSOLUTE_LITERALS=0\nABI=0\n", false, { abi: "windowed" }],
    ["ABI=1\nUSE_ABSOLUTE_LITERALS=1\n", true, { abi: "call0" }],
  ] as const)(
    "reads %j with little-endian note words: %s",
    (descriptor, little, expected) => {
      expect(parseXtensaInfoAbi(info(descriptor, little), little)).toEqual({
        status: "declared",
        ...expected,
      });
    },
  );

  it("keeps an undefined declared value as written", () => {
    expect(parseXtensaInfoAbi(info("ABI=2\n"), true)).toEqual({
      status: "unrecognized",
      value: "2",
    });
    expect(parseXtensaInfoAbi(info("ABI=-1\n"), true)).toEqual({
      status: "unrecognized",
      value: "-1",
    });
  });

  it("reports a note without an ABI key as absent, not windowed", () => {
    expect(parseXtensaInfoAbi(info("USE_ABSOLUTE_LITERALS=0\n"), true)).toEqual(
      { status: "absent" },
    );
  });

  it("finds the Xtensa_Info note after other notes in the section", () => {
    const contents = Buffer.concat([
      elfNote("GNU", 3, Buffer.alloc(20)),
      elfNote("Xtensa_Info", 2, Buffer.from("ABI=1\n\0", "latin1")),
      info("ABI=0\n"),
    ]);
    expect(parseXtensaInfoAbi(contents, true)).toEqual({
      status: "declared",
      abi: "windowed",
    });
  });

  it.each([
    [info("ABI=0\nABI=1\n"), "declares ABI more than once"],
    [info("ABI=windowed\n"), "malformed ABI value"],
    [info("ABI= 0\n"), "malformed ABI value"],
    [Buffer.concat([info("ABI=0\n"), info("ABI=0\n")]), "more than one"],
    [elfNote("GNU", 1, Buffer.from("ABI=0\n\0", "latin1")), "no Xtensa_Info"],
    [BINUTILS_WINDOWED.subarray(0, 40), "exceeds its table"],
    [
      Buffer.concat([BINUTILS_WINDOWED, Buffer.from([0, 0, 1])]),
      "trailing non-zero bytes",
    ],
    [Buffer.alloc(0), "no Xtensa_Info"],
  ])("leaves a malformed declaration unknown (%#)", (contents, reason) => {
    const parsed = parseXtensaInfoAbi(contents, true);
    expect(parsed).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining(reason),
    });
  });

  it("accepts zero padding shorter than a note header, as inspect_elf_notes does", () => {
    expect(
      parseXtensaInfoAbi(
        Buffer.concat([BINUTILS_WINDOWED, Buffer.alloc(11)]),
        true,
      ),
    ).toEqual({ status: "declared", abi: "windowed" });
  });

  it("does not read big-endian note words as little-endian", () => {
    expect(parseXtensaInfoAbi(BINUTILS_WINDOWED, false)).toMatchObject({
      status: "unavailable",
    });
  });
});
