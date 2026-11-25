import { describe, expect, it } from "vitest";
import {
  assertMipsSharedLoad,
  mipsSharedPlacementDelta,
  parseMipsSharedReadelf,
} from "./mips-shared-checks.mjs";

// GNU readelf -l -d -r --dyn-syms excerpt of the little-endian LLD fixture.
const readelf = `Program Headers:
  Type           Offset   VirtAddr   PhysAddr   FileSiz MemSiz  Flg Align
  LOAD           0x000000 0x00000000 0x00000000 0x003f8 0x003f8 R   0x10000
  LOAD           0x000400 0x00010400 0x00010400 0x000b4 0x000b4 R E 0x10000
  LOAD           0x0004b4 0x000204b4 0x000204b4 0x00010 0x00b4c RW  0x10000
  LOAD           0x0004d0 0x000304d0 0x000304d0 0x00024 0x00030 RW  0x10000

Dynamic section at offset 0x2a8 contains 4 entries:
  Tag        Type                         Name/Value
 0x70000011 (MIPS_SYMTABNO)              9
 0x7000000a (MIPS_LOCAL_GOTNO)           2
 0x70000013 (MIPS_GOTSYM)                0x4
 0x00000003 (PLTGOT)                     0x304d0

Relocation section '.rel.dyn' at offset 0x3d0 contains 5 entries:
 Offset     Info    Type                Sym. Value  Symbol's Name
000204b8  00000003 R_MIPS_REL32          
000204bc  00000803 R_MIPS_REL32           00010400   rea_mips_so_exported
000204c0  00000403 R_MIPS_REL32           00000000   rea_mips_so_external
000304ec  00000226 R_MIPS_TLS_DTPMOD32    00000000   rea_mips_so_tls
000304f0  00000227 R_MIPS_TLS_DTPREL32    00000000   rea_mips_so_tls

Symbol table '.dynsym' contains 9 entries:
   Num:    Value  Size Type    Bind   Vis      Ndx Name
     0: 00000000     0 NOTYPE  LOCAL  DEFAULT  UND 
     1: 00010418   156 FUNC    GLOBAL DEFAULT    8 rea_mips_so_entry
     2: 00000000     4 TLS     GLOBAL DEFAULT    9 rea_mips_so_tls
     3: 000204c0     4 OBJECT  GLOBAL DEFAULT   10 rea_mips_so_external_pointer
     4: 00000000     0 NOTYPE  GLOBAL DEFAULT  UND rea_mips_so_external
     5: 00000000     0 NOTYPE  GLOBAL DEFAULT  UND rea_mips_so_external_data
     6: 000204b8     8 OBJECT  GLOBAL DEFAULT   10 rea_mips_so_table
     7: 00000000     0 NOTYPE  GLOBAL DEFAULT  UND __tls_get_addr
     8: 00010400     8 FUNC    GLOBAL DEFAULT    8 rea_mips_so_exported
`;

// Source words at their file offsets: local table entry, GOT, TLS slots.
const fileBytes = Buffer.alloc(0x4f4);
fileBytes.writeUInt32LE(0x10408, 0x4b8);
fileBytes.writeUInt32LE(0x80000000, 0x4d4);
fileBytes.writeUInt32LE(0x204b8, 0x4e0);
fileBytes.writeUInt32LE(0x10400, 0x4e8);

// Ghidra placement as observed: +0x10000, imports in a separate EXTERNAL block.
const mappings = [
  { block: "segment_1.1", start: "0x10000", length: 0x3f8, file_offset: 0 },
  { block: ".text", start: "0x20400", length: 0xb4, file_offset: 0x400 },
  { block: ".data.rel.ro", start: "0x304b8", length: 12, file_offset: 0x4b8 },
  { block: ".got", start: "0x404d0", length: 0x24, file_offset: 0x4d0 },
  { block: "EXTERNAL", start: "0x41000", length: 12, file_offset: null },
];
const names = [
  {
    value: "rea_mips_so_external",
    address: "0x41000",
    symbol: { external: false, type: "function" },
  },
  {
    value: "rea_mips_so_external_data",
    address: "0x41004",
    symbol: { external: false, type: "label" },
  },
  {
    value: "__tls_get_addr",
    address: "0x41008",
    symbol: { external: false, type: "function" },
  },
];
const relocations = () => [
  { address: "0x304b8", type: 3, status: "APPLIED" },
  { address: "0x304bc", type: 3, status: "APPLIED" },
  { address: "0x304c0", type: 3, status: "APPLIED" },
  { address: "0x404ec", type: 38, status: "UNSUPPORTED" },
  { address: "0x404f0", type: 39, status: "UNSUPPORTED" },
];
const words = () =>
  new Map([
    [0x304b8n, 0x20408],
    [0x304bcn, 0x20400],
    [0x304c0n, 0x41000],
    [0x404d8n, 0x41000],
    [0x404dcn, 0x41004],
    [0x404e0n, 0x304b8],
    [0x404e4n, 0x41008],
    [0x404e8n, 0x20400],
    [0x404ecn, 0],
    [0x404f0n, 0],
  ]);
const check = (
  overrides: Partial<Parameters<typeof assertMipsSharedLoad>[0]> = {},
) =>
  assertMipsSharedLoad({
    facts: parseMipsSharedReadelf(readelf),
    fileBytes,
    mappings,
    ghidraRelocations: relocations(),
    words: words(),
    names,
    byteOrder: "little",
    ...overrides,
  });

describe("MIPS32 shared-library real-verifier expectations", () => {
  it("reads PT_LOAD, GOT tags, dynamic symbols and REL entries", () => {
    const facts = parseMipsSharedReadelf(readelf);
    expect(facts.loads).toHaveLength(4);
    expect(Object.fromEntries(facts.dynamic)).toEqual({
      MIPS_SYMTABNO: 9,
      MIPS_LOCAL_GOTNO: 2,
      MIPS_GOTSYM: 4,
      PLTGOT: 0x304d0,
    });
    expect(facts.symbols.get(4)).toMatchObject({
      ndx: "UND",
      name: "rea_mips_so_external",
    });
    expect(facts.relocations).toEqual([
      { address: 0x204b8, type: 3, symbolIndex: 0 },
      { address: 0x204bc, type: 3, symbolIndex: 8 },
      { address: 0x204c0, type: 3, symbolIndex: 4 },
      { address: 0x304ec, type: 38, symbolIndex: 2 },
      { address: 0x304f0, type: 39, symbolIndex: 2 },
    ]);
  });

  it("accepts REL32, GOT and TLS words that match the placement", () => {
    expect(check()).toEqual({
      delta: "0x10000",
      rel32_local: 1,
      rel32_defined: 1,
      rel32_external: 1,
      tls: 2,
      got_local: 0,
      got_local_zero: 0,
      got_defined: 2,
      got_external: 3,
      got_lazy_stub: 0,
      got_skipped_tls: 0,
    });
  });

  it("rejects a block that disagrees with the shared placement offset", () => {
    expect(() =>
      mipsSharedPlacementDelta(
        parseMipsSharedReadelf(readelf),
        mappings.map((item) =>
          item.block === ".text" ? { ...item, start: "0x20404" } : item,
        ),
      ),
    ).toThrow(/Placement delta of \.text/u);
  });

  it.each([
    ["an unshifted local REL32", 0x304b8n, 0x10408],
    ["a REL32 bound to the wrong import", 0x304c0n, 0x41004],
    ["an unshifted global GOT entry for a definition", 0x404e0n, 0x204b8],
    ["a GOT entry for an import outside EXTERNAL", 0x404d8n, 0],
    ["a rewritten TLS slot", 0x404ecn, 1],
  ])("rejects %s", (_label, address, value) => {
    const changed = words();
    changed.set(address, value);
    expect(() => check({ words: changed })).toThrow();
  });

  it("rebases a zero-valued local GOT page entry, as glibc does", () => {
    // Entry 1 without its MSB is an ordinary local entry (page 0 here).
    const bytes = Buffer.from(fileBytes);
    bytes.writeUInt32LE(0, 0x4d4);
    const shifted = words();
    shifted.set(0x404d4n, 0x10000);
    expect(check({ fileBytes: bytes, words: shifted }).got_local).toBe(1);
    // Ghidra's adjustTableEntryIfNonZero leaves zero entries unshifted.
    const unshifted = words();
    unshifted.set(0x404d4n, 0);
    expect(() => check({ fileBytes: bytes, words: unshifted })).toThrow(
      /Local GOT entry 1/u,
    );
  });

  it("expects an import's lazy-binding stub, not EXTERNAL, in its GOT entry", () => {
    const lazy = readelf.replace(
      "4: 00000000     0 NOTYPE  GLOBAL DEFAULT  UND rea_mips_so_external",
      "4: 000103f0     0 FUNC    GLOBAL DEFAULT  UND rea_mips_so_external",
    );
    const facts = parseMipsSharedReadelf(lazy);
    const stub = words();
    stub.set(0x404d8n, 0x203f0);
    expect(check({ facts, words: stub })).toMatchObject({
      got_external: 2,
      got_lazy_stub: 1,
    });
    expect(() => check({ facts })).toThrow(/lazy stub/u);
  });

  it("rejects a TLS slot Ghidra claims to have applied, or a missing REL32", () => {
    expect(() =>
      check({
        ghidraRelocations: relocations().map((item) =>
          item.type === 38 ? { ...item, status: "APPLIED" } : item,
        ),
      }),
    ).toThrow(/TLS status/u);
    expect(() => check({ ghidraRelocations: relocations().slice(1) })).toThrow(
      /Ghidra relocation 3/u,
    );
  });
});
