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
} from "../../ports/AnalysisProvider.js";
import { err, ok } from "../../domain/result.js";
import {
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
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
      "SoC platform is unresolved because stm32f1, stm32f4, stm32h7, gd32f1, gd32f4, rp2040, nrf52 share the highest peripheral match count",
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
      "xtensa",
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
      [{ target_address: "0x3ff40000", read: true }],
      "xtensa",
    );

    expect(report.detectedPlatforms).toEqual([
      {
        platform: "esp32",
        matchedCount: 1,
        totalAddresses: 1,
        confidence: 1,
        matchedPeripherals: ["UART0"],
      },
    ]);
    expect(report.peripheralBlocks[0]?.socPeripheralName).toBe("UART0");
    expect(report.peripheralBlocks[0]?.regionKind).toBe("peripheral_mmio");
    expect(report.limitations).toEqual([]);
  });

  it("does not name a controller when STM32F4 and GD32F4 share the window", () => {
    const report = reconstructHardwareFromReferences(
      [{ target_address: "0x40023800", read: true }],
      "arm",
    );

    expect(
      report.detectedPlatforms.map((candidate) => candidate.platform),
    ).toEqual(["stm32f4", "gd32f4"]);
    expect(
      report.detectedPlatforms.every(
        (candidate) => candidate.matchedCount === 1,
      ),
    ).toBe(true);
    expect(report.peripheralBlocks[0]?.socPeripheralName).toBeNull();
    expect(report.limitations[0]).toContain("stm32f4, gd32f4");
  });

  it("names an RP2040 UART when no other catalog owns the window", () => {
    const report = reconstructHardwareFromReferences(
      [{ target_address: "0x40034000", read: true }],
      "arm",
    );

    expect(report.detectedPlatforms).toEqual([
      {
        platform: "rp2040",
        matchedCount: 1,
        totalAddresses: 1,
        confidence: 1,
        matchedPeripherals: ["UART0"],
      },
    ]);
    expect(report.peripheralBlocks[0]?.socPeripheralName).toBe("UART0");
    expect(report.peripheralBlocks[0]?.socPeripheralBus).toBe("APB");
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

    expect(
      report.detectedPlatforms.map((candidate) => candidate.platform),
    ).toEqual(["esp32c2", "esp32c3", "esp32c6", "esp32h2"]);
    expect(
      report.detectedPlatforms.every(
        (candidate) =>
          candidate.matchedCount === 1 && candidate.totalAddresses === 1,
      ),
    ).toBe(true);
    expect(report.mmioAccessCount).toBe(1);
    expect(report.nonMmioAccessCount).toBe(2);
    expect(report.peripheralBlocks).toEqual([
      expect.objectContaining({
        blockBase: "0x60000000",
        regionKind: "peripheral_mmio",
        regionName: "Peripheral MMIO",
        socPeripheralName: null,
        socPeripheralNameBasis: "observed_address",
      }),
    ]);
    expect(report.limitations[0]).toContain(
      "esp32c2, esp32c3, esp32c6, esp32h2",
    );
  });

  it("names the ESP32-C6 low-power UART when no other catalog owns the window", () => {
    const report = reconstructHardwareFromReferences(
      [{ target_address: "0x600b1400", read: true }],
      "riscv",
    );

    expect(report.detectedPlatforms).toEqual([
      {
        platform: "esp32c6",
        matchedCount: 1,
        totalAddresses: 1,
        confidence: 1,
        matchedPeripherals: ["LP_UART"],
      },
    ]);
    expect(report.peripheralBlocks[0]?.socPeripheralName).toBe("LP_UART");
    expect(report.limitations).toEqual([]);
  });

  it("names the ESP32-C3 USB serial block when no other catalog owns it", () => {
    const report = reconstructHardwareFromReferences(
      [{ target_address: "0x60043000", read: true }],
      "riscv",
    );

    expect(report.detectedPlatforms).toEqual([
      {
        platform: "esp32c3",
        matchedCount: 1,
        totalAddresses: 1,
        confidence: 1,
        matchedPeripherals: ["USB_SERIAL_JTAG"],
      },
    ]);
    expect(report.peripheralBlocks[0]?.socPeripheralName).toBe(
      "USB_SERIAL_JTAG",
    );
    expect(report.limitations).toEqual([]);
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

describe("ESP32-C2 catalog selection", () => {
  it("names the ESP32-C2 I2C master when no other catalog owns it", () => {
    const report = reconstructHardwareFromReferences(
      [{ target_address: "0x6004e800", read: true }],
      "riscv",
    );

    expect(report.detectedPlatforms).toEqual([
      {
        platform: "esp32c2",
        matchedCount: 1,
        totalAddresses: 1,
        confidence: 1,
        matchedPeripherals: ["I2C_MST"],
      },
    ]);
    expect(report.peripheralBlocks[0]?.socPeripheralName).toBe("I2C_MST");
    expect(report.limitations).toEqual([]);
  });

  it("does not name the sensitive block when C2 and C3 share it", () => {
    const report = reconstructHardwareFromReferences(
      [{ target_address: "0x600c1000", read: true }],
      "riscv",
    );

    expect(
      report.detectedPlatforms.map((candidate) => candidate.platform),
    ).toEqual(["esp32c2", "esp32c3"]);
    expect(
      report.peripheralBlocks.some(
        (block) => block.socPeripheralName === "SENSITIVE",
      ),
    ).toBe(false);
    expect(report.limitations[0]).toContain("esp32c2, esp32c3");
  });
});

describe("ESP32-H2 catalog selection", () => {
  it("names the ESP32-H2 ECDSA block when no other catalog owns it", () => {
    const report = reconstructHardwareFromReferences(
      [{ target_address: "0x6008e000", read: true }],
      "riscv",
    );

    expect(report.detectedPlatforms).toEqual([
      {
        platform: "esp32h2",
        matchedCount: 1,
        totalAddresses: 1,
        confidence: 1,
        matchedPeripherals: ["ECDSA"],
      },
    ]);
    expect(report.peripheralBlocks[0]?.socPeripheralName).toBe("ECDSA");
    expect(report.limitations).toEqual([]);
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
      { subjectSha256: RT_SPARK_FLASH_IMAGE_SHA256 },
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
    expect(spi?.boardDrivers.map((driver) => driver.id)).not.toContain(
      "spi-flash",
    );
    expect(
      report.boardDrivers.find((driver) => driver.id === "spi-flash"),
    ).toMatchObject({ controllers: ["RCC", "GPIOB"] });
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
    ).toMatchObject({ linkage: "linked_in_image", controllers: ["GPIOF"] });
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
      { subjectSha256: RT_SPARK_FLASH_IMAGE_SHA256 },
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
});

describe("captured RT-Spark image", () => {
  it("decodes the captured image onto the RT-Spark report", () => {
    const report = reconstructHardwareFromReferences(
      [],
      "cortex-m",
      "rt_spark_image",
      null,
      "stm32f407-rt-spark",
      { subjectSha256: RT_SPARK_FLASH_IMAGE_SHA256 },
    );
    expect(
      report.hardwareClaims.find(
        (claim) => claim.subject === "spi2" && claim.source === "0x08060378",
      ),
    ).toMatchObject({ rule: "driver-linkage", settled: true });
    expect(
      report.hardwareClaims.find(
        (claim) => claim.subject === "SPI2" && claim.source === "0x080604e4",
      ),
    ).toBeUndefined();
    expect(
      report.hardwareClaims.find(
        (claim) => claim.subject === "SPI2" && claim.source === "0x080742b0",
      ),
    ).toMatchObject({ basis: "chip_manual" });
    expect(
      report.hardwareClaims.find((claim) => claim.subject === "pin:0x5c"),
    ).toMatchObject({
      rule: "instruction-decode",
      settled: true,
      source: expect.stringContaining("port=5 pin=12"),
    });
    expect(
      report.hardwareClaims.find((claim) => claim.subject === "pin-base:0x5c"),
    ).toMatchObject({ basis: "explicit_profile", source: "0x40021400" });
    expect(
      report.hardwareClaims.find((claim) => claim.subject === "gpio-role:5:12"),
    ).toMatchObject({ rule: "board-record", settled: false });
    expect(
      report.hardwareClaims.find((claim) => claim.subject === "spi-flash-part"),
    ).toMatchObject({
      rule: "installed-part",
      settled: false,
      reason: expect.stringContaining("W25Q128BV"),
    });
    expect(
      report.hardwareClaims.find(
        (claim) => claim.subject === "pll:0x0800c704:PLLM",
      ),
    ).toMatchObject({ source: "0x24003010=16" });
    expect(
      report.hardwareClaims.find(
        (claim) => claim.subject === "pll-frequency:0x0800c704",
      ),
    ).toMatchObject({ settled: false });
    expect(
      report.hardwareClaims.find(
        (claim) => claim.subject === "sysclk:0x0800c77c",
      ),
    ).toMatchObject({
      settled: true,
      source: "0xf42400*0xa8/0x8/0x2=0xa037a00",
    });
    expect(
      report.hardwareClaims.find((claim) => claim.subject === "Reset"),
    ).toMatchObject({ rule: "architecture-register", settled: true });
    expect(
      report.hardwareClaims.find(
        (claim) => claim.subject === "TIM3" && claim.source === "0x08012ef0",
      ),
    ).toMatchObject({ basis: "chip_manual" });
    expect(
      report.hardwareClaims.find(
        (claim) => claim.subject === "SDIO" && claim.source === "0x0805fb44",
      ),
    ).toMatchObject({ basis: "chip_manual" });
    expect(
      report.hardwareClaims.find(
        (claim) => claim.subject === "RTC" && claim.source === "0x0806466c",
      ),
    ).toMatchObject({ basis: "chip_manual" });
    expect(
      report.hardwareClaims.find(
        (claim) => claim.subject === "GPIOI" && claim.source === "0x0800e2de",
      ),
    ).toMatchObject({ basis: "chip_manual" });
    expect(
      report.hardwareClaims.filter(
        (claim) =>
          claim.subject === "ADC1_3" && claim.rule === "chip-manual-name",
      ),
    ).toHaveLength(3);
  });

  it("keeps boot immediates raw and names architectural registers", () => {
    const report = reconstructHardwareFromReferences(
      [],
      "cortex-m",
      "rt_spark_boot",
      null,
      "stm32f407-rt-spark",
      { subjectSha256: RT_SPARK_FLASH_IMAGE_SHA256 },
    );
    expect(
      report.hardwareClaims.find((claim) => claim.subject === "VTOR"),
    ).toMatchObject({ rule: "architecture-register", source: "0x0800c704" });
    expect(
      report.hardwareClaims.find((claim) => claim.subject === "CPACR"),
    ).toMatchObject({ rule: "architecture-register" });
    expect(
      report.hardwareClaims.find(
        (claim) => claim.subject === "immediate:0x0800c704:0xe000ed08",
      ),
    ).toMatchObject({ source: "0x8000000" });
    expect(
      report.hardwareClaims.find(
        (claim) => claim.subject === "immediate:0x08054fc2",
      ),
    ).toMatchObject({ source: "0x1f4" });
    expect(
      report.hardwareClaims.some((claim) =>
        /500|millisecond|\bms\b/i.test(claim.reason),
      ),
    ).toBe(false);
    expect(
      report.hardwareClaims.find(
        (claim) => claim.subject === "SPI2" && claim.source === "0x080742b0",
      ),
    ).toMatchObject({ basis: "chip_manual" });
    expect(
      report.hardwareClaims.find(
        (claim) => claim.subject === "mask:0x0800e244",
      ),
    ).toMatchObject({ source: "0x10" });
    expect(
      report.hardwareClaims.find((claim) => claim.subject === "uart1"),
    ).toMatchObject({ rule: "driver-linkage", source: "0x0800c786" });
  });
});

describe("captured RT-Spark vectors and extra loads", () => {
  it("names the other exception slots and the extra controller loads", () => {
    const report = reconstructHardwareFromReferences(
      [],
      "cortex-m",
      "rt_spark_vectors",
      null,
      "stm32f407-rt-spark",
      { subjectSha256: RT_SPARK_FLASH_IMAGE_SHA256 },
    );
    expect(
      report.hardwareClaims.find((claim) => claim.subject === "NMI"),
    ).toMatchObject({
      rule: "architecture-register",
      source: "0x08000008",
      settled: true,
    });
    expect(
      report.hardwareClaims.find((claim) => claim.subject === "vector:7"),
    ).toMatchObject({ settled: false, source: "0x0800001c" });
    expect(
      report.hardwareClaims.find((claim) => claim.subject === "WWDG"),
    ).toBeUndefined();
    expect(
      report.hardwareClaims.find(
        (claim) => claim.subject === "USART6" && claim.source === "0x0800c5c8",
      ),
    ).toMatchObject({ basis: "chip_manual" });
    expect(
      report.hardwareClaims.find(
        (claim) =>
          claim.subject === "USB_OTG_FS" && claim.source === "0x080ccfb4",
      ),
    ).toMatchObject({ basis: "chip_manual" });
    expect(
      report.hardwareClaims.find(
        (claim) =>
          claim.subject === "USB_OTG_HS" && claim.source === "0x080aee94",
      ),
    ).toMatchObject({ basis: "chip_manual" });
    for (const subject of ["USART2", "I2C1", "CAN1", "FSMC"]) {
      expect(
        report.hardwareClaims.find(
          (claim) =>
            claim.subject === subject && claim.rule === "chip-manual-name",
        ),
      ).toBeUndefined();
    }
  });
});

describe("RT-Spark platform mismatch", () => {
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
      { subjectSha256: RT_SPARK_FLASH_IMAGE_SHA256 },
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
    expect(result.value.producingSource).toMatchObject({
      subjectSha256: "a".repeat(64),
      subjectPath: "/tmp/firmware.bin",
      providerId: "ghidra",
      evidenceId: null,
      evidenceLinks: [],
    });
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
    // On STM32F1, 0x40003000 is IWDG (0x400 bytes) while 0x40003400 is architecturally Reserved.
    const report = reconstructHardwareFromReferences(
      [
        { target_address: "0x40003400", read: true },
        { target_address: "0x40003000", write: true },
      ],
      "arm",
      "iwdg_touch",
      "stm32f1",
    );
    const iwdg = report.peripheralBlocks.find(
      (block) => block.socPeripheralName === "IWDG",
    );
    const missed = report.peripheralBlocks.find((block) =>
      block.uniqueAddresses.includes("0x40003400"),
    );
    expect(iwdg?.uniqueAddresses).toEqual(["0x40003000"]);
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
    expect(invalidInput.error).toBeInstanceOf(AnalysisInputError);
    if (invalidInput.error instanceof AnalysisInputError) {
      expect(invalidInput.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ["procedure"] }),
        ]),
      );
    }

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
    expect(mismatchedBoard.error).toBeInstanceOf(AnalysisInputError);
    if (mismatchedBoard.error instanceof AnalysisInputError) {
      expect(mismatchedBoard.error.issues[0]?.path).toEqual(["board"]);
    }
  });

  it("keeps a provider failure when cancellation arrives during the query", async () => {
    const controller = new AbortController();
    const result = await reconstructProcedureHardwareInteractions(
      {
        execute: () => {
          controller.abort("stopped");
          return Promise.resolve(err(new AnalysisOutputError("test", "fail")));
        },
      },
      { procedure: "test_fn", architecture: "arm" },
      { signal: controller.signal },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error._tag).toBe("AnalysisOutputError");
    expect(result.error.secondaryFailures[0]).toMatchObject({
      _tag: "AnalysisCancelledError",
      cause: "stopped",
    });
  });

  it("returns cancellation with the built report when the query finishes after abort", async () => {
    const controller = new AbortController();
    const execution: AnalysisExecution = {
      result: {
        procedure: ghidraFunctionIdentity(),
        direction: "outgoing",
        reference_kinds_available: true,
        references: [ghidraReferenceEdge()],
        unresolved_calls: [],
      },
      rawResult: null,
      provider: { id: "ghidra", name: "Ghidra", version: "12.1.4" },
      locations: [],
      subject: {
        sha256: "d".repeat(64),
        path: "/tmp/other.bin",
        format: "raw-binary",
        architecture: "arm",
      },
      evidenceId: "ev_" + "d".repeat(64),
      limitations: [],
    };
    const result = await reconstructProcedureHardwareInteractions(
      {
        execute: () => {
          controller.abort("stopped");
          return Promise.resolve(ok(execution));
        },
      },
      { procedure: "fixture_main", architecture: "arm" },
      { signal: controller.signal },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(result.error.cause).toBe("stopped");
    expect(result.error.partialObservation).toMatchObject({
      kind: "hardware-peripheral-reconstruction",
      procedure: "fixture_main",
      subjectSha256: "d".repeat(64),
      providerId: "ghidra",
      evidenceId: "ev_" + "d".repeat(64),
    });
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

describe("dynamic SVD/Devicetree profiles and container hints", () => {
  it("reconstructs custom SVD peripherals and registers with explicit-profile claims", async () => {
    const svdXml = `
      <device>
        <name>VENDOR_X1</name>
        <peripherals>
          <peripheral>
            <name>PWMX</name>
            <groupName>APB</groupName>
            <baseAddress>0x40090000</baseAddress>
            <addressBlock><offset>0</offset><size>0x400</size><usage>registers</usage></addressBlock>
            <registers>
              <register><name>DUTY</name><description>Duty cycle</description><addressOffset>0x08</addressOffset></register>
            </registers>
          </peripheral>
        </peripherals>
      </device>
    `;
    const execution: AnalysisExecution = {
      result: {
        procedure: ghidraFunctionIdentity(),
        direction: "outgoing",
        reference_kinds_available: true,
        references: [
          { ...ghidraReferenceEdge(), target_address: "0x40090008" },
        ],
        unresolved_calls: [],
      },
      rawResult: null,
      provider: { id: "ghidra", name: "Ghidra", version: "12.2" },
      locations: [],
      subject: {
        sha256: "d".repeat(64),
        path: "/tmp/vendor.bin",
        format: "raw-binary",
        architecture: "cortex-m",
      },
      limitations: [],
    };

    const result = await reconstructProcedureHardwareInteractions(
      { execute: () => Promise.resolve(ok(execution)) },
      {
        procedure: "pwm_set",
        architecture: "cortex-m",
        svd_xml: svdXml,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.customProfile).toMatchObject({
      id: "VENDOR_X1",
      sourceKind: "cmsis_svd",
      sourceSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(result.value.peripheralBlocks[0]).toMatchObject({
      socPeripheralName: "PWMX",
      socPeripheralNameBasis: "explicit_profile",
      socPeripheralBus: "APB",
      knownRegisters: ["PWMX_DUTY"],
    });
    expect(
      result.value.hardwareClaims.some(
        (claim) =>
          claim.rule === "explicit-profile" &&
          claim.settled &&
          claim.subject === "0x40090000" &&
          claim.source.includes("cmsis_svd:VENDOR_X1@"),
      ),
    ).toBe(true);
    expect(
      hardwarePeripheralReconstructionSchema.safeParse(result.value).success,
    ).toBe(true);

    const bothRejected = await reconstructProcedureHardwareInteractions(
      { execute: () => Promise.resolve(ok(execution)) },
      {
        procedure: "pwm_set",
        architecture: "cortex-m",
        svd_xml: svdXml,
        devicetree: {
          artifact: { path: "/tmp/a.dtb", sha256: "e".repeat(64), bytes: 64 },
          header: {
            magic: 0xd00dfeed,
            totalsize: 64,
            off_dt_struct: 40,
            off_dt_strings: 56,
            off_mem_rsvmap: 40,
            version: 17,
            last_comp_version: 16,
            boot_cpuid_phys: 0,
            size_dt_strings: 8,
            size_dt_struct: 16,
          },
          reservations: [],
          nodes: [{ path: "/", parent: null, offset: 0, properties: [] }],
          references: [],
          summary: {
            confidence: "derived",
            compatible: null,
            model: null,
            bootargs: null,
            stdout_path: null,
            aliases: [],
          },
          coverage: {
            status: "complete",
            examined_nodes: 1,
            examined_properties: 0,
          },
          limitations: [],
        },
      },
    );
    expect(bothRejected.ok).toBe(false);
    if (!bothRejected.ok) {
      expect(bothRejected.error._tag).toBe("AnalysisInputError");
    }
  });
});

describe("firmware container hints (esp_chip_id and uf2_family_id)", () => {
  it("selects SoC catalogs from ESP chip_id and UF2 family_id hints without overriding explicit platform", async () => {
    const execution: AnalysisExecution = {
      result: {
        procedure: ghidraFunctionIdentity(),
        direction: "outgoing",
        reference_kinds_available: true,
        references: [
          { ...ghidraReferenceEdge(), target_address: "0x60038000" },
        ],
        unresolved_calls: [],
      },
      rawResult: null,
      provider: { id: "ghidra", name: "Ghidra", version: "12.2" },
      locations: [],
      subject: {
        sha256: "f".repeat(64),
        path: "/tmp/esp32s3.bin",
        format: "raw-binary",
        architecture: "xtensa",
      },
      limitations: [],
    };

    const s3Result = await reconstructProcedureHardwareInteractions(
      { execute: () => Promise.resolve(ok(execution)) },
      {
        procedure: "usb_init",
        architecture: "xtensa",
        esp_chip_id: 0x0009,
      },
    );
    if (!s3Result.ok) throw s3Result.error;
    expect(s3Result.value.platform).toBe("esp32s3");
    expect(s3Result.value.peripheralBlocks[0]?.socPeripheralName).toBe(
      "USB_SERIAL_JTAG",
    );

    // Cyclic Devicetree parent links return AnalysisInputError instead of hanging
    const cyclicDtb = await reconstructProcedureHardwareInteractions(
      { execute: () => Promise.resolve(ok(execution)) },
      {
        procedure: "usb_init",
        architecture: "xtensa",
        devicetree: {
          artifact: { path: "/tmp/c.dtb", sha256: "e".repeat(64), bytes: 64 },
          header: {
            magic: 0xd00dfeed,
            totalsize: 64,
            off_dt_struct: 40,
            off_dt_strings: 56,
            off_mem_rsvmap: 40,
            version: 17,
            last_comp_version: 16,
            boot_cpuid_phys: 0,
            size_dt_strings: 8,
            size_dt_struct: 16,
          },
          reservations: [],
          nodes: [
            { path: "/", parent: null, offset: 0, properties: [] },
            { path: "/loop", parent: "/loop", offset: 16, properties: [] },
          ],
          references: [],
          summary: {
            confidence: "derived",
            compatible: null,
            model: null,
            bootargs: null,
            stdout_path: null,
            aliases: [],
          },
          coverage: {
            status: "complete",
            examined_nodes: 2,
            examined_properties: 0,
          },
          limitations: [],
        },
      },
    );
    expect(cyclicDtb.ok).toBe(false);
    if (!cyclicDtb.ok) {
      expect(cyclicDtb.error._tag).toBe("AnalysisInputError");
    }

    const conflictResult = reconstructHardwareFromReferences(
      [{ target_address: "0x40034000", read: true }],
      "cortex-m",
      "uart_poll",
      "stm32f4",
      null,
      { uf2FamilyId: 0xe48bff56 },
    );
    expect(conflictResult.peripheralBlocks[0]?.socPeripheralName).toBeNull();
    expect(conflictResult.limitations[0]).toContain(
      "Container metadata selects rp2040, which disagrees with caller platform stm32f4",
    );
  });
});

describe("multi-board subjectSha256 gating and register aliases", () => {
  it("gates RT-Spark captured-image drivers and boot observations when subjectSha256 belongs to another image", () => {
    const foreignSha = "1".repeat(64);
    const report = reconstructHardwareFromReferences(
      [
        { target_address: "0x4000380c", write: true },
        { target_address: "0x10000020", read: true },
      ],
      "cortex-m",
      "spi_transfer",
      "stm32f4",
      "stm32f407-rt-spark",
      { subjectSha256: foreignSha },
    );

    // Board schematic facts (CCM memory window + SPI2 attachments) still apply
    expect(
      report.boardMemory.find((win) => win.id === "ccm")?.accessCount,
    ).toBe(1);
    expect(report.peripheralBlocks[0]?.socPeripheralName).toBe("SPI2");
    expect(report.peripheralBlocks[0]?.boardDevices.map((d) => d.id)).toEqual([
      "rw007",
      "spi-flash",
    ]);

    // Captured-image-only facts (drivers, driverRecoveries, and decoded boot immediates) are gated out
    expect(report.peripheralBlocks[0]?.boardDrivers).toEqual([]);
    expect(report.driverRecoveries).toBeUndefined();
    expect(
      report.hardwareClaims.some((claim) => claim.rule === "driver-linkage"),
    ).toBe(false);
    expect(
      report.limitations.some((note) =>
        note.includes(`apply only to image ${RT_SPARK_FLASH_IMAGE_SHA256}`),
      ),
    ).toBe(true);

    const noDigestReport = reconstructHardwareFromReferences(
      [{ target_address: "0x4000380c", write: true }],
      "cortex-m",
      "spi_transfer",
      "stm32f4",
      "stm32f407-rt-spark",
    );
    expect(noDigestReport.peripheralBlocks[0]?.boardDrivers).toEqual([]);
    expect(noDigestReport.driverRecoveries).toBeUndefined();
    expect(
      noDigestReport.limitations.some((note) =>
        note.includes("analyzed firmware image digest is unknown"),
      ),
    ).toBe(true);

    // Uppercase SHA-256 strings and positional string digest arguments are also accepted
    const upperDigestReport = reconstructHardwareFromReferences(
      [{ target_address: "0x40011000", write: true }],
      "cortex-m",
      "usart_tx",
      null,
      "stm32f407-rt-spark",
      RT_SPARK_FLASH_IMAGE_SHA256.toUpperCase(),
    );
    expect(
      upperDigestReport.peripheralBlocks[0]?.boardDrivers.map((d) => d.id),
    ).toEqual(["serial-usart1"]);
  });

  it("enriches multi-board profiles and unwraps bit-band and RP2040 atomic register aliases", () => {
    const picoReport = reconstructHardwareFromReferences(
      [
        { target_address: "0xd0000014", write: true },
        { target_address: "0x4000e000", write: true },
      ],
      "cortex-m",
      "pico_blink",
      null,
      "rp2040-pico",
    );
    const sioBlock = picoReport.peripheralBlocks.find(
      (b) => b.socPeripheralName === "SIO",
    );
    const resetsBlock = picoReport.peripheralBlocks.find(
      (b) => b.socPeripheralName === "RESETS",
    );
    expect(sioBlock?.knownRegisters).toEqual(["SIO_GPIO_OUT_SET"]);
    expect(sioBlock?.boardDevices.map((d) => d.id)).toContain("onboard-led");
    expect(resetsBlock?.knownRegisters).toEqual(["RESETS_RESET"]);
    expect(picoReport.attributions[1]?.registerAlias?.kind).toBe("atomic_set");
    expect(
      hardwarePeripheralReconstructionSchema.safeParse(picoReport).success,
    ).toBe(true);

    const bitbandReport = reconstructHardwareFromReferences(
      [{ target_address: "0x424002a4", write: true }],
      "cortex-m",
      "gpio_bitband_set",
      "stm32f4",
    );
    expect(bitbandReport.peripheralBlocks[0]).toMatchObject({
      blockBase: "0x40020000",
      socPeripheralName: "GPIOA",
      knownRegisters: ["GPIOA_ODR"],
    });
    expect(bitbandReport.attributions[0]?.registerAlias).toEqual({
      kind: "bitband",
      canonicalAddress: "0x40020014",
      registerOffset: "0x14",
      bit: 9,
    });
  });
});

describe("overlapping custom profile MMIO windows", () => {
  it("preserves MMIO blocks while leaving controller name unresolved when custom windows tie", async () => {
    const svdOverlap = `<?xml version="1.0" encoding="utf-8"?>
      <device><name>BCM_OVERLAP</name><peripherals>
        <peripheral>
          <name>PINMUX</name>
          <baseAddress>0xfe201000</baseAddress>
          <addressBlock><offset>0x0</offset><size>0x200</size><usage>registers</usage></addressBlock>
        </peripheral>
        <peripheral>
          <name>UART_ALT</name>
          <baseAddress>0xfe201000</baseAddress>
          <addressBlock><offset>0x0</offset><size>0x200</size><usage>registers</usage></addressBlock>
        </peripheral>
      </peripherals></device>`;

    const execution: AnalysisExecution = {
      result: {
        procedure: ghidraFunctionIdentity(),
        direction: "outgoing",
        reference_kinds_available: true,
        references: [
          { ...ghidraReferenceEdge(), target_address: "0xfe201010" },
        ],
        unresolved_calls: [],
      },
      rawResult: null,
      provider: { id: "ghidra", name: "Ghidra", version: "12.2" },
      locations: [],
      subject: {
        sha256: "d".repeat(64),
        path: "/tmp/bcm2711.bin",
        format: "raw-binary",
        architecture: "arm64",
      },
      limitations: [],
    };

    const res = await reconstructProcedureHardwareInteractions(
      { execute: () => Promise.resolve(ok(execution)) },
      {
        procedure: "uart_mux_init",
        architecture: "arm64",
        svd_xml: svdOverlap,
      },
    );
    if (!res.ok) throw res.error;

    expect(res.value.mmioAccessCount).toBe(1);
    expect(res.value.nonMmioAccessCount).toBe(0);
    expect(res.value.attributions[0]).toMatchObject({
      targetAddress: "0xfe201010",
      regionKind: "peripheral_mmio",
      isMmio: true,
      controllerName: null,
      controllerBasis: "observed_address",
    });
    expect(res.value.peripheralBlocks).toEqual([
      expect.objectContaining({
        blockBase: "0xfe201000",
        regionKind: "peripheral_mmio",
        socPeripheralName: null,
        socPeripheralNameBasis: "observed_address",
        uniqueAddresses: ["0xfe201010"],
      }),
    ]);
    expect(
      res.value.limitations.some((note) =>
        note.includes(
          "matches overlapping custom profile windows (PINMUX, UART_ALT)",
        ),
      ),
    ).toBe(true);
  });
});
