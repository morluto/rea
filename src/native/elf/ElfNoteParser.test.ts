import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { inspectElfNotesInputSchema } from "../../domain/native/elfNotes.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { decodeElfSectionNameTable } from "../metadata/ElfSectionNameTable.js";
import { readElfDirectoryFromBuffer } from "../metadata/NativeSectionDirectory.js";
import {
  androidIdentNote,
  compressedElfNoteFixture,
  compressedElfNoteSectionFixture,
  coreAuxvNote,
  coreFileNote,
  corePrpsinfoNote,
  coreSiginfoNote,
  elfNote,
  elfNoteFixture,
  elfNoteTablePastEnd,
  elfExtendedSectionCountFixture,
  gnuAbiTagNote,
  gnuBuildIdNote,
  gnuPropertyNote,
} from "./ElfNotes.fixture.js";
import {
  ElfNoteSectionNameBudgetFailure,
  parseElfNotes,
} from "./ElfNoteParser.js";

const defaults = inspectElfNotesInputSchema.parse({
  path: "/artifacts/app",
});

const parse = (bytes: Buffer, input: typeof defaults = defaults) =>
  parseElfNotes(
    bytes,
    {
      path: input.path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    },
    input,
  );

const elf64 = (
  fields: {
    readonly phoff?: number;
    readonly shoff?: number;
    readonly phnum?: number;
    readonly shnum?: number;
    readonly phentsize?: number;
    readonly shentsize?: number;
  },
  tail?: Buffer,
): Buffer => {
  const header = Buffer.alloc(64);
  header.write("\x7fELF", 0, "latin1");
  header[4] = 2;
  header[5] = 1;
  header[6] = 1;
  header.writeUInt16LE(2, 16);
  header.writeUInt16LE(62, 18);
  header.writeUInt32LE(1, 20);
  header.writeBigUInt64LE(BigInt(fields.phoff ?? 0), 32);
  header.writeBigUInt64LE(BigInt(fields.shoff ?? 0), 40);
  header.writeUInt16LE(64, 52);
  header.writeUInt16LE(fields.phentsize ?? 56, 54);
  header.writeUInt16LE(fields.phnum ?? 0, 56);
  header.writeUInt16LE(fields.shentsize ?? 64, 58);
  header.writeUInt16LE(fields.shnum ?? 0, 60);
  return tail === undefined ? header : Buffer.concat([header, tail]);
};

it("reads GNU build-id and ABI-tag notes from ELF32 and ELF64", () => {
  for (const bits of [32, 64] as const) {
    const bytes = elfNoteFixture({ bits, ownership: "program" });
    const report = parse(bytes);
    expect(report.format).toBe(bits === 64 ? "elf64" : "elf32");
    expect(report.byte_order).toBe("little");
    expect(report.tables).toHaveLength(1);
    expect(report.tables[0]?.kind).toBe("program");
    const buildId = report.entries.find(
      (entry) => entry.type_name === "gnu_build_id",
    );
    const abi = report.entries.find(
      (entry) => entry.type_name === "gnu_abi_tag",
    );
    expect(buildId?.gnu?.build_id_hex).toBe(
      "0123456789abcdef0123456789abcdef01234567",
    );
    expect(abi?.gnu?.abi_tag).toMatchObject({
      os: 0,
      os_name: "linux",
      major: 3,
      minor: 2,
      subminor: 0,
    });
  }
});

it("reads the same notes from an SHT_NOTE section including its name", () => {
  const report = parse(elfNoteFixture({ ownership: "section" }));
  expect(report.tables).toEqual([
    expect.objectContaining({
      kind: "section",
      name: ".note.gnu.build-id",
    }),
  ]);
  expect(
    report.entries.some((entry) => entry.type_name === "gnu_build_id"),
  ).toBe(true);
});

it.each([
  [32, true],
  [32, false],
  [64, true],
  [64, false],
] as const)(
  "refuses compressed ELF%i %s-endian note storage without parsing its compression header",
  (bits, little) => {
    expect(() => parse(compressedElfNoteSectionFixture(bits, little))).toThrow(
      expect.objectContaining({
        kind: "unsupported",
        message: expect.stringMatching(/compressed.*note/iu),
      }),
    );
  },
);

it("does not allocate the declared decoded note size, but still validates stored ranges", () => {
  const bytes = compressedElfNoteSectionFixture();
  const noteSection = 64 + 64;
  const storedOffset = Number(bytes.readBigUInt64LE(noteSection + 24));
  bytes.writeBigUInt64LE(0xffffffffffffffffn, storedOffset + 8);
  expect(() => parse(bytes)).toThrow(
    expect.objectContaining({ kind: "unsupported" }),
  );
  bytes.writeBigUInt64LE(0n, noteSection + 32);
  expect(() => parse(bytes)).toThrow(
    expect.objectContaining({ kind: "unsupported" }),
  );
  bytes.writeBigUInt64LE(BigInt(bytes.length), noteSection + 32);
  expect(() => parse(bytes)).toThrow(ArtifactReaderFailure);
});

it("preserves unknown ELF64 section flag bits without treating them as file sizes", () => {
  const bytes = elfNoteFixture({ ownership: "section" });
  bytes.writeBigUInt64LE(0x8000000000000000n, 64 + 64 + 8);
  bytes.writeBigUInt64LE(0x8000000000000000n, 64 + 2 * 64 + 8);
  expect(parse(bytes).entries[0]?.gnu?.build_id_hex).toBe(
    "0123456789abcdef0123456789abcdef01234567",
  );
});

it.each([
  [32, true, 1],
  [32, false, 1],
  [64, true, 1],
  [64, false, 1],
  [32, true, 2],
  [32, false, 2],
  [64, true, 2],
  [64, false, 2],
] as const)(
  "decompresses an ELF%i little-endian=%s section-name table using algorithm %i",
  (bits, little, compressionType) => {
    const report = parse(
      compressedElfNoteFixture(bits, little, compressionType),
    );
    expect(report.tables).toEqual([
      expect.objectContaining({ kind: "section", name: ".note.gnu.build-id" }),
    ]);
    expect(report.entries[0]?.gnu?.build_id_hex).toBe(
      "0123456789abcdef0123456789abcdef01234567",
    );
  },
);

it.each([1, 2])(
  "admits a decoded section name larger than algorithm %i storage",
  (compressionType) => {
    const name = "n".repeat(512);
    const bytes = compressedElfNoteFixture(64, true, compressionType, name);
    expect(bytes.length).toBeLessThan(name.length);
    const report = parse(bytes);
    expect(report.tables[0]?.name).toBe(name);
  },
);

it.each([1, 2])(
  "rejects malformed algorithm %i section-name storage",
  (compressionType) => {
    for (const damage of ["corrupt", "truncated", "too-large", "too-small"]) {
      const bytes = compressedElfNoteFixture(64, true, compressionType);
      const sectionOffset = Number(bytes.readBigUInt64LE(40));
      const nameHeader = sectionOffset + bytes.readUInt16LE(62) * 64;
      const namesOffset = Number(bytes.readBigUInt64LE(nameHeader + 24));
      if (damage === "corrupt") bytes[namesOffset + 24] = 0;
      else if (damage === "truncated")
        bytes.writeBigUInt64LE(
          bytes.readBigUInt64LE(nameHeader + 32) - 1n,
          nameHeader + 32,
        );
      else
        bytes.writeBigUInt64LE(
          bytes.readBigUInt64LE(namesOffset + 8) +
            (damage === "too-large" ? 1n : -1n),
          namesOffset + 8,
        );
      expect(() => parse(bytes), damage).toThrow(
        /compressed section-name table/u,
      );
    }
  },
);

it("refuses a Zstandard frame requiring more than the decoder window allowance", () => {
  const header = Buffer.alloc(24);
  header.writeUInt32LE(2, 0);
  header.writeBigUInt64LE(1n, 16);
  // An empty last raw block with Window_Descriptor 0x90: a 2^28-byte window.
  const frame = Buffer.from("28b52ffd0090010000", "hex");
  expect(
    decodeElfSectionNameTable(
      Buffer.concat([header, frame]),
      0x800n,
      64,
      true,
      0,
    ),
  ).toMatchObject({
    state: "malformed",
    message: expect.stringMatching(/memory/iu),
  });
});

it("keeps note facts but marks section names unavailable for unknown compression", () => {
  const report = parse(compressedElfNoteFixture(64, true, 3));
  expect(report.tables[0]?.name).toBeNull();
  expect(report.entries[0]?.gnu?.build_id_hex).toBe(
    "0123456789abcdef0123456789abcdef01234567",
  );
  expect(report.limitations).toContainEqual(
    expect.stringMatching(
      /section names.*unavailable.*compression type 3.*unsupported/iu,
    ),
  );
});

it.each([1, 2])(
  "admits algorithm %i section names when max_file_bytes includes expansion",
  (compressionType) => {
    const bytes = compressedElfNoteFixture(64, true, compressionType);
    const sectionOffset = Number(bytes.readBigUInt64LE(40));
    const nameHeader = sectionOffset + bytes.readUInt16LE(62) * 64;
    const namesOffset = Number(bytes.readBigUInt64LE(nameHeader + 24));
    const decodedNamesBytes = Number(bytes.readBigUInt64LE(namesOffset + 8));
    const minimumMaxFileBytes = bytes.length + decodedNamesBytes;
    const input = inspectElfNotesInputSchema.parse({
      path: defaults.path,
      max_file_bytes: bytes.length + 1,
    });
    let failure: unknown;
    try {
      parse(bytes, input);
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(ElfNoteSectionNameBudgetFailure);
    expect(failure).toMatchObject({
      minimumMaxFileBytes: BigInt(minimumMaxFileBytes),
      selectedMaxFileBytes: bytes.length + 1,
    });

    const admitted = parse(
      bytes,
      inspectElfNotesInputSchema.parse({
        path: defaults.path,
        max_file_bytes: minimumMaxFileBytes,
      }),
    );
    expect(admitted.tables[0]?.name).toBe(".note.gnu.build-id");
  },
);

it("reports independent PT_NOTE and SHT_NOTE declarations of the same bytes", () => {
  const report = parse(elfNoteFixture({ ownership: "both" }));
  expect(report.tables.map((table) => table.kind).sort()).toEqual([
    "program",
    "section",
  ]);
  expect(
    report.entries.filter((entry) => entry.type_name === "gnu_build_id"),
  ).toHaveLength(2);
});

it("reports missing note tables without claiming notes never existed", () => {
  const report = parse(elfNoteFixture({ ownership: "none" }));
  expect(report.tables).toEqual([]);
  expect(report.entries).toEqual([]);
  expect(report.limitations[0]).toMatch(/No PT_NOTE/u);
});

it("fails a truncated note payload without partial success", () => {
  const notes = gnuBuildIdNote();
  notes.writeUInt32LE(64, 0);
  const bytes = elfNoteFixture({ ownership: "program", notes });
  expect(() => parse(bytes)).toThrow(ArtifactReaderFailure);
});

it("keeps non-GNU owners as unknown types with descriptor hashes", () => {
  const payload = Buffer.from("hello");
  const notes = elfNote("CORE", 1, payload);
  const report = parse(elfNoteFixture({ ownership: "program", notes }));
  expect(report.entries[0]).toMatchObject({
    owner: "CORE",
    type_name: "unknown",
    gnu: null,
    core: null,
    android: null,
  });
  expect(report.entries[0]?.descriptor.sha256).toBe(
    createHash("sha256").update(payload).digest("hex"),
  );
});

it("reads a big-endian ELF32 GNU build-id", () => {
  const notes = gnuBuildIdNote(undefined, false);
  const report = parse(
    elfNoteFixture({
      bits: 32,
      little: false,
      machine: 20,
      ownership: "program",
      notes,
    }),
  );
  expect(report.byte_order).toBe("big");
  expect(report.machine).toBe(20);
  expect(report.entries[0]?.gnu?.build_id_hex).toBe(
    "0123456789abcdef0123456789abcdef01234567",
  );
});

it("reads an 8-aligned GNU property note from a PT_NOTE program header", () => {
  const notes = gnuPropertyNote();
  expect(notes.length).toBe(48);
  const report = parse(
    elfNoteFixture({ ownership: "program", notes, alignment: 8 }),
  );
  expect(report.tables).toEqual([
    expect.objectContaining({ kind: "program", alignment: 8 }),
  ]);
  expect(report.entries).toHaveLength(1);
  expect(report.entries[0]).toMatchObject({
    owner: "GNU",
    type: 5,
    type_name: "gnu_property",
    namesz: 4,
    descsz: 32,
  });
  expect(report.entries[0]?.descriptor.location.offset).toBe(
    (report.entries[0]?.location.offset ?? 0) + 16,
  );
});

it("reads an 8-aligned GNU property note from an SHT_NOTE section", () => {
  const report = parse(
    elfNoteFixture({
      ownership: "section",
      notes: gnuPropertyNote(),
      alignment: 8,
      sectionName: ".note.gnu.property",
    }),
  );
  expect(report.tables).toEqual([
    expect.objectContaining({
      kind: "section",
      name: ".note.gnu.property",
      alignment: 8,
    }),
  ]);
  expect(report.entries[0]?.type_name).toBe("gnu_property");
  expect(report.entries[0]?.descriptor.bytes).toBe(32);
});

it.each([0, 1] as const)(
  "treats declared note alignment %i as 4-byte padding",
  (alignment) => {
    const report = parse(elfNoteFixture({ ownership: "program", alignment }));
    expect(report.tables[0]?.alignment).toBe(4);
    expect(
      report.entries.some((entry) => entry.type_name === "gnu_build_id"),
    ).toBe(true);
    expect(
      report.entries.some((entry) => entry.type_name === "gnu_abi_tag"),
    ).toBe(true);
  },
);

const hostElf = [
  "/bin/ls",
  "/usr/bin/ls",
  "/usr/bin/env",
].reduce<Buffer | null>((found, path) => {
  if (found) return found;
  try {
    const bytes = readFileSync(path);
    if (
      bytes.length > 64 &&
      bytes[0] === 0x7f &&
      bytes[1] === 0x45 &&
      bytes[2] === 0x4c &&
      bytes[3] === 0x46
    )
      return bytes;
  } catch {
    return found;
  }
  return found;
}, null);

it.skipIf(hostElf === null)(
  "parses a host ELF without requiring it to contain notes",
  () => {
    const report = parse(hostElf!);
    expect(report.coverage.status).toBe("complete");
    const buildId = report.entries.find(
      (entry) => entry.type_name === "gnu_build_id",
    );
    const abi = report.entries.find(
      (entry) => entry.type_name === "gnu_abi_tag",
    );
    if (buildId !== undefined)
      expect(buildId.gnu?.build_id_hex).toMatch(/^[0-9a-f]+$/u);
    if (abi !== undefined)
      expect(abi.gnu?.abi_tag).toMatchObject({
        os: expect.any(Number),
        major: expect.any(Number),
        minor: expect.any(Number),
        subminor: expect.any(Number),
      });
  },
);

const unterminatedNoteSections = (
  sections: number,
  nameBytes: number,
): Buffer => {
  const shnum = sections + 2;
  const tableOffset = 64 + shnum * 64;
  const shdr = (type: number, offset = 0, size = 0): Buffer => {
    const header = Buffer.alloc(64);
    header.writeUInt32LE(type, 4);
    header.writeBigUInt64LE(BigInt(offset), 24);
    header.writeBigUInt64LE(BigInt(size), 32);
    return header;
  };
  const image = Buffer.concat([
    elf64({ shoff: 64, shnum }),
    shdr(0),
    shdr(3, tableOffset, nameBytes),
    ...Array.from({ length: sections }, () => shdr(7, tableOffset)),
    Buffer.alloc(nameBytes, 0x41),
  ]);
  image.writeUInt16LE(1, 62);
  return image;
};

it.each([
  { offset: 2, name: "é", state: "known" },
  { offset: 3, name: "", state: "known" },
  { offset: 4, name: null, state: "unavailable" },
])(
  "retains ELF section-name offset $offset consistently across consumers",
  ({ offset, name, state }) => {
    const bytes = unterminatedNoteSections(1, 4);
    bytes.set([0x41, 0x42, 0xe9, 0], bytes.length - 4);
    bytes.writeUInt32LE(offset, 64 + 2 * 64);
    const notes = parse(bytes);
    const directory = readElfDirectoryFromBuffer(bytes);
    expect(notes.tables[0]?.name).toBe(name);
    expect(directory.sections[2]).toMatchObject({ name, name_state: state });
    if (name === null) {
      expect(notes.coverage.status).toBe("complete");
      expect(notes.limitations.join(" ")).toMatch(
        /name offset.*string table/iu,
      );
      expect(directory.section_names_limitation).toMatch(
        /name offset.*string table/iu,
      );
    }
  },
);

it.each([65535, 65536])(
  "preserves consumer-specific section-name windows for NUL at byte %i",
  (terminatorOffset) => {
    const bytes = unterminatedNoteSections(1, terminatorOffset + 1);
    bytes[bytes.length - 1] = 0;
    const name = "A".repeat(terminatorOffset);
    const notes = parse(bytes);
    const directory = readElfDirectoryFromBuffer(bytes);
    expect(notes.tables[0]?.name).toBe(name);
    expect(notes.coverage.status).toBe("complete");
    expect(directory.sections[2]).toMatchObject(
      terminatorOffset === 65535
        ? { name, name_state: "known" }
        : { name: null, name_state: "truncated" },
    );
    if (terminatorOffset === 65536)
      expect(directory.section_names_limitation).toMatch(
        /section names.*unavailable.*not NUL-terminated/iu,
      );
  },
);

it("bounds repeated scans of an unterminated section name", () => {
  const report = parse(unterminatedNoteSections(2, 64));
  expect(report.tables.map(({ name }) => name)).toEqual([null, null]);
  expect(report.coverage.status).toBe("complete");
  const nameWarnings = report.limitations.filter((value) =>
    /not NUL-terminated/iu.test(value),
  );
  expect(nameWarnings).toHaveLength(1);
  expect(nameWarnings[0]).toMatch(
    /section names.*incomplete.*not NUL-terminated/iu,
  );
  let failure: unknown;
  try {
    parse(unterminatedNoteSections(3, 400));
  } catch (cause) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(ArtifactReaderFailure);
  expect(failure).toMatchObject({ reason: "limit", boundary: "memory" });
  expect(failure).toHaveProperty(
    "message",
    expect.stringMatching(/byte budget/u),
  );
});

it("rejects note text that repeats beyond the shared byte budget", () => {
  const notes = elfNote("A".repeat(40), 1, Buffer.alloc(0));
  const once = elfNoteFixture({ ownership: "program", notes });
  const twice = elfNoteFixture({ ownership: "both", notes });
  const input = inspectElfNotesInputSchema.parse({
    path: defaults.path,
    max_file_bytes: 200,
  });
  expect(parse(once, input).entries).toHaveLength(1);
  expect(() => parse(twice, input)).toThrow(ArtifactReaderFailure);
  expect(() => parse(twice, input)).toThrow(/byte budget/u);
});

it("rejects program and section header tables that do not fit", () => {
  expect(() =>
    parse(elf64({ phoff: 64, phnum: 1 }, Buffer.from([1, 0, 0, 0]))),
  ).toThrow(/leaves the artifact/u);
  expect(() =>
    parse(
      elf64({ shoff: 64, shnum: 1, shentsize: 64 }, Buffer.from([0, 0, 0, 0])),
    ),
  ).toThrow(/leaves the artifact/u);
});

it("rejects an extended section count stored in section zero", () => {
  expect(() => parse(elf64({ shoff: 64, shnum: 0 }))).toThrow(
    /extended numbering/u,
  );
});

const repeatedNotes = (count: number, notes: Buffer): Buffer => {
  const headers = Buffer.alloc(56 * count);
  const offset = 64 + headers.length;
  for (let index = 0; index < count; index += 1) {
    const at = index * 56;
    headers.writeUInt32LE(4, at);
    headers.writeBigUInt64LE(BigInt(offset), at + 8);
    headers.writeBigUInt64LE(BigInt(notes.length), at + 32);
    headers.writeBigUInt64LE(4n, at + 48);
  }
  return Buffer.concat([elf64({ phoff: 64, phnum: count }), headers, notes]);
};

it("reuses one descriptor hash and GNU NUL scan across note headers", () => {
  const payload = Buffer.alloc(400);
  const hashed = parse(repeatedNotes(6, elfNote("X", 1, payload)));
  expect(hashed.entries).toHaveLength(6);
  expect(
    new Set(hashed.entries.map((entry) => entry.descriptor.sha256)).size,
  ).toBe(1);
  const gold = parse(repeatedNotes(6, elfNote("GNU", 4, payload)));
  expect(gold.entries).toHaveLength(6);
  expect(gold.entries.every((entry) => entry.gnu?.gold_version === "")).toBe(
    true,
  );
  const distinct = Buffer.concat([
    elfNote("X", 1, payload),
    elfNote("X", 1, Buffer.alloc(400, 1)),
  ]);
  expect(() =>
    parse(
      elfNoteFixture({ ownership: "program", notes: distinct }),
      inspectElfNotesInputSchema.parse({
        path: defaults.path,
        max_file_bytes: payload.length + 160,
      }),
    ),
  ).toThrow(/byte budget/u);
});

it("decodes a GNU gold version by scanning trailing NULs", () => {
  const trailing = elfNote("GNU", 4, Buffer.from("gold\0\0x\0", "latin1"));
  expect(
    parse(elfNoteFixture({ ownership: "program", notes: trailing })).entries[0]
      ?.gnu?.gold_version,
  ).toBe("gold\0\0x");
  const descriptor = Buffer.concat([Buffer.alloc(131_072), Buffer.from("x")]);
  const started = Date.now();
  const report = parse(
    elfNoteFixture({
      ownership: "program",
      notes: elfNote("GNU", 4, descriptor),
    }),
  );
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(report.entries[0]?.gnu?.gold_version).toBe(`${"\0".repeat(131_072)}x`);
});

it("rejects a declared note table that extends past the file", () => {
  const truncated = elfNoteTablePastEnd();
  expect(truncated.length).toBe(137);
  expect(() => parse(truncated)).toThrow(ArtifactReaderFailure);
  expect(() => parse(truncated)).toThrow(/leaves the artifact/u);
  const present = Buffer.concat([truncated, Buffer.alloc(3)]);
  expect(parse(present).entries).toHaveLength(1);
  expect(parse(present).tables[0]?.location).toEqual({
    offset: 120,
    bytes: 20,
  });
});

it("fails when the entry budget is exhausted", () => {
  const notes = Buffer.concat([
    gnuBuildIdNote(),
    gnuAbiTagNote(),
    elfNote("GNU", 4, Buffer.from("gold")),
  ]);
  const bytes = elfNoteFixture({ ownership: "program", notes });
  expect(() =>
    parseElfNotes(
      bytes,
      {
        path: defaults.path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
      },
      inspectElfNotesInputSchema.parse({ path: defaults.path, max_entries: 1 }),
    ),
  ).toThrow(ArtifactReaderFailure);
});

it("keeps unsafe table offsets ahead of unsupported extended numbering", () => {
  const bytes = elfExtendedSectionCountFixture();
  bytes.writeBigUInt64LE(0xffffffffffffffffn, 32);
  expect(() => parse(bytes)).toThrow(
    "ELF offset or size exceeds a safe integer.",
  );
});

it("does not apply note precision admission to unrelated program records", () => {
  const bytes = elf64({ phoff: 64, phnum: 1 }, Buffer.alloc(56));
  bytes.writeUInt32LE(0x70000001, 64);
  for (const relative of [8, 16, 24, 32, 40, 48])
    bytes.writeBigUInt64LE(0xffffffffffffffffn, 64 + relative);
  expect(parse(bytes).tables).toEqual([]);
  bytes.writeUInt32LE(4, 64);
  expect(() => parse(bytes)).toThrow(
    "ELF offset or size exceeds a safe integer.",
  );
});

it("keeps compressed-note refusal ahead of alignment precision admission", () => {
  const bytes = compressedElfNoteSectionFixture();
  const sectionTable = Number(bytes.readBigUInt64LE(40));
  bytes.writeBigUInt64LE(0xffffffffffffffffn, sectionTable + 64 + 48);
  expect(() => parse(bytes)).toThrow(/compressed.*note/iu);
});

it.each([
  { bits: 32, little: true },
  { bits: 32, little: false },
  { bits: 64, little: true },
  { bits: 64, little: false },
] as const)(
  "rejects dangling section names with and without notes (ELF$bits $little)",
  ({ bits, little }) => {
    for (const ownership of ["program", "none"] as const) {
      const bytes = elfNoteFixture({ bits, little, ownership });
      const before = parse(bytes);
      const nameOffset = bits === 64 ? 62 : 50;
      if (little) bytes.writeUInt16LE(5, nameOffset);
      else bytes.writeUInt16BE(5, nameOffset);
      expect(() => parse(bytes)).toThrow("ELF section table is missing");
      if (little) bytes.writeUInt16LE(0, nameOffset);
      else bytes.writeUInt16BE(0, nameOffset);
      expect(parse(bytes)).toEqual(before);
    }
  },
);

it("decodes Linux core dump notes (NT_PRPSINFO, NT_FILE, NT_SIGINFO, NT_AUXV) for 64-bit little-endian", () => {
  const notes = Buffer.concat([
    corePrpsinfoNote({
      bits: 64,
      little: true,
      state: 0,
      sname: "R",
      pid: 4242,
      ppid: 1,
      pgrp: 4242,
      sid: 4242,
      uid: 1001,
      gid: 1002,
      fname: "test-proc",
      psargs: "/usr/bin/test-proc --daemon -v",
    }),
    coreFileNote(
      [
        {
          start: 0x400000n,
          end: 0x405000n,
          file_ofs: 0n,
          path: "/usr/bin/test-proc",
        },
        {
          start: 0x7fff0000n,
          end: 0x7fff2000n,
          file_ofs: 10n,
          path: "/lib/x86_64-linux-gnu/libc.so.6",
        },
      ],
      4096,
      64,
      true,
    ),
    coreSiginfoNote(11, 1, 0, true), // SIGSEGV, SEGV_MAPERR
    coreAuxvNote(
      [
        [6, 4096n], // AT_PAGESZ
        [3, 0x400040n], // AT_PHDR
        [9, 0x401000n], // AT_ENTRY
        [999, 0x1234n], // Unknown auxv tag
      ],
      64,
      true,
    ),
  ]);

  const bytes = elfNoteFixture({
    bits: 64,
    little: true,
    type: 4, // ET_CORE
    ownership: "program",
    notes,
  });

  const report = parse(bytes);
  expect(report.entries).toHaveLength(4);

  // 1. NT_PRPSINFO
  expect(report.entries[0]).toMatchObject({
    owner: "CORE",
    type: 3,
    type_name: "core_prpsinfo",
    gnu: null,
    core: {
      prpsinfo: {
        state: 0,
        pid: 4242,
        ppid: 1,
        pgrp: 4242,
        sid: 4242,
        uid: 1001,
        gid: 1002,
        filename: "test-proc",
        psargs: "/usr/bin/test-proc --daemon -v",
      },
      file: null,
      siginfo: null,
      auxv: null,
    },
  });

  // 2. NT_FILE
  expect(report.entries[1]).toMatchObject({
    owner: "CORE",
    type: 0x46494c45,
    type_name: "core_file",
    gnu: null,
    core: {
      prpsinfo: null,
      file: {
        count: 2,
        page_size: 4096,
        mappings: [
          {
            start_address: "0x400000",
            end_address: "0x405000",
            file_offset_pages: "0x0",
            path: "/usr/bin/test-proc",
            path_hex: Buffer.from("/usr/bin/test-proc").toString("hex"),
          },
          {
            start_address: "0x7fff0000",
            end_address: "0x7fff2000",
            file_offset_pages: "0xa",
            path: "/lib/x86_64-linux-gnu/libc.so.6",
            path_hex: Buffer.from("/lib/x86_64-linux-gnu/libc.so.6").toString(
              "hex",
            ),
          },
        ],
      },
      siginfo: null,
      auxv: null,
    },
  });

  // 3. NT_SIGINFO
  expect(report.entries[2]).toMatchObject({
    owner: "CORE",
    type: 0x53494749,
    type_name: "core_siginfo",
    gnu: null,
    core: {
      prpsinfo: null,
      file: null,
      siginfo: {
        signo: 11,
        errno: 0,
        code: 1,
      },
      auxv: null,
    },
  });

  // 4. NT_AUXV
  expect(report.entries[3]).toMatchObject({
    owner: "CORE",
    type: 6,
    type_name: "core_auxv",
    gnu: null,
    core: {
      prpsinfo: null,
      file: null,
      siginfo: null,
      auxv: [
        { type: 6, type_name: "AT_PAGESZ", value: "0x1000" },
        { type: 3, type_name: "AT_PHDR", value: "0x400040" },
        { type: 9, type_name: "AT_ENTRY", value: "0x401000" },
        { type: 999, type_name: null, value: "0x1234" },
      ],
    },
  });
});

it("decodes Linux core dump notes for 32-bit big-endian", () => {
  const notes = Buffer.concat([
    corePrpsinfoNote({
      bits: 32,
      little: false,
      state: 1,
      pid: 123,
      ppid: 1,
      pgrp: 123,
      sid: 123,
      uid: 500,
      gid: 500,
      fname: "proc32",
      psargs: "proc32 arg",
    }),
    coreFileNote(
      [
        {
          start: 0x10000,
          end: 0x12000,
          file_ofs: 0,
          path: "/bin/proc32",
        },
      ],
      4096,
      32,
      false,
    ),
    coreAuxvNote(
      [
        [6, 4096],
        [11, 500],
      ],
      32,
      false,
    ),
  ]);

  const bytes = elfNoteFixture({
    bits: 32,
    little: false,
    type: 4,
    ownership: "program",
    notes,
  });

  const report = parse(bytes);
  expect(report.entries).toHaveLength(3);
  expect(report.entries[0]?.core?.prpsinfo).toMatchObject({
    state: 1,
    pid: 123,
    uid: 500,
    gid: 500,
    filename: "proc32",
    psargs: "proc32 arg",
  });
  expect(report.entries[1]?.core?.file).toMatchObject({
    count: 1,
    page_size: 4096,
    mappings: [
      {
        start_address: "0x10000",
        end_address: "0x12000",
        file_offset_pages: "0x0",
        path: "/bin/proc32",
        path_hex: Buffer.from("/bin/proc32").toString("hex"),
      },
    ],
  });
  expect(report.entries[2]?.core?.auxv).toEqual([
    { type: 6, type_name: "AT_PAGESZ", value: "0x1000" },
    { type: 11, type_name: "AT_UID", value: "0x1f4" },
  ]);
});

it("decodes a 32-bit prpsinfo whose ABI gives pr_uid 32 bits", () => {
  // `pr_uid`/`pr_gid` are `__kernel_uid_t`, which is 16-bit only on i386, ARM, m68k and sparc32.
  // MIPS o32, PowerPC-32 and s390 take the asm-generic `unsigned int`, so the kernel writes
  // `sizeof(struct elf_prpsinfo)` == 128 and every member after `pr_flag` sits four bytes later.
  const report = parse(
    elfNoteFixture({
      bits: 32,
      machine: 8,
      type: 4,
      ownership: "program",
      notes: corePrpsinfoNote({
        bits: 32,
        idWidth: 4,
        state: 1,
        uid: 70_000,
        gid: 80_000,
        pid: 4242,
        ppid: 1,
        pgrp: 4242,
        sid: 4242,
        fname: "mips-proc",
        psargs: "./mips-proc --serve",
      }),
    }),
  );
  expect(report.entries[0]?.core?.prpsinfo).toEqual({
    state: 1,
    pid: 4242,
    ppid: 1,
    pgrp: 4242,
    sid: 4242,
    uid: 70_000,
    gid: 80_000,
    filename: "mips-proc",
    psargs: "./mips-proc --serve",
  });
});

it("still decodes the 124-byte 32-bit prpsinfo with 16-bit ids", () => {
  // The i386/ARM form must not shift: its descriptor is four bytes shorter.
  const report = parse(
    elfNoteFixture({
      bits: 32,
      machine: 3,
      type: 4,
      ownership: "program",
      notes: corePrpsinfoNote({
        bits: 32,
        state: 1,
        uid: 500,
        gid: 600,
        pid: 4242,
        ppid: 1,
        pgrp: 4242,
        sid: 4242,
        fname: "i386-proc",
        psargs: "./i386-proc --serve",
      }),
    }),
  );
  expect(report.entries[0]?.core?.prpsinfo).toEqual({
    state: 1,
    pid: 4242,
    ppid: 1,
    pgrp: 4242,
    sid: 4242,
    uid: 500,
    gid: 600,
    filename: "i386-proc",
    psargs: "./i386-proc --serve",
  });
});
it("tolerates malformed core notes by returning null without throwing", () => {
  const truncatedPrpsinfo = elfNote("CORE", 3, Buffer.alloc(20)); // requires 136 for 64-bit
  const truncatedFile = elfNote(
    "CORE",
    0x46494c45,
    Buffer.from("01000000000000000010000000000000", "hex"), // count 1, page_size 4096, but no map entries or filenames
  );
  const truncatedSiginfo = elfNote("CORE", 0x53494749, Buffer.alloc(4)); // requires 12 bytes
  const unterminatedAuxv = elfNote(
    "CORE",
    6,
    Buffer.from("06000000000000000010000000000000", "hex"), // AT_PAGESZ=4096 but lacks AT_NULL terminator
  );
  const truncatedAuxv = elfNote("CORE", 6, Buffer.alloc(7)); // not multiple of entry size
  const notes = Buffer.concat([
    truncatedPrpsinfo,
    truncatedFile,
    truncatedSiginfo,
    unterminatedAuxv,
    truncatedAuxv,
  ]);

  const bytes = elfNoteFixture({
    bits: 64,
    ownership: "program",
    notes,
  });

  const report = parse(bytes);
  expect(report.entries).toHaveLength(5);
  expect(report.entries[0]?.core).toBeNull();
  expect(report.entries[0]?.type_name).toBe("core_prpsinfo");
  expect(report.entries[1]?.core).toBeNull();
  expect(report.entries[1]?.type_name).toBe("core_file");
  expect(report.entries[2]?.core).toBeNull();
  expect(report.entries[2]?.type_name).toBe("core_siginfo");
  expect(report.entries[3]?.core).toBeNull();
  expect(report.entries[3]?.type_name).toBe("core_auxv");
  expect(report.entries[4]?.core).toBeNull();
  expect(report.entries[4]?.type_name).toBe("core_auxv");
  const valid = parse(
    elfNoteFixture({
      bits: 64,
      ownership: "program",
      notes: Buffer.concat([
        coreFileNote([
          { start: 0x1000, end: 0x2000, file_ofs: 0, path: "/bin/app" },
        ]),
        coreAuxvNote([[6, 4096]]),
      ]),
    }),
  );
  expect(valid.entries[0]?.core?.file?.mappings[0]?.path).toBe("/bin/app");
  expect(valid.entries[1]?.core?.auxv).toContainEqual({
    type: 6,
    type_name: "AT_PAGESZ",
    value: "0x1000",
  });
});

it("decodes siginfo using target ABI for MIPS machines", () => {
  const desc = Buffer.alloc(128);
  desc.writeInt32LE(11, 0); // signo = SIGSEGV
  desc.writeInt32LE(1, 4); // code = SEGV_MAPERR (offset 4 on MIPS)
  desc.writeInt32LE(0, 8); // errno = 0 (offset 8 on MIPS)
  const mipsSiginfo = elfNote("CORE", 0x53494749, desc, true);
  const bytes = elfNoteFixture({
    bits: 32,
    machine: 8, // EM_MIPS
    ownership: "program",
    notes: mipsSiginfo,
  });
  const report = parse(bytes);
  expect(report.entries[0]?.core?.siginfo).toEqual({
    signo: 11,
    code: 1,
    errno: 0,
  });
});

it("preserves negative process IDs and signal numbers without rewriting to zero", () => {
  const prps = corePrpsinfoNote({
    pid: -1,
    ppid: -1,
    pgrp: -1,
    sid: -1,
  });
  const sig = coreSiginfoNote(-1, -2, -3);
  const bytes = elfNoteFixture({
    bits: 64,
    ownership: "program",
    notes: Buffer.concat([prps, sig]),
  });
  const report = parse(bytes);
  expect(report.entries[0]?.core?.prpsinfo).toMatchObject({
    pid: -1,
    ppid: -1,
    pgrp: -1,
    sid: -1,
  });
  expect(report.entries[1]?.core?.siginfo).toMatchObject({
    signo: -1,
    code: -2,
    errno: -3,
  });
});

it("rejects 64-bit auxv tags and out-of-range page sizes with core: null without schema error", () => {
  const validAuxv = coreAuxvNote([[6, 4096n]], 64, true);
  const wideTagAuxv = Buffer.from(validAuxv);
  wideTagAuxv.writeBigUInt64LE(0x100000000n, 20);

  const validFile = coreFileNote(
    [
      {
        start: 0x400000n,
        end: 0x401000n,
        file_ofs: 0n,
        path: "/bin/app",
      },
    ],
    4096,
    64,
    true,
  );
  const widePageSizeFile = Buffer.from(validFile);
  widePageSizeFile.writeBigUInt64LE(0x100000000n, 28);

  const bytes = elfNoteFixture({
    bits: 64,
    ownership: "program",
    notes: Buffer.concat([wideTagAuxv, widePageSizeFile]),
  });
  const report = parse(bytes);
  expect(report.entries[0]?.core).toBeNull();
  expect(report.entries[1]?.core).toBeNull();
});

it.each([32, 64] as const)(
  "leaves ELF%d NT_FILE mappings unknown when the descriptor contains a surplus pathname",
  (bits) => {
    const little = bits === 64;
    const file = coreFileNote(
      [{ start: 0x1000, end: 0x2000, file_ofs: 2, path: "/bin/app" }],
      4096,
      bits,
      little,
    );
    const descriptorBytes = little
      ? file.readUInt32LE(4)
      : file.readUInt32BE(4);
    // A five-byte CORE owner including its NUL pads to eight bytes.
    const descriptor = file.subarray(20, 20 + descriptorBytes);
    const inspect = (tail: Buffer) => {
      const payload = Buffer.concat([descriptor, tail]);
      return parse(
        elfNoteFixture({
          bits,
          little,
          machine: little ? 62 : 20,
          type: 4,
          ownership: "both",
          notes: elfNote("CORE", 0x46494c45, payload, little),
        }),
      );
    };
    const exact = inspect(Buffer.alloc(0));
    const padded = inspect(Buffer.alloc(3));
    expect(exact.entries).toHaveLength(2);
    expect(padded.entries.map(({ core }) => core)).toEqual(
      exact.entries.map(({ core }) => core),
    );
    for (const entry of exact.entries)
      expect(entry.core?.file?.mappings[0]).toMatchObject({
        start_address: "0x1000",
        end_address: "0x2000",
        file_offset_pages: "0x2",
        path: "/bin/app",
      });

    const tail = Buffer.from("/lib/extra.so\0");
    const malformed = inspect(tail);
    expect(malformed.coverage).toEqual(exact.coverage);
    expect(malformed.entries).toHaveLength(2);
    const payload = Buffer.concat([descriptor, tail]);
    const sha256 = createHash("sha256").update(payload).digest("hex");
    for (const entry of malformed.entries)
      expect(entry).toMatchObject({
        type_name: "core_file",
        core: null,
        descriptor: { bytes: payload.length, sha256 },
      });
  },
);

it("does not spend text budget on malformed or discarded NT_FILE paths", () => {
  const header = Buffer.alloc(16);
  header.writeBigUInt64LE(2n, 0); // count = 2
  header.writeBigUInt64LE(4096n, 8); // page_size = 4096
  const mappings = Buffer.alloc(48); // 2 mappings * 24 bytes
  const paths = Buffer.from(
    "/bin/app\0unterminated_path_without_null",
    "latin1",
  );
  const badFileNote = elfNote(
    "CORE",
    0x46494c45,
    Buffer.concat([header, mappings, paths]),
  );
  const path = "p".repeat(128);
  const valid = coreFileNote([
    { start: 0x1000, end: 0x2000, file_ofs: 0, path },
  ]);
  const image = elfNoteFixture({
    bits: 64,
    ownership: "program",
    notes: Buffer.concat([badFileNote, valid]),
  });
  // Two CORE owners use 14 bytes each; one ELF64 mapping uses 54, and
  // the retained Latin-1 path plus its hex spelling uses 3 bytes per byte.
  const budget = 2 * 14 + 54 + 128 * 3;
  expect(image.length).toBeLessThanOrEqual(budget);
  const bytes = Buffer.concat([image, Buffer.alloc(budget - image.length)]);
  const report = parse(bytes);
  expect(report.entries[0]?.core).toBeNull();
  expect(report.entries[1]?.core?.file?.mappings).toEqual([
    {
      start_address: "0x1000",
      end_address: "0x2000",
      file_offset_pages: "0x0",
      path,
      path_hex: Buffer.from(path).toString("hex"),
    },
  ]);
  expect(() => parse(bytes.subarray(0, bytes.length - 1))).toThrow(
    expect.objectContaining({ reason: "limit", boundary: "memory" }),
  );
});

it.each([
  { bits: 64, little: true, machine: 183 },
  { bits: 64, little: true, machine: 62 },
  { bits: 32, little: false, machine: 8 },
  { bits: 64, little: false, machine: 21 },
] as const)(
  "decodes Android .note.android.ident 132-byte, 152-byte, and legacy 4-byte descriptors (ELF$bits little=$little machine=$machine)",
  ({ bits, little, machine }) => {
    const extendedTail = Buffer.alloc(20, 0xaa);
    const notes = Buffer.concat([
      androidIdentNote({
        androidApi: 24,
        ndkVersion: "r27c",
        ndkBuildNumber: "12297006",
        little,
      }),
      androidIdentNote({
        androidApi: 35,
        ndkVersion: "r28",
        ndkBuildNumber: "12479018",
        extraTail: extendedTail,
        little,
      }),
      androidIdentNote({
        androidApi: 21,
        ndkVersion: null,
        ndkBuildNumber: null,
        little,
      }),
      elfNote("Android", 2, Buffer.from([1, 2, 3, 4]), little),
    ]);
    const bytes = elfNoteFixture({
      bits,
      little,
      machine,
      ownership: "section",
      sectionName: ".note.android.ident",
      notes,
    });
    const report = parse(bytes);
    expect(report.tables[0]?.name).toBe(".note.android.ident");
    expect(report.entries).toHaveLength(4);

    expect(report.entries[0]).toMatchObject({
      owner: "Android",
      type: 1,
      type_name: "android_ident",
      descsz: 132,
      gnu: null,
      core: null,
      android: {
        android_api: 24,
        ndk_version: "r27c",
        ndk_build_number: "12297006",
      },
    });
    expect(report.entries[1]).toMatchObject({
      owner: "Android",
      type: 1,
      type_name: "android_ident",
      descsz: 152,
      gnu: null,
      core: null,
      android: {
        android_api: 35,
        ndk_version: "r28",
        ndk_build_number: "12479018",
      },
    });
    expect(report.entries[2]).toMatchObject({
      owner: "Android",
      type: 1,
      type_name: "android_ident",
      descsz: 4,
      gnu: null,
      core: null,
      descriptor: {
        bytes: 4,
        hex: little ? "15000000" : "00000015",
      },
      android: {
        android_api: 21,
        ndk_version: null,
        ndk_build_number: null,
      },
    });
    expect(report.entries[3]).toMatchObject({
      owner: "Android",
      type: 2,
      type_name: "unknown",
      gnu: null,
      core: null,
      android: null,
      descriptor: {
        bytes: 4,
        hex: "01020304",
      },
    });
  },
);

it("degrades truncated, unterminated, or non-printable Android ident notes to null while preserving descriptors", () => {
  const truncated2 = Buffer.from([0x15, 0x00]);
  const truncated68 = Buffer.alloc(68);
  truncated68.writeUInt32LE(24, 0);
  truncated68.write("r27c\0", 4, "latin1");

  const unterminatedVersion = Buffer.alloc(132);
  unterminatedVersion.writeUInt32LE(24, 0);
  unterminatedVersion.fill(0x72, 4, 68);
  unterminatedVersion.write("12297006\0", 68, "latin1");

  const unterminatedBuild = Buffer.alloc(132);
  unterminatedBuild.writeUInt32LE(24, 0);
  unterminatedBuild.write("r27c\0", 4, "latin1");
  unterminatedBuild.fill(0x39, 68, 132);

  const controlByteSlot = Buffer.alloc(132);
  controlByteSlot.writeUInt32LE(24, 0);
  controlByteSlot.set([0x72, 0x07, 0x00], 4);
  controlByteSlot.write("12297006\0", 68, "latin1");

  const nonZeroPaddingSlot = Buffer.alloc(132);
  nonZeroPaddingSlot.writeUInt32LE(24, 0);
  nonZeroPaddingSlot.write("r27c\0", 4, "latin1");
  nonZeroPaddingSlot[20] = 0x58;
  nonZeroPaddingSlot.write("12297006\0", 68, "latin1");

  const descriptors = [
    Buffer.alloc(0),
    truncated2,
    truncated68,
    unterminatedVersion,
    unterminatedBuild,
    controlByteSlot,
    nonZeroPaddingSlot,
  ];
  const notes = Buffer.concat(
    descriptors.map((desc) => elfNote("Android", 1, desc)),
  );
  const report = parse(elfNoteFixture({ ownership: "program", notes }));
  expect(report.entries).toHaveLength(descriptors.length);
  for (const [index, desc] of descriptors.entries()) {
    expect(report.entries[index]).toMatchObject({
      owner: "Android",
      type: 1,
      type_name: "android_ident",
      gnu: null,
      core: null,
      android: null,
      descriptor: {
        bytes: desc.length,
        sha256: createHash("sha256").update(desc).digest("hex"),
        hex: desc.length <= 64 ? desc.toString("hex") : null,
      },
    });
  }
});

it("charges TextBudget for scanned and retained Android ident strings", () => {
  // 6 aliased headers over a 552-byte file: 128 scanned once <= 552, and
  // 6 * (23 owner + 12 retained) = 210 <= 552 (un-cached 6 * 128 = 768 > 552).
  const typicalIdent = androidIdentNote({
    androidApi: 24,
    ndkVersion: "r27c",
    ndkBuildNumber: "12297006",
  });
  const aliased6 = parse(repeatedNotes(6, typicalIdent));
  expect(aliased6.entries).toHaveLength(6);
  expect(
    aliased6.entries.every(
      (entry) =>
        entry.android?.ndk_version === "r27c" &&
        entry.android.ndk_build_number === "12297006",
    ),
  ).toBe(true);

  // 6 aliased headers * (23 owner + 126 retained) = 894 bytes > 552-byte file.
  const maxStrings = androidIdentNote({
    androidApi: 24,
    ndkVersion: "v".repeat(63),
    ndkBuildNumber: "b".repeat(63),
  });
  let retainedFailure: unknown;
  try {
    parse(repeatedNotes(6, maxStrings));
  } catch (cause) {
    retainedFailure = cause;
  }
  expect(retainedFailure).toBeInstanceOf(ArtifactReaderFailure);
  expect(retainedFailure).toMatchObject({
    reason: "limit",
    boundary: "memory",
    message: expect.stringMatching(/byte budget/u),
  });

  // Share one 132-byte descriptor range across a GNU gold-version header
  // (namesz=24) and a nested Android ident header (namesz=8 at +16) so
  // `hashed` stays 132 (cached by range) and `used` stays 148, while
  // `scanned` reaches 132 (GNU) + 128 (Android) = 260 bytes.
  const identDescriptor = Buffer.alloc(132);
  identDescriptor.writeUInt32LE(24, 0);
  identDescriptor.write("r27c\0", 4, "latin1");
  identDescriptor.write("1\0", 68, "latin1");
  const sharedPayload = Buffer.alloc(36 + identDescriptor.length);
  sharedPayload.writeUInt32LE(24, 0);
  sharedPayload.writeUInt32LE(identDescriptor.length, 4);
  sharedPayload.writeUInt32LE(4, 8);
  sharedPayload.write("GNU\0", 12, "latin1");
  sharedPayload.writeUInt32LE(8, 16);
  sharedPayload.writeUInt32LE(identDescriptor.length, 20);
  sharedPayload.writeUInt32LE(1, 24);
  sharedPayload.write("Android\0", 28, "latin1");
  identDescriptor.copy(sharedPayload, 36);
  const programHeaders = Buffer.alloc(56 * 2);
  const payloadOffset = 64 + programHeaders.length;
  programHeaders.writeUInt32LE(4, 0);
  programHeaders.writeBigUInt64LE(BigInt(payloadOffset), 8);
  programHeaders.writeBigUInt64LE(BigInt(sharedPayload.length), 32);
  programHeaders.writeBigUInt64LE(4n, 48);
  programHeaders.writeUInt32LE(4, 56);
  programHeaders.writeBigUInt64LE(BigInt(payloadOffset + 16), 56 + 8);
  programHeaders.writeBigUInt64LE(BigInt(sharedPayload.length - 16), 56 + 32);
  programHeaders.writeBigUInt64LE(4n, 56 + 48);
  const sharedScanImage = Buffer.concat([
    elf64({ phoff: 64, phnum: 2 }),
    programHeaders,
    sharedPayload,
  ]);

  const withinScanBudget = parse(
    sharedScanImage,
    inspectElfNotesInputSchema.parse({
      path: defaults.path,
      max_file_bytes: 260,
    }),
  );
  expect(withinScanBudget.entries[1]?.android).toEqual({
    android_api: 24,
    ndk_version: "r27c",
    ndk_build_number: "1",
  });

  let scanFailure: unknown;
  try {
    parse(
      sharedScanImage,
      inspectElfNotesInputSchema.parse({
        path: defaults.path,
        max_file_bytes: 259,
      }),
    );
  } catch (cause) {
    scanFailure = cause;
  }
  expect(scanFailure).toBeInstanceOf(ArtifactReaderFailure);
  expect(scanFailure).toMatchObject({
    reason: "limit",
    boundary: "memory",
    message: expect.stringMatching(/259-byte budget/u),
  });
});
