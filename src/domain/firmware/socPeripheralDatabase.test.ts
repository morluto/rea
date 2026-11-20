import { describe, expect, it } from "vitest";
import {
  detectSocPlatform,
  lookupSocPeripheral,
  resolveSocRegisterAlias,
  socPeripheralDefinitionSchema,
  socPlatformForEspChipId,
  socPlatformForUf2FamilyId,
} from "./socPeripheralDatabase.js";

describe("STM32 and GD32 peripheral lookup", () => {
  it("resolves STM32F1 APB and AHB peripherals", () => {
    // USART1 in STM32F1 (APB2)
    const usart1 = lookupSocPeripheral("0x40013804", "stm32f1");
    expect(usart1).not.toBeNull();
    if (usart1 === null) return;
    expect(usart1.name).toBe("USART1");
    expect(usart1.bus).toBe("APB2");
    expect(usart1.baseAddress).toBe("0x40013800");
    expect(socPeripheralDefinitionSchema.safeParse(usart1).success).toBe(true);

    // GPIOA in STM32F1
    const gpioa = lookupSocPeripheral("0x40010800", "stm32f1");
    expect(gpioa?.name).toBe("GPIOA");

    // RCC in STM32F1 (AHB)
    const rcc = lookupSocPeripheral("0x40021000", "stm32f1");
    expect(rcc?.name).toBe("RCC");
    expect(rcc?.bus).toBe("AHB");
  });

  it("resolves GD32F1 naming differences while preserving matching base addresses", () => {
    // GD32F1 names USART1 as USART0
    const usart0 = lookupSocPeripheral("0x40013800", "gd32f1");
    expect(usart0?.name).toBe("USART0");
    expect(usart0?.bus).toBe("APB2");

    // GD32F1 names RCC as RCU
    const rcu = lookupSocPeripheral("0x40021000", "gd32f1");
    expect(rcu?.name).toBe("RCU");
  });

  it("resolves STM32F4 AHB1 GPIO mapping (0x40020000)", () => {
    // In STM32F4, GPIOA moved from APB2 to AHB1 at 0x40020000
    const gpioa = lookupSocPeripheral("0x40020014", "stm32f4");
    expect(gpioa?.name).toBe("GPIOA");
    expect(gpioa?.bus).toBe("AHB1");

    // In STM32F4, USART1 is at 0x40011000
    const usart1 = lookupSocPeripheral("0x40011000", "stm32f4");
    expect(usart1?.name).toBe("USART1");
  });

  it("resolves STM32F407 controllers used by RT-Spark firmware", () => {
    expect(lookupSocPeripheral("0x4000380c", "stm32f4")?.name).toBe("SPI2");
    expect(lookupSocPeripheral("0x40012c00", "stm32f4")?.name).toBe("SDIO");
    expect(lookupSocPeripheral("0x40021414", "stm32f4")).toMatchObject({
      name: "GPIOF",
      bus: "AHB1",
    });
    expect(lookupSocPeripheral("0x40002000", "stm32f4")?.name).toBe("TIM14");
    expect(lookupSocPeripheral("0x50000000", "stm32f4")).toMatchObject({
      name: "USB_OTG_FS",
      bus: "AHB2",
    });
    expect(lookupSocPeripheral("0x40040004", "stm32f4")?.name).toBe(
      "USB_OTG_HS",
    );
    expect(lookupSocPeripheral("0xa0000000", "stm32f4")).toMatchObject({
      name: "FSMC",
      bus: "AHB3",
    });
    expect(lookupSocPeripheral("0x40028010", "stm32f4")?.name).toBe("ETH");

    const candidates = detectSocPlatform([
      "0x40023800",
      "0x40021400",
      "0x50000000",
    ]);
    const leaders = candidates.filter(
      (candidate) => candidate.matchedCount === candidates[0]?.matchedCount,
    );
    expect(leaders.map((candidate) => candidate.platform)).toEqual([
      "stm32f4",
      "gd32f4",
    ]);
    expect(leaders.every((candidate) => candidate.confidence === 1)).toBe(true);
  });

  it("names the shared F4 windows with the GD32 manual's controller names", () => {
    expect(lookupSocPeripheral("0x40020014", "gd32f4")).toMatchObject({
      name: "GPIOA",
      bus: "AHB1",
    });
    expect(lookupSocPeripheral("0x40023800", "gd32f4")?.name).toBe("RCU");
    expect(lookupSocPeripheral("0x40026000", "gd32f4")?.name).toBe("DMA0");
    expect(lookupSocPeripheral("0x40011000", "gd32f4")?.name).toBe("USART0");
    expect(lookupSocPeripheral("0x4000380c", "gd32f4")?.name).toBe("SPI1");
    expect(lookupSocPeripheral("0x50000000", "gd32f4")?.name).toBe("USBFS");
    expect(lookupSocPeripheral("0xa0000000", "gd32f4")?.name).toBe("EXMC");
    expect(lookupSocPeripheral("0x40006c00", "gd32f4")?.name).toBe("CTC");
    expect(lookupSocPeripheral("0x40006c00", "stm32f4")).toBeNull();
  });

  it("lets the GD32F4 clock-trim window combined with AHB1 RCU select only that family", () => {
    expect(detectSocPlatform(["0x40023800", "0x40006c00"], "arm")[0]).toEqual({
      platform: "gd32f4",
      matchedCount: 2,
      totalAddresses: 2,
      confidence: 1,
      matchedPeripherals: ["CTC", "RCU"],
    });
    expect(
      detectSocPlatform(["0x40006c00"], "arm").map((item) => item.platform),
    ).toEqual(["stm32h7", "gd32f4"]);
  });
});

describe("ESP32 peripheral lookup and automated platform detection", () => {
  it("resolves ESP32 Xtensa DPort and RTC peripheral blocks separately from RISC-V ESP32-C", () => {
    const uart0 = lookupSocPeripheral("0x3ff40004", "esp32");
    expect(uart0?.name).toBe("UART0");
    expect(uart0?.bus).toBe("DPort");

    const gpio = lookupSocPeripheral("0x3ff44000", "esp32");
    expect(gpio?.name).toBe("GPIO");

    const dport = lookupSocPeripheral("0x3ff00000", "esp32");
    expect(dport?.name).toBe("DPORT");
    expect(lookupSocPeripheral("0x3ff4c000", "esp32")?.name).toBe("UHCI0");
    expect(lookupSocPeripheral("0x3ff50000", "esp32")?.name).toBe("UART1");
    expect(lookupSocPeripheral("0x3ff6e000", "esp32")?.name).toBe("UART2");

    const timg0 = lookupSocPeripheral("0x3ff5f000", "esp32");
    expect(timg0?.name).toBe("TIMG0");

    // Classic Xtensa ESP32 does not map RISC-V 0x60000000 blocks
    expect(lookupSocPeripheral("0x60000000", "esp32")).toBeNull();
    expect(lookupSocPeripheral("0x60000000", "esp32c3")).toMatchObject({
      name: "UART0",
      bus: "System",
    });
    expect(lookupSocPeripheral("0x60004004", "esp32c3")?.name).toBe("GPIO");
  });

  it("detects candidate SoC platform from observed MMIO address set", () => {
    // Typical STM32F1 firmware accesses: USART1, GPIOA, RCC
    const stm32Addresses = ["0x40013800", "0x40010800", "0x40021000"];
    const stm32Candidates = detectSocPlatform(stm32Addresses);
    expect(stm32Candidates.length).toBeGreaterThanOrEqual(1);
    expect(stm32Candidates[0]?.platform).toBe("stm32f1");
    expect(stm32Candidates[0]?.confidence).toBe(1.0);
    expect(stm32Candidates[0]?.matchedPeripherals).toEqual([
      "GPIOA",
      "RCC",
      "USART1",
    ]);

    const esp32Addresses = ["0x3ff40000", "0x3ff44000", "0x3ff00000"];
    const esp32Candidates = detectSocPlatform(esp32Addresses);
    expect(esp32Candidates).toHaveLength(1);
    expect(esp32Candidates[0]?.platform).toBe("esp32");
    expect(esp32Candidates[0]?.confidence).toBe(1.0);
  });

  it("returns null or empty candidate list for unrecognized addresses", () => {
    expect(lookupSocPeripheral("0x12345678", "stm32f1")).toBeNull();
    expect(lookupSocPeripheral("invalid", "esp32")).toBeNull();
    expect(detectSocPlatform(["0x12345678", "0x87654321"])).toEqual([]);
  });

  it("does not let a shared STM32F4 window select only one family", () => {
    const tied = detectSocPlatform(
      ["0x40020000", "0x40023800", "0x40026000"],
      "cortex-m",
    );
    const leaders = tied.filter(
      (candidate) => candidate.matchedCount === tied[0]?.matchedCount,
    );
    expect(leaders.map((candidate) => candidate.platform)).toEqual([
      "stm32f4",
      "gd32f4",
    ]);
    expect(leaders.every((candidate) => candidate.matchedCount === 3)).toBe(
      true,
    );
  });

  it("keeps overlapping STM32 and GD32 catalogs tied", () => {
    const tied = detectSocPlatform(
      ["0x40013800", "0x40010800", "0x40021000"],
      "arm",
    );
    const leaders = tied.filter(
      (candidate) => candidate.matchedCount === tied[0]?.matchedCount,
    );
    expect(leaders.map((candidate) => candidate.platform)).toEqual([
      "stm32f1",
      "gd32f1",
    ]);
    expect(leaders.every((candidate) => candidate.confidence === 1)).toBe(true);
  });

  it("does not treat a shared GD32 window as STM32-only", () => {
    expect(lookupSocPeripheral("0x40012800", "gd32f1")?.name).toBe("ADC1");
    expect(lookupSocPeripheral("0x40020400", "gd32f1")?.name).toBe("DMA1");
    expect(lookupSocPeripheral("0x40000800", "gd32f1")?.name).toBe("TIMER3");
    expect(lookupSocPeripheral("0x40004800", "gd32f1")?.name).toBe("USART2");
    expect(lookupSocPeripheral("0x40005800", "gd32f1")?.name).toBe("I2C1");
    expect(lookupSocPeripheral("0x40006400", "gd32f1")?.name).toBe("CAN0");
    expect(lookupSocPeripheral("0x40007000", "gd32f1")?.name).toBe("PMU");
    expect(lookupSocPeripheral("0x40011400", "gd32f1")?.name).toBe("GPIOD");
    expect(lookupSocPeripheral("0x40023000", "gd32f1")?.name).toBe("CRC");
    const tied = detectSocPlatform(
      ["0x40020000", "0x40012800", "0x40010800"],
      "arm",
    );
    const leaders = tied.filter(
      (candidate) => candidate.matchedCount === tied[0]?.matchedCount,
    );
    expect(leaders.map((candidate) => candidate.platform)).toEqual([
      "stm32f1",
      "gd32f1",
    ]);
    expect(leaders.every((candidate) => candidate.matchedCount === 3)).toBe(
      true,
    );
  });

  it("names the separate controllers inside the ESP32 RTC page", () => {
    expect(lookupSocPeripheral("0x3ff48000", "esp32")?.name).toBe("RTC_CNTL");
    expect(lookupSocPeripheral("0x3ff48400", "esp32")?.name).toBe("RTCIO");
    expect(lookupSocPeripheral("0x3ff48800", "esp32")?.name).toBe("SENS");
    expect(lookupSocPeripheral("0x3ff48c00", "esp32")?.name).toBe("RTC_I2C");
  });
});

describe("CPU-compatible catalog scoring", () => {
  it("scores only addresses that hit a CPU-compatible catalog", () => {
    const diluted = detectSocPlatform(
      ["0x60000000", "0x20000040", "0x80001000"],
      "riscv",
    );
    expect(diluted).toEqual([
      {
        platform: "esp32c2",
        matchedCount: 1,
        totalAddresses: 1,
        confidence: 1,
        matchedPeripherals: ["UART0"],
      },
      {
        platform: "esp32c3",
        matchedCount: 1,
        totalAddresses: 1,
        confidence: 1,
        matchedPeripherals: ["UART0"],
      },
      {
        platform: "esp32c6",
        matchedCount: 1,
        totalAddresses: 1,
        confidence: 1,
        matchedPeripherals: ["UART0"],
      },
      {
        platform: "esp32h2",
        matchedCount: 1,
        totalAddresses: 1,
        confidence: 1,
        matchedPeripherals: ["UART0"],
      },
    ]);

    expect(detectSocPlatform(["0x3ff40000"], "xtensa")).toEqual([
      {
        platform: "esp32",
        matchedCount: 1,
        totalAddresses: 1,
        confidence: 1,
        matchedPeripherals: ["UART0"],
      },
    ]);
    expect(detectSocPlatform(["0x3ff40000"], "riscv")).toEqual([]);
    expect(detectSocPlatform(["0x3ff40000"], "x86")).toEqual([]);
    expect(detectSocPlatform(["0x40011000"], "arm64")).toEqual([]);
    const sharedClock = detectSocPlatform(["0x40023800"], "arm");
    const clockLeaders = sharedClock.filter(
      (candidate) => candidate.matchedCount === sharedClock[0]?.matchedCount,
    );
    expect(clockLeaders).toEqual([
      {
        platform: "stm32f4",
        matchedCount: 1,
        totalAddresses: 1,
        confidence: 1,
        matchedPeripherals: ["RCC"],
      },
      {
        platform: "gd32f4",
        matchedCount: 1,
        totalAddresses: 1,
        confidence: 1,
        matchedPeripherals: ["RCU"],
      },
    ]);
  });
});

describe("RP2040 peripheral windows", () => {
  it("names blocks that sit outside the STM32 and GD32 windows", () => {
    expect(lookupSocPeripheral("0x40034000", "rp2040")).toMatchObject({
      name: "UART0",
      bus: "APB",
    });
    expect(lookupSocPeripheral("0x40035000", "rp2040")?.name).toBe("UART0");
    expect(lookupSocPeripheral("0x40040000", "rp2040")?.name).toBe("SPI1");
    expect(lookupSocPeripheral("0x50200010", "rp2040")).toMatchObject({
      name: "PIO0",
      bus: "AHBL",
    });
    expect(lookupSocPeripheral("0xd0000004", "rp2040")?.name).toBe("SIO");
    expect(lookupSocPeripheral("0x50110000", "rp2040")?.name).toBe(
      "USBCTRL_REGS",
    );
    expect(lookupSocPeripheral("0x40020400", "rp2040")).toBeNull();
    expect(lookupSocPeripheral("0x40070000", "rp2040")).toBeNull();
    expect(detectSocPlatform(["0x40034000"], "arm")).toEqual([
      {
        platform: "rp2040",
        matchedCount: 1,
        totalAddresses: 1,
        confidence: 1,
        matchedPeripherals: ["UART0"],
      },
    ]);
    expect(detectSocPlatform(["0x40034000"], "riscv")).toEqual([]);
  });
});

describe("ESP32-C3 peripheral windows", () => {
  it("keeps a shared UART from selecting only one family", () => {
    expect(lookupSocPeripheral("0x60000000", "esp32c3")?.name).toBe("UART0");
    expect(lookupSocPeripheral("0x60010000", "esp32c3")?.name).toBe("UART1");
    expect(lookupSocPeripheral("0x60010000", "esp32")).toBeNull();
    expect(lookupSocPeripheral("0x60043000", "esp32c3")?.name).toBe(
      "USB_SERIAL_JTAG",
    );
    expect(lookupSocPeripheral("0x6002e000", "esp32c3")).toBeNull();
    expect(lookupSocPeripheral("0x6002e000", "esp32")).toBeNull();
    const leaders = detectSocPlatform(["0x60000000"], "riscv");
    expect(leaders.map((candidate) => candidate.platform)).toEqual([
      "esp32c2",
      "esp32c3",
      "esp32c6",
      "esp32h2",
    ]);
    expect(detectSocPlatform(["0x60043000"], "riscv")).toEqual([
      {
        platform: "esp32c3",
        matchedCount: 1,
        totalAddresses: 1,
        confidence: 1,
        matchedPeripherals: ["USB_SERIAL_JTAG"],
      },
    ]);
    expect(detectSocPlatform(["0x60043000"], "arm")).toEqual([]);
  });
});

describe("ESP32-C6 peripheral windows", () => {
  it("keeps a shared page from selecting only one family", () => {
    expect(lookupSocPeripheral("0x60002000", "esp32")).toBeNull();
    expect(lookupSocPeripheral("0x60002000", "esp32s3")?.name).toBe("SPI1");
    expect(lookupSocPeripheral("0x60002000", "esp32c2")?.name).toBe("SPI1");
    expect(lookupSocPeripheral("0x60002000", "esp32c3")?.name).toBe("SPI1");
    expect(lookupSocPeripheral("0x60002000", "esp32c6")?.name).toBe("SPI0");
    expect(lookupSocPeripheral("0x60002000", "esp32h2")?.name).toBe("SPI0");
    expect(lookupSocPeripheral("0x60010000", "esp32c2")?.name).toBe("UART1");
    expect(lookupSocPeripheral("0x60010000", "esp32c3")?.name).toBe("UART1");
    expect(lookupSocPeripheral("0x60010000", "esp32c6")?.name).toBe("INTMTX");
    expect(lookupSocPeripheral("0x60010000", "esp32h2")?.name).toBe("INTMTX");
    expect(lookupSocPeripheral("0x600c0000", "esp32c2")?.name).toBe("SYSTEM");
    expect(lookupSocPeripheral("0x600c0000", "esp32c3")?.name).toBe("SYSTEM");
    expect(lookupSocPeripheral("0x600c0000", "esp32c6")?.name).toBe("TRACE");
    expect(lookupSocPeripheral("0x600c0000", "esp32h2")?.name).toBe("TRACE");
    expect(
      detectSocPlatform(["0x60002000"], "riscv").map(
        (candidate) => candidate.platform,
      ),
    ).toEqual(["esp32c2", "esp32c3", "esp32c6", "esp32h2"]);
    expect(
      detectSocPlatform(["0x60010000"], "riscv").map(
        (candidate) => candidate.platform,
      ),
    ).toEqual(["esp32c2", "esp32c3", "esp32c6", "esp32h2"]);
  });

  it("lets a C6-only window select that family", () => {
    expect(lookupSocPeripheral("0x60001000", "esp32")).toBeNull();
    expect(lookupSocPeripheral("0x60001000", "esp32c2")).toBeNull();
    expect(lookupSocPeripheral("0x60001000", "esp32c3")).toBeNull();
    expect(lookupSocPeripheral("0x60001000", "esp32c6")?.name).toBe("UART1");
    expect(lookupSocPeripheral("0x60001000", "esp32h2")?.name).toBe("UART1");
    expect(lookupSocPeripheral("0x6000f000", "esp32c3")).toBeNull();
    expect(lookupSocPeripheral("0x6000f000", "esp32c6")?.name).toBe(
      "USB_SERIAL_JTAG",
    );
    expect(lookupSocPeripheral("0x6000f000", "esp32h2")?.name).toBe(
      "USB_SERIAL_JTAG",
    );
    expect(lookupSocPeripheral("0x600b1400", "esp32h2")).toBeNull();
    expect(lookupSocPeripheral("0x600b1400", "esp32c6")?.name).toBe("LP_UART");
    expect(lookupSocPeripheral("0x600b1400", "esp32c6")?.sizeBytes).toBe(0x400);
    expect(
      detectSocPlatform(["0x60001000"], "riscv").map(
        (candidate) => candidate.platform,
      ),
    ).toEqual(["esp32c6", "esp32h2"]);
    expect(detectSocPlatform(["0x600b1400"], "riscv")).toEqual([
      {
        platform: "esp32c6",
        matchedCount: 1,
        totalAddresses: 1,
        confidence: 1,
        matchedPeripherals: ["LP_UART"],
      },
    ]);
    expect(detectSocPlatform(["0x6000f000"], "arm")).toEqual([]);
  });
});

describe("ESP32-C2 peripheral windows", () => {
  it("keeps a shared page from selecting only one family", () => {
    expect(lookupSocPeripheral("0x60008000", "esp32c2")?.name).toBe("RTCCNTL");
    expect(lookupSocPeripheral("0x60008000", "esp32c2")?.sizeBytes).toBe(0x800);
    expect(lookupSocPeripheral("0x60008800", "esp32c3")?.name).toBe("EFUSE");
    expect(lookupSocPeripheral("0x60008800", "esp32c2")?.name).toBe("EFUSE");
    expect(lookupSocPeripheral("0x60024000", "esp32c2")?.name).toBe("SPI2");
    expect(lookupSocPeripheral("0x60024000", "esp32c3")?.name).toBe("SPI2");
    expect(lookupSocPeripheral("0x600c1000", "esp32c2")?.name).toBe(
      "SENSITIVE",
    );
    expect(lookupSocPeripheral("0x600c1000", "esp32c3")?.name).toBe(
      "SENSITIVE",
    );
    expect(lookupSocPeripheral("0x600c1000", "esp32c6")).toBeNull();
    expect(lookupSocPeripheral("0x600c1000", "esp32h2")).toBeNull();
    expect(lookupSocPeripheral("0x60008800", "esp32h2")?.name).toBe("LEDC");
    expect(lookupSocPeripheral("0x60020000", "esp32c2")).toBeNull();
    expect(
      detectSocPlatform(["0x60008800"], "riscv").map(
        (candidate) => candidate.platform,
      ),
    ).toEqual(["esp32c2", "esp32c3", "esp32c6", "esp32h2"]);
    expect(
      detectSocPlatform(["0x600c1000"], "riscv").map(
        (candidate) => candidate.platform,
      ),
    ).toEqual(["esp32c2", "esp32c3"]);
  });

  it("lets a C2-only window select that family", () => {
    expect(lookupSocPeripheral("0x6004e800", "esp32")).toBeNull();
    expect(lookupSocPeripheral("0x6004e800", "esp32c3")).toBeNull();
    expect(lookupSocPeripheral("0x6004e800", "esp32c6")).toBeNull();
    expect(lookupSocPeripheral("0x6004e800", "esp32h2")).toBeNull();
    expect(lookupSocPeripheral("0x6004e800", "esp32c2")?.name).toBe("I2C_MST");
    expect(detectSocPlatform(["0x6004e800"], "riscv")).toEqual([
      {
        platform: "esp32c2",
        matchedCount: 1,
        totalAddresses: 1,
        confidence: 1,
        matchedPeripherals: ["I2C_MST"],
      },
    ]);
    expect(detectSocPlatform(["0x6004e800"], "arm")).toEqual([]);
  });
});

describe("ESP32-H2 peripheral windows", () => {
  it("lets an H2-only window select that family", () => {
    expect(lookupSocPeripheral("0x6008e000", "esp32")).toBeNull();
    expect(lookupSocPeripheral("0x6008e000", "esp32c2")).toBeNull();
    expect(lookupSocPeripheral("0x6008e000", "esp32c3")).toBeNull();
    expect(lookupSocPeripheral("0x6008e000", "esp32c6")).toBeNull();
    expect(lookupSocPeripheral("0x6008e000", "esp32h2")?.name).toBe("ECDSA");
    expect(detectSocPlatform(["0x6008e000"], "riscv")).toEqual([
      {
        platform: "esp32h2",
        matchedCount: 1,
        totalAddresses: 1,
        confidence: 1,
        matchedPeripherals: ["ECDSA"],
      },
    ]);
    expect(detectSocPlatform(["0x6008e000"], "arm")).toEqual([]);
  });
});

describe("STM32L4, STM32H7, nRF52, SAMD21, ESP32-S2/S3, and RISC-V MCU catalogs", () => {
  it("resolves STM32L4 AHB2 GPIO and STM32H7 multi-domain peripherals", () => {
    expect(lookupSocPeripheral("0x48000014", "stm32l4")).toMatchObject({
      name: "GPIOA",
      bus: "AHB2",
    });
    expect(lookupSocPeripheral("0x40021000", "stm32l4")?.name).toBe("RCC");
    expect(lookupSocPeripheral("0x58024400", "stm32h7")).toMatchObject({
      name: "RCC",
      bus: "AHB4",
    });
    expect(lookupSocPeripheral("0x58020014", "stm32h7")?.name).toBe("GPIOA");
    expect(lookupSocPeripheral("0x52002000", "stm32h7")?.name).toBe("Flash_IF");
  });

  it("resolves nRF52840 non-overlapping P0/P1 GPIO ports and SAMD21 APB peripherals", () => {
    expect(lookupSocPeripheral("0x50000504", "nrf52")?.name).toBe("P0");
    expect(lookupSocPeripheral("0x50000804", "nrf52")?.name).toBe("P1");
    expect(lookupSocPeripheral("0x40002000", "nrf52")?.name).toBe("UARTE0");
    expect(lookupSocPeripheral("0x40027000", "nrf52")?.name).toBe("USBD");
    expect(lookupSocPeripheral("0x4002d000", "nrf52")?.name).toBe("PWM3");

    expect(lookupSocPeripheral("0x41004400", "samd21")).toMatchObject({
      name: "PORT",
      bus: "APB",
    });
    expect(lookupSocPeripheral("0x60000000", "samd21")).toMatchObject({
      name: "PORT_IOBUS",
      bus: "System",
    });
    expect(lookupSocPeripheral("0x42000800", "samd21")?.name).toBe("SERCOM0");
    expect(detectSocPlatform(["0x42000800"], "cortex-m")).toEqual([
      {
        platform: "samd21",
        matchedCount: 1,
        totalAddresses: 1,
        confidence: 1,
        matchedPeripherals: ["SERCOM0"],
      },
    ]);
  });

  it("resolves Xtensa ESP32-S2/S3 and RISC-V GD32VF103/CH32V30x families", () => {
    expect(lookupSocPeripheral("0x3f400000", "esp32s2")?.name).toBe("UART0");
    expect(lookupSocPeripheral("0x60038000", "esp32s3")?.name).toBe(
      "USB_SERIAL_JTAG",
    );
    expect(lookupSocPeripheral("0x6002e000", "esp32s3")?.name).toBe("UART2");
    expect(detectSocPlatform(["0x6002e000"], "xtensa")).toEqual([
      {
        platform: "esp32s3",
        matchedCount: 1,
        totalAddresses: 1,
        confidence: 1,
        matchedPeripherals: ["UART2"],
      },
    ]);

    expect(lookupSocPeripheral("0xd1000000", "gd32vf103")?.name).toBe("MTIMER");
    expect(lookupSocPeripheral("0xd2000000", "gd32vf103")?.name).toBe("ECLIC");
    expect(lookupSocPeripheral("0xe000e000", "ch32v30x")?.name).toBe("PFIC");
    expect(lookupSocPeripheral("0x40023400", "ch32v30x")?.name).toBe("USBHS");
    expect(detectSocPlatform(["0xd2000000"], "riscv")[0]?.platform).toBe(
      "gd32vf103",
    );
  });
});

describe("hardware register aliases and firmware container bridges", () => {
  it("unwraps Cortex-M3/M4 peripheral bit-band aliases and RP2040 atomic alias pages", () => {
    // STM32F4 GPIOA (0x40020000) + ODR (0x14), bit 9 => 0x42000000 + 0x20015*32 + 1*4 = 0x424002a4
    const bitband = resolveSocRegisterAlias("0x424002a4", "stm32f4");
    expect(bitband).toMatchObject({
      kind: "bitband",
      canonicalAddress: "0x40020014",
      registerOffset: "0x14",
      bit: 9,
    });
    expect(bitband?.peripheral.name).toBe("GPIOA");
    // Unaligned bit-band address and Cortex-M7 STM32H7 (no peripheral bit-banding) must return null
    expect(resolveSocRegisterAlias("0x424002a6", "stm32f4")).toBeNull();
    expect(resolveSocRegisterAlias("0x424002a4", "stm32h7")).toBeNull();

    // RP2040 RESETS (0x4000c000): XOR=0x4000d000, SET=0x4000e000, CLR=0x4000f000
    expect(resolveSocRegisterAlias("0x4000d000", "rp2040")?.kind).toBe(
      "atomic_xor",
    );
    expect(resolveSocRegisterAlias("0x4000e000", "rp2040")).toMatchObject({
      kind: "atomic_set",
      canonicalAddress: "0x4000c000",
      registerOffset: "0x0",
      bit: null,
    });
    expect(resolveSocRegisterAlias("0x4000f008", "rp2040")).toMatchObject({
      kind: "atomic_clr",
      canonicalAddress: "0x4000c008",
      registerOffset: "0x8",
    });
    // Direct page and offsets past PADS_QSPI's 0x18 aliasPageRegisterBytes return null
    expect(resolveSocRegisterAlias("0x4000c000", "rp2040")).toBeNull();
    expect(resolveSocRegisterAlias("0x40022400", "rp2040")).toBeNull();
  });

  it("maps ESP chip IDs and UF2 family IDs to built-in SoC catalogs", () => {
    expect(socPlatformForEspChipId(0x0000)).toBe("esp32");
    expect(socPlatformForEspChipId(0x0002)).toBe("esp32s2");
    expect(socPlatformForEspChipId(0x0005)).toBe("esp32c3");
    expect(socPlatformForEspChipId(0x0009)).toBe("esp32s3");
    expect(socPlatformForEspChipId(0x000c)).toBe("esp32c2");
    expect(socPlatformForEspChipId(0x000d)).toBe("esp32c6");
    expect(socPlatformForEspChipId(0x0010)).toBe("esp32h2");
    expect(socPlatformForEspChipId(0x0012)).toBeNull();

    expect(socPlatformForUf2FamilyId(0xe48bff56)).toBe("rp2040");
    expect(socPlatformForUf2FamilyId(0xada52840)).toBe("nrf52");
    expect(socPlatformForUf2FamilyId(0x68ed2b88)).toBe("samd21");
    expect(socPlatformForUf2FamilyId(0x57755a57)).toBe("stm32f4");
    expect(socPlatformForUf2FamilyId(0x00ff6919)).toBe("stm32l4");
    expect(socPlatformForUf2FamilyId(0x6db66082)).toBe("stm32h7");
    expect(socPlatformForUf2FamilyId(0x699b62ec)).toBe("ch32v30x");
    expect(socPlatformForUf2FamilyId(0xdeadbeef)).toBeNull();
  });
});
