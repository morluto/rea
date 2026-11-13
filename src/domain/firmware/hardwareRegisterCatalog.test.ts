import { describe, expect, it } from "vitest";
import {
  hardwareRegisterDefinitionSchema,
  lookupExplicitRegister,
  lookupHardwareRegister,
} from "./hardwareRegisterCatalog.js";

describe("ARM Cortex-M architectural register lookup", () => {
  it.each([
    {
      address: "0xe000e010",
      mnemonic: "SysTick_CTRL",
      block: "SysTick",
    },
    {
      address: "0xe000e014",
      mnemonic: "SysTick_LOAD",
      block: "SysTick",
    },
    {
      address: "0xe000e100",
      mnemonic: "NVIC_ISER0",
      block: "NVIC",
    },
    {
      address: "0xe000e180",
      mnemonic: "NVIC_ICER0",
      block: "NVIC",
    },
    {
      address: "0xe000ed00",
      mnemonic: "CPUID",
      block: "SCB",
    },
    {
      address: "0xe000ed08",
      mnemonic: "VTOR",
      block: "SCB",
    },
    {
      address: "0xe000ed0c",
      mnemonic: "AIRCR",
      block: "SCB",
    },
  ])(
    "resolves ARM SCS register $mnemonic at $address",
    ({ address, mnemonic, block }) => {
      const reg = lookupHardwareRegister(address, "arm");
      expect(reg).not.toBeNull();
      if (reg === null) return;
      expect(reg.mnemonic).toBe(mnemonic);
      expect(reg.blockName).toBe(block);
      expect(reg.architecture).toBe("arm");
      expect(hardwareRegisterDefinitionSchema.safeParse(reg).success).toBe(
        true,
      );
    },
  );

  it("resolves the same SCS register for a Cortex-M target", () => {
    const reg = lookupHardwareRegister("0xe000ed08", "cortex-m");
    expect(reg).toMatchObject({ mnemonic: "VTOR", architecture: "cortex-m" });
    expect(lookupHardwareRegister("0xe000ed88", "cortex-m")?.mnemonic).toBe(
      "CPACR",
    );
  });
});

describe("RISC-V and x86 standard architectural register lookup", () => {
  it("names SiFive CLINT and PLIC registers only from that profile", () => {
    expect(lookupHardwareRegister("0x02000000", "riscv")).toBeNull();
    const msip = lookupExplicitRegister(
      "0x02000000",
      "riscv-sifive-clint-plic",
    );
    expect(msip?.mnemonic).toBe("msip0");
    expect(msip?.blockName).toBe("CLINT");

    const plicClaim = lookupExplicitRegister(
      "0x0c200004",
      "riscv-sifive-clint-plic",
    );
    expect(plicClaim?.mnemonic).toBe("PLIC_CLAIM");
    expect(plicClaim?.blockName).toBe("PLIC");
  });

  it("resolves standard x86 Local APIC registers", () => {
    const eoi = lookupHardwareRegister("0xfee000b0", "x86");
    expect(eoi?.mnemonic).toBe("LAPIC_EOI");
    expect(eoi?.blockName).toBe("Local APIC");

    const icr = lookupHardwareRegister("0xfee00300", "x86");
    expect(icr?.mnemonic).toBe("LAPIC_ICR_LOW");
  });

  it("names a GIC register only when its placement profile is selected", () => {
    expect(lookupHardwareRegister("0x08000000", "arm64")).toBeNull();
    const gicd = lookupExplicitRegister(
      "0x08000000",
      "arm-gic-v2-base-0x08000000",
    );
    expect(gicd?.mnemonic).toBe("GICD_CTLR");
    expect(gicd?.blockName).toBe("GIC Distributor");

    const gicc = lookupExplicitRegister(
      "0x08010000",
      "arm-gic-v2-base-0x08000000",
    );
    expect(gicc?.mnemonic).toBe("GICC_CTLR");
    expect(gicc?.blockName).toBe("GIC CPU Interface");
  });
});

describe("Hardware register catalog unknown and edge-case handling", () => {
  it("returns null for non-architectural SoC addresses preserving unknowns", () => {
    // STM32 UART1 is SoC-specific, not ARM architecture-defined
    expect(lookupHardwareRegister("0x40011000", "arm")).toBeNull();
    // RAM and Flash addresses
    expect(lookupHardwareRegister("0x20000000", "arm")).toBeNull();
    expect(lookupHardwareRegister("0x08000000", "arm")).toBeNull();
  });

  it("returns null for MIPS where registers are coprocessor CP0", () => {
    expect(lookupHardwareRegister("0xbfc00000", "mips")).toBeNull();
  });

  it("rejects malformed and non-hex address formats", () => {
    expect(lookupHardwareRegister("invalid", "arm")).toBeNull();
    expect(lookupHardwareRegister("", "arm")).toBeNull();
  });
});
