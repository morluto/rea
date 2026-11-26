import { z } from "zod";
import type { AnalysisParameterLimit } from "../analysisSettings.js";
import { ARCHITECTURE_VARIANT_NAMES } from "../architectureVariant.js";
import { coverageStatusSchema } from "../coverage.js";
import { digestSchema } from "../digests.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";
import { BINARY_ARCHITECTURES } from "../rawBinary.js";

const uint = z.number().int().min(0).max(0xffffffff);
const hexAddress = z.string().regex(/^0x[0-9a-f]+$/u);

/** Smallest caller-selected file read budget (bytes). */
export const MIN_FIRMWARE_ARCH_FILE_BYTES = 16;
/** Default caller-selected file read budget: 64 MiB. */
export const DEFAULT_FIRMWARE_ARCH_FILE_BYTES = 64 * 1024 * 1024;
/** Maximum caller-selected file read budget: 256 MiB. */
export const MAX_FIRMWARE_ARCH_FILE_BYTES = 256 * 1024 * 1024;

/** Smallest caller-selected scan window (bytes). */
export const MIN_FIRMWARE_ARCH_SCAN_BYTES = 64;
/** Default caller-selected scan window: 4 MiB. */
export const DEFAULT_FIRMWARE_ARCH_SCAN_BYTES = 4 * 1024 * 1024;
/** Maximum caller-selected scan window: 64 MiB. */
export const MAX_FIRMWARE_ARCH_SCAN_BYTES = 64 * 1024 * 1024;

export const FIRMWARE_ARCH_CANDIDATE_BUDGETS = {
  max_file_bytes: {
    minimum: MIN_FIRMWARE_ARCH_FILE_BYTES,
    maximum: MAX_FIRMWARE_ARCH_FILE_BYTES,
    default_value: DEFAULT_FIRMWARE_ARCH_FILE_BYTES,
  },
  max_scan_bytes: {
    minimum: MIN_FIRMWARE_ARCH_SCAN_BYTES,
    maximum: MAX_FIRMWARE_ARCH_SCAN_BYTES,
    default_value: DEFAULT_FIRMWARE_ARCH_SCAN_BYTES,
  },
} as const;

export const firmwareArchBudgetLimit = (
  parameter: keyof typeof FIRMWARE_ARCH_CANDIDATE_BUDGETS,
  effectiveValue: number,
): AnalysisParameterLimit => ({
  control_kind: "parameter",
  parameter,
  effective_value: effectiveValue,
  unit: "bytes",
  ...FIRMWARE_ARCH_CANDIDATE_BUDGETS[parameter],
  applies_at: "next_call",
});

export const FIRMWARE_DETECTOR_IDS = [
  "uimage-header",
  "embedded-elf-census",
  "cortex-m-vector-table",
  "instruction-signature-census",
] as const;
export type FirmwareDetectorId = (typeof FIRMWARE_DETECTOR_IDS)[number];

export const FIRMWARE_CPU_FAMILIES = [
  "x86",
  "x86_64",
  "arm",
  "arm64",
  "mips",
  "mips64",
  "powerpc",
  "riscv",
  "xtensa",
  "m68k",
  "6502",
  "sh",
  "sparc",
  "sparc64",
  "microblaze",
  "nios2",
  "arc",
  "avr32",
  "hexagon",
  "other",
] as const;
export type FirmwareCpuFamily = (typeof FIRMWARE_CPU_FAMILIES)[number];

export const FIRMWARE_WORD_SIZES = [8, 16, 32, 64, "unknown"] as const;
export type FirmwareWordSize = (typeof FIRMWARE_WORD_SIZES)[number];

export const FIRMWARE_BYTE_ORDERS = ["little", "big", "unknown"] as const;
export type FirmwareByteOrder = (typeof FIRMWARE_BYTE_ORDERS)[number];

export const FIRMWARE_CANDIDATE_CONFIDENCES = [
  "observed",
  "derived",
  "inferred",
] as const;
export type FirmwareCandidateConfidence =
  (typeof FIRMWARE_CANDIDATE_CONFIDENCES)[number];

export const inspectFirmwareArchitectureCandidatesInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute local path to a headerless firmware blob, flash dump, or container image.",
  ),
  max_file_bytes: z
    .number()
    .int()
    .min(MIN_FIRMWARE_ARCH_FILE_BYTES)
    .max(MAX_FIRMWARE_ARCH_FILE_BYTES)
    .default(DEFAULT_FIRMWARE_ARCH_FILE_BYTES)
    .describe("Whole-file admission ceiling in bytes (default 64 MiB)."),
  max_scan_bytes: z
    .number()
    .int()
    .min(MIN_FIRMWARE_ARCH_SCAN_BYTES)
    .max(MAX_FIRMWARE_ARCH_SCAN_BYTES)
    .default(DEFAULT_FIRMWARE_ARCH_SCAN_BYTES)
    .describe(
      "Contiguous prefix bytes examined by embedded header and opcode detectors (default 4 MiB).",
    ),
});
export type InspectFirmwareArchitectureCandidatesInput = z.infer<
  typeof inspectFirmwareArchitectureCandidatesInputSchema
>;

export const fileOffsetRangeSchema = z.strictObject({
  start: uint,
  end: uint,
});
export type FileOffsetRange = z.infer<typeof fileOffsetRangeSchema>;

const wordSizeSchema = z.union([
  z.literal(8),
  z.literal(16),
  z.literal(32),
  z.literal(64),
  z.literal("unknown"),
]);

export const rawBinarySuggestionSchema = z.strictObject({
  admitted_today: z.boolean(),
  open_binary_arguments: z
    .strictObject({
      format: z.literal("raw-binary"),
      architecture: z.enum(BINARY_ARCHITECTURES),
      architecture_variant: z.enum(ARCHITECTURE_VARIANT_NAMES).optional(),
      base_address: hexAddress.optional(),
      vector_table_address: hexAddress.optional(),
      entry_point_required: z.boolean(),
    })
    .nullable(),
  rizin_decoder_hint: z
    .strictObject({
      asm_arch: z.string().min(1),
      asm_bits: z.union([z.literal(16), z.literal(32), z.literal(64)]),
    })
    .nullable(),
  note: z.string(),
});
export type RawBinarySuggestion = z.infer<typeof rawBinarySuggestionSchema>;

export const cortexMLoadBaseCandidateSchema = z.strictObject({
  table_file_offset: uint,
  base_address: hexAddress,
  vector_table_address: hexAddress,
  initial_sp: hexAddress,
  reset_vector: hexAddress,
  reset_code_address: hexAddress,
  valid_exception_vectors: z.number().int().min(1),
  basis: z.enum(["standard-flash-window", "page-aligned-minimum-handler"]),
});
export type CortexMLoadBaseCandidate = z.infer<
  typeof cortexMLoadBaseCandidateSchema
>;

export const firmwareArchitectureCandidateSchema = z.strictObject({
  rank: z.number().int().min(1),
  cpu_family: z.enum(FIRMWARE_CPU_FAMILIES),
  isa_mode: z.enum(["arm", "thumb", "standard"]).optional(),
  word_size: wordSizeSchema,
  byte_order: z.enum(FIRMWARE_BYTE_ORDERS),
  detector: z.enum(FIRMWARE_DETECTOR_IDS),
  confidence: z.enum(FIRMWARE_CANDIDATE_CONFIDENCES),
  rationale: z.string(),
  locations: z.array(fileOffsetRangeSchema),
  omitted_locations: z.number().int().min(0),
  load_base_candidates: z.array(cortexMLoadBaseCandidateSchema).optional(),
  raw_binary_support: rawBinarySuggestionSchema,
});
export type FirmwareArchitectureCandidate = z.infer<
  typeof firmwareArchitectureCandidateSchema
>;

export const uimageCandidateObservationSchema = z.strictObject({
  file_offset: uint,
  header_end: uint,
  raw_ih_arch: z.number().int().min(0).max(255),
  ih_arch_name: z.string(),
  raw_ih_comp: z.number().int().min(0).max(255),
  ih_comp_name: z.string(),
  ih_type_name: z.string(),
  load_address: hexAddress,
  entry_point: hexAddress,
  payload_size: uint,
  image_name: z.string().nullable(),
  payload_mapping_note: z.string(),
});
export type UImageCandidateObservation = z.infer<
  typeof uimageCandidateObservationSchema
>;

export const elfMachineTallySchema = z.strictObject({
  machine: z.number().int().min(0).max(0xffff),
  cpu_family: z.enum(FIRMWARE_CPU_FAMILIES),
  elf_class: z.union([z.literal(32), z.literal(64)]),
  byte_order: z.enum(["little", "big"]),
  count: z.number().int().min(1),
  sample_locations: z.array(fileOffsetRangeSchema),
  omitted_locations: z.number().int().min(0),
});
export type ElfMachineTally = z.infer<typeof elfMachineTallySchema>;

export const instructionSignatureHitSchema = z.strictObject({
  id: z.string().min(1),
  mnemonic: z.string().min(1),
  alignment: z.union([z.literal(1), z.literal(2), z.literal(4)]),
  hits: z.number().int().min(0),
});

export const instructionCensusProfileSchema = z.strictObject({
  profile_id: z.string().min(1),
  cpu_family: z.enum(FIRMWARE_CPU_FAMILIES),
  isa_mode: z.enum(["arm", "thumb", "standard"]),
  word_size: z.union([z.literal(32), z.literal(64), z.literal("unknown")]),
  byte_order: z.enum(["little", "big"]),
  alignment: z.union([z.literal(1), z.literal(2), z.literal(4)]),
  total_hits: z.number().int().min(0),
  distinct_signatures_matched: z.number().int().min(0),
  density_per_kib: z.number().min(0),
  meets_threshold: z.boolean(),
  signatures: z.array(instructionSignatureHitSchema),
});
export type InstructionCensusProfile = z.infer<
  typeof instructionCensusProfileSchema
>;

export const detectorRunSummarySchema = z.strictObject({
  detector: z.enum(FIRMWARE_DETECTOR_IDS),
  examined_bytes: uint,
  status: z.enum(["matched", "no_match", "mixed", "skipped_empty"]),
  detail: z.string(),
});
export type DetectorRunSummary = z.infer<typeof detectorRunSummarySchema>;

export const firmwareArchitectureCandidatesSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    sha256: digestSchema,
    bytes: uint,
  }),
  status: z.enum(["candidates_found", "unknown"]),
  coverage: z.strictObject({
    status: coverageStatusSchema,
    examined_bytes: uint,
    total_bytes: uint,
  }),
  detectors: z.array(detectorRunSummarySchema),
  candidates: z.array(firmwareArchitectureCandidateSchema),
  uimage_headers: z.strictObject({
    total: z.number().int().min(0),
    omitted: z.number().int().min(0),
    items: z.array(uimageCandidateObservationSchema),
  }),
  elf_census: z.strictObject({
    total_valid_headers: z.number().int().min(0),
    consensus: z.enum(["absent", "unanimous", "majority", "mixed"]),
    tallies: z.array(elfMachineTallySchema),
  }),
  instruction_census: z.strictObject({
    examined_bytes: uint,
    leader_profile_id: z.string().nullable(),
    runner_up_profile_id: z.string().nullable(),
    margin_hits: z.number().int().min(0).nullable(),
    profiles: z.array(instructionCensusProfileSchema),
  }),
  limitations: z.array(z.string()),
});
export type FirmwareArchitectureCandidates = z.infer<
  typeof firmwareArchitectureCandidatesSchema
>;

const RIZIN_ARCH_BY_FAMILY: Partial<Record<FirmwareCpuFamily, string>> = {
  x86: "x86",
  x86_64: "x86",
  arm: "arm",
  arm64: "arm",
  mips: "mips",
  mips64: "mips",
  powerpc: "ppc",
  riscv: "riscv",
  xtensa: "xtensa",
  m68k: "m68k",
  "6502": "6502",
  sh: "sh",
};

type LeAdmittedFamily = "x86" | "x86_64" | "arm" | "arm64" | "6502";
const LE_ADMITTED_FAMILIES: ReadonlySet<string> = new Set<LeAdmittedFamily>([
  "x86",
  "x86_64",
  "arm",
  "arm64",
  "6502",
]);
const isLeAdmittedFamily = (
  family: FirmwareCpuFamily,
): family is LeAdmittedFamily => LE_ADMITTED_FAMILIES.has(family);

const buildThumbRawBinarySuggestion = (
  byteOrder: FirmwareByteOrder,
  topBaseCandidate?: CortexMLoadBaseCandidate,
): RawBinarySuggestion => {
  if (byteOrder === "big") {
    return {
      admitted_today: false,
      open_binary_arguments: null,
      rizin_decoder_hint: { asm_arch: "arm", asm_bits: 16 },
      note: "Big-endian ARM is not admitted by raw-binary.",
    };
  }
  if (byteOrder === "little" && topBaseCandidate !== undefined) {
    const base = topBaseCandidate.base_address;
    const vtor = topBaseCandidate.vector_table_address;
    return {
      admitted_today: true,
      open_binary_arguments: {
        format: "raw-binary",
        architecture: "arm",
        architecture_variant: "armv7-m",
        base_address: base,
        ...(vtor !== base ? { vector_table_address: vtor } : {}),
        entry_point_required: false,
      },
      rizin_decoder_hint: { asm_arch: "arm", asm_bits: 16 },
      note: "M-profile Thumb raw images open with architecture 'arm', a caller-selected M-profile architecture_variant (such as 'armv7-m'), and an explicit base_address; omit entry_point to derive Reset from the vector table.",
    };
  }
  return {
    admitted_today: false,
    open_binary_arguments: null,
    rizin_decoder_hint: { asm_arch: "arm", asm_bits: 16 },
    note: "Thumb opcodes alone do not establish an ARM M-profile, base_address, or vector table; open_binary admits Thumb raw-binary images only when the caller supplies an M-profile architecture_variant, base_address, and an even entry_point (or a verified vector table).",
  };
};

const computeRizinHint = (
  cpuFamily: FirmwareCpuFamily,
  wordSize: FirmwareWordSize,
): RawBinarySuggestion["rizin_decoder_hint"] => {
  const arch = RIZIN_ARCH_BY_FAMILY[cpuFamily];
  if (arch === undefined) return null;
  if (cpuFamily === "6502") return { asm_arch: arch, asm_bits: 16 };
  if (wordSize === 16 || wordSize === 32 || wordSize === 64) {
    return { asm_arch: arch, asm_bits: wordSize };
  }
  return null;
};

/** Describe how a proposed CPU candidate maps to current `open_binary` raw-binary admission. */
export const buildRawBinarySuggestion = (options: {
  readonly cpuFamily: FirmwareCpuFamily;
  readonly byteOrder: FirmwareByteOrder;
  readonly wordSize: FirmwareWordSize;
  readonly isaMode?: "arm" | "thumb" | "standard";
  readonly topBaseCandidate?: CortexMLoadBaseCandidate;
}): RawBinarySuggestion => {
  const { cpuFamily, byteOrder, wordSize, isaMode, topBaseCandidate } = options;
  if (cpuFamily === "arm" && isaMode === "thumb") {
    return buildThumbRawBinarySuggestion(byteOrder, topBaseCandidate);
  }
  const rizinHint = computeRizinHint(cpuFamily, wordSize);

  if (isLeAdmittedFamily(cpuFamily) && byteOrder !== "big") {
    const isLittle = byteOrder === "little";
    return {
      admitted_today: isLittle,
      open_binary_arguments: isLittle
        ? {
            format: "raw-binary",
            architecture: cpuFamily,
            entry_point_required: true,
          }
        : null,
      rizin_decoder_hint: rizinHint,
      note: isLittle
        ? `open_binary admits raw-binary ${cpuFamily} (little-endian) when caller supplies entry_point.`
        : `open_binary admits little-endian ${cpuFamily} only; byte order is currently unknown and must be confirmed before opening as raw-binary.`,
    };
  }

  if (cpuFamily === "m68k" && byteOrder !== "little") {
    const isBig = byteOrder === "big";
    return {
      admitted_today: isBig,
      open_binary_arguments: isBig
        ? {
            format: "raw-binary",
            architecture: "m68k",
            entry_point_required: true,
          }
        : null,
      rizin_decoder_hint: rizinHint,
      note: isBig
        ? "open_binary admits big-endian raw-binary m68k when caller supplies an even entry_point."
        : "open_binary admits big-endian m68k only; confirm byte order and an even entry_point.",
    };
  }

  return {
    admitted_today: false,
    open_binary_arguments: null,
    rizin_decoder_hint: rizinHint,
    note: `open_binary format=raw-binary does not currently admit headerless ${cpuFamily}${byteOrder === "big" ? " (big-endian)" : ""} blobs; extract an ELF if present or use execute_rizin_command with explicit decoder flags.`,
  };
};
