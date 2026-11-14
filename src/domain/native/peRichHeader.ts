import { z } from "zod";

import { digestSchema } from "../digests.js";
import { fixedTupleSchema } from "../fixedTupleSchema.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";

const uint = z.number().int().min(0).max(0xffffffff);
const uint16 = z.number().int().min(0).max(0xffff);
const range = z.strictObject({ offset: uint, bytes: uint });

/** Hard ceiling on the caller-selected input read budget. */
export const MAX_INSPECT_PE_RICH_HEADER_FILE_BYTES = 536870912;
/** Hard ceiling on decoded Rich header entries. */
export const MAX_INSPECT_PE_RICH_HEADER_ENTRIES = 65536;

/** Byte width of the `DanS` marker plus its three padding DWORDs. */
export const PE_RICH_HEADER_START_BYTES = 16;
/** Byte width of one `@comp.id` and use-count pair. */
export const PE_RICH_HEADER_ENTRY_BYTES = 8;
/** Byte width of the `Rich` marker and the key that follows it. */
export const PE_RICH_HEADER_FOOTER_BYTES = 8;

/** Complete bounded inspection of one PE image's Rich header. */
export const inspectPeRichHeaderInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute filesystem path to a PE image",
  ),
  max_file_bytes: z
    .number()
    .int()
    .min(64)
    .max(MAX_INSPECT_PE_RICH_HEADER_FILE_BYTES)
    .default(67108864)
    .describe("Maximum stable artifact bytes to read (default 64 MiB)"),
  max_entries: z
    .number()
    .int()
    .min(1)
    .max(MAX_INSPECT_PE_RICH_HEADER_ENTRIES)
    .default(1024)
    .describe(
      "Maximum Rich header entries to decode; exceeding the budget fails without partial success",
    ),
});
export type InspectPeRichHeaderInput = z.infer<
  typeof inspectPeRichHeaderInputSchema
>;

/** One decoded `@comp.id` record: the high word, low word and use count. */
const entrySchema = z.strictObject({
  product_id: uint16,
  build: uint16,
  count: uint,
});
export type PeRichHeaderEntry = z.infer<typeof entrySchema>;

export const PE_RICH_HEADER_MALFORMED_REASONS = [
  "start_marker_missing",
  "partial_entry",
] as const;

const richHeaderSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("absent") }),
  z.strictObject({
    state: z.literal("malformed"),
    reason: z.enum(PE_RICH_HEADER_MALFORMED_REASONS),
    footer_location: range,
    key: uint,
  }),
  z.strictObject({
    state: z.literal("present"),
    /** From the `DanS` marker through the key after `Rich`. */
    location: range,
    footer_location: range,
    key: uint,
    checksum: z.strictObject({ computed: uint, matches: z.boolean() }),
    /** The three DWORDs after `DanS`, decoded with the key. */
    padding: fixedTupleSchema([uint, uint, uint]),
    entries: z.array(entrySchema),
  }),
]);
export type PeRichHeaderRecord = z.infer<typeof richHeaderSchema>;

/** Limits that apply to every successful Rich header report. */
export const PE_RICH_HEADER_LIMITATIONS = [
  "The Rich header is an undocumented linker record. Product IDs and build numbers are reported as stored; this inspection does not name the tools or Visual Studio releases they stand for.",
  "Only the last Rich footer before the PE signature is examined. An earlier footer, such as one inside an image embedded in a custom DOS stub, is not reported.",
  "The checksum covers the DOS header except e_lfanew, the bytes before the DanS marker and the decoded entries. A match does not show that the rest of the image is unchanged, and a mismatch does not show which covered bytes changed.",
] as const;

/** Added when no Rich footer precedes the PE signature. */
export const PE_RICH_HEADER_ABSENT_LIMITATION =
  "No Rich footer precedes the PE signature. That is observed absence of the record; linkers other than Microsoft's omit it, and it can be removed after linking." as const;

/** Static Rich header record of one PE32/PE32+ image. */
export const peRichHeaderSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    sha256: digestSchema,
    bytes: uint,
  }),
  format: z.enum(["pe32", "pe32-plus"]),
  machine: uint,
  /** The e_lfanew value that bounds the search. */
  pe_header_offset: uint,
  rich_header: richHeaderSchema,
  limitations: z.array(z.string().min(1)),
});
export type PeRichHeader = z.infer<typeof peRichHeaderSchema>;
