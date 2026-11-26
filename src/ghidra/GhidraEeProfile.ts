import type { GhidraLanguageOverride } from "../config/ghidraLanguageOverride.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import type { JsonValue } from "../domain/jsonValue.js";
import {
  ghidraMipsGnuAttributesUnsupportedReason,
  ghidraMipsIncompleteDeclarationsReason,
} from "./GhidraMipsProfile.js";

const EF_MIPS_MACH_5900 = 0x00920000;
const EF_MIPS_ARCH_3 = 0x20000000;
const EF_MIPS_ABI_EABI64 = 0x00004000;
const EF_MIPS_NOREORDER = 0x00000001;
const MIPS_ET_EXEC = 2;
const KNOWN_FLAG_BITS =
  0xf0000000 | 0x0f000000 | 0x00ff0000 | 0x0000f000 | EF_MIPS_NOREORDER;

/** The language the caller-installed ghidra-emotionengine-reloaded extension registers. */
export const GHIDRA_EE_LANGUAGE_ID = "r5900:LE:32:default";
export const GHIDRA_EE_SUPPORT_LANE = "ps2-elf32-exec-eabi64-r5900-v1";

/** The Emotion Engine's ELF machine declaration (EF_MIPS_MACH_5900), not a filename. */
export const isGhidraEeTarget = (target: BinaryTarget): boolean =>
  target.kind === "executable" &&
  target.format === "elf" &&
  target.architecture === "mips" &&
  target.mips !== undefined &&
  (target.mips.flags & 0x00ff0000) === EF_MIPS_MACH_5900;

/** PlayStation 2 EE has its own verified interpretation; generic MIPS rules remain unchanged. */
export const ghidraEeUnsupportedReason = (
  target: BinaryTarget,
): string | null => {
  if (
    target.kind !== "executable" ||
    target.architecture !== "mips" ||
    !isGhidraEeTarget(target)
  )
    return null;
  const metadata = target.mips;
  if (metadata === undefined) return "EE analysis requires ELF metadata.";
  const gnuAttributesReason =
    ghidraMipsGnuAttributesUnsupportedReason(metadata);
  if (gnuAttributesReason !== null) return gnuAttributesReason;
  // ee-gcc writes no GNU attributes; generic-MIPS-verified records are not EE evidence.
  if (metadata.gnuAttributes !== null)
    return "The PlayStation 2 EE profile covers producers without GNU MIPS ABI attributes; an attributes section needs separate verification.";
  const incomplete = ghidraMipsIncompleteDeclarationsReason(metadata);
  if (incomplete !== null) return incomplete;
  if (metadata.elfClass !== 32 || metadata.byteOrder !== "little")
    return "The PlayStation 2 EE profile requires little-endian ELF32.";
  if (metadata.type !== MIPS_ET_EXEC)
    return "The PlayStation 2 EE profile supports static ET_EXEC only; IRX modules, shared and relocatable images require separate verification.";
  // ee-gcc emits MIPS III, R5900 and EABI64 (optionally NOREORDER) with no ABI
  // flags record. Unknown producer bits are not inferred to be harmless.
  if ((metadata.flags & 0x0f000000) !== 0)
    return "The PlayStation 2 EE profile does not admit MIPS16, microMIPS or other ASE encodings.";
  if ((metadata.flags & 0xf0000000) !== EF_MIPS_ARCH_3)
    return "The PlayStation 2 EE profile requires the EF_MIPS_ARCH_3 declaration ee-gcc emits; other ISA levels need separate verification.";
  const abi = metadata.flags & 0x0000f000;
  if (abi !== EF_MIPS_ABI_EABI64 && abi !== 0)
    return "The PlayStation 2 EE profile requires the EABI64 declaration (or none); other ABI fields need separate verification.";
  if ((metadata.flags & ~KNOWN_FLAG_BITS) !== 0)
    return "The PlayStation 2 EE profile does not admit undeclared MIPS header flags.";
  if (metadata.abiFlags === undefined)
    return "The PlayStation 2 EE profile requires an inspected ELF; the MIPS ABI flags tables were not examined.";
  if (metadata.abiFlags !== null)
    return "The PlayStation 2 EE profile covers producers without a MIPS ABI flags record; a record needs separate verification.";
  return null;
};

/** The provider pins the extension's language; header auto-selection cannot name it. */
export const ghidraEeLanguageOverride = (
  target: BinaryTarget,
): GhidraLanguageOverride | undefined =>
  isGhidraEeTarget(target) && ghidraEeUnsupportedReason(target) === null
    ? { languageId: GHIDRA_EE_LANGUAGE_ID, compilerSpecId: "default" }
    : undefined;

/** Commit the EE lane over the generic MIPS header commitment. */
export const ghidraEeProfileParameters = (
  target: BinaryTarget,
): Readonly<Record<string, JsonValue>> => {
  const language = ghidraEeLanguageOverride(target);
  if (language === undefined) return {};
  return {
    mips_support_lane: GHIDRA_EE_SUPPORT_LANE,
    mips_abi_basis: "declared-eabi64-r5900-extension-v1",
    language_id: language.languageId,
    compiler_spec_id: language.compilerSpecId ?? "default",
    language_selection: "provider-pinned",
  };
};

/** Propagated with every EE observation, including successful decompilation. */
export const GHIDRA_EE_LIMITATIONS = [
  "PlayStation 2 EE analysis uses the caller-installed ghidra-emotionengine-reloaded extension (language r5900:LE:32:default). ELF declarations and the extension's instruction definitions are not proof of runtime semantics.",
  "The 128-bit multimedia instructions, VU0 macro mode and COP2 transfers follow the extension's definitions; decompiled output for them is an approximation, not an execution oracle.",
  "This EE profile covers static ELF32 ET_EXEC only. IRX modules, ISO containers, overlays and emulation are outside this verified lane.",
] as const;
