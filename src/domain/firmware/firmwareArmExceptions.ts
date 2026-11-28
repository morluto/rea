import type { ArchitectureVariant } from "../architectureVariant.js";

/**
 * System exceptions 1..15 per ARM M-profile variant (the Armv6-M, Armv7-M and
 * Armv8-M Architecture Reference Manuals; CMSIS `IRQn_Type` in core_cm0plus.h,
 * core_cm3.h, core_cm23.h and core_cm33.h). Every other number is reserved.
 */
const ARMV6M_SYSTEM_EXCEPTIONS: Readonly<Record<number, string>> = {
  1: "Reset",
  2: "NMI",
  3: "HardFault",
  11: "SVCall",
  14: "PendSV",
  15: "SysTick",
};

const ARMV7M_SYSTEM_EXCEPTIONS: Readonly<Record<number, string>> = {
  ...ARMV6M_SYSTEM_EXCEPTIONS,
  4: "MemManage",
  5: "BusFault",
  6: "UsageFault",
  12: "DebugMonitor",
};

/** Armv8-M Mainline; SecureFault is implemented only with the Security Extension. */
const ARMV8M_MAINLINE_SYSTEM_EXCEPTIONS: Readonly<Record<number, string>> = {
  ...ARMV7M_SYSTEM_EXCEPTIONS,
  7: "SecureFault",
};

/** Armv8-M Baseline has Armv6-M's exceptions; SecureFault escalates to HardFault. */
export const ARM_SYSTEM_EXCEPTIONS: Readonly<
  Record<ArchitectureVariant, Readonly<Record<number, string>>>
> = {
  "armv6-m": ARMV6M_SYSTEM_EXCEPTIONS,
  "armv7-m": ARMV7M_SYSTEM_EXCEPTIONS,
  "armv7e-m": ARMV7M_SYSTEM_EXCEPTIONS,
  "armv8-m.base": ARMV6M_SYSTEM_EXCEPTIONS,
  "armv8-m.main": ARMV8M_MAINLINE_SYSTEM_EXCEPTIONS,
  "armv8.1-m.main": ARMV8M_MAINLINE_SYSTEM_EXCEPTIONS,
};

/**
 * VTOR.TBLOFF starts at bit 7 on Armv7-M and Armv8-M, so the table is at
 * least 128-byte aligned; the manuals additionally require alignment to the
 * next power of two of the implemented exception count, which a file does not
 * record. Armv6-M VTOR is optional (absent on Cortex-M0) and implementation
 * defined where present (Cortex-M0+ CMSIS places TBLOFF at bit 8).
 */
export const ARM_MIN_VTOR_ALIGNMENT_BYTES: Readonly<
  Record<ArchitectureVariant, number | null>
> = {
  "armv6-m": null,
  "armv7-m": 128,
  "armv7e-m": 128,
  "armv8-m.base": 128,
  "armv8-m.main": 128,
  "armv8.1-m.main": 128,
};
