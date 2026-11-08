import { describe, expect, it } from "vitest";
import { readNativeInitializers } from "./NativeInitializersProvider.js";
import {
  elf32RelativeInitializers,
  elf64PieInitializers,
  elfRelocatableCtors,
  machoArm64FatInitializers,
  machoArm64Initializers,
} from "./NativeInitializers.fixture.js";
import {
  MAX_NATIVE_INITIALIZER_ENTRIES,
  MAX_NATIVE_INITIALIZER_LIMITATIONS,
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

const read = (
  bytes: Buffer,
  page: { offset?: number; limit?: number; architecture?: "arm64" } = {},
) =>
  nativeInitializersSchema.parse(
    readNativeInitializers(bytes, artifact(bytes), {
      path: "/artifacts/image",
      offset: page.offset ?? 0,
      limit: page.limit ?? 64,
      ...(page.architecture === undefined
        ? {}
        : { architecture: page.architecture }),
    }),
  );

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

const row = (report: ReturnType<typeof read>) =>
  report.entries.map((entry) => ({
    kind: entry.kind,
    value: entry.value_va,
    section: entry.section?.name ?? null,
    symbol: entry.symbol?.name ?? null,
    resolution: entry.resolution,
  }));

describe("ELF", () => {
  it("does not treat repeated DT_NEEDED entries as duplicate tags", () => {
    const report = read(elf64PieInitializers(3));
    expect(report.status).toBe("parsed");
    expect(report.coverage.status).toBe("complete");
    expect(row(report)).toEqual(row(read(elf64PieInitializers())));
    expect(
      report.limitations.some((line) =>
        line.startsWith("Duplicate dynamic tag"),
      ),
    ).toBe(false);
  });

  it("lists PIE slots in declaration order through RELA, RELR and imports", () => {
    const report = read(elf64PieInitializers());
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

  it("pages entries without changing their indexes", () => {
    const report = read(elf64PieInitializers(), { offset: 2, limit: 2 });
    expect(report.coverage).toMatchObject({
      status: "complete",
      examined_entries: 7,
      returned_entries: 2,
      offset: 2,
      limit: 2,
    });
    expect(report.entries.map((entry) => entry.index)).toEqual([2, 3]);
  });

  it("resolves an ELF32 REL RELATIVE slot from its in-place addend", () => {
    const report = read(elf32RelativeInitializers());
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

  it("reads relocatable-object sections by section-relative offset and skips sentinels", () => {
    const report = read(elfRelocatableCtors());
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
  it("keeps a 32-bit all-ones word in a 64-bit .ctors as a listed value", () => {
    const bytes = elfRelocatableCtors();
    // The leading .ctors sentinel becomes 0x00000000ffffffff, which is not -1 in ELF64.
    bytes.writeBigUInt64LE(0xffffffffn, 0x200);
    const report = read(bytes);
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

  it("reports no slot address for DT_INIT and DT_FINI fields outside every load segment", () => {
    const bytes = elf64PieInitializers();
    // Shrink the only PT_LOAD so PT_DYNAMIC (file offset 0x300) is no longer mapped.
    bytes.writeBigUInt64LE(0x300n, 64 + 32);
    bytes.writeBigUInt64LE(0x300n, 64 + 40);
    const report = read(bytes);
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
});

describe("ELF incomplete inputs", () => {
  it("reports an unsupported relocation machine as incomplete, not as raw zeros", () => {
    const bytes = elf64PieInitializers();
    bytes.writeUInt16LE(243, 18);
    const report = read(bytes);
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

  it("bounds a huge declared DT_INIT_ARRAYSZ by the slot budget", () => {
    const bytes = elf64PieInitializers();
    // DT_INIT_ARRAYSZ is the fourth dynamic entry; 2^50 slots is still a safe integer.
    bytes.writeBigUInt64LE(8n << 50n, 0x300 + 3 * 16 + 8);
    const started = performance.now();
    const report = read(bytes);
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

  it("stops a file-backed section-derived init_array at the slot budget", () => {
    const base = elfRelocatableCtors();
    const slots = MAX_NATIVE_INITIALIZER_ENTRIES + 4096;
    const bytes = Buffer.concat([base, Buffer.alloc(slots * 8)]);
    // .init_array is section 7 of the relocatable fixture: sh_offset at +24, sh_size at +32.
    bytes.writeBigUInt64LE(BigInt(base.length), 0x500 + 7 * 64 + 24);
    bytes.writeBigUInt64LE(BigInt(slots * 8), 0x500 + 7 * 64 + 32);
    const report = read(bytes);
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

  it("reports over-long section and symbol names as null instead of failing the schema", () => {
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
    const report = read(bytes);
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

  it("labels an over-long section-derived array with the request name", () => {
    const base = elfRelocatableCtors();
    const longSection = `.init_array.${"s".repeat(1100)}`;
    const bytes = Buffer.concat([base, Buffer.from(`${longSection}\0`)]);
    // .shstrtab (section 6) at 0x400 grows to cover the tail; rename .init_array (section 7).
    bytes.writeBigUInt64LE(BigInt(bytes.length - 0x400), 0x500 + 6 * 64 + 32);
    bytes.writeUInt32LE(base.length - 0x400, 0x500 + 7 * 64);
    const report = read(bytes);
    const slot = report.entries.find((entry) => entry.kind === "init_array");
    expect(slot).toMatchObject({ slot_section: null, detail: ".init_array" });
    expect(
      report.limitations.some((line) =>
        line.includes("exceeded the 1024-byte name budget"),
      ),
    ).toBe(true);
  });
});

describe("ELF table budgets", () => {
  it("caps symbols in total across every symbol table, not per table", () => {
    const perTable = 40_000;
    // Two zeroed SHT_SYMTAB tables, each under the cap, that exceed it together.
    const bytes = withExtraSections(Buffer.alloc(perTable * 24), (at) => [
      sectionHeader(2, at, perTable * 24, 5, 24),
      sectionHeader(2, at, perTable * 24, 5, 24),
    ]);
    const report = read(bytes);
    expect(report.status).toBe("incomplete");
    expect(report.coverage.total_entries).toBeNull();
    expect(report.limitations).toContain(
      "Symbol table scanning stopped at 65536 symbols across all symbol tables. Later names may be missing.",
    );
  });

  it("reports an unreadable symbol table as incomplete rather than absent", () => {
    // An SHT_SYMTAB whose size is not a whole number of 24-byte entries.
    const bytes = withExtraSections(Buffer.alloc(32), (at) => [
      sectionHeader(2, at, 25, 5, 24),
    ]);
    const report = read(bytes);
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

  it("bounds section relocation records in total across repeated headers", () => {
    const report = read(repeatedRelocations());
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
    expect(row(report)).toEqual(row(read(elfRelocatableCtors())));
  });

  it("reports a relocation section reached after the record budget is spent", () => {
    // Sixteen full headers spend the budget exactly; the seventeenth is not read.
    const records = 65_536;
    const bytes = withExtraSections(Buffer.alloc(records * 24), (at) => [
      ...Array.from({ length: 16 }, () =>
        sectionHeader(4, at, records * 24, 4, 24, 1),
      ),
      sectionHeader(4, at, 24, 4, 24, 1),
    ]);
    const report = read(bytes);
    expect(report.status).toBe("incomplete");
    expect(
      report.limitations.filter((line) =>
        line.startsWith(
          "Section relocation scanning stopped at 1048576 records",
        ),
      ),
    ).toHaveLength(1);
  });

  it("observes cancellation during the section relocation walk", () => {
    const bytes = repeatedRelocations();
    let reads = 0;
    const signal = {
      get aborted() {
        reads += 1;
        return reads > 16;
      },
      reason: new Error("cancelled by test"),
    } as unknown as AbortSignal;
    expect(() =>
      readNativeInitializers(
        bytes,
        artifact(bytes),
        { path: "/artifacts/image", offset: 0, limit: 64 },
        signal,
      ),
    ).toThrow(ArtifactReaderFailure);
  });
});

describe("Mach-O", () => {
  it("decodes chained pointers, init offsets and raw terminators", () => {
    const report = read(machoArm64Initializers());
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

  it("marks the report incomplete when a chained-fixup slot cannot be decoded", () => {
    const bytes = machoArm64Initializers();
    // A DYLD_CHAINED_PTR_64_OFFSET bind with ordinal 5, but the image has no imports.
    bytes.writeBigUInt64LE((1n << 63n) | 5n, 0x4000);
    const report = read(bytes);
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

  it("reports container file offsets for a selected universal slice", () => {
    const report = read(machoArm64FatInitializers(), { architecture: "arm64" });
    expect(report.slice).toMatchObject({
      file_offset: 0x1000,
      architecture: "arm64",
    });
    expect(report.entries[0]).toMatchObject({
      slot_file_offset: 0x5000,
      value_file_offset: 0x2000,
    });
  });

  it("rejects bytes that are neither ELF nor Mach-O", () => {
    expect(() => read(Buffer.alloc(128))).toThrow(BinaryFormatFailure);
  });
});

describe("ELF repeated observations", () => {
  it("tallies every over-long symbol name into one counted limitation", () => {
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
    const report = read(bytes);
    expect(report.status).toBe("incomplete");
    expect(
      report.limitations.filter((line) =>
        line.includes("exceeded the 1024-byte name budget"),
      ),
    ).toEqual([
      `${String(rows)} symbol name(s) exceeded the 1024-byte name budget and were not used.`,
    ]);
    expect(report.limitations.length).toBeLessThanOrEqual(
      MAX_NATIVE_INITIALIZER_LIMITATIONS,
    );
  });

  it("tallies relocation sections with an unexpected entry size", () => {
    const sections = 40;
    const bytes = withExtraSections(Buffer.alloc(48), (at) =>
      Array.from({ length: sections }, () =>
        sectionHeader(4, at, 48, 4, 16, 7),
      ),
    );
    const report = read(bytes);
    expect(report.status).toBe("incomplete");
    expect(
      report.limitations.filter((line) => line.includes("entry size")),
    ).toEqual([
      `${String(sections)} relocation section(s) had an unexpected entry size and were not applied.`,
    ]);
    expect(report.limitations.length).toBeLessThanOrEqual(
      MAX_NATIVE_INITIALIZER_LIMITATIONS,
    );
  });

  it("keeps distinct notes to the budget and counts the rest", () => {
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
    ).toBeLessThanOrEqual(MAX_NATIVE_INITIALIZER_LIMITATIONS);
    expect(notes.recorded).toBe(400);
  });
});

describe("ELF section lookups", () => {
  it("names the smallest covering range and breaks ties by header order", () => {
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

  it("resolves a full slot budget against a near-maximal section table in one pass", () => {
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
    const report = read(bytes);
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
  }, 180_000);
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

  it("caps symbols in total across every LC_SYMTAB, not per command", () => {
    const perTable = 40_000;
    const bytes = withSymtabs(
      Buffer.alloc((perTable + 1) * 16),
      (at, original) => [
        symtab(original, at, perTable),
        symtab(original, at + 16, perTable),
      ],
    );
    const report = read(bytes);
    expect(report.status).toBe("incomplete");
    expect(report.coverage.total_entries).toBeNull();
    expect(report.limitations).toContain(
      "Symbol scanning stopped at 65536 symbols across all LC_SYMTAB commands. Later names may be missing.",
    );
    expect(report.entries[0]?.symbol?.name).toBe("_init");
  });

  it("ignores a repeated LC_SYMTAB over the same ranges", () => {
    const bytes = withSymtabs(Buffer.alloc(0), (_, original) => [original]);
    const report = read(bytes);
    expect(report.status).toBe("parsed");
    expect(row(report)).toEqual(row(read(machoArm64Initializers())));
    expect(report.limitations).toContain(
      "A repeated LC_SYMTAB names the same symbol and string ranges and was ignored.",
    );
  });
});
