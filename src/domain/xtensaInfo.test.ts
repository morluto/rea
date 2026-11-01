import { describe, expect, it } from "vitest";

import { parseXtensaInfo } from "./xtensaInfo.js";

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

/** What ESP-IDF's windowed builds declare. */
const WINDOWED = {
  abi: { status: "declared", abi: "windowed" },
  literals: { status: "declared", literals: "pc-relative" },
} as const;

describe(".xtensa.info declarations", () => {
  it("reads the windowed, PC-relative declarations binutils writes", () => {
    expect(BINUTILS_WINDOWED).toHaveLength(56);
    expect(parseXtensaInfo(BINUTILS_WINDOWED, true)).toEqual(WINDOWED);
  });

  it.each([
    ["USE_ABSOLUTE_LITERALS=0\nABI=1\n", true, "call0", "pc-relative"],
    ["USE_ABSOLUTE_LITERALS=0\nABI=0\n", false, "windowed", "pc-relative"],
    ["ABI=1\nUSE_ABSOLUTE_LITERALS=1\n", true, "call0", "absolute"],
  ] as const)(
    "reads %j with little-endian note words: %s",
    (descriptor, little, abi, literals) => {
      expect(parseXtensaInfo(info(descriptor, little), little)).toEqual({
        abi: { status: "declared", abi },
        literals: { status: "declared", literals },
      });
    },
  );

  it("keeps an undefined declared value as written", () => {
    expect(
      parseXtensaInfo(info("USE_ABSOLUTE_LITERALS=0\nABI=2\n"), true).abi,
    ).toEqual({ status: "unrecognized", value: "2" });
    expect(parseXtensaInfo(info("ABI=-1\n"), true).abi).toEqual({
      status: "unrecognized",
      value: "-1",
    });
    expect(
      parseXtensaInfo(info("USE_ABSOLUTE_LITERALS=2\nABI=0\n"), true),
    ).toEqual({
      abi: WINDOWED.abi,
      literals: { status: "unrecognized", value: "2" },
    });
  });

  it("reports a missing key as absent, not as either binutils value", () => {
    expect(parseXtensaInfo(info("USE_ABSOLUTE_LITERALS=0\n"), true)).toEqual({
      abi: { status: "absent" },
      literals: WINDOWED.literals,
    });
    expect(parseXtensaInfo(info("ABI=0\n"), true)).toEqual({
      abi: WINDOWED.abi,
      literals: { status: "absent" },
    });
  });

  it("finds the Xtensa_Info note after other notes in the section", () => {
    const contents = Buffer.concat([
      elfNote("GNU", 3, Buffer.alloc(20)),
      elfNote("Xtensa_Info", 2, Buffer.from("ABI=1\n\0", "latin1")),
      info("USE_ABSOLUTE_LITERALS=0\nABI=0\n"),
    ]);
    expect(parseXtensaInfo(contents, true)).toEqual(WINDOWED);
  });

  it.each([
    [info("ABI=0\n\0ABI=1\n"), "non-zero bytes after its terminating NUL"],
    [Buffer.concat([info("ABI=0\n"), info("ABI=0\n")]), "more than one"],
    [elfNote("GNU", 1, Buffer.from("ABI=0\n\0", "latin1")), "no Xtensa_Info"],
    [BINUTILS_WINDOWED.subarray(0, 40), "exceeds its table"],
    [
      Buffer.concat([BINUTILS_WINDOWED, Buffer.from([0, 0, 1])]),
      "trailing non-zero bytes",
    ],
    [Buffer.alloc(0), "no Xtensa_Info"],
  ])(
    "leaves every declaration unknown in a malformed note (%#)",
    (contents, reason) => {
      const unknown = {
        status: "unavailable",
        reason: expect.stringContaining(reason),
      };
      expect(parseXtensaInfo(contents, true)).toEqual({
        abi: unknown,
        literals: unknown,
      });
    },
  );

  it.each([
    ["ABI=0\nABI=1\n", "abi", "declares ABI more than once"],
    ["ABI=windowed\n", "abi", "malformed ABI value"],
    ["ABI= 0\n", "abi", "malformed ABI value"],
    [
      "USE_ABSOLUTE_LITERALS=0\nUSE_ABSOLUTE_LITERALS=1\n",
      "literals",
      "declares USE_ABSOLUTE_LITERALS more than once",
    ],
    [
      "USE_ABSOLUTE_LITERALS=no\n",
      "literals",
      "malformed USE_ABSOLUTE_LITERALS value",
    ],
  ] as const)(
    "leaves only the malformed key unknown in %j",
    (malformed, key, reason) => {
      const other = key === "abi" ? "USE_ABSOLUTE_LITERALS=0\n" : "ABI=0\n";
      const parsed = parseXtensaInfo(info(`${other}${malformed}`), true);
      expect(parsed).toEqual({
        ...WINDOWED,
        [key]: {
          status: "unavailable",
          reason: expect.stringContaining(reason),
        },
      });
    },
  );

  it("accepts zero padding shorter than a note header, as inspect_elf_notes does", () => {
    expect(
      parseXtensaInfo(
        Buffer.concat([BINUTILS_WINDOWED, Buffer.alloc(11)]),
        true,
      ),
    ).toEqual(WINDOWED);
  });

  it("does not read big-endian note words as little-endian", () => {
    expect(parseXtensaInfo(BINUTILS_WINDOWED, false)).toMatchObject({
      abi: { status: "unavailable" },
      literals: { status: "unavailable" },
    });
  });
});
