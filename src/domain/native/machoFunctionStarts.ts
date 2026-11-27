import { z } from "zod";

import {
  machoSliceArchitectureSchema,
  machoTargetSelectionSchema,
} from "../apple/machoTargetSelection.js";
import { BINARY_ARCHITECTURES } from "../binaryTargetTypes.js";
import { knownCoverageStatusSchema } from "../coverage.js";
import { digestSchema } from "../digests.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";
import type { AnalysisParameterLimit } from "../analysisSettings.js";
import { maxStructureBytesSchema } from "./nativeStructureBudget.js";
import {
  parameterBudgetLimit,
  parameterBudgetSchema,
  type ParameterBudget,
} from "../parameterBudget.js";

const uint = z.number().int().min(0).max(0xffffffff);
const hexAddress = z.string().regex(/^0x[0-9a-f]+$/u);

/**
 * Whole-file identity ceiling. `LC_FUNCTION_STARTS` and `LC_DATA_IN_CODE`
 * `dataoff` fields, and FAT32 slice offsets, are 32-bit. FAT64 files larger
 * than 4 GiB are outside this reader. `max_file_bytes` does not raise it.
 */
export const MACHO_FUNCTION_STARTS_FILE_CEILING_BYTES = 0xffffffff;
/** Hard ceiling on the caller-selected input read budget. */
export const MAX_INSPECT_MACHO_FUNCTION_STARTS_FILE_BYTES = 536870912;
/** Hard ceiling on one returned page of either table. */
export const MAX_INSPECT_MACHO_FUNCTION_STARTS_PAGE = 4096;

/**
 * Limitation texts the parser emits and the application layer checks for.
 * One owner keeps the producer and the report validation in step.
 */
export const MACHO_FUNCTION_STARTS_LIMITATIONS = {
  missingStarts:
    "A missing LC_FUNCTION_STARTS does not prove the image has no function starts.",
  missingData:
    "A missing LC_DATA_IN_CODE does not prove those bytes are instructions.",
  static: "This reader does not disassemble and does not execute the image.",
  duplicateStarts:
    "LC_FUNCTION_STARTS is declared more than once; the first command was decoded.",
  duplicateData:
    "LC_DATA_IN_CODE is declared more than once; the first command was decoded.",
  outsideStarts: "LC_FUNCTION_STARTS data is not in the __LINKEDIT segment.",
  outsideData: "LC_DATA_IN_CODE data is not in the __LINKEDIT segment.",
  misSizedStarts: "LC_FUNCTION_STARTS cmdsize is not 16.",
  misSizedData: "LC_DATA_IN_CODE cmdsize is not 16.",
  ulebTruncated: "LC_FUNCTION_STARTS ended inside a ULEB128 delta.",
  ulebOverflow: "LC_FUNCTION_STARTS ULEB128 delta does not fit in 64 bits.",
  wrapped: "LC_FUNCTION_STARTS address wrapped; later deltas were not decoded.",
  outOfText:
    "A function start is outside every executable segment; later deltas were not decoded.",
  missingText: "LC_FUNCTION_STARTS has no __TEXT segment to anchor its deltas.",
  textNotAtHeader:
    "The mach_header is not mapped at the __TEXT vmaddr. Starts are anchored on that vmaddr, as llvm-objdump does; dyld adds the deltas to the mach_header address, which differs here or is unknown.",
  trailing: "Bytes after the LC_FUNCTION_STARTS terminator are not zero.",
  startsPastFile:
    "LC_FUNCTION_STARTS extends past the file; only in-file bytes were decoded.",
  dataPastFile:
    "LC_DATA_IN_CODE extends past the file; only complete in-file entries were decoded.",
  dataTrailing:
    "LC_DATA_IN_CODE has trailing bytes shorter than one 8-byte entry.",
  crosses: "A data-in-code entry is not contained in one section.",
  unsorted: "data-in-code offsets are not strictly increasing.",
  zeroLength: "A data-in-code entry has length 0.",
  unmapped:
    "A data-in-code entry has no VM address: the mach_header address its offset is relative to is unknown, or the address is outside every segment.",
  unterminated:
    "LC_FUNCTION_STARTS ends without its zero terminator; the list may be cut off.",
} as const;

/** `max_entries` of `inspect_macho_function_starts`: decoded starts plus data-in-code entries. */
export const MACHO_FUNCTION_STARTS_ENTRY_BUDGET = {
  minimum: 1,
  maximum: 16_777_216,
  default_value: 2_097_152,
  unit: "count",
} as const satisfies ParameterBudget;

/** The `max_entries` control that stopped a function-start decode. */
export const machoFunctionStartsEntryLimit = (
  effectiveValue: number,
): AnalysisParameterLimit =>
  parameterBudgetLimit(
    "max_entries",
    MACHO_FUNCTION_STARTS_ENTRY_BUDGET,
    effectiveValue,
  );

export const inspectMachoFunctionStartsInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute filesystem path to a thin or universal Mach-O image",
  ),
  architecture: machoSliceArchitectureSchema.optional(),
  max_file_bytes: z
    .number()
    .int()
    .min(64)
    .max(MAX_INSPECT_MACHO_FUNCTION_STARTS_FILE_BYTES)
    .default(67108864)
    .describe(
      "Maximum bytes this reader reads from the artifact: headers, load commands and the LINKEDIT ranges they reference (default 64 MiB). The file may be larger; its one hashing pass is not counted",
    ),
  max_structure_bytes: maxStructureBytesSchema,
  max_entries: parameterBudgetSchema(
    MACHO_FUNCTION_STARTS_ENTRY_BUDGET,
  ).describe(
    "Maximum function starts plus data-in-code entries to decode (default 2097152); a larger pair of tables fails without partial success",
  ),
  kind: z
    .enum(["all", "starts", "data"])
    .default("all")
    .describe(
      "Return both tables, only function starts, or only data-in-code entries; counts always cover every entry",
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .max(0xffffffff)
    .default(0)
    .describe("Zero-based index into each selected table"),
  limit: z
    .number()
    .int()
    .min(0)
    .max(MAX_INSPECT_MACHO_FUNCTION_STARTS_PAGE)
    .default(64)
    .describe(
      "Maximum entries to return from each selected table; 0 returns counts only",
    ),
});
export type InspectMachoFunctionStartsInput = z.infer<
  typeof inspectMachoFunctionStartsInputSchema
>;

/**
 * `data_in_code_entry.kind` values named in <mach-o/loader.h>
 * (`DICE_KIND_DATA` through `DICE_KIND_ABS_JUMP_TABLE32`), the same five that
 * dyld's `mach_o::DataInCode` accepts. Any other value is reported as its
 * number. The reader, the schema and the report check share this table.
 */
export const MACHO_DICE_KIND_NAMES = {
  1: "DICE_KIND_DATA",
  2: "JUMP_TABLE8",
  3: "JUMP_TABLE16",
  4: "JUMP_TABLE32",
  5: "ABS_JUMP_TABLE32",
} as const;
const DICE_KINDS = Object.values(MACHO_DICE_KIND_NAMES) as [
  (typeof MACHO_DICE_KIND_NAMES)[keyof typeof MACHO_DICE_KIND_NAMES],
  ...(typeof MACHO_DICE_KIND_NAMES)[keyof typeof MACHO_DICE_KIND_NAMES][],
];

/** The reported `kind` of one raw `data_in_code_entry.kind`. */
export const machoDataInCodeKind = (raw: number): MachoDataInCode["kind"] =>
  Object.hasOwn(MACHO_DICE_KIND_NAMES, raw)
    ? MACHO_DICE_KIND_NAMES[raw as keyof typeof MACHO_DICE_KIND_NAMES]
    : raw;

const startIssueSchema = z.enum(["wrapped", "out_of_text"]);
const dataIssueSchema = z.enum([
  "crosses_section",
  "zero_length",
  "unmapped",
  "out_of_order",
]);

/** An observed section name, which may be empty (an all-zero `sectname`). */
const sectionNameSchema = z.string().nullable();

export const machoFunctionStartSchema = z.strictObject({
  index: uint,
  /** Code address. On 32-bit ARM the Thumb tag in bit 0 is cleared here. */
  vmaddr: hexAddress,
  /**
   * 32-bit ARM only: bit 0 of the encoded start was set, marking Thumb code.
   * Other architectures omit it, because their starts carry no ISA tag.
   */
  thumb: z.boolean().optional(),
  section: sectionNameSchema,
  issues: z.array(startIssueSchema),
});
export type MachoFunctionStart = z.infer<typeof machoFunctionStartSchema>;

const ownerSchema = z.strictObject({
  index: uint,
  vmaddr: hexAddress,
});

export const machoDataInCodeSchema = z.strictObject({
  index: uint,
  /**
   * `data_in_code_entry.offset`, relative to the mach_header's address: ld64
   * writes the entry's address minus that address. For MH_OBJECT, whose
   * header is not mapped, it is the address itself.
   */
  offset: uint,
  vmaddr: hexAddress.nullable(),
  length: z.number().int().min(0).max(0xffff),
  kind: z.union([z.enum(DICE_KINDS), z.number().int().min(0).max(0xffff)]),
  section: sectionNameSchema,
  /** Greatest decoded start at or before `vmaddr`, or null when none applies. */
  owner: ownerSchema.nullable(),
  issues: z.array(dataIssueSchema),
});
export type MachoDataInCode = z.infer<typeof machoDataInCodeSchema>;

const commandSchema = z.strictObject({
  status: z.enum(["present", "absent"]),
  dataoff: uint.nullable(),
  datasize: uint.nullable(),
  /** Container file offset of `dataoff`, or null when the command is absent. */
  file_offset: uint.nullable(),
  in_linkedit: z.boolean().nullable(),
});

export const machoFunctionStartsSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    sha256: digestSchema,
    bytes: uint,
  }),
  format: z.literal("macho"),
  architecture: z.enum(BINARY_ARCHITECTURES).nullable(),
  bits: z.union([z.literal(32), z.literal(64)]),
  byte_order: z.enum(["little", "big"]),
  /** Present only for a universal file. A thin image omits it. */
  selected_slice: machoTargetSelectionSchema.optional(),
  function_starts: commandSchema,
  data_in_code: commandSchema,
  coverage: z.strictObject({
    status: knownCoverageStatusSchema,
    total_starts: uint,
    total_data_in_code: uint,
    duplicate_commands: uint,
    mis_sized_commands: uint,
    outside_linkedit: uint,
    truncated_commands: uint,
    uleb_truncated: uint,
    uleb_overflow: uint,
    non_monotonic: uint,
    out_of_text: uint,
    missing_text_anchor: uint,
    /** 1 when __TEXT does not map file offset 0, so the delta base is disputed. */
    text_not_at_header: uint,
    /** 1 when the table ends after a delta without its zero terminator. */
    unterminated_starts: uint,
    trailing_nonzero: uint,
    data_trailing_bytes: uint,
    section_crossings: uint,
    unsorted_data: uint,
    unmapped_data: uint,
    zero_length_data: uint,
  }),
  page: z.strictObject({
    kind: z.enum(["all", "starts", "data"]),
    offset: uint,
    limit: uint,
    returned_starts: uint,
    total_starts: uint,
    next_starts_offset: uint.nullable(),
    returned_data: uint,
    total_data: uint,
    next_data_offset: uint.nullable(),
  }),
  starts: z.array(machoFunctionStartSchema),
  data_in_code_entries: z.array(machoDataInCodeSchema),
  limitations: z.array(z.string().min(1)),
});
export type MachoFunctionStarts = z.infer<typeof machoFunctionStartsSchema>;

/** Whether any decoded-table problem made coverage partial. */
export const machoFunctionStartsHasIssues = (
  coverage: MachoFunctionStarts["coverage"],
): boolean =>
  coverage.duplicate_commands +
    coverage.mis_sized_commands +
    coverage.outside_linkedit +
    coverage.truncated_commands +
    coverage.uleb_truncated +
    coverage.uleb_overflow +
    coverage.non_monotonic +
    coverage.out_of_text +
    coverage.missing_text_anchor +
    coverage.text_not_at_header +
    coverage.unterminated_starts +
    coverage.trailing_nonzero +
    coverage.data_trailing_bytes +
    coverage.section_crossings +
    coverage.unsorted_data +
    coverage.unmapped_data +
    coverage.zero_length_data >
  0;
