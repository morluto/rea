import { deflateSync } from "node:zlib";
import { expect, it } from "vitest";
import { pe } from "../../domain/binaryTarget.fixture.js";
import { elfHardeningFixture } from "../hardening/BinaryHardening.fixture.js";
import { elfUnwindSectionlessFixture } from "../elf/ElfUnwindTables.fixture.js";
import {
  compressedElfNoteFixture,
  compressedElfNoteSectionFixture,
} from "../elf/ElfNotes.fixture.js";
import {
  ELF_PT_GNU_EH_FRAME,
  ELF_PT_GNU_RELRO,
  ELF_PT_GNU_STACK,
  ELF_PT_INTERP,
  readElfDirectoryFromBuffer,
  readPeSectionDirectory,
} from "./NativeSectionDirectory.js";

const readDirectory = (bytes: Buffer) => {
  const reader = readPeSectionDirectory(bytes.length);
  let next = reader.next();
  while (!next.done) {
    const { offset, size } = next.value;
    next = reader.next(bytes.subarray(offset, offset + size));
  }
  return next.value;
};

it("classifies a confirmed overlapping PE directory as an unsupported layout", () => {
  expect(() => readDirectory(pe(0x014c, 4))).toThrow(
    expect.objectContaining({
      kind: "unsupported",
      message: expect.stringContaining("overlapping PE header"),
    }),
  );
});

it.each([0x014c, 0x8664])(
  "reads a nonoverlapping PE directory for machine %s",
  (machine) => {
    expect(readDirectory(pe(machine))).toMatchObject({
      format: "pe",
      machine,
      bits: machine === 0x014c ? 32 : 64,
      sections: [],
    });
  },
);

it("does not classify an unconfirmed pointer overlapping DOS data as a PE layout", () => {
  const bytes = pe(0x014c);
  bytes.writeUInt32LE(4, 60);
  expect(() => readDirectory(bytes)).toThrow(
    expect.objectContaining({ kind: "malformed" }),
  );
});

it("admits PT_INTERP, PT_GNU_STACK and PT_GNU_RELRO program headers", () => {
  const directory = readElfDirectoryFromBuffer(
    elfHardeningFixture({ interp: true, gnuRelro: true }),
  );
  expect(directory.elf_type).toBe(3);
  expect(directory.programs.map((program) => program.type)).toEqual(
    expect.arrayContaining([
      1,
      2,
      ELF_PT_INTERP,
      ELF_PT_GNU_STACK,
      ELF_PT_GNU_RELRO,
    ]),
  );
});

it("retains PT_GNU_EH_FRAME with its file and address span", () => {
  const bytes = elfUnwindSectionlessFixture();
  const directory = readElfDirectoryFromBuffer(bytes);
  expect(directory.programs.map((program) => program.type)).toEqual([
    1,
    ELF_PT_GNU_EH_FRAME,
  ]);
  expect(directory.programs[1]).toMatchObject({
    type: ELF_PT_GNU_EH_FRAME,
    header_offset: 64 + 56,
    file_offset: bytes.readBigUInt64LE(64 + 56 + 8),
    virtual_address: bytes.readBigUInt64LE(64 + 56 + 16),
    file_size: bytes.readBigUInt64LE(64 + 56 + 32),
  });
});

it("retains a confirmed overlapping PE when the COFF record extends past EOF", () => {
  const bytes = Buffer.alloc(64);
  bytes.write("MZ", 0, "ascii");
  bytes.write("PE\0\0", 44, "ascii");
  bytes.writeUInt32LE(44, 60);
  expect(() => readDirectory(bytes)).toThrow(
    expect.objectContaining({
      kind: "unsupported",
      message: expect.stringContaining("overlapping PE header"),
    }),
  );
});

it.each([
  ["nonzero bytes", Buffer.from([0xa5, 0x3c])],
  ["zero bytes", Buffer.alloc(2)],
  ["another zlib stream", deflateSync("unmatched section names")],
] as const)(
  "rejects %s inside the declared zlib section-name table",
  (_, suffix) => {
    const bytes = compressedElfNoteFixture();
    const names = readElfDirectoryFromBuffer(bytes).sections[2]!;
    expect(names.offset + names.size).toBe(BigInt(bytes.length));
    const withSuffix = Buffer.concat([bytes, suffix]);
    expect(readElfDirectoryFromBuffer(withSuffix).sections[1]?.name).toBe(
      ".note.gnu.build-id",
    );
    withSuffix.writeBigUInt64LE(
      names.size + BigInt(suffix.length),
      names.header_offset + 32,
    );
    expect(() => readElfDirectoryFromBuffer(withSuffix)).toThrow(
      expect.objectContaining({ kind: "malformed" }),
    );
  },
);

it.each([
  [32, true],
  [32, false],
  [64, true],
  [64, false],
] as const)(
  "retains ELF%i little=%s compression independently of stored section coverage",
  (bits, little) => {
    const bytes = compressedElfNoteSectionFixture(bits, little);
    const initial = readElfDirectoryFromBuffer(bytes).sections[1]!;
    expect(initial).toMatchObject({ compressed: true, file_backed: true });
    expect(readElfDirectoryFromBuffer(bytes).sections[2]).toMatchObject({
      compressed: false,
      file_backed: true,
    });
    // Compression metadata describes the encoding even if its stored range
    // subsequently proves incomplete. It must not be inferred from readability.
    const sizeAt = initial.header_offset + (bits === 64 ? 32 : 20);
    if (bits === 64) {
      if (little) bytes.writeBigUInt64LE(BigInt(bytes.length), sizeAt);
      else bytes.writeBigUInt64BE(BigInt(bytes.length), sizeAt);
    } else if (little) bytes.writeUInt32LE(bytes.length, sizeAt);
    else bytes.writeUInt32BE(bytes.length, sizeAt);
    expect(readElfDirectoryFromBuffer(bytes).sections[1]).toMatchObject({
      compressed: true,
      file_backed: false,
      offset: initial.offset,
      size: BigInt(bytes.length),
    });
  },
);
