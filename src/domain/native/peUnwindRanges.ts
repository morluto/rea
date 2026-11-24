import { z } from "zod";

import { knownCoverageStatusSchema } from "../coverage.js";
import { digestSchema } from "../digests.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";

const uint = z.number().int().min(0).max(0xffffffff);
const hexRva = z.string().regex(/^0x[0-9a-f]+$/u);
const hexVa = z.string().regex(/^0x[0-9a-f]+$/u);

/** Hard ceiling on the caller-selected input read budget. */
export const MAX_INSPECT_PE_UNWIND_FILE_BYTES = 536870912;
/** Hard ceiling on one returned page of exception-directory entries. */
export const MAX_INSPECT_PE_UNWIND_PAGE = 4096;
/**
 * Microsoft documents no chain depth. Each level names the entry it extends,
 * so a deeper chain than this is treated as a cycle in the target's bytes.
 */
export const MAX_PE_UNWIND_CHAIN_DEPTH = 32;

/** Size of one x64 `RUNTIME_FUNCTION`: begin, end and unwind-information RVAs. */
export const PE_X64_RUNTIME_FUNCTION_BYTES = 12;

/**
 * Limitation texts the parser emits and the application layer checks for.
 * One owner keeps the producer and the report validation in step.
 */
export const PE_UNWIND_LIMITATIONS = {
  codes:
    "Unwind codes are counted, not evaluated; handler and frame facts are not decoded.",
  leaf: "Leaf functions that need no unwind data have no entry, so a missing entry does not establish that no function starts there.",
  absent: "The image declares no exception directory (data directory 3).",
  machine:
    "Only the x64 RUNTIME_FUNCTION layout is decoded; this machine's exception directory uses another entry format.",
} as const;

export const inspectPeUnwindRangesInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute filesystem path to a PE32+ image",
  ),
  max_file_bytes: z
    .number()
    .int()
    .min(64)
    .max(MAX_INSPECT_PE_UNWIND_FILE_BYTES)
    .default(67108864)
    .describe("Maximum stable artifact bytes to read (default 64 MiB)"),
  kind: z
    .enum(["all", "primary", "chained", "issues"])
    .default("all")
    .describe(
      "Return every entry, only primary function entries, only chained fragments, or only entries with issues; counts always cover every entry",
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .max(0xffffffff)
    .default(0)
    .describe("Zero-based index into the selected entries"),
  limit: z
    .number()
    .int()
    .min(0)
    .max(MAX_INSPECT_PE_UNWIND_PAGE)
    .default(64)
    .describe("Maximum entries to return in this page; 0 returns counts only"),
});
export type InspectPeUnwindRangesInput = z.infer<
  typeof inspectPeUnwindRangesInputSchema
>;

/** Why an entry's boundary or unwind facts cannot be taken at face value. */
export const peUnwindIssueSchema = z.enum([
  // EndAddress is not above BeginAddress.
  "empty_range",
  // BeginAddress is below the previous entry's; the loader binary-searches a sorted table.
  "unsorted",
  // The range starts before the previous entry's end.
  "overlaps_previous",
  // The unwind-information RVA maps to no file-backed bytes.
  "unwind_unmapped",
  // UNWIND_INFO declares a version other than 1 or 2.
  "unwind_version_unknown",
  // The declared unwind-code array leaves the file-backed bytes.
  "unwind_codes_unmapped",
  // A chain names an entry that is not in this table.
  "chain_parent_missing",
  // A table entry begins where the chain names, but its end or unwind RVA differs.
  "chain_parent_mismatch",
  // A chain does not reach a primary entry within the depth bound.
  "chain_cycle",
]);

const parentSchema = z.strictObject({
  begin_rva: hexRva,
  end_rva: hexRva,
  unwind_rva: hexRva,
  /** Index of the table entry with this begin RVA, or null when none matches. */
  index: uint.nullable(),
});

export const peUnwindEntrySchema = z.strictObject({
  index: uint,
  begin_rva: hexRva,
  end_rva: hexRva,
  unwind_rva: hexRva,
  /**
   * `primary` starts a function; `chained` is a fragment whose unwind data
   * continues another entry's (UNW_FLAG_CHAININFO, or an unwind RVA with
   * its low bit set). `unknown` when the unwind information is unreadable.
   */
  kind: z.enum(["primary", "chained", "unknown"]),
  unwind_version: z.number().int().min(0).max(7).nullable(),
  unwind_flags: z
    .array(z.enum(["ehandler", "uhandler", "chaininfo"]))
    .nullable(),
  unwind_code_count: z.number().int().min(0).max(255).nullable(),
  /** The RUNTIME_FUNCTION this fragment's unwind data names. */
  parent: parentSchema.nullable(),
  /** The primary entry the chain reaches, or null when it reaches none. */
  primary_index: uint.nullable(),
  issues: z.array(peUnwindIssueSchema),
});
export type PeUnwindEntry = z.infer<typeof peUnwindEntrySchema>;

/** Static x64 exception-directory function ranges of one PE image. */
export const peUnwindRangesSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    sha256: digestSchema,
    bytes: uint,
  }),
  format: z.enum(["pe32", "pe32-plus"]),
  machine: uint,
  image_base: hexVa,
  /** Addresses in `entries` are RVAs; add `image_base` for virtual addresses. */
  address_space: z.literal("rva"),
  exception_directory: z.strictObject({
    status: z.enum(["present", "absent", "unsupported_machine"]),
    rva: hexRva.nullable(),
    size: uint.nullable(),
    file_offset: uint.nullable(),
    section: z.string().nullable(),
  }),
  coverage: z.strictObject({
    status: knownCoverageStatusSchema,
    total_entries: uint,
    primary_entries: uint,
    chained_entries: uint,
    unknown_entries: uint,
    entries_with_issues: uint,
    /** Bytes of the directory after its last whole 12-byte entry. */
    trailing_bytes: uint,
  }),
  page: z.strictObject({
    kind: z.enum(["all", "primary", "chained", "issues"]),
    offset: uint,
    limit: uint,
    returned: uint,
    total: uint,
    next_offset: uint.nullable(),
  }),
  entries: z.array(peUnwindEntrySchema),
  limitations: z.array(z.string().min(1)),
});
export type PeUnwindRanges = z.infer<typeof peUnwindRangesSchema>;
