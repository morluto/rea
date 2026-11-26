import { peripheralEntry as p, type InternalPeripheralEntry } from "./types.js";

// Classic ESP32 (Xtensa LX6) peripheral memory map (ESP32 TRM / soc/reg_base.h).
export const ESP32_PERIPHERALS: readonly InternalPeripheralEntry[] = [
  p("DPORT", 0x3ff00000n, 0x1000, "DPort", "System control and clock gating"),
  p("AES", 0x3ff01000n, 0x1000, "DPort", "AES hardware accelerator"),
  p("RSA", 0x3ff02000n, 0x1000, "DPort", "RSA hardware accelerator"),
  p("SHA", 0x3ff03000n, 0x1000, "DPort", "SHA hardware accelerator"),
  p("UART0", 0x3ff40000n, 0x1000, "DPort", "UART 0"),
  p("SPI1", 0x3ff42000n, 0x1000, "DPort", "SPI flash interface 1"),
  p("SPI0", 0x3ff43000n, 0x1000, "DPort", "SPI cache interface 0"),
  p("GPIO", 0x3ff44000n, 0x1000, "DPort", "General purpose I/O controller"),
  p("RTC_CNTL", 0x3ff48000n, 0x400, "RTC", "RTC and power control"),
  p("RTCIO", 0x3ff48400n, 0x400, "RTC", "Low-power I/O controller"),
  p("SENS", 0x3ff48800n, 0x400, "RTC", "SAR ADC and touch sensor control"),
  p("RTC_I2C", 0x3ff48c00n, 0x400, "RTC", "Low-power I2C controller"),
  p("IO_MUX", 0x3ff49000n, 0x1000, "DPort", "Pin multiplexer control"),
  p("UHCI0", 0x3ff4c000n, 0x1000, "DPort", "UART host controller 0"),
  p("I2S0", 0x3ff4f000n, 0x1000, "DPort", "Inter-IC sound 0"),
  p("UART1", 0x3ff50000n, 0x1000, "DPort", "UART 1"),
  p("I2C0", 0x3ff53000n, 0x1000, "DPort", "Inter-integrated circuit 0"),
  p("RMT", 0x3ff56000n, 0x1000, "DPort", "Remote control transceiver"),
  p("LEDC", 0x3ff59000n, 0x1000, "DPort", "LED PWM controller"),
  p("EFUSE", 0x3ff5a000n, 0x1000, "DPort", "eFuse controller"),
  p("TWAI", 0x3ff6b000n, 0x1000, "DPort", "Two-wire automotive interface"),
  p("TIMG0", 0x3ff5f000n, 0x1000, "DPort", "Timer Group 0"),
  p("TIMG1", 0x3ff60000n, 0x1000, "DPort", "Timer Group 1"),
  p("SPI2_HSPI", 0x3ff64000n, 0x1000, "DPort", "General purpose SPI 2 (HSPI)"),
  p("SPI3_VSPI", 0x3ff65000n, 0x1000, "DPort", "General purpose SPI 3 (VSPI)"),
  p("I2C1", 0x3ff67000n, 0x1000, "DPort", "Inter-integrated circuit 1"),
  p("SDMMC", 0x3ff68000n, 0x1000, "DPort", "SD/MMC host controller"),
  p("EMAC", 0x3ff69000n, 0x2000, "DPort", "Ethernet MAC"),
  p("I2S1", 0x3ff6d000n, 0x1000, "DPort", "Inter-IC sound 1"),
  p("UART2", 0x3ff6e000n, 0x1000, "DPort", "UART 2"),
];

// Shared 0x60000000 pages on Xtensa ESP32-S2 (PeriBUS2) and ESP32-S3 (System).
const ESP32_S2_S3_SHARED_6000: readonly InternalPeripheralEntry[] = [
  p("UART0", 0x60000000n, 0x1000, "System", "UART0 register block"),
  p("SPI1", 0x60002000n, 0x1000, "System", "SPI1 register block"),
  p("SPI0", 0x60003000n, 0x1000, "System", "SPI0 register block"),
  p("GPIO", 0x60004000n, 0x1000, "System", "GPIO register block"),
  p("RTCCNTL", 0x60008000n, 0x800, "RTC", "RTC control register block"),
  p("IO_MUX", 0x60009000n, 0x1000, "System", "IO mux register block"),
  p("UART1", 0x60010000n, 0x1000, "System", "UART1 register block"),
  p("I2C0", 0x60013000n, 0x1000, "System", "I2C0 register block"),
  p("TIMG0", 0x6001f000n, 0x1000, "System", "Timer group 0"),
  p("TIMG1", 0x60020000n, 0x1000, "System", "Timer group 1"),
  p("SYSTIMER", 0x60023000n, 0x1000, "System", "System timer"),
  p("SPI2", 0x60024000n, 0x1000, "System", "SPI2 register block"),
  p("SPI3", 0x60025000n, 0x1000, "System", "SPI3 register block"),
  p("I2C1", 0x60027000n, 0x1000, "System", "I2C1 register block"),
  p("USB0", 0x60080000n, 0x40000, "System", "USB OTG FS controller"),
  p("SYSTEM", 0x600c0000n, 0x1000, "System", "System register block"),
  p("SENSITIVE", 0x600c1000n, 0x1000, "System", "Sensitive register block"),
];

// ESP32-S2 (Xtensa LX7) maps peripherals at 0x3f400000 (PeriBUS1) and 0x60000000 (PeriBUS2).
export const ESP32S2_PERIPHERALS: readonly InternalPeripheralEntry[] = [
  ...ESP32_S2_S3_SHARED_6000.map((entry) => ({
    ...entry,
    base: entry.base - 0x20c00000n,
    bus: "PeriBUS1" as const,
  })),
  ...ESP32_S2_S3_SHARED_6000.map((entry) => ({
    ...entry,
    bus: entry.bus === "RTC" ? ("RTC" as const) : ("PeriBUS2" as const),
  })),
  p("EFUSE", 0x3f41a000n, 0x1000, "PeriBUS1", "eFuse register block"),
  p("EFUSE", 0x6001a000n, 0x1000, "PeriBUS2", "eFuse register block"),
];

// ESP32-S3 (Xtensa LX7) maps peripherals at 0x60000000, adding UART2 and USB_SERIAL_JTAG.
export const ESP32S3_PERIPHERALS: readonly InternalPeripheralEntry[] = [
  ...ESP32_S2_S3_SHARED_6000,
  p("EFUSE", 0x60007000n, 0x1000, "System", "eFuse register block"),
  p("UART2", 0x6002e000n, 0x1000, "System", "UART2 register block"),
  p("USB_SERIAL_JTAG", 0x60038000n, 0x1000, "System", "USB Serial/JTAG"),
];

// ESP32-C3 bases from esp-idf soc/esp32c3/register/soc/reg_base.h.
export const ESP32C3_PERIPHERALS: readonly InternalPeripheralEntry[] = [
  p("UART0", 0x60000000n, 0x1000, "System", "UART register block"),
  p("SPI1", 0x60002000n, 0x1000, "System", "SPI1 register block"),
  p("SPI0", 0x60003000n, 0x1000, "System", "SPI0 register block"),
  p("GPIO", 0x60004000n, 0x1000, "System", "GPIO register block"),
  p("RTCCNTL", 0x60008000n, 0x800, "RTC", "RTC control register block"),
  p("EFUSE", 0x60008800n, 0x800, "System", "eFuse register block"),
  p("IO_MUX", 0x60009000n, 0x1000, "System", "IO mux register block"),
  p("UART1", 0x60010000n, 0x1000, "System", "UART1 register block"),
  p("I2C0", 0x60013000n, 0x1000, "System", "I2C register block"),
  p("TIMG0", 0x6001f000n, 0x1000, "System", "Timer group 0"),
  p("TIMG1", 0x60020000n, 0x1000, "System", "Timer group 1"),
  p("SYSTIMER", 0x60023000n, 0x1000, "System", "System timer"),
  p("SPI2", 0x60024000n, 0x1000, "System", "SPI2 register block"),
  p("USB_SERIAL_JTAG", 0x60043000n, 0x1000, "System", "USB serial JTAG"),
  p("SYSTEM", 0x600c0000n, 0x1000, "System", "System register block"),
  p("SENSITIVE", 0x600c1000n, 0x1000, "System", "Sensitive register block"),
];

// ESP32-C2 bases from esp-idf soc/esp32c2/register/soc/reg_base.h.
export const ESP32C2_PERIPHERALS: readonly InternalPeripheralEntry[] = [
  p("UART0", 0x60000000n, 0x1000, "System", "UART register block"),
  p("SPI1", 0x60002000n, 0x1000, "System", "SPI1 register block"),
  p("SPI0", 0x60003000n, 0x1000, "System", "SPI0 register block"),
  p("GPIO", 0x60004000n, 0x1000, "System", "GPIO register block"),
  p("RTCCNTL", 0x60008000n, 0x800, "RTC", "RTC control register block"),
  p("EFUSE", 0x60008800n, 0x800, "System", "eFuse register block"),
  p("IO_MUX", 0x60009000n, 0x1000, "System", "IO mux register block"),
  p("UART1", 0x60010000n, 0x1000, "System", "UART1 register block"),
  p("I2C0", 0x60013000n, 0x1000, "System", "I2C register block"),
  p("TIMG0", 0x6001f000n, 0x1000, "System", "Timer group 0"),
  p("SYSTIMER", 0x60023000n, 0x1000, "System", "System timer"),
  p("SPI2", 0x60024000n, 0x1000, "System", "SPI2 register block"),
  p("I2C_MST", 0x6004e800n, 0x1000, "System", "I2C master register block"),
  p("SYSTEM", 0x600c0000n, 0x1000, "System", "System register block"),
  p("SENSITIVE", 0x600c1000n, 0x1000, "System", "Sensitive register block"),
];

// ESP32-C6 bases from esp-idf soc/esp32c6/register/soc/reg_base.h.
export const ESP32C6_PERIPHERALS: readonly InternalPeripheralEntry[] = [
  p("UART0", 0x60000000n, 0x1000, "System", "UART register block"),
  p("UART1", 0x60001000n, 0x1000, "System", "UART1 register block"),
  p("SPI0", 0x60002000n, 0x1000, "System", "SPI0 register block"),
  p("SPI1", 0x60003000n, 0x1000, "System", "SPI1 register block"),
  p("I2C", 0x60004000n, 0x1000, "System", "I2C register block"),
  p("TIMG0", 0x60008000n, 0x1000, "System", "Timer group 0"),
  p("TIMG1", 0x60009000n, 0x1000, "System", "Timer group 1"),
  p("USB_SERIAL_JTAG", 0x6000f000n, 0x1000, "System", "USB serial JTAG"),
  p("INTMTX", 0x60010000n, 0x1000, "System", "Interrupt matrix"),
  p("ETM", 0x60013000n, 0x1000, "System", "Event task matrix"),
  p("GPIO", 0x60091000n, 0x1000, "System", "GPIO register block"),
  p("IO_MUX", 0x60090000n, 0x1000, "System", "IO mux register block"),
  p("LP_UART", 0x600b1400n, 0x400, "System", "Low-power UART"),
  p("TRACE", 0x600c0000n, 0x1000, "System", "Trace register block"),
];

// ESP32-H2 bases from esp-idf soc/esp32h2/register/soc/reg_base.h.
export const ESP32H2_PERIPHERALS: readonly InternalPeripheralEntry[] = [
  p("UART0", 0x60000000n, 0x1000, "System", "UART register block"),
  p("UART1", 0x60001000n, 0x1000, "System", "UART1 register block"),
  p("SPI0", 0x60002000n, 0x1000, "System", "SPI0 register block"),
  p("SPI1", 0x60003000n, 0x1000, "System", "SPI1 register block"),
  p("I2C0", 0x60004000n, 0x1000, "System", "I2C0 register block"),
  p("LEDC", 0x60008000n, 0x1000, "System", "LED controller"),
  p("TIMG0", 0x60009000n, 0x1000, "System", "Timer group 0"),
  p("USB_SERIAL_JTAG", 0x6000f000n, 0x1000, "System", "USB serial JTAG"),
  p("INTMTX", 0x60010000n, 0x1000, "System", "Interrupt matrix"),
  p("ETM", 0x60013000n, 0x1000, "System", "Event task matrix"),
  p("ECDSA", 0x6008e000n, 0x1000, "System", "ECDSA register block"),
  p("IO_MUX", 0x60090000n, 0x1000, "System", "IO mux register block"),
  p("GPIO", 0x60091000n, 0x1000, "System", "GPIO register block"),
  p("TRACE", 0x600c0000n, 0x1000, "System", "Trace register block"),
];
