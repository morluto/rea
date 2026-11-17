import { describe, expect, it } from "vitest";
import { projectAnalysisView } from "./analysisView.js";
import { createEvidence } from "../evidence.js";
import { DWARF_LINES_PROVIDER } from "../investigationProviders.js";
import type { DwarfLinesReport } from "../native/dwarfLines.js";

const sampleReport: DwarfLinesReport = {
  artifact: {
    path: "/tmp/app",
    sha256: "b".repeat(64),
    bytes: 512,
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
      offset: 64,
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
      file_offset: 64,
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
          md5_hex: "0123456789abcdef0123456789abcdef",
          source_present: false,
          defined_by_opcode: false,
        },
        {
          index: 1,
          name: { state: "present", value: "util.c" },
          directory_index: 0,
          directory: { state: "present", value: "/src" },
          path: { state: "present", value: "/src/util.c" },
          mtime: { state: "absent", value: null },
          size: { state: "absent", value: null },
          md5_hex: "fedcba9876543210fedcba9876543210",
          source_present: false,
          defined_by_opcode: false,
        },
      ],
      sequences: [
        {
          sequence_index: 0,
          start_address: "0x1000",
          end_address: "0x1010",
          has_end_sequence: true,
          row_start: 0,
          row_count: 2,
        },
      ],
      total_rows: 2,
      retained_rows: 2,
      addresses_unresolved: false,
      issues: [{ code: "end_sequence_missing", detail: "test note" }],
    },
  ],
  total_programs: 1,
  rows: [
    {
      program_index: 0,
      sequence_index: 0,
      address: "0x1000",
      op_index: 0,
      file_index: 0,
      file: "/src/main.c",
      line: 10,
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
      address: "0x1010",
      op_index: 0,
      file_index: 1,
      file: "/src/util.c",
      line: 20,
      column: 2,
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
  address_matches: [
    {
      query_address: "0x1004",
      status: "resolved",
      matches: [
        {
          program_index: 0,
          program_offset: 0,
          sequence_index: 0,
          span_start: "0x1000",
          span_end: "0x1010",
          exact: false,
          address: "0x1000",
          op_index: 0,
          file_index: 0,
          file: "main.c",
          directory: "/src",
          path: "/src/main.c",
          md5_hex: "0123456789abcdef0123456789abcdef",
          line: 10,
          column: 1,
          is_stmt: true,
          basic_block: false,
          prologue_end: true,
          epilogue_begin: false,
          isa: 0,
          discriminator: 0,
        },
      ],
    },
  ],
  coverage: { status: "complete", reason: null },
  limitations: ["target-derived"],
};

describe("dwarfLinesView", () => {
  const parentEvidence = createEvidence(
    {
      path: sampleReport.artifact.path,
      format: "elf",
      sha256: sampleReport.artifact.sha256,
      architecture: "x86_64",
    },
    DWARF_LINES_PROVIDER,
    {
      operation: "inspect_dwarf_lines",
      parameters: { path: sampleReport.artifact.path, addresses: ["0x1004"] },
      result: sampleReport,
      confidence: "observed",
      limitations: sampleReport.limitations,
      locations: [{ kind: "artifact-path", path: sampleReport.artifact.path }],
    },
  );

  it("projects summary and all collections with exact source_index and field selection", () => {
    const parent = {
      evidenceId: parentEvidence.evidence_id,
      operation: parentEvidence.operation,
      predicateType: parentEvidence.predicate_type,
      normalizedResult: parentEvidence.normalized_result,
      limitations: parentEvidence.limitations,
    };

    const summary = projectAnalysisView(parent, { kind: "summary" });
    if (!summary.ok) throw summary.error;
    expect(summary.value).toMatchObject({
      kind: "summary",
      summary: {
        program_count: 1,
        directory_count: 1,
        file_count: 2,
        row_count: 2,
        address_match_count: 1,
        issue_count: 1,
      },
    });

    const files = projectAnalysisView(parent, {
      kind: "dwarf-lines",
      collection: "files",
      md5_hex: "fedcba9876543210fedcba9876543210",
      offset: 0,
      limit: 10,
    });
    if (!files.ok) throw files.error;
    expect(files.value).toMatchObject({
      kind: "dwarf-lines",
      items: [{ source_index: 1, program_index: 0, index: 1 }],
      coverage: { examined: 1, total: 1, exhausted: true },
    });

    const rows = projectAnalysisView(parent, {
      kind: "dwarf-lines",
      collection: "rows",
      indices: [1],
      fields: ["address", "line"],
      offset: 0,
      limit: 10,
    });
    if (!rows.ok) throw rows.error;
    expect(rows.value).toMatchObject({
      items: [{ source_index: 1, address: "0x1010", line: 20 }],
    });

    const matches = projectAnalysisView(parent, {
      kind: "dwarf-lines",
      collection: "address_matches",
      status: "resolved",
      query_address: "0x0000000000001004",
      offset: 0,
      limit: 10,
    });
    if (!matches.ok) throw matches.error;
    expect(matches.value).toMatchObject({
      items: [{ source_index: 0, query_address: "0x1004", status: "resolved" }],
    });

    const upperMatches = projectAnalysisView(parent, {
      kind: "dwarf-lines",
      collection: "address_matches",
      query_address: "0X001004",
      offset: 0,
      limit: 10,
    });
    if (!upperMatches.ok) throw upperMatches.error;
    expect(upperMatches.value).toMatchObject({
      items: [{ source_index: 0, query_address: "0x1004", status: "resolved" }],
    });

    const invalidQuery = projectAnalysisView(parent, {
      kind: "dwarf-lines",
      collection: "address_matches",
      query_address: "not-hex",
      offset: 0,
      limit: 10,
    });
    expect(invalidQuery.ok).toBe(false);

    const issues = projectAnalysisView(parent, {
      kind: "dwarf-lines",
      collection: "issues",
      code: "end_sequence_missing",
      offset: 0,
      limit: 10,
    });
    if (!issues.ok) throw issues.error;
    expect(issues.value).toMatchObject({
      items: [
        { source_index: 0, program_index: 0, code: "end_sequence_missing" },
      ],
    });
  });
});
