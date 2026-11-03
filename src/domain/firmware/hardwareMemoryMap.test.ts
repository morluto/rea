import { describe, expect, it } from "vitest";
import {
  ARM64_EXPLICIT_BOARD_REGIONS,
  RISCV_SIFIVE_INTERRUPT_REGIONS,
  classifyHardwareMemoryAddress,
  isHardwareMmio,
  parseAddressValue,
} from "./hardwareMemoryMap.js";

describe("ARM Cortex-M hardware memory map classification", () => {
  it.each([
    {
      address: "0x0",
      kind: "code",
      name: "Code / Flash",
      isMmio: false,
    },
    {
      address: "0x08000000",
      kind: "code",
      name: "Code / Flash",
      isMmio: false,
    },
    {
      address: "0x20000000",
      kind: "sram",
      name: "Internal SRAM",
      isMmio: false,
    },
    {
      address: "0x40000000",
      kind: "peripheral_mmio",
      name: "Peripheral MMIO",
      isMmio: true,
    },
    {
      address: "0x40011000",
      kind: "peripheral_mmio",
      name: "Peripheral MMIO",
      isMmio: true,
    },
    {
      address: "0x60000000",
      kind: "external_device",
      name: "External RAM",
      isMmio: false,
    },
    {
      address: "0xa0000000",
      kind: "external_device",
      name: "External Device Space",
      isMmio: false,
    },
    {
      address: "0xe000e010",
      kind: "system_control",
      name: "System Control Space (SCS)",
      isMmio: true,
    },
    {
      address: "0xe000e100",
      kind: "system_control",
      name: "System Control Space (SCS)",
      isMmio: true,
    },
    {
      address: "0xe0100000",
      kind: "reserved",
      name: "Reserved Architecture Space",
      isMmio: false,
    },
  ])(
    "classifies ARM address $address as $kind ($name)",
    ({ address, kind, name, isMmio }) => {
      const result = classifyHardwareMemoryAddress(address, "arm");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.regionKind).toBe(kind);
      expect(result.value.regionName).toBe(name);
      expect(result.value.isMmio).toBe(isMmio);
      expect(isHardwareMmio(address, "arm")).toBe(isMmio);
    },
  );
});

describe("RISC-V and MIPS hardware memory map classification", () => {
  it.each([
    {
      address: "0x00001000",
      kind: "code",
      name: "Debug & Boot ROM",
      isMmio: false,
    },
    {
      address: "0x02000000",
      kind: "reserved",
      name: "Unknown / Unmapped Region",
      isMmio: false,
    },
    {
      address: "0x0c000000",
      kind: "reserved",
      name: "Unknown / Unmapped Region",
      isMmio: false,
    },
    {
      address: "0x10012000",
      kind: "peripheral_mmio",
      name: "Peripheral MMIO",
      isMmio: true,
    },
    {
      address: "0x20000000",
      kind: "code",
      name: "Flash Memory",
      isMmio: false,
    },
    {
      address: "0x80000000",
      kind: "sram",
      name: "Main System RAM",
      isMmio: false,
    },
  ])(
    "classifies RISC-V address $address",
    ({ address, kind, name, isMmio }) => {
      const result = classifyHardwareMemoryAddress(address, "riscv");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.regionKind).toBe(kind);
      expect(result.value.regionName).toBe(name);
      expect(result.value.isMmio).toBe(isMmio);
    },
  );

  it.each([
    {
      address: "0x00400000",
      kind: "code",
      name: "kuseg (User TLB Space)",
      isMmio: false,
    },
    {
      address: "0x80000000",
      kind: "sram",
      name: "kseg0 (Kernel Unmapped Cached)",
      isMmio: false,
    },
    {
      address: "0xa0000000",
      kind: "sram",
      name: "kseg1 (Kernel Unmapped Uncached)",
      isMmio: false,
    },
    {
      address: "0xbfc00000",
      kind: "code",
      name: "kseg1 Boot ROM / Reset Vector",
      isMmio: false,
    },
    {
      address: "0xc0000000",
      kind: "system_control",
      name: "kseg2 / kseg3 (Kernel TLB Space)",
      isMmio: false,
    },
  ])("classifies MIPS address $address", ({ address, kind, name, isMmio }) => {
    const result = classifyHardwareMemoryAddress(address, "mips");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.regionKind).toBe(kind);
    expect(result.value.regionName).toBe(name);
    expect(result.value.isMmio).toBe(isMmio);
  });
});

describe("x86 and ARM64 hardware memory map classification", () => {
  it.each([
    {
      address: "0x00000000",
      kind: "sram",
      name: "Real Mode Base RAM",
      isMmio: false,
    },
    {
      address: "0x000a0000",
      kind: "peripheral_mmio",
      name: "Video MMIO (VGA)",
      isMmio: true,
    },
    {
      address: "0x000e0000",
      kind: "code",
      name: "Option ROM / BIOS Code",
      isMmio: false,
    },
    {
      address: "0xfec00000",
      kind: "system_control",
      name: "APIC System Control MMIO",
      isMmio: true,
    },
    {
      address: "0xfffffff0",
      kind: "code",
      name: "BIOS Firmware Flash",
      isMmio: false,
    },
  ])("classifies x86 address $address", ({ address, kind, name, isMmio }) => {
    const result = classifyHardwareMemoryAddress(address, "x86");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.regionKind).toBe(kind);
    expect(result.value.regionName).toBe(name);
    expect(result.value.isMmio).toBe(isMmio);
  });

  it.each([
    {
      address: "0x0000000000001000",
      kind: "code",
      name: "Flash / Firmware Code",
      isMmio: false,
    },
    {
      address: "0x0000000008000000",
      kind: "system_control",
      name: "Interrupt Controller (GIC) MMIO",
      isMmio: true,
    },
    {
      address: "0x0000000009000000",
      kind: "peripheral_mmio",
      name: "Peripheral MMIO Space",
      isMmio: true,
    },
    {
      address: "0x0000000040000000",
      kind: "sram",
      name: "System RAM / DRAM",
      isMmio: false,
    },
  ])(
    "classifies an explicit ARM64 board profile at $address",
    ({ address, kind, name, isMmio }) => {
      const result = classifyHardwareMemoryAddress(
        address,
        "arm64",
        ARM64_EXPLICIT_BOARD_REGIONS,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw result.error;
      expect(result.value.regionKind).toBe(kind);
      expect(result.value.regionName).toBe(name);
      expect(result.value.isMmio).toBe(isMmio);
    },
  );

  it("leaves arm64 and SiFive interrupt windows unnamed until a profile is selected", () => {
    const uart = classifyHardwareMemoryAddress("0xfe201000", "arm64");
    if (!uart.ok) throw uart.error;
    expect(uart.value.regionName).toBe("Unknown / Unmapped Region");
    expect(uart.value.isMmio).toBe(false);

    const gic = classifyHardwareMemoryAddress("0x08000000", "arm64");
    if (!gic.ok) throw gic.error;
    expect(gic.value.regionName).toBe("Unknown / Unmapped Region");

    const clint = classifyHardwareMemoryAddress(
      "0x02000000",
      "riscv",
      RISCV_SIFIVE_INTERRUPT_REGIONS,
    );
    if (!clint.ok) throw clint.error;
    expect(clint.value.regionName).toBe("Core Local Interruptor (CLINT)");
  });
});

describe("hardware memory map address parsing and overflow boundaries", () => {
  it("rejects 32-bit address overflow on 32-bit architectures", () => {
    const overflow = classifyHardwareMemoryAddress("0x100000000", "arm");
    expect(overflow.ok).toBe(false);
    if (overflow.ok) return;
    expect(overflow.error).toContain("exceeds arm maximum address width");

    const mipsOverflow = classifyHardwareMemoryAddress("0x100000000", "mips");
    expect(mipsOverflow.ok).toBe(false);
  });

  it("admits 64-bit addresses on arm64 and rejects 64-bit overflow", () => {
    const valid64 = classifyHardwareMemoryAddress(
      "0x0000000040000000",
      "arm64",
    );
    expect(valid64.ok).toBe(true);

    const overflow64 = parseAddressValue("0x10000000000000000");
    expect(overflow64.ok).toBe(false);
    if (overflow64.ok) return;
    expect(overflow64.error).toContain("hexadecimal string");
  });

  it("rejects malformed address strings and negative BigInt values", () => {
    expect(parseAddressValue("not-hex").ok).toBe(false);
    expect(parseAddressValue("0x").ok).toBe(false);
    expect(parseAddressValue("").ok).toBe(false);
    expect(parseAddressValue(-1n).ok).toBe(false);
  });

  it("classifies a Cortex-M flash vector and peripheral as the ARM map", () => {
    const reset = classifyHardwareMemoryAddress("0x0800c6b4", "cortex-m");
    const usart = classifyHardwareMemoryAddress("0x40011000", "cortex-m");
    expect(reset.ok && reset.value).toMatchObject({
      regionKind: "code",
      isMmio: false,
    });
    expect(usart.ok && usart.value).toMatchObject({
      regionKind: "peripheral_mmio",
      isMmio: true,
    });
    expect(classifyHardwareMemoryAddress("0x100000000", "cortex-m").ok).toBe(
      false,
    );
  });

  it("handles BigInt address inputs directly", () => {
    const result = classifyHardwareMemoryAddress(0x40001000n, "arm");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.canonicalAddress).toBe("0x40001000");
    expect(result.value.isMmio).toBe(true);
  });
});
