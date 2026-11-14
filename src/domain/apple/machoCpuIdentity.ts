/** CPU subtype bits reserved for ABI/capability flags, not the base subtype. */
const CPU_SUBTYPE_CAPABILITY_MASK = 0xff000000;

/**
 * Host-slice preference for one CPU type, best first.
 * arm64, then arm64e, then arm64v8. Generic x86_64 and i386 outrank Haswell
 * and other unlisted bases. Apple tool names stay with the native policy.
 */
export const ARM64_HOST_SUBTYPE_PREFERENCE = [0, 2, 1] as const;
export const X86_64_HOST_SUBTYPE_PREFERENCE = [3] as const;
export const X86_HOST_SUBTYPE_PREFERENCE = [3] as const;
export const ARM64_32_HOST_SUBTYPE_PREFERENCE = [1] as const;

/** Preference lists keyed by Mach-O CPU type. Unlisted types have no ranking. */
export const MACHO_HOST_SUBTYPE_PREFERENCE: Readonly<
  Record<number, readonly number[]>
> = {
  7: X86_HOST_SUBTYPE_PREFERENCE,
  0x01000007: X86_64_HOST_SUBTYPE_PREFERENCE,
  0x0100000c: ARM64_HOST_SUBTYPE_PREFERENCE,
  0x0200000c: ARM64_32_HOST_SUBTYPE_PREFERENCE,
};

/**
 * Rank of a slice for host admission. Lower is better. Unlisted bases share
 * the rank after every preferred base, so they tie with each other.
 */
export const machoHostSubtypeRank = (
  cpuType: number,
  cpuSubtype: number,
): number => {
  const preference = MACHO_HOST_SUBTYPE_PREFERENCE[cpuType] ?? [];
  const rank = preference.indexOf(machoCpuSubtypeBase(cpuSubtype));
  return rank < 0 ? preference.length : rank;
};

/** Return the CPU subtype identity shared across capability-flag variations. */
export const machoCpuSubtypeBase = (cpuSubtype: number): number =>
  cpuSubtype & ~CPU_SUBTYPE_CAPABILITY_MASK;

// XNU osfmk/mach/machine.h CPU_SUBTYPE_ARM_* identities. Keep the generic
// display fallback separate: an unlisted subtype does not establish agreement.
const ARM32_SUBTYPES: ReadonlyMap<number, string> = new Map([
  [0, "arm"],
  [5, "armv4t"],
  [6, "armv6"],
  [7, "armv5tej"],
  [8, "xscale"],
  [9, "armv7"],
  [10, "armv7f"],
  [11, "armv7s"],
  [12, "armv7k"],
  [13, "armv8"],
  [14, "armv6m"],
  [15, "armv7m"],
  [16, "armv7em"],
  [17, "armv8m.main"],
  [18, "armv8m.base"],
  [19, "armv8.1m.main"],
]);

/** Known ARM32 identity without changing the family name used for display. */
export const machoKnownArm32Subtype = (
  cpuSubtype: number,
): string | undefined => ARM32_SUBTYPES.get(machoCpuSubtypeBase(cpuSubtype));

/** Known ARM64 subtype identity, distinct from the family display fallback. */
export const machoKnownArm64Subtype = (
  cpuSubtype: number,
): string | undefined => {
  switch (machoCpuSubtypeBase(cpuSubtype)) {
    case 0:
      return "arm64";
    case 1:
      return "arm64v8";
    case 2:
      return "arm64e";
    case 12:
      return "arm64e.x1";
    default:
      return undefined;
  }
};

/** Known x86_64 subtype identity, distinct from the family display fallback. */
export const machoKnownX86_64Subtype = (
  cpuSubtype: number,
): string | undefined => {
  switch (machoCpuSubtypeBase(cpuSubtype)) {
    case 3:
      return "x86_64";
    case 8:
      return "x86_64h";
    default:
      return undefined;
  }
};

/**
 * Display known byte-header identities without inferring pointer-auth ABI names.
 * Subtype 12: llvm-project b8007a8e4020b8bca2b12e941660e10bf5bf6716,
 * MachO.h / MachOObjectFile.cpp. Capability bits remain independent source facts.
 */
export const machoArchitectureName = (
  cpuType: number,
  cpuSubtype: number,
): string => {
  if (cpuType === 0x0100000c) {
    return machoKnownArm64Subtype(cpuSubtype) ?? "arm64";
  }
  if (cpuType === 0x0200000c) return "arm64_32";
  if (cpuType === 0x01000007)
    return machoKnownX86_64Subtype(cpuSubtype) ?? "x86_64";
  if (cpuType === 7) return "i386";
  if (cpuType === 12) return "arm";
  return `cpu-${cpuType.toString(16)}`;
};

/** Known exact display aliases retain the existing family-based request semantics. */
export const machoArchitectureFamily = (architecture: string): string => {
  if (architecture === "arm64e.x1") return "arm64e";
  if (architecture === "arm64v8") return "arm64";
  return architecture;
};
