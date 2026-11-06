import { describe, expect, it } from "vitest";
import {
  analysisAddressOffset,
  assertLoongArchGlobalBytes,
  assertLoongArchLoadedImage,
  assertLoongArchProbeBytes,
  assertLoongArchProbeInstructions,
  assertLoongArchProbePseudocode,
  loongArchPointer,
  parseLoongArchReadelf,
  requireLoongArchRelocation,
} from "./loongarch-checks.mjs";

// GNU readelf 2.43 output for the source-owned GNU 12.3 fixture. This tests the
// independent reader boundary, not Ghidra; the real lane rebuilds the fixture.
const readelf = `ELF Header:
  Magic:   7f 45 4c 46 02 01 01 00 00 00 00 00 00 00 00 00
  Class:                             ELF64
  Data:                              2's complement, little endian
  Version:                           1 (current)
  OS/ABI:                            UNIX - System V
  ABI Version:                       0
  Type:                              DYN (Shared object file)
  Machine:                           LoongArch
  Version:                           0x1
  Entry point address:               0x0
  Start of program headers:          64 (bytes into file)
  Start of section headers:          66504 (bytes into file)
  Flags:                             0x43, DOUBLE-FLOAT, OBJ-v1
  Size of this header:               64 (bytes)
  Size of program headers:           56 (bytes)
  Number of program headers:         6
  Size of section headers:           64 (bytes)
  Number of section headers:         18
  Section header string table index: 17

Relocation section '.rela.dyn' at offset 0x2d8 contains 1 entry:
    Offset             Info             Type               Symbol's Value  Symbol's Name + Addend
000000000001ffe8  0000000600000002 R_LARCH_64             0000000000020008 rea_loongarch_global + 0

Relocation section '.rela.plt' at offset 0x2f0 contains 1 entry:
    Offset             Info             Type               Symbol's Value  Symbol's Name + Addend
0000000000020000  0000000400000005 R_LARCH_JUMP_SLOT      0000000000000340 rea_loongarch_add + 0

Symbol table '.dynsym' contains 8 entries:
   Num:    Value          Size Type    Bind   Vis      Ndx Name
     0: 0000000000000000     0 NOTYPE  LOCAL  DEFAULT  UND
     1: 0000000000000340     0 SECTION LOCAL  DEFAULT    7 .text
     2: 0000000000000390     0 SECTION LOCAL  DEFAULT    9 .eh_frame
     3: 0000000000020008     0 SECTION LOCAL  DEFAULT   13 .data
     4: 0000000000000340    24 FUNC    GLOBAL DEFAULT    7 rea_loongarch_add
     5: 0000000000000360     8 FUNC    GLOBAL DEFAULT    7 rea_loongarch_entry
     6: 0000000000020008     4 OBJECT  GLOBAL DEFAULT   13 rea_loongarch_global
     7: 0000000000000368    12 FUNC    GLOBAL DEFAULT    7 rea_loongarch_probe

Symbol table '.symtab' contains 25 entries:
   Num:    Value          Size Type    Bind   Vis      Ndx Name
     0: 0000000000000000     0 NOTYPE  LOCAL  DEFAULT  UND
     4: 00000000000002d8     0 SECTION LOCAL  DEFAULT    4 .rela.dyn
    13: 0000000000000368    12 FUNC    GLOBAL DEFAULT    7 rea_loongarch_probe
`;
const sha256 = "a".repeat(64);
const image = {
  language_id: "Loongarch:LE:64:lp64d",
  compiler_spec_id: "default",
  // Relocations change the loaded image, not the source identity.
  source_files: [{ original_sha256: sha256, modified_sha256: "b".repeat(64) }],
};
const probeInstructions = [
  "0x100368: addi.d a0, zero, 0x5",
  "0x10036c: addi.d a0, a0, 0x3",
  "0x100370: ret",
];

describe("LoongArch real-verifier independent expectations", () => {
  it("reads GNU header, symbols and relocations without a Ghidra oracle", () => {
    const parsed = parseLoongArchReadelf(readelf);
    expect(parsed.loongarch).toEqual({
      elfClass: 64,
      byteOrder: "little",
      type: 3,
      flags: 0x43,
      floatAbi: "double",
      objectAbiVersion: 1,
      undeclaredFlags: 0,
    });
    expect(parsed.symbols).toEqual({
      rea_loongarch_add: "0x340",
      rea_loongarch_entry: "0x360",
      rea_loongarch_global: "0x20008",
      rea_loongarch_probe: "0x368",
    });
    expect(parsed.relocations).toEqual({
      R_LARCH_64: 1,
      R_LARCH_JUMP_SLOT: 1,
    });
    // The lane needs the site, type id and addend, not just type counts.
    expect(parsed.relocationEntries).toEqual([
      {
        offset: "0x1ffe8",
        type: "R_LARCH_64",
        typeId: 2,
        symbol: "rea_loongarch_global",
        symbolValue: "0x20008",
        addend: 0n,
      },
      {
        offset: "0x20000",
        type: "R_LARCH_JUMP_SLOT",
        typeId: 5,
        symbol: "rea_loongarch_add",
        symbolValue: "0x340",
        addend: 0n,
      },
    ]);
  });

  it("requires exactly one relocation of the requested type", () => {
    const parsed = parseLoongArchReadelf(readelf);
    expect(requireLoongArchRelocation(parsed, "R_LARCH_64")).toBe(
      parsed.relocationEntries[0],
    );
    expect(() => requireLoongArchRelocation(parsed, "R_LARCH_32")).toThrow(
      /exactly one R_LARCH_32 relocation/u,
    );
  });

  it("decodes an 8-byte little-endian pointer observation", () => {
    expect(loongArchPointer("0800120000000000")).toBe(0x120008n);
    expect(() => loongArchPointer("1208")).toThrow(/8-byte/u);
  });

  it("keeps a v0 declaration distinct from a v1 declaration", () => {
    const oldWorld = parseLoongArchReadelf(
      readelf.replace(
        "Flags:                             0x43, DOUBLE-FLOAT, OBJ-v1",
        "Flags:                             0x3, DOUBLE-FLOAT",
      ),
    );
    expect(oldWorld.loongarch).toMatchObject({
      flags: 0x3,
      floatAbi: "double",
      objectAbiVersion: 0,
    });
  });

  it("rejects conflicting duplicate symbol values", () => {
    expect(() =>
      parseLoongArchReadelf(
        readelf.replace(
          "    13: 0000000000000368    12 FUNC    GLOBAL DEFAULT    7 rea_loongarch_probe",
          "    13: 0000000000000340    12 FUNC    GLOBAL DEFAULT    7 rea_loongarch_probe",
        ),
      ),
    ).toThrow(/conflicting addresses/u);
  });

  it("checks the loaded language and original source identity", () => {
    expect(() => assertLoongArchLoadedImage(image, sha256)).not.toThrow();
    expect(() =>
      assertLoongArchLoadedImage(
        { ...image, language_id: "Loongarch:LE:64:lp64f" },
        sha256,
      ),
    ).toThrow();
  });

  it("checks the source-owned probe bytes and listing text", () => {
    expect(() =>
      assertLoongArchProbeBytes("0414c002840cc0022000004c"),
    ).not.toThrow();
    expect(() => assertLoongArchGlobalBytes("2a000000")).not.toThrow();
    expect(() =>
      assertLoongArchProbeInstructions(probeInstructions, "0x100368"),
    ).not.toThrow();
    expect(() =>
      assertLoongArchProbeInstructions(probeInstructions, "0x10036c"),
    ).toThrow();
  });

  it("requires a folded return value, not merely pseudocode presence", () => {
    expect(() =>
      assertLoongArchProbePseudocode(
        "\nundefined8 rea_loongarch_probe(void)\n\n{\n  return 8;\n}\n\n",
      ),
    ).not.toThrow();
    expect(() =>
      assertLoongArchProbePseudocode("void rea_loongarch_probe(void) {}"),
    ).toThrow();
  });

  it("parses default and address-space-prefixed coordinates", () => {
    expect(analysisAddressOffset("0x100368")).toBe(0x100368n);
    expect(analysisAddressOffset("ram:0x368")).toBe(0x368n);
  });
});
