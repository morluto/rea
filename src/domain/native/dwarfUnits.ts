import { z } from "zod";

import {
  machoSelectionContainsRange,
  machoSliceArchitectureSchema,
  machoTargetSelectionSchema,
  selectedSliceAgreesWithReport,
} from "../apple/machoTargetSelection.js";
import { BINARY_ARCHITECTURES } from "../binaryTargetTypes.js";
import { digestSchema } from "../digests.js";
import { localPathStringSchema } from "../localPath.js";

/** Hard ceiling on the caller-selected input read budget. */
export const MAX_INSPECT_DWARF_UNITS_FILE_BYTES = 536870912;
/** Hard ceiling on decompressed DWARF debug bytes for one image. */
export const MAX_DWARF_DECOMPRESSED_SECTION_BYTES = 268435456;
/** Display name of that fixed decompressed-section allowance. */
export const DWARF_DECOMPRESSED_SECTION_ALLOWANCE =
  "The DWARF decompressed section allowance";
/** Maximum compile-unit rows returned in one call. */
export const MAX_INSPECT_DWARF_UNITS_LIMIT = 256;
/** Default page size. */
export const DEFAULT_INSPECT_DWARF_UNITS_LIMIT = 32;
/** Maximum unit index a caller may request. */
export const MAX_DWARF_UNIT_OFFSET = 100_000;
/** Walk cap. A stop at this count is not a complete census when bytes remain. */
export const MAX_DWARF_UNITS = 100_000;
/** Abbreviations admitted from one table, and retained across cached tables. */
export const MAX_DWARF_ABBREV_ENTRIES = 8192;
/** Attributes admitted on one abbreviation. */
export const MAX_DWARF_ABBREV_ATTRIBUTES = 256;
/** ULEB128 and SLEB128 byte cap. */
export const MAX_DWARF_ULEB_BYTES = 10;
/** Bytes retained from one NUL-terminated DWARF string. */
export const MAX_DWARF_STRING_BYTES = 65_536;
/** Issues retained on one compile unit. */
export const MAX_DWARF_UNIT_ISSUES = 32;

/**
 * DWARF 5 language codes, Table 7.3, without the `DW_LANG_` prefix.
 * Codes outside this table stay unnamed.
 */
export const DWARF_LANGUAGE_NAMES: Readonly<Record<number, string>> = {
  0x0001: "C89",
  0x0002: "C",
  0x0003: "Ada83",
  0x0004: "C_plus_plus",
  0x0005: "Cobol74",
  0x0006: "Cobol85",
  0x0007: "Fortran77",
  0x0008: "Fortran90",
  0x0009: "Pascal83",
  0x000a: "Modula2",
  0x000b: "Java",
  0x000c: "C99",
  0x000d: "Ada95",
  0x000e: "Fortran95",
  0x000f: "PLI",
  0x0010: "ObjC",
  0x0011: "ObjC_plus_plus",
  0x0012: "UPC",
  0x0013: "D",
  0x0014: "Python",
  0x0015: "OpenCL",
  0x0016: "Go",
  0x0017: "Modula3",
  0x0018: "Haskell",
  0x0019: "C_plus_plus_03",
  0x001a: "C_plus_plus_11",
  0x001b: "OCaml",
  0x001c: "Rust",
  0x001d: "C11",
  0x001e: "Swift",
  0x001f: "Julia",
  0x0020: "Dylan",
  0x0021: "C_plus_plus_14",
  0x0022: "Fortran03",
  0x0023: "Fortran08",
  0x0024: "RenderScript",
  0x0025: "BLISS",
};

/** Name a DWARF 5 language code, or null when the code is unnamed. */
export const dwarfLanguageName = (code: number): string | null =>
  DWARF_LANGUAGE_NAMES[code] ?? null;

export const DWARF_UNIT_ISSUE_CODES = [
  "truncated_header",
  "unsupported_version",
  "unsupported_address_size",
  "unknown_unit_type",
  "abbrev_offset_out_of_range",
  "abbrev_unavailable",
  "abbrev_malformed",
  "abbrev_budget",
  "unknown_abbrev_code",
  "unknown_form",
  "truncated_die",
  "string_unresolved",
  "value_unresolved",
  "unapplied_relocation",
  "str_offsets_base_absent",
  "supplementary_string",
  "string_not_utf8",
  "empty_unit",
  "value_out_of_range",
  "conflicting_dwo_name",
] as const;
export type DwarfUnitIssueCode = (typeof DWARF_UNIT_ISSUE_CODES)[number];

export const DWARF_SECTION_ROLES = [
  ".debug_info",
  ".debug_abbrev",
  ".debug_str",
  ".debug_line_str",
  ".debug_str_offsets",
] as const;
export type DwarfSectionRole = (typeof DWARF_SECTION_ROLES)[number];

const safeInt = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

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
const numberFactSchema = attributeState(
  z.number().int().min(0).max(0xffffffff),
);

const issueSchema = z.strictObject({
  code: z.enum(DWARF_UNIT_ISSUE_CODES),
  detail: z.string().min(1),
});

const unitSchema = z
  .strictObject({
    /** Byte offset of the unit inside decompressed `.debug_info`. */
    offset: safeInt,
    /** Artifact file offset. Null when `.debug_info` is compressed. */
    file_offset: safeInt.nullable(),
    /** Framed byte length, including the initial length field. */
    length: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    version: z.number().int().min(0).max(0xffff).nullable(),
    /** Null when the header has no unit-type byte. */
    unit_type: z.number().int().min(0).max(0xff).nullable(),
    address_size: z.number().int().min(0).max(0xff).nullable(),
    offset_size: z.union([z.literal(4), z.literal(8)]),
    /** Null when the header stops first or an unapplied ET_REL relocation hides it. */
    abbrev_offset: safeInt.nullable(),
    tag: z.number().int().min(0).max(0xffff).nullable(),
    die_complete: z.boolean(),
    name: stringFactSchema,
    comp_dir: stringFactSchema,
    producer: stringFactSchema,
    dwo_name: stringFactSchema,
    language: numberFactSchema,
    /** Null when the language is absent, unresolved, unknown, or unnamed. */
    language_name: z.string().nullable(),
    stmt_list: numberFactSchema,
    /** Null when the abbreviation set was not read. */
    low_pc_present: z.boolean().nullable(),
    issues: z.array(issueSchema).max(MAX_DWARF_UNIT_ISSUES),
  })
  .superRefine((unit, context) => {
    if (
      (unit.low_pc_present === null) !==
      (unit.tag === null && !unit.die_complete)
    )
      context.addIssue({
        code: "custom",
        message: "low_pc_present does not match abbreviation availability",
      });
    if (unit.die_complete) {
      for (const [key, fact] of [
        ["name", unit.name],
        ["comp_dir", unit.comp_dir],
        ["producer", unit.producer],
        ["dwo_name", unit.dwo_name],
        ["language", unit.language],
        ["stmt_list", unit.stmt_list],
      ] as const)
        if (fact.state === "unknown")
          context.addIssue({
            code: "custom",
            path: [key],
            message: "A complete DIE cannot leave an attribute unknown",
          });
    }
    const named =
      unit.language.state === "present" && unit.language.value !== null
        ? dwarfLanguageName(unit.language.value)
        : null;
    if (unit.language_name !== named)
      context.addIssue({
        code: "custom",
        path: ["language_name"],
        message: "language_name does not match the DWARF 5 language table",
      });
  });

const sectionSchema = z.strictObject({
  /** Stored section name, including a Mach-O or `.zdebug_*` spelling. */
  name: z.string().min(1),
  role: z.enum(DWARF_SECTION_ROLES),
  offset: safeInt,
  size: safeInt,
  compression: z.enum(["none", "zlib", "zstd"]),
  uncompressed_size: safeInt,
});

/** One explicit-file DWARF compile-unit inspection. */
export const inspectDwarfUnitsInputSchema = z.strictObject({
  path: localPathStringSchema.describe(
    "Absolute filesystem path to an ELF, Mach-O, or PE image",
  ),
  max_file_bytes: z
    .number()
    .int()
    .min(64)
    .max(MAX_INSPECT_DWARF_UNITS_FILE_BYTES)
    .default(67_108_864)
    .describe("Maximum stable artifact bytes to read (default 64 MiB)"),
  offset: z
    .number()
    .int()
    .min(0)
    .max(MAX_DWARF_UNIT_OFFSET)
    .default(0)
    .describe("Index of the first compile unit to return"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_INSPECT_DWARF_UNITS_LIMIT)
    .default(DEFAULT_INSPECT_DWARF_UNITS_LIMIT)
    .describe("Maximum compile units to return"),
  architecture: machoSliceArchitectureSchema
    .exactOptional()
    .describe(
      "CPU family of the slice to read from a universal Mach-O. Required for universal files and rejected for every other image.",
    ),
});

export const dwarfUnitsSchema = z
  .strictObject({
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
    omissions: z.array(
      z.strictObject({
        name: z.string().min(1),
        reason: z.string().min(1),
      }),
    ),
    units: z.array(unitSchema).max(MAX_INSPECT_DWARF_UNITS_LIMIT),
    total_units: safeInt,
    page: z.strictObject({
      offset: z.number().int().min(0).max(MAX_DWARF_UNIT_OFFSET),
      limit: z.number().int().min(1).max(MAX_INSPECT_DWARF_UNITS_LIMIT),
    }),
    coverage: z.strictObject({
      status: z.enum(["complete", "partial", "no_debug_info"]),
      reason: z.string().nullable(),
    }),
    limitations: z.array(z.string().min(1)).min(1),
  })
  .superRefine((report, context) => {
    const info = report.sections.find(
      (section) => section.role === ".debug_info",
    );
    const pageCount = Math.min(
      report.page.limit,
      Math.max(0, report.total_units - report.page.offset),
    );
    if (report.units.length !== pageCount)
      context.addIssue({
        code: "custom",
        path: ["units"],
        message:
          "Unit page length does not match offset, limit, and total_units",
      });
    if (report.coverage.status === "partial" && report.coverage.reason === null)
      context.addIssue({
        code: "custom",
        path: ["coverage"],
        message: "Partial coverage requires a reason",
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
    if (report.coverage.status === "no_debug_info") {
      if (
        report.coverage.reason === null ||
        report.total_units !== 0 ||
        report.units.length !== 0 ||
        info !== undefined
      )
        context.addIssue({
          code: "custom",
          path: ["coverage"],
          message: "Absent debug info has no .debug_info section and no units",
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
    if (info === undefined) return;
    for (const unit of report.units) {
      if (unit.offset + unit.length > info.uncompressed_size)
        context.addIssue({
          code: "custom",
          path: ["units"],
          message: "Unit range is outside decompressed .debug_info",
        });
      if (info.compression === "none") {
        if (unit.file_offset !== info.offset + unit.offset)
          context.addIssue({
            code: "custom",
            path: ["units"],
            message: "Unit file_offset does not match .debug_info",
          });
      } else if (unit.file_offset !== null)
        context.addIssue({
          code: "custom",
          path: ["units"],
          message: "Compressed .debug_info has no per-unit file_offset",
        });
      if (
        unit.file_offset !== null &&
        (unit.file_offset + unit.length > report.artifact.bytes ||
          (slice !== undefined &&
            !machoSelectionContainsRange(
              slice,
              report.artifact.bytes,
              unit.file_offset,
              unit.length,
            )))
      )
        context.addIssue({
          code: "custom",
          path: ["units"],
          message: "Unit file range is outside the artifact",
        });
    }
  });

export type InspectDwarfUnitsInput = z.infer<
  typeof inspectDwarfUnitsInputSchema
>;
export type DwarfUnitsReport = z.infer<typeof dwarfUnitsSchema>;
export type DwarfCompileUnit = DwarfUnitsReport["units"][number];
export type DwarfStringFact = DwarfCompileUnit["name"];
export type DwarfNumberFact = DwarfCompileUnit["language"];
