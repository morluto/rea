import { z } from "zod";

import { machoSliceArchitectureSchema } from "../apple/machoTargetSelection.js";
import {
  BINARY_ARCHITECTURES,
  RAW_ONLY_ARCHITECTURES,
} from "../binaryTargetTypes.js";
import { digestSchema } from "../digests.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";

/** Hard ceiling on the caller-selected input read budget. */
export const MAX_INSPECT_NATIVE_INITIALIZERS_FILE_BYTES = 536870912;
/** Slots collected before the inventory is reported incomplete. */
export const MAX_NATIVE_INITIALIZER_ENTRIES = 65536;
/** Default page size for returned entries. */
export const DEFAULT_NATIVE_INITIALIZER_PAGE = 64;
/** Upper bound on one returned page. */
export const MAX_NATIVE_INITIALIZER_PAGE = 4096;
/** Bytes admitted for one symbol or section name. */
export const MAX_NATIVE_INITIALIZER_NAME_BYTES = 1024;
/** Distinct image observations listed before later ones are only counted. */
export const MAX_NATIVE_INITIALIZER_NOTES = 24;
/**
 * Upper bound on reported limitations: the standing ones, the note budget, a
 * line per tallied reason, an omission count and a withheld-name count.
 */
export const MAX_NATIVE_INITIALIZER_LIMITATIONS = 40;

const uint = z.number().int().min(0).max(0xffffffff);
const safeNonNegative = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const hexAddress = z.string().regex(/^0x[0-9a-f]+$/u);

/** Declaration order used for ELF entries. Mach-O kinds follow. */
export const NATIVE_INITIALIZER_KINDS = [
  "preinit_array",
  "init",
  "init_array",
  "ctors",
  "fini",
  "fini_array",
  "dtors",
  "mod_init",
  "init_offsets",
  "mod_term",
] as const;
export type NativeInitializerKind = (typeof NATIVE_INITIALIZER_KINDS)[number];

/** How a slot value was obtained. `unresolved` is not a stored zero. */
export const NATIVE_INITIALIZER_RESOLUTIONS = [
  "raw",
  "relative_addend",
  "relr",
  "chained_fixup",
  "dyld_info_rebase",
  "offset_table",
  "symbol_addend",
  "unresolved_import",
  "unresolved",
] as const;
export type NativeInitializerResolution =
  (typeof NATIVE_INITIALIZER_RESOLUTIONS)[number];

/** One local ELF or Mach-O image, optionally one selected universal slice. */
export const inspectNativeInitializersInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute filesystem path to an ELF or Mach-O image",
  ),
  max_file_bytes: z
    .number()
    .int()
    .min(64)
    .max(MAX_INSPECT_NATIVE_INITIALIZERS_FILE_BYTES)
    .default(67108864)
    .describe("Maximum stable artifact bytes to read (default 64 MiB)"),
  offset: z
    .number()
    .int()
    .min(0)
    .max(MAX_NATIVE_INITIALIZER_ENTRIES)
    .default(0)
    .describe("Zero-based index of the first returned entry"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_NATIVE_INITIALIZER_PAGE)
    .default(DEFAULT_NATIVE_INITIALIZER_PAGE)
    .describe("Maximum entries to return (default 64, max 4096)"),
  architecture: machoSliceArchitectureSchema.optional(),
});
export type InspectNativeInitializersInput = z.infer<
  typeof inspectNativeInitializersInputSchema
>;

const untrustedNameSchema = z.strictObject({
  name: z.string().min(1).max(MAX_NATIVE_INITIALIZER_NAME_BYTES),
  trust: z.literal("observed-untrusted"),
});
export type NativeInitializerName = z.infer<typeof untrustedNameSchema>;

const entrySchema = z.strictObject({
  index: uint,
  kind: z.enum(NATIVE_INITIALIZER_KINDS),
  slot_va: hexAddress.nullable(),
  slot_file_offset: safeNonNegative.nullable(),
  slot_bytes: z.union([z.literal(4), z.literal(8)]),
  value_va: hexAddress.nullable(),
  value_file_offset: safeNonNegative.nullable(),
  slot_section: untrustedNameSchema.nullable(),
  section: untrustedNameSchema.nullable(),
  symbol: untrustedNameSchema.nullable(),
  resolution: z.enum(NATIVE_INITIALIZER_RESOLUTIONS),
  detail: z.string().min(1).max(MAX_NATIVE_INITIALIZER_NAME_BYTES).nullable(),
});
export type NativeInitializerEntry = z.infer<typeof entrySchema>;

const coverageSchema = z.strictObject({
  status: z.enum(["complete", "incomplete"]),
  examined_entries: z.number().int().min(0).max(MAX_NATIVE_INITIALIZER_ENTRIES),
  total_entries: z
    .number()
    .int()
    .min(0)
    .max(MAX_NATIVE_INITIALIZER_ENTRIES)
    .nullable(),
  returned_entries: z.number().int().min(0).max(MAX_NATIVE_INITIALIZER_PAGE),
  offset: z.number().int().min(0).max(MAX_NATIVE_INITIALIZER_ENTRIES),
  limit: z.number().int().min(1).max(MAX_NATIVE_INITIALIZER_PAGE),
});
export type NativeInitializerCoverage = z.infer<typeof coverageSchema>;

const sliceSchema = z.strictObject({
  file_offset: safeNonNegative,
  size: safeNonNegative.min(1),
  cpu_type: z.number().int(),
  cpu_subtype: z.number().int(),
  architecture: z.string().min(1),
});
export type NativeInitializerSlice = z.infer<typeof sliceSchema>;

/**
 * Facts this inspection does not establish. A missing tag is not proof that
 * no constructor runs, and file order is not the dynamic linker's order.
 */
export const NATIVE_INITIALIZER_LIMITATIONS = [
  "This inspection does not execute the image and does not prove that a listed address runs before main or at exit.",
  "A missing dynamic tag or section is observed absence of that declaration, not proof that no constructor exists in code.",
  "Symbol and section names are exact file text and are untrusted. A resolved address is named only when a defined symbol value equals that address. An unresolved import keeps the relocation symbol name.",
  "PIE and shared-object slots are resolved through RELATIVE and RELR dynamic relocations, and through section REL or RELA records when no dynamic relocation covers the slot. Other relocation kinds stay unresolved.",
  ".ctors and .dtors values 0 and -1 are sentinels and are omitted. Those sections are listed in file order, not reverse runtime order.",
  "DT_FINI is listed before fini_array. The dynamic linker runs fini_array first at exit.",
  "Mach-O __init_offsets entries are 32-bit offsets from the image base, not pointers. Chained binds are unresolved imports.",
] as const;

const artifactSchema = z.strictObject({
  path: absoluteLocalPathStringSchema,
  sha256: digestSchema,
  bytes: z
    .number()
    .int()
    .min(0)
    .max(MAX_INSPECT_NATIVE_INITIALIZERS_FILE_BYTES),
});

/** Ordered initializer and finalizer slots for one ELF or Mach-O image. */
export const nativeInitializersSchema = z.strictObject({
  artifact: artifactSchema,
  format: z.enum(["elf", "mach-o"]),
  status: z.enum(["parsed", "incomplete"]),
  applicability: z.literal("applicable"),
  architecture: z
    .enum(BINARY_ARCHITECTURES)
    .exclude([...RAW_ONLY_ARCHITECTURES])
    .nullable(),
  bits: z.union([z.literal(32), z.literal(64)]).nullable(),
  byte_order: z.enum(["little", "big"]).nullable(),
  machine: uint.nullable(),
  elf_type: uint.nullable(),
  slice: sliceSchema.nullable(),
  coverage: coverageSchema,
  entries: z.array(entrySchema),
  limitations: z
    .array(z.string().min(1))
    .max(MAX_NATIVE_INITIALIZER_LIMITATIONS),
});
export type NativeInitializers = z.infer<typeof nativeInitializersSchema>;

/** Parser result before the provider attaches the stable artifact identity. */
export type NativeInitializerInspection = Omit<NativeInitializers, "artifact">;
