import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { GhidraLanguageOverride } from "../config/ghidraLanguageOverride.js";

const MIPS_FP_ABI_SOFT = 3;
const MIPS_ET_REL = 1;
const MIPS_ET_EXEC = 2;
const MIPS_ET_DYN = 3;
const MIPS16_HEADER_ASE = 0x04000000;

/** A distinct compressed shared-image shape; admission still checks every declaration. */
const isGhidraMips16SharedTarget = (target: BinaryTarget): boolean =>
  target.kind === "executable" &&
  target.architecture === "mips" &&
  target.mips.type === MIPS_ET_DYN &&
  (target.mips.flags & 0x0f000000) === MIPS16_HEADER_ASE;

/** Generic MIPS32 permits per-function ISA_MODE; a global 16e processor does not. */
export const ghidraMipsSharedLanguageOverride = (
  target: BinaryTarget,
): GhidraLanguageOverride | undefined =>
  isGhidraMips16SharedTarget(target) && target.architecture === "mips"
    ? {
        languageId: `MIPS:${target.mips.byteOrder === "little" ? "LE" : "BE"}:32:default`,
        compilerSpecId: "default",
      }
    : undefined;

/** Keep family recognition separate from the deliberately bounded Ghidra lane. */
export const ghidraMipsUnsupportedReason = (
  target: BinaryTarget,
): string | null => {
  if (target.kind !== "executable" || target.architecture !== "mips")
    return null;
  const metadata = target.mips;
  if (target.format !== "elf" || metadata === undefined)
    return "MIPS analysis requires ELF header metadata; a family name alone does not select an ISA or ABI.";
  const shared = isGhidraMips16SharedTarget(target);
  if (metadata.elfClass !== 32)
    return "This Ghidra MIPS lane supports ELF32 only; MIPS64 and n64 remain unsupported.";
  if (
    metadata.type !== MIPS_ET_EXEC &&
    metadata.type !== MIPS_ET_REL &&
    !shared
  )
    return "This Ghidra MIPS lane supports ET_EXEC and ET_REL only; shared images and PSP PRX need separate load verification.";
  if ((metadata.flags & 0x0f000000) !== 0 && !shared)
    return "MIPS16, microMIPS and other ASE encodings are outside this standard-instruction MIPS lane.";
  if ((metadata.flags & 0x00ff0000) !== 0)
    return "Machine-specific MIPS variants, including PSP Allegrex, need a separately supported processor profile.";
  if ((metadata.flags & 0xf0000000) !== 0x70000000)
    return "This Ghidra MIPS lane requires EF_MIPS_ARCH_32R2; other ISA revisions need separate verification.";
  if (
    (metadata.flags & 0x0000f000) !== 0x00001000 ||
    (metadata.flags & 0x20) !== 0
  )
    return "This Ghidra MIPS lane requires an explicit o32 ABI; unspecified, n32 and EABI targets remain unsupported.";
  if ((metadata.flags & 0x00000200) !== 0)
    return "EF_MIPS_FP64 requires separate verification of 64-bit floating-point register semantics in this Ghidra lane.";
  if ((metadata.flags & 0x00000400) !== 0)
    return "EF_MIPS_NAN2008 requires separate verification of NaN encoding semantics in this Ghidra lane.";
  if (shared) {
    if ((metadata.flags & 0x40) !== 0)
      return "EF_MIPS_ABI_ON32 declares an unverified ABI for the MIPS16 shared-image lane.";
    const load = metadata.sharedLoad;
    if (load === undefined || load.status !== "complete")
      return `MIPS16 shared images require complete dynamic relocation inspection. ${load?.reason ?? "The source declarations have not been inspected."}`;
    if (load.relocationTypes.some((type) => type !== 0 && type !== 3))
      return "This MIPS16 shared-image lane verifies R_MIPS_NONE and R_MIPS_REL32 only; other dynamic relocation types require separate verification.";
    if (load.symbolRelativeCount !== 0)
      return "Symbol-bearing R_MIPS_REL32 is unsupported: Ghidra normalizes MIPS16 function addresses and can lose the source function-pointer mode tag. Symbol-index-zero REL32 is verified separately.";
  }
  const abi = metadata.abiFlags;
  if (shared && abi === null && (metadata.limitations?.length ?? 0) === 0)
    return null; // Inspected absence leaves FP semantics unknown, never inferred.
  if (abi === undefined || abi === null)
    return [
      "This Ghidra MIPS lane requires an inspected ABI flags record; header flags alone do not establish the floating-point ABI.",
      ...(metadata.limitations ?? []),
    ].join(" ");
  if (abi.version !== 0)
    return "This Ghidra MIPS lane requires ABI flags version 0; newer record semantics are unsupported.";
  if (abi.isaLevel !== 32 || abi.isaRevision !== 2)
    return "MIPS ABI flags must agree with the declared MIPS32r2 ISA.";
  if (abi.gprSize !== 1 || abi.cpr2Size !== 0)
    return "This Ghidra MIPS lane requires 32-bit GPRs and no CPR2; other register modes need separate verification.";
  const hardFloat = abi.cpr1Size === 1 && (abi.fpAbi === 1 || abi.fpAbi === 5);
  const softFloat = abi.cpr1Size === 0 && abi.fpAbi === MIPS_FP_ABI_SOFT;
  if (!hardFloat && !softFloat)
    return "This Ghidra MIPS lane admits double-precision or FPXX ABI declarations with 32-bit CPR1, or soft-float without CPR1; single-float, FP64 and unspecified modes need separate verification.";
  if (abi.isaExtension !== 0 || abi.ases !== (shared ? 0x400 : 0))
    return "MIPS ABI flags declare an ISA extension or ASE outside this profile's verified instruction declarations.";
  // MIPS_AFL_FLAGS1_ODDSPREG (bit 0) is the GCC and LLVM default for MIPS32 o32
  // whatever the FP ABI; soft-float objects from both carry it. With no CPR1 it
  // selects nothing, so it is accepted for soft-float as well as hard-float.
  if ((abi.flags1 & ~1) !== 0 || abi.flags2 !== 0)
    return "MIPS ABI flags contain unsupported general flags.";
  return null;
};

/** Soft-float prototype policy applied by ReaGhidraMipsSoftFloat.java after analysis. */
export const GHIDRA_MIPS_SOFT_FLOAT_STORAGE = "o32-soft-float-prototype-v1";

/** Whether the admitted target declares the soft-float o32 ABI. */
export const isGhidraMipsSoftFloatTarget = (target: BinaryTarget): boolean =>
  target.kind === "executable" &&
  target.architecture === "mips" &&
  target.mips?.abiFlags?.cpr1Size === 0 &&
  target.mips.abiFlags.fpAbi === MIPS_FP_ABI_SOFT;

/** Prototype outcome the post-analysis script records for the bridge handshake. */
export interface GhidraMipsSoftFloatReport {
  readonly policy: typeof GHIDRA_MIPS_SOFT_FLOAT_STORAGE;
  readonly functions: number;
  readonly definitions: number;
}

/** Fail closed unless soft-float storage ran exactly for soft-float targets. */
export const ghidraMipsSoftFloatFailure = (
  expected: boolean,
  report: GhidraMipsSoftFloatReport | undefined,
): string | undefined =>
  expected === (report !== undefined)
    ? undefined
    : expected
      ? "The Ghidra session did not report the committed MIPS soft-float prototype."
      : "The Ghidra session reported MIPS soft-float storage that the profile did not commit.";

/** Keep REA's soft-float prototype distinct from Ghidra's hard-float o32 model. */
export const ghidraMipsSoftFloatLimitations = (
  expected: boolean,
  report?: GhidraMipsSoftFloatReport,
): readonly string[] =>
  expected
    ? [
        "Soft-float o32: Ghidra's MIPS32 compiler specifications model hard-float o32 only. After analysis REA installs a program-specific `__rea_soft_float` prototype, derived from the default o32 model without its floating-point registers and rules, and assigns it to every function, external function and function-pointer definition whose declared types use float or double, so those values keep their types and use integer registers and stack slots.",
        ...(report === undefined
          ? []
          : [
              `Soft-float prototype outcome: ${report.functions} functions and ${report.definitions} function-pointer definitions use __rea_soft_float.`,
            ]),
      ]
    : [];

/** Ghidra-placed relocatable objects need coordinates and relocation caveats. */
export const ghidraMipsRelocatableLimitations = (
  target: BinaryTarget,
): readonly string[] =>
  target.kind === "executable" &&
  target.architecture === "mips" &&
  target.mips?.type === MIPS_ET_REL
    ? [
        "Relocatable MIPS ELF: Ghidra assigns each allocated section an analysis address and applies the object's relocations there. Returned addresses are analysis coordinates, not the addresses a kernel or linker would choose at load time.",
        "Undefined symbols (for example kernel exports used by a module) are placed in Ghidra's EXTERNAL block; their definitions are outside this artifact. inspect_native_load_image reports each relocation with Ghidra's status; HI16 entries report PARTIAL because Ghidra applies them together with their paired LO16.",
      ]
    : [];

/** Shared-image results are analysis observations, not dynamic-loader execution. */
export const ghidraMipsSharedLimitations = (
  target: BinaryTarget,
): readonly string[] =>
  isGhidraMips16SharedTarget(target) && target.architecture === "mips"
    ? [
        "MIPS16 shared ELF: the endian-matched generic MIPS32 language uses the provider's per-address ISA_MODE context. The program language variant is not the instruction's encoding mode.",
        "Shared-image addresses are Ghidra analysis coordinates, not runtime addresses. The source bytes remain unchanged; inspect_native_load_image retains original relocation bytes, loaded memory bytes and provider relocation status. External GOT bindings remain unverified without their defining images.",
        ...(target.mips.abiFlags === null
          ? [
              "No MIPS ABI flags record was found in the completely examined declaration tables. The header declares o32 but does not establish the floating-point ABI; the default compiler specification does not verify floating-point argument or return storage.",
            ]
          : []),
      ]
    : [];

/** Commit source ELF interpretation without confusing target ISA with host CPU. */
export const ghidraMipsProfileParameters = (
  target: BinaryTarget,
): Readonly<Record<string, JsonValue>> => {
  if (
    target.kind !== "executable" ||
    target.architecture !== "mips" ||
    target.mips === undefined
  )
    return {};
  const abi = target.mips.abiFlags;
  return {
    mips_elf: {
      elf_class: target.mips.elfClass,
      byte_order: target.mips.byteOrder,
      type: target.mips.type,
      flags: target.mips.flags,
      ...(target.mips.limitations === undefined
        ? {}
        : { abi_flags_limitations: [...target.mips.limitations] }),
      abi_flags:
        abi === undefined || abi === null
          ? null
          : {
              version: abi.version,
              isa_level: abi.isaLevel,
              isa_revision: abi.isaRevision,
              gpr_size: abi.gprSize,
              cpr1_size: abi.cpr1Size,
              cpr2_size: abi.cpr2Size,
              fp_abi: abi.fpAbi,
              isa_extension: abi.isaExtension,
              ases: abi.ases,
              flags1: abi.flags1,
              flags2: abi.flags2,
            },
      ...(target.mips.sharedLoad === undefined
        ? {}
        : {
            shared_load:
              target.mips.sharedLoad.status === "complete"
                ? {
                    status: "complete",
                    relocation_count: target.mips.sharedLoad.relocationCount,
                    relocation_types: [
                      ...target.mips.sharedLoad.relocationTypes,
                    ],
                    symbol_relative_count:
                      target.mips.sharedLoad.symbolRelativeCount,
                  }
                : {
                    status: "unavailable",
                    reason: target.mips.sharedLoad.reason,
                  },
          }),
    },
    ...(isGhidraMipsSoftFloatTarget(target)
      ? { mips_soft_float_storage: GHIDRA_MIPS_SOFT_FLOAT_STORAGE }
      : {}),
    instruction_context_evidence: "per-address-isa-mode-v1",
    mips_support_lane: isGhidraMips16SharedTarget(target)
      ? "elf32-dyn-o32-arch32r2-mips16-local-rel32-v1"
      : target.mips.type === MIPS_ET_REL
        ? "elf32-rel-o32-arch32r2-standard-v1"
        : "elf32-exec-o32-arch32r2-standard-v3",
  };
};
