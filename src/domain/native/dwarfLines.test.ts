import { describe, expect, it } from "vitest";
import {
  dwarfLinesSchema,
  formatDwarfLineAddress,
  inspectDwarfLinesInputSchema,
  type DwarfLinesReport,
} from "./dwarfLines.js";

const SAMPLE_SHA = "a".repeat(64);

const baseReport = (
  overrides: Partial<DwarfLinesReport> = {},
): DwarfLinesReport => ({
  artifact: {
    path: "/tmp/sample.elf",
    sha256: SAMPLE_SHA,
    bytes: 4096,
  },
  format: "elf",
  bits: 64,
  byte_order: "little",
  machine: 62,
  architecture: "x86_64",
  sections: [
    {
      name: ".debug_line",
      role: ".debug_line",
      offset: 256,
      size: 128,
      compression: "none",
      uncompressed_size: 128,
    },
  ],
  debug_line: "present",
  omissions: [],
  selected_program_offset: null,
  programs: [
    {
      index: 0,
      offset: 0,
      file_offset: 256,
      length: 64,
      offset_size: 4,
      version: 5,
      address_size: 8,
      segment_selector_size: 0,
      minimum_instruction_length: 1,
      maximum_operations_per_instruction: 1,
      default_is_stmt: true,
      line_base: -5,
      line_range: 14,
      opcode_base: 13,
      standard_opcode_lengths: [0, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 1],
      directories: [{ index: 0, path: { state: "present", value: "/src" } }],
      files: [
        {
          index: 0,
          name: { state: "present", value: "main.c" },
          directory_index: 0,
          directory: { state: "present", value: "/src" },
          path: { state: "present", value: "/src/main.c" },
          mtime: { state: "absent", value: null },
          size: { state: "absent", value: null },
          md5_hex: "0".repeat(32),
          source_present: false,
          defined_by_opcode: false,
        },
      ],
      sequences: [
        {
          sequence_index: 0,
          start_address: "0x1130",
          end_address: "0x1140",
          has_end_sequence: true,
          row_start: 0,
          row_count: 2,
        },
      ],
      total_rows: 2,
      retained_rows: 2,
      addresses_unresolved: false,
      issues: [],
    },
  ],
  total_programs: 1,
  rows: [
    {
      program_index: 0,
      sequence_index: 0,
      address: "0x1130",
      op_index: 0,
      file_index: 0,
      file: "/src/main.c",
      line: 3,
      column: 1,
      is_stmt: true,
      basic_block: false,
      end_sequence: false,
      prologue_end: true,
      epilogue_begin: false,
      isa: 0,
      discriminator: 0,
    },
    {
      program_index: 0,
      sequence_index: 0,
      address: "0x1140",
      op_index: 0,
      file_index: 0,
      file: "/src/main.c",
      line: 3,
      column: 1,
      is_stmt: true,
      basic_block: false,
      end_sequence: true,
      prologue_end: false,
      epilogue_begin: false,
      isa: 0,
      discriminator: 0,
    },
  ],
  total_rows: 2,
  address_matches: [],
  coverage: { status: "complete", reason: null },
  limitations: ["Target-derived paths are untrusted."],
  ...overrides,
});

describe("dwarfLines domain schema", () => {
  it("accepts a valid complete report and formats addresses canonically", () => {
    expect(dwarfLinesSchema.safeParse(baseReport()).success).toBe(true);
    expect(formatDwarfLineAddress(0x001130n)).toBe("0x1130");
    expect(formatDwarfLineAddress(0n)).toBe("0x0");
  });

  it("validates input defaults, distinct addresses, and max_rows=0", () => {
    const parsed = inspectDwarfLinesInputSchema.parse({
      path: "/tmp/sample.elf",
      max_rows: 0,
      addresses: ["0x1130", "0X1140"],
    });
    expect(parsed.max_programs).toBe(256);
    expect(parsed.max_rows).toBe(0);
    expect(parsed.addresses).toEqual(["0x1130", "0X1140"]);
    expect(
      inspectDwarfLinesInputSchema.safeParse({
        path: "relative.elf",
      }).success,
    ).toBe(false);
    expect(
      inspectDwarfLinesInputSchema.safeParse({
        path: "/tmp/sample.elf",
        addresses: ["0x1130", "0x1130"],
      }).success,
    ).toBe(false);
  });

  it("rejects mismatched coverage, absent/unreadable invariants, and out-of-range offsets", () => {
    expect(
      dwarfLinesSchema.safeParse(
        baseReport({ coverage: { status: "partial", reason: null } }),
      ).success,
    ).toBe(false);
    expect(
      dwarfLinesSchema.safeParse(
        baseReport({
          debug_line: "absent",
          sections: [],
        }),
      ).success,
    ).toBe(false);
    expect(
      dwarfLinesSchema.safeParse(
        baseReport({
          debug_line: "unreadable",
          sections: [],
          programs: [],
          total_programs: 0,
          rows: [],
          total_rows: 0,
          coverage: { status: "complete", reason: null },
        }),
      ).success,
    ).toBe(false);
    expect(
      dwarfLinesSchema.safeParse(
        baseReport({
          sections: [
            {
              name: ".zdebug_line",
              role: ".debug_line",
              offset: 256,
              size: 32,
              compression: "zlib",
              uncompressed_size: 128,
            },
          ],
        }),
      ).success,
    ).toBe(false);
  });
});
