import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import {
  MAX_DWARF_DECOMPRESSED_SECTION_BYTES,
  inspectDwarfUnitsInputSchema,
} from "../../domain/native/dwarfUnits.js";
import {
  CPU_ARM64,
  CPU_X86_64,
  universalMacho,
} from "../../../tests/fixtures/universalMacho.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { DwarfUnitsProvider } from "./DwarfUnitsProvider.js";
import {
  DwarfSectionAllowanceFailure,
  locateDwarfSections,
} from "./DwarfSections.js";
import {
  abbrevTable,
  compileUnit,
  decompressionBombBody,
  elfCompressedBody,
  elfDebugImage,
  elfImage,
  gnuZdebugBody,
  macho64,
  namedUnit,
  peImage,
  strxBeforeBase,
} from "./DwarfUnits.fixture.js";

const inspect = async (
  bytes: Buffer,
  extra: {
    readonly architecture?: "x86" | "x86_64" | "arm" | "arm64";
    readonly offset?: number;
    readonly limit?: number;
  } = {},
) => {
  const root = await createTestTempDirectory("rea-dwarf-units-");
  const path = join(root, "image");
  await writeFile(path, bytes);
  const provider = new DwarfUnitsProvider();
  try {
    return await provider.inspect(
      inspectDwarfUnitsInputSchema.parse({ path, ...extra }),
    );
  } finally {
    await provider.close();
  }
};

it("reads a little-endian ELF unit and refuses architecture on a thin file", async () => {
  const named = namedUnit({ name: "main.c", dwoName: "main.dwo" });
  const image = elfDebugImage(named);
  const read = await inspect(image);
  expect(read.ok).toBe(true);
  if (!read.ok) throw read.error;
  expect(read.value).toMatchObject({
    format: "elf",
    architecture: "x86_64",
    coverage: { status: "complete", reason: null },
    total_units: 1,
  });
  expect(read.value.units[0]).toMatchObject({
    name: { state: "present", value: "main.c" },
    dwo_name: { state: "present", value: "main.dwo" },
    file_offset: expect.any(Number),
  });
  expect(read.value.limitations[0]).toContain("Child DIEs");
  const rejected = await inspect(image, { architecture: "x86_64" });
  expect(rejected.ok).toBe(false);
  if (!rejected.ok) {
    expect(rejected.error).toBeInstanceOf(AnalysisInputError);
    expect(rejected.error).toMatchObject({
      issues: [
        {
          path: ["architecture"],
          message: expect.stringContaining("omit architecture"),
        },
      ],
    });
  }
});

it("reads a big-endian ELF unit", async () => {
  const named = namedUnit({ little: false, name: "be.c" });
  const read = await inspect(
    elfDebugImage(named, { little: false, machine: 20 }),
  );
  expect(read.ok).toBe(true);
  if (!read.ok) throw read.error;
  expect(read.value).toMatchObject({
    byte_order: "big",
    architecture: "powerpc",
    units: [{ name: { state: "present", value: "be.c" } }],
  });
});

it("reports absent debug info for this file and names a present .gnu_debuglink", async () => {
  const plain = await inspect(elfImage());
  expect(plain.ok).toBe(true);
  if (!plain.ok) throw plain.error;
  expect(plain.value.coverage.status).toBe("no_debug_info");
  expect(plain.value.coverage.reason).toContain("does not establish");
  expect(plain.value.limitations.join("\n")).toContain(
    ".gnu_debuglink was not observed",
  );
  const linked = await inspect(
    elfImage({
      sections: [
        { name: ".gnu_debuglink", body: Buffer.from("other.debug\0") },
      ],
    }),
  );
  expect(linked.ok).toBe(true);
  if (!linked.ok) throw linked.error;
  expect(linked.value.coverage.status).toBe("no_debug_info");
  expect(linked.value.limitations.join("\n")).toContain(
    "A .gnu_debuglink section is present",
  );
});

it("refuses a decompression bomb before inflation and reads zlib, zstd, and GNU payloads", async () => {
  const named = namedUnit({ name: "compressed.c" });
  const bomb = await inspect(
    elfDebugImage(
      { info: decompressionBombBody(), abbrev: named.abbrev },
      { infoFlags: 0x800n },
    ),
  );
  expect(bomb.ok).toBe(false);
  if (!bomb.ok) {
    expect(bomb.error).toBeInstanceOf(AnalysisResourceConstraintError);
    expect(bomb.error).toMatchObject({
      resource: "memory",
      fixedAllowance: {
        name: "The DWARF decompressed section allowance",
        kind: "parser",
      },
    });
  }
  for (const [compression, body] of [
    ["zlib", elfCompressedBody(named.info, "zlib")],
    ["zstd", elfCompressedBody(named.info, "zstd")],
  ] as const) {
    const read = await inspect(
      elfDebugImage(
        { info: body, abbrev: named.abbrev },
        { infoFlags: 0x800n },
      ),
    );
    expect(read.ok, compression).toBe(true);
    if (!read.ok) throw read.error;
    expect(
      read.value.sections.find((section) => section.role === ".debug_info"),
    ).toMatchObject({
      compression,
    });
    expect(read.value.units[0]).toMatchObject({
      name: { state: "present", value: "compressed.c" },
      file_offset: null,
    });
  }
  const gnu = await inspect(
    elfDebugImage(
      { info: gnuZdebugBody(named.info), abbrev: named.abbrev },
      { infoName: ".zdebug_info" },
    ),
  );
  expect(gnu.ok).toBe(true);
  if (!gnu.ok) throw gnu.error;
  expect(gnu.value.sections[0]).toMatchObject({
    name: ".zdebug_info",
    role: ".debug_info",
    compression: "zlib",
  });
  expect(gnu.value.units[0]?.file_offset).toBeNull();
});

it("reads PE long names and a Mach-O __debug_str_offs section", async () => {
  const sample = strxBeforeBase();
  const pe = await inspect(
    peImage([
      { name: ".debug_info", body: sample.info },
      { name: ".debug_abbrev", body: sample.abbrev },
      { name: ".debug_str", body: sample.str },
      { name: ".debug_str_offsets", body: sample.strOffsets },
    ]),
  );
  expect(pe.ok).toBe(true);
  if (!pe.ok) throw pe.error;
  expect(pe.value.format).toBe("pe");
  expect(pe.value.units[0]?.name.value).toBe("hello.c");
  const macho = await inspect(
    macho64({
      cpuType: CPU_ARM64,
      sections: [
        { name: "__debug_info", body: sample.info },
        { name: "__debug_abbrev", body: sample.abbrev },
        { name: "__debug_str", body: sample.str },
        { name: "__debug_str_offsets", body: sample.strOffsets },
      ],
    }),
  );
  expect(macho.ok).toBe(true);
  if (!macho.ok) throw macho.error;
  expect(macho.value).toMatchObject({
    format: "macho",
    architecture: "arm64",
  });
  expect(macho.value.sections.map((section) => section.name)).toContain(
    "__debug_str_offs",
  );
  expect(macho.value.units[0]?.name.value).toBe("hello.c");
  expect(macho.value.limitations.join("\n")).toContain(".dSYM");
});

it("decodes a shared PE long name once, including at the per-name allowance", async () => {
  const image = peImage([
    { name: "x".repeat(65536), body: Buffer.alloc(0) },
    ...Array.from({ length: 127 }, () => ({
      name: "/4",
      body: Buffer.alloc(0),
    })),
  ]);
  const decode = vi.spyOn(Buffer.prototype, "toString");
  try {
    const read = await inspect(image);
    expect(read.ok).toBe(true);
    if (!read.ok) throw read.error;
    expect(read.value.coverage.status).toBe("no_debug_info");
    expect(
      decode.mock.calls.filter(
        ([encoding, start, end]) =>
          encoding === "latin1" &&
          typeof start === "number" &&
          typeof end === "number" &&
          end - start === 65536,
      ),
    ).toHaveLength(1);
  } finally {
    decode.mockRestore();
  }
});

it("bounds individual PE long names before decoding", async () => {
  const read = await inspect(
    peImage([{ name: "x".repeat(65537), body: Buffer.alloc(0) }]),
  );
  expect(read.ok).toBe(false);
  if (!read.ok) {
    expect(read.error).toBeInstanceOf(AnalysisResourceConstraintError);
    expect(read.error.message).toContain("65536-byte decoding allowance");
  }
});

it("bounds aggregate PE name decoding for overlapping string-table offsets", async () => {
  const read = await inspect(
    peImage([
      { name: "x".repeat(65536), body: Buffer.alloc(0) },
      ...Array.from({ length: 299 }, (_, index) => ({
        name: `/${String(index + 5)}`,
        body: Buffer.alloc(0),
      })),
    ]),
  );
  expect(read.ok).toBe(false);
  if (!read.ok) {
    expect(read.error).toBeInstanceOf(AnalysisResourceConstraintError);
    expect(read.error.message).toContain("16 MiB structural budget");
  }
});

it("rejects an unterminated PE long name within the decoding allowance", async () => {
  const image = peImage([{ name: ".debug_info", body: Buffer.alloc(0) }]);
  image[image.length - 1] = 120;
  const read = await inspect(image);
  expect(read.ok).toBe(false);
  if (!read.ok) {
    expect(read.error).toBeInstanceOf(AnalysisInputError);
    expect(read.error).toMatchObject({
      issues: [{ message: expect.stringContaining("could not be resolved") }],
    });
  }
});

it("selects one universal Mach-O slice", async () => {
  const named = namedUnit({ name: "arm.c" });
  const arm = macho64({
    cpuType: CPU_ARM64,
    sections: [
      { name: "__debug_info", body: named.info },
      { name: "__debug_abbrev", body: named.abbrev },
    ],
  });
  const intel = macho64({ cpuType: CPU_X86_64 });
  const fat = universalMacho([
    { bytes: intel, cpuType: CPU_X86_64, cpuSubtype: 0 },
    { bytes: arm, cpuType: CPU_ARM64, cpuSubtype: 0 },
  ]).bytes;
  const missing = await inspect(fat);
  expect(missing.ok).toBe(false);
  if (!missing.ok)
    expect(missing.error).toMatchObject({
      _tag: "AnalysisInputError",
      issues: [
        {
          path: ["architecture"],
          message: expect.stringContaining("select one architecture"),
        },
      ],
    });
  const selected = await inspect(fat, { architecture: "arm64" });
  expect(selected.ok).toBe(true);
  if (!selected.ok) throw selected.error;
  expect(selected.value.selected_slice?.cpu_type).toBe(CPU_ARM64);
  expect(selected.value.units[0]?.name.value).toBe("arm.c");
  const other = await inspect(fat, { architecture: "x86_64" });
  expect(other.ok).toBe(true);
  if (!other.ok) throw other.error;
  expect(other.value.coverage.status).toBe("no_debug_info");
  expect(other.value.units).toEqual([]);
});

it("does not inflate a duplicate section and caps decompressed bytes across roles", async () => {
  const named = namedUnit({ name: "kept.c" });
  const duplicate = await inspect(
    elfDebugImage(
      { info: named.info, abbrev: named.abbrev },
      {
        extra: [
          {
            name: ".debug_info",
            body: decompressionBombBody(),
            flags: 0x800n,
          },
        ],
      },
    ),
  );
  expect(duplicate.ok).toBe(true);
  if (!duplicate.ok) throw duplicate.error;
  expect(duplicate.value.units[0]?.name.value).toBe("kept.c");
  expect(
    duplicate.value.omissions.some(
      (omission) =>
        omission.name === ".debug_info" &&
        omission.reason.startsWith("Duplicate"),
    ),
  ).toBe(true);
  const info = elfCompressedBody(named.info, "zlib");
  const abbrev = elfCompressedBody(
    named.abbrev,
    "zlib",
    64,
    true,
    MAX_DWARF_DECOMPRESSED_SECTION_BYTES,
  );
  const aggregate = await inspect(
    elfImage({
      sections: [
        { name: ".debug_info", body: info, flags: 0x800n },
        { name: ".debug_abbrev", body: abbrev, flags: 0x800n },
      ],
    }),
  );
  expect(aggregate.ok).toBe(false);
  if (!aggregate.ok)
    expect(aggregate.error).toBeInstanceOf(AnalysisResourceConstraintError);
});

it("charges failed decompression attempts against the shared allowance", () => {
  const allowance = 1024 * 1024;
  const bytes = Buffer.alloc(allowance);
  for (const gnu of [false, true]) {
    const body = gnu ? gnuZdebugBody(bytes) : elfCompressedBody(bytes, "zlib");
    // Corrupt the checksum after the stream has produced its output.
    body[body.length - 1] = body[body.length - 1]! ^ 1;
    const image = elfImage({
      sections: Array.from({ length: 32 }, () => ({
        name: gnu ? ".zdebug_info" : ".debug_info",
        body,
        flags: gnu ? 0n : 0x800n,
      })),
    });
    expect(() => locateDwarfSections(image, allowance)).toThrow(
      DwarfSectionAllowanceFailure,
    );
  }
});

it("keeps the inflate allowance after a truncated optional section header", async () => {
  const named = namedUnit({ name: "kept.c" });
  const read = await inspect(
    elfImage({
      sections: [
        { name: ".debug_line_str", body: Buffer.alloc(4), flags: 0x800n },
        {
          name: ".debug_info",
          body: elfCompressedBody(named.info, "zlib"),
          flags: 0x800n,
        },
        { name: ".debug_abbrev", body: named.abbrev },
      ],
    }),
  );
  expect(read.ok).toBe(true);
  if (!read.ok) throw read.error;
  expect(read.value.units[0]?.name.value).toBe("kept.c");
  expect(read.value.omissions).toContainEqual(
    expect.objectContaining({
      name: ".debug_line_str",
      reason: expect.stringContaining("truncated"),
    }),
  );
});

it("keeps units after a corrupt optional compressed stream", async () => {
  const named = namedUnit({ name: "kept.c" });
  const corrupt = elfCompressedBody(Buffer.from("abc"), "zlib");
  corrupt[corrupt.length - 1] = (corrupt.at(-1) ?? 0) ^ 1;
  const read = await inspect(
    elfImage({
      sections: [
        { name: ".debug_line_str", body: corrupt, flags: 0x800n },
        {
          name: ".debug_info",
          body: elfCompressedBody(named.info, "zlib"),
          flags: 0x800n,
        },
        { name: ".debug_abbrev", body: named.abbrev },
      ],
    }),
  );
  expect(read.ok).toBe(true);
  if (!read.ok) throw read.error;
  expect(read.value.units[0]?.name.value).toBe("kept.c");
});

it("reads a populated .debug_info that follows an empty copy", async () => {
  const named = namedUnit({ name: "second.c" });
  const read = await inspect(
    elfImage({
      sections: [
        { name: ".debug_info", body: Buffer.alloc(0), type: 1 },
        { name: ".debug_info", body: named.info },
        { name: ".debug_abbrev", body: named.abbrev },
      ],
    }),
  );
  expect(read.ok).toBe(true);
  if (!read.ok) throw read.error;
  expect(read.value.units[0]?.name.value).toBe("second.c");
  expect(read.value.coverage.status).toBe("complete");
});

it("keeps units when an optional compressed section cannot be read", async () => {
  const named = namedUnit({ name: "kept.c" });
  const read = await inspect(
    elfDebugImage(
      { info: named.info, abbrev: named.abbrev },
      {
        extra: [
          {
            name: ".debug_line_str",
            body: Buffer.from([1, 0, 0, 0]),
            flags: 0x800n,
          },
        ],
      },
    ),
  );
  expect(read.ok).toBe(true);
  if (!read.ok) throw read.error;
  expect(read.value.units[0]?.name.value).toBe("kept.c");
  expect(read.value.omissions).toContainEqual(
    expect.objectContaining({
      name: ".debug_line_str",
      reason: expect.stringContaining("truncated"),
    }),
  );
});

it("reports a declared .debug_info that was not decoded as partial, never absent", async () => {
  const named = namedUnit({ name: "kept.c" });
  const expectPartial = async (
    bytes: Buffer,
    section: string,
    reason: string,
  ) => {
    const read = await inspect(bytes);
    expect(read.ok, section).toBe(true);
    if (!read.ok) throw read.error;
    expect(read.value.coverage.status, section).toBe("partial");
    expect(read.value.coverage.reason, section).toContain(reason);
    expect(read.value.units, section).toEqual([]);
    const limitations = read.value.limitations.join("\n");
    expect(limitations, section).toContain(reason);
    expect(limitations, section).not.toContain("no .debug_info section");
    expect(limitations, section).not.toContain(".gnu_debuglink");
    expect(read.value.omissions, section).toContainEqual({
      name: section,
      reason: read.value.coverage.reason,
    });
  };
  const compressed = { infoFlags: 0x800n };
  await expectPartial(
    elfDebugImage(
      { info: Buffer.from([1, 0, 0, 0]), abbrev: named.abbrev },
      compressed,
    ),
    ".debug_info",
    "truncated",
  );
  const unknownCompression = Buffer.alloc(24);
  unknownCompression.writeUInt32LE(9, 0);
  await expectPartial(
    elfDebugImage(
      { info: unknownCompression, abbrev: named.abbrev },
      compressed,
    ),
    ".debug_info",
    "compression type 9 is unsupported",
  );
  await expectPartial(
    elfDebugImage(
      { info: Buffer.from("not zlib"), abbrev: named.abbrev },
      { infoName: ".zdebug_info" },
    ),
    ".zdebug_info",
    "not a GNU ZLIB compressed section",
  );
  await expectPartial(
    macho64({
      cpuType: CPU_ARM64,
      sections: [{ name: "__zdebug_info", body: Buffer.from([1, 2, 3, 4]) }],
    }),
    "__zdebug_info",
    "not a GNU ZLIB compressed section",
  );
  await expectPartial(
    peImage([{ name: ".zdebug_info", body: Buffer.from([1, 2, 3, 4]) }]),
    ".zdebug_info",
    "not a GNU ZLIB compressed section",
  );
  const truncated = elfDebugImage(named);
  truncated.writeBigUInt64LE(BigInt(truncated.length + 1), 64 + 64 + 24);
  await expectPartial(truncated, ".debug_info", "outside the file");
  await expectPartial(
    elfImage({ sections: [{ name: ".debug_info.dwo", body: named.info }] }),
    ".debug_info.dwo",
    "Split DWARF section .debug_info.dwo is not read",
  );
  await expectPartial(
    elfImage({
      sections: [{ name: ".zdebug_info.dwo", body: gnuZdebugBody(named.info) }],
    }),
    ".zdebug_info.dwo",
    "Split DWARF section .zdebug_info.dwo is not read",
  );
});

it("keeps a section that stores no bytes as no_debug_info for this file", async () => {
  const read = await inspect(
    elfImage({
      sections: [{ name: ".debug_info", body: Buffer.alloc(0), type: 8 }],
    }),
  );
  expect(read.ok).toBe(true);
  if (!read.ok) throw read.error;
  expect(read.value.coverage).toMatchObject({
    status: "no_debug_info",
    reason: expect.stringContaining("no file-backed .debug_info"),
  });
});

it("keeps an empty PROGBITS .debug_info as no_debug_info", async () => {
  const read = await inspect(
    elfImage({
      sections: [{ name: ".debug_info", body: Buffer.alloc(0), type: 1 }],
    }),
  );
  expect(read.ok).toBe(true);
  if (!read.ok) throw read.error;
  expect(read.value.coverage.status).toBe("no_debug_info");
  expect(read.value.sections).toEqual([]);
  expect(read.value.omissions).toContainEqual({
    name: ".debug_info",
    reason: ".debug_info stores no bytes",
  });
});

it("reads units from an unmapped Mach-O __DWARF segment", async () => {
  const named = namedUnit({ name: "unmapped.c" });
  const bytes = macho64({
    cpuType: CPU_X86_64,
    sections: [
      { name: "__debug_info", body: named.info },
      { name: "__debug_abbrev", body: named.abbrev },
    ],
  });
  // LC_SEGMENT_64 retains its file range but has no VM mapping or protections.
  bytes.writeBigUInt64LE(0n, 32 + 32);
  bytes.writeUInt32LE(0, 32 + 56);
  bytes.writeUInt32LE(0, 32 + 60);
  const read = await inspect(bytes);
  expect(read.ok).toBe(true);
  if (!read.ok) throw read.error;
  expect(read.value.coverage.status).toBe("complete");
  expect(read.value.units[0]?.name.value).toBe("unmapped.c");
});

it("reports unread .debug_info copies as partial and groups repeated omissions", async () => {
  const first = namedUnit({ name: "first.c" });
  const second = namedUnit({ name: "second.c" });
  const repeated = { name: ".debug_info", body: second.info };
  const read = await inspect(
    elfDebugImage(first, { extra: [repeated, repeated, repeated] }),
  );
  expect(read.ok).toBe(true);
  if (!read.ok) throw read.error;
  expect(read.value.units.map((unit) => unit.name.value)).toEqual(["first.c"]);
  expect(read.value.coverage).toEqual({
    status: "partial",
    reason:
      "3 further .debug_info section(s) were not read, so total_units covers the first only.",
  });
  expect(
    read.value.omissions.filter(({ name }) => name === ".debug_info"),
  ).toEqual([
    {
      name: ".debug_info",
      reason:
        "Duplicate section; the first file-backed copy was read (3 sections)",
    },
  ]);
});

it("reads Mach-O compressed line strings under the 16-byte name and only from __DWARF", async () => {
  const lineStr = Buffer.from("line.c\0", "latin1");
  const abbrev = abbrevTable([
    {
      code: 1,
      tag: 0x11,
      children: false,
      attributes: [{ name: 0x03, form: 0x1f }],
    },
  ]);
  const info = compileUnit({
    version: 5,
    unitType: 1,
    attributes: [Buffer.alloc(4)],
  });
  const read = await inspect(
    macho64({
      cpuType: CPU_ARM64,
      sections: [
        { name: "__debug_info", body: info },
        { name: "__debug_abbrev", body: abbrev },
        { name: "__zdebug_line_str", body: gnuZdebugBody(lineStr) },
      ],
    }),
  );
  expect(read.ok).toBe(true);
  if (!read.ok) throw read.error;
  expect(read.value.sections).toContainEqual(
    expect.objectContaining({
      name: "__zdebug_line_st",
      role: ".debug_line_str",
      compression: "zlib",
    }),
  );
  expect(read.value.units[0]?.name.value).toBe("line.c");
  const foreign = await inspect(
    macho64({
      cpuType: CPU_ARM64,
      sections: [{ name: "__debug_info", body: info, segment: "__TEXT" }],
    }),
  );
  expect(foreign.ok).toBe(true);
  if (!foreign.ok) throw foreign.error;
  expect(foreign.value.coverage.status).toBe("no_debug_info");
  expect(foreign.value.limitations.join("\n")).not.toContain(".gnu_debuglink");
});

it("does not read .debug_* spellings across container formats", async () => {
  const named = namedUnit();
  const elf = await inspect(
    elfImage({ sections: [{ name: "__debug_info", body: named.info }] }),
  );
  expect(elf.ok).toBe(true);
  if (!elf.ok) throw elf.error;
  expect(elf.value.coverage.status).toBe("no_debug_info");
  const macho = await inspect(
    macho64({
      cpuType: CPU_ARM64,
      sections: [{ name: ".debug_info", body: named.info }],
    }),
  );
  expect(macho.ok).toBe(true);
  if (!macho.ok) throw macho.error;
  expect(macho.value.coverage.status).toBe("no_debug_info");
});

it("names a .gnu_debuglink section in a PE image", async () => {
  const read = await inspect(
    peImage([{ name: ".gnu_debuglink", body: Buffer.from("other.debug\0") }]),
  );
  expect(read.ok).toBe(true);
  if (!read.ok) throw read.error;
  expect(read.value.coverage.status).toBe("no_debug_info");
  expect(read.value.limitations.join("\n")).toContain(
    "A .gnu_debuglink section is present",
  );
});

it("treats .crel debug sections as unapplied relocations and lists each name once", async () => {
  const repeated = {
    name: ".crel.debug_info",
    body: Buffer.alloc(8),
    type: 0x40000014,
    info: 1,
  };
  const read = await inspect(
    elfDebugImage(namedUnit(), { extra: [repeated, repeated] }),
  );
  expect(read.ok).toBe(true);
  if (!read.ok) throw read.error;
  expect(read.value.limitations.join("\n")).toContain(
    "debug relocations were not applied (.crel.debug_info).",
  );
});

it.each([4, 9, 20, 0x40000014])(
  "identifies renamed ELF relocation sections by type %i and target index",
  async (type) => {
    const abbrev = abbrevTable([
      {
        code: 1,
        tag: 0x11,
        children: false,
        attributes: [
          { name: 0x03, form: 0x0e },
          { name: 0x1b, form: 0x0e },
        ],
      },
    ]);
    const parts = {
      info: compileUnit({ attributes: [Buffer.alloc(4), Buffer.alloc(4)] }),
      abbrev,
      str: Buffer.from("compiler version\0"),
    };
    const read = await inspect(
      elfDebugImage(parts, {
        extra: [{ name: ".renamed", body: Buffer.alloc(24), type, info: 1 }],
      }),
    );
    expect(read.ok).toBe(true);
    if (!read.ok) throw read.error;
    expect(read.value.units[0]?.name).toEqual({
      state: "unresolved",
      value: null,
    });
    expect(read.value.units[0]?.comp_dir).toEqual({
      state: "unresolved",
      value: null,
    });
    expect(read.value.units[0]?.issues.map((issue) => issue.code)).toContain(
      "unapplied_relocation",
    );
    expect(read.value.limitations.join("\n")).toContain(
      "debug relocations were not applied (.renamed)",
    );

    const unrelated = await inspect(
      elfDebugImage(parts, {
        extra: [
          { name: ".rela.debug_info", body: Buffer.alloc(24), type, info: 0 },
        ],
      }),
    );
    expect(unrelated.ok).toBe(true);
    if (!unrelated.ok) throw unrelated.error;
    expect(unrelated.value.units[0]?.name).toEqual({
      state: "present",
      value: "compiler version",
    });
    expect(unrelated.value.limitations.join("\n")).not.toContain(
      "debug relocations were not applied",
    );
  },
);

it("reports unapplied ET_REL debug relocations instead of a string at offset zero", async () => {
  const abbrev = abbrevTable([
    {
      code: 1,
      tag: 0x11,
      children: false,
      attributes: [{ name: 0x03, form: 0x0e }],
    },
  ]);
  const info = compileUnit({ attributes: [Buffer.alloc(4)] });
  const str = Buffer.from("wrong\0right\0", "latin1");
  const relocatable = await inspect(
    elfDebugImage(
      { info, abbrev, str },
      {
        extra: [
          {
            name: ".rela.debug_info",
            body: Buffer.alloc(24),
            type: 4,
            info: 1,
          },
        ],
      },
    ),
  );
  expect(relocatable.ok).toBe(true);
  if (!relocatable.ok) throw relocatable.error;
  expect(relocatable.value.units[0]?.name).toEqual({
    state: "unresolved",
    value: null,
  });
  expect(relocatable.value.limitations.join("\n")).toContain(
    "debug relocations were not applied (.rela.debug_info)",
  );
  const linked = await inspect(
    elfDebugImage(
      { info, abbrev, str },
      {
        type: 2,
        extra: [
          {
            name: ".rela.debug_info",
            body: Buffer.alloc(24),
            type: 4,
            info: 1,
          },
        ],
      },
    ),
  );
  expect(linked.ok).toBe(true);
  if (!linked.ok) throw linked.error;
  expect(linked.value.units[0]?.name).toEqual({
    state: "present",
    value: "wrong",
  });
  expect(linked.value.limitations.join("\n")).not.toContain(
    "debug relocations were not applied",
  );
});

it("does not report DWARF 5 strx strings from unrelocated ET_REL str offsets", async () => {
  const sample = strxBeforeBase();
  const sections = {
    info: sample.info,
    abbrev: sample.abbrev,
    str: sample.str,
    strOffsets: sample.strOffsets,
  };
  const relocation = {
    name: ".rela.debug_str_offsets",
    body: Buffer.alloc(24),
    type: 4,
    info: 4,
  };
  const relocatable = await inspect(
    elfDebugImage(sections, { extra: [relocation] }),
  );
  expect(relocatable.ok).toBe(true);
  if (!relocatable.ok) throw relocatable.error;
  expect(relocatable.value.units[0]?.name).toEqual({
    state: "unresolved",
    value: null,
  });
  expect(
    relocatable.value.units[0]?.issues.map((issue) => issue.detail),
  ).toEqual(["Relocatable ELF debug relocations were not applied"]);
  expect(relocatable.value.limitations.join("\n")).toContain(
    "debug relocations were not applied (.rela.debug_str_offsets)",
  );
  const linked = await inspect(
    elfDebugImage(sections, { type: 2, extra: [relocation] }),
  );
  expect(linked.ok).toBe(true);
  if (!linked.ok) throw linked.error;
  expect(linked.value.units[0]?.name).toEqual({
    state: "present",
    value: "hello.c",
  });
});

it("decompresses GNU zdebug sections in PE and Mach-O", async () => {
  const named = namedUnit({ name: "zdebug.c" });
  const pe = await inspect(
    peImage([
      { name: ".zdebug_info", body: gnuZdebugBody(named.info) },
      { name: ".debug_abbrev", body: named.abbrev },
    ]),
  );
  expect(pe.ok).toBe(true);
  if (!pe.ok) throw pe.error;
  expect(pe.value.sections[0]).toMatchObject({
    name: ".zdebug_info",
    role: ".debug_info",
    compression: "zlib",
  });
  expect(pe.value.units[0]?.name.value).toBe("zdebug.c");
  const macho = await inspect(
    macho64({
      cpuType: CPU_ARM64,
      sections: [
        { name: "__zdebug_info", body: gnuZdebugBody(named.info) },
        { name: "__debug_abbrev", body: named.abbrev },
      ],
    }),
  );
  expect(macho.ok).toBe(true);
  if (!macho.ok) throw macho.error;
  expect(macho.value.coverage.status).not.toBe("no_debug_info");
  expect(macho.value.sections).toContainEqual(
    expect.objectContaining({
      name: "__zdebug_info",
      role: ".debug_info",
      compression: "zlib",
    }),
  );
  expect(macho.value.units[0]?.name.value).toBe("zdebug.c");
});

it("names PE and Mach-O architectures from their shared owners", async () => {
  for (const machine of [0x01c0, 0x01c2, 0x01c4] as const) {
    const arm = await inspect(peImage([], machine, 0x10b));
    expect(arm.ok, machine.toString(16)).toBe(true);
    if (!arm.ok) throw arm.error;
    expect(arm.value.architecture).toBe("arm");
    const disagreed = await inspect(peImage([], machine));
    expect(disagreed.ok).toBe(true);
    if (!disagreed.ok) throw disagreed.error;
    expect(disagreed.value.architecture).toBeNull();
  }
  const wideIa32 = await inspect(peImage([], 0x014c));
  expect(wideIa32.ok).toBe(true);
  if (!wideIa32.ok) throw wideIa32.error;
  expect(wideIa32.value.architecture).toBeNull();
  const ia32 = await inspect(peImage([], 0x014c, 0x10b));
  expect(ia32.ok).toBe(true);
  if (!ia32.ok) throw ia32.error;
  expect(ia32.value.architecture).toBe("x86");
  const i386 = await inspect(macho64({ cpuType: 7 }));
  expect(i386.ok).toBe(true);
  if (!i386.ok) throw i386.error;
  expect(i386.value.architecture).toBe("x86");
  const ppc = await inspect(macho64({ cpuType: 18 }));
  expect(ppc.ok).toBe(true);
  if (!ppc.ok) throw ppc.error;
  expect(ppc.value.architecture).toBe("powerpc");
  const amd64 = await inspect(macho64({ cpuType: 0x01000007 }));
  expect(amd64.ok).toBe(true);
  if (!amd64.ok) throw amd64.error;
  expect(amd64.value.architecture).toBe("x86_64");
});
