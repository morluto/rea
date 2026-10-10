import { describe, expect, it } from "vitest";
import {
  assertMipsGlobal,
  assertMipsLoadedImage,
  assertMipsProbe,
  parseMipsReadelf,
} from "./mips-checks.mjs";

// GNU readelf 2.40 output for the source-owned Clang 17 / LLD fixture.
// This tests the reader boundary, not Ghidra; the real lane rebuilds both orders.
const readelf = `ELF Header:
  Magic:   7f 45 4c 46 01 01 01 00 00 00 00 00 00 00 00 00
  Class:                             ELF32
  Data:                              2's complement, little endian
  Version:                           1 (current)
  OS/ABI:                            UNIX - System V
  ABI Version:                       0
  Type:                              EXEC (Executable file)
  Machine:                           MIPS R3000
  Version:                           0x1
  Entry point address:               0x201b0
  Start of program headers:          52 (bytes into file)
  Start of section headers:          2996 (bytes into file)
  Flags:                             0x70001001, noreorder, o32, mips32r2
  Size of this header:               52 (bytes)
  Size of program headers:           32 (bytes)
  Number of program headers:         7
  Size of section headers:           40 (bytes)
  Number of section headers:         24
  Section header string table index: 22

Symbol table '.symtab' contains 9 entries:
   Num:    Value  Size Type    Bind   Vis      Ndx Name
     0: 00000000     0 NOTYPE  LOCAL  DEFAULT  UND
     1: 00000000     0 FILE    LOCAL  DEFAULT  ABS mips.c
     2: 00020254     0 NOTYPE  LOCAL  DEFAULT    4 .Lzero
     3: 00038250     0 NOTYPE  LOCAL  HIDDEN     6 _gp
     4: 00020170    64 FUNC    GLOBAL DEFAULT    4 rea_mips_leaf
     5: 00030268     4 OBJECT  GLOBAL DEFAULT    7 rea_mips_global
     6: 000201b0   136 FUNC    GLOBAL DEFAULT    4 rea_mips_entry
     7: 00010148    30 OBJECT  GLOBAL DEFAULT    3 rea_mips_marker
     8: 00020240    32 FUNC    GLOBAL DEFAULT    4 rea_mips_probe

MIPS ABI Flags Version: 0

ISA: MIPS32r2
GPR size: 32
CPR1 size: 32
CPR2 size: 0
FP ABI: Hard float (32-bit CPU, Any FPU)
ISA Extension: None
ASEs:
	None
FLAGS 1: 00000000
FLAGS 2: 00000000
`;
const sha256 = "a".repeat(64);
const image = {
  language_id: "MIPS:LE:32:default",
  compiler_spec_id: "default",
  source_files: [{ original_sha256: sha256, modified_sha256: sha256 }],
};
const move = {
  address: "0x20240",
  status: "decoded",
  architecture: "MIPS:LE:32:default",
  length: 4,
  bytes: "34128224",
  mnemonic: "addiu",
  operands: [
    { index: 2, components: [{ kind: "immediate", value: "0x1234" }] },
  ],
};
const branch = {
  address: "0x20244",
  status: "decoded",
  architecture: "MIPS:LE:32:default",
  length: 4,
  bytes: "03008010",
  mnemonic: "beqz",
  flow: {
    kind: "jump",
    conditional: true,
    computed: false,
    direct_destinations: ["0x20254"],
  },
};

describe("MIPS real-verifier independent expectations", () => {
  it("reads GNU header, ABI and defined symbols without a Ghidra-derived oracle", () => {
    const parsed = parseMipsReadelf(readelf, "little");
    expect(parsed.mips).toMatchObject({
      elfClass: 32,
      byteOrder: "little",
      flags: 0x70001001,
      abiFlags: {
        isaLevel: 32,
        isaRevision: 2,
        gprSize: 1,
        cpr1Size: 1,
        fpAbi: 5,
      },
    });
    expect(parsed.symbols.rea_mips_probe).toBe("0x20240");
    expect(
      parseMipsReadelf(readelf.replace("little endian", "big endian"), "big")
        .mips.byteOrder,
    ).toBe("big");
  });

  it.each([
    ["wrong class", "ELF32", "ELF64"],
    ["wrong byte order", "little endian", "big endian"],
    ["wrong machine", "MIPS R3000", "AArch64"],
    ["wrong object type", "EXEC (Executable file)", "DYN (Shared object file)"],
    ["wrong flags", "0x70001001", "0x60001001"],
    ["wrong ISA", "ISA: MIPS32r2", "ISA: MIPS32r6"],
    ["unknown FP ABI", "Hard float (32-bit CPU, Any FPU)", "unknown"],
    ["unknown register width", "GPR size: 32", "GPR size: 64"],
    ["missing symbol", "rea_mips_probe", "unrelated_probe"],
    ["missing ABI", "MIPS ABI Flags Version: 0", "ABI omitted"],
  ])(
    "rejects %s instead of returning a guessed fixture interpretation",
    (_name, from, to) => {
      expect(() =>
        parseMipsReadelf(readelf.replace(from, to), "little"),
      ).toThrow();
    },
  );

  it("rejects ambiguous producer fields", () => {
    expect(() =>
      parseMipsReadelf(`${readelf}\nClass: ELF32\n`, "little"),
    ).toThrow(/ambiguous/u);
  });

  it("checks the effective loaded image, not requested profile metadata", () => {
    assertMipsLoadedImage(image, "little", sha256);
    expect(() =>
      assertMipsLoadedImage(
        { ...image, language_id: "MIPS:BE:32:default" },
        "little",
        sha256,
      ),
    ).toThrow();
    expect(() =>
      assertMipsLoadedImage(
        { ...image, compiler_spec_id: "other" },
        "little",
        sha256,
      ),
    ).toThrow();
    expect(() =>
      assertMipsLoadedImage(
        {
          ...image,
          source_files: [
            { original_sha256: sha256, modified_sha256: "b".repeat(64) },
          ],
        },
        "little",
        sha256,
      ),
    ).toThrow();
  });

  it("checks exact probe bytes, immediate and conditional destination in both orders", () => {
    assertMipsProbe(move, branch, "little", "0x20240");
    assertMipsProbe(
      { ...move, architecture: "MIPS:BE:32:default", bytes: "24821234" },
      { ...branch, architecture: "MIPS:BE:32:default", bytes: "10800003" },
      "big",
      "0x20240",
    );
  });

  it("rejects plausible nonempty but incorrect instruction observations", () => {
    expect(() =>
      assertMipsProbe(
        { ...move, bytes: "35128224" },
        branch,
        "little",
        "0x20240",
      ),
    ).toThrow();
    expect(() =>
      assertMipsProbe({ ...move, length: 2 }, branch, "little", "0x20240"),
    ).toThrow();
    expect(() =>
      assertMipsProbe(
        {
          ...move,
          operands: [
            { index: 2, components: [{ kind: "immediate", value: "0x1235" }] },
          ],
        },
        branch,
        "little",
        "0x20240",
      ),
    ).toThrow();
    expect(() =>
      assertMipsProbe(
        move,
        {
          ...branch,
          flow: { ...branch.flow, direct_destinations: ["0x20250"] },
        },
        "little",
        "0x20240",
      ),
    ).toThrow();
    expect(() =>
      assertMipsProbe(
        move,
        { ...branch, flow: { ...branch.flow, conditional: false } },
        "little",
        "0x20240",
      ),
    ).toThrow();
  });

  it("checks all four global bytes in the declared order", () => {
    assertMipsGlobal("07000000", "little");
    assertMipsGlobal("00000007", "big");
    expect(() => assertMipsGlobal("00000007", "little")).toThrow();
    expect(() => assertMipsGlobal("0700", "little")).toThrow();
  });
});
