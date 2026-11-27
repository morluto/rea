import { z } from "zod";

import type { AnalysisProfileCommitment } from "../analysisProfile.js";
import type { BinaryArchitecture } from "../binaryTargetTypes.js";
import {
  machoKnownArm64Subtype,
  machoKnownX86_64Subtype,
} from "./machoCpuIdentity.js";

/** Provider-neutral observed identity of one Mach-O image selected from a source. */
export const machoTargetSelectionSchema = z
  .strictObject({
    kind: z.literal("macho-selected-image-v1"),
    container: z.enum(["thin", "fat"]),
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    byte_length: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    cpu_type: z.number().int().nonnegative().max(0xffff_ffff),
    /** Keep the complete raw subtype, including capability bits. */
    cpu_subtype: z.number().int().nonnegative().max(0xffff_ffff),
    container_table_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
  })
  .superRefine((selection, context) => {
    // Each refusal names the rule for its container, so the selection can be
    // corrected without the canonical schema.
    const problem =
      selection.container === "thin"
        ? selection.offset !== 0 || selection.container_table_sha256 !== null
          ? "A thin Mach-O selection has offset 0 and container_table_sha256 null"
          : undefined
        : selection.container_table_sha256 === null
          ? "A fat Mach-O selection requires the container_table_sha256 of its fat header table"
          : undefined;
    if (problem !== undefined)
      context.addIssue({ code: "custom", message: problem });
  });

export type MachoTargetSelection = z.infer<typeof machoTargetSelectionSchema>;

/** Read only the provider-neutral fact committed by an analysis profile. */
export const profileMachoTargetSelection = (
  profile: AnalysisProfileCommitment | undefined,
): MachoTargetSelection | undefined => {
  const raw = profile?.parameters.target_selection;
  if (raw === undefined) return undefined;
  const parsed = machoTargetSelectionSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
};

/** mach/machine.h CPU types of the families a Mach-O slice can be selected by. */
export const MACHO_CPU_TYPES = {
  x86: 7,
  x86_64: 0x01000007,
  arm: 12,
  arm64: 0x0100000c,
} as const satisfies Partial<Record<BinaryArchitecture, number>>;

/** Caller-selected architecture of one universal Mach-O slice. */
export const machoSliceArchitectureSchema = z
  .enum(["x86", "x86_64", "arm", "arm64", "arm64e", "arm64e.x1"])
  .describe(
    "Architecture of the slice to read from a universal (FAT) Mach-O. Required for universal files and rejected for every other image. A CPU family with one slice is selected by its family name; arm64e and arm64e.x1 each read only a slice of that subtype, as lipo -thin does. When several slices share a family, the value must name the slice's subtype: arm64 reads the arm64 or arm64v8 slice, and x86_64 the x86_64 slice but not x86_64h; capability bits are ignored. A value that matches no slice or several is refused.",
  ) satisfies z.ZodType<keyof typeof MACHO_CPU_TYPES | "arm64e" | "arm64e.x1">;
export type MachoSliceArchitecture = z.infer<
  typeof machoSliceArchitectureSchema
>;

/**
 * Whether a value names an arm64 subtype rather than a CPU family, so it reads
 * only a slice of that subtype, even as its family's only slice.
 */
export const machoSliceNamesSubtypeOnly = (
  architecture: MachoSliceArchitecture,
): architecture is "arm64e" | "arm64e.x1" =>
  architecture === "arm64e" || architecture === "arm64e.x1";

/** The CPU family whose slices an architecture value selects. */
export const machoSliceFamily = (
  architecture: MachoSliceArchitecture,
): keyof typeof MACHO_CPU_TYPES =>
  machoSliceNamesSubtypeOnly(architecture) ? "arm64" : architecture;

/**
 * The architecture value that names a slice's subtype exactly, as
 * `lipo -thin` does, or undefined when no accepted value names it. Capability
 * bits are ignored, and `arm64v8` reads as `arm64`.
 */
export const machoSliceSubtypeSelector = (
  cpuType: number,
  cpuSubtype: number,
): MachoSliceArchitecture | undefined => {
  if (cpuType === MACHO_CPU_TYPES.arm64)
    switch (machoKnownArm64Subtype(cpuSubtype)) {
      case "arm64":
      case "arm64v8":
        return "arm64";
      case "arm64e":
        return "arm64e";
      case "arm64e.x1":
        return "arm64e.x1";
      default:
        return undefined;
    }
  if (cpuType === MACHO_CPU_TYPES.x86_64)
    return machoKnownX86_64Subtype(cpuSubtype) === "x86_64"
      ? "x86_64"
      : undefined;
  return undefined;
};

/**
 * Whether a reported universal slice answers the caller's architecture value.
 * Only a universal image has a selection, and only one needs a value. The
 * slice must be of the value's CPU family; arm64e and arm64e.x1 also require
 * their subtype, while a family name may read the family's only slice
 * whatever its subtype.
 */
export const machoSelectionAnswersArchitecture = (
  selection:
    | { readonly cpu_type: number; readonly cpu_subtype: number }
    | null
    | undefined,
  architecture: MachoSliceArchitecture | undefined,
): boolean =>
  selection === null || selection === undefined || architecture === undefined
    ? (selection === null || selection === undefined) ===
      (architecture === undefined)
    : selection.cpu_type === MACHO_CPU_TYPES[machoSliceFamily(architecture)] &&
      (!machoSliceNamesSubtypeOnly(architecture) ||
        machoSliceSubtypeSelector(selection.cpu_type, selection.cpu_subtype) ===
          architecture);

/** Confirm the selected header's CPU family agrees with the caller's request. */
export const machoTargetSelectionMatchesArchitecture = (
  selection: MachoTargetSelection,
  architecture: BinaryArchitecture,
): boolean => {
  const cpuTypes: Partial<Record<BinaryArchitecture, number>> = MACHO_CPU_TYPES;
  return cpuTypes[architecture] === selection.cpu_type;
};

/** Whether a file-offset range lies inside the selected image and its file. */
export const machoSelectionContainsRange = (
  selection: MachoTargetSelection,
  fileBytes: number,
  offset: number,
  bytes: number,
): boolean =>
  selection.offset + selection.byte_length <= fileBytes &&
  offset >= selection.offset &&
  bytes <= selection.offset + selection.byte_length - offset;

/** Confirm the parser-observed container agrees with the target's declared format. */
export const machoTargetSelectionMatchesFormat = (
  selection: MachoTargetSelection,
  format: "mach-o" | "mach-o-universal",
): boolean => selection.container === (format === "mach-o" ? "thin" : "fat");

/** Exact range and raw CPU identity equality; null is never treated as a match. */
export const sameMachoTargetSelection = (
  left: MachoTargetSelection | undefined,
  right: MachoTargetSelection | undefined,
): boolean =>
  left !== undefined &&
  right !== undefined &&
  left.container === right.container &&
  left.offset === right.offset &&
  left.byte_length === right.byte_length &&
  left.cpu_type === right.cpu_type &&
  left.cpu_subtype === right.cpu_subtype &&
  left.container_table_sha256 === right.container_table_sha256;

/**
 * Evidence subject format of a metadata report that read an ELF, PE, thin
 * Mach-O or universal slice, or a WebAssembly module, which is a file as for WABT.
 */
export const metadataReportSubjectFormat = (report: {
  readonly format: "elf" | "pe" | "macho" | "wasm";
  readonly selected_slice?: MachoTargetSelection;
}): "elf" | "pe" | "mach-o" | "mach-o-universal" | "file" =>
  report.format === "wasm"
    ? "file"
    : report.format !== "macho"
      ? report.format
      : report.selected_slice === undefined
        ? "mach-o"
        : "mach-o-universal";

/**
 * Whether a metadata report's own container and CPU agree with the universal
 * slice it says it read: the report must be Mach-O and name the slice's CPU family.
 */
export const selectedSliceAgreesWithReport = (
  selection: MachoTargetSelection,
  format: "elf" | "pe" | "macho" | "wasm",
  architecture: BinaryArchitecture | undefined,
): boolean =>
  selection.container === "fat" &&
  format === "macho" &&
  architecture !== undefined &&
  machoTargetSelectionMatchesArchitecture(selection, architecture);
