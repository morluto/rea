import { describe, expect, it } from "vitest";

import { elfDynamicExportsImage } from "../../../tests/fixtures/binaryDiagnostics/elfDynamicExports.js";
import {
  MAX_NATIVE_EXPORT_ROWS,
  nativeExportsSchema,
} from "../../domain/native/nativeExports.js";
import {
  BinaryFormatFailure,
  BinaryResourceFailure,
} from "../metadata/BinaryContainer.js";
import { parseNativeExports } from "./NativeExportParser.js";

const parse = (bytes: Buffer) =>
  nativeExportsSchema.parse(
    parseNativeExports(bytes, {
      path: "/fixture/libsectionless.so",
      sha256: "a".repeat(64),
      bytes: bytes.length,
    }),
  );

describe("ELF exports declared by PT_DYNAMIC", () => {
  it.each([
    { bits: 32, little: false, hash: "sysv" },
    { bits: 64, little: true, hash: "gnu" },
    { bits: 64, little: false, hash: "both" },
  ] as const)(
    "enumerates $bits-bit exports with $hash hashes without section headers",
    (encoding) => {
      const result = parse(elfDynamicExportsImage(encoding));
      expect(result).toMatchObject({
        format: "elf",
        bits: encoding.bits,
        byte_order: encoding.little ? "little" : "big",
        exports: [
          { name: "exported_answer", type: "function", value: "0x10700" },
          { name: "exported_state", type: "object", value: "0x10710" },
        ],
        coverage: { status: "complete", examined_entries: 2, exports: 2 },
        issues: [],
      });
    },
  );

  it("uses PT_DYNAMIC when a section directory remains without SHT_DYNSYM", () => {
    const bytes = elfDynamicExportsImage();
    // Two ELF64 section headers: SHT_NULL followed by the symbols' SHT_PROGBITS section.
    const table = 0x600;
    const section = table + 64;
    bytes.writeBigUInt64LE(BigInt(table), 40); // e_shoff
    bytes.writeUInt16LE(2, 60); // e_shnum
    bytes.writeUInt32LE(1, section + 4); // sh_type
    bytes.writeBigUInt64LE(2n, section + 8); // SHF_ALLOC
    bytes.writeBigUInt64LE(0x10700n, section + 16); // sh_addr
    bytes.writeBigUInt64LE(0x700n, section + 24); // sh_offset
    bytes.writeBigUInt64LE(0x14n, section + 32); // sh_size
    bytes.writeBigUInt64LE(16n, section + 48); // sh_addralign

    expect(parse(bytes)).toMatchObject({
      exports: [
        { name: "exported_answer", type: "function", value: "0x10700" },
        { name: "exported_state", type: "object", value: "0x10710" },
      ],
      coverage: { status: "complete", examined_entries: 2, exports: 2 },
      issues: [],
    });
  });

  it.each([{ hash: "none" }, { hash: "gnu", emptyGnuBuckets: true }] as const)(
    "keeps an indeterminate symbol count unsupported: %j",
    (options) => {
      const result = parse(elfDynamicExportsImage(options));
      expect(result.exports).toEqual([]);
      expect(result.coverage.status).toBe("unsupported");
      expect(result.coverage.reason).toEqual(expect.any(String));
    },
  );

  it("retains version indices and hidden flags while marking names unresolved", () => {
    const result = parse(
      elfDynamicExportsImage({ hash: "both", versions: [0, 2, 0x8003] }),
    );
    expect(result.exports).toMatchObject([
      {
        name: "exported_answer",
        version: { index: 2, name: null, hidden: false },
      },
      {
        name: "exported_state",
        version: { index: 3, name: null, hidden: true },
      },
    ]);
    expect(result.coverage.status).toBe("partial");
    expect(result.issues).toMatchObject([
      { code: "version_unresolved" },
      { code: "version_unresolved" },
    ]);
  });

  it("keeps readable exports with unknown versions when DT_VERSYM is unmapped", () => {
    const bytes = elfDynamicExportsImage({ versions: [0, 2, 3] });
    // The sixth dynamic entry is DT_VERSYM for the SysV-only fixture.
    bytes.writeBigUInt64LE(0x20000n, 0x400 + 5 * 16 + 8);
    const result = parse(bytes);
    expect(result.exports).toMatchObject([
      { name: "exported_answer", version: "unknown" },
      { name: "exported_state", version: "unknown" },
    ]);
    expect(result.issues).toMatchObject([{ code: "version_unresolved" }]);
    expect(result.coverage.status).toBe("partial");
  });

  it.each([
    { binding: "global", info: 0x12, exported: true },
    { binding: "weak", info: 0x22, exported: true },
    { binding: "local", info: 0x02, exported: false },
  ])(
    "uses the $binding symbol binding when DT_VERSYM reports index zero",
    ({ binding, info, exported }) => {
      const bytes = elfDynamicExportsImage({ versions: [0, 0, 1] });
      // st_info of the first non-null Elf64_Sym: change the binding, keep STT_FUNC.
      bytes[0x200 + 24 + 4] = info;
      const exports = [
        ...(exported
          ? [{ name: "exported_answer", binding, version: null }]
          : []),
        { name: "exported_state", binding: "global", version: null },
      ];
      expect(parse(bytes)).toMatchObject({
        exports,
        coverage: {
          status: "complete",
          examined_entries: 2,
          exports: exports.length,
        },
        issues: [],
      });
    },
  );

  it("keeps a readable sibling when a symbol names bytes outside DT_STRSZ", () => {
    const bytes = elfDynamicExportsImage();
    bytes.writeUInt32LE(0xffff, 0x200 + 2 * 24);
    const result = parse(bytes);
    expect(result.exports).toMatchObject([{ name: "exported_answer" }]);
    expect(result.issues).toMatchObject([{ code: "name_unreadable" }]);
    expect(result.coverage).toMatchObject({
      status: "partial",
      examined_entries: 2,
    });
  });

  it("recognizes a complete empty inventory when SysV nchain declares only STN_UNDEF", () => {
    const bytes = elfDynamicExportsImage();
    bytes.writeUInt32LE(1, 0x304);
    bytes.writeUInt32LE(0, 0x308);
    const result = parse(bytes);
    expect(result.exports).toEqual([]);
    expect(result.coverage).toMatchObject({
      status: "complete",
      examined_entries: 0,
      exports: 0,
    });
    expect(result.issues).toEqual([]);
  });
});

describe("malformed ELF dynamic export declarations", () => {
  it.each([
    {
      name: "a non-null reserved symbol",
      mutate: (bytes: Buffer) => {
        bytes[0x200] = 1;
      },
    },
    {
      name: "a dynamic table without DT_NULL",
      mutate: (bytes: Buffer) => bytes.writeBigUInt64LE(1n, 0x400 + 5 * 16),
    },
    {
      name: "a duplicate symbol-table declaration",
      mutate: (bytes: Buffer) => bytes.writeBigUInt64LE(6n, 0x400 + 4 * 16),
    },
    {
      name: "an incompatible symbol width",
      mutate: (bytes: Buffer) => bytes.writeBigUInt64LE(16n, 0x400 + 16 + 8),
    },
    {
      name: "a symbol range crossing the end of a load mapping",
      mutate: (bytes: Buffer) => bytes.writeBigUInt64LE(0x107f0n, 0x408),
    },
    {
      name: "a hash table crossing the end of a load mapping",
      mutate: (bytes: Buffer) => {
        bytes.writeBigUInt64LE(0x107f0n, 0x400 + 4 * 16 + 8);
        bytes.writeUInt32LE(1, 0x7f0);
        bytes.writeUInt32LE(3, 0x7f4);
      },
    },
    {
      name: "a missing reserved symbol",
      mutate: (bytes: Buffer) => bytes.writeUInt32LE(0, 0x304),
    },
  ])("rejects $name without publishing an invented inventory", ({ mutate }) => {
    const bytes = elfDynamicExportsImage();
    mutate(bytes);
    expect(() => parse(bytes)).toThrow(BinaryFormatFailure);
  });

  it("rejects conflicting SysV and GNU symbol counts", () => {
    const bytes = elfDynamicExportsImage({ hash: "both" });
    bytes.writeUInt32LE(2, 0x304);
    expect(() => parse(bytes)).toThrow(BinaryFormatFailure);
  });

  it("rejects a conflicting load mapping inside a hash table, even when its last word is readable", () => {
    const bytes = elfDynamicExportsImage();
    bytes.writeUInt16LE(3, 56);
    const program = 64 + 2 * 56;
    bytes.writeUInt32LE(1, program);
    bytes.writeUInt32LE(4, program + 4);
    bytes.writeBigUInt64LE(0x700n, program + 8);
    bytes.writeBigUInt64LE(0x10308n, program + 16);
    bytes.writeBigUInt64LE(0x10308n, program + 24);
    bytes.writeBigUInt64LE(4n, program + 32);
    bytes.writeBigUInt64LE(4n, program + 40);
    bytes.writeBigUInt64LE(4n, program + 48);
    expect(() => parse(bytes)).toThrow(BinaryFormatFailure);
  });

  it("bounds hash-declared symbols before reading or allocating their rows", () => {
    const bytes = elfDynamicExportsImage();
    bytes.writeUInt32LE(MAX_NATIVE_EXPORT_ROWS + 1, 0x304);
    expect(() => parse(bytes)).toThrow(BinaryResourceFailure);
  });
});
