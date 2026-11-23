import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { inspectElfNotesInputSchema } from "../../domain/native/elfNotes.js";
import { ArtifactReaderFailure } from "../../resources/ArtifactReader.js";
import {
  decodeElfSectionNameRequest,
  decodeElfSectionNameTable,
  elfSectionNameBudget,
} from "../../domain/native/elfSectionNameTable.js";
import { readElfDirectoryFromBuffer } from "../../domain/native/nativeSectionDirectory.js";
import {
  androidIdentNote,
  compressedElfNoteFixture,
  compressedElfNoteSectionFixture,
  coreAuxvNote,
  coreFileNote,
  corePrpsinfoDescriptor,
  corePrpsinfoNote,
  coreSiginfoNote,
  elf32ProcessIdentityFixture,
  elfNote,
  elfNoteByteSource,
  elfNoteFixture,
  elfNoteTablePastEnd,
  elfExtendedSectionCountFixture,
  gnuAbiTagNote,
  gnuBuildIdNote,
  gnuPropertyNote,
  withElf64DirectSectionCount,
} from "./ElfNotes.fixture.js";
import {
  parseElfNotesFromHandle,
  readElfBuildIds,
  readElfBuildIdsFromHandle,
  readGnuPropertyWordsSteps,
} from "./ElfNoteParser.js";

it.each([
  { order: "descending", type: 0xc0000001, little: true },
  { order: "duplicate", type: 0xc0000002, little: true },
  { order: "descending", type: 0xc0000001, little: false },
  { order: "duplicate", type: 0xc0000002, little: false },
])(
  "rejects $order GNU property types (little-endian: $little)",
  ({ type, little }) => {
    const note = gnuPropertyNote(little);
    const words = () => {
      const steps = readGnuPropertyWordsSteps(
        note.length,
        little,
        [{ offset: 0, size: note.length, alignment: 8 }],
        1,
        8,
      );
      let next = steps.next();
      while (!next.done)
        next = steps.next(
          note.subarray(
            next.value.offset,
            next.value.offset + next.value.length,
          ),
        );
      return next.value;
    };
    expect(words().get(0xc0000002)?.value).toBe(3);
    const secondPropertyOffset = note.length - 16;
    if (little) note.writeUInt32LE(type, secondPropertyOffset);
    else note.writeUInt32BE(type, secondPropertyOffset);
    expect(words).toThrow(expect.objectContaining({ reason: "format" }));
  },
);

it("checks GNU property order across streamed read windows", () => {
  const descriptor = Buffer.alloc(65552);
  descriptor.writeUInt32LE(1, 0);
  descriptor.writeUInt32LE(65528, 4);
  descriptor.writeUInt32LE(0xc0000002, 65536);
  descriptor.writeUInt32LE(4, 65540);
  descriptor.writeUInt32LE(3, 65544);
  const note = elfNote("GNU", 5, descriptor, true, 8);
  const reads: number[] = [];
  const words = () => {
    const steps = readGnuPropertyWordsSteps(
      note.length,
      true,
      [{ offset: 0, size: note.length, alignment: 8 }],
      1,
      8,
    );
    let next = steps.next();
    while (!next.done) {
      reads.push(next.value.offset);
      next = steps.next(
        note.subarray(next.value.offset, next.value.offset + next.value.length),
      );
    }
    return next.value;
  };
  expect(words().get(0xc0000002)?.value).toBe(3);
  expect(reads).toContain(16 + 65536);
  note.writeUInt32LE(1, 16 + 65536);
  expect(words).toThrow(expect.objectContaining({ reason: "format" }));
});

it("restarts GNU property ordering for each note", () => {
  const notes = Buffer.concat([gnuPropertyNote(), gnuPropertyNote()]);
  const steps = readGnuPropertyWordsSteps(
    notes.length,
    true,
    [{ offset: 0, size: notes.length, alignment: 8 }],
    2,
    8,
  );
  let next = steps.next();
  while (!next.done)
    next = steps.next(
      notes.subarray(next.value.offset, next.value.offset + next.value.length),
    );
  expect(next.value.get(0xc0000002)).toMatchObject({
    value: 3,
    conflict: false,
  });
});

const defaults = inspectElfNotesInputSchema.parse({
  path: "/artifacts/app",
});

const parse = (bytes: Buffer, input: typeof defaults = defaults) =>
  parseElfNotesFromHandle(
    elfNoteByteSource(bytes),
    {
      path: input.path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    },
    input,
    async () => {},
  );

const noteTextLimit = (maximum: number) => ({
  failure: {
    kind: "limit",
    format: "elf-notes",
    limit: { name: "note_text_bytes", maximum },
  },
});

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

it("retains GNU build ID and ABI from program or section notes", async () => {
  for (const [bits, little, ownership, machine] of [
    [32, true, "program", 3],
    [32, false, "program", 20],
    [64, true, "program", 62],
    [64, true, "section", 62],
  ] as const) {
    const report = await parse(
      elfNoteFixture({ bits, little, ownership, machine }),
    );
    expect(report).toMatchObject({
      format: bits === 64 ? "elf64" : "elf32",
      byte_order: little ? "little" : "big",
      machine,
      tables: [
        {
          kind: ownership,
          name: ownership === "section" ? ".note.gnu.build-id" : null,
        },
      ],
      entries: [
        {
          table_kind: ownership,
          type_name: "gnu_build_id",
          gnu: { build_id_hex: "0123456789abcdef0123456789abcdef01234567" },
        },
        {
          table_kind: ownership,
          type_name: "gnu_abi_tag",
          gnu: {
            abi_tag: {
              os: 0,
              os_name: "linux",
              major: 3,
              minor: 2,
              subminor: 0,
            },
          },
        },
      ],
    });
  }
});

it.each([
  [32, true],
  [32, false],
  [64, true],
  [64, false],
] as const)(
  "refuses compressed ELF%i %s-endian note storage without parsing its compression header",
  async (bits, little) => {
    for (const ownership of ["section", "both"] as const) {
      await expect(
        parse(compressedElfNoteSectionFixture(bits, little, ownership)),
      ).rejects.toThrow(
        expect.objectContaining({
          kind: "unsupported",
          message: expect.stringMatching(/compressed.*note/iu),
        }),
      );
    }
  },
);

it("still checks an independent PT_NOTE beside an exact compressed-note alias", async () => {
  const original = compressedElfNoteSectionFixture(64, true, "both");
  const alias = original.subarray(64, 120);
  const withDisjointNotes = (notes: Buffer): Buffer => {
    const disjoint = Buffer.from(alias);
    disjoint.writeBigUInt64LE(BigInt(original.length), 8);
    disjoint.writeBigUInt64LE(BigInt(notes.length), 32);
    disjoint.writeBigUInt64LE(BigInt(notes.length), 40);
    disjoint.writeBigUInt64LE(1n, 48);
    const image = Buffer.concat([original, notes, alias, disjoint]);
    image.writeBigUInt64LE(BigInt(original.length + notes.length), 32);
    image.writeUInt16LE(2, 56);
    return image;
  };
  await expect(parse(withDisjointNotes(Buffer.from([1])))).rejects.toThrow(
    expect.objectContaining({
      reason: "format",
      message: "ELF note table has trailing non-zero bytes.",
    }),
  );
  const framed = withDisjointNotes(
    Buffer.concat([gnuBuildIdNote(), gnuAbiTagNote()]),
  );
  await expect(parse(framed, { ...defaults, max_entries: 1 })).rejects.toThrow(
    expect.objectContaining({
      failure: expect.objectContaining({
        limit: { name: "max_entries", maximum: 1, required: 2 },
      }),
    }),
  );
  await expect(parse(framed)).rejects.toThrow(
    expect.objectContaining({ kind: "unsupported" }),
  );
  const programs = Number(framed.readBigUInt64LE(32));
  framed.writeBigUInt64LE(BigInt(framed.length), programs + 32);
  await expect(parse(framed)).rejects.toThrow(/leaves the artifact/u);
});

it("does not allocate the declared decoded note size, but still validates stored ranges", async () => {
  const bytes = compressedElfNoteSectionFixture();
  const noteSection = 64 + 64;
  const storedOffset = Number(bytes.readBigUInt64LE(noteSection + 24));
  bytes.writeBigUInt64LE(0xffffffffffffffffn, storedOffset + 8);
  await expect(parse(bytes)).rejects.toThrow(
    expect.objectContaining({ kind: "unsupported" }),
  );
  bytes.writeBigUInt64LE(0n, noteSection + 32);
  await expect(parse(bytes)).rejects.toThrow(
    expect.objectContaining({ kind: "unsupported" }),
  );
  bytes.writeBigUInt64LE(BigInt(bytes.length), noteSection + 32);
  await expect(parse(bytes)).rejects.toThrow(ArtifactReaderFailure);
});

it("does not decode an earlier raw section overlapping compressed storage", async () => {
  const bytes = withElf64DirectSectionCount(
    compressedElfNoteSectionFixture(),
    4,
  );
  const alias = Number(bytes.readBigUInt64LE(40)) + 64;
  bytes.copy(bytes, alias + 128, alias, alias + 64);
  bytes.writeBigUInt64LE(0n, alias + 8);
  bytes.writeBigUInt64LE(bytes.readBigUInt64LE(alias + 24) + 4n, alias + 24);
  await expect(parse(bytes)).rejects.toThrow(
    expect.objectContaining({ kind: "unsupported" }),
  );
});

it("preserves unknown ELF64 section flag bits without treating them as file sizes", async () => {
  const bytes = elfNoteFixture({ ownership: "section" });
  bytes.writeBigUInt64LE(0x8000000000000000n, 64 + 64 + 8);
  bytes.writeBigUInt64LE(0x8000000000000000n, 64 + 2 * 64 + 8);
  expect((await parse(bytes)).entries[0]?.gnu?.build_id_hex).toBe(
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
  async (bits, little, compressionType) => {
    const report = await parse(
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
  async (compressionType) => {
    const name = "n".repeat(512);
    const bytes = compressedElfNoteFixture(64, true, compressionType, name);
    expect(bytes.length).toBeLessThan(name.length);
    const report = await parse(bytes);
    expect(report.tables[0]?.name).toBe(name);
  },
);

it.each([1, 2])(
  "rejects malformed algorithm %i section-name storage",
  async (compressionType) => {
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
      await expect(parse(bytes), damage).rejects.toThrow(
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

it("keeps note facts but marks section names unavailable for unknown compression", async () => {
  const report = await parse(compressedElfNoteFixture(64, true, 3));
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
  async (compressionType) => {
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
      await parse(bytes, input);
    } catch (cause) {
      failure = cause;
    }
    expect(elfSectionNameBudget(failure)).toMatchObject({
      required: BigInt(minimumMaxFileBytes),
      selected: bytes.length + 1,
    });

    const admitted = await parse(
      bytes,
      inspectElfNotesInputSchema.parse({
        path: defaults.path,
        max_file_bytes: minimumMaxFileBytes,
      }),
    );
    expect(admitted.tables[0]?.name).toBe(".note.gnu.build-id");
  },
);

it("reports independent PT_NOTE and SHT_NOTE declarations of the same bytes", async () => {
  const report = await parse(elfNoteFixture({ ownership: "both" }));
  expect(report.tables.map((table) => table.kind).sort()).toEqual([
    "program",
    "section",
  ]);
  expect(
    report.entries.filter((entry) => entry.type_name === "gnu_build_id"),
  ).toHaveLength(2);
});

it.each([true, false])(
  "decodes FDO package and dlopen notes (little endian: %s)",
  async (little) => {
    const packaging = {
      type: "rpm",
      name: "café",
      "extension-id": 9007199254740991,
    };
    const dlopen = [{ soname: ["libdemo.so.1"], feature: "examples" }];
    const packagingBytes = Buffer.from(JSON.stringify(packaging) + "\0\0");
    const dlopenBytes = Buffer.from(JSON.stringify(dlopen) + "\0");
    const notes = Buffer.concat([
      elfNote("FDO", 0xcafe1a7e, packagingBytes, little),
      elfNote("FDO", 0x407c0c0a, dlopenBytes, little),
      elfNote("FDO", 99, Buffer.from("opaque"), little),
    ]);
    const report = await parse(
      elfNoteFixture({ ownership: "both", notes, little }),
    );
    const expected = [
      ["fdo_packaging_metadata", { metadata: packaging, issue: null }],
      ["fdo_dlopen_metadata", { metadata: dlopen, issue: null }],
      ["unknown", null],
    ];
    expect(
      report.entries.map(({ type_name, fdo }) => [type_name, fdo]),
    ).toEqual([...expected, ...expected]);
    expect(report.entries[0]?.descriptor.sha256).toBe(
      createHash("sha256").update(packagingBytes).digest("hex"),
    );
    expect(report.coverage.status).toBe("complete");
    expect(report.limitations).toContain(
      "FDO packaging and dlopen metadata are unverified producer declarations.",
    );
  },
);

it("retains raw descriptors across malformed FDO metadata in one note table", async () => {
  const cases = [
    [
      "missing terminator",
      0xcafe1a7e,
      Buffer.from("{}"),
      /not NUL-terminated/u,
    ],
    ["trailing data", 0xcafe1a7e, Buffer.from("{}\0x"), /non-NUL bytes/u],
    ["invalid UTF-8", 0xcafe1a7e, Buffer.from([0xc3, 0]), /valid UTF-8/u],
    ["invalid JSON", 0xcafe1a7e, Buffer.from("{\0"), /exact JSON/u],
    [
      "inexact number",
      0xcafe1a7e,
      Buffer.from('{"id":9007199254740993}\0'),
      /exact JSON/u,
    ],
    [
      "duplicate name",
      0xcafe1a7e,
      Buffer.from('{"name":"one","name":"two"}\0'),
      /repeats/u,
    ],
    [
      "package array",
      0xcafe1a7e,
      Buffer.from("[]\0"),
      /must be a JSON object/u,
    ],
    ["dlopen scalar", 0x407c0c0a, Buffer.from("[1]\0"), /array of objects/u],
    [
      "Evidence nesting",
      0xcafe1a7e,
      Buffer.from('{"deep":' + "[".repeat(996) + "0" + "]".repeat(996) + "}\0"),
      /nesting allowance/u,
    ],
  ] as const;
  const notes = Buffer.concat(
    cases.map(([, type, descriptor]) => elfNote("FDO", type, descriptor)),
  );
  const report = await parse(elfNoteFixture({ ownership: "program", notes }));
  expect(report.coverage).toEqual({
    status: "complete",
    examined_entries: cases.length,
    examined_tables: 1,
  });
  for (const [index, [name, , descriptor, issue]] of cases.entries())
    expect(report.entries[index], name).toMatchObject({
      descriptor: {
        bytes: descriptor.length,
        sha256: createHash("sha256").update(descriptor).digest("hex"),
      },
      fdo: { metadata: null, issue: expect.stringMatching(issue) },
    });
});

it("bounds distinct FDO decoding and each emitted copy independently", async () => {
  const metadata = { name: "x".repeat(33_000) };
  const descriptor = Buffer.from(JSON.stringify(metadata) + "\0");
  const note = elfNote("FDO", 0xcafe1a7e, descriptor);
  const repeated = await parse(
    elfNoteFixture({ ownership: "both", notes: note }),
  );
  expect(repeated.entries.map(({ fdo }) => fdo)).toEqual([
    { metadata, issue: null },
    {
      metadata: null,
      issue: expect.stringMatching(/projected JSON allowance/u),
    },
  ]);
  expect(repeated.entries[0]?.descriptor).toEqual(
    repeated.entries[1]?.descriptor,
  );
  const distinct = await parse(
    elfNoteFixture({
      ownership: "program",
      notes: Buffer.concat([note, note, gnuBuildIdNote()]),
    }),
  );
  expect(distinct.entries.map(({ fdo }) => fdo)).toEqual([
    { metadata, issue: null },
    {
      metadata: null,
      issue: expect.stringMatching(/descriptor decode allowance/u),
    },
    null,
  ]);
  expect(distinct.entries[2]?.gnu?.build_id_hex).toBe(
    "0123456789abcdef0123456789abcdef01234567",
  );
  expect(distinct.coverage.status).toBe("complete");
});

it("reports missing note tables without claiming notes never existed", async () => {
  const report = await parse(elfNoteFixture({ ownership: "none" }));
  expect(report.tables).toEqual([]);
  expect(report.entries).toEqual([]);
  expect(report.limitations[0]).toMatch(/No PT_NOTE/u);
});

it("diagnoses incomplete note framing at the entry limit", async () => {
  const note = elfNote("REA", 9, Buffer.from([1]));
  const truncatedName = Buffer.from(note);
  truncatedName.writeUInt32LE(16);
  const truncatedDescriptor = Buffer.from(note);
  truncatedDescriptor.writeUInt32LE(8, 4);
  const truncatedPadding = note.subarray(0, note.length - 1);
  const input = { ...defaults, max_entries: 1 };
  for (const truncated of [
    truncatedName,
    truncatedDescriptor,
    truncatedPadding,
  ]) {
    const image = elfNoteFixture({
      ownership: "program",
      notes: Buffer.concat([note, truncated]),
    });
    await expect(parse(image, input)).rejects.toThrow(
      expect.objectContaining({
        reason: "format",
      }),
    );
  }
});

it("keeps non-GNU owners as unknown types with descriptor hashes", async () => {
  const payload = Buffer.from("hello");
  const notes = elfNote("CORE", 1, payload);
  const report = await parse(elfNoteFixture({ ownership: "program", notes }));
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

it.each(["program", "section"] as const)(
  "keeps the 8-byte stride and physical descriptor for a GNU property note in a %s table",
  async (ownership) => {
    const notes = Buffer.concat([
      elfNote("GNU", 3, Buffer.alloc(20, 1), true, 8),
      gnuPropertyNote(),
    ]);
    const report = await parse(
      elfNoteFixture({
        ownership,
        notes,
        alignment: 8,
        sectionName: ".note.gnu.property",
      }),
    );
    const offset = ownership === "program" ? 120 : 256;
    expect(report.tables).toMatchObject([
      {
        kind: ownership,
        name: ownership === "section" ? ".note.gnu.property" : null,
        alignment: 8,
        location: { offset, bytes: 88 },
      },
    ]);
    expect(report.entries).toMatchObject([
      { type_name: "gnu_build_id", location: { offset, bytes: 40 } },
      {
        owner: "GNU",
        type: 5,
        type_name: "gnu_property",
        namesz: 4,
        descsz: 32,
        location: { offset: offset + 40, bytes: 48 },
        descriptor: {
          bytes: 32,
          location: { offset: offset + 56, bytes: 32 },
        },
      },
    ]);
  },
);

it.each([0, 1] as const)(
  "treats declared note alignment %i as 4-byte padding",
  async (alignment) => {
    const report = await parse(
      elfNoteFixture({ ownership: "program", alignment }),
    );
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
  async () => {
    const report = await parse(hostElf!);
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
  async ({ offset, name, state }) => {
    const bytes = unterminatedNoteSections(1, 4);
    bytes.set([0x41, 0x42, 0xe9, 0], bytes.length - 4);
    bytes.writeUInt32LE(offset, 64 + 2 * 64);
    const notes = await parse(bytes);
    const directory = readElfDirectoryFromBuffer(bytes, "elf-directory");
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
  async (terminatorOffset) => {
    const bytes = unterminatedNoteSections(1, terminatorOffset + 1);
    bytes[bytes.length - 1] = 0;
    const name = "A".repeat(terminatorOffset);
    const notes = await parse(bytes);
    const directory = readElfDirectoryFromBuffer(bytes, "elf-directory");
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

it("bounds repeated scans of an unterminated section name", async () => {
  const report = await parse(unterminatedNoteSections(2, 64));
  expect(report.tables.map(({ name }) => name)).toEqual([null, null]);
  expect(report.coverage.status).toBe("complete");
  const nameWarnings = report.limitations.filter((value) =>
    /not NUL-terminated/iu.test(value),
  );
  expect(nameWarnings).toHaveLength(1);
  expect(nameWarnings[0]).toMatch(
    /section names.*incomplete.*not NUL-terminated/iu,
  );
  const crowded = unterminatedNoteSections(3, 400);
  await expect(parse(crowded)).rejects.toMatchObject(
    noteTextLimit(crowded.length),
  );
});

it("rejects note text that repeats beyond the shared byte budget", async () => {
  const notes = elfNote("A".repeat(40), 1, Buffer.alloc(0));
  const once = elfNoteFixture({ ownership: "program", notes });
  const twice = elfNoteFixture({ ownership: "both", notes });
  const input = inspectElfNotesInputSchema.parse({
    path: defaults.path,
    max_file_bytes: 200,
  });
  expect((await parse(once, input)).entries).toHaveLength(1);
  await expect(parse(twice, input)).rejects.toMatchObject(noteTextLimit(200));
});

it("rejects program and section header tables that do not fit", async () => {
  await expect(
    parse(elf64({ phoff: 64, phnum: 1 }, Buffer.from([1, 0, 0, 0]))),
  ).rejects.toThrow(/leaves the artifact/u);
  await expect(
    parse(
      elf64({ shoff: 64, shnum: 1, shentsize: 64 }, Buffer.from([0, 0, 0, 0])),
    ),
  ).rejects.toThrow(/leaves the artifact/u);
});

it("rejects an extended section count stored in section zero", async () => {
  await expect(parse(elf64({ shoff: 64, shnum: 0 }))).rejects.toThrow(
    /extended numbering/u,
  );
});

it("checks direct section count encoding in notes and the native directory", async () => {
  const bytes = elfExtendedSectionCountFixture();
  const sectionZero = Number(bytes.readBigUInt64LE(40));
  bytes.writeBigUInt64LE(0n, sectionZero + 32);
  bytes.writeUInt16LE(0xfeff, 60);
  expect((await parse(bytes)).tables[0]?.name).toBe(".note.gnu.build-id");
  expect(
    readElfDirectoryFromBuffer(bytes, "elf-directory").sections[1]?.name,
  ).toBe(".note.gnu.build-id");

  bytes.writeUInt16LE(0xff00, 60);
  const reason = /e_shnum uses a reserved direct section count/u;
  await expect(parse(bytes)).rejects.toThrow(reason);
  expect(() => readElfDirectoryFromBuffer(bytes, "elf-directory")).toThrow(
    reason,
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

it("checks extended ELF header size using the whole file for note and build-ID readers", async () => {
  const bytes = repeatedNotes(1, gnuBuildIdNote());
  const extended = Buffer.concat([
    bytes.subarray(0, 64),
    Buffer.alloc(64),
    bytes.subarray(64),
  ]);
  extended.writeUInt16LE(128, 52);
  extended.writeBigUInt64LE(128n, 32);
  extended.writeBigUInt64LE(bytes.readBigUInt64LE(72) + 64n, 136);
  const artifact = {
    path: defaults.path,
    bytes: extended.length,
    sha256: createHash("sha256").update(extended).digest("hex"),
  };
  const source = {
    size: extended.length,
    prefix: extended.subarray(0, 64),
    readRange: async (offset: number, length: number) =>
      extended.subarray(offset, offset + length),
  };
  const hex = "0123456789abcdef0123456789abcdef01234567";
  const note = { offset: 184, bytes: 36 };
  const descriptor = { offset: 200, bytes: 20 };
  const report = await parseElfNotesFromHandle(
    source,
    artifact,
    defaults,
    async () => {},
  );
  expect(report.entries).toMatchObject([
    {
      location: note,
      descriptor: { location: descriptor },
      gnu: { build_id_hex: hex },
    },
  ]);
  const expected = [
    { hex, note, descriptor, table_kind: "program", table_index: 0 },
  ];
  expect(readElfBuildIds(extended, defaults, 64).sources).toEqual(expected);
  const positional = await readElfBuildIdsFromHandle(
    source,
    defaults,
    64,
    async (request) => decodeElfSectionNameRequest(request),
  );
  expect(positional.sources).toEqual(expected);
});

it("reads aliased note tables once and retains each program header's evidence", async () => {
  const count = 32;
  const descriptor = Buffer.alloc(8192, 0xa5);
  const table = elfNote("", 0xffff, descriptor);
  const bytes = repeatedNotes(count, table);
  const reads: Array<{ offset: number; length: number }> = [];
  const artifact = {
    path: defaults.path,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const report = await parseElfNotesFromHandle(
    {
      size: bytes.length,
      prefix: bytes.subarray(0, 64),
      readRange: async (offset, length) => {
        reads.push({ offset, length });
        return bytes.subarray(offset, offset + length);
      },
    },
    artifact,
    defaults,
    async () => {},
  );
  const tableOffset = 64 + 56 * count;
  const location = { offset: tableOffset, bytes: table.length };
  const sha256 = createHash("sha256").update(descriptor).digest("hex");
  const indices = Array.from({ length: count }, (_, index) => index);
  expect(report.tables).toEqual(
    indices.map((index) => ({
      kind: "program",
      index,
      name: null,
      location,
      alignment: 4,
    })),
  );
  expect(report.entries).toMatchObject(
    indices.map((index) => ({
      index,
      table_kind: "program",
      table_index: index,
      location,
      descriptor: {
        location: { offset: tableOffset + 16, bytes: descriptor.length },
        sha256,
      },
    })),
  );
  expect(reads.filter(({ length }) => length === table.length)).toEqual([
    { offset: tableOffset, length: table.length },
  ]);
});

it("reuses one descriptor hash and GNU NUL scan across note headers", async () => {
  const payload = Buffer.alloc(400);
  const hashed = await parse(repeatedNotes(6, elfNote("X", 1, payload)));
  expect(hashed.entries).toHaveLength(6);
  expect(
    new Set(hashed.entries.map((entry) => entry.descriptor.sha256)).size,
  ).toBe(1);
  const gold = await parse(repeatedNotes(6, elfNote("GNU", 4, payload)));
  expect(gold.entries).toHaveLength(6);
  expect(gold.entries.every((entry) => entry.gnu?.gold_version === "")).toBe(
    true,
  );
  const distinct = Buffer.concat([
    elfNote("X", 1, payload),
    elfNote("X", 1, Buffer.alloc(400, 1)),
  ]);
  await expect(
    parse(
      elfNoteFixture({ ownership: "program", notes: distinct }),
      inspectElfNotesInputSchema.parse({
        path: defaults.path,
        max_file_bytes: payload.length + 160,
      }),
    ),
  ).rejects.toThrow(/byte budget/u);
});

it("preserves interior NULs in GNU gold alongside a bounded trailing scan", async () => {
  const interior = `\0`.repeat(131_072) + "x";
  const notes = Buffer.concat([
    elfNote("GNU", 4, Buffer.from("gold\0\0x\0", "latin1")),
    elfNote("GNU", 4, Buffer.from(interior, "latin1")),
  ]);
  const image = elfNoteFixture({ ownership: "program", notes });
  const started = process.cpuUsage();
  const report = await parse(image);
  const { user, system } = process.cpuUsage(started);
  // The nonzero tail exposes quadratic NUL trimming. Measure CPU to avoid
  // charging scheduler delays against the parser on loaded runners.
  expect(user + system).toBeLessThan(1_000_000);
  expect(report.entries.map(({ gnu }) => gnu?.gold_version)).toEqual([
    "gold\0\0x",
    interior,
  ]);
});

it("rejects a declared note table that extends past the file", async () => {
  const truncated = elfNoteTablePastEnd();
  await expect(parse(truncated)).rejects.toMatchObject({
    reason: "format",
    message: expect.stringMatching(/leaves the artifact/u),
  });
  const report = await parse(Buffer.concat([truncated, Buffer.alloc(3)]));
  expect(report.entries).toHaveLength(1);
  expect(report.tables[0]?.location).toEqual({ offset: 120, bytes: 20 });
});

it("fails when the entry budget is exhausted", async () => {
  const notes = Buffer.concat([
    gnuBuildIdNote(),
    gnuAbiTagNote(),
    elfNote("GNU", 4, Buffer.from("gold")),
  ]);
  const bytes = elfNoteFixture({ ownership: "program", notes });
  await expect(parse(bytes, { ...defaults, max_entries: 1 })).rejects.toThrow(
    expect.objectContaining({
      failure: expect.objectContaining({
        kind: "limit",
        limit: { name: "max_entries", maximum: 1, required: 2 },
      }),
    }),
  );
  expect(
    (await parse(bytes, { ...defaults, max_entries: 3 })).coverage,
  ).toEqual({
    status: "complete",
    examined_tables: 1,
    examined_entries: 3,
  });
});

it("reads a glibc-sized note table with the default entry budget", async () => {
  // Ubuntu's libc.so.6 has 79 SystemTap probe notes beside its build-id, ABI
  // tag and GNU property notes; this table has the first two and the probes.
  const probes = Array.from({ length: 79 }, () =>
    elfNote("stapsdt", 3, Buffer.alloc(40)),
  );
  const report = await parse(
    elfNoteFixture({
      ownership: "section",
      notes: Buffer.concat([gnuBuildIdNote(), gnuAbiTagNote(), ...probes]),
    }),
  );
  expect(report.entries).toHaveLength(81);
});

it("keeps unsafe table offsets ahead of unsupported extended numbering", async () => {
  const bytes = elfExtendedSectionCountFixture();
  bytes.writeBigUInt64LE(0xffffffffffffffffn, 32);
  await expect(parse(bytes)).rejects.toThrow(
    "ELF offset or size exceeds a safe integer.",
  );
});

it("does not apply note precision admission to unrelated program records", async () => {
  const bytes = elf64({ phoff: 64, phnum: 1 }, Buffer.alloc(56));
  bytes.writeUInt32LE(0x70000001, 64);
  for (const relative of [8, 16, 24, 32, 40, 48])
    bytes.writeBigUInt64LE(0xffffffffffffffffn, 64 + relative);
  expect((await parse(bytes)).tables).toEqual([]);
  bytes.writeUInt32LE(4, 64);
  await expect(parse(bytes)).rejects.toThrow(
    "ELF offset or size exceeds a safe integer.",
  );
});

it("keeps compressed-note refusal ahead of alignment precision admission", async () => {
  const bytes = compressedElfNoteSectionFixture();
  const sectionTable = Number(bytes.readBigUInt64LE(40));
  bytes.writeBigUInt64LE(0xffffffffffffffffn, sectionTable + 64 + 48);
  await expect(parse(bytes)).rejects.toThrow(/compressed.*note/iu);
});

it.each([
  { bits: 32, little: true },
  { bits: 32, little: false },
  { bits: 64, little: true },
  { bits: 64, little: false },
] as const)(
  "rejects dangling section names with and without notes (ELF$bits $little)",
  async ({ bits, little }) => {
    for (const ownership of ["program", "none"] as const) {
      const bytes = elfNoteFixture({ bits, little, ownership });
      const before = await parse(bytes);
      const nameOffset = bits === 64 ? 62 : 50;
      if (little) bytes.writeUInt16LE(5, nameOffset);
      else bytes.writeUInt16BE(5, nameOffset);
      await expect(parse(bytes)).rejects.toThrow(
        "ELF section table is missing",
      );
      if (little) bytes.writeUInt16LE(0, nameOffset);
      else bytes.writeUInt16BE(0, nameOffset);
      expect(await parse(bytes)).toEqual(before);
    }
  },
);

it("decodes Linux core dump notes for 32-bit big-endian", async () => {
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
    machine: 40,
    little: false,
    type: 4,
    ownership: "program",
    notes,
  });

  const report = await parse(bytes);
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

const elf32ProcessLayouts: readonly [
  name: string,
  machine: number,
  little: boolean,
  idWidth: 2 | 4,
  flags?: number,
][] = [
  ["MIPS little", 8, true, 4],
  ["MIPS big", 8, false, 4],
  ["PowerPC big", 20, false, 4],
  ["RISC-V little", 243, true, 4],
  ["Hexagon V4 little", 164, true, 4, 3],
  ["PA-RISC big", 15, false, 4],
  ["OpenRISC big", 92, false, 4],
  ["OpenRISC Linux big", 0x8472, false, 4],
  ["ARC compact little", 93, true, 4],
  ["ARCv2 big", 195, false, 4],
  ["Xtensa little", 94, true, 4],
  ["MicroBlaze big", 189, false, 4],
  ["C-SKY little", 252, true, 4],
  ["C-SKY big", 252, false, 4],
  ["Blackfin little", 106, true, 4],
  ["UniCore little", 110, true, 4],
  ["Nios II little", 113, true, 4],
  ["C6x little", 140, true, 4],
  ["C6x big", 140, false, 4],
  ["NDS32 little", 167, true, 4],
  ["NDS32 big", 167, false, 4],
  ["Meta little", 174, true, 4],
  ["TILEPro little", 188, true, 4],
  ["TILE-Gx m32 little", 191, true, 4],
  ["SuperH little", 42, true, 2],
  ["SuperH big", 42, false, 2],
];

it.each(elf32ProcessLayouts)(
  "decodes the Linux ELF32 process record for %s",
  async (_name, machine, little, idWidth, flags) => {
    const { bytes, shortened, expected } = elf32ProcessIdentityFixture(
      machine,
      little,
      idWidth,
      flags,
    );
    const report = await parse(bytes);
    expect(report).toMatchObject({
      format: "elf32",
      byte_order: little ? "little" : "big",
      machine,
      coverage: { status: "complete", examined_entries: 2 },
    });
    expect(report.entries[0]?.core?.prpsinfo).toEqual(expected);
    expect(report.entries[1]).toMatchObject({
      type_name: "core_prpsinfo",
      descriptor: {
        bytes: shortened.length,
        sha256: createHash("sha256").update(shortened).digest("hex"),
      },
      core: null,
    });
  },
);

it.each([
  { name: "i386", machine: 3, little: true },
  { name: "s390 compat", machine: 22, little: false },
  { name: "x86 x32 compat", machine: 62, little: true },
])(
  "decodes the 124-byte prpsinfo with 16-bit IDs for $name",
  async ({ machine, little }) => {
    const report = await parse(
      elfNoteFixture({
        bits: 32,
        machine,
        little,
        type: 4,
        ownership: "program",
        notes: corePrpsinfoNote({
          bits: 32,
          little,
          state: 1,
          uid: 500,
          gid: 600,
          pid: 4242,
          ppid: 1,
          pgrp: 4242,
          sid: 4242,
          fname: "legacy-proc",
          psargs: "./legacy-proc --serve",
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
      filename: "legacy-proc",
      psargs: "./legacy-proc --serve",
    });
  },
);

it.each([
  { name: "an oversized legacy layout", machine: 3, idWidth: 4 as const },
  {
    name: "an unknown machine with 16-bit fields",
    machine: 0xffff,
    idWidth: 2 as const,
  },
  {
    name: "an unknown machine with 32-bit fields",
    machine: 0xffff,
    idWidth: 4 as const,
  },
])("keeps raw prpsinfo evidence for $name", async ({ machine, idWidth }) => {
  const descriptor = corePrpsinfoDescriptor({ bits: 32, idWidth });
  const report = await parse(
    elfNoteFixture({
      bits: 32,
      machine,
      type: 4,
      ownership: "program",
      notes: elfNote("CORE", 3, descriptor),
    }),
  );
  expect(report.coverage).toMatchObject({
    status: "complete",
    examined_entries: 1,
  });
  expect(report.entries[0]).toMatchObject({
    type_name: "core_prpsinfo",
    descriptor: {
      bytes: descriptor.length,
      sha256: createHash("sha256").update(descriptor).digest("hex"),
    },
    core: null,
  });
});

it.each([
  { bits: 32 as const, little: true, address: 0xf1234567n },
  { bits: 64 as const, little: false, address: 0xf123456789abcdefn },
])(
  "keeps unsigned ELF$bits file and auxiliary words exact",
  async ({ bits, little, address }) => {
    const mapping = {
      start: address,
      end: address + 1n,
      file_ofs: 1,
      path: "/image",
    };
    const notes = Buffer.concat([
      coreFileNote([mapping], 4096, bits, little),
      coreAuxvNote([[9, address]], bits, little),
    ]);
    const { entries } = await parse(
      elfNoteFixture({ bits, little, type: 4, ownership: "program", notes }),
    );
    const expected = `0x${address.toString(16)}`;
    expect(entries[0]?.core?.file?.mappings[0]?.start_address).toBe(expected);
    expect(entries[1]?.core?.auxv).toEqual([
      { type: 9, type_name: "AT_ENTRY", value: expected },
    ]);
  },
);

it.each([
  [10, "AT_NOTELF"],
  [24, "AT_BASE_PLATFORM"],
  [27, "AT_RSEQ_FEATURE_SIZE"],
  [28, "AT_RSEQ_ALIGN"],
  [29, "AT_HWCAP3"],
  [30, "AT_HWCAP4"],
  [51, "AT_MINSIGSTKSZ"],
])("names auxv type %i as %s", async (type, name) => {
  const notes = coreAuxvNote([[type, 1]]);
  const { entries } = await parse(
    elfNoteFixture({ ownership: "program", notes }),
  );
  expect(entries[0]?.core?.auxv?.[0]?.type_name).toBe(name);
});

it("tolerates malformed core notes by returning null without throwing", async () => {
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

  const report = await parse(bytes);
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
  const valid = await parse(
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

it("decodes siginfo using target ABI for MIPS machines", async () => {
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
  const report = await parse(bytes);
  expect(report.entries[0]?.core?.siginfo).toEqual({
    signo: 11,
    code: 1,
    errno: 0,
  });
});

it("preserves negative process IDs and signal numbers without rewriting to zero", async () => {
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
  const report = await parse(bytes);
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

it("rejects 64-bit auxv tags and out-of-range page sizes with core: null without schema error", async () => {
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
  const report = await parse(bytes);
  expect(report.entries[0]?.core).toBeNull();
  expect(report.entries[1]?.core).toBeNull();
});

it.each([32, 64] as const)(
  "leaves ELF%d NT_FILE mappings unknown when the descriptor contains a surplus pathname",
  async (bits) => {
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
    const exact = await inspect(Buffer.alloc(0));
    const padded = await inspect(Buffer.alloc(3));
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
    const malformed = await inspect(tail);
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

it("does not spend text budget on malformed or discarded NT_FILE paths", async () => {
  const header = Buffer.alloc(16);
  header.writeBigUInt64LE(32n, 0);
  header.writeBigUInt64LE(4096n, 8); // page_size = 4096
  const mappings = Buffer.alloc(32 * 24);
  const paths = Buffer.from(
    "/bin/app\0unterminated_path_without_null",
    "latin1",
  );
  const malformed = Buffer.concat([header, mappings, paths]);
  const badFileNote = elfNote("CORE", 0x46494c45, malformed);
  const path = "p".repeat(512);
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
  const budget = 2 * 14 + 54 + path.length * 3;
  expect(image.length).toBeLessThanOrEqual(budget);
  const bytes = Buffer.concat([image, Buffer.alloc(budget - image.length)]);
  const report = await parse(bytes);
  expect(report.entries[0]).toMatchObject({
    type_name: "core_file",
    core: null,
    descriptor: {
      bytes: malformed.length,
      sha256: createHash("sha256").update(malformed).digest("hex"),
    },
  });
  expect(report.entries[1]?.core?.file?.mappings).toEqual([
    {
      start_address: "0x1000",
      end_address: "0x2000",
      file_offset_pages: "0x0",
      path,
      path_hex: Buffer.from(path).toString("hex"),
    },
  ]);
  await expect(parse(bytes.subarray(0, bytes.length - 1))).rejects.toThrow(
    expect.objectContaining({
      failure: expect.objectContaining({
        kind: "limit",
        limit: expect.objectContaining({ name: "note_text_bytes" }),
      }),
    }),
  );
});

it.each([
  { bits: 64, little: true, machine: 183 },
  { bits: 64, little: true, machine: 62 },
  { bits: 32, little: false, machine: 8 },
  { bits: 64, little: false, machine: 21 },
] as const)(
  "decodes Android .note.android.ident 132-byte, 152-byte, and legacy 4-byte descriptors (ELF$bits little=$little machine=$machine)",
  async ({ bits, little, machine }) => {
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
    const report = await parse(bytes);
    expect(report.tables[0]?.name).toBe(".note.android.ident");
    const ident = {
      owner: "Android",
      type: 1,
      type_name: "android_ident",
      gnu: null,
      core: null,
    };
    expect(report.entries).toMatchObject([
      {
        ...ident,
        descsz: 132,
        android: {
          android_api: 24,
          ndk_version: "r27c",
          ndk_build_number: "12297006",
        },
      },
      {
        ...ident,
        descsz: 152,
        android: {
          android_api: 35,
          ndk_version: "r28",
          ndk_build_number: "12479018",
        },
      },
      {
        ...ident,
        descsz: 4,
        descriptor: { bytes: 4, hex: little ? "15000000" : "00000015" },
        android: { android_api: 21, ndk_version: null, ndk_build_number: null },
      },
      {
        owner: "Android",
        type: 2,
        type_name: "unknown",
        gnu: null,
        core: null,
        android: null,
        descriptor: { bytes: 4, hex: "01020304" },
      },
    ]);
  },
);

it("degrades truncated, unterminated, or non-printable Android ident notes to null while preserving descriptors", async () => {
  const descriptor = Buffer.alloc(132);
  descriptor.writeUInt32LE(24, 0);
  descriptor.write("r27c\0", 4);
  descriptor.write("12297006\0", 68);
  const controlByte = Buffer.from(descriptor);
  controlByte[5] = 0x07;
  const nonZeroPadding = Buffer.from(descriptor);
  nonZeroPadding[20] = 0x58;
  const descriptors = [
    Buffer.alloc(0),
    Buffer.of(0x15, 0),
    descriptor.subarray(0, 68),
    Buffer.from(descriptor).fill(0x72, 4, 68),
    Buffer.from(descriptor).fill(0x39, 68, 132),
    controlByte,
    nonZeroPadding,
  ];
  const notes = Buffer.concat(
    descriptors.map((desc) => elfNote("Android", 1, desc)),
  );
  const report = await parse(elfNoteFixture({ ownership: "program", notes }));
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

it("charges TextBudget for scanned and retained Android ident strings", async () => {
  // 6 aliased headers over a 552-byte file: 128 scanned once <= 552, and
  // 6 * (23 owner + 12 retained) = 210 <= 552 (un-cached 6 * 128 = 768 > 552).
  const typicalIdent = androidIdentNote({
    androidApi: 24,
    ndkVersion: "r27c",
    ndkBuildNumber: "12297006",
  });
  const aliased6 = await parse(repeatedNotes(6, typicalIdent));
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
  const retained = repeatedNotes(6, maxStrings);
  await expect(parse(retained)).rejects.toMatchObject(
    noteTextLimit(retained.length),
  );

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

  const withinScanBudget = await parse(
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

  await expect(
    parse(sharedScanImage, { ...defaults, max_file_bytes: 259 }),
  ).rejects.toMatchObject(noteTextLimit(259));
});
