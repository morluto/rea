import {
  atomicAliasEntry as a,
  peripheralEntry as p,
  type InternalPeripheralEntry,
} from "./types.js";
import { GD32F1_PERIPHERALS, STM32F1_PERIPHERALS } from "./stm32Catalogs.js";

// Raspberry Pi RP2040 blocks from pico-sdk addressmap.h and rp2040.svd.
// Atomic-aliased blocks span 4x 0x1000 pages (RW, XOR, SET, CLR), each bounded
// to the peripheral's implemented register span so unmapped sub-page offsets
// do not claim unrelated addresses.
export const RP2040_PERIPHERALS: readonly InternalPeripheralEntry[] = [
  a("XIP_CTRL", 0x14000000n, "AHBL", 0x20, "QSPI XIP cache control"),
  p("XIP_SSI", 0x18000000n, 0x100, "AHBL", "DW_apb_ssi XIP flash controller"),
  a("SYSINFO", 0x40000000n, "APB", 0x44, "System information registers"),
  a("SYSCFG", 0x40004000n, "APB", 0x1c, "System configuration block"),
  a("CLOCKS", 0x40008000n, "APB", 0xc8, "Clock control register block"),
  a("RESETS", 0x4000c000n, "APB", 0x0c, "Reset control register block"),
  a("PSM", 0x40010000n, "APB", 0x10, "Power-on state machine"),
  a("IO_BANK0", 0x40014000n, "APB", 0x190, "User GPIO mux and IRQ control"),
  a("IO_QSPI", 0x40018000n, "APB", 0x58, "QSPI I/O register block"),
  a("PADS_BANK0", 0x4001c000n, "APB", 0x84, "Pad control block for bank 0"),
  a("PADS_QSPI", 0x40020000n, "APB", 0x18, "Pad control block for QSPI"),
  a("XOSC", 0x40024000n, "APB", 0x20, "Crystal oscillator control"),
  a("PLL_SYS", 0x40028000n, "APB", 0x10, "System PLL register block"),
  a("PLL_USB", 0x4002c000n, "APB", 0x10, "USB PLL register block"),
  a("BUSCTRL", 0x40030000n, "APB", 0x28, "Bus fabric control register block"),
  a("UART0", 0x40034000n, "APB", 0x1000, "PL011 UART0 register block"),
  a("UART1", 0x40038000n, "APB", 0x1000, "PL011 UART1 register block"),
  a("SPI0", 0x4003c000n, "APB", 0x1000, "PL022 SPI0 register block"),
  a("SPI1", 0x40040000n, "APB", 0x1000, "PL022 SPI1 register block"),
  a("I2C0", 0x40044000n, "APB", 0x100, "DW_apb_i2c I2C0 register block"),
  a("I2C1", 0x40048000n, "APB", 0x100, "DW_apb_i2c I2C1 register block"),
  a("ADC", 0x4004c000n, "APB", 0x14, "SAR ADC and temperature sensor"),
  a("PWM", 0x40050000n, "APB", 0xb0, "8-slice PWM controller"),
  a("TIMER", 0x40054000n, "APB", 0x44, "64-bit microsecond timer"),
  a("WATCHDOG", 0x40058000n, "APB", 0x30, "Watchdog and scratch registers"),
  a("RTC", 0x4005c000n, "APB", 0x30, "Real-time calendar clock"),
  a("ROSC", 0x40060000n, "APB", 0x24, "Ring oscillator control"),
  a("VREG_AND_CHIP_RESET", 0x40064000n, "APB", 0x0c, "Voltage regulator/reset"),
  a("TBMAN", 0x4006c000n, "APB", 0x04, "Testbench manager"),
  a("DMA", 0x50000000n, "AHBL", 0x468, "12-channel DMA controller"),
  p("USBCTRL_DPRAM", 0x50100000n, 0x1000, "AHBL", "USB dual-port SRAM"),
  a("USBCTRL_REGS", 0x50110000n, "AHBL", 0x9c, "USB FS/LS controller"),
  a("PIO0", 0x50200000n, "AHBL", 0x144, "Programmable I/O block 0"),
  a("PIO1", 0x50300000n, "AHBL", 0x144, "Programmable I/O block 1"),
  p("SIO", 0xd0000000n, 0x180, "APB", "Single-cycle I/O block"),
];

// Nordic nRF52832/52833/52840 peripheral windows (nrf52840.svd).
// Register structs implement TASKS/EVENTS/INTEN/CONFIG below +0x600 (or +0xa00
// on PPI); P0 and P1 occupy distinct windows starting at +0x500 and +0x800.
export const NRF52_PERIPHERALS: readonly InternalPeripheralEntry[] = [
  p("FICR", 0x10000000n, 0x1000, "System", "Factory information registers"),
  p("UICR", 0x10001000n, 0x1000, "System", "User information registers"),
  p("CLOCK_POWER", 0x40000000n, 0x600, "APB", "Clock and power management"),
  p("RADIO", 0x40001000n, 0x1000, "APB", "2.4 GHz BLE / 802.15.4 radio"),
  p("UARTE0", 0x40002000n, 0x600, "APB", "UART0 / UARTE0 with EasyDMA"),
  p("SPIM0_TWIM0", 0x40003000n, 0x600, "APB", "SPI0 / TWI0 shared EasyDMA"),
  p("SPIM1_TWIM1", 0x40004000n, 0x600, "APB", "SPI1 / TWI1 shared EasyDMA"),
  p("NFCT", 0x40005000n, 0x600, "APB", "NFC-A tag peripheral"),
  p("GPIOTE", 0x40006000n, 0x600, "APB", "GPIO tasks and events"),
  p("SAADC", 0x40007000n, 0x650, "APB", "Successive approximation ADC"),
  p("TIMER0", 0x40008000n, 0x600, "APB", "Timer/counter 0"),
  p("TIMER1", 0x40009000n, 0x600, "APB", "Timer/counter 1"),
  p("TIMER2", 0x4000a000n, 0x600, "APB", "Timer/counter 2"),
  p("RTC0", 0x4000b000n, 0x600, "APB", "Real-time counter 0"),
  p("TEMP", 0x4000c000n, 0x600, "APB", "Temperature sensor"),
  p("RNG", 0x4000d000n, 0x600, "APB", "Random number generator"),
  p("ECB", 0x4000e000n, 0x600, "APB", "AES electronic codebook"),
  p("CCM_AAR", 0x4000f000n, 0x600, "APB", "AES CCM and address resolver"),
  p("WDT", 0x40010000n, 0x600, "APB", "Watchdog timer"),
  p("RTC1", 0x40011000n, 0x600, "APB", "Real-time counter 1"),
  p("QDEC", 0x40012000n, 0x600, "APB", "Quadrature decoder"),
  p("COMP", 0x40013000n, 0x600, "APB", "Comparator / LPCOMP"),
  p("TIMER3", 0x4001a000n, 0x600, "APB", "Timer/counter 3"),
  p("TIMER4", 0x4001b000n, 0x600, "APB", "Timer/counter 4"),
  p("PWM0", 0x4001c000n, 0x600, "APB", "Pulse width modulation unit 0"),
  p("PDM", 0x4001d000n, 0x600, "APB", "Pulse density modulation"),
  p("NVMC", 0x4001e000n, 0x600, "APB", "Non-volatile memory controller"),
  p("PPI", 0x4001f000n, 0xa00, "APB", "Programmable peripheral interconnect"),
  p("PWM1", 0x40021000n, 0x600, "APB", "Pulse width modulation unit 1"),
  p("PWM2", 0x40022000n, 0x600, "APB", "Pulse width modulation unit 2"),
  p("SPIM2", 0x40023000n, 0x600, "APB", "SPI2 / TWI2 shared EasyDMA"),
  p("RTC2", 0x40024000n, 0x600, "APB", "Real-time counter 2"),
  p("I2S", 0x40025000n, 0x600, "APB", "Inter-IC sound interface"),
  p("USBD", 0x40027000n, 0x900, "APB", "USB 2.0 full-speed device"),
  p("UARTE1", 0x40028000n, 0x600, "APB", "UARTE1 with EasyDMA"),
  p("QSPI", 0x40029000n, 0x700, "APB", "External Quad-SPI flash interface"),
  p("PWM3", 0x4002d000n, 0x600, "APB", "Pulse width modulation unit 3"),
  p("SPIM3", 0x4002f000n, 0x600, "APB", "High-speed SPIM3"),
  p("P0", 0x50000500n, 0x300, "System", "GPIO port 0 registers (P0.00..P0.31)"),
  p("P1", 0x50000800n, 0x300, "System", "GPIO port 1 registers (P1.00..P1.15)"),
];

// Microchip ATSAMD21 peripheral windows (samd21g18a.h).
export const SAMD21_PERIPHERALS: readonly InternalPeripheralEntry[] = [
  p("PAC0", 0x40000000n, 0x400, "APB", "Peripheral access controller 0"),
  p("PM", 0x40000400n, 0x400, "APB", "Power manager"),
  p("SYSCTRL", 0x40000800n, 0x400, "APB", "System controller"),
  p("GCLK", 0x40000c00n, 0x400, "APB", "Generic clock controller"),
  p("WDT", 0x40001000n, 0x400, "APB", "Watchdog timer"),
  p("RTC", 0x40001400n, 0x400, "APB", "Real-time counter"),
  p("EIC", 0x40001800n, 0x400, "APB", "External interrupt controller"),
  p("PAC1", 0x41000000n, 0x400, "APB", "Peripheral access controller 1"),
  p("DSU", 0x41002000n, 0x2000, "APB", "Device service unit"),
  p("NVMCTRL", 0x41004000n, 0x400, "APB", "Non-volatile memory controller"),
  p("PORT", 0x41004400n, 0x400, "APB", "Port pin configuration"),
  p("DMAC", 0x41004800n, 0x400, "APB", "Direct memory access controller"),
  p("USB", 0x41005000n, 0x1000, "APB", "USB full-speed host/device"),
  p("PAC2", 0x42000000n, 0x400, "APB", "Peripheral access controller 2"),
  p("EVSYS", 0x42000400n, 0x400, "APB", "Event system"),
  p("SERCOM0", 0x42000800n, 0x400, "APB", "Serial communication interface 0"),
  p("SERCOM1", 0x42000c00n, 0x400, "APB", "Serial communication interface 1"),
  p("SERCOM2", 0x42001000n, 0x400, "APB", "Serial communication interface 2"),
  p("SERCOM3", 0x42001400n, 0x400, "APB", "Serial communication interface 3"),
  p("SERCOM4", 0x42001800n, 0x400, "APB", "Serial communication interface 4"),
  p("SERCOM5", 0x42001c00n, 0x400, "APB", "Serial communication interface 5"),
  p("TCC0", 0x42002000n, 0x400, "APB", "Timer/counter for control 0"),
  p("TCC1", 0x42002400n, 0x400, "APB", "Timer/counter for control 1"),
  p("TCC2", 0x42002800n, 0x400, "APB", "Timer/counter for control 2"),
  p("TC3", 0x42002c00n, 0x400, "APB", "Basic timer/counter 3"),
  p("TC4", 0x42003000n, 0x400, "APB", "Basic timer/counter 4"),
  p("TC5", 0x42003400n, 0x400, "APB", "Basic timer/counter 5"),
  p("ADC", 0x42004000n, 0x400, "APB", "Analog-to-digital converter"),
  p("AC", 0x42004400n, 0x400, "APB", "Analog comparators"),
  p("DAC", 0x42004800n, 0x400, "APB", "Digital-to-analog converter"),
  p("PORT_IOBUS", 0x60000000n, 0x200, "System", "Single-cycle IOBUS port"),
];

const VF103_OMITTED: ReadonlySet<string> = new Set([
  "USBD",
  "GPIOF",
  "GPIOG",
  "TIMER7",
  "ADC2",
  "SDIO",
]);

const CH32V_OMITTED: ReadonlySet<string> = new Set([
  "USB",
  "GPIOF",
  "GPIOG",
  "TIM8",
  "ADC3",
  "SDIO",
]);

// GigaDevice GD32VF103 (Nuclei Bumblebee RISC-V) peripheral windows.
export const GD32VF103_PERIPHERALS: readonly InternalPeripheralEntry[] = [
  ...GD32F1_PERIPHERALS.filter((item) => !VF103_OMITTED.has(item.name)),
  p("EXMC", 0xa0000000n, 0x1000, "AHB", "External memory controller"),
  p("USBFS", 0x50000000n, 0x40000, "AHB", "USB full-speed OTG controller"),
  p("MTIMER", 0xd1000000n, 0x1000, "System", "Bumblebee machine timer"),
  p("ECLIC", 0xd2000000n, 0x2000, "System", "Enhanced core-local interrupt"),
];

// WCH CH32V20x/30x (QingKe V4 RISC-V) peripheral windows, symmetric on shared F1 slots.
export const CH32V30X_PERIPHERALS: readonly InternalPeripheralEntry[] = [
  ...STM32F1_PERIPHERALS.filter((item) => !CH32V_OMITTED.has(item.name)),
  p("TIM8", 0x40013400n, 0x400, "APB2", "Advanced control timer 8"),
  p("SDIO", 0x40018000n, 0x400, "AHB", "SDIO host controller"),
  p("USBHS", 0x40023400n, 0x400, "AHB", "USB 2.0 high-speed controller"),
  p("RNG", 0x40023800n, 0x400, "AHB", "True random number generator"),
  p("ETH", 0x40028000n, 0x1400, "AHB", "Ethernet MAC and DMA"),
  p("OTG_FS", 0x50000000n, 0x40000, "AHB", "USB OTG full-speed controller"),
  p("FSMC", 0xa0000000n, 0x1000, "AHB", "Flexible static memory controller"),
  p("PFIC", 0xe000e000n, 0x1000, "System", "QingKe fast interrupt and SysTick"),
];
