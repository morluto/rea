import { z } from "zod";

import { digestSchema } from "../digests.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";
import { ELF_OBJECT_TYPE_NAMES } from "./elfNotes.js";

const uint = z.number().int().min(0).max(0xffffffff);
const hexAddress = z.string().regex(/^0x[0-9a-f]+$/u);
const decimalSize = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);
const range = z.strictObject({ offset: uint, bytes: uint });

/** Hard ceiling on the caller-selected input read budget. */
export const MAX_INSPECT_ELF_UNWIND_FILE_BYTES = 536870912;
/** Hard ceiling on decoded CIE records and, separately, on decoded FDEs. */
export const MAX_INSPECT_ELF_UNWIND_RANGES = 65536;
/** Hard ceiling on one returned page of FDE ranges. */
export const MAX_INSPECT_ELF_UNWIND_PAGE = 4096;
/** Hard ceiling on symbol-table entries scanned, across all tables, for exact-start names. */
export const MAX_ELF_UNWIND_SYMBOLS = 65536;
/** Fixed allowance on symbol-name text decoded for one returned page. */
export const MAX_ELF_UNWIND_SYMBOL_TEXT_BYTES = 16 * 1024 * 1024;

/**
 * Limitation texts the parser emits and the application layer checks for.
 * One owner keeps the producer and the report validation in step.
 */
export const ELF_UNWIND_LIMITATIONS = {
  cfa: "CFA instructions are counted but not evaluated.",
  untrusted:
    "Symbol names, section names, and augmentation strings are target-derived and untrusted.",
  indirect: "Indirect EH pointers were not dereferenced.",
  headerMismatch:
    "The .eh_frame_hdr binary search table does not match the decoded FDEs.",
  frameAbsent: "No .eh_frame section or PT_GNU_EH_FRAME segment was declared.",
  headerAbsent:
    "No .eh_frame_hdr section or PT_GNU_EH_FRAME segment was declared.",
  debugPresent: ".debug_frame is present and was not decoded.",
  debugAbsent: ".debug_frame is absent; only .eh_frame was examined.",
  debugUnknown: ".debug_frame presence is unknown.",
  debugOutside:
    ".debug_frame is declared but its bytes are not in the file; it was not examined.",
} as const;

const FORMAT_NAMES: Readonly<Record<number, string>> = {
  0: "absptr",
  1: "uleb128",
  2: "udata2",
  3: "udata4",
  4: "udata8",
  9: "sleb128",
  0x0a: "sdata2",
  0x0b: "sdata4",
  0x0c: "sdata8",
};

const APPLICATION_NAMES: Readonly<Record<number, string>> = {
  0x10: "pcrel",
  0x20: "textrel",
  0x30: "datarel",
  0x40: "funcrel",
  0x50: "aligned",
};

/** DW_EH_PE name such as `pcrel|sdata4` or `pcrel|sdata4|indirect`. */
export const elfEhPointerEncodingName = (raw: number): string => {
  const encoding = raw & 0xff;
  if (encoding === 0xff) return "omit";
  const format =
    FORMAT_NAMES[encoding & 0x0f] ?? `unknown${(encoding & 0x0f).toString(16)}`;
  const application = encoding & 0x70;
  const parts: string[] = [];
  if (application !== 0)
    parts.push(
      APPLICATION_NAMES[application] ?? `unknown${application.toString(16)}`,
    );
  parts.push(format);
  if ((encoding & 0x80) !== 0) parts.push("indirect");
  return parts.join("|");
};

const untrustedText = z.strictObject({
  text: z.string().min(1),
  trust: z.literal("untrusted"),
});

const untrustedAugmentation = z.strictObject({
  text: z.string(),
  trust: z.literal("untrusted"),
});

const encodingSchema = z.strictObject({
  raw: z.number().int().min(0).max(255),
  name: z.string().min(1),
});

const tableStatus = z.enum(["present", "absent", "incomplete", "unknown"]);

/** Caller-selected page of ELF unwind function ranges. */
export const inspectElfUnwindRangesInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute filesystem path to an ELF image",
  ),
  max_file_bytes: z
    .number()
    .int()
    .min(64)
    .max(MAX_INSPECT_ELF_UNWIND_FILE_BYTES)
    .default(67108864)
    .describe("Maximum stable artifact bytes to read (default 64 MiB)"),
  max_ranges: z
    .number()
    .int()
    .min(1)
    .max(MAX_INSPECT_ELF_UNWIND_RANGES)
    .default(8192)
    .describe(
      "Maximum CIE records and, separately, maximum FDEs to decode; exceeding either budget fails without partial success",
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .max(0xffffffff)
    .default(0)
    .describe("Zero-based index of the first FDE range to return"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_INSPECT_ELF_UNWIND_PAGE)
    .default(256)
    .describe("Maximum FDE ranges to return in this page"),
});

const cieSchema = z.strictObject({
  index: uint,
  version: z.union([z.literal(1), z.literal(3)]),
  augmentation: untrustedAugmentation,
  code_alignment: z.number().int().nonnegative(),
  data_alignment: z.number().int(),
  return_address_register: z.number().int().nonnegative(),
  pointer_encoding: encodingSchema,
  lsda_encoding: encodingSchema.nullable(),
  personality: z
    .strictObject({
      address: hexAddress,
      encoding: encodingSchema,
      indirect: z.boolean(),
    })
    .nullable(),
  signal_frame: z.boolean(),
  b_key: z.boolean(),
  instruction_bytes: uint,
  location: range,
});

const functionRangeSchema = z.strictObject({
  index: uint,
  start: hexAddress,
  end: hexAddress,
  size: decimalSize,
  section: untrustedText.nullable(),
  symbol: untrustedText.nullable(),
  cie_index: uint,
  lsda: z
    .strictObject({
      address: hexAddress,
      indirect: z.boolean(),
    })
    .nullable(),
  personality: z
    .strictObject({
      address: hexAddress,
      indirect: z.boolean(),
    })
    .nullable(),
  location: range,
});

/** Observed .eh_frame function ranges. Truncation is incomplete, not absence. */
export const elfUnwindRangesSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    sha256: digestSchema,
    bytes: uint,
  }),
  format: z.enum(["elf32", "elf64"]),
  byte_order: z.enum(["little", "big"]),
  machine: uint,
  type: uint,
  type_name: z.enum(ELF_OBJECT_TYPE_NAMES),
  eh_frame: z.strictObject({
    status: tableStatus,
    source: z.enum(["section", "program"]).nullable(),
    location: range.nullable(),
  }),
  eh_frame_hdr: z.strictObject({
    status: tableStatus,
    location: range.nullable(),
    version: uint.nullable(),
    eh_frame_pointer_encoding: encodingSchema.nullable(),
    fde_count_encoding: encodingSchema.nullable(),
    table_encoding: encodingSchema.nullable(),
    eh_frame_pointer: hexAddress.nullable(),
    fde_count: uint.nullable(),
    table_entries: uint,
  }),
  debug_frame: z.strictObject({
    /** `incomplete`: declared, but NOBITS or outside the file. */
    status: z.enum(["present", "absent", "incomplete", "unknown"]),
    location: range.nullable(),
  }),
  /** Decoded CIEs named by this page's ranges, in index order. */
  cies: z.array(cieSchema),
  ranges: z.array(functionRangeSchema),
  page: z.strictObject({
    offset: uint,
    limit: uint,
    returned: uint,
    total: uint,
    next_offset: uint.nullable(),
  }),
  coverage: z.strictObject({
    status: z.enum(["complete", "incomplete"]),
    total_ranges: uint,
    /** Every decoded CIE, including ones this page does not return. */
    total_cies: uint,
    ranges_with_symbols: uint,
    ranges_without_symbols: uint,
    eh_frame_hdr_agreement: z.enum(["agree", "disagree", "unavailable"]),
    examined_records: uint,
  }),
  limitations: z.array(z.string()),
});

export type ElfUnwindRanges = z.infer<typeof elfUnwindRangesSchema>;
export type InspectElfUnwindRangesInput = z.infer<
  typeof inspectElfUnwindRangesInputSchema
>;
