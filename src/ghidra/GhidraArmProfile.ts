import type { GhidraLanguageOverride } from "../config/ghidraLanguageOverride.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import type { JsonValue } from "../domain/jsonValue.js";

/** EF_ARM masks and flags read from the ELF32 header without interpretation. */
const EABI_VERSION_MASK = 0xff000000;
const EF_ARM_EABI_VER5 = 0x05000000;
const EF_ARM_BE8 = 0x00800000;
const EF_ARM_ABI_FLOAT_SOFT = 0x00000200;
const EF_ARM_ABI_FLOAT_HARD = 0x00000400;

/** Tag_CPU_arch enum for ARMv7, the only ISA this lane's verifier built. */
const ARM_CPU_ARCH_V7 = 10;
/** Tag_CPU_arch_profile for Application, the only variant the build covers. */
const ARM_CPU_ARCH_PROFILE_A = "A";
/** Tag_DIV_use=2 and nonzero Tag_Virtualization_use enable instructions the build does not probe. */
const TAG_DIV_USE = 44;
const TAG_VIRTUALIZATION_USE = 68;

const ARM_CPU_ARCH_PROFILE_NAMES: Readonly<Record<string, string>> = {
  R: "the Realtime profile",
  M: "the Microcontroller profile",
  [String.fromCharCode(0)]: "the Not Applicable profile",
};

const armCpuArchProfileName = (profile: string | null | undefined): string =>
  profile == null
    ? "no Tag_CPU_arch_profile"
    : (ARM_CPU_ARCH_PROFILE_NAMES[profile] ?? `profile "${profile}"`);

/** Declared Tag_CPU_arch names for typed refusals; unknown values stay numeric. */
const ARM_CPU_ARCH_NAMES: Readonly<Record<number, string>> = {
  0: "pre-v4",
  1: "v4",
  2: "v4T",
  3: "v5T",
  4: "v5TE",
  5: "v5TEJ",
  6: "v6",
  7: "v6KZ",
  8: "v6T2",
  9: "v6K",
  10: "v7",
  11: "v6-M",
  12: "v6S-M",
  13: "v7E-M",
  14: "v8-A",
  15: "v8-R",
  16: "v8-M Baseline",
  17: "v8-M Mainline",
  18: "v8.1-A",
  19: "v8.2-A",
  20: "v8.3-A",
  21: "v8.1-M Mainline",
  22: "v9-A",
};

const armCpuArchName = (value: number): string =>
  ARM_CPU_ARCH_NAMES[value] ?? `an unknown architecture (${value})`;

/**
 * Verified 32-bit ARM admission: little-endian ELF32 ET_EXEC with EABI5 whose
 * .ARM.attributes declare Tag_CPU_arch v7 with the Application profile, and
 * the refusal reasons name what the image declares instead. Only the
 * hard-float (armhf) convention the real build verifies is admitted, and the
 * hardware-divide and virtualization extensions it does not probe are
 * refused; the import language
 * is pinned because Ghidra header auto-selection has several plausible wrong
 * answers for ARM/Thumb-2 interworked images, and neither the EABI version
 * nor the arch enum alone identifies the CPU variant.
 */

/** Keep family recognition separate from the deliberately bounded Ghidra lane. */
export const ghidraArmUnsupportedReason = (
  target: BinaryTarget,
): string | null => {
  if (
    target.kind !== "executable" ||
    target.format !== "elf" ||
    target.architecture !== "arm"
  )
    return null;
  const metadata = target.arm;
  if (metadata === undefined)
    return "ARM analysis requires ELF header metadata; a family name alone does not select an ISA or ABI.";
  if (metadata.elfClass !== 32)
    return "This Ghidra ARM lane supports ELF32 only; ELF64 AArch64 images use the separately verified arm64 lane.";
  if (metadata.byteOrder !== "little")
    return "This Ghidra ARM lane supports little-endian images only; big-endian armeb and mixed-endian targets need separate verification.";
  if (metadata.type !== 2)
    return "This Ghidra ARM lane supports ET_EXEC only; PIE (ET_DYN), shared images and relocatable objects need separate load verification.";
  if ((metadata.flags & EABI_VERSION_MASK) !== EF_ARM_EABI_VER5)
    return "This Ghidra ARM lane requires EABI5; legacy ABIs and other EABI versions need separate verification.";
  if ((metadata.flags & EF_ARM_BE8) !== 0)
    return "EF_ARM_BE8 mixed-endian images need separate verification in this Ghidra lane.";
  if ((metadata.flags & EF_ARM_ABI_FLOAT_SOFT) !== 0)
    return "EF_ARM_ABI_FLOAT_SOFT is outside this Ghidra lane; the verified lane covers the hard-float convention only.";
  if ((metadata.flags & EF_ARM_ABI_FLOAT_HARD) === 0)
    return "This Ghidra ARM lane requires EF_ARM_ABI_FLOAT_HARD; images with an unspecified float convention need their own verified build.";
  if ((metadata.limitations?.length ?? 0) > 0)
    return `This Ghidra ARM lane requires completely inspected .ARM.attributes declarations, so the declared ISA is not established for this image: ${(metadata.limitations ?? []).join(" ")}`;
  if (metadata.cpuArch === undefined || metadata.cpuArch === null)
    return "This Ghidra ARM lane requires .ARM.attributes declaring Tag_CPU_arch v7; an image without a readable declaration cannot establish the verified ISA, and the ELF header alone does not identify the CPU architecture.";
  if (metadata.cpuArch !== ARM_CPU_ARCH_V7)
    return `This Ghidra ARM lane admits Tag_CPU_arch v7 only, and this image declares ${armCpuArchName(metadata.cpuArch)}; that ISA needs its own verified build before admission.`;
  if (metadata.cpuArchProfile !== ARM_CPU_ARCH_PROFILE_A)
    return `This Ghidra ARM lane admits the ARMv7 Application profile only, and this image declares ${armCpuArchProfileName(metadata.cpuArchProfile)}; the verified build covers armv7-a.`;
  const extension = metadata.extensions?.find(
    ({ tag, value }) =>
      (tag === TAG_DIV_USE && value === 2) ||
      (tag === TAG_VIRTUALIZATION_USE && value !== 0),
  );
  if (extension !== undefined)
    return `This Ghidra ARM lane admits armv7-a without the hardware-divide or virtualization extensions, and this image declares ${extension.tag === TAG_DIV_USE ? "Tag_DIV_use" : "Tag_Virtualization_use"}=${extension.value}; that extension needs its own verified build before admission.`;
  return null;
};

/** Derive the admitted ARM import language from target facts, independently of a committed profile. */
export const ghidraArmLanguageOverride = (
  target: BinaryTarget,
): GhidraLanguageOverride | undefined =>
  target.kind === "executable" &&
  target.format === "elf" &&
  target.architecture === "arm" &&
  ghidraArmUnsupportedReason(target) === null
    ? { languageId: "ARM:LE:32:v7", compilerSpecId: "default" }
    : undefined;

/** Commit source ELF interpretation without confusing target ISA with host CPU. */
export const ghidraArmProfileParameters = (
  target: BinaryTarget,
  languageOverride?: GhidraLanguageOverride,
): Readonly<Record<string, JsonValue>> => {
  if (
    target.kind !== "executable" ||
    target.format !== "elf" ||
    target.architecture !== "arm" ||
    target.arm === undefined
  )
    return {};
  const pinnedLanguage = ghidraArmLanguageOverride(target);
  // A deliberate caller-selected language wins over the provider pin; the pin
  // exists because header auto-selection misselects for interworked images.
  return {
    arm_elf: {
      elf_class: target.arm.elfClass,
      byte_order: target.arm.byteOrder,
      type: target.arm.type,
      flags: target.arm.flags,
      cpu_arch: target.arm.cpuArch ?? null,
      cpu_arch_name:
        target.arm.cpuArch == null ? null : armCpuArchName(target.arm.cpuArch),
      cpu_arch_profile: target.arm.cpuArchProfile ?? null,
      float_abi:
        (target.arm.flags & EF_ARM_ABI_FLOAT_HARD) !== 0
          ? "hard"
          : (target.arm.flags & EF_ARM_ABI_FLOAT_SOFT) !== 0
            ? "soft"
            : "unspecified",
    },
    arm_support_lane: "elf32-exec-le-eabi5-v7-pinned",
    ...(languageOverride === undefined && pinnedLanguage !== undefined
      ? {
          language_id: pinnedLanguage.languageId,
          compiler_spec_id: pinnedLanguage.compilerSpecId ?? "default",
          language_selection: "provider-pinned",
        }
      : {}),
  };
};

/** Read the provider-pinned import language back from a resolved profile. */
export const ghidraPinnedArmLanguage = (
  parameters: Readonly<Record<string, unknown>>,
): GhidraLanguageOverride | undefined => {
  if (
    parameters.arm_support_lane !== "elf32-exec-le-eabi5-v7-pinned" ||
    parameters.language_selection !== "provider-pinned"
  )
    return undefined;
  const languageId = parameters.language_id;
  const compilerSpecId = parameters.compiler_spec_id;
  if (typeof languageId !== "string" || typeof compilerSpecId !== "string")
    return undefined;
  return compilerSpecId === "language-default"
    ? { languageId }
    : { languageId, compilerSpecId };
};
