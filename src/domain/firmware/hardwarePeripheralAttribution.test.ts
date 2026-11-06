import { describe, expect, it } from "vitest";
import {
  attributeHardwareAccess,
  summarizeHardwarePeripheralInteractions,
  type AnalyzedInstructionReference,
  type HardwareAccessAttribution,
} from "./hardwarePeripheralAttribution.js";

describe("Hardware peripheral reference attribution", () => {
  it("attributes a read access to a UART peripheral register", () => {
    const reference: AnalyzedInstructionReference = {
      target_address: "0x40011004",
      read: true,
      write: false,
      source_address: "0x08000150",
      operand_index: 1,
      provenance: "instruction_disassembly",
    };

    const result = attributeHardwareAccess(reference, "arm");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toEqual({
      targetAddress: "0x40011004",
      addressValue: 0x40011004n,
      architecture: "arm",
      regionKind: "peripheral_mmio",
      regionName: "Peripheral MMIO",
      isMmio: true,
      accessKind: "read",
      peripheralBlockBase: "0x40011000",
      peripheralBlockOffset: "0x4",
      controllerName: null,
      controllerBasis: "observed_address",
      registerName: null,
      registerMnemonic: null,
      registerBasis: "observed_address",
      sourceAddress: "0x08000150",
      operandIndex: 1,
      provenance: "instruction_disassembly",
    });
  });

  it("attributes a write access to a GPIO peripheral register", () => {
    const reference: AnalyzedInstructionReference = {
      target_address: "0x40020014",
      read: false,
      write: true,
      source_address: "0x08000180",
      operand_index: 0,
    };

    const result = attributeHardwareAccess(reference, "arm");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.accessKind).toBe("write");
    expect(result.value.isMmio).toBe(true);
    expect(result.value.peripheralBlockBase).toBe("0x40020000");
    expect(result.value.peripheralBlockOffset).toBe("0x14");
  });

  it("attributes a read/write access to ARM System Control Space (SCS)", () => {
    const reference: AnalyzedInstructionReference = {
      target_address: "0xe000e010",
      read: true,
      write: true,
      source_address: "0x08000200",
    };

    const result = attributeHardwareAccess(reference, "arm");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.regionKind).toBe("system_control");
    expect(result.value.accessKind).toBe("read_write");
    expect(result.value.isMmio).toBe(true);
    expect(result.value.peripheralBlockBase).toBe("0xe000e000");
    expect(result.value.peripheralBlockOffset).toBe("0x10");
    expect(result.value.registerMnemonic).toBe("SysTick_CTRL");
    expect(result.value.registerName).toBe(
      "SysTick Control and Status Register",
    );
    expect(result.value.registerBasis).toBe("architecture_manual");
    expect(result.value.controllerBasis).toBe("observed_address");
  });

  it("distinguishes non-MMIO code and RAM memory accesses", () => {
    const codeRef: AnalyzedInstructionReference = {
      target_address: "0x08000500",
      call: true,
    };
    const codeResult = attributeHardwareAccess(codeRef, "arm");
    expect(codeResult.ok).toBe(true);
    if (!codeResult.ok) return;
    expect(codeResult.value.isMmio).toBe(false);
    expect(codeResult.value.regionKind).toBe("code");

    const ramRef: AnalyzedInstructionReference = {
      target_address: "0x20000400",
      read: true,
    };
    const ramResult = attributeHardwareAccess(ramRef, "arm");
    expect(ramResult.ok).toBe(true);
    if (!ramResult.ok) return;
    expect(ramResult.value.isMmio).toBe(false);
    expect(ramResult.value.regionKind).toBe("sram");
  });

  it("rejects invalid target address representations", () => {
    const invalid: AnalyzedInstructionReference = {
      target_address: "malformed",
    };
    const result = attributeHardwareAccess(invalid, "arm");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("hexadecimal string");
  });
});

describe("Hardware peripheral interaction summarization", () => {
  it("aggregates MMIO accesses into distinct peripheral blocks", () => {
    const references: AnalyzedInstructionReference[] = [
      // Block 0x40011000 (UART1): 2 writes, 1 read
      { target_address: "0x40011000", write: true },
      { target_address: "0x40011004", read: true },
      { target_address: "0x40011004", write: true },
      // Block 0x40020000 (GPIOA): 1 write
      { target_address: "0x40020014", write: true },
      // Non-MMIO accesses: Code and Stack RAM
      { target_address: "0x08000100", call: true },
      { target_address: "0x20000000", read: true },
    ];

    const attributions: HardwareAccessAttribution[] = [];
    for (const ref of references) {
      const attributed = attributeHardwareAccess(ref, "arm");
      if (attributed.ok) attributions.push(attributed.value);
    }

    const summary = summarizeHardwarePeripheralInteractions(
      attributions,
      "arm",
    );

    expect(summary.totalReferencesExamined).toBe(6);
    expect(summary.mmioAccessCount).toBe(4);
    expect(summary.nonMmioAccessCount).toBe(2);
    expect(summary.peripheralBlocks).toHaveLength(2);

    const uartBlock = summary.peripheralBlocks[0];
    expect(uartBlock).toBeDefined();
    if (uartBlock === undefined) return;
    expect(uartBlock.blockBase).toBe("0x40011000");
    expect(uartBlock.regionKind).toBe("peripheral_mmio");
    expect(uartBlock.totalAccesses).toBe(3);
    expect(uartBlock.readCount).toBe(1);
    expect(uartBlock.writeCount).toBe(2);
    expect(uartBlock.uniqueAddresses).toEqual(["0x40011000", "0x40011004"]);
    expect(uartBlock.observedOffsets).toEqual(["0x0", "0x4"]);

    const gpioBlock = summary.peripheralBlocks[1];
    expect(gpioBlock).toBeDefined();
    if (gpioBlock === undefined) return;
    expect(gpioBlock.blockBase).toBe("0x40020000");
    expect(gpioBlock.totalAccesses).toBe(1);
    expect(gpioBlock.writeCount).toBe(1);
    expect(gpioBlock.readCount).toBe(0);
    expect(gpioBlock.observedOffsets).toEqual(["0x14"]);
  });

  it("handles empty attribution sets without error", () => {
    const emptySummary = summarizeHardwarePeripheralInteractions([], "arm");
    expect(emptySummary.totalReferencesExamined).toBe(0);
    expect(emptySummary.mmioAccessCount).toBe(0);
    expect(emptySummary.peripheralBlocks).toEqual([]);
  });

  it("sorts observed register offsets numerically rather than lexicographically", () => {
    const references: AnalyzedInstructionReference[] = [
      { target_address: "0x40011100", write: true },
      { target_address: "0x40011004", read: true },
      { target_address: "0x40011010", write: true },
    ];

    const attributions: HardwareAccessAttribution[] = [];
    for (const ref of references) {
      const attributed = attributeHardwareAccess(ref, "arm");
      if (attributed.ok) attributions.push(attributed.value);
    }

    const summary = summarizeHardwarePeripheralInteractions(
      attributions,
      "arm",
    );

    expect(summary.peripheralBlocks).toHaveLength(1);
    const block = summary.peripheralBlocks[0];
    expect(block).toBeDefined();
    if (block === undefined) return;
    expect(block.observedOffsets).toEqual(["0x4", "0x10", "0x100"]);
    expect(block.uniqueAddresses).toEqual([
      "0x40011004",
      "0x40011010",
      "0x40011100",
    ]);
  });
});

describe("SoC platform-specific peripheral attribution", () => {
  it("attributes exact peripheral coordinates when an explicit SoC platform is provided", () => {
    const stm32Ref: AnalyzedInstructionReference = {
      target_address: "0x40010804",
      write: true,
    };
    const stm32Result = attributeHardwareAccess(stm32Ref, "arm", "stm32f1");
    expect(stm32Result.ok).toBe(true);
    if (!stm32Result.ok) return;
    expect(stm32Result.value.peripheralBlockBase).toBe("0x40010800");
    expect(stm32Result.value.peripheralBlockOffset).toBe("0x4");
    expect(stm32Result.value.regionName).toBe("GPIOA (APB2)");
    expect(stm32Result.value.controllerName).toBe("GPIOA");
    expect(stm32Result.value.controllerBasis).toBe("chip_manual");
    expect(stm32Result.value.registerBasis).toBe("observed_address");
    expect(stm32Result.value.isMmio).toBe(true);

    const esp32Ref: AnalyzedInstructionReference = {
      target_address: "0x3ff40000",
      read: true,
    };
    const esp32Result = attributeHardwareAccess(esp32Ref, "riscv", "esp32");
    expect(esp32Result.ok).toBe(true);
    if (!esp32Result.ok) return;
    expect(esp32Result.value.peripheralBlockBase).toBe("0x3ff40000");
    expect(esp32Result.value.peripheralBlockOffset).toBe("0x0");
    expect(esp32Result.value.regionName).toBe("UART0 (DPort)");
    expect(esp32Result.value.isMmio).toBe(true);
  });
});
