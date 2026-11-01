import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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
    <c>   DW_AT_producer    : (indirect string, offset: 0x0): GNU C17 13.2.0 -mtune=generic
    <11>   DW_AT_name        : alpha.c
    <15>   DW_AT_comp_dir    : /tmp/two words
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
        comp_dir: "/tmp/two words",
        producer: "GNU C17 13.2.0 -mtune=generic",
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

  it("loads verify:dwarf-units through the single verifier source loader", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      readonly scripts: Readonly<Record<string, string>>;
    };
    expect(pkg.scripts["verify:dwarf-units"]).toBe(
      "node scripts/verify-dwarf-units.mjs",
    );
    const source = readFileSync("scripts/verify-dwarf-units.mjs", "utf8");
    expect(source).toContain('from "./lib/verifier-source-loader.mjs"');
    expect(source).not.toContain("tsx");
    const record = readFileSync(
      "docs/verification/dwarf-units-2026-10-31.md",
      "utf8",
    );
    expect(record).toContain(pkg.scripts["verify:dwarf-units"]);
    expect(record).not.toContain("tsx");
  });
});
