import { isDeepStrictEqual } from "node:util";
import type { GhidraLanguageOverride } from "../config/ghidraLanguageOverride.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { loongarchObjectAbiConvention } from "../domain/loongarchAbi.js";

const ET_EXEC = 2;
const ET_DYN = 3;

/**
 * Ghidra 12.1.4's ELF loader selects this language for an ELF64 LoongArch image
 * whose `e_flags` modifiers are `.011`, but its `loongarch.opinion` also maps
 * the soft-float modifier (`.001`) to `lp64d`. REA pins the language so the
 * floating-point ABI the profile verified is the one that gets imported.
 */
export const GHIDRA_LOONGARCH_LANGUAGE: GhidraLanguageOverride = {
  languageId: "Loongarch:LE:64:lp64d",
  compilerSpecId: "default",
};

/** Keep family recognition separate from the deliberately bounded Ghidra lane. */
export const ghidraLoongArchUnsupportedReason = (
  target: BinaryTarget,
): string | null => {
  if (target.kind !== "executable" || target.architecture !== "loongarch")
    return null;
  const missingMetadata =
    "LoongArch analysis requires ELF header metadata; a family name alone does not select a floating-point ABI or object ABI version.";
  if (target.format !== "elf") return missingMetadata;
  const metadata = target.loongarch;
  if (metadata === undefined) return missingMetadata;
  if (metadata.elfClass !== 64)
    return "This Ghidra LoongArch lane supports ELF64 only; the 32-bit ILP32 psABI and Ghidra's ilp32 languages have no verified analysis lane.";
  if (metadata.byteOrder !== "little")
    return "This Ghidra LoongArch lane supports little-endian images only; Ghidra 12.1.4 ships no big-endian LoongArch language.";
  if (metadata.type !== ET_EXEC && metadata.type !== ET_DYN)
    return `This Ghidra LoongArch lane supports ET_EXEC and ET_DYN only; ${
      metadata.type === 1
        ? "relocatable objects need per-section analysis coordinates and relocation verification"
        : `e_type ${metadata.type} needs separate load verification`
    }.`;
  if (metadata.undeclaredFlags !== 0)
    return `LoongArch e_flags declares bits outside the verified lane (0x${metadata.undeclaredFlags.toString(
      16,
    )}); reserved or newer declarations are not treated as compatible with this profile.`;
  switch (metadata.floatAbi) {
    case "soft":
      return "e_flags declares the soft-float (LP64S) argument ABI; Ghidra 12.1.4 ships no soft-float LoongArch compiler specification, so its decompiler would misstate floating-point argument storage.";
    case "single":
      return "e_flags declares the single-float (LP64F) argument ABI; only the double-float LP64D lane is verified, and the LP64F compiler specification remains unverified.";
    case "unspecified":
      return "e_flags declares no floating-point ABI modifier (bits 0-2 are zero), so argument and return storage are unknown rather than defaulted.";
    case "reserved":
      return "e_flags declares a reserved floating-point ABI modifier (bits 0-2 are 4-7, which the psABI leaves undefined).";
    case "double":
      return null;
  }
};

/**
 * The language the lane imports with, unless REA_GHIDRA_LANGUAGE_ID already
 * selected one through the committed profile.
 */
export const ghidraLoongArchLanguage = (
  target: BinaryTarget,
): GhidraLanguageOverride | undefined =>
  target.kind === "executable" &&
  target.architecture === "loongarch" &&
  ghidraLoongArchUnsupportedReason(target) === null
    ? GHIDRA_LOONGARCH_LANGUAGE
    : undefined;

/**
 * Commit source ELF interpretation without confusing target ISA with host CPU.
 * The token is built from the declared fields, so a new load model or ABI
 * version must add a value rather than silently reuse another lane.
 */
export const ghidraLoongArchProfileParameters = (
  target: BinaryTarget,
): Readonly<Record<string, JsonValue>> => {
  if (
    target.kind !== "executable" ||
    target.architecture !== "loongarch" ||
    target.format !== "elf" ||
    target.loongarch === undefined
  )
    return {};
  const metadata = target.loongarch;
  return {
    loongarch_elf: {
      elf_class: metadata.elfClass,
      byte_order: metadata.byteOrder,
      type: metadata.type,
      flags: metadata.flags,
      float_abi: metadata.floatAbi,
      object_abi_version: metadata.objectAbiVersion,
      object_abi_convention: loongarchObjectAbiConvention(
        metadata.objectAbiVersion,
      ),
      undeclared_flags: metadata.undeclaredFlags,
    },
    loongarch_support_lane: `elf64-le-${
      metadata.type === ET_DYN ? "dyn" : "exec"
    }-lp64d-objabi-v${metadata.objectAbiVersion}-generic-v1`,
  };
};

/**
 * Bind a committed LoongArch profile to the target being imported: object ABI
 * version selects different dynamic-linker conventions, and both versions
 * share one pinned language, so the language check alone cannot detect a
 * profile resolved for the other version.
 */
export const ghidraLoongArchProfileMismatchReason = (
  target: BinaryTarget,
  parameters: Readonly<Record<string, unknown>>,
  existingProject: boolean,
): string | null => {
  if (target.architecture !== "loongarch" || target.loongarch === undefined)
    return null;
  const expected = ghidraLoongArchProfileParameters(target);
  if (
    !existingProject &&
    expected.loongarch_support_lane !== undefined &&
    parameters.loongarch_support_lane !== expected.loongarch_support_lane
  )
    return "The committed LoongArch analysis lane was resolved for a different target; reopen the target to resolve a new profile.";
  if (
    expected.loongarch_elf !== undefined &&
    !isDeepStrictEqual(parameters.loongarch_elf, expected.loongarch_elf)
  )
    return "The committed LoongArch ELF declarations do not match the current target; reopen the target to resolve a new profile.";
  return null;
};

/** The pinned language is an analysis convention, not proof of the producer. */
export const ghidraLoongArchLimitations = (
  target: BinaryTarget,
): readonly string[] => {
  if (target.kind !== "executable" || target.architecture !== "loongarch")
    return [];
  const metadata = target.loongarch;
  return [
    "LoongArch ELF: REA pins Ghidra's `Loongarch:LE:64:lp64d` language with the `default` compiler specification instead of accepting header auto-selection, whose `loongarch.opinion` maps the soft-float `e_flags` modifier to `lp64d`. The pinned language models the declared LP64D double-float ABI; the pin is an analysis convention, not evidence of the original compiler or of verified instruction semantics.",
    ...(metadata === undefined
      ? []
      : metadata.objectAbiVersion === 1
        ? [
            "e_flags sets `EF_LARCH_OBJABI_V1` (0x40): object ABI v1, the toolchain/distribution convention commonly called the LoongArch new world. Instruction encoding is shared with v0; the declared version selects linker, PLT and dynamic-loader conventions that static analysis does not emulate.",
          ]
        : [
            "e_flags does not set `EF_LARCH_OBJABI_V1`: object ABI v0, the toolchain/distribution convention commonly called the LoongArch old world. The flag marks v1 and never records v0 explicitly, so v0 is an inference from its absence rather than a separate declaration. Instruction encoding is shared with v1; v0 PLT stubs and dynamic-linker conventions are not emulated.",
          ]),
    ...(metadata?.type === ET_DYN
      ? [
          "LoongArch shared ELF: addresses are Ghidra analysis coordinates, not runtime load addresses. Ghidra applies the dynamic relocations its LoongArch handler implements (including R_LARCH_RELATIVE, R_LARCH_64 and R_LARCH_JUMP_SLOT) to loaded memory; it does not run ld.so, so external PLT/GOT bindings remain unverified without the defining images.",
          "Ghidra 12.1.4's LoongArch relocation handler reports TLS DTPMOD/DTPREL/TPREL, COPY and other unhandled relocation types as unsupported; those fixups remain unapplied, and any conclusion that depends on thread-local storage or copied data must be checked against the source bytes.",
        ]
      : []),
    "A stripped LoongArch image still exposes its dynamic symbol exports; other functions are recovered from direct-call analysis and exception unwind data, so the recovered function inventory is not a complete source-level function inventory.",
  ];
};
