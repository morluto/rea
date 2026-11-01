import { describe, expect, it } from "vitest";
import {
  dwarfLanguageName,
  dwarfUnitsSchema,
  inspectDwarfUnitsInputSchema,
} from "./dwarfUnits.js";

const absent = { state: "absent" as const, value: null };
const limitations = [
  "Child DIEs, types, line tables, and location expressions are not read.",
];

const report = {
  artifact: {
    path: "/artifacts/program",
    sha256: "a".repeat(64),
    bytes: 128,
  },
  format: "elf" as const,
  bits: 64 as const,
  byte_order: "little" as const,
  machine: 62,
  architecture: "x86_64" as const,
  sections: [],
  omissions: [
    {
      name: ".debug_info",
      reason: ".debug_info was not observed in this file",
    },
  ],
  units: [],
  total_units: 0,
  page: { offset: 0, limit: 32 },
  coverage: {
    status: "no_debug_info" as const,
    reason:
      "This file has no .debug_info section. That does not establish that a separate debug file is absent.",
  },
  limitations,
};

describe("DWARF compile-unit schema", () => {
  it("names DWARF 5 languages and leaves later codes unnamed", () => {
    expect(dwarfLanguageName(0x0c)).toBe("C99");
    expect(dwarfLanguageName(0x1c)).toBe("Rust");
    expect(dwarfLanguageName(0x0025)).toBe("BLISS");
    expect(dwarfLanguageName(0x26)).toBeNull();
  });

  it("accepts an absent-info report and applies paging defaults", () => {
    expect(dwarfUnitsSchema.parse(report)).toMatchObject({
      coverage: { status: "no_debug_info" },
      total_units: 0,
    });
    expect(
      inspectDwarfUnitsInputSchema.parse({ path: "/artifacts/program" }),
    ).toMatchObject({
      offset: 0,
      limit: 32,
      max_file_bytes: 67_108_864,
    });
    expect(
      inspectDwarfUnitsInputSchema.safeParse({
        path: "/artifacts/program",
        limit: 0,
      }).success,
    ).toBe(false);
    expect(
      inspectDwarfUnitsInputSchema.safeParse({
        path: "/artifacts/program",
        limit: 257,
      }).success,
    ).toBe(false);
  });

  it("rejects a debug section, a short page, and a file offset on compressed info", () => {
    expect(
      dwarfUnitsSchema.safeParse({
        ...report,
        sections: [
          {
            name: ".debug_info",
            role: ".debug_info",
            offset: 0,
            size: 4,
            compression: "none",
            uncompressed_size: 4,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      dwarfUnitsSchema.safeParse({
        ...report,
        coverage: { status: "complete", reason: null },
        total_units: 2,
        units: [],
      }).success,
    ).toBe(false);
    const info = {
      name: ".debug_info",
      role: ".debug_info" as const,
      offset: 16,
      size: 20,
      compression: "zlib" as const,
      uncompressed_size: 40,
    };
    const unit = {
      offset: 0,
      file_offset: 16,
      length: 8,
      version: 4,
      unit_type: null,
      address_size: 8,
      offset_size: 4 as const,
      abbrev_offset: 0,
      tag: 0x11,
      die_complete: true,
      name: absent,
      comp_dir: absent,
      producer: absent,
      dwo_name: absent,
      language: absent,
      language_name: null,
      stmt_list: absent,
      low_pc_present: false,
      issues: [],
    };
    expect(
      dwarfUnitsSchema.safeParse({
        ...report,
        sections: [info],
        omissions: [],
        units: [unit],
        total_units: 1,
        coverage: { status: "complete", reason: null },
      }).success,
    ).toBe(false);
    expect(
      dwarfUnitsSchema.safeParse({
        ...report,
        sections: [info],
        omissions: [],
        units: [{ ...unit, file_offset: null }],
        total_units: 1,
        coverage: { status: "complete", reason: null },
      }).success,
    ).toBe(true);
  });
});
