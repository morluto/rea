import { describe, expect, it, vi } from "vitest";
import { deflateSync } from "node:zlib";
import { readNativeInitializers } from "./NativeInitializersProvider.js";

/** Pass-through spies on the shared mapping module, so tests can count lookups made from other modules. */
const mapping = vi.hoisted(() => ({
  scans: vi.fn(),
  indexes: vi.fn(),
}));
vi.mock("../metadata/BinaryContainer.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../metadata/BinaryContainer.js")>();
  return {
    ...actual,
    mappedFileOffset: (
      ...args: Parameters<typeof actual.mappedFileOffset>
    ): number => {
      mapping.scans(...args);
      return actual.mappedFileOffset(...args);
    },
    createFileMappingIndex: (
      ...args: Parameters<typeof actual.createFileMappingIndex>
    ) => {
      mapping.indexes(...args);
      return actual.createFileMappingIndex(...args);
    },
  };
});
import {
  elf32RelativeInitializers,
  elf64PieInitializers,
  elf64AliasedInitializers,
  elfRelocatableCtors,
  elfUnmappedInitializerTargets,
  macho32Initializers,
  machoArm64FatInitializers,
  machoArm64Initializers,
  machoArm64LegacyRebaseInitializers,
  machoSparseBindInitializers,
  machoX8664ObjectInitializers,
} from "./NativeInitializers.fixture.js";
import {
  MAX_NATIVE_INITIALIZER_ENTRIES,
  MAX_NATIVE_INITIALIZER_NAME_BYTES,
  MAX_NATIVE_INITIALIZER_NOTES,
  NATIVE_INITIALIZER_LIMITATIONS,
  nativeInitializersSchema,
} from "../../domain/native/nativeInitializers.js";
import { buildAddressRangeIndex } from "./addressRangeIndex.js";
import { InitializerNotes } from "./initializerNotes.js";
import { BinaryFormatFailure } from "../metadata/BinaryContainer.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";

const artifact = (bytes: Buffer) => ({
  path: "/artifacts/image",
  sha256: "a".repeat(64),
  bytes: bytes.length,
});

const read = async (
  bytes: Buffer,
  page: { offset?: number; limit?: number; architecture?: "arm64" } = {},
) =>
  nativeInitializersSchema.parse(
    await readNativeInitializers(bytes, artifact(bytes), {
      path: "/artifacts/image",
      offset: page.offset ?? 0,
      limit: page.limit ?? 64,
      ...(page.architecture === undefined
        ? {}
        : { architecture: page.architecture }),
    }),
  );

it.each([
  { type: 2 as const, metadataAllocated: false },
  { type: 3 as const, metadataAllocated: false },
  { type: 2 as const, metadataAllocated: true },
])(
  "keeps section metadata from inventing linked target file offsets ($type / $metadataAllocated)",
  async (options) => {
    const report = await read(elfUnmappedInitializerTargets(options));
    expect(
      report.entries.map((entry) => [entry.value_va, entry.value_file_offset]),
    ).toEqual([
      ["0x0", null],
      ["0x10", null],
      ["0x401000", 0x100],
    ]);
    expect(report.coverage).toMatchObject({
      status: "complete",
      examined_entries: 3,
      total_entries: 3,
    });
  },
);

it("preserves a real mapping to file offset zero instead of treating zero as missing", async () => {
  const bytes = elfUnmappedInitializerTargets({ type: 3 });
  bytes.writeBigUInt64LE(0n, 64 + 16);
  bytes.writeBigUInt64LE(0n, 64 + 24);
  const report = await read(bytes);
  expect(
    report.entries.slice(0, 2).map((entry) => entry.value_file_offset),
  ).toEqual([0, 0x10]);
});

it("does not use metadata to back a target in a load segment's zero-fill tail", async () => {
  const bytes = elfUnmappedInitializerTargets();
  bytes.writeBigUInt64LE(0x2000n, 176 + 40);
  bytes.writeBigUInt64LE(0x403000n, 0x140);
  bytes.writeBigUInt64LE(0x403000n, 0x400 + 3 * 64 + 16);
  const report = await read(bytes);
  expect(report.entries[0]).toMatchObject({
    value_va: "0x403000",
    value_file_offset: null,
  });
  expect(report.entries[2]).toMatchObject({
    value_va: "0x401000",
    value_file_offset: 0x100,
  });
});

/** One ELF64 section header for {@link withExtraSections}. */
const sectionHeader = (
  type: number,
  offset: number,
  size: number,
  link: number,
  entsize: number,
  info = 0,
): Buffer => {
  const header = Buffer.alloc(64);
  header.writeUInt32LE(type, 4);
  header.writeBigUInt64LE(BigInt(offset), 24);
  header.writeBigUInt64LE(BigInt(size), 32);
  header.writeUInt32LE(link, 40);
  header.writeUInt32LE(info, 44);
  header.writeBigUInt64LE(BigInt(entsize), 56);
  return header;
};

/**
 * The relocatable fixture with `payload` appended and a moved section-header
 * table that keeps its nine headers and adds `extra`. Extra offsets are
 * relative to the payload.
 */
const withExtraSections = (
  payload: Buffer,
  extra: (payloadAt: number) => readonly Buffer[],
): Buffer => {
  const base = elfRelocatableCtors();
  const headers = extra(base.length);
  const table = Buffer.concat([
    base.subarray(0x500, 0x500 + 9 * 64),
    ...headers,
  ]);
  const bytes = Buffer.concat([base, payload, table]);
  bytes.writeBigUInt64LE(BigInt(base.length + payload.length), 40);
  bytes.writeUInt16LE(9 + headers.length, 60);
  return bytes;
};

const row = (report: Awaited<ReturnType<typeof read>>) =>
  report.entries.map((entry) => ({
    kind: entry.kind,
    value: entry.value_va,
    section: entry.section?.name ?? null,
    symbol: entry.symbol?.name ?? null,
    resolution: entry.resolution,
  }));

describe("ELF", () => {
  it("does not treat repeated DT_NEEDED entries as duplicate tags", async () => {
    const report = await read(elf64PieInitializers(3));
    expect(report.status).toBe("parsed");
    expect(report.coverage.status).toBe("complete");
    expect(row(report)).toEqual(row(await read(elf64PieInitializers())));
    expect(
      report.limitations.some((line) =>
        line.startsWith("Duplicate dynamic tag"),
      ),
    ).toBe(false);
  });

  it("lists PIE slots in declaration order through RELA, RELR and imports", async () => {
    const report = await read(elf64PieInitializers());
    expect(report).toMatchObject({
      format: "elf",
      status: "parsed",
      architecture: "x86_64",
      bits: 64,
      elf_type: 3,
      coverage: { status: "complete", examined_entries: 7, total_entries: 7 },
    });
    expect(row(report)).toEqual([
      {
        kind: "preinit_array",
        value: "0x100",
        section: ".text",
        symbol: "ctor_a",
        resolution: "raw",
      },
      {
        kind: "init",
        value: "0x100",
        section: ".text",
        symbol: "ctor_a",
        resolution: "raw",
      },
      {
        kind: "init_array",
        value: "0x100",
        section: ".text",
        symbol: "ctor_a",
        resolution: "relative_addend",
      },
      {
        kind: "init_array",
        value: "0x110",
        section: ".text",
        symbol: "ctor_b",
        resolution: "relative_addend",
      },
      {
        kind: "init_array",
        value: null,
        section: null,
        symbol: "imp_init",
        resolution: "unresolved_import",
      },
      {
        kind: "fini",
        value: "0x120",
        section: ".text",
        symbol: "fini_fn",
        resolution: "raw",
      },
      {
        kind: "fini_array",
        value: "0x120",
        section: ".text",
        symbol: "fini_fn",
        resolution: "relr",
      },
    ]);
    expect(report.entries[2]).toMatchObject({
      slot_va: "0x200",
      slot_file_offset: 0x200,
      slot_bytes: 8,
      value_file_offset: 0x100,
      slot_section: { name: ".init_array", trust: "observed-untrusted" },
      detail: "DT_INIT_ARRAY",
    });
    expect(
      report.limitations.slice(0, NATIVE_INITIALIZER_LIMITATIONS.length),
    ).toEqual([...NATIVE_INITIALIZER_LIMITATIONS]);
  });

  it("pages entries without changing their indexes", async () => {
    const report = await read(elf64PieInitializers(), { offset: 2, limit: 2 });
    expect(report.coverage).toMatchObject({
      status: "complete",
      examined_entries: 7,
      returned_entries: 2,
      offset: 2,
      limit: 2,
    });
    expect(report.entries.map((entry) => entry.index)).toEqual([2, 3]);
  });

  it("resolves an ELF32 REL RELATIVE slot from its in-place addend", async () => {
    const report = await read(elf32RelativeInitializers());
    expect(report).toMatchObject({ bits: 32, architecture: "x86" });
    expect(row(report)).toEqual([
      {
        kind: "init_array",
        value: "0x80",
        section: ".text",
        symbol: "ctor",
        resolution: "relative_addend",
      },
    ]);
    expect(report.entries[0]?.slot_bytes).toBe(4);
  });

  it("reads relocatable-object sections by section-relative offset and skips sentinels", async () => {
    const report = await read(elfRelocatableCtors());
    expect(report.elf_type).toBe(1);
    expect(row(report)).toEqual([
      {
        kind: "init_array",
        value: "0x8",
        section: ".text",
        symbol: "init_b",
        resolution: "symbol_addend",
      },
      {
        kind: "ctors",
        value: "0x0",
        section: ".text",
        symbol: "ctor",
        resolution: "symbol_addend",
      },
    ]);
    expect(report.entries[1]).toMatchObject({
      slot_va: "0x8",
      slot_file_offset: 0x208,
    });
    expect(report.limitations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Relocatable object (ET_REL)"),
        "Omitted 2 .ctors or .dtors sentinel values (0 or -1).",
      ]),
    );
    expect(report.status).toBe("parsed");
    // Three .ctors slots, including both sentinels, and one .init_array slot.
    expect(report.coverage).toMatchObject({
      examined_entries: 4,
      total_entries: 2,
    });
  });
});

describe("ELF slot semantics", () => {
  it("keeps a 32-bit all-ones word in a 64-bit .ctors as a listed value", async () => {
    const bytes = elfRelocatableCtors();
    // The leading .ctors sentinel becomes 0x00000000ffffffff, which is not -1 in ELF64.
    bytes.writeBigUInt64LE(0xffffffffn, 0x200);
    const report = await read(bytes);
    expect(row(report).filter((entry) => entry.kind === "ctors")).toEqual([
      {
        kind: "ctors",
        value: "0xffffffff",
        section: null,
        symbol: null,
        resolution: "raw",
      },
      {
        kind: "ctors",
        value: "0x0",
        section: ".text",
        symbol: "ctor",
        resolution: "symbol_addend",
      },
    ]);
    expect(report.limitations).toContain(
      "Omitted 1 .ctors or .dtors sentinel values (0 or -1).",
    );
  });

  it("reports no slot address for DT_INIT and DT_FINI fields outside every load segment", async () => {
    const bytes = elf64PieInitializers();
    // Shrink the only PT_LOAD so PT_DYNAMIC (file offset 0x300) is no longer mapped.
    bytes.writeBigUInt64LE(0x300n, 64 + 32);
    bytes.writeBigUInt64LE(0x300n, 64 + 40);
    const report = await read(bytes);
    const direct = report.entries.filter(
      (entry) => entry.kind === "init" || entry.kind === "fini",
    );
    expect(direct).toHaveLength(2);
    for (const entry of direct)
      expect(entry).toMatchObject({ slot_va: null, slot_section: null });
    expect(direct.map((entry) => entry.value_va)).toEqual(["0x100", "0x120"]);
    expect(report.limitations).toEqual(
      expect.arrayContaining([
        "DT_INIT value field is not inside a load segment.",
        "DT_FINI value field is not inside a load segment.",
      ]),
    );
  });

  const sectionlessElf = (directOnly: boolean): Buffer => {
    const bytes = Buffer.from(elf64PieInitializers());
    bytes.writeBigUInt64LE(0n, 40);
    bytes.writeUInt16LE(0, 60);
    bytes.writeUInt16LE(0, 62);
    if (!directOnly) return bytes;
    (
      [
        [12, 0x100],
        [13, 0x120],
        [6, 0x520],
        [0, 0],
      ] as const
    ).forEach(([tag, value], index) => {
      const at = 0x300 + index * 16;
      bytes.writeBigUInt64LE(BigInt(tag), at);
      bytes.writeBigUInt64LE(BigInt(value), at + 8);
    });
    bytes.writeBigUInt64LE(64n, 120 + 32);
    bytes.writeBigUInt64LE(64n, 120 + 40);
    return bytes;
  };

  it("keeps direct initializers complete when DT_SYMTAB has no decoded table", async () => {
    const report = await read(sectionlessElf(true));
    expect(report.entries.map((entry) => entry.kind)).toEqual(["init", "fini"]);
    expect(report.coverage).toMatchObject({
      status: "complete",
      total_entries: 2,
    });
    expect(report.limitations.join("\n")).not.toContain("DT_SYMTAB");
  });

  it("marks coverage incomplete when a relocation needs the missing DT_SYMTAB", async () => {
    const report = await read(sectionlessElf(false));
    expect(report.coverage).toMatchObject({
      status: "incomplete",
      total_entries: null,
    });
    expect(report.limitations).toContain(
      "DT_SYMTAB does not identify a decoded symbol table; dynamic relocation symbols are unresolved.",
    );
  });
});

describe("ELF section content admission", () => {
  it("keeps symbol relocations unresolved for a conflicting symbol entry width", async () => {
    const bytes = elfRelocatableCtors();
    bytes.writeBigUInt64LE(16n, 0x500 + 4 * 64 + 56);
    const report = await read(bytes);
    expect(
      report.entries.find((entry) => entry.kind === "init_array"),
    ).toMatchObject({
      resolution: "unresolved",
      value_va: null,
      symbol: null,
    });
    expect(report.status).toBe("incomplete");
    expect(report.limitations.join("\n")).toContain("entry size");
  });

  it.each([
    { section: 7, label: "initializer array" },
    { section: 4, label: "symbol table" },
    { section: 5, label: "symbol string table" },
    { section: 8, label: "relocation table" },
  ])("preserves uncertainty for a compressed $label", async ({ section }) => {
    const base = elfRelocatableCtors();
    const at = 0x500 + section * 64;
    const offset = Number(base.readBigUInt64LE(at + 24));
    const size = Number(base.readBigUInt64LE(at + 32));
    const header = Buffer.alloc(24);
    header.writeUInt32LE(1, 0);
    header.writeBigUInt64LE(BigInt(size), 8);
    header.writeBigUInt64LE(1n, 16);
    const compressed = Buffer.concat([
      header,
      deflateSync(base.subarray(offset, offset + size)),
    ]);
    const bytes = Buffer.concat([base, compressed]);
    bytes.writeBigUInt64LE(base.readBigUInt64LE(at + 8) | 0x800n, at + 8);
    bytes.writeBigUInt64LE(BigInt(base.length), at + 24);
    bytes.writeBigUInt64LE(BigInt(compressed.length), at + 32);
    const report = await read(bytes);
    expect(report.status).toBe("incomplete");
    expect(report.coverage.total_entries).toBeNull();
    expect(report.limitations.join("\n")).toContain("compressed");
    if (section === 7)
      expect(report.entries.some((entry) => entry.kind === "init_array")).toBe(
        false,
      );
    else {
      const init = report.entries.find((entry) => entry.kind === "init_array");
      expect(init).toBeDefined();
      if (section === 5) expect(init?.symbol).toBeNull();
      else
        expect(init).toMatchObject({
          resolution: "unresolved",
          value_va: null,
        });
    }
    // The uncompressed fixture remains the working comparison.
    expect((await read(base)).status).toBe("parsed");
  });

  it("does not substitute an unrelated dynamic symbol table for DT_SYMTAB", async () => {
    const bytes = elf64PieInitializers();
    bytes.writeBigUInt64LE(0x777n, 0x300 + 14 * 16 + 8);
    const report = await read(bytes);
    expect(
      report.entries.find((entry) => entry.slot_va === "0x210"),
    ).toMatchObject({
      resolution: "unresolved",
      symbol: null,
      value_va: null,
    });
    expect(report.status).toBe("incomplete");
  });

  it.each(["compressed", "not a string table"])(
    "retains later symbol tables when an earlier name source is %s",
    async (source) => {
      const bytes = elf64PieInitializers();
      // The first (dynamic) symbol table links section 8; its bytes still contain imp_init.
      if (source === "compressed")
        bytes.writeBigUInt64LE(0x802n, 0x800 + 8 * 64 + 8);
      else bytes.writeUInt32LE(1, 0x800 + 8 * 64 + 4);
      const report = await read(bytes);
      expect(report.status).toBe("incomplete");
      expect(
        report.entries.find((entry) => entry.kind === "init"),
      ).toMatchObject({
        symbol: { name: "ctor_a" },
        value_va: "0x100",
      });
      expect(
        report.entries.find((entry) => entry.slot_va === "0x210"),
      ).toMatchObject({
        resolution: "unresolved_import",
        symbol: null,
      });
    },
  );
});

describe("ELF incomplete inputs", () => {
  it("reports an unsupported relocation machine as incomplete, not as raw zeros", async () => {
    const bytes = elf64PieInitializers();
    bytes.writeUInt16LE(243, 18);
    const report = await read(bytes);
    expect(report.status).toBe("incomplete");
    expect(report.coverage.total_entries).toBeNull();
    const slots = report.entries.filter((entry) => entry.kind === "init_array");
    expect(slots.map((entry) => entry.resolution)).toEqual([
      "unresolved",
      "unresolved",
      "unresolved_import",
    ]);
    expect(slots.every((entry) => entry.value_va === null)).toBe(true);
    expect(
      report.entries.find((entry) => entry.kind === "init")?.resolution,
    ).toBe("raw");
  });

  it("bounds a huge declared DT_INIT_ARRAYSZ by the slot budget", async () => {
    const bytes = elf64PieInitializers();
    // DT_INIT_ARRAYSZ is the fourth dynamic entry; 2^50 slots is still a safe integer.
    bytes.writeBigUInt64LE(8n << 50n, 0x300 + 3 * 16 + 8);
    const started = performance.now();
    const report = await read(bytes);
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(report.status).toBe("incomplete");
    expect(report.coverage).toMatchObject({
      status: "incomplete",
      total_entries: null,
    });
    expect(report.coverage.examined_entries).toBeLessThanOrEqual(
      MAX_NATIVE_INITIALIZER_ENTRIES,
    );
    expect(report.limitations).toContain(
      `DT_INIT_ARRAY declares ${String(1n << 50n)} slots. Scanning stopped at the 65536-slot budget, so later slots were not read.`,
    );
  });

  it("stops a file-backed section-derived init_array at the slot budget", async () => {
    const base = elfRelocatableCtors();
    const slots = MAX_NATIVE_INITIALIZER_ENTRIES + 4096;
    const bytes = Buffer.concat([base, Buffer.alloc(slots * 8)]);
    // .init_array is section 7 of the relocatable fixture: sh_offset at +24, sh_size at +32.
    bytes.writeBigUInt64LE(BigInt(base.length), 0x500 + 7 * 64 + 24);
    bytes.writeBigUInt64LE(BigInt(slots * 8), 0x500 + 7 * 64 + 32);
    const report = await read(bytes);
    expect(report.status).toBe("incomplete");
    expect(report.coverage).toMatchObject({
      status: "incomplete",
      examined_entries: MAX_NATIVE_INITIALIZER_ENTRIES,
      total_entries: null,
    });
    expect(report.limitations).toContain(
      `.init_array declares ${String(slots)} slots. Scanning stopped at the 65536-slot budget, so later slots were not read.`,
    );
  });

  it("reports over-long section and symbol names as null instead of failing the schema", async () => {
    const base = elf64PieInitializers();
    const longSection = `.init_array.${"s".repeat(1100)}`;
    const longSymbol = `ctor_${"y".repeat(1100)}`;
    const tail = Buffer.from(`${longSection}\0${longSymbol}\0`, "utf8");
    const bytes = Buffer.concat([base, tail]);
    const sectionAt = base.length;
    const symbolAt = base.length + longSection.length + 1;
    // .shstrtab (section 11) at 0x680 and .strtab (section 10) at 0x600 grow to cover the tail.
    bytes.writeBigUInt64LE(BigInt(bytes.length - 0x680), 0x800 + 11 * 64 + 32);
    bytes.writeBigUInt64LE(BigInt(bytes.length - 0x600), 0x800 + 10 * 64 + 32);
    // Rename .init_array (section 3) and ctor_a (first .symtab entry after the null symbol).
    bytes.writeUInt32LE(sectionAt - 0x680, 0x800 + 3 * 64);
    bytes.writeUInt32LE(symbolAt - 0x600, 0x598);
    const report = await read(bytes);
    const slot = report.entries.find((entry) => entry.kind === "init_array");
    expect(slot?.slot_section).toBeNull();
    expect(
      report.entries.every(
        (entry) =>
          (entry.symbol?.name.length ?? 0) <= MAX_NATIVE_INITIALIZER_NAME_BYTES,
      ),
    ).toBe(true);
    expect(
      report.limitations.some((line) =>
        line.includes("exceeded the 1024-byte name budget"),
      ),
    ).toBe(true);
  });

  it("labels an over-long section-derived array with the request name", async () => {
    const base = elfRelocatableCtors();
    const longSection = `.init_array.${"s".repeat(1100)}`;
    const bytes = Buffer.concat([base, Buffer.from(`${longSection}\0`)]);
    // .shstrtab (section 6) at 0x400 grows to cover the tail; rename .init_array (section 7).
    bytes.writeBigUInt64LE(BigInt(bytes.length - 0x400), 0x500 + 6 * 64 + 32);
    bytes.writeUInt32LE(base.length - 0x400, 0x500 + 7 * 64);
    const report = await read(bytes);
    const slot = report.entries.find((entry) => entry.kind === "init_array");
    expect(slot).toMatchObject({ slot_section: null, detail: ".init_array" });
    expect(report.status).toBe("incomplete");
    const beyond = await read(bytes, { offset: 100 });
    expect(beyond.entries).toHaveLength(0);
    expect(beyond.status).toBe("incomplete");
    expect(beyond.coverage.status).toBe("incomplete");
    expect(
      beyond.limitations.some((line) =>
        line.includes("exceeded the 1024-byte name budget"),
      ),
    ).toBe(true);
    expect(
      report.limitations.some((line) =>
        line.includes("exceeded the 1024-byte name budget"),
      ),
    ).toBe(true);
  });
});

describe("ELF table budgets", () => {
  it("caps symbols in total across every symbol table, not per table", async () => {
    const perTable = 40_000;
    // Two zeroed SHT_SYMTAB tables, each under the cap, that exceed it together.
    const bytes = withExtraSections(Buffer.alloc(perTable * 24), (at) => [
      sectionHeader(2, at, perTable * 24, 5, 24),
      sectionHeader(2, at, perTable * 24, 5, 24),
    ]);
    const report = await read(bytes);
    expect(report.status).toBe("incomplete");
    expect(report.coverage.total_entries).toBeNull();
    expect(report.limitations).toContain(
      "Symbol table scanning stopped at 65536 symbols across all symbol tables. Later names may be missing.",
    );
  });

  it("reports an unreadable symbol table as incomplete rather than absent", async () => {
    // An SHT_SYMTAB whose size is not a whole number of 24-byte entries.
    const bytes = withExtraSections(Buffer.alloc(32), (at) => [
      sectionHeader(2, at, 25, 5, 24),
    ]);
    const report = await read(bytes);
    expect(report.status).toBe("incomplete");
    expect(report.limitations).toContain(
      "A symbol table is not stored in the file or its size is not a whole number of entries, so its names were not read.",
    );
  });

  const repeatedRelocations = (): Buffer => {
    const records = 65_536;
    // Seventeen SHT_RELA headers over one zeroed range targeting .text, where no slot lives.
    return withExtraSections(Buffer.alloc(records * 24), (at) =>
      Array.from({ length: 17 }, () =>
        sectionHeader(4, at, records * 24, 4, 24, 1),
      ),
    );
  };

  it("bounds section relocation records in total across repeated headers", async () => {
    const report = await read(repeatedRelocations());
    expect(report.status).toBe("incomplete");
    expect(report.coverage.total_entries).toBeNull();
    expect(
      report.limitations.filter((line) =>
        line.startsWith(
          "Section relocation scanning stopped at 1048576 records",
        ),
      ),
    ).toHaveLength(1);
    // Records past the budget were not applied, but earlier slot results stand.
    expect(row(report)).toEqual(row(await read(elfRelocatableCtors())));
  });

  it("reports a relocation section reached after the record budget is spent", async () => {
    // Sixteen full headers spend the budget exactly; the seventeenth is not read.
    const records = 65_536;
    const bytes = withExtraSections(Buffer.alloc(records * 24), (at) => [
      ...Array.from({ length: 16 }, () =>
        sectionHeader(4, at, records * 24, 4, 24, 1),
      ),
      sectionHeader(4, at, 24, 4, 24, 1),
    ]);
    const report = await read(bytes);
    expect(report.status).toBe("incomplete");
    expect(
      report.limitations.filter((line) =>
        line.startsWith(
          "Section relocation scanning stopped at 1048576 records",
        ),
      ),
    ).toHaveLength(1);
  });

  it("observes cancellation during the section relocation walk", async () => {
    const bytes = repeatedRelocations();
    const controller = new AbortController();
    setImmediate(() => controller.abort(new Error("cancelled by test")));
    await expect(
      readNativeInitializers(
        bytes,
        artifact(bytes),
        { path: "/artifacts/image", offset: 0, limit: 64 },
        controller.signal,
      ),
    ).rejects.toThrow(ArtifactReaderFailure);
  });
});

describe("Mach-O", () => {
  it("decodes chained pointers, init offsets and raw terminators", async () => {
    const report = await read(machoArm64Initializers());
    expect(report).toMatchObject({
      format: "mach-o",
      status: "parsed",
      architecture: "arm64",
      slice: null,
      elf_type: null,
    });
    expect(row(report)).toEqual([
      {
        kind: "mod_init",
        value: "0x100001000",
        section: "__TEXT,__text",
        symbol: "_init",
        resolution: "chained_fixup",
      },
      {
        kind: "init_offsets",
        value: "0x100001000",
        section: "__TEXT,__text",
        symbol: "_init",
        resolution: "offset_table",
      },
      {
        kind: "mod_term",
        value: "0x100001100",
        section: "__TEXT,__text",
        symbol: "_term",
        resolution: "raw",
      },
    ]);
    expect(report.entries[1]).toMatchObject({
      slot_bytes: 4,
      slot_file_offset: 0x4010,
    });
  });

  it("marks the report incomplete when a chained-fixup slot cannot be decoded", async () => {
    const bytes = machoArm64Initializers();
    // A DYLD_CHAINED_PTR_64_OFFSET bind with ordinal 5, but the image has no imports.
    bytes.writeBigUInt64LE((1n << 63n) | 5n, 0x4000);
    const report = await read(bytes);
    expect(report.entries[0]).toMatchObject({
      kind: "mod_init",
      resolution: "unresolved",
      value_va: null,
    });
    expect(report.status).toBe("incomplete");
    expect(report.coverage).toMatchObject({
      status: "incomplete",
      total_entries: null,
    });
    expect(report.limitations).toEqual(
      expect.arrayContaining([
        "Mach-O chained fixup coverage is incomplete.",
        "1 pointer slot(s) could not be decoded through Mach-O fixups and are listed as unresolved.",
      ]),
    );
  });

  it("reports container file offsets for a selected universal slice", async () => {
    const report = await read(machoArm64FatInitializers(), {
      architecture: "arm64",
    });
    expect(report.slice).toMatchObject({
      file_offset: 0x1000,
      architecture: "arm64",
    });
    expect(report.entries[0]).toMatchObject({
      slot_file_offset: 0x5000,
      value_file_offset: 0x2000,
    });
  });

  it("rejects bytes that are neither ELF nor Mach-O", async () => {
    await expect(read(Buffer.alloc(128))).rejects.toThrow(BinaryFormatFailure);
  });
});

describe("ELF repeated observations", () => {
  it("tallies every over-long symbol name into one counted limitation", async () => {
    const rows = 200;
    const strings = Buffer.from(`\0${"x".repeat(1100)}\0`, "utf8");
    const symbolsAt = 1104;
    const symbols = Buffer.alloc(rows * 24);
    for (let row = 0; row < rows; row += 1) {
      symbols.writeUInt32LE(1, row * 24);
      symbols.writeUInt8(0x12, row * 24 + 4);
      symbols.writeUInt16LE(1, row * 24 + 6);
    }
    const payload = Buffer.concat([
      strings,
      Buffer.alloc(symbolsAt - strings.length),
      symbols,
    ]);
    // Section 9 is the string table, section 10 a symbol table whose every row names it.
    const bytes = withExtraSections(payload, (at) => [
      sectionHeader(3, at, strings.length, 0, 0),
      sectionHeader(2, at + symbolsAt, rows * 24, 9, 24),
    ]);
    const report = await read(bytes);
    expect(report.status).toBe("incomplete");
    expect(
      report.limitations.filter((line) =>
        line.includes("exceeded the 1024-byte name budget"),
      ),
    ).toEqual([
      `${String(rows)} symbol name(s) exceeded the 1024-byte name budget and were not used.`,
    ]);
    expect(report.limitations.length).toBeLessThanOrEqual(40);
  });

  it("tallies relocation sections with an unexpected entry size", async () => {
    const sections = 40;
    const bytes = withExtraSections(Buffer.alloc(48), (at) =>
      Array.from({ length: sections }, () =>
        sectionHeader(4, at, 48, 4, 16, 7),
      ),
    );
    const report = await read(bytes);
    expect(report.status).toBe("incomplete");
    expect(
      report.limitations.filter((line) => line.includes("entry size")),
    ).toEqual([
      `${String(sections)} relocation section(s) had an unexpected entry size and were not applied.`,
    ]);
    expect(report.limitations.length).toBeLessThanOrEqual(40);
  });

  it("keeps distinct notes to the budget and counts the rest", async () => {
    const notes = new InitializerNotes();
    for (let index = 0; index < 100; index += 1) {
      notes.add(`note ${String(index)}`);
      notes.add(`note ${String(index)}`);
      notes.tally("long-symbol-name");
      notes.tally("relocation-entry-size");
    }
    const lines = notes.list();
    expect(lines.slice(0, MAX_NATIVE_INITIALIZER_NOTES)).toEqual(
      Array.from(
        { length: MAX_NATIVE_INITIALIZER_NOTES },
        (_, index) => `note ${String(index)}`,
      ),
    );
    expect(lines.slice(MAX_NATIVE_INITIALIZER_NOTES)).toEqual([
      "100 symbol name(s) exceeded the 1024-byte name budget and were not used.",
      "100 relocation section(s) had an unexpected entry size and were not applied.",
      // Repeats of an unlisted message cannot be told apart once the budget is full.
      `${String(2 * (100 - MAX_NATIVE_INITIALIZER_NOTES))} further observation(s), repeats included, were not listed after the 24-note budget.`,
    ]);
    // Standing limitations, the full note list and the withheld-name line fit the schema.
    expect(
      NATIVE_INITIALIZER_LIMITATIONS.length + lines.length + 1,
    ).toBeLessThanOrEqual(40);
    expect(notes.recorded).toBe(400);
  });
});

describe("ELF section lookups", () => {
  it("names the smallest covering range and breaks ties by header order", async () => {
    const index = buildAddressRangeIndex(
      [
        {
          start: 0n,
          end: 0x100n,
          value: { name: "outer", size: 0x100, order: 0 },
        },
        {
          start: 0x10n,
          end: 0x20n,
          value: { name: "inner", size: 0x10, order: 1 },
        },
        {
          start: 0x10n,
          end: 0x20n,
          value: { name: "twin", size: 0x10, order: 2 },
        },
        {
          start: 0x200n,
          end: 0x200n,
          value: { name: "empty", size: 0, order: 3 },
        },
      ],
      (left, right) => left.size - right.size || left.order - right.order,
    );
    const name = (address: bigint) => index.at(address)?.value.name ?? null;
    expect(
      [0n, 0xfn, 0x10n, 0x1fn, 0x20n, 0xffn, 0x100n, 0x200n].map(name),
    ).toEqual([
      "outer",
      "outer",
      "inner",
      "inner",
      "outer",
      "outer",
      null,
      null,
    ]);
  });

  it(
    "resolves a full slot budget against a near-maximal section table in one pass",
    { tags: ["long-running"] },
    async () => {
      const base = elf64PieInitializers();
      const slots = MAX_NATIVE_INITIALIZER_ENTRIES;
      const payload = Buffer.alloc(slots * 8);
      for (let slot = 0; slot < slots; slot += 1)
        payload.writeBigUInt64LE(0x100n, slot * 8);
      // Allocated, unnamed sections that cover every slot and target address.
      const extra = Buffer.alloc((0xffff - 12) * 64);
      for (let at = 0; at < extra.length; at += 64) {
        extra.writeUInt32LE(1, at + 4);
        extra.writeBigUInt64LE(2n, at + 8);
        extra.writeBigUInt64LE(0x100000n, at + 32);
      }
      const bytes = Buffer.concat([
        base,
        payload,
        base.subarray(0x800, 0x800 + 12 * 64),
        extra,
      ]);
      bytes.writeBigUInt64LE(BigInt(base.length + payload.length), 40);
      bytes.writeUInt16LE(0xffff, 60);
      // The single PT_LOAD maps the whole file; DT_INIT_ARRAY moves to the payload.
      bytes.writeBigUInt64LE(BigInt(bytes.length), 64 + 32);
      bytes.writeBigUInt64LE(BigInt(bytes.length), 64 + 40);
      bytes.writeBigUInt64LE(BigInt(base.length), 0x300 + 2 * 16 + 8);
      bytes.writeBigUInt64LE(BigInt(slots * 8), 0x300 + 3 * 16 + 8);
      const started = performance.now();
      const report = await read(bytes);
      // A per-lookup header walk is about 4e9 comparisons here; the index is a few hundred ms.
      expect(performance.now() - started).toBeLessThan(10_000);
      expect(report.coverage.examined_entries).toBe(slots);
      const slot = report.entries.find((entry) => entry.kind === "init_array");
      expect(slot).toMatchObject({
        value_va: "0x100",
        slot_section: null,
        section: { name: ".text" },
        symbol: { name: "ctor_a" },
      });
    },
  );
});

describe("Mach-O symbol tables", () => {
  const SYMTAB_COMMAND = 24;
  /** The arm64 fixture with `extra` LC_SYMTAB commands after its own and `payload` appended. */
  const withSymtabs = (
    payload: Buffer,
    extra: (payloadAt: number, original: Buffer) => readonly Buffer[],
  ): Buffer => {
    const base = machoArm64Initializers();
    const original = Buffer.from(base.subarray(512, 512 + SYMTAB_COMMAND));
    const commands = extra(base.length, original);
    const bytes = Buffer.concat([base, payload]);
    Buffer.concat(commands).copy(bytes, 512 + SYMTAB_COMMAND);
    bytes.writeUInt32LE(4 + commands.length, 16);
    bytes.writeUInt32LE(504 + commands.length * SYMTAB_COMMAND, 20);
    return bytes;
  };
  const symtab = (original: Buffer, symoff: number, nsyms: number): Buffer => {
    const command = Buffer.from(original);
    command.writeUInt32LE(symoff, 8);
    command.writeUInt32LE(nsyms, 12);
    return command;
  };

  it("caps symbols in total across every LC_SYMTAB, not per command", async () => {
    const perTable = 40_000;
    const bytes = withSymtabs(
      Buffer.alloc((perTable + 1) * 16),
      (at, original) => [
        symtab(original, at, perTable),
        symtab(original, at + 16, perTable),
      ],
    );
    const report = await read(bytes);
    expect(report.status).toBe("incomplete");
    expect(report.coverage.total_entries).toBeNull();
    expect(report.limitations).toContain(
      "Symbol scanning stopped at 65536 symbols across all LC_SYMTAB commands. Later names may be missing.",
    );
    expect(report.entries[0]?.symbol?.name).toBe("_init");
  });

  it("ignores a repeated LC_SYMTAB over the same ranges", async () => {
    const bytes = withSymtabs(Buffer.alloc(0), (_, original) => [original]);
    const report = await read(bytes);
    expect(report.status).toBe("parsed");
    expect(row(report)).toEqual(row(await read(machoArm64Initializers())));
    expect(report.limitations).toContain(
      "A repeated LC_SYMTAB names the same symbol and string ranges and was ignored.",
    );
  });
});

describe("ELF relocation coverage", () => {
  it("ignores no-op relocation records overlapping an initializer", async () => {
    const base = elfRelocatableCtors();
    const records = Buffer.alloc(48);
    base.copy(records, 0, 0x300, 0x318);
    base.copy(records, 24, 0x300, 0x318);
    records.writeBigUInt64LE(0n, 32);
    const bytes = Buffer.concat([base, records]);
    bytes.writeBigUInt64LE(BigInt(base.length), 0x500 + 3 * 64 + 24);
    bytes.writeBigUInt64LE(48n, 0x500 + 3 * 64 + 32);
    expect(row(await read(bytes))).toEqual(row(await read(base)));
  });

  it("keeps slots unresolved when a section relocation table that reaches them is skipped", async () => {
    const bytes = elfRelocatableCtors();
    // .rela.ctors (section 3) and .rela.init_array (section 8) get a 16-byte entry size.
    bytes.writeBigUInt64LE(16n, 0x500 + 3 * 64 + 56);
    bytes.writeBigUInt64LE(16n, 0x500 + 8 * 64 + 56);
    const report = await read(bytes);
    expect(report.status).toBe("incomplete");
    // No stored zero becomes a raw value, and no .ctors slot is dropped as a sentinel.
    expect(
      report.entries.map((entry) => [entry.kind, entry.resolution]),
    ).toEqual([
      ["init_array", "unresolved"],
      ["ctors", "unresolved"],
      ["ctors", "unresolved"],
      ["ctors", "unresolved"],
    ]);
    expect(report.entries.every((entry) => entry.value_va === null)).toBe(true);
  });

  it.each([0, 999])(
    "keeps raw object slots unresolved when skipped relocation target %s is unknown",
    async (target) => {
      const bytes = elfRelocatableCtors();
      // This invalid target makes it unknown whether the skipped table affects .ctors.
      bytes.writeUInt32LE(target, 0x500 + 3 * 64 + 44);
      bytes.writeBigUInt64LE(16n, 0x500 + 3 * 64 + 56);
      const report = await read(bytes);
      expect(report.status).toBe("incomplete");
      const ctors = report.entries.filter((entry) => entry.kind === "ctors");
      expect(ctors).toHaveLength(3);
      expect(
        ctors.every(
          (entry) =>
            entry.resolution === "unresolved" && entry.value_va === null,
        ),
      ).toBe(true);
    },
  );

  it("does not treat a dynamic write that overlaps half a slot as leaving it untouched", async () => {
    const bytes = elf64PieInitializers();
    // The leading null RELA record becomes R_X86_64_32 at 0x204, the upper half of slot 0x200.
    bytes.writeBigUInt64LE(0x204n, 0x480);
    bytes.writeBigUInt64LE(10n, 0x488);
    const report = await read(bytes);
    const slots = report.entries.filter((entry) => entry.kind === "init_array");
    expect(slots.map((entry) => [entry.slot_va, entry.resolution])).toEqual([
      ["0x200", "unresolved"],
      ["0x208", "relative_addend"],
      ["0x210", "unresolved_import"],
    ]);
    expect(report.status).toBe("incomplete");
    expect(report.limitations).toContain(
      "1 initializer slot(s) are partly overwritten or written more than once by dynamic relocations and are listed as unresolved.",
    );
  });

  it("does not reapply a linked image's retained link-time REL record", async () => {
    const base = elf32RelativeInitializers();
    const bytes = Buffer.from(base);
    bytes.writeUInt16LE(2, 16);
    // Move the loader RELATIVE record off the slot so only the retained record reaches it.
    bytes.writeUInt32LE(0x104, 0x180);
    // A non-SHF_ALLOC SHT_REL with R_386_32 against `ctor` at slot 0x100, which already holds 0x80.
    bytes.writeUInt32LE(0x100, 0x190);
    bytes.writeUInt32LE((1 << 8) | 1, 0x194);
    const header = Buffer.alloc(40);
    header.writeUInt32LE(9, 4);
    header.writeUInt32LE(0x190, 16);
    header.writeUInt32LE(8, 20);
    header.writeUInt32LE(5, 24);
    header.writeUInt32LE(2, 28);
    header.writeUInt32LE(8, 36);
    header.copy(bytes, 0x280 + 8 * 40);
    bytes.writeUInt16LE(9, 48);
    const report = await read(bytes);
    expect(row(report)).toEqual([
      {
        kind: "init_array",
        value: "0x80",
        section: ".text",
        symbol: "ctor",
        resolution: "raw",
      },
    ]);
    expect(report.status).toBe("parsed");
  });

  it("maps a resolved target whose first byte ends a load segment", async () => {
    const bytes = elf64PieInitializers();
    // The first init_array RELATIVE addend points at the last mapped byte.
    bytes.writeBigInt64LE(BigInt(bytes.length - 1), 0x498 + 16);
    const report = await read(bytes);
    const slot = report.entries.find((entry) => entry.kind === "init_array");
    expect(slot).toMatchObject({
      value_va: `0x${(bytes.length - 1).toString(16)}`,
      value_file_offset: bytes.length - 1,
    });
  });

  it("pauses during a large dynamic relocation table and observes cancellation there", async () => {
    const base = elf64PieInitializers();
    const words = 64 * 1024;
    const relr = Buffer.alloc(words * 8);
    // One address entry for the fini slot, then empty bitmaps that only advance the cursor.
    relr.writeBigUInt64LE(0x220n, 0);
    for (let word = 1; word < words; word += 1)
      relr.writeBigUInt64LE(1n, word * 8);
    const bytes = Buffer.concat([base, relr]);
    bytes.writeBigUInt64LE(BigInt(bytes.length), 64 + 32);
    bytes.writeBigUInt64LE(BigInt(bytes.length), 64 + 40);
    // DT_RELR and DT_RELRSZ are the twelfth and thirteenth dynamic entries.
    bytes.writeBigUInt64LE(BigInt(base.length), 0x300 + 11 * 16 + 8);
    bytes.writeBigUInt64LE(BigInt(relr.length), 0x300 + 12 * 16 + 8);
    expect(row(await read(bytes))).toEqual(row(await read(base)));
    const controller = new AbortController();
    let turns = 0;
    const tick = (): void => {
      turns += 1;
      if (turns === 2) controller.abort(new Error("cancelled by test"));
      else setImmediate(tick);
    };
    setImmediate(tick);
    await expect(
      readNativeInitializers(
        bytes,
        artifact(bytes),
        { path: "/artifacts/image", offset: 0, limit: 64 },
        controller.signal,
      ),
    ).rejects.toThrow(ArtifactReaderFailure);
  });
});

/**
 * elf64PieInitializers whose leading RELA record is read only as a section
 * record: DT_RELA starts at the second one. With `fileEnd`, the load is also
 * split at the preinit_array slot (0x240), so memory from `fileEnd` up to that
 * slot is zero-fill.
 */
const sectionOnlyRecord = (
  offset: bigint,
  info: bigint,
  fileEnd?: bigint,
): Buffer => {
  const bytes = elf64PieInitializers();
  bytes.writeBigUInt64LE(0x498n, 0x300 + 8 * 16 + 8);
  bytes.writeBigUInt64LE(72n, 0x300 + 9 * 16 + 8);
  bytes.writeBigUInt64LE(offset, 0x480);
  bytes.writeBigUInt64LE(info, 0x488);
  if (fileEnd === undefined) return bytes;
  bytes.writeUInt16LE(3, 56);
  bytes.writeBigUInt64LE(fileEnd, 64 + 32);
  bytes.writeBigUInt64LE(0x240n, 64 + 40);
  bytes.writeUInt32LE(1, 176);
  bytes.writeUInt32LE(6, 180);
  for (const field of [184, 192, 200]) bytes.writeBigUInt64LE(0x240n, field);
  for (const field of [208, 216])
    bytes.writeBigUInt64LE(BigInt(bytes.length - 0x240), field);
  bytes.writeBigUInt64LE(1n, 224);
  return bytes;
};

/** R_X86_64_COPY of dynamic symbol 1, whose `st_size` is at 0x548. */
const COPY_OF_SYMBOL_1 = (1n << 32n) | 5n;
const SYMBOL_1_SIZE = 0x538 + 16;

describe("ELF COPY relocations and writes without file bytes", () => {
  it.each([
    ["file-backed bytes", 0x700n],
    ["zero-fill memory", 0xc10n],
  ])(
    "keeps a stored word when a COPY relocation writes %s elsewhere",
    async (_where, destination) => {
      const base = elf64PieInitializers();
      const bytes = Buffer.from(base);
      // The load segment gains a zero-fill tail from 0xc00, as .bss does.
      bytes.writeBigUInt64LE(0xd00n, 64 + 40);
      // The leading null RELA record becomes R_X86_64_COPY of dynamic symbol
      // 1, which now records an 8-byte object.
      bytes.writeBigUInt64LE(destination, 0x480);
      bytes.writeBigUInt64LE((1n << 32n) | 5n, 0x488);
      bytes.writeBigUInt64LE(8n, 0x538 + 16);
      const report = await read(bytes);
      expect(row(report)).toEqual(row(await read(base)));
      expect(report.status).toBe("parsed");
      expect(report.limitations).toEqual((await read(base)).limitations);
    },
  );

  it("keeps a slot inside the bytes a COPY relocation writes unresolved", async () => {
    const bytes = elf64PieInitializers();
    // A 16-byte COPY at 0x238 runs through the preinit_array slot at 0x240.
    bytes.writeBigUInt64LE(0x238n, 0x480);
    bytes.writeBigUInt64LE((1n << 32n) | 5n, 0x488);
    bytes.writeBigUInt64LE(16n, 0x538 + 16);
    const report = await read(bytes);
    expect(
      report.entries.map((entry) => [entry.slot_va, entry.resolution]),
    ).toEqual([
      ["0x240", "unresolved"],
      ["0x308", "raw"],
      ["0x200", "relative_addend"],
      ["0x208", "relative_addend"],
      ["0x210", "unresolved_import"],
      ["0x318", "raw"],
      ["0x220", "relr"],
    ]);
    expect(report.status).toBe("incomplete");
    expect(report.limitations).toContain(
      "1 initializer slot(s) are partly overwritten or written more than once by dynamic relocations and are listed as unresolved.",
    );
  });

  it("keeps stored words unresolved when a COPY relocation's size is unreadable", async () => {
    const bytes = elf64PieInitializers();
    bytes.writeBigUInt64LE(0x700n, 0x480);
    bytes.writeBigUInt64LE((1n << 32n) | 5n, 0x488);
    bytes.writeBigUInt64LE(8n, 0x538 + 16);
    // DT_SYMENT is the eighteenth dynamic entry; 16 is not an ELF64 symbol size.
    bytes.writeBigUInt64LE(16n, 0x300 + 17 * 16 + 8);
    const report = await read(bytes);
    expect(report.entries[0]).toMatchObject({
      kind: "preinit_array",
      value_va: null,
      resolution: "unresolved",
    });
    expect(report.status).toBe("incomplete");
    expect(report.limitations).toContain(
      "ELF COPY relocation write size is not established",
    );
  });

  it.each([
    ["an 8-byte write that runs into the slot", 1n, "unresolved", "incomplete"],
    ["a 4-byte write that ends at the slot", 10n, "raw", "parsed"],
  ] as const)(
    "judges a section record without file bytes by the memory it overlaps: %s",
    async (_case, kind, resolution, status) => {
      // The first segment ends in four zero-fill bytes at 0x23c, where the
      // record writes, just below the slot at 0x240.
      const report = await read(
        sectionOnlyRecord(0x23cn, (1n << 32n) | kind, 0x23cn),
      );
      expect(report.entries[0]).toMatchObject({
        kind: "preinit_array",
        slot_va: "0x240",
        value_va: resolution === "raw" ? "0x100" : null,
        resolution,
      });
      expect(report.status).toBe(status);
    },
  );
});

describe("ELF COPY relocations read as section records", () => {
  it.each([
    ["ends at the slot", 16n, "raw", "parsed"],
    ["reaches the slot's first byte", 17n, "unresolved", "incomplete"],
    ["runs through the slot", 24n, "unresolved", "incomplete"],
  ] as const)(
    "sizes a COPY into zero-fill memory by its symbol: %s",
    async (_case, size, resolution, status) => {
      // Zero-fill runs from the record at 0x230 up to the slot at 0x240.
      const bytes = sectionOnlyRecord(0x230n, COPY_OF_SYMBOL_1, 0x230n);
      bytes.writeBigUInt64LE(size, SYMBOL_1_SIZE);
      const report = await read(bytes);
      expect(report.entries[0]).toMatchObject({
        kind: "preinit_array",
        slot_va: "0x240",
        value_va: resolution === "raw" ? "0x100" : null,
        resolution,
      });
      expect(report.status).toBe(status);
    },
  );

  it.each([
    ["ends at the slot", 8n, "raw", "parsed"],
    ["runs through the slot", 16n, "unresolved", "incomplete"],
  ] as const)(
    "sizes a COPY over file bytes by its symbol: %s",
    async (_case, size, resolution, status) => {
      const bytes = sectionOnlyRecord(0x238n, COPY_OF_SYMBOL_1);
      bytes.writeBigUInt64LE(size, SYMBOL_1_SIZE);
      const report = await read(bytes);
      expect(report.entries[0]).toMatchObject({
        kind: "preinit_array",
        slot_va: "0x240",
        value_va: resolution === "raw" ? "0x100" : null,
        resolution,
      });
      expect(report.status).toBe(status);
      expect(
        report.limitations.includes(
          "1 initializer slot(s) are partly overwritten or relocated more than once by section relocations and are listed as unresolved.",
        ),
      ).toBe(resolution === "unresolved");
    },
  );

  it.each([
    ["names symbol 0", (bytes: Buffer) => bytes.writeBigUInt64LE(5n, 0x488)],
    [
      "names a symbol past its table",
      (bytes: Buffer) => bytes.writeBigUInt64LE((2n << 32n) | 5n, 0x488),
    ],
    [
      "links to a section that is not a symbol table",
      // .rela.dyn is section 6; .dynstr is section 8.
      (bytes: Buffer) => bytes.writeUInt32LE(8, 0x800 + 6 * 64 + 40),
    ],
  ])(
    "keeps stored words unresolved when a section COPY %s",
    async (_case, change) => {
      // Neither destination is within a word of a slot: file bytes at 0x700
      // and zero-fill memory at 0xc10.
      for (const destination of [0x700n, 0xc10n]) {
        const bytes = sectionOnlyRecord(destination, COPY_OF_SYMBOL_1);
        bytes.writeBigUInt64LE(0xd00n, 64 + 40);
        bytes.writeBigUInt64LE(8n, SYMBOL_1_SIZE);
        change(bytes);
        const report = await read(bytes);
        expect(report.entries[0]).toMatchObject({
          kind: "preinit_array",
          value_va: null,
          resolution: "unresolved",
        });
        expect(report.status).toBe("incomplete");
        expect(report.limitations).toContain(
          "A section COPY relocation's write size is not established; slots without a relocation are unresolved.",
        );
      }
    },
  );

  it("limits section COPY sizes together to the file byte count", async () => {
    // One or two section-only COPY records of dynamic symbol 1 write zero-fill
    // memory far above every slot of this 0xc00-byte file.
    const sized = (size: bigint, records: 1 | 2) => {
      const bytes = sectionOnlyRecord(0xc10n, COPY_OF_SYMBOL_1);
      bytes.writeBigUInt64LE(0x4000n, 64 + 40);
      bytes.writeBigUInt64LE(size, SYMBOL_1_SIZE);
      if (records === 2) {
        // DT_RELA starts at the third record, so the second one is read only
        // as a section record too.
        bytes.writeBigUInt64LE(0x4b0n, 0x300 + 8 * 16 + 8);
        bytes.writeBigUInt64LE(48n, 0x300 + 9 * 16 + 8);
        bytes.writeBigUInt64LE(0x2000n, 0x498);
        bytes.writeBigUInt64LE(COPY_OF_SYMBOL_1, 0x4a0);
      }
      return read(bytes);
    };
    for (const [size, records] of [
      [0xc00n, 1],
      [0x600n, 2],
    ] as const) {
      const within = await sized(size, records);
      expect(within.entries[0]?.resolution).toBe("raw");
      expect(within.status).toBe("parsed");
    }
    for (const [size, records] of [
      [0xc01n, 1],
      [0x601n, 2],
    ] as const) {
      const beyond = await sized(size, records);
      expect(beyond.entries[0]?.resolution).toBe("unresolved");
      expect(beyond.status).toBe("incomplete");
      expect(beyond.limitations).toContain(
        "Section COPY relocation sizes exceed the file byte count allowance; slots without a relocation are unresolved.",
      );
    }
  });

  it("takes the one word of a RELATIVE record as an established extent", async () => {
    // R_X86_64_RELATIVE into zero-fill memory, ending a word below the slot.
    const report = await read(sectionOnlyRecord(0x230n, 8n, 0x230n));
    expect(report.entries[0]).toMatchObject({
      kind: "preinit_array",
      slot_va: "0x240",
      value_va: "0x100",
      resolution: "raw",
    });
    expect(report.status).toBe("parsed");
  });

  it("does not take the word assumed for an unknown kind as proof that a slot beside zero-fill memory is untouched", async () => {
    // Kind 99 has no known width. Its record sits 16 bytes below the slot.
    const report = await read(
      sectionOnlyRecord(0x230n, (1n << 32n) | 99n, 0x230n),
    );
    expect(report.entries[0]).toMatchObject({
      kind: "preinit_array",
      slot_va: "0x240",
      value_va: null,
      resolution: "unresolved",
    });
    expect(report.status).toBe("incomplete");
  });

  it("keeps the one-word assumption for a COPY kind in a relocatable object", async () => {
    const bytes = elfRelocatableCtors();
    // The .ctors record against `ctor`, a symbol of size 0, becomes kind 5.
    bytes.writeBigUInt64LE(COPY_OF_SYMBOL_1, 0x308);
    const report = await read(bytes);
    expect(
      report.entries.map((entry) => [entry.kind, entry.resolution]),
    ).toEqual([
      ["init_array", "symbol_addend"],
      ["ctors", "unresolved"],
    ]);
  });
});

describe("Unreadable symbol names", () => {
  it("reports an ELF name offset outside its string table as incomplete", async () => {
    const bytes = elf64PieInitializers();
    // ctor_a, the first .symtab entry after the null symbol.
    bytes.writeUInt32LE(0x7fff, 0x598);
    const report = await read(bytes);
    expect(report.status).toBe("incomplete");
    expect(report.entries[0]?.symbol).toBeNull();
    expect(report.limitations).toContain(
      "1 symbol name(s) could not be read because the string table is missing or the name offset is outside it.",
    );
  });

  it("reports a Mach-O name index outside its string table as incomplete", async () => {
    const bytes = machoArm64Initializers();
    bytes.writeUInt32LE(0x7fff, 0x3000);
    const report = await read(bytes);
    expect(report.status).toBe("incomplete");
    expect(report.entries[0]?.symbol).toBeNull();
    expect(report.limitations).toContain(
      "1 symbol name(s) could not be read because the string table is missing or the name offset is outside it.",
    );
  });
});

describe("Mach-O fixup sources", () => {
  it("yields and cancels while expanding legacy rebase runs", async () => {
    const bytes = machoArm64LegacyRebaseInitializers();
    const run = Buffer.from([0x11, 0x21, 0, 0x60, 0x80, 0x10]);
    const stream = Buffer.concat([
      ...Array.from({ length: 12 }, () => run),
      Buffer.from([0]),
    ]);
    stream.copy(bytes, 0x3300);
    bytes.writeUInt32LE(stream.length, 548);
    const controller = new AbortController();
    setImmediate(() => controller.abort(new Error("cancel during rebase")));
    await expect(
      readNativeInitializers(
        bytes,
        artifact(bytes),
        { path: "/artifacts/image", offset: 0, limit: 64 },
        controller.signal,
      ),
    ).rejects.toThrow(ArtifactReaderFailure);
  });

  it("keeps both initializer slots unresolved when a legacy bind crosses their boundary", async () => {
    const bytes = machoArm64LegacyRebaseInitializers();
    const bind = Buffer.from([
      0x40,
      ...Buffer.from("_foo\0"),
      0x51,
      0x71,
      0x04,
      0x90,
      0x00,
    ]);
    bytes.writeBigUInt64LE(16n, 256 + 40);
    bytes.writeUInt32LE(0, 548);
    bytes.writeUInt32LE(0x3300, 552);
    bytes.writeUInt32LE(bind.length, 556);
    bind.copy(bytes, 0x3300);
    const report = await read(bytes);
    expect(report.entries.slice(0, 2).map((entry) => entry.resolution)).toEqual(
      ["unresolved", "unresolved"],
    );
    expect(report.status).toBe("incomplete");
  });

  it("does not resolve an initializer from a section offset that disagrees with its load mapping", async () => {
    const bytes = machoArm64LegacyRebaseInitializers();
    bytes.writeUInt32LE(0x4030, 256 + 48);
    bytes.writeBigUInt64LE(0x100001100n, 0x4030);
    const report = await read(bytes);
    expect(report.entries[0]).toMatchObject({
      resolution: "unresolved",
      value_va: null,
    });
    expect(report.status).toBe("incomplete");
  });

  it("labels an LC_DYLD_INFO rebase as a legacy rebase, not a chained fixup", async () => {
    const report = await read(machoArm64LegacyRebaseInitializers());
    expect(report.status).toBe("parsed");
    expect(row(report)[0]).toEqual({
      kind: "mod_init",
      value: "0x100001000",
      section: "__TEXT,__text",
      symbol: "_init",
      resolution: "dyld_info_rebase",
    });
  });

  it("keeps a 32-bit pointer slot unresolved when undecoded bind opcodes could replace it", async () => {
    expect(row(await read(macho32Initializers(0)))).toEqual([
      {
        kind: "mod_init",
        value: "0x1100",
        section: "__TEXT,__text",
        symbol: "_init",
        resolution: "raw",
      },
    ]);
    const report = await read(macho32Initializers(8));
    expect(report.entries[0]).toMatchObject({
      resolution: "unresolved",
      value_va: null,
    });
    expect(report.status).toBe("incomplete");
    expect(report.limitations).toContain(
      "LC_DYLD_INFO bind opcodes are not decoded for this image, so a pointer slot's stored word may be replaced by a bound symbol at load time.",
    );
  });

  it("applies object-file section relocations instead of reading the stored addend as a target", async () => {
    const report = await read(machoX8664ObjectInitializers());
    expect(row(report)).toEqual([
      {
        kind: "mod_init",
        value: "0x10",
        section: "__TEXT,__text",
        symbol: "_startup",
        resolution: "symbol_addend",
      },
      {
        kind: "mod_init",
        value: "0x0",
        section: "__TEXT,__text",
        symbol: "_before",
        resolution: "raw",
      },
    ]);
    expect(report.status).toBe("parsed");
  });

  it("decodes UTF-8 Mach-O nlist names and retains invalid text as unknown", async () => {
    const image = machoX8664ObjectInitializers();
    const strings = Buffer.from("\0_before\0_démarre\0", "utf8");
    strings.copy(image, 0x270);
    image.writeUInt32LE(strings.length, 284);
    const report = await read(image);
    expect(report.entries[0]?.symbol?.name).toBe("_démarre");
    const invalid = Buffer.from(image);
    invalid[0x270 + 10] = 0xff;
    const unknown = await read(invalid);
    expect(unknown.entries[0]?.symbol).toBeNull();
    expect(unknown.status).toBe("incomplete");
  });

  it("keeps both object-file slots unresolved when a relocation crosses their boundary", async () => {
    const bytes = machoX8664ObjectInitializers();
    bytes.writeUInt32LE(4, 0x248);
    const report = await read(bytes);
    expect(report.entries.map((entry) => entry.resolution)).toEqual([
      "unresolved",
      "unresolved",
    ]);
    expect(report.status).toBe("incomplete");
  });

  it("keeps an object-file slot unresolved under a relocation it does not apply", async () => {
    const bytes = machoX8664ObjectInitializers();
    // The first entry becomes X86_64_RELOC_SUBTRACTOR (type 5).
    bytes.writeUInt32LE(1 | (3 << 25) | (1 << 27) | (5 << 28), 0x244);
    const report = await read(bytes);
    expect(report.entries[0]).toMatchObject({
      resolution: "unresolved",
      value_va: null,
    });
    expect(report.status).toBe("incomplete");
    expect(report.limitations).toContain(
      "1 object-file slot(s) have section relocations this reader does not apply and are listed as unresolved.",
    );
  });
});

describe("Initializer target semantics", () => {
  it("keeps an absolute relocation against an IFUNC symbol unresolved", async () => {
    const bytes = elfRelocatableCtors();
    // `ctor` becomes a global STT_GNU_IFUNC, whose value is its resolver.
    bytes.writeUInt8(0x1a, 0x338 + 4);
    const report = await read(bytes);
    const ctor = report.entries.find((entry) => entry.kind === "ctors");
    expect(ctor).toMatchObject({
      slot_va: "0x8",
      resolution: "unresolved",
      value_va: null,
    });
  });

  it("keeps a slot a narrower section relocation partly overwrites unresolved", async () => {
    const bytes = elfRelocatableCtors();
    // The .ctors record becomes R_X86_64_32 at byte 4 of slot 0x8.
    bytes.writeBigUInt64LE(0xcn, 0x300);
    bytes.writeBigUInt64LE((1n << 32n) | 10n, 0x308);
    const report = await read(bytes);
    const ctors = report.entries.filter((entry) => entry.kind === "ctors");
    expect(ctors.map((entry) => [entry.slot_va, entry.resolution])).toEqual([
      ["0x8", "unresolved"],
    ]);
    expect(report.status).toBe("incomplete");
    expect(report.limitations).toContain(
      "1 initializer slot(s) are partly overwritten or relocated more than once by section relocations and are listed as unresolved.",
    );
  });

  it("clears the ELF ARM Thumb bit when locating a target but keeps the callable value", async () => {
    const bytes = elf32RelativeInitializers();
    bytes.writeUInt16LE(40, 18);
    // R_ARM_RELATIVE with in-place addend 0x81, and a Thumb `ctor` at 0x81.
    bytes.writeUInt32LE(23, 0x184);
    bytes.writeUInt32LE(0x81, 0x100);
    bytes.writeUInt32LE(0x81, 0x1b4);
    const report = await read(bytes);
    expect(report.entries[0]).toMatchObject({
      value_va: "0x81",
      value_file_offset: 0x80,
      section: { name: ".text" },
      symbol: { name: "ctor" },
      resolution: "relative_addend",
    });
  });

  it("clears the Mach-O ARM Thumb bit when locating and naming a target", async () => {
    const bytes = macho32Initializers(0);
    bytes.writeUInt32LE(12, 4);
    bytes.writeUInt32LE(0x1101, 0x1000);
    const report = await read(bytes);
    expect(report.entries[0]).toMatchObject({
      value_va: "0x1101",
      value_file_offset: 0x100,
      section: { name: "__TEXT,__text" },
      symbol: { name: "_init" },
      resolution: "raw",
    });
  });

  it("rejects an arm64_32 image that declares a 64-bit header", async () => {
    const bytes = machoArm64Initializers();
    bytes.writeUInt32LE(0x0200000c, 4);
    await expect(read(bytes)).rejects.toThrow(BinaryFormatFailure);
  });
});

describe("ELF initializer relocation identity", () => {
  it("reuses one section relocation for repeated declarations of the same virtual slot", async () => {
    const bytes = elf64AliasedInitializers();
    bytes.writeBigUInt64LE(0x200n, 0x300 + 2 * 16 + 8);
    const report = await read(bytes);
    expect(report.status).toBe("parsed");
    expect(
      report.entries
        .filter((entry) => entry.slot_va === "0x200")
        .map((entry) => [entry.value_va, entry.resolution]),
    ).toEqual([
      ["0x100", "relative_addend"],
      ["0x100", "relative_addend"],
    ]);
  });

  it("does not attribute an i386 REL's in-place addend to an unrelocated alias", async () => {
    const bytes = elf32RelativeInitializers();
    bytes.writeUInt16LE(3, 44);
    const alias = 116;
    bytes.writeUInt32LE(1, alias);
    bytes.writeUInt32LE(0x100, alias + 4);
    bytes.writeUInt32LE(0x1100, alias + 8);
    bytes.writeUInt32LE(4, alias + 16);
    bytes.writeUInt32LE(4, alias + 20);
    bytes.writeUInt32LE(6, alias + 24);
    bytes.writeUInt32LE(1, alias + 28);
    bytes.writeUInt32LE(0x1100, 0x124);
    // Only the section declaration still names the REL table.
    for (let index = 2; index <= 4; index++)
      bytes.writeInt32LE(0x70000000 + index, 0x120 + index * 8);
    const unrelocated = await read(bytes);
    expect(unrelocated.entries[0]).toMatchObject({
      slot_va: "0x1100",
      value_va: "0x80",
      resolution: "raw",
    });
    // Moving the same REL to that address uses its own stored in-place word.
    bytes.writeUInt32LE(0x1100, 0x180);
    expect((await read(bytes)).entries[0]).toMatchObject({
      slot_va: "0x1100",
      value_va: "0x80",
      resolution: "relative_addend",
    });
  });

  it.each([false, true])(
    "keeps section RELA writes on their virtual-address owner (both aliases relocated: %s)",
    async (both) => {
      const bytes = elf64AliasedInitializers();
      if (both) bytes.writeBigUInt64LE(0x1200n, 0x4b0);
      const report = await read(bytes);
      expect(report.status).toBe("parsed");
      expect(
        report.entries
          .filter((entry) =>
            ["preinit_array", "init_array"].includes(entry.kind),
          )
          .map((entry) => [entry.slot_va, entry.value_va, entry.resolution]),
      ).toEqual([
        ["0x200", "0x100", "relative_addend"],
        ["0x1200", both ? "0x110" : "0x0", both ? "relative_addend" : "raw"],
      ]);
    },
  );

  it("keeps a partial relocation on one alias from clobbering the other", async () => {
    const bytes = elf64AliasedInitializers();
    bytes.writeBigUInt64LE(0x1204n, 0x4b0);
    bytes.writeBigUInt64LE(10n, 0x4b8); // R_X86_64_32, overlapping the alias's last four bytes.
    const report = await read(bytes);
    expect(report.status).toBe("incomplete");
    expect(
      report.entries.find((entry) => entry.kind === "preinit_array"),
    ).toMatchObject({
      value_va: "0x100",
      resolution: "relative_addend",
    });
    expect(
      report.entries.find((entry) => entry.kind === "init_array"),
    ).toMatchObject({
      value_va: null,
      resolution: "unresolved",
    });
  });

  it("keeps relocatable section identities distinct when their source bytes alias", async () => {
    const bytes = elfRelocatableCtors();
    // The .init_array bytes now alias .ctors's relocated middle slot.
    bytes.writeBigUInt64LE(0x208n, 0x500 + 7 * 64 + 24);
    const report = await read(bytes);
    expect(report.status).toBe("parsed");
    expect(
      report.entries.map((entry) => [
        entry.kind,
        entry.slot_file_offset,
        entry.value_va,
        entry.symbol?.name,
      ]),
    ).toEqual([
      ["init_array", 0x208, "0x8", "init_b"],
      ["ctors", 0x208, "0x0", "ctor"],
    ]);
  });
});

describe("Initializer address mapping", () => {
  it("reports no target file offset when load segments map it ambiguously", async () => {
    const bytes = elf64PieInitializers();
    // A third PT_LOAD maps 0x100..0x140 from file offset 0x200, conflicting with the identity load.
    bytes.writeUInt16LE(3, 56);
    bytes.writeUInt32LE(1, 176);
    bytes.writeUInt32LE(5, 180);
    bytes.writeBigUInt64LE(0x200n, 184);
    bytes.writeBigUInt64LE(0x100n, 192);
    bytes.writeBigUInt64LE(0x100n, 200);
    bytes.writeBigUInt64LE(0x40n, 208);
    bytes.writeBigUInt64LE(0x40n, 216);
    bytes.writeBigUInt64LE(1n, 224);
    const report = await read(bytes);
    const preinit = report.entries.find(
      (entry) => entry.kind === "preinit_array",
    );
    expect(preinit).toMatchObject({
      value_va: "0x100",
      value_file_offset: null,
    });
    expect(report.status).toBe("incomplete");
    expect(report.limitations).toContain(
      "An address has ambiguous file mappings (overlapping load segments with different file offsets, or file and zero-fill memory), so its file offset is not reported.",
    );
  });

  /** ELF64 ET_EXEC with `loads` identical identity PT_LOADs and an `.init_array` of `slots` slots, each pointing at 0x40. */
  const manyLoads = (loads: number, slots: number): Buffer => {
    const arrayAt = 0x1000;
    const shstr = Buffer.from("\0.init_array\0.shstrtab\0", "utf8");
    const stringsAt = arrayAt + slots * 8;
    const headersAt = stringsAt + 0x40;
    const bytes = Buffer.alloc(headersAt + 3 * 64);
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
    bytes.writeUInt16LE(2, 16);
    bytes.writeUInt16LE(62, 18);
    bytes.writeUInt32LE(1, 20);
    bytes.writeBigUInt64LE(64n, 32);
    bytes.writeBigUInt64LE(BigInt(headersAt), 40);
    bytes.writeUInt16LE(64, 52);
    bytes.writeUInt16LE(56, 54);
    bytes.writeUInt16LE(loads, 56);
    bytes.writeUInt16LE(64, 58);
    bytes.writeUInt16LE(3, 60);
    bytes.writeUInt16LE(2, 62);
    for (let load = 0; load < loads; load += 1) {
      const at = 64 + load * 56;
      bytes.writeUInt32LE(1, at);
      bytes.writeUInt32LE(5, at + 4);
      bytes.writeBigUInt64LE(BigInt(bytes.length), at + 32);
      bytes.writeBigUInt64LE(BigInt(bytes.length), at + 40);
      bytes.writeBigUInt64LE(1n, at + 48);
    }
    for (let slot = 0; slot < slots; slot += 1)
      bytes.writeBigUInt64LE(0x40n, arrayAt + slot * 8);
    shstr.copy(bytes, stringsAt);
    const header = (
      index: number,
      name: number,
      type: number,
      offset: number,
      size: number,
      flags: number,
    ): void => {
      const at = headersAt + index * 64;
      bytes.writeUInt32LE(name, at);
      bytes.writeUInt32LE(type, at + 4);
      bytes.writeBigUInt64LE(BigInt(flags), at + 8);
      bytes.writeBigUInt64LE(BigInt(offset), at + 16);
      bytes.writeBigUInt64LE(BigInt(offset), at + 24);
      bytes.writeBigUInt64LE(BigInt(size), at + 32);
      bytes.writeBigUInt64LE(1n, at + 48);
    };
    header(1, 1, 14, arrayAt, slots * 8, 3);
    header(2, 13, 3, stringsAt, shstr.length, 0);
    return bytes;
  };

  it("builds one mapping index per image instead of scanning every load per slot", async () => {
    // Calls into the mapping module made from other modules, per inspection.
    const mappingCalls = async (slots: number) => {
      mapping.scans.mockClear();
      mapping.indexes.mockClear();
      const report = await read(manyLoads(4, slots));
      expect(report.coverage.examined_entries).toBe(slots);
      expect(report.entries[0]).toMatchObject({
        value_va: "0x40",
        value_file_offset: 0x40,
      });
      return {
        scans: mapping.scans.mock.calls.length,
        indexes: mapping.indexes.mock.calls.length,
      };
    };
    const few = await mappingCalls(8);
    const many = await mappingCalls(64);
    // A per-slot linear scan grows with the slot count; indexed lookups do not.
    expect(many).toEqual(few);
    expect(many.indexes).toBeGreaterThan(0);
  });

  it("reports a Mach-O bind name over the name budget as incomplete", async () => {
    const bytes = machoArm64Initializers();
    const name = `_${"b".repeat(1100)}`;
    // Rebuild the chained-fixups payload with one DYLD_CHAINED_IMPORT bound by flat lookup.
    const starts = Buffer.from(bytes.subarray(0x3200 + 28, 0x3200 + 64));
    const header = Buffer.alloc(28);
    header.writeUInt32LE(28, 4);
    header.writeUInt32LE(28 + starts.length, 8);
    header.writeUInt32LE(28 + starts.length + 4, 12);
    header.writeUInt32LE(1, 16);
    header.writeUInt32LE(1, 20);
    const entry = Buffer.alloc(4);
    entry.writeUInt32LE(0xfe, 0);
    const chained = Buffer.concat([
      header,
      starts,
      entry,
      Buffer.from(`${name}\0`),
    ]);
    chained.copy(bytes, 0x3200);
    bytes.writeUInt32LE(chained.length, 508);
    bytes.writeBigUInt64LE(1n << 63n, 0x4000);
    const report = await read(bytes);
    expect(report.entries[0]).toMatchObject({
      kind: "mod_init",
      resolution: "unresolved_import",
      symbol: null,
    });
    expect(report.status).toBe("incomplete");
    expect(report.limitations).toContain(
      "1 symbol name(s) exceeded the 1024-byte name budget and were not used.",
    );
  });
});

it("keeps a slot touched by an overrun section relocation unresolved", async () => {
  const bytes = elfRelocatableCtors();
  bytes.writeBigUInt64LE(4n, 0x318);
  bytes.writeBigUInt64LE(0x10n, 0x220);
  const report = await readNativeInitializers(bytes, artifact(bytes), {
    path: "/artifacts/image",
    offset: 0,
    limit: 64,
  });
  expect(report.coverage.status).toBe("incomplete");
  expect(
    report.entries.find((entry) => entry.kind === "init_array"),
  ).toMatchObject({ resolution: "unresolved", value_va: null });
});

it("keeps identical repeated dynamic writes unresolved", async () => {
  const bytes = elf64PieInitializers();
  bytes.writeBigUInt64LE(0x200n, 0x480);
  bytes.writeBigUInt64LE(8n, 0x488);
  bytes.writeBigInt64LE(0x100n, 0x490);
  const report = await readNativeInitializers(bytes, artifact(bytes), {
    path: "/artifacts/image",
    offset: 0,
    limit: 64,
  });
  expect(
    report.entries.find((entry) => entry.slot_va === "0x200"),
  ).toMatchObject({ resolution: "unresolved", value_va: null });
});

it("retains unknown coverage when sparse bind lookups exhaust their allowance", async () => {
  const bytes = machoSparseBindInitializers(4097);
  const report = await readNativeInitializers(bytes, artifact(bytes), {
    path: "/artifacts/image",
    offset: 0,
    limit: 1,
  });
  expect(report.coverage.status).toBe("incomplete");
  expect(report.entries[0]).toMatchObject({
    resolution: "unresolved",
    value_va: null,
  });
  expect(report.limitations.join("\n")).toContain(
    "bind lookup candidate allowance exhausted",
  );
});

it("yields and observes cancellation during sparse bind analysis", async () => {
  const bytes = machoSparseBindInitializers(2048);
  const controller = new AbortController();
  setImmediate(() => controller.abort());
  await expect(
    readNativeInitializers(
      bytes,
      artifact(bytes),
      { path: "/artifacts/image", offset: 0, limit: 1 },
      controller.signal,
    ),
  ).rejects.toThrow(ArtifactReaderFailure);
});

it("keeps a linked section-fallback slot unresolved when its load mapping disagrees", async () => {
  const bytes = elf64PieInitializers();
  for (let at = 0x300; at < 0x430; at += 16) {
    if (bytes.readBigUInt64LE(at) === 25n)
      bytes.writeBigUInt64LE(0x70000000n, at);
  }
  bytes.writeBigUInt64LE(0x260n, 0x800 + 3 * 64 + 24);
  bytes.writeBigUInt64LE(0x110n, 0x260);
  const report = await readNativeInitializers(bytes, artifact(bytes), {
    path: "/artifacts/image",
    offset: 0,
    limit: 64,
  });
  expect(report.coverage.status).toBe("incomplete");
  expect(
    report.entries.find((entry) => entry.kind === "init_array"),
  ).toMatchObject({
    resolution: "unresolved",
    value_va: null,
    slot_file_offset: 0x260,
  });
});
