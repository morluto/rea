/** CPU subtype bits reserved for ABI/capability flags, not the base subtype. */
const CPU_SUBTYPE_CAPABILITY_MASK = 0xff000000;

/** Return the CPU subtype identity shared across capability-flag variations. */
export const machoCpuSubtypeBase = (cpuSubtype: number): number =>
  cpuSubtype & ~CPU_SUBTYPE_CAPABILITY_MASK;
