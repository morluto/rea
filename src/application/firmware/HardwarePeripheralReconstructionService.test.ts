import { describe, expect, it } from "vitest";
import {
  hardwarePeripheralReconstructionSchema,
  reconstructHardwareFromReferences,
  reconstructProcedureHardwareInteractions,
} from "./HardwarePeripheralReconstructionService.js";
import type { AnalyzedInstructionReference } from "../../domain/firmware/hardwarePeripheralAttribution.js";
import type {
  AnalysisExecution,
  AnalysisOperationPort,
} from "../AnalysisProvider.js";
import { err, ok } from "../../domain/result.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import {
  ghidraFunctionIdentity,
  ghidraReferenceEdge,
} from "../../domain/ghidraValues.fixture.js";
import { RT_SPARK_FLASH_IMAGE_SHA256 } from "../../domain/firmware/boardDriverLayer.js";

describe("Hardware peripheral reconstruction from offline instruction references", () => {
  it("reconstructs peripheral blocks and identifies standard architectural registers", () => {
    const references: AnalyzedInstructionReference[] = [
      // UART1 registers
      {
        target_address: "0x40011000",
        source_address: "0x08000100",
        write: true,
      },
      {
        target_address: "0x40011004",
        source_address: "0x08000104",
        read: true,
      },
      // SysTick Control Register (ARM SCS standard)
      {
        target_address: "0xe000e010",
        source_address: "0x08000108",
        write: true,
      },
      // Internal SRAM (non-MMIO)
      {
        target_address: "0x20000040",
        source_address: "0x0800010c",
        read: true,
      },
    ];

    const report = reconstructHardwareFromReferences(
      references,
      "arm",
      "uart_init",
    );

    expect(report.procedure).toBe("uart_init");
    expect(report.architecture).toBe("arm");
    expect(report.totalReferencesExamined).toBe(4);
    expect(report.mmioAccessCount).toBe(3);
    expect(report.nonMmioAccessCount).toBe(1);
    expect(report.peripheralBlocks).toHaveLength(2);

    // 0x40011000 is GPIOC on STM32F1 and GD32, and USART1 on STM32F4.
    const uartBlock = report.peripheralBlocks[0];
    expect(uartBlock?.blockBase).toBe("0x40011000");
    expect(uartBlock?.totalAccesses).toBe(2);
    expect(uartBlock?.knownRegisters).toEqual([]);
    expect(uartBlock?.regionName).toBe("Peripheral MMIO");
    expect(uartBlock?.socPeripheralName ?? null).toBeNull();
    expect(report.limitations).toEqual([
      "SoC platform is unresolved because stm32f1, stm32f4, gd32f1 share the highest peripheral match count",
    ]);

    // Block 1: SCS (0xe000e000)
    const scsBlock = report.peripheralBlocks[1];
    expect(scsBlock?.blockBase).toBe("0xe000e000");
    expect(scsBlock?.totalAccesses).toBe(1);
    expect(scsBlock?.knownRegisters).toEqual(["SysTick_CTRL"]);

    const parsed = hardwarePeripheralReconstructionSchema.safeParse(report);
    expect(parsed.success).toBe(true);
  });

  it("records limitations for malformed target address references", () => {
    const references: AnalyzedInstructionReference[] = [
      { target_address: "malformed_addr" },
    ];

    const report = reconstructHardwareFromReferences(references, "arm");
    expect(report.totalReferencesExamined).toBe(0);
    expect(report.limitations).toHaveLength(1);
    expect(report.limitations[0]).toContain("Failed to attribute reference");
  });

  it("enriches peripheral blocks with STM32F1 and ESP32 SoC peripheral definitions", () => {
    // STM32F1 GPIOA and USART1
    const stm32Refs: AnalyzedInstructionReference[] = [
      { target_address: "0x40010804", write: true }, // GPIOA
      { target_address: "0x40013800", read: true }, // USART1
    ];

    const stm32Report = reconstructHardwareFromReferences(
      stm32Refs,
      "arm",
      "stm32_driver",
      "stm32f1",
    );

    expect(stm32Report.peripheralBlocks).toHaveLength(2);
    const gpioa = stm32Report.peripheralBlocks.find(
      (b) => b.blockBase === "0x40010000" || b.socPeripheralName === "GPIOA",
    );
    expect(gpioa?.socPeripheralName).toBe("GPIOA");
    expect(gpioa?.socPeripheralBus).toBe("APB2");

    // ESP32 UART0 and GPIO
    const esp32Refs: AnalyzedInstructionReference[] = [
      { target_address: "0x3ff40000", write: true }, // UART0
      { target_address: "0x3ff44004", read: true }, // GPIO
    ];

    const esp32Report = reconstructHardwareFromReferences(
      esp32Refs,
      "riscv",
      "esp32_app",
      "esp32",
    );

    expect(esp32Report.peripheralBlocks).toHaveLength(2);
    const uart0 = esp32Report.peripheralBlocks.find(
      (b) => b.socPeripheralName === "UART0",
    );
    expect(uart0?.socPeripheralName).toBe("UART0");
    expect(uart0?.socPeripheralBus).toBe("DPort");
  });

  it("automatically detects candidate SoC platform when unspecified", () => {
    const references: AnalyzedInstructionReference[] = [
      { target_address: "0x40010800", write: true },
      { target_address: "0x40013800", read: true },
      { target_address: "0x40021000", write: true },
    ];

    const report = reconstructHardwareFromReferences(references, "arm");
    expect(report.detectedPlatforms.length).toBeGreaterThanOrEqual(1);
    expect(report.detectedPlatforms[0]?.platform).toBe("stm32f1");
    expect(report.detectedPlatforms[0]?.confidence).toBe(1.0);
    expect(report.board).toBeNull();
    expect(report.boardMemory).toEqual([]);
    expect(
      report.peripheralBlocks.every((block) => block.socPeripheralName == null),
    ).toBe(true);
    expect(
      report.peripheralBlocks.every((block) => block.boardDevices.length === 0),
    ).toBe(true);
    expect(report.limitations[0]).toContain("stm32f1, gd32f1");
  });
});

describe("SoC catalog selection", () => {
  it("names a peripheral only when one catalog leads", () => {
    const report = reconstructHardwareFromReferences(
      [{ target_address: "0x40023800", read: true }],
      "arm",
    );

    expect(report.detectedPlatforms).toEqual([
      {
        platform: "stm32f4",
        matchedCount: 1,
        totalAddresses: 1,
        confidence: 1,
        matchedPeripherals: ["RCC"],
      },
    ]);
    expect(report.peripheralBlocks[0]?.socPeripheralName).toBe("RCC");
    expect(report.peripheralBlocks[0]?.regionKind).toBe("peripheral_mmio");
    expect(report.limitations).toEqual([]);
  });

  it("keeps an ESP32-C UART when unrelated references are present", () => {
    const report = reconstructHardwareFromReferences(
      [
        { target_address: "0x60000000", read: true },
        { target_address: "0x20000040", read: true },
        { target_address: "0x80001000", read: true },
      ],
      "riscv",
    );

    expect(report.detectedPlatforms[0]).toMatchObject({
      platform: "esp32",
      matchedCount: 1,
      totalAddresses: 1,
      confidence: 1,
    });
    const uart = report.peripheralBlocks.find(
      (block) => block.socPeripheralName === "UART0",
    );
    expect(uart?.regionKind).toBe("peripheral_mmio");
    expect(uart?.socPeripheralBus).toBe("System");
  });

  it("does not rename an x86 data read to an ESP32 UART", () => {
    const report = reconstructHardwareFromReferences(
      [{ target_address: "0x3ff40000", read: true }],
      "x86",
    );

    expect(report.detectedPlatforms).toEqual([]);
    expect(
      report.peripheralBlocks.some((block) =>
        (block.socPeripheralName ?? "").includes("UART0"),
      ),
    ).toBe(false);
    expect(report.attributions[0]?.regionName).toBe("System RAM");
    expect(report.attributions[0]?.isMmio).toBe(false);
  });
});

describe("RT-Spark board annotation", () => {
  it("annotates RT-Spark controllers and corrects CCM to data RAM", () => {
    const references: AnalyzedInstructionReference[] = [
      { target_address: "0x40011000", write: true },
      { target_address: "0x40003800", write: true },
      { target_address: "0x40021400", write: true },
      { target_address: "0x40005400", read: true },
      { target_address: "0x10000000", write: true },
      { target_address: "0x08000100", read: true },
    ];

    const report = reconstructHardwareFromReferences(
      references,
      "arm",
      "rt_spark_init",
      null,
      "stm32f407-rt-spark",
    );

    expect(report.board).toBe("stm32f407-rt-spark");
    expect(report.boardMcu).toBe("STM32F407ZGT6");
    expect(report.platform).toBeNull();

    const usart = report.peripheralBlocks.find(
      (block) => block.socPeripheralName === "USART1",
    );
    expect(usart?.boardDevices.map((device) => device.id)).toEqual([
      "usb-uart-com1",
    ]);
    expect(usart?.boardDrivers.map((driver) => driver.id)).toEqual([
      "serial-usart1",
    ]);
    expect(usart?.boardDrivers[0]?.linkage).toBe("linked_in_image");
    expect(usart?.socPeripheralNameBasis).toBe("chip_manual");
    expect(
      report.attributions.find((item) => item.targetAddress === "0x40011000")
        ?.controllerBasis,
    ).toBe("chip_manual");

    const spi = report.peripheralBlocks.find(
      (block) => block.socPeripheralName === "SPI2",
    );
    expect(spi?.boardDevices.map((device) => device.id)).toEqual([
      "rw007",
      "spi-flash",
    ]);
    expect(
      spi?.boardDevices.find((device) => device.id === "spi-flash")
        ?.uncertainty,
    ).toContain("W25Q128");

    const gpiof = report.peripheralBlocks.find(
      (block) => block.socPeripheralName === "GPIOF",
    );
    expect(gpiof?.boardDevices.map((device) => device.id)).toEqual([
      "ap3216c",
      "audio",
      "icm20608",
      "led-b",
      "led-r",
    ]);

    const i2c = report.peripheralBlocks.find(
      (block) => block.socPeripheralName === "I2C1",
    );
    expect(i2c?.boardDevices).toEqual([]);

    const ccm = report.attributions.find(
      (item) => item.targetAddress === "0x10000000",
    );
    expect(ccm).toMatchObject({
      regionName: "STM32F407 CCM data RAM",
      regionKind: "sram",
      isMmio: false,
    });
    expect(
      report.boardMemory.find((item) => item.id === "ccm")?.accessCount,
    ).toBe(1);
    expect(
      report.boardMemory.find((item) => item.id === "internal-flash")
        ?.accessCount,
    ).toBe(1);
    expect(report.boardUnboundDevices.map((device) => device.id)).toEqual([
      "usb-device",
      "usb-host",
    ]);
    expect(
      report.boardDrivers.find((driver) => driver.id === "rw007"),
    ).toMatchObject({ linkage: "linked_in_image", controllers: ["SPI2"] });
    expect(
      report.boardDrivers.find((driver) => driver.id === "esp8266")?.linkage,
    ).toBe("not_observed");
    expect(report.unsettledFacts.map((fact) => fact.subject)).toEqual(
      expect.arrayContaining(["spi-flash", "led-b", "usb-device", "usb-host"]),
    );
    expect(
      report.unsettledFacts.every((fact) => fact.basis === "unsettled"),
    ).toBe(true);
    const cortex = reconstructHardwareFromReferences(
      references,
      "cortex-m",
      "rt_spark_init",
      null,
      "stm32f407-rt-spark",
    );
    expect(
      cortex.peripheralBlocks.find(
        (block) => block.socPeripheralName === "USART1",
      )?.boardDrivers[0]?.id,
    ).toBe("serial-usart1");
    expect(cortex.architecture).toBe("cortex-m");
    expect(report.limitations.join("\n")).toContain("software I2C");
    expect(
      hardwarePeripheralReconstructionSchema.safeParse(report).success,
    ).toBe(true);
  });

  it("does not apply RT-Spark devices when the caller platform is a different family", () => {
    const report = reconstructHardwareFromReferences(
      [{ target_address: "0x40011000", write: true }],
      "arm",
      "mismatch",
      "stm32f1",
      "stm32f407-rt-spark",
    );
    expect(report.boardMcu).toBeNull();
    expect(
      report.peripheralBlocks.every((block) => block.boardDevices.length === 0),
    ).toBe(true);
    expect(report.limitations[0]).toContain("does not match");
  });
});

describe("hardware claim identity", () => {
  it("keeps each hardware claim's subject, rule, and source", () => {
    const report = reconstructHardwareFromReferences(
      [{ target_address: "0x40011000", write: true }],
      "arm",
      "rt_spark_init",
      null,
      "stm32f407-rt-spark",
    );
    const usart = report.peripheralBlocks.find(
      (block) => block.socPeripheralName === "USART1",
    );

    expect(report.hardwareClaims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject: usart?.blockBase,
          rule: "chip-manual-name",
          basis: "chip_manual",
          settled: true,
          source: "0x40011000",
        }),
        expect.objectContaining({
          subject: "spi-flash",
          rule: "installed-part",
          basis: "unsettled",
          settled: false,
          reason: expect.stringContaining("W25Q128"),
        }),
        expect.objectContaining({
          subject: "led-b",
          rule: "board-record",
          basis: "unsettled",
          settled: false,
          reason: expect.stringContaining("green"),
        }),
        expect.objectContaining({
          subject: "serial-usart1",
          rule: "driver-linkage",
          basis: "observed_address",
          settled: true,
          source: expect.stringContaining(RT_SPARK_FLASH_IMAGE_SHA256),
        }),
      ]),
    );
    expect(
      hardwarePeripheralReconstructionSchema.safeParse(report).success,
    ).toBe(true);
  });
});

describe("Hardware peripheral reconstruction through analysis operation port", () => {
  it("queries procedure references and reconstructs peripheral interaction profile", async () => {
    const mockExecution: AnalysisExecution = {
      result: {
        procedure: ghidraFunctionIdentity(),
        direction: "outgoing",
        reference_kinds_available: true,
        references: [
          {
            source_address: "0x08000200",
            target_address: "0x40020000", // GPIOA MODER
            source_procedure: ghidraFunctionIdentity(),
            target_procedure: null,
            kind: {
              available: true,
              provenance: "test",
              type: "WRITE",
              flow: false,
              call: false,
              jump: false,
              data: true,
              read: false,
              write: true,
              indirect: false,
              computed: false,
              conditional: false,
              terminal: false,
              primary: true,
              operand_index: 0,
              external: false,
            },
          },
          {
            source_address: "0x08000204",
            target_address: "0xe000e100", // NVIC_ISER0
            source_procedure: ghidraFunctionIdentity(),
            target_procedure: null,
            kind: {
              available: true,
              provenance: "test",
              type: "WRITE",
              flow: false,
              call: false,
              jump: false,
              data: true,
              read: false,
              write: true,
              indirect: false,
              computed: false,
              conditional: false,
              terminal: false,
              primary: true,
              operand_index: 0,
              external: false,
            },
          },
          {
            // Pure function call (should be filtered out of MMIO attribution)
            source_address: "0x08000208",
            target_address: "0x08000500",
            source_procedure: ghidraFunctionIdentity(),
            target_procedure: null,
            kind: {
              available: true,
              provenance: "test",
              type: "CALL",
              flow: true,
              call: true,
              jump: false,
              data: false,
              read: false,
              write: false,
              indirect: false,
              computed: false,
              conditional: false,
              terminal: false,
              primary: true,
              operand_index: 0,
              external: false,
            },
          },
        ],
        unresolved_calls: [],
      },
      rawResult: null,
      provider: { id: "ghidra", name: "Ghidra", version: "12.1.4" },
      locations: [],
      subject: {
        sha256: "a".repeat(64),
        path: "/tmp/firmware.bin",
        format: "raw-binary",
        architecture: "arm",
      },
      limitations: [],
    };

    const mockPort: AnalysisOperationPort = {
      execute: (operation, parameters) => {
        expect(operation).toBe("procedure_references");
        expect(parameters).toEqual({
          procedure: "gpio_setup",
          direction: "outgoing",
        });
        return Promise.resolve(ok(mockExecution));
      },
    };

    const result = await reconstructProcedureHardwareInteractions(mockPort, {
      procedure: "gpio_setup",
      architecture: "arm",
    });

    if (!result.ok) throw result.error;

    expect(result.value.procedure).toBe("gpio_setup");
    expect(result.value.totalReferencesExamined).toBe(2);
    expect(result.value.mmioAccessCount).toBe(2);
    expect(result.value.peripheralBlocks).toHaveLength(2);

    const nvicBlock = result.value.peripheralBlocks.find(
      (b) => b.blockBase === "0xe000e000",
    );
    expect(nvicBlock?.knownRegisters).toContain("NVIC_ISER0");
  });
});

describe("controller names come from observed addresses", () => {
  it("does not label a missed page base as the neighboring controller", () => {
    const report = reconstructHardwareFromReferences(
      [
        { target_address: "0x40011800", read: true },
        { target_address: "0x40011000", write: true },
      ],
      "arm",
      "gpio_touch",
      "stm32f1",
    );
    const gpioc = report.peripheralBlocks.find(
      (block) => block.socPeripheralName === "GPIOC",
    );
    const missed = report.peripheralBlocks.find((block) =>
      block.uniqueAddresses.includes("0x40011800"),
    );
    expect(gpioc?.uniqueAddresses).toEqual(["0x40011000"]);
    expect(missed?.socPeripheralName ?? null).toBeNull();
    expect(missed?.socPeripheralNameBasis).toBe("observed_address");
  });
});

describe("Hardware peripheral reconstruction input failures", () => {
  it("propagates cancellation and input validation errors", async () => {
    const mockPort: AnalysisOperationPort = {
      execute: () =>
        Promise.resolve(err(new AnalysisOutputError("test", "fail"))),
    };

    const controller = new AbortController();
    controller.abort();

    const cancelled = await reconstructProcedureHardwareInteractions(
      mockPort,
      { procedure: "test_fn", architecture: "arm" },
      { signal: controller.signal },
    );
    expect(cancelled.ok).toBe(false);
    if (cancelled.ok) return;
    expect(cancelled.error._tag).toBe("AnalysisCancelledError");

    const invalidInput = await reconstructProcedureHardwareInteractions(
      mockPort,
      { procedure: "", architecture: "arm" },
    );
    expect(invalidInput.ok).toBe(false);
    if (invalidInput.ok) return;
    expect(invalidInput.error._tag).toBe("AnalysisInputError");

    const mismatchedBoard = await reconstructProcedureHardwareInteractions(
      mockPort,
      {
        procedure: "test_fn",
        architecture: "arm",
        platform: "stm32f1",
        board: "stm32f407-rt-spark",
      },
    );
    expect(mismatchedBoard.ok).toBe(false);
    if (mismatchedBoard.ok) return;
    expect(mismatchedBoard.error._tag).toBe("AnalysisInputError");
  });
});

describe("Ghidra procedure reference shape", () => {
  it("keeps classification, body, direction, and source_procedure", async () => {
    const edge = { ...ghidraReferenceEdge(), target_address: "0x40011000" };
    const execution: AnalysisExecution = {
      result: {
        procedure: ghidraFunctionIdentity(),
        direction: "outgoing",
        reference_kinds_available: true,
        references: [edge],
        unresolved_calls: [],
      },
      rawResult: null,
      provider: { id: "ghidra", name: "Ghidra", version: "12.1.4" },
      locations: [],
      subject: {
        sha256: "b".repeat(64),
        path: "/tmp/firmware.bin",
        format: "raw-binary",
        architecture: "arm",
      },
      limitations: [],
    };
    const result = await reconstructProcedureHardwareInteractions(
      { execute: () => Promise.resolve(ok(execution)) },
      { procedure: "fixture_main", architecture: "arm", platform: "stm32f4" },
    );

    if (!result.ok) throw result.error;
    expect(result.value.totalReferencesExamined).toBe(1);
    expect(result.value.attributions[0]?.targetAddress).toBe("0x40011000");
  });

  it("keeps provider limitations ahead of local address errors", async () => {
    const providerLimitation = "Ghidra omitted operand kinds for one edge";
    const execution: AnalysisExecution = {
      result: {
        procedure: ghidraFunctionIdentity(),
        direction: "outgoing",
        reference_kinds_available: true,
        references: [
          ghidraReferenceEdge(),
          { ...ghidraReferenceEdge(), target_address: "not-an-address" },
        ],
        unresolved_calls: [],
      },
      rawResult: null,
      provider: { id: "ghidra", name: "Ghidra", version: "12.1.4" },
      locations: [],
      subject: {
        sha256: "c".repeat(64),
        path: "/tmp/firmware.bin",
        format: "raw-binary",
        architecture: "arm",
      },
      limitations: [providerLimitation],
    };

    const result = await reconstructProcedureHardwareInteractions(
      { execute: () => Promise.resolve(ok(execution)) },
      { procedure: "fixture_main", architecture: "arm" },
    );

    if (!result.ok) throw result.error;
    expect(result.value.limitations[0]).toBe(providerLimitation);
    expect(result.value.limitations.at(-1)).toContain(
      "Failed to attribute reference to not-an-address",
    );
  });
});
