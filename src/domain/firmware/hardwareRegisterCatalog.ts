import { z } from "zod";
import {
  type HardwareArchitecture,
  hardwareArchitectureSchema,
} from "./hardwareMemoryMap.js";

/** Architectural specification defining a standard hardware register. */
export interface HardwareRegisterDefinition {
  readonly name: string;
  readonly mnemonic: string;
  readonly address: string;
  readonly addressValue: bigint;
  readonly architecture: HardwareArchitecture;
  readonly blockName: string;
  readonly description: string;
  readonly standard: string;
}

export const hardwareRegisterDefinitionSchema = z.strictObject({
  name: z.string(),
  mnemonic: z.string(),
  address: z.string(),
  addressValue: z.bigint(),
  architecture: hardwareArchitectureSchema,
  blockName: z.string(),
  description: z.string(),
  standard: z.string(),
});

const HEX_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{1,16}$/u;

interface RegisterEntry {
  readonly address: bigint;
  readonly name: string;
  readonly mnemonic: string;
  readonly blockName: string;
  readonly description: string;
  readonly standard: string;
}

// ARM Cortex-M System Control Space (SCS) architectural registers.
const ARM_SCS_REGISTERS: readonly RegisterEntry[] = [
  // SysTick
  {
    address: 0xe000e010n,
    name: "SysTick Control and Status Register",
    mnemonic: "SysTick_CTRL",
    blockName: "SysTick",
    description:
      "Controls the SysTick counter, interrupt enable, and clock source",
    standard: "ARMv7-M / ARMv8-M Architecture",
  },
  {
    address: 0xe000e014n,
    name: "SysTick Reload Value Register",
    mnemonic: "SysTick_LOAD",
    blockName: "SysTick",
    description: "Specifies the reload value when the SysTick counter wraps",
    standard: "ARMv7-M / ARMv8-M Architecture",
  },
  {
    address: 0xe000e018n,
    name: "SysTick Current Value Register",
    mnemonic: "SysTick_VAL",
    blockName: "SysTick",
    description: "Reads current counter value or writes to clear counter",
    standard: "ARMv7-M / ARMv8-M Architecture",
  },
  {
    address: 0xe000e01cn,
    name: "SysTick Calibration Register",
    mnemonic: "SysTick_CALIB",
    blockName: "SysTick",
    description: "Calibration value for 10ms SysTick tick interval",
    standard: "ARMv7-M / ARMv8-M Architecture",
  },
  // NVIC
  {
    address: 0xe000e100n,
    name: "Interrupt Set-Enable Register 0",
    mnemonic: "NVIC_ISER0",
    blockName: "NVIC",
    description: "Enables external interrupts 0 to 31",
    standard: "ARMv7-M / ARMv8-M Architecture",
  },
  {
    address: 0xe000e104n,
    name: "Interrupt Set-Enable Register 1",
    mnemonic: "NVIC_ISER1",
    blockName: "NVIC",
    description: "Enables external interrupts 32 to 63",
    standard: "ARMv7-M / ARMv8-M Architecture",
  },
  {
    address: 0xe000e180n,
    name: "Interrupt Clear-Enable Register 0",
    mnemonic: "NVIC_ICER0",
    blockName: "NVIC",
    description: "Disables external interrupts 0 to 31",
    standard: "ARMv7-M / ARMv8-M Architecture",
  },
  {
    address: 0xe000e200n,
    name: "Interrupt Set-Pending Register 0",
    mnemonic: "NVIC_ISPR0",
    blockName: "NVIC",
    description: "Forces interrupts 0 to 31 into pending state",
    standard: "ARMv7-M / ARMv8-M Architecture",
  },
  {
    address: 0xe000e280n,
    name: "Interrupt Clear-Pending Register 0",
    mnemonic: "NVIC_ICPR0",
    blockName: "NVIC",
    description: "Clears pending state for interrupts 0 to 31",
    standard: "ARMv7-M / ARMv8-M Architecture",
  },
  // System Control Block (SCB)
  {
    address: 0xe000ed00n,
    name: "CPUID Base Register",
    mnemonic: "CPUID",
    blockName: "SCB",
    description:
      "Core architecture, implementer, variant, part number and revision",
    standard: "ARMv7-M / ARMv8-M Architecture",
  },
  {
    address: 0xe000ed04n,
    name: "Interrupt Control and State Register",
    mnemonic: "ICSR",
    blockName: "SCB",
    description:
      "Pending NMI, PendSV, SysTick interrupts and active exception number",
    standard: "ARMv7-M / ARMv8-M Architecture",
  },
  {
    address: 0xe000ed08n,
    name: "Vector Table Offset Register",
    mnemonic: "VTOR",
    blockName: "SCB",
    description: "Base address offset of the exception vector table",
    standard: "ARMv7-M / ARMv8-M Architecture",
  },
  {
    address: 0xe000ed0cn,
    name: "Application Interrupt and Reset Control Register",
    mnemonic: "AIRCR",
    blockName: "SCB",
    description:
      "System reset request, priority grouping, and endianness status",
    standard: "ARMv7-M / ARMv8-M Architecture",
  },
  {
    address: 0xe000ed10n,
    name: "System Control Register",
    mnemonic: "SCR",
    blockName: "SCB",
    description: "Controls low-power sleep modes and sleep-on-exit behavior",
    standard: "ARMv7-M / ARMv8-M Architecture",
  },
  {
    address: 0xe000ed14n,
    name: "Configuration and Control Register",
    mnemonic: "CCR",
    blockName: "SCB",
    description:
      "Controls unaligned access traps, divide-by-zero traps, and stack alignment",
    standard: "ARMv7-M / ARMv8-M Architecture",
  },
  {
    address: 0xe000ed24n,
    name: "System Handler Control and State Register",
    mnemonic: "SHCSR",
    blockName: "SCB",
    description: "Enables MemManage, BusFault, and UsageFault system handlers",
    standard: "ARMv7-M / ARMv8-M Architecture",
  },
  {
    address: 0xe000ed28n,
    name: "Configurable Fault Status Register",
    mnemonic: "CFSR",
    blockName: "SCB",
    description:
      "Composite status for MemManage, BusFault, and UsageFault causes",
    standard: "ARMv7-M / ARMv8-M Architecture",
  },
  {
    address: 0xe000ed2cn,
    name: "HardFault Status Register",
    mnemonic: "HFSR",
    blockName: "SCB",
    description: "Causes of HardFault escalation and vector fetch failures",
    standard: "ARMv7-M / ARMv8-M Architecture",
  },
  {
    address: 0xe000ed38n,
    name: "BusFault Address Register",
    mnemonic: "BFAR",
    blockName: "SCB",
    description: "Memory address that caused a precise data BusFault",
    standard: "ARMv7-M / ARMv8-M Architecture",
  },
];

// RISC-V Privileged Architecture standard registers (CLINT and PLIC).
const RISCV_STANDARD_REGISTERS: readonly RegisterEntry[] = [
  // CLINT
  {
    address: 0x02000000n,
    name: "Machine Software Interrupt Pending (msip)",
    mnemonic: "msip0",
    blockName: "CLINT",
    description:
      "Inter-processor and software interrupt trigger register for Hart 0",
    standard: "RISC-V Privileged Architecture",
  },
  {
    address: 0x02004000n,
    name: "Machine Timer Compare Register Low",
    mnemonic: "mtimecmp0_lo",
    blockName: "CLINT",
    description: "Lower 32-bit comparator value for timer interrupt generation",
    standard: "RISC-V Privileged Architecture",
  },
  {
    address: 0x0200bff8n,
    name: "Machine Real-Time Counter Low",
    mnemonic: "mtime_lo",
    blockName: "CLINT",
    description: "Lower 32 bits of real-time monotonic cycle counter",
    standard: "RISC-V Privileged Architecture",
  },
  // PLIC
  {
    address: 0x0c000004n,
    name: "Interrupt Source 1 Priority",
    mnemonic: "PLIC_PRIORITY1",
    blockName: "PLIC",
    description: "Priority configuration for external interrupt source 1",
    standard: "RISC-V Privileged Architecture",
  },
  {
    address: 0x0c002000n,
    name: "Hart 0 M-Mode Interrupt Enable 0",
    mnemonic: "PLIC_ENABLE0",
    blockName: "PLIC",
    description:
      "Enables external interrupt sources 1 to 31 for Hart 0 machine mode",
    standard: "RISC-V Privileged Architecture",
  },
  {
    address: 0x0c200000n,
    name: "Hart 0 M-Mode Priority Threshold",
    mnemonic: "PLIC_THRESHOLD",
    blockName: "PLIC",
    description: "Minimum priority required to trigger an interrupt to Hart 0",
    standard: "RISC-V Privileged Architecture",
  },
  {
    address: 0x0c200004n,
    name: "Hart 0 M-Mode Interrupt Claim / Complete",
    mnemonic: "PLIC_CLAIM",
    blockName: "PLIC",
    description:
      "Reads highest pending interrupt ID and writes to signal completion",
    standard: "RISC-V Privileged Architecture",
  },
];

// x86 Standard Local APIC registers.
const X86_APIC_REGISTERS: readonly RegisterEntry[] = [
  {
    address: 0xfee00020n,
    name: "Local APIC ID Register",
    mnemonic: "LAPIC_ID",
    blockName: "Local APIC",
    description: "Hardware identification number for the local processor core",
    standard: "Intel 64 and IA-32 Architectures Software Developer's Manual",
  },
  {
    address: 0xfee00080n,
    name: "Task Priority Register",
    mnemonic: "LAPIC_TPR",
    blockName: "Local APIC",
    description:
      "Current processor task priority; suppresses lower priority interrupts",
    standard: "Intel 64 and IA-32 Architectures Software Developer's Manual",
  },
  {
    address: 0xfee000b0n,
    name: "End of Interrupt Register",
    mnemonic: "LAPIC_EOI",
    blockName: "Local APIC",
    description:
      "Software write to notify Local APIC that current interrupt handling is done",
    standard: "Intel 64 and IA-32 Architectures Software Developer's Manual",
  },
  {
    address: 0xfee000f0n,
    name: "Spurious Interrupt Vector Register",
    mnemonic: "LAPIC_SVR",
    blockName: "Local APIC",
    description: "Controls APIC software enable and spurious vector assignment",
    standard: "Intel 64 and IA-32 Architectures Software Developer's Manual",
  },
  {
    address: 0xfee00300n,
    name: "Interrupt Command Register Low",
    mnemonic: "LAPIC_ICR_LOW",
    blockName: "Local APIC",
    description:
      "Sends inter-processor interrupts (IPI) to other processor cores",
    standard: "Intel 64 and IA-32 Architectures Software Developer's Manual",
  },
  {
    address: 0xfee00320n,
    name: "LVT Timer Register",
    mnemonic: "LAPIC_LVT_TIMER",
    blockName: "Local APIC",
    description:
      "Local APIC timer interrupt mode (one-shot/periodic) and vector",
    standard: "Intel 64 and IA-32 Architectures Software Developer's Manual",
  },
  {
    address: 0xfee00380n,
    name: "Initial Count Register",
    mnemonic: "LAPIC_TIMER_INIT",
    blockName: "Local APIC",
    description: "Starting counter value for Local APIC timer",
    standard: "Intel 64 and IA-32 Architectures Software Developer's Manual",
  },
];

// ARM64 GIC standard registers.
const ARM64_GIC_REGISTERS: readonly RegisterEntry[] = [
  {
    address: 0x08000000n,
    name: "Distributor Control Register",
    mnemonic: "GICD_CTLR",
    blockName: "GIC Distributor",
    description:
      "Enables forwarding of interrupts from distributor to CPU interfaces",
    standard: "ARM Generic Interrupt Controller Architecture",
  },
  {
    address: 0x08000004n,
    name: "Interrupt Controller Type Register",
    mnemonic: "GICD_TYPER",
    blockName: "GIC Distributor",
    description:
      "Indicates number of implemented interrupt lines and CPU interfaces",
    standard: "ARM Generic Interrupt Controller Architecture",
  },
  {
    address: 0x08000100n,
    name: "Interrupt Set-Enable Register 0",
    mnemonic: "GICD_ISENABLER0",
    blockName: "GIC Distributor",
    description: "Enables forwarding of SGI and PPI interrupts 0 to 31",
    standard: "ARM Generic Interrupt Controller Architecture",
  },
  {
    address: 0x08000180n,
    name: "Interrupt Clear-Enable Register 0",
    mnemonic: "GICD_ICENABLER0",
    blockName: "GIC Distributor",
    description: "Disables forwarding of SGI and PPI interrupts 0 to 31",
    standard: "ARM Generic Interrupt Controller Architecture",
  },
  {
    address: 0x08010000n,
    name: "CPU Interface Control Register",
    mnemonic: "GICC_CTLR",
    blockName: "GIC CPU Interface",
    description: "Enables CPU interface signaling of interrupts to the core",
    standard: "ARM Generic Interrupt Controller Architecture",
  },
  {
    address: 0x08010004n,
    name: "Interrupt Priority Mask Register",
    mnemonic: "GICC_PMR",
    blockName: "GIC CPU Interface",
    description:
      "Priority threshold for delivering interrupts to the target processor",
    standard: "ARM Generic Interrupt Controller Architecture",
  },
  {
    address: 0x0801000cn,
    name: "Interrupt Acknowledge Register",
    mnemonic: "GICC_IAR",
    blockName: "GIC CPU Interface",
    description:
      "Reads highest priority pending interrupt ID and marks it active",
    standard: "ARM Generic Interrupt Controller Architecture",
  },
  {
    address: 0x08010010n,
    name: "End of Interrupt Register",
    mnemonic: "GICC_EOIR",
    blockName: "GIC CPU Interface",
    description:
      "Software write to signal completion of current interrupt processing",
    standard: "ARM Generic Interrupt Controller Architecture",
  },
];

const ARCH_REGISTERS: Record<HardwareArchitecture, readonly RegisterEntry[]> = {
  arm: ARM_SCS_REGISTERS,
  "cortex-m": ARM_SCS_REGISTERS,
  riscv: RISCV_STANDARD_REGISTERS,
  x86: X86_APIC_REGISTERS,
  arm64: ARM64_GIC_REGISTERS,
  mips: [], // MIPS uses CP0 coprocessor registers (mtc0/mfc0) rather than standard MMIO
};

/**
 * Resolve an architectural hardware register by its exact physical memory address.
 *
 * Returns null when the address does not map to an architecturally defined register,
 * explicitly preserving unknown facts rather than fabricating hypothetical definitions.
 */
export const lookupHardwareRegister = (
  rawAddress: string,
  architecture: HardwareArchitecture,
): HardwareRegisterDefinition | null => {
  if (typeof rawAddress !== "string" || !HEX_ADDRESS_PATTERN.test(rawAddress))
    return null;

  let addressBigInt: bigint;
  try {
    addressBigInt = BigInt(rawAddress);
  } catch {
    return null;
  }

  const catalog = ARCH_REGISTERS[architecture];
  if (!catalog || catalog.length === 0) return null;

  const match = catalog.find((entry) => entry.address === addressBigInt);
  if (!match) return null;

  return {
    name: match.name,
    mnemonic: match.mnemonic,
    address: `0x${addressBigInt.toString(16)}`,
    addressValue: addressBigInt,
    architecture,
    blockName: match.blockName,
    description: match.description,
    standard: match.standard,
  };
};
