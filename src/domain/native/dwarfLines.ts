import { z } from "zod";

import {
  machoSelectionContainsRange,
  machoSliceArchitectureSchema,
  machoTargetSelectionSchema,
  selectedSliceAgreesWithReport,
} from "../apple/machoTargetSelection.js";
import { BINARY_ARCHITECTURES } from "../binaryTargetTypes.js";
import { coverageStatusSchema } from "../coverage.js";
import { digestSchema } from "../digests.js";
import { keyedBy, uniqueKeyed } from "../keyedCollection.js";
import {
  absoluteLocalPathStringSchema,
  localPathStringSchema,
} from "../localPath.js";
import { distinctItems } from "../schemaConstraints.js";
import { DWARF_DECOMPRESSED_SECTION_ALLOWANCE } from "./dwarfUnits.js";

export { DWARF_DECOMPRESSED_SECTION_ALLOWANCE };

/** Hard ceiling on the caller-selected input read budget (512 MiB). */
export const MAX_INSPECT_DWARF_LINES_FILE_BYTES = 536_870_912;
/** Hard ceiling on a caller-selected `.debug_line` program offset (256 MiB). */
export const MAX_DWARF_LINE_PROGRAM_OFFSET = 268_435_456;
/** Maximum distinct addresses requested for lookup in one call. */
export const MAX_INSPECT_DWARF_LINE_ADDRESSES = 64;
/** Default retained line-number programs per call. */
export const DEFAULT_INSPECT_DWARF_LINE_PROGRAMS = 256;
/** Hard ceiling on retained line-number programs per call. */
export const MAX_INSPECT_DWARF_LINE_PROGRAMS = 16_384;
/** Walk cap on `.debug_line` programs examined in one pass. */
export const MAX_DWARF_LINE_PROGRAMS_WALKED = 100_000;
/** Default emitted line-matrix rows retained inline. */
export const DEFAULT_INSPECT_DWARF_LINE_ROWS = 4_096;
/** Hard ceiling on emitted line-matrix rows retained inline. */
export const MAX_INSPECT_DWARF_LINE_ROWS = 65_536;
/** Aggregate state-machine opcode & header decoding steps per call. */
export const MAX_DWARF_LINE_PROGRAM_STEPS = 2_097_152;
/** Aggregate directory and file table entries admitted across all programs per call. */
export const MAX_DWARF_LINE_TOTAL_HEADER_ENTRIES = 262_144;
/** Maximum decoded string bytes retained across directory and file tables (16 MiB). */
export const MAX_DWARF_LINE_STRING_TABLE_BYTES = 16 * 1024 * 1024;
/** Maximum derived directory/file path and row-label characters retained across one call. */
export const MAX_DWARF_LINE_EXPANDED_STRING_CHARS = 16 * 1024 * 1024;
/** Maximum sequence summary entries retained across all programs in one call. */
export const MAX_DWARF_LINE_SEQUENCES = 65_536;
/** Maximum rows retained inside one sequence index for address attribution. */
export const MAX_DWARF_LINE_SEQUENCE_ROWS = 262_144;
/** Maximum address-match rows retained across all address queries in one call. */
export const MAX_DWARF_LINE_ADDRESS_MATCHES = 65_536;
/** Maximum issues retained on one line-number program. */
export const MAX_DWARF_LINE_PROGRAM_ISSUES = 32;
/** Maximum header directory or file entries per line-number program. */
export const MAX_DWARF_LINE_HEADER_ENTRIES = 65_536;
/** Maximum standard opcode length slots admitted in one header. */
export const MAX_DWARF_LINE_STANDARD_OPCODES = 255;
/** Maximum DWARF 5 directory or file format columns per header. */
export const MAX_DWARF_LINE_FORMAT_COLUMNS = 32;

export const DWARF_LINE_SECTION_ROLES = [
  ".debug_line",
  ".debug_line_str",
  ".debug_str",
  ".debug_str_offsets",
] as const;
export type DwarfLineSectionRole = (typeof DWARF_LINE_SECTION_ROLES)[number];

export const DWARF_LINE_ISSUE_CODES = [
  "truncated_header",
  "unsupported_version",
  "unsupported_address_size",
  "unsupported_segment_selector",
  "malformed_header",
  "malformed_opcode",
  "unknown_form",
  "unknown_content_type",
  "string_unresolved",
  "unapplied_relocation",
  "str_offsets_base_absent",
  "string_budget",
  "header_entry_budget",
  "decode_budget",
  "truncated_program",
  "end_sequence_missing",
  "value_out_of_range",
] as const;
export type DwarfLineIssueCode = (typeof DWARF_LINE_ISSUE_CODES)[number];

export const DWARF_LINE_LIMITATIONS = {
  targetDerived:
    "Directory names, file names, and line metadata are target-derived and untrusted.",
  childDiesOmitted:
    "Child DIEs, variable locations, and inline call-site DIEs (.debug_info) are not read.",
  externalDebugUnfollowed:
    "Separate .dwo, .gnu_debuglink, and build-id debug files are not opened automatically.",
  machoDsym:
    "A .dSYM bundle is not opened. Pass the DWARF file inside the bundle.",
  compressedOffsets:
    "Program offsets are within decompressed .debug_line and file_offset is null.",
  rowsOmittedByCaller:
    "Emitted line-matrix rows were omitted because max_rows was set to 0.",
  addressMatchesTruncated:
    "Address match entries were truncated at the 65,536-match output limit.",
  stringExpansionTruncated:
    "Derived directory/file path strings or row labels were truncated at the 16 MiB expansion budget.",
} as const;

const safeInt = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hexAddressSchema = z.string().regex(/^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/);
export const inputAddressHexSchema = z
  .string()
  .regex(/^0[xX][0-9a-fA-F]{1,16}$/);
const md5HexSchema = z.string().regex(/^[0-9a-f]{32}$/);

const attributeState = <Value extends z.ZodType>(value: Value) =>
  z
    .strictObject({
      state: z.enum(["absent", "present", "unknown", "unresolved"]),
      value: value.nullable(),
    })
    .superRefine((fact, context) => {
      const row = fact as {
        readonly state: "absent" | "present" | "unknown" | "unresolved";
        readonly value: unknown;
      };
      if ((row.state === "present") !== (row.value !== null))
        context.addIssue({
          code: "custom",
          message: "Attribute state does not match its value",
        });
    });

const stringFactSchema = attributeState(z.string());
const numberFactSchema = attributeState(safeInt);

const lineIssueSchema = z.strictObject({
  code: z.enum(DWARF_LINE_ISSUE_CODES),
  detail: z.string().min(1),
});

const lineDirectorySchema = z.strictObject({
  index: safeInt,
  path: stringFactSchema,
});

const lineFileSchema = z.strictObject({
  index: safeInt,
  name: stringFactSchema,
  directory_index: safeInt.nullable(),
  directory: stringFactSchema,
  path: stringFactSchema,
  mtime: numberFactSchema,
  size: numberFactSchema,
  md5_hex: md5HexSchema.nullable(),
  source_present: z.boolean(),
  defined_by_opcode: z.boolean(),
});

const lineSequenceSchema = z.strictObject({
  sequence_index: safeInt,
  start_address: hexAddressSchema.nullable(),
  end_address: hexAddressSchema.nullable(),
  has_end_sequence: z.boolean(),
  row_start: safeInt,
  row_count: safeInt,
});

export const dwarfLineProgramSchema = z.strictObject({
  index: safeInt,
  offset: safeInt,
  file_offset: safeInt.nullable(),
  length: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  offset_size: z.union([z.literal(4), z.literal(8)]),
  version: z.number().int().min(0).max(0xffff).nullable(),
  address_size: z.number().int().min(0).max(0xff).nullable(),
  segment_selector_size: z.number().int().min(0).max(0xff).nullable(),
  minimum_instruction_length: z.number().int().min(0).max(0xff).nullable(),
  maximum_operations_per_instruction: z
    .number()
    .int()
    .min(0)
    .max(0xff)
    .nullable(),
  default_is_stmt: z.boolean().nullable(),
  line_base: z.number().int().min(-128).max(127).nullable(),
  line_range: z.number().int().min(0).max(0xff).nullable(),
  opcode_base: z.number().int().min(0).max(0xff).nullable(),
  standard_opcode_lengths: z
    .array(z.number().int().min(0).max(0xff))
    .max(MAX_DWARF_LINE_STANDARD_OPCODES),
  directories: z.array(lineDirectorySchema),
  files: z.array(lineFileSchema),
  sequences: z.array(lineSequenceSchema),
  total_rows: safeInt,
  retained_rows: safeInt,
  addresses_unresolved: z.boolean(),
  issues: z.array(lineIssueSchema).max(MAX_DWARF_LINE_PROGRAM_ISSUES),
});

export const dwarfLineRowSchema = z.strictObject({
  program_index: safeInt,
  sequence_index: safeInt,
  address: hexAddressSchema,
  op_index: safeInt,
  file_index: safeInt,
  file: z.string().nullable(),
  line: z.number().int(),
  column: safeInt,
  is_stmt: z.boolean(),
  basic_block: z.boolean(),
  end_sequence: z.boolean(),
  prologue_end: z.boolean(),
  epilogue_begin: z.boolean(),
  isa: safeInt,
  discriminator: safeInt,
});

const addressMatchEntrySchema = z.strictObject({
  program_index: safeInt,
  program_offset: safeInt,
  sequence_index: safeInt,
  span_start: hexAddressSchema,
  span_end: hexAddressSchema.nullable(),
  exact: z.boolean(),
  address: hexAddressSchema,
  op_index: safeInt,
  file_index: safeInt,
  file: z.string().nullable(),
  directory: z.string().nullable(),
  path: z.string().nullable(),
  md5_hex: md5HexSchema.nullable(),
  line: z.number().int(),
  column: safeInt,
  is_stmt: z.boolean(),
  basic_block: z.boolean(),
  prologue_end: z.boolean(),
  epilogue_begin: z.boolean(),
  isa: safeInt,
  discriminator: safeInt,
});

export const dwarfLineAddressMatchSchema = z.strictObject({
  query_address: hexAddressSchema,
  status: z.enum([
    "resolved",
    "not_found",
    "unapplied_relocation",
    "incomplete",
  ]),
  matches: z.array(addressMatchEntrySchema),
});

const sectionSchema = z.strictObject({
  name: z.string().min(1),
  role: z.enum(DWARF_LINE_SECTION_ROLES),
  offset: safeInt,
  size: safeInt,
  compression: z.enum(["none", "zlib", "zstd"]),
  uncompressed_size: safeInt,
});

/** One explicit-file DWARF line-number program inspection. */
export const inspectDwarfLinesInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute filesystem path to an ELF, Mach-O, or PE image",
  ),
  max_file_bytes: z
    .number()
    .int()
    .min(64)
    .max(MAX_INSPECT_DWARF_LINES_FILE_BYTES)
    .default(67_108_864)
    .describe("Maximum stable artifact bytes to read (default 64 MiB)"),
  program_offset: z
    .number()
    .int()
    .min(0)
    .max(MAX_DWARF_LINE_PROGRAM_OFFSET)
    .exactOptional()
    .describe(
      "Optional byte offset inside decompressed .debug_line (such as a DW_AT_stmt_list value) to inspect one line-number program",
    ),
  addresses: distinctItems(
    z.array(inputAddressHexSchema).min(1).max(MAX_INSPECT_DWARF_LINE_ADDRESSES),
    "Addresses must be unique",
  )
    .exactOptional()
    .describe(
      "Optional virtual addresses (0x...) to resolve against decoded line sequences",
    ),
  max_programs: z
    .number()
    .int()
    .min(1)
    .max(MAX_INSPECT_DWARF_LINE_PROGRAMS)
    .default(DEFAULT_INSPECT_DWARF_LINE_PROGRAMS)
    .describe("Maximum line-number programs to retain in the result"),
  max_rows: z
    .number()
    .int()
    .min(0)
    .max(MAX_INSPECT_DWARF_LINE_ROWS)
    .default(DEFAULT_INSPECT_DWARF_LINE_ROWS)
    .describe(
      "Maximum emitted line-matrix rows to retain inline (0 retains programs, file tables, and address lookups without row entries)",
    ),
  architecture: machoSliceArchitectureSchema
    .exactOptional()
    .describe(
      "CPU family of the slice to read from a universal Mach-O. Required for universal files and rejected for every other image.",
    ),
});

export const dwarfLinesReportSchema = z.strictObject({
  artifact: z.strictObject({
    path: localPathStringSchema,
    sha256: digestSchema,
    bytes: safeInt,
  }),
  format: z.enum(["elf", "pe", "macho"]),
  bits: z.union([z.literal(32), z.literal(64)]),
  byte_order: z.enum(["little", "big"]),
  machine: z.number().int().min(0).max(0xffffffff).nullable(),
  architecture: z.enum(BINARY_ARCHITECTURES).nullable(),
  selected_slice: machoTargetSelectionSchema.exactOptional(),
  sections: z.array(sectionSchema),
  debug_line: z
    .enum(["present", "absent", "unreadable"])
    .describe(
      "absent when this file declares no file-backed .debug_line; unreadable when a declared section could not be decoded",
    ),
  omissions: z.array(
    z.strictObject({
      name: z.string().min(1),
      reason: z.string().min(1),
    }),
  ),
  selected_program_offset: safeInt.nullable(),
  programs: z
    .array(dwarfLineProgramSchema)
    .max(MAX_INSPECT_DWARF_LINE_PROGRAMS),
  total_programs: safeInt,
  rows: z.array(dwarfLineRowSchema).max(MAX_INSPECT_DWARF_LINE_ROWS),
  total_rows: safeInt,
  address_matches: z
    .array(dwarfLineAddressMatchSchema)
    .max(MAX_INSPECT_DWARF_LINE_ADDRESSES),
  coverage: z.strictObject({
    status: coverageStatusSchema,
    reason: z.string().nullable(),
  }),
  limitations: z.array(z.string().min(1)).min(1),
});

export const dwarfLinesSchema = dwarfLinesReportSchema.superRefine(
  (report, context) => {
    const debugLine = uniqueKeyed(
      keyedBy(report.sections, (section) => section.role),
      ".debug_line",
    );
    if (!debugLine.ok)
      context.addIssue({
        code: "custom",
        path: ["sections"],
        message: "A report names at most one .debug_line section",
      });
    const lineSection = debugLine.ok ? debugLine.value : undefined;
    if (
      report.coverage.status !== "complete" &&
      report.coverage.reason === null
    )
      context.addIssue({
        code: "custom",
        path: ["coverage"],
        message: "Incomplete coverage requires a reason",
      });
    if (
      report.coverage.status === "complete" &&
      report.coverage.reason !== null
    )
      context.addIssue({
        code: "custom",
        path: ["coverage"],
        message: "Complete coverage has no stop reason",
      });
    if (report.debug_line === "absent") {
      if (
        report.coverage.status !== "complete" ||
        report.total_programs !== 0 ||
        report.programs.length !== 0 ||
        report.total_rows !== 0 ||
        report.rows.length !== 0 ||
        lineSection !== undefined
      )
        context.addIssue({
          code: "custom",
          path: ["debug_line"],
          message:
            "Absent .debug_line must be complete with no .debug_line section, programs, or rows",
        });
    }
    if (report.debug_line === "unreadable") {
      if (
        report.coverage.status !== "partial" ||
        report.total_programs !== 0 ||
        report.programs.length !== 0 ||
        report.total_rows !== 0 ||
        report.rows.length !== 0 ||
        lineSection !== undefined
      )
        context.addIssue({
          code: "custom",
          path: ["debug_line"],
          message:
            "Unreadable .debug_line must report partial coverage with no decoded programs or rows",
        });
    }
    if (report.debug_line === "present" && lineSection === undefined) {
      context.addIssue({
        code: "custom",
        path: ["debug_line"],
        message: "Present .debug_line requires a .debug_line section entry",
      });
    }
    const slice = report.selected_slice;
    if (
      slice !== undefined &&
      !selectedSliceAgreesWithReport(
        slice,
        report.format,
        report.architecture ?? undefined,
      )
    )
      context.addIssue({
        code: "custom",
        path: ["selected_slice"],
        message: "Selected Mach-O slice does not agree with the report",
      });
    for (const section of report.sections) {
      if (section.offset + section.size > report.artifact.bytes)
        context.addIssue({
          code: "custom",
          path: ["sections"],
          message: "Section range is outside the artifact",
        });
      if (
        section.compression === "none" &&
        section.uncompressed_size !== section.size
      )
        context.addIssue({
          code: "custom",
          path: ["sections"],
          message: "An uncompressed section changed size",
        });
      if (
        slice !== undefined &&
        !machoSelectionContainsRange(
          slice,
          report.artifact.bytes,
          section.offset,
          section.size,
        )
      )
        context.addIssue({
          code: "custom",
          path: ["sections"],
          message: "Section range is outside the selected Mach-O slice",
        });
    }
    if (lineSection === undefined) return;
    for (const program of report.programs) {
      if (program.offset + program.length > lineSection.uncompressed_size)
        context.addIssue({
          code: "custom",
          path: ["programs"],
          message: "Program range is outside decompressed .debug_line",
        });
      if (lineSection.compression === "none") {
        if (program.file_offset !== lineSection.offset + program.offset)
          context.addIssue({
            code: "custom",
            path: ["programs"],
            message: "Program file_offset does not match .debug_line",
          });
      } else if (program.file_offset !== null)
        context.addIssue({
          code: "custom",
          path: ["programs"],
          message: "Compressed .debug_line has no per-program file_offset",
        });
      if (
        program.file_offset !== null &&
        (program.file_offset + program.length > report.artifact.bytes ||
          (slice !== undefined &&
            !machoSelectionContainsRange(
              slice,
              report.artifact.bytes,
              program.file_offset,
              program.length,
            )))
      )
        context.addIssue({
          code: "custom",
          path: ["programs"],
          message: "Program file range is outside the artifact",
        });
    }
    for (const row of report.rows) {
      if (row.program_index >= report.programs.length)
        context.addIssue({
          code: "custom",
          path: ["rows"],
          message: "Line row program_index does not match retained programs",
        });
    }
  },
);

export type InspectDwarfLinesInput = z.infer<
  typeof inspectDwarfLinesInputSchema
>;
export type DwarfLinesReport = z.infer<typeof dwarfLinesSchema>;
export type DwarfLineProgram = DwarfLinesReport["programs"][number];
export type DwarfLineDirectory = DwarfLineProgram["directories"][number];
export type DwarfLineFile = DwarfLineProgram["files"][number];
export type DwarfLineSequence = DwarfLineProgram["sequences"][number];
export type DwarfLineRow = DwarfLinesReport["rows"][number];
export type DwarfLineAddressMatch = DwarfLinesReport["address_matches"][number];
export type DwarfLineStringFact = DwarfLineFile["name"];
export type DwarfLineNumberFact = DwarfLineFile["mtime"];
export type DwarfLineIssue = DwarfLineProgram["issues"][number];

/** Canonical lowercase 0x... representation from an admitted hex string or bigint. */
export const formatDwarfLineAddress = (value: bigint): string =>
  `0x${value.toString(16)}`;
