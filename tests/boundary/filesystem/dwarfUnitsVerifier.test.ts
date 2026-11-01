import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { importVerifierSource } from "../../../scripts/lib/verifier-source-loader.mjs";
import { parseDumperUnits } from "../../../scripts/verify-dwarf-units.mjs";

describe("DWARF dumper comparison", () => {
  it("reads readelf units when Version is on the next line", () => {
    const text = `
  Compilation Unit @ offset 0x0:
   Length:        0x4a (32-bit)
   Version:       4
   Abbrev Offset: 0x0
   Pointer Size:  8
 <0><b>: Abbrev Number: 1 (DW_TAG_compile_unit)
    <c>   DW_AT_producer    : (indirect string, offset: 0x0): clang version 17 https://x
    <11>   DW_AT_name        : alpha.c
    <15>   DW_AT_comp_dir    : (indirect line string, offset: 0x0): /tmp/two:words
    <19>   DW_AT_GNU_dwo_name: (indirect string, offset: 0x12): alpha.dwo
    <1d>   DW_AT_GNU_dwo_id  : 0xabcdef
  Compilation Unit @ offset 0x4e:
   Length:        0x30 (32-bit)
   Version:       5
 <0><5a>: Abbrev Number: 1 (DW_TAG_compile_unit)
    <5b>   DW_AT_producer    : clang version 17
    <5f>   DW_AT_name        : beta.c
    <63>   DW_AT_comp_dir    : /src
    <67>   DW_AT_dwo_name    : beta.dwo
`;
    expect(parseDumperUnits(text)).toEqual([
      {
        version: 4,
        name: "alpha.c",
        comp_dir: "/tmp/two:words",
        producer: "clang version 17 https://x",
        dwo_name: "alpha.dwo",
      },
      {
        version: 5,
        name: "beta.c",
        comp_dir: "/src",
        producer: "clang version 17",
        dwo_name: "beta.dwo",
      },
    ]);
  });

  it("keeps an llvm-dwarfdump unit whose version shares the header line", () => {
    const text = `
0x00000000: Compile Unit: length = 0x0000002b, format = DWARF32, version = 0x0004, abbr_offset = 0x0000, addr_size = 0x08 (next unit at 0x0000002f)

0x0000000b: DW_TAG_compile_unit
              DW_AT_producer	("clang version 17.0.0")
              DW_AT_name	("alpha.c")
              DW_AT_comp_dir	("/src/project")
              DW_AT_GNU_dwo_name	("alpha.dwo")
`;
    expect(parseDumperUnits(text)).toEqual([
      {
        version: 4,
        name: "alpha.c",
        comp_dir: "/src/project",
        producer: "clang version 17.0.0",
        dwo_name: "alpha.dwo",
      },
    ]);
  });

  it.each([
    `Compilation Unit @ offset 0x0:
     Version: 4
 <0><b>: Abbrev Number: 1 (DW_TAG_compile_unit)
 <1><c>: Abbrev Number: 2 (DW_TAG_subprogram)
    <d> DW_AT_name : child`,
    `0x00000000: Compile Unit: version = 0x0004
0x0000000b: DW_TAG_compile_unit
0x0000000c: DW_TAG_subprogram
              DW_AT_name ("child")`,
  ])("keeps an unnamed unit separate from child attributes: %s", (text) => {
    expect(parseDumperUnits(text)).toEqual([
      {
        version: 4,
        name: null,
        comp_dir: null,
        producer: null,
        dwo_name: null,
      },
    ]);
  });

  it("reads readelf indexed strings and ignores unit markers inside values", () => {
    expect(
      parseDumperUnits(
        [
          "  Compilation Unit @ offset 0x0:",
          "   Version:       5",
          " <0><c>: Abbrev Number: 1 (DW_TAG_compile_unit)",
          "    <d>   DW_AT_producer    : (indexed string: 0x0): My Compilation Unit @ tool",
          "    <e>   DW_AT_name        : (indexed string: 0x1): alpha.c",
        ].join("\n"),
      ),
    ).toEqual([
      {
        version: 5,
        name: "alpha.c",
        comp_dir: null,
        producer: "My Compilation Unit @ tool",
        dwo_name: null,
      },
    ]);
    expect(
      parseDumperUnits(
        [
          "0x00000000: Compile Unit: length = 0x2b, format = DWARF32, version = 0x0005",
          "0x0000000b: DW_TAG_compile_unit",
          '              DW_AT_producer\t("My Compile Unit: tool")',
          '              DW_AT_name\t("alpha.c")',
        ].join("\n"),
      ),
    ).toHaveLength(1);
  });

  it("loads verify:dwarf-units through the single verifier source loader", async () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      readonly scripts: Readonly<Record<string, string>>;
    };
    expect(pkg.scripts["verify:dwarf-units"]).toBe(
      "node scripts/verify-dwarf-units.mjs",
    );
    const module = await importVerifierSource(
      "../src/composition/binaryDiagnostics.ts",
      new URL("../../../scripts/verify-dwarf-units.mjs", import.meta.url).href,
    );
    expect(module.createDwarfUnitsService).toBeTypeOf("function");
  });
});
