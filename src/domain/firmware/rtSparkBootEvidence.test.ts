import { describe, expect, it } from "vitest";
import { RT_SPARK_FLASH_IMAGE_SHA256 } from "./boardDriverLayer.js";
import {
  rtSparkBoardPack,
  rtSparkBootEvidence,
} from "./rtSparkBootEvidence.js";

describe("RT-Spark boot evidence", () => {
  it("follows reset into startup and keeps manual names on register bases", () => {
    expect(rtSparkBootEvidence.imageSha256).toBe(RT_SPARK_FLASH_IMAGE_SHA256);
    expect(rtSparkBootEvidence.architecture).toBe("cortex-m");
    expect(rtSparkBootEvidence.loadAddress).toBe("0x08000000");
    expect(rtSparkBootEvidence.steps[0]).toMatchObject({
      name: "reset_handler",
      calls: ["0x0800c704", "0x080013c4"],
    });
    const rcc = rtSparkBootEvidence.registerWrites.find(
      (write) => write.register === "RCC_PLLCFGR",
    );
    expect(rcc).toMatchObject({
      base: "0x40023800",
      baseName: "RCC",
      baseBasis: "chip_manual",
      operation: "write 0x24003010",
    });
    const vtor = rtSparkBootEvidence.registerWrites.find(
      (write) => write.register === "VTOR",
    );
    expect(vtor?.baseBasis).toBe("architecture_manual");
  });

  it("records the console path and leaves the flash part and pin number open", () => {
    expect(rtSparkBootEvidence.console.deviceName).toBe("uart1");
    expect(rtSparkBootEvidence.console.greeting).toBe("Hello RT-Thread!");
    expect(rtSparkBootEvidence.usartSetup.configDecimal).toBe(115200);
    expect(rtSparkBootEvidence.boardInitTable.targets).toEqual([
      "0x08001334",
      "0x0800c954",
      "0x0800d8c4",
    ]);
    expect(rtSparkBootEvidence.usartClock).toMatchObject({
      instanceName: "USART1",
      instanceBasis: "chip_manual",
      clockRegister: "RCC_APB2ENR",
      clockOperation: "orr 0x10",
    });
    expect(rtSparkBootEvidence.gpioClocks.ports).toContain("GPIOF");
    expect(
      rtSparkBootEvidence.spiControllers.controllers.map((item) => item.name),
    ).toEqual(["SPI1", "SPI2", "SPI3"]);
    expect(rtSparkBootEvidence.spiFlashInit.attach).toMatchObject({
      busName: "spi2",
      deviceName: "spi20",
      gpioName: "GPIOB",
      pinMask: "0x1000",
      pinBit: 12,
    });
    expect(
      rtSparkBootEvidence.spiFlashInit.probe.table.map((row) => row.name),
    ).toEqual([
      "W25Q16BV",
      "W25Q32BV",
      "W25Q64CV",
      "W25Q64DW",
      "W25Q128BV",
      "W25Q256FV",
    ]);
    expect(rtSparkBootEvidence.pinCalls.map((call) => call.pin)).toEqual([
      "0x5c",
      "0x5b",
      "0x10",
      "0x11",
      "0x53",
      "0x20",
      "0x24",
      "0x25",
      "0x21",
      "0x5c",
      "0x5b",
      "0x5c",
      "0x5b",
      "0x5c",
      "0x5b",
    ]);
    expect(rtSparkBootEvidence.delayCalls).toEqual([
      { site: "0x08054fc2", immediate: "0x1f4", target: "0x0806752c" },
      { site: "0x08054fda", immediate: "0x1f4", target: "0x0806752c" },
      { site: "0x08054ff2", immediate: "0x1f4", target: "0x0806752c" },
    ]);
    expect(
      rtSparkBoardPack.drivers.find((driver) => driver.id === "spi-flash")
        ?.linkage,
    ).toBe("linked_in_image");
    expect(rtSparkBootEvidence.spiFlashInit.registerWrites[0]).toMatchObject({
      register: "RCC_AHB1ENR",
      operation: "orr 0x2",
      bitName: "GPIOBEN",
      basis: "chip_manual",
    });
    expect(rtSparkBootEvidence.pinCalls[0]).toEqual({
      site: "0x08054f6a",
      pin: "0x5c",
      argument: "0x0",
      target: "0x08063d68",
    });
    expect(rtSparkBootEvidence.pinDecode).toMatchObject({
      implementation: "0x08073c94",
      gpioBase: "0x40020000",
      stride: "0x400",
      basis: "instruction",
    });
    expect(rtSparkBootEvidence.unresolved.map((fact) => fact.subject)).toEqual([
      "spi-flash-part",
      "gpio-role",
    ]);
    expect(rtSparkBootEvidence.sysclk).toMatchObject({
      plln: { site: "0x0800c77c", value: "0xa8" },
      pllm: { site: "0x0800c8e6", value: "0x8" },
      pllpDivider: { site: "0x0800c8ee", value: "0x2" },
      pllSource: { site: "0x0800c8e2", value: "0x0" },
      pllRegisterWrite: "0x0800aa18",
      clockSwitch: {
        site: "0x0800ab7e",
        sourceSite: "0x0800c912",
        source: "0x2",
      },
      hsiLiteral: { site: "0x0800adf8", value: "0xf42400" },
      hseLiteral: { site: "0x0800adfc", value: "0x7a1200" },
    });
  });

  it("keeps the observed exception handlers and the missing controller bases", () => {
    expect(
      rtSparkBootEvidence.exceptionVectors.find(
        (entry) => entry.name === "HardFault",
      ),
    ).toEqual({ index: 3, name: "HardFault", word: "0x080002d1" });
    expect(
      rtSparkBootEvidence.exceptionVectors.find(
        (entry) => entry.name === "SysTick",
      )?.word,
    ).toBe("0x0800ca31");
    expect(
      rtSparkBootEvidence.controllerLoads.find(
        (load) => load.site === "0x0800c5c8",
      ),
    ).toEqual({ site: "0x0800c5c8", address: "0x40011400" });
    expect(
      rtSparkBootEvidence.controllerLoads.some((load) =>
        ["0x40004400", "0x40005400", "0x40006400", "0xa0000000"].includes(
          load.address,
        ),
      ),
    ).toBe(false);
  });
});
