import type { GhidraLanguageOverride } from "../config/ghidraLanguageOverride.js";
import type {
  BinaryTarget,
  ElfFamilyMetadata,
} from "../domain/binaryTargetTypes.js";
import type { JsonValue } from "../domain/jsonValue.js";

/**
 * Generic 32-bit big-endian PowerPC. Ghidra's ELF loader selects the e500
 * (Book-E/SPE) variant for a plain EM_PPC header, so the lane binds this
 * language instead of accepting the loader's choice.
 */
export const GHIDRA_POWERPC_LANGUAGE: GhidraLanguageOverride = {
  languageId: "PowerPC:BE:32:default",
  compilerSpecId: "default",
};

/**
 * 64-bit PowerPC by byte order. Ghidra names its Power ISA 3.0 languages
 * A2ALT; its `default` 64-bit languages decode the older G2-era instruction
 * set and stop at the first VSX instruction in POWER8 or POWER9 code. The ELF
 * loader selects A2ALT today; the lane passes it explicitly, so a later loader
 * that prefers another variant does not change how these files decode.
 */
export const GHIDRA_POWERPC64_LANGUAGES: Readonly<
  Record<ElfFamilyMetadata["byteOrder"], GhidraLanguageOverride>
> = {
  little: { languageId: "PowerPC:LE:64:A2ALT", compilerSpecId: "default" },
  big: { languageId: "PowerPC:BE:64:A2ALT", compilerSpecId: "default" },
};

const ET_EXEC = 2;
// EF_PPC64_ABI: the low two e_flags bits declare the ELF ABI version.
const EF_PPC64_ABI = 0x3;
const PPC64_ELFV2 = 2;

const powerPc64UnsupportedReason = (
  metadata: ElfFamilyMetadata,
): string | null => {
  // ELFv1 calls through .opd function descriptors; ABI 0 does not say which
  // convention the code follows.
  if ((metadata.flags & EF_PPC64_ABI) !== PPC64_ELFV2)
    return "This Ghidra PPC64 lane supports the ELFv2 ABI only (e_flags ABI version 2); ELFv1 function descriptors and an undeclared ABI need separate verification.";
  if ((metadata.flags & ~EF_PPC64_ABI) !== 0)
    return "PPC64 e_flags declares bits outside the ABI version that this lane has not verified.";
  if (metadata.type !== ET_EXEC)
    return "This Ghidra PPC64 lane supports ET_EXEC only; relocatable objects, shared objects and position-independent executables need separate load verification.";
  return null;
};

/** Keep family recognition separate from the deliberately bounded Ghidra lane. */
export const ghidraPowerPcUnsupportedReason = (
  target: BinaryTarget,
): string | null => {
  if (target.kind !== "executable" || target.architecture !== "powerpc")
    return null;
  const missingMetadata =
    "PowerPC analysis requires ELF header metadata; a family name alone does not select a processor variant.";
  if (target.format !== "elf") return missingMetadata;
  const metadata = target.powerpc;
  if (metadata === undefined) return missingMetadata;
  if (metadata.elfClass === 64) return powerPc64UnsupportedReason(metadata);
  if (metadata.byteOrder !== "big")
    return "This Ghidra PowerPC lane supports big-endian ELF32 only; little-endian PowerPC needs separate verification.";
  if (metadata.type !== ET_EXEC)
    return "This Ghidra PowerPC lane supports ET_EXEC only; relocatable objects and shared images need separate load verification.";
  // EF_PPC_EMB (0x80000000) marks embedded variants; other bits only declare
  // relocation conventions that do not change instruction decoding.
  if ((metadata.flags & 0x80000000) !== 0)
    return "EF_PPC_EMB declares an embedded PowerPC variant that needs a separately supported processor profile.";
  return null;
};

/**
 * The language the lane imports with, unless REA_GHIDRA_LANGUAGE_ID already
 * selected one through the committed profile.
 */
export const ghidraPowerPcLanguage = (
  target: BinaryTarget,
): GhidraLanguageOverride | undefined => {
  if (target.kind !== "executable" || target.architecture !== "powerpc")
    return undefined;
  const metadata = target.format === "elf" ? target.powerpc : undefined;
  return metadata?.elfClass === 64
    ? GHIDRA_POWERPC64_LANGUAGES[metadata.byteOrder]
    : GHIDRA_POWERPC_LANGUAGE;
};

/** Commit source ELF interpretation without confusing target ISA with host CPU. */
export const ghidraPowerPcProfileParameters = (
  target: BinaryTarget,
): Readonly<Record<string, JsonValue>> => {
  if (
    target.kind !== "executable" ||
    target.architecture !== "powerpc" ||
    target.format !== "elf" ||
    target.powerpc === undefined
  )
    return {};
  return {
    powerpc_elf: {
      elf_class: target.powerpc.elfClass,
      byte_order: target.powerpc.byteOrder,
      type: target.powerpc.type,
      flags: target.powerpc.flags,
    },
    powerpc_support_lane:
      target.powerpc.elfClass === 64
        ? "elf64-elfv2-exec-isa3"
        : "elf32-be-exec-generic",
  };
};
