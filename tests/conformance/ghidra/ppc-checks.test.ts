import { describe, expect, it } from "vitest";
import {
  assertPowerPc64EntryPair,
  assertPowerPc64Global,
  assertPowerPc64LoadedImage,
  assertPowerPc64Probe,
  assertPowerPcGlobal,
  assertPowerPcLoadedImage,
  assertPowerPcProbe,
  parsePowerPc64Readelf,
  parsePowerPcReadelf,
} from "./ppc-checks.mjs";

// GNU readelf 2.47 output for the source-owned Clang 23 / LLD fixture.
// This tests the reader boundary, not Ghidra; the real lane rebuilds it.
const readelf = `ELF Header:
  Magic:   7f 45 4c 46 01 02 01 00 00 00 00 00 00 00 00 00
  Class:                             ELF32
  Data:                              2's complement, big endian
  Version:                           1 (current)
  OS/ABI:                            UNIX - System V
  ABI Version:                       0
  Type:                              EXEC (Executable file)
  Machine:                           PowerPC
  Version:                           0x1
  Entry point address:               0x100101b0
  Start of program headers:          52 (bytes into file)
  Start of section headers:          2188 (bytes into file)
  Flags:                             0x0
  Size of this header:               52 (bytes)
  Size of program headers:           32 (bytes)
  Number of program headers:         6
  Size of section headers:           40 (bytes)
  Number of section headers:         18
  Section header string table index: 16

Symbol table '.symtab' contains 7 entries:
   Num:    Value  Size Type    Bind   Vis      Ndx Name
     0: 00000000     0 NOTYPE  LOCAL  DEFAULT  UND
     1: 00000000     0 FILE    LOCAL  DEFAULT  ABS ppc.c
     2: 10010180    48 FUNC    GLOBAL DEFAULT    4 rea_ppc_leaf
     3: 1002023c     4 OBJECT  GLOBAL DEFAULT    5 rea_ppc_global
     4: 100101b0   116 FUNC    GLOBAL DEFAULT    4 rea_ppc_entry
     5: 100000f4    29 OBJECT  GLOBAL DEFAULT    1 rea_ppc_marker
     6: 10010224    24 FUNC    GLOBAL DEFAULT    4 rea_ppc_probe
`;
const sha256 = "a".repeat(64);
const image = {
  language_id: "PowerPC:BE:32:default",
  compiler_spec_id: "default",
  source_files: [{ original_sha256: sha256, modified_sha256: sha256 }],
};
const move = {
  address: "0x10010224",
  status: "decoded",
  architecture: "PowerPC:BE:32:default",
  length: 4,
  bytes: "38641234",
  mnemonic: "addi",
  operands: [
    { index: 2, components: [{ kind: "immediate", value: "0x1234" }] },
  ],
};
const branch = {
  address: "0x1001022c",
  status: "decoded",
  architecture: "PowerPC:BE:32:default",
  length: 4,
  bytes: "41820008",
  mnemonic: "beq",
  flow: {
    kind: "jump",
    conditional: true,
    computed: false,
    direct_destinations: ["0x10010234"],
  },
};

describe("PowerPC real-verifier independent expectations", () => {
  it("reads GNU header and defined symbols without a Ghidra-derived oracle", () => {
    const parsed = parsePowerPcReadelf(readelf);
    expect(parsed.powerpc).toEqual({
      elfClass: 32,
      byteOrder: "big",
      type: 2,
      flags: 0,
    });
    expect(parsed.symbols.rea_ppc_probe).toBe("0x10010224");
  });

  it.each([
    ["wrong class", "ELF32", "ELF64"],
    ["wrong byte order", "big endian", "little endian"],
    [
      "wrong machine",
      "Machine:                           PowerPC",
      "Machine: PowerPC64",
    ],
    ["wrong object type", "EXEC (Executable file)", "DYN (Shared object file)"],
    [
      "wrong flags",
      "Flags:                             0x0",
      "Flags: 0x80000000",
    ],
    ["missing symbol", "rea_ppc_probe", "unrelated_probe"],
  ])(
    "rejects %s instead of returning a guessed fixture interpretation",
    (_name, from, to) => {
      expect(() => parsePowerPcReadelf(readelf.replace(from, to))).toThrow();
    },
  );

  it("rejects ambiguous producer fields", () => {
    expect(() => parsePowerPcReadelf(`${readelf}\nClass: ELF32\n`)).toThrow(
      /ambiguous/u,
    );
  });

  it("checks the effective loaded image, including Ghidra's e500 default", () => {
    assertPowerPcLoadedImage(image, sha256);
    expect(() =>
      assertPowerPcLoadedImage(
        { ...image, language_id: "PowerPC:BE:32:e500" },
        sha256,
      ),
    ).toThrow();
    expect(() =>
      assertPowerPcLoadedImage(
        { ...image, compiler_spec_id: "macosx" },
        sha256,
      ),
    ).toThrow();
    expect(() =>
      assertPowerPcLoadedImage(
        {
          ...image,
          source_files: [
            { original_sha256: sha256, modified_sha256: "b".repeat(64) },
          ],
        },
        sha256,
      ),
    ).toThrow();
  });

  it("checks exact probe bytes, immediate and conditional destination", () => {
    assertPowerPcProbe(move, branch, "0x10010224");
  });

  it("rejects plausible nonempty but incorrect instruction observations", () => {
    expect(() =>
      assertPowerPcProbe({ ...move, bytes: "38641235" }, branch, "0x10010224"),
    ).toThrow();
    expect(() =>
      assertPowerPcProbe({ ...move, length: 2 }, branch, "0x10010224"),
    ).toThrow();
    expect(() =>
      assertPowerPcProbe(
        {
          ...move,
          operands: [
            { index: 2, components: [{ kind: "immediate", value: "0x1235" }] },
          ],
        },
        branch,
        "0x10010224",
      ),
    ).toThrow();
    expect(() =>
      assertPowerPcProbe(
        move,
        {
          ...branch,
          flow: { ...branch.flow, direct_destinations: ["0x10010230"] },
        },
        "0x10010224",
      ),
    ).toThrow();
    expect(() =>
      assertPowerPcProbe(
        move,
        { ...branch, flow: { ...branch.flow, conditional: false } },
        "0x10010224",
      ),
    ).toThrow();
  });

  it("checks the big-endian global word", () => {
    assertPowerPcGlobal("00000007");
    expect(() => assertPowerPcGlobal("07000000")).toThrow();
  });
});

// GNU readelf 2.42 output for the little-endian Clang 18 / LLD PPC64 fixture.
const readelf64 = `ELF Header:
  Magic:   7f 45 4c 46 02 01 01 00 00 00 00 00 00 00 00 00
  Class:                             ELF64
  Data:                              2's complement, little endian
  Version:                           1 (current)
  OS/ABI:                            UNIX - System V
  ABI Version:                       0
  Type:                              EXEC (Executable file)
  Machine:                           PowerPC64
  Version:                           0x1
  Entry point address:               0x100102d0
  Start of program headers:          64 (bytes into file)
  Start of section headers:          3328 (bytes into file)
  Flags:                             0x2, abiv2
  Size of this header:               64 (bytes)
  Size of program headers:           56 (bytes)
  Number of program headers:         8
  Size of section headers:           64 (bytes)
  Number of section headers:         21
  Section header string table index: 19

Symbol table '.symtab' contains 8 entries:
   Num:    Value          Size Type    Bind   Vis      Ndx Name
     0: 0000000000000000     0 NOTYPE  LOCAL  DEFAULT  UND
     1: 0000000000000000     0 FILE    LOCAL  DEFAULT  ABS ppc64.c
     2: 0000000010028378     0 NOTYPE  LOCAL  HIDDEN     5 .TOC.
     3: 0000000010010290    52 FUNC    GLOBAL DEFAULT [<localentry>: 8]     4 rea_ppc64_leaf
     4: 0000000010030380     8 OBJECT  GLOBAL DEFAULT    7 rea_ppc64_global
     5: 00000000100102d0   136 FUNC    GLOBAL DEFAULT [<localentry>: 8]     4 rea_ppc64_entry
     6: 0000000010000200    31 OBJECT  GLOBAL DEFAULT    1 rea_ppc64_marker
     7: 0000000010010358    28 FUNC    GLOBAL DEFAULT    4 rea_ppc64_probe
`;
const LE64 = "PowerPC:LE:64:A2ALT";
const probe64 = "0x10010358";
const decoded = (address: string, bytes: string, mnemonic: string) => ({
  address,
  status: "decoded",
  architecture: LE64,
  length: 4,
  bytes,
  mnemonic,
});
const move64 = {
  ...decoded("0x10010358", "34126438", "addi"),
  operands: [
    { index: 2, components: [{ kind: "immediate", value: "0x1234" }] },
  ],
};
const branch64 = {
  ...decoded("0x10010360", "0c008241", "beq"),
  flow: {
    kind: "jump",
    conditional: true,
    computed: false,
    direct_destinations: ["0x1001036c"],
  },
};
const vector64 = decoded("0x10010364", "901401f0", "xxlor");
const dossier = (address: string, thunk: boolean, target: string | null) => ({
  procedure: {
    address,
    classification: { thunk, thunk_target: target },
  },
  pseudocode: "uint _rea_ppc64_entry(uint selector) { }",
});
const pair = { global: "0x100102d0", local: "0x100102d8" };

describe("PPC64 real-verifier independent expectations", () => {
  it("reads the ELFv2 header, symbols and local entries from GNU readelf", () => {
    const parsed = parsePowerPc64Readelf(readelf64, "little");
    expect(parsed.powerpc).toEqual({
      elfClass: 64,
      byteOrder: "little",
      type: 2,
      flags: 2,
    });
    expect(parsed.symbols.rea_ppc64_probe).toBe(probe64);
    expect(parsed.localEntries).toEqual({
      rea_ppc64_entry: "0x100102d8",
      rea_ppc64_leaf: "0x10010298",
    });
  });

  it.each([
    ["wrong byte order", "little endian", "big endian"],
    ["wrong machine", "PowerPC64", "PowerPC"],
    ["ELFv1 flags", "0x2, abiv2", "0x1, abiv1"],
    ["shared object", "EXEC (Executable file)", "DYN (Shared object file)"],
    [
      "missing local entry",
      "DEFAULT [<localentry>: 8]     4 rea_ppc64_entry",
      "DEFAULT    4 rea_ppc64_entry",
    ],
  ])(
    "rejects %s instead of returning a guessed fixture interpretation",
    (_name, from, to) => {
      expect(() =>
        parsePowerPc64Readelf(readelf64.replace(from, to), "little"),
      ).toThrow();
    },
  );

  it("checks the Power ISA language Ghidra actually loaded", () => {
    const image64 = { ...image, language_id: LE64 };
    assertPowerPc64LoadedImage(image64, sha256, "little");
    expect(() =>
      assertPowerPc64LoadedImage(
        { ...image64, language_id: "PowerPC:LE:64:default" },
        sha256,
        "little",
      ),
    ).toThrow();
    expect(() => assertPowerPc64LoadedImage(image64, sha256, "big")).toThrow();
  });

  it("checks probe words in file byte order, including the VSX instruction", () => {
    assertPowerPc64Probe(
      { move: move64, branch: branch64, vector: vector64 },
      probe64,
      "little",
    );
    // The same words in big-endian order are a different encoding.
    expect(() =>
      assertPowerPc64Probe(
        {
          move: { ...move64, bytes: "38641234" },
          branch: branch64,
          vector: vector64,
        },
        probe64,
        "little",
      ),
    ).toThrow();
  });

  it("rejects a VSX word the language did not decode", () => {
    expect(() =>
      assertPowerPc64Probe(
        {
          move: move64,
          branch: branch64,
          vector: {
            address: "0x10010364",
            status: "not-in-listing",
            mnemonic: null,
            bytes: null,
          },
        },
        probe64,
        "little",
      ),
    ).toThrow();
  });

  it("checks the global doubleword in each byte order", () => {
    assertPowerPc64Global("0807060504030201", "little");
    assertPowerPc64Global("0102030405060708", "big");
    expect(() => assertPowerPc64Global("0102030405060708", "little")).toThrow();
  });

  it("requires the global entry to be a thunk to the local-entry body", () => {
    assertPowerPc64EntryPair(
      dossier(pair.global, true, pair.local),
      dossier(pair.local, false, null),
      pair,
    );
    expect(() =>
      assertPowerPc64EntryPair(
        dossier(pair.global, false, null),
        dossier(pair.local, false, null),
        pair,
      ),
    ).toThrow();
    expect(() =>
      assertPowerPc64EntryPair(
        dossier(pair.global, true, "0x100102d4"),
        dossier(pair.local, false, null),
        pair,
      ),
    ).toThrow();
  });
});
