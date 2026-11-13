import { z } from "zod";
import { err, ok, type Result } from "../result.js";

/** Supported target hardware CPU architectures for memory map classification. */
export const HARDWARE_ARCHITECTURES = [
  "arm",
  "arm64",
  "cortex-m",
  "riscv",
  "mips",
  "x86",
] as const;
export type HardwareArchitecture = (typeof HARDWARE_ARCHITECTURES)[number];
export const hardwareArchitectureSchema = z.enum(HARDWARE_ARCHITECTURES);

/** Standard hardware memory region functional classifications. */
export const HARDWARE_MEMORY_REGION_KINDS = [
  "code",
  "sram",
  "peripheral_mmio",
  "external_device",
  "system_control",
  "reserved",
] as const;
export type HardwareMemoryRegionKind =
  (typeof HARDWARE_MEMORY_REGION_KINDS)[number];
export const hardwareMemoryRegionKindSchema = z.enum(
  HARDWARE_MEMORY_REGION_KINDS,
);

/** Internal descriptor for an architectural memory map segment. */
export interface HardwareMemoryRegionDefinition {
  readonly name: string;
  readonly kind: HardwareMemoryRegionKind;
  readonly start: bigint;
  readonly end: bigint;
  readonly isMmio: boolean;
  readonly description: string;
}

/** Verified classification outcome for an addressed memory location. */
export interface HardwareMemoryClassification {
  readonly canonicalAddress: string;
  readonly addressValue: bigint;
  readonly architecture: HardwareArchitecture;
  readonly regionKind: HardwareMemoryRegionKind;
  readonly regionName: string;
  readonly range: {
    readonly start: string;
    readonly end: string;
  };
  readonly isMmio: boolean;
  readonly description: string;
}

const HEX_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{1,16}$/u;

const formatHex = (value: bigint): string => `0x${value.toString(16)}`;

const maxAddressFor = (architecture: HardwareArchitecture): bigint =>
  architecture === "arm64" ? 0xffffffffffffffffn : 0xffffffffn;

// Standard ARM Cortex-M / ARMv7-M / ARMv8-M memory architecture.
const ARM_REGIONS: readonly HardwareMemoryRegionDefinition[] = [
  {
    name: "Code / Flash",
    kind: "code",
    start: 0x00000000n,
    end: 0x1fffffffn,
    isMmio: false,
    description: "Executable Flash ROM, BootROM, or vector table mapping",
  },
  {
    name: "Internal SRAM",
    kind: "sram",
    start: 0x20000000n,
    end: 0x3fffffffn,
    isMmio: false,
    description: "Internal SRAM, stack, heap, and static data allocation",
  },
  {
    name: "Peripheral MMIO",
    kind: "peripheral_mmio",
    start: 0x40000000n,
    end: 0x5fffffffn,
    isMmio: true,
    description:
      "Microcontroller peripherals: GPIO, UART, SPI, I2C, Timers, ADC, DMA",
  },
  {
    name: "External RAM",
    kind: "external_device",
    start: 0x60000000n,
    end: 0x9fffffffn,
    isMmio: false,
    description: "External RAM accessed via FMC/FSMC; non-peripheral memory",
  },
  {
    name: "External Device Space",
    kind: "external_device",
    start: 0xa0000000n,
    end: 0xdfffffffn,
    isMmio: false,
    description: "External device memory or external storage mapping",
  },
  {
    name: "System Control Space (SCS)",
    kind: "system_control",
    start: 0xe0000000n,
    end: 0xe00fffffn,
    isMmio: true,
    description: "ARM core system control: NVIC, SysTick, SCB, MPU, DWT, ITM",
  },
  {
    name: "Reserved Architecture Space",
    kind: "reserved",
    start: 0xe0100000n,
    end: 0xffffffffn,
    isMmio: false,
    description: "Vendor or architecture reserved space",
  },
];

// Standard embedded RISC-V platform memory architecture.
const RISCV_REGIONS: readonly HardwareMemoryRegionDefinition[] = [
  {
    name: "Debug & Boot ROM",
    kind: "code",
    start: 0x00000000n,
    end: 0x01ffffffn,
    isMmio: false,
    description: "On-chip Debug module, mask ROM, and boot execution space",
  },
  {
    name: "Peripheral MMIO",
    kind: "peripheral_mmio",
    start: 0x10000000n,
    end: 0x1fffffffn,
    isMmio: true,
    description: "SoC peripheral registers: UART, SPI, GPIO, PWM, I2C",
  },
  {
    name: "Flash Memory",
    kind: "code",
    start: 0x20000000n,
    end: 0x7fffffffn,
    isMmio: false,
    description: "SPI/QSPI XIP Flash executable code",
  },
  {
    name: "Main System RAM",
    kind: "sram",
    start: 0x80000000n,
    end: 0xffffffffn,
    isMmio: false,
    description: "Main SRAM or DDR memory space",
  },
];

// Standard 32-bit MIPS memory segments.
const MIPS_REGIONS: readonly HardwareMemoryRegionDefinition[] = [
  {
    name: "kuseg (User TLB Space)",
    kind: "code",
    start: 0x00000000n,
    end: 0x7fffffffn,
    isMmio: false,
    description: "User virtual space, TLB-mapped and cached",
  },
  {
    name: "kseg0 (Kernel Unmapped Cached)",
    kind: "sram",
    start: 0x80000000n,
    end: 0x9fffffffn,
    isMmio: false,
    description: "Kernel executable and data space, cached and unmapped",
  },
  {
    name: "kseg1 (Kernel Unmapped Uncached)",
    kind: "sram",
    start: 0xa0000000n,
    end: 0xbfbfffffn,
    isMmio: false,
    description:
      "Kernel uncached space: mirrors physical memory for DMA and non-cached buffers",
  },
  {
    name: "kseg1 Boot ROM / Reset Vector",
    kind: "code",
    start: 0xbfc00000n,
    end: 0xbfffffffn,
    isMmio: false,
    description: "Reset vector and firmware boot ROM in uncached kernel space",
  },
  {
    name: "kseg2 / kseg3 (Kernel TLB Space)",
    kind: "system_control",
    start: 0xc0000000n,
    end: 0xffffffffn,
    isMmio: false,
    description: "Kernel mapped space and debug/supervisor control",
  },
];

// Standard x86 hardware memory map.
const X86_REGIONS: readonly HardwareMemoryRegionDefinition[] = [
  {
    name: "Real Mode Base RAM",
    kind: "sram",
    start: 0x00000000n,
    end: 0x0009ffffn,
    isMmio: false,
    description: "Conventional real-mode RAM and interrupt vector table",
  },
  {
    name: "Video MMIO (VGA)",
    kind: "peripheral_mmio",
    start: 0x000a0000n,
    end: 0x000bffffn,
    isMmio: true,
    description: "Legacy VGA text and graphics frame buffer MMIO",
  },
  {
    name: "Option ROM / BIOS Code",
    kind: "code",
    start: 0x000c0000n,
    end: 0x000fffffn,
    isMmio: false,
    description: "Expansion ROM and legacy BIOS firmware code",
  },
  {
    name: "System RAM",
    kind: "sram",
    start: 0x00100000n,
    end: 0xfebfffffn,
    isMmio: false,
    description: "Extended physical memory space",
  },
  {
    name: "APIC System Control MMIO",
    kind: "system_control",
    start: 0xfec00000n,
    end: 0xfeefffffn,
    isMmio: true,
    description: "I/O APIC and Local APIC memory-mapped control registers",
  },
  {
    name: "BIOS Firmware Flash",
    kind: "code",
    start: 0xfff00000n,
    end: 0xffffffffn,
    isMmio: false,
    description:
      "System firmware ROM containing x86 reset vector at 0xfffffff0",
  },
];

/**
 * One caller-selected AArch64 window list. The CPU family does not place GIC,
 * peripherals, or DRAM at these addresses.
 */
export const ARM64_EXPLICIT_BOARD_REGIONS: readonly HardwareMemoryRegionDefinition[] =
  [
    {
      name: "Flash / Firmware Code",
      kind: "code",
      start: 0x0000000000000000n,
      end: 0x0000000007ffffffn,
      isMmio: false,
      description: "Primary system firmware and boot code",
    },
    {
      name: "Interrupt Controller (GIC) MMIO",
      kind: "system_control",
      start: 0x0000000008000000n,
      end: 0x0000000008ffffffn,
      isMmio: true,
      description:
        "ARM Generic Interrupt Controller (GIC) distributor and CPU interfaces",
    },
    {
      name: "Peripheral MMIO Space",
      kind: "peripheral_mmio",
      start: 0x0000000009000000n,
      end: 0x000000003fffffffn,
      isMmio: true,
      description: "Memory-mapped I/O peripherals and PCIe configuration ECAM",
    },
    {
      name: "System RAM / DRAM",
      kind: "sram",
      start: 0x0000000040000000n,
      end: 0x000000ffffffffffn,
      isMmio: false,
      description: "Main physical memory space",
    },
    {
      name: "Extended Hardware Space",
      kind: "reserved",
      start: 0x0000010000000000n,
      end: 0xffffffffffffffffn,
      isMmio: false,
      description: "Upper 64-bit physical address space",
    },
  ];

const getArchitectureRegions = (
  arch: HardwareArchitecture,
): readonly HardwareMemoryRegionDefinition[] => {
  switch (arch) {
    case "arm":
    case "cortex-m":
      return ARM_REGIONS;
    case "riscv":
      return RISCV_REGIONS;
    case "mips":
      return MIPS_REGIONS;
    case "x86":
      return X86_REGIONS;
    case "arm64":
      return [];
  }
};

/** SiFive-style interrupt windows. A RISC-V CPU does not place CLINT or PLIC here. */
export const RISCV_SIFIVE_INTERRUPT_REGIONS: readonly HardwareMemoryRegionDefinition[] =
  [
    {
      name: "Core Local Interruptor (CLINT)",
      kind: "system_control",
      start: 0x02000000n,
      end: 0x0bffffffn,
      isMmio: true,
      description: "RISC-V timer and software interrupt control registers",
    },
    {
      name: "Platform-Level Interrupt Controller (PLIC)",
      kind: "system_control",
      start: 0x0c000000n,
      end: 0x0fffffffn,
      isMmio: true,
      description:
        "RISC-V external interrupt controller priority and enable registers",
    },
  ];

/** Parse and canonicalize an address input into a safe BigInt representation. */
export const parseAddressValue = (
  address: bigint | string,
): Result<bigint, string> => {
  if (typeof address === "bigint") {
    return address < 0n
      ? err("Address cannot be a negative value")
      : ok(address);
  }
  if (typeof address !== "string" || !HEX_ADDRESS_PATTERN.test(address)) {
    return err("Address must be a hexadecimal string of the form 0x…");
  }
  try {
    const parsed = BigInt(address);
    return ok(parsed);
  } catch {
    return err("Invalid hexadecimal address format");
  }
};

/**
 * Classify a target address within the standardized hardware memory map for
 * the specified CPU architecture. Distinguishes code, SRAM, peripheral MMIO,
 * external devices, and core system control spaces.
 */
export const classifyHardwareMemoryAddress = (
  address: bigint | string,
  architecture: HardwareArchitecture,
  profile?: readonly HardwareMemoryRegionDefinition[],
): Result<HardwareMemoryClassification, string> => {
  const parsed = parseAddressValue(address);
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  const max = maxAddressFor(architecture);
  if (value > max) {
    return err(
      `Address ${formatHex(value)} exceeds ${architecture} maximum address width ${formatHex(max)}`,
    );
  }

  const regions = profile ?? getArchitectureRegions(architecture);
  const matched = regions.find(
    (region) => value >= region.start && value <= region.end,
  );

  if (matched !== undefined) {
    return ok({
      canonicalAddress: formatHex(value),
      addressValue: value,
      architecture,
      regionKind: matched.kind,
      regionName: matched.name,
      range: {
        start: formatHex(matched.start),
        end: formatHex(matched.end),
      },
      isMmio: matched.isMmio,
      description: matched.description,
    });
  }

  return ok({
    canonicalAddress: formatHex(value),
    addressValue: value,
    architecture,
    regionKind: "reserved",
    regionName: "Unknown / Unmapped Region",
    range: { start: formatHex(value), end: formatHex(value) },
    isMmio: false,
    description: "Address does not match any recognized hardware region",
  });
};

/** Fast boolean predicate to check if an address represents memory-mapped I/O. */
export const isHardwareMmio = (
  address: bigint | string,
  architecture: HardwareArchitecture,
): boolean => {
  const result = classifyHardwareMemoryAddress(address, architecture);
  return result.ok ? result.value.isMmio : false;
};
