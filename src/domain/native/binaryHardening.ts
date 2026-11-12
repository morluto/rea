import { z } from "zod";

import {
  BINARY_ARCHITECTURES,
  RAW_ONLY_ARCHITECTURES,
} from "../binaryTargetTypes.js";
import { digestSchema } from "../digests.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";

/** Hard ceiling on the caller-selected input read budget. */
export const MAX_INSPECT_BINARY_HARDENING_FILE_BYTES = 536870912;
/** Fixed dynamic-entry and symbol budget. This release has no runtime override. */
export const MAX_BINARY_HARDENING_TABLE_ENTRIES = 65536;
/** Bytes examined for one symbol name. A longer run is not a terminated name. */
export const MAX_BINARY_HARDENING_SYMBOL_NAME_BYTES = 65536;
/** Aggregate string-table bytes examined while resolving symbol names. */
export const MAX_BINARY_HARDENING_SYMBOL_SCAN_BYTES = 16 * 1024 * 1024;

const uint = z.number().int().min(0).max(0xffffffff);
/** FAT64 declarations can exceed 2^32 while staying inside a safe integer. */
const safeNonNegative = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Explicit-file hardening inspection of one ELF, PE, or Mach-O image. */
export const inspectBinaryHardeningInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute filesystem path to an ELF, PE, or Mach-O image",
  ),
  max_file_bytes: z
    .number()
    .int()
    .min(64)
    .max(MAX_INSPECT_BINARY_HARDENING_FILE_BYTES)
    .default(67108864)
    .describe("Maximum stable artifact bytes to read (default 64 MiB)"),
});
export type InspectBinaryHardeningInput = z.infer<
  typeof inspectBinaryHardeningInputSchema
>;

export const BINARY_HARDENING_STATES = [
  "enabled",
  "disabled",
  "partial",
  "unknown",
  "not_applicable",
] as const;

/** ELF rows, in report order. */
export const ELF_HARDENING_PROPERTIES = [
  "pie",
  "nx",
  "relro",
  "stack_protector",
  "fortify",
  "cet_ibt_shstk",
  "aarch64_bti_pac",
  "rpath",
  "runpath",
  "stripped",
] as const;

/** PE rows, in report order. */
export const PE_HARDENING_PROPERTIES = [
  "dynamic_base",
  "high_entropy_va",
  "nx_compat",
  "force_integrity",
  "no_seh",
  "guard_cf",
  "cfg_instrumented",
  "authenticode_present",
  "debug_record_present",
] as const;

/** Mach-O rows, in report order. One row per slice. */
export const MACHO_HARDENING_PROPERTIES = [
  "pie",
  "allow_stack_execution",
  "no_heap_execution",
  "restrict_segment",
  "code_signature_present",
  "encrypted",
  "arm64e",
  "stack_protector",
  "hardened_runtime",
] as const;

export const BINARY_HARDENING_PROPERTIES = [
  ...new Set([
    ...ELF_HARDENING_PROPERTIES,
    ...PE_HARDENING_PROPERTIES,
    ...MACHO_HARDENING_PROPERTIES,
  ]),
] as const;
export type BinaryHardeningProperty =
  (typeof BINARY_HARDENING_PROPERTIES)[number];

export const BINARY_HARDENING_FORMATS = ["elf", "pe", "mach-o"] as const;
export type BinaryHardeningFormat = (typeof BINARY_HARDENING_FORMATS)[number];

/** Property order a parsed image of this format must report. */
export const hardeningPropertiesFor = (
  format: BinaryHardeningFormat,
): readonly BinaryHardeningProperty[] => {
  switch (format) {
    case "elf":
      return ELF_HARDENING_PROPERTIES;
    case "pe":
      return PE_HARDENING_PROPERTIES;
    case "mach-o":
      return MACHO_HARDENING_PROPERTIES;
  }
};

const locationSchema = z.strictObject({ offset: uint, bytes: uint.min(1) });

const rowSchema = z.strictObject({
  property: z.enum(BINARY_HARDENING_PROPERTIES),
  state: z.enum(BINARY_HARDENING_STATES),
  confidence: z.enum(["observed", "derived"]),
  basis: z.string().min(1),
  location: locationSchema.nullable(),
  note: z
    .string()
    .min(1)
    .max(MAX_BINARY_HARDENING_SYMBOL_NAME_BYTES)
    .nullable(),
  next_probe: z.string().min(1).nullable(),
});
export type BinaryHardeningRow = z.infer<typeof rowSchema>;

const sliceSchema = z.strictObject({
  index: uint,
  // A failed FAT64 slice may declare an offset or size of 2^32 or more.
  file_offset: safeNonNegative,
  // A failed fat slice may declare size 0. Parsed slices are checked later.
  size: safeNonNegative,
  cpu_type: z.number().int(),
  cpu_subtype: z.number().int(),
  architecture: z.string().min(1),
});
export type BinaryHardeningSlice = z.infer<typeof sliceSchema>;

const imageSchema = z.strictObject({
  format: z.enum(BINARY_HARDENING_FORMATS),
  status: z.enum(["parsed", "malformed", "unknown"]),
  reason: z.string().min(1).nullable(),
  /** CPU family. `machine` and `slice.architecture` keep the exact identity. */
  architecture: z
    .enum(BINARY_ARCHITECTURES)
    .exclude([...RAW_ONLY_ARCHITECTURES])
    .nullable(),
  bits: z.union([z.literal(32), z.literal(64)]).nullable(),
  byte_order: z.enum(["little", "big"]).nullable(),
  machine: uint.nullable(),
  slice: sliceSchema.nullable(),
  rows: z.array(rowSchema),
});
export type BinaryHardeningImage = z.infer<typeof imageSchema>;

/**
 * Facts this inspection does not establish. A missing import is not evidence
 * that the protection was left out of the build.
 */
export const BINARY_HARDENING_LIMITATIONS = [
  "This inspection reads headers, program tables, dynamic symbols, and imports. It does not execute the image or assess exploitability.",
  "A missing stack-protector or fortify symbol does not establish that the protection is absent.",
  "An undefined stack-protector or fortify symbol is a sign that some code uses the protection, not proof that all code does.",
  "Authenticode and Mach-O code-signature rows report table or load-command presence, not signature validity.",
  "PE control-flow guard state is the GuardFlags linker claim, not a check that CFG checks run.",
  "Mach-O hardened runtime is not read here. inspect_signature owns CodeDirectory flags.",
] as const;

const artifactSchema = z.strictObject({
  path: absoluteLocalPathStringSchema,
  sha256: digestSchema,
  bytes: z.number().int().min(0).max(MAX_INSPECT_BINARY_HARDENING_FILE_BYTES),
});

/** One file, or one image per Mach-O slice, with a row for each property. */
export const binaryHardeningSchema = z.strictObject({
  artifact: artifactSchema,
  format: z.enum(BINARY_HARDENING_FORMATS),
  images: z.array(imageSchema).min(1),
  limitations: z.array(z.string().min(1)),
});
export type BinaryHardening = z.infer<typeof binaryHardeningSchema>;
