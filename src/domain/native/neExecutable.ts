import { z } from "zod";

import { absoluteLocalPathStringSchema } from "../localPath.js";

const uint = z.number().int().min(0).max(0xffffffff);
const u16 = z.number().int().min(0).max(0xffff);
const u8 = z.number().int().min(0).max(0xff);
const range = z.strictObject({ offset: uint, bytes: uint });
const farPointer = z.strictObject({ segment: u16, offset: u16 });
/** Length-prefixed 8-bit name. `name` decodes each byte as latin1, so it is lossless. */
const name = z.strictObject({ name: z.string(), location: range });
const identity = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("id"), id: u16 }),
  z.strictObject({ kind: z.literal("name"), ...name.shape }),
  // A zero name word: offset 0 is the table's alignment shift, never a name.
  z.strictObject({ kind: z.literal("none") }),
]);
const exportedName = z.strictObject({ ...name.shape, ordinal: u16 });

/** Smallest and default caller-selected input read budgets. */
export const MIN_INSPECT_NE_FILE_BYTES = 64;
export const DEFAULT_INSPECT_NE_FILE_BYTES = 67108864;
/** Smallest and default caller-selected table-row budgets. */
export const MIN_INSPECT_NE_TABLE_ROWS = 1;
export const DEFAULT_INSPECT_NE_TABLE_ROWS = 131072;
/** Hard ceiling on the caller-selected input read budget. */
export const MAX_INSPECT_NE_FILE_BYTES = 536870912;
/**
 * Hard ceiling on the caller-selected table-row budget. Every NE table count
 * is a 16-bit field, and resource types multiply their per-type counts.
 */
export const MAX_INSPECT_NE_TABLE_ROWS = 1048576;

/** Complete bounded inspection of a caller-selected NE image, without execution. */
export const inspectNeExecutableInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute filesystem path to a 16-bit Windows or OS/2 NE image",
  ),
  max_file_bytes: z
    .number()
    .int()
    .min(MIN_INSPECT_NE_FILE_BYTES)
    .max(MAX_INSPECT_NE_FILE_BYTES)
    .default(DEFAULT_INSPECT_NE_FILE_BYTES)
    .describe("Maximum stable artifact bytes to read (default 64 MiB)"),
  max_rows: z
    .number()
    .int()
    .min(MIN_INSPECT_NE_TABLE_ROWS)
    .max(MAX_INSPECT_NE_TABLE_ROWS)
    .default(DEFAULT_INSPECT_NE_TABLE_ROWS)
    .describe(
      "Maximum segment, resource, name, module-reference and entry rows to examine; exceeding the budget fails without partial success",
    ),
});

/** NE header and tables with their original file locations. */
export const neExecutableSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: uint,
  }),
  format: z.literal("ne"),
  header: z.strictObject({
    location: range,
    linker_version: z.strictObject({ major: u8, minor: u8 }),
    checksum: uint,
    flags: u16,
    module_kind: z.enum(["library", "application"]),
    auto_data_segment: u16,
    heap_bytes: u16,
    stack_bytes: u16,
    entry_point: farPointer,
    initial_stack: farPointer,
    alignment_shift: u16,
    target_os: u8,
    other_flags: u8,
    expected_windows_version: z.strictObject({ major: u8, minor: u8 }),
  }),
  module_name: name.nullable(),
  description: name.nullable(),
  segments: z.array(
    z.strictObject({
      index: u16,
      kind: z.enum(["code", "data"]),
      flags: u16,
      location: range.nullable(),
      minimum_allocation_bytes: uint,
      relocations: z.strictObject({ count: u16, location: range }).nullable(),
    }),
  ),
  resources: z.array(
    z.strictObject({
      type: identity,
      name: identity,
      flags: u16,
      location: range.nullable(),
      declared_bytes: uint,
      entry_location: range,
    }),
  ),
  resident_names: z.array(exportedName),
  nonresident_names: z.array(exportedName),
  module_references: z.array(z.strictObject({ index: u16, ...name.shape })),
  entries: z.array(
    z.strictObject({
      ordinal: u16,
      movable: z.boolean(),
      segment: u8,
      offset: u16,
      flags: u8,
      location: range,
    }),
  ),
  coverage: z.strictObject({
    status: z.literal("complete"),
    examined_rows: uint,
  }),
  limitations: z.array(z.string()),
});

export type NeExecutable = z.infer<typeof neExecutableSchema>;
export type InspectNeExecutableInput = z.infer<
  typeof inspectNeExecutableInputSchema
>;
export type NeIdentity = NeExecutable["resources"][number]["type"];
