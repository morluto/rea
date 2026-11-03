import { z } from "zod";
import type { HardwareArchitecture } from "./hardwareMemoryMap.js";

/** Supported microcontroller and SoC platform families. */
export const SOC_PLATFORMS = ["stm32f1", "stm32f4", "gd32f1", "esp32"] as const;
export type SocPlatform = (typeof SOC_PLATFORMS)[number];
export const socPlatformSchema = z.enum(SOC_PLATFORMS);

/** Standard peripheral bus interconnect kinds. */
export type PeripheralBusKind =
  | "APB1"
  | "APB2"
  | "AHB"
  | "AHB1"
  | "AHB2"
  | "AHB3"
  | "DPort"
  | "RTC"
  | "System";

/** Definition for a known SoC peripheral controller block. */
export interface SocPeripheralDefinition {
  readonly platform: SocPlatform;
  readonly name: string;
  readonly baseAddress: string;
  readonly baseAddressValue: bigint;
  readonly sizeBytes: number;
  readonly bus: PeripheralBusKind;
  readonly description: string;
}

export const socPeripheralDefinitionSchema = z.strictObject({
  platform: socPlatformSchema,
  name: z.string(),
  baseAddress: z.string(),
  baseAddressValue: z.bigint(),
  sizeBytes: z.number().int().positive(),
  bus: z.enum([
    "APB1",
    "APB2",
    "AHB",
    "AHB1",
    "AHB2",
    "AHB3",
    "DPort",
    "RTC",
    "System",
  ]),
  description: z.string(),
});

interface InternalPeripheralEntry {
  readonly name: string;
  readonly base: bigint;
  readonly size: number;
  readonly bus: PeripheralBusKind;
  readonly description: string;
}

// STMicroelectronics STM32F10x series peripheral memory map (RM0008).
const STM32F1_PERIPHERALS: readonly InternalPeripheralEntry[] = [
  // APB1
  {
    name: "TIM2",
    base: 0x40000000n,
    size: 0x400,
    bus: "APB1",
    description: "General purpose timer 2",
  },
  {
    name: "TIM3",
    base: 0x40000400n,
    size: 0x400,
    bus: "APB1",
    description: "General purpose timer 3",
  },
  {
    name: "TIM4",
    base: 0x40000800n,
    size: 0x400,
    bus: "APB1",
    description: "General purpose timer 4",
  },
  {
    name: "RTC",
    base: 0x40002800n,
    size: 0x400,
    bus: "APB1",
    description: "Real-time clock",
  },
  {
    name: "WWDG",
    base: 0x40002c00n,
    size: 0x400,
    bus: "APB1",
    description: "Window watchdog timer",
  },
  {
    name: "IWDG",
    base: 0x40003000n,
    size: 0x400,
    bus: "APB1",
    description: "Independent watchdog timer",
  },
  {
    name: "SPI2",
    base: 0x40003800n,
    size: 0x400,
    bus: "APB1",
    description: "Serial peripheral interface 2",
  },
  {
    name: "USART2",
    base: 0x40004400n,
    size: 0x400,
    bus: "APB1",
    description: "Universal synchronous asynchronous receiver transmitter 2",
  },
  {
    name: "USART3",
    base: 0x40004800n,
    size: 0x400,
    bus: "APB1",
    description: "Universal synchronous asynchronous receiver transmitter 3",
  },
  {
    name: "I2C1",
    base: 0x40005400n,
    size: 0x400,
    bus: "APB1",
    description: "Inter-integrated circuit 1",
  },
  {
    name: "I2C2",
    base: 0x40005800n,
    size: 0x400,
    bus: "APB1",
    description: "Inter-integrated circuit 2",
  },
  {
    name: "CAN1",
    base: 0x40006400n,
    size: 0x400,
    bus: "APB1",
    description: "Controller area network 1",
  },
  {
    name: "PWR",
    base: 0x40007000n,
    size: 0x400,
    bus: "APB1",
    description: "Power control interface",
  },
  // APB2
  {
    name: "AFIO",
    base: 0x40010000n,
    size: 0x400,
    bus: "APB2",
    description: "Alternate function I/O remap and EXTI routing",
  },
  {
    name: "EXTI",
    base: 0x40010400n,
    size: 0x400,
    bus: "APB2",
    description: "External interrupt/event controller",
  },
  {
    name: "GPIOA",
    base: 0x40010800n,
    size: 0x400,
    bus: "APB2",
    description: "General purpose I/O port A",
  },
  {
    name: "GPIOB",
    base: 0x40010c00n,
    size: 0x400,
    bus: "APB2",
    description: "General purpose I/O port B",
  },
  {
    name: "GPIOC",
    base: 0x40011000n,
    size: 0x400,
    bus: "APB2",
    description: "General purpose I/O port C",
  },
  {
    name: "GPIOD",
    base: 0x40011400n,
    size: 0x400,
    bus: "APB2",
    description: "General purpose I/O port D",
  },
  {
    name: "ADC1",
    base: 0x40012400n,
    size: 0x400,
    bus: "APB2",
    description: "Analog-to-digital converter 1",
  },
  {
    name: "ADC2",
    base: 0x40012800n,
    size: 0x400,
    bus: "APB2",
    description: "Analog-to-digital converter 2",
  },
  {
    name: "TIM1",
    base: 0x40012c00n,
    size: 0x400,
    bus: "APB2",
    description: "Advanced control timer 1",
  },
  {
    name: "SPI1",
    base: 0x40013000n,
    size: 0x400,
    bus: "APB2",
    description: "Serial peripheral interface 1",
  },
  {
    name: "USART1",
    base: 0x40013800n,
    size: 0x400,
    bus: "APB2",
    description: "Universal synchronous asynchronous receiver transmitter 1",
  },
  // AHB
  {
    name: "DMA1",
    base: 0x40020000n,
    size: 0x400,
    bus: "AHB",
    description: "Direct memory access controller 1",
  },
  {
    name: "DMA2",
    base: 0x40020400n,
    size: 0x400,
    bus: "AHB",
    description: "Direct memory access controller 2",
  },
  {
    name: "RCC",
    base: 0x40021000n,
    size: 0x400,
    bus: "AHB",
    description: "Reset and clock control",
  },
  {
    name: "Flash_IF",
    base: 0x40022000n,
    size: 0x400,
    bus: "AHB",
    description: "Embedded Flash memory interface",
  },
  {
    name: "CRC",
    base: 0x40023000n,
    size: 0x400,
    bus: "AHB",
    description: "CRC calculation unit",
  },
];

// GigaDevice GD32F10x series peripheral memory map.
const GD32F1_PERIPHERALS: readonly InternalPeripheralEntry[] = [
  // APB1
  {
    name: "TIMER1",
    base: 0x40000000n,
    size: 0x400,
    bus: "APB1",
    description: "General purpose timer 1 (TIM2 equivalent)",
  },
  {
    name: "TIMER2",
    base: 0x40000400n,
    size: 0x400,
    bus: "APB1",
    description: "General purpose timer 2 (TIM3 equivalent)",
  },
  {
    name: "RTC",
    base: 0x40002800n,
    size: 0x400,
    bus: "APB1",
    description: "Real-time clock",
  },
  {
    name: "WWDG",
    base: 0x40002c00n,
    size: 0x400,
    bus: "APB1",
    description: "Window watchdog timer",
  },
  {
    name: "FWDGT",
    base: 0x40003000n,
    size: 0x400,
    bus: "APB1",
    description: "Free watchdog timer (IWDG equivalent)",
  },
  {
    name: "SPI1",
    base: 0x40003800n,
    size: 0x400,
    bus: "APB1",
    description: "Serial peripheral interface 1 (SPI2 equivalent)",
  },
  {
    name: "USART1",
    base: 0x40004400n,
    size: 0x400,
    bus: "APB1",
    description: "Universal synchronous asynchronous receiver transmitter 1",
  },
  {
    name: "I2C0",
    base: 0x40005400n,
    size: 0x400,
    bus: "APB1",
    description: "Inter-integrated circuit 0 (I2C1 equivalent)",
  },
  // APB2
  {
    name: "AFIO",
    base: 0x40010000n,
    size: 0x400,
    bus: "APB2",
    description: "Alternate function I/O and EXTI routing",
  },
  {
    name: "EXTI",
    base: 0x40010400n,
    size: 0x400,
    bus: "APB2",
    description: "External interrupt controller",
  },
  {
    name: "GPIOA",
    base: 0x40010800n,
    size: 0x400,
    bus: "APB2",
    description: "General purpose I/O port A",
  },
  {
    name: "GPIOB",
    base: 0x40010c00n,
    size: 0x400,
    bus: "APB2",
    description: "General purpose I/O port B",
  },
  {
    name: "GPIOC",
    base: 0x40011000n,
    size: 0x400,
    bus: "APB2",
    description: "General purpose I/O port C",
  },
  {
    name: "ADC0",
    base: 0x40012400n,
    size: 0x400,
    bus: "APB2",
    description: "Analog-to-digital converter 0 (ADC1 equivalent)",
  },
  {
    name: "TIMER0",
    base: 0x40012c00n,
    size: 0x400,
    bus: "APB2",
    description: "Advanced timer 0 (TIM1 equivalent)",
  },
  {
    name: "SPI0",
    base: 0x40013000n,
    size: 0x400,
    bus: "APB2",
    description: "Serial peripheral interface 0 (SPI1 equivalent)",
  },
  {
    name: "USART0",
    base: 0x40013800n,
    size: 0x400,
    bus: "APB2",
    description:
      "Universal synchronous asynchronous receiver transmitter 0 (USART1 equivalent)",
  },
  // AHB
  {
    name: "DMA0",
    base: 0x40020000n,
    size: 0x400,
    bus: "AHB",
    description: "Direct memory access controller 0 (DMA1 equivalent)",
  },
  {
    name: "RCU",
    base: 0x40021000n,
    size: 0x400,
    bus: "AHB",
    description: "Reset and clock unit (RCC equivalent)",
  },
  {
    name: "FMC",
    base: 0x40022000n,
    size: 0x400,
    bus: "AHB",
    description: "Flash memory controller",
  },
];

// STM32F405/407 peripheral windows from RM0090. RT-Spark uses STM32F407ZGT6.
// Blocks present only on other F4 lines (DMA2D, FMC-as-F429, JPEG) are omitted.
const STM32F4_PERIPHERALS: readonly InternalPeripheralEntry[] = [
  // APB1
  {
    name: "TIM2",
    base: 0x40000000n,
    size: 0x400,
    bus: "APB1",
    description: "General purpose timer 2",
  },
  {
    name: "TIM3",
    base: 0x40000400n,
    size: 0x400,
    bus: "APB1",
    description: "General purpose timer 3",
  },
  {
    name: "TIM4",
    base: 0x40000800n,
    size: 0x400,
    bus: "APB1",
    description: "General purpose timer 4",
  },
  {
    name: "TIM5",
    base: 0x40000c00n,
    size: 0x400,
    bus: "APB1",
    description: "General purpose timer 5",
  },
  {
    name: "TIM6",
    base: 0x40001000n,
    size: 0x400,
    bus: "APB1",
    description: "Basic timer 6",
  },
  {
    name: "TIM7",
    base: 0x40001400n,
    size: 0x400,
    bus: "APB1",
    description: "Basic timer 7",
  },
  {
    name: "TIM12",
    base: 0x40001800n,
    size: 0x400,
    bus: "APB1",
    description: "General purpose timer 12",
  },
  {
    name: "TIM13",
    base: 0x40001c00n,
    size: 0x400,
    bus: "APB1",
    description: "General purpose timer 13",
  },
  {
    name: "TIM14",
    base: 0x40002000n,
    size: 0x400,
    bus: "APB1",
    description: "General purpose timer 14",
  },
  {
    name: "RTC",
    base: 0x40002800n,
    size: 0x400,
    bus: "APB1",
    description: "Real-time clock",
  },
  {
    name: "WWDG",
    base: 0x40002c00n,
    size: 0x400,
    bus: "APB1",
    description: "Window watchdog",
  },
  {
    name: "IWDG",
    base: 0x40003000n,
    size: 0x400,
    bus: "APB1",
    description: "Independent watchdog",
  },
  {
    name: "I2S2ext",
    base: 0x40003400n,
    size: 0x400,
    bus: "APB1",
    description: "I2S2 full-duplex extension",
  },
  {
    name: "SPI2",
    base: 0x40003800n,
    size: 0x400,
    bus: "APB1",
    description: "Serial peripheral interface 2 / I2S2",
  },
  {
    name: "SPI3",
    base: 0x40003c00n,
    size: 0x400,
    bus: "APB1",
    description: "Serial peripheral interface 3 / I2S3",
  },
  {
    name: "I2S3ext",
    base: 0x40004000n,
    size: 0x400,
    bus: "APB1",
    description: "I2S3 full-duplex extension",
  },
  {
    name: "USART2",
    base: 0x40004400n,
    size: 0x400,
    bus: "APB1",
    description: "Universal synchronous asynchronous receiver transmitter 2",
  },
  {
    name: "USART3",
    base: 0x40004800n,
    size: 0x400,
    bus: "APB1",
    description: "Universal synchronous asynchronous receiver transmitter 3",
  },
  {
    name: "UART4",
    base: 0x40004c00n,
    size: 0x400,
    bus: "APB1",
    description: "Universal asynchronous receiver transmitter 4",
  },
  {
    name: "UART5",
    base: 0x40005000n,
    size: 0x400,
    bus: "APB1",
    description: "Universal asynchronous receiver transmitter 5",
  },
  {
    name: "I2C1",
    base: 0x40005400n,
    size: 0x400,
    bus: "APB1",
    description: "Inter-integrated circuit 1",
  },
  {
    name: "I2C2",
    base: 0x40005800n,
    size: 0x400,
    bus: "APB1",
    description: "Inter-integrated circuit 2",
  },
  {
    name: "I2C3",
    base: 0x40005c00n,
    size: 0x400,
    bus: "APB1",
    description: "Inter-integrated circuit 3",
  },
  {
    name: "CAN1",
    base: 0x40006400n,
    size: 0x400,
    bus: "APB1",
    description: "Controller area network 1",
  },
  {
    name: "CAN2",
    base: 0x40006800n,
    size: 0x400,
    bus: "APB1",
    description: "Controller area network 2",
  },
  {
    name: "PWR",
    base: 0x40007000n,
    size: 0x400,
    bus: "APB1",
    description: "Power controller",
  },
  {
    name: "DAC",
    base: 0x40007400n,
    size: 0x400,
    bus: "APB1",
    description: "Digital-to-analog converter",
  },
  // APB2
  {
    name: "TIM1",
    base: 0x40010000n,
    size: 0x400,
    bus: "APB2",
    description: "Advanced control timer 1",
  },
  {
    name: "TIM8",
    base: 0x40010400n,
    size: 0x400,
    bus: "APB2",
    description: "Advanced control timer 8",
  },
  {
    name: "USART1",
    base: 0x40011000n,
    size: 0x400,
    bus: "APB2",
    description: "Universal synchronous asynchronous receiver transmitter 1",
  },
  {
    name: "USART6",
    base: 0x40011400n,
    size: 0x400,
    bus: "APB2",
    description: "Universal synchronous asynchronous receiver transmitter 6",
  },
  {
    name: "ADC1_3",
    base: 0x40012000n,
    size: 0x400,
    bus: "APB2",
    description: "Analog-to-digital converters 1, 2, and 3",
  },
  {
    name: "SDIO",
    base: 0x40012c00n,
    size: 0x400,
    bus: "APB2",
    description: "Secure digital input/output interface",
  },
  {
    name: "SPI1",
    base: 0x40013000n,
    size: 0x400,
    bus: "APB2",
    description: "Serial peripheral interface 1",
  },
  {
    name: "SYSCFG",
    base: 0x40013800n,
    size: 0x400,
    bus: "APB2",
    description: "System configuration controller",
  },
  {
    name: "EXTI",
    base: 0x40013c00n,
    size: 0x400,
    bus: "APB2",
    description: "External interrupt/event controller",
  },
  {
    name: "TIM9",
    base: 0x40014000n,
    size: 0x400,
    bus: "APB2",
    description: "General purpose timer 9",
  },
  {
    name: "TIM10",
    base: 0x40014400n,
    size: 0x400,
    bus: "APB2",
    description: "General purpose timer 10",
  },
  {
    name: "TIM11",
    base: 0x40014800n,
    size: 0x400,
    bus: "APB2",
    description: "General purpose timer 11",
  },
  // AHB1
  {
    name: "GPIOA",
    base: 0x40020000n,
    size: 0x400,
    bus: "AHB1",
    description: "General purpose I/O port A",
  },
  {
    name: "GPIOB",
    base: 0x40020400n,
    size: 0x400,
    bus: "AHB1",
    description: "General purpose I/O port B",
  },
  {
    name: "GPIOC",
    base: 0x40020800n,
    size: 0x400,
    bus: "AHB1",
    description: "General purpose I/O port C",
  },
  {
    name: "GPIOD",
    base: 0x40020c00n,
    size: 0x400,
    bus: "AHB1",
    description: "General purpose I/O port D",
  },
  {
    name: "GPIOE",
    base: 0x40021000n,
    size: 0x400,
    bus: "AHB1",
    description: "General purpose I/O port E",
  },
  {
    name: "GPIOF",
    base: 0x40021400n,
    size: 0x400,
    bus: "AHB1",
    description: "General purpose I/O port F",
  },
  {
    name: "GPIOG",
    base: 0x40021800n,
    size: 0x400,
    bus: "AHB1",
    description: "General purpose I/O port G",
  },
  {
    name: "GPIOH",
    base: 0x40021c00n,
    size: 0x400,
    bus: "AHB1",
    description: "General purpose I/O port H",
  },
  {
    name: "GPIOI",
    base: 0x40022000n,
    size: 0x400,
    bus: "AHB1",
    description: "General purpose I/O port I",
  },
  {
    name: "CRC",
    base: 0x40023000n,
    size: 0x400,
    bus: "AHB1",
    description: "CRC calculation unit",
  },
  {
    name: "RCC",
    base: 0x40023800n,
    size: 0x400,
    bus: "AHB1",
    description: "Reset and clock control",
  },
  {
    name: "Flash_IF",
    base: 0x40023c00n,
    size: 0x400,
    bus: "AHB1",
    description: "Flash memory interface",
  },
  {
    name: "DMA1",
    base: 0x40026000n,
    size: 0x400,
    bus: "AHB1",
    description: "Direct memory access controller 1",
  },
  {
    name: "DMA2",
    base: 0x40026400n,
    size: 0x400,
    bus: "AHB1",
    description: "Direct memory access controller 2",
  },
  {
    name: "ETH",
    base: 0x40028000n,
    size: 0x1400,
    bus: "AHB1",
    description: "Ethernet MAC, MMC, PTP, and DMA",
  },
  {
    name: "USB_OTG_HS",
    base: 0x40040000n,
    size: 0x40000,
    bus: "AHB1",
    description: "USB on-the-go high-speed controller",
  },
  {
    name: "USB_OTG_FS",
    base: 0x50000000n,
    size: 0x40000,
    bus: "AHB2",
    description: "USB on-the-go full-speed controller",
  },
  {
    name: "DCMI",
    base: 0x50050000n,
    size: 0x400,
    bus: "AHB2",
    description: "Digital camera interface",
  },
  {
    name: "RNG",
    base: 0x50060800n,
    size: 0x400,
    bus: "AHB2",
    description: "Random number generator",
  },
  {
    name: "FSMC",
    base: 0xa0000000n,
    size: 0x1000,
    bus: "AHB3",
    description: "Flexible static memory controller registers",
  },
];

// Espressif ESP32 series peripheral memory map (ESP32 Technical Reference Manual).
const ESP32_PERIPHERALS: readonly InternalPeripheralEntry[] = [
  {
    name: "UART0",
    base: 0x3ff40000n,
    size: 0x1000,
    bus: "DPort",
    description: "Universal asynchronous receiver transmitter 0",
  },
  {
    name: "SPI1",
    base: 0x3ff42000n,
    size: 0x1000,
    bus: "DPort",
    description: "SPI flash interface 1",
  },
  {
    name: "SPI0",
    base: 0x3ff43000n,
    size: 0x1000,
    bus: "DPort",
    description: "SPI cache/external memory interface 0",
  },
  {
    name: "GPIO",
    base: 0x3ff44000n,
    size: 0x1000,
    bus: "DPort",
    description: "General purpose I/O controller",
  },
  {
    name: "RTC_CNTL",
    base: 0x3ff48000n,
    size: 0x1000,
    bus: "RTC",
    description: "Real-time clock and ultra-low power controller",
  },
  {
    name: "IO_MUX",
    base: 0x3ff49000n,
    size: 0x1000,
    bus: "DPort",
    description: "Pin multiplexer and drive capability control",
  },
  {
    name: "DPORT",
    base: 0x3ff4c000n,
    size: 0x1000,
    bus: "DPort",
    description: "System control registers, clock gating, and peripheral reset",
  },
  {
    name: "I2C0",
    base: 0x3ff53000n,
    size: 0x1000,
    bus: "DPort",
    description: "Inter-integrated circuit 0",
  },
  {
    name: "EFUSE",
    base: 0x3ff5a000n,
    size: 0x1000,
    bus: "DPort",
    description: "eFuse controller (MAC address, security keys)",
  },
  {
    name: "TIMG0",
    base: 0x3ff5f000n,
    size: 0x1000,
    bus: "DPort",
    description: "Timer Group 0 (64-bit timers and watchdog)",
  },
  {
    name: "TIMG1",
    base: 0x3ff60000n,
    size: 0x1000,
    bus: "DPort",
    description: "Timer Group 1 (64-bit timers and watchdog)",
  },
  {
    name: "SPI2_HSPI",
    base: 0x3ff64000n,
    size: 0x1000,
    bus: "DPort",
    description: "General purpose SPI controller 2 (HSPI)",
  },
  {
    name: "SPI3_VSPI",
    base: 0x3ff65000n,
    size: 0x1000,
    bus: "DPort",
    description: "General purpose SPI controller 3 (VSPI)",
  },
  {
    name: "I2C1",
    base: 0x3ff67000n,
    size: 0x1000,
    bus: "DPort",
    description: "Inter-integrated circuit 1",
  },
  {
    name: "UART1",
    base: 0x3ff6e000n,
    size: 0x1000,
    bus: "DPort",
    description: "Universal asynchronous receiver transmitter 1",
  },
  {
    name: "UART2",
    base: 0x3ff6f000n,
    size: 0x1000,
    bus: "DPort",
    description: "Universal asynchronous receiver transmitter 2",
  },
  // ESP32-C series (RISC-V) peripheral memory map
  {
    name: "UART0",
    base: 0x60000000n,
    size: 0x1000,
    bus: "System",
    description: "Universal asynchronous receiver transmitter 0 (ESP32-C)",
  },
  {
    name: "SPI1",
    base: 0x60002000n,
    size: 0x1000,
    bus: "System",
    description: "SPI flash interface 1 (ESP32-C)",
  },
  {
    name: "SPI0",
    base: 0x60003000n,
    size: 0x1000,
    bus: "System",
    description: "SPI memory interface 0 (ESP32-C)",
  },
  {
    name: "GPIO",
    base: 0x60004000n,
    size: 0x1000,
    bus: "System",
    description: "General purpose I/O controller (ESP32-C)",
  },
  {
    name: "RTC_CNTL",
    base: 0x60008000n,
    size: 0x1000,
    bus: "RTC",
    description: "Real-time clock controller (ESP32-C)",
  },
  {
    name: "IO_MUX",
    base: 0x60009000n,
    size: 0x1000,
    bus: "System",
    description: "Pin multiplexer control (ESP32-C)",
  },
  {
    name: "I2C0",
    base: 0x60013000n,
    size: 0x1000,
    bus: "System",
    description: "Inter-integrated circuit 0 (ESP32-C)",
  },
  {
    name: "TIMG0",
    base: 0x6001f000n,
    size: 0x1000,
    bus: "System",
    description: "Timer Group 0 (ESP32-C)",
  },
  {
    name: "TIMG1",
    base: 0x60020000n,
    size: 0x1000,
    bus: "System",
    description: "Timer Group 1 (ESP32-C)",
  },
  {
    name: "SYSTIMER",
    base: 0x60023000n,
    size: 0x1000,
    bus: "System",
    description: "System timer (ESP32-C)",
  },
  {
    name: "UART1",
    base: 0x6002e000n,
    size: 0x1000,
    bus: "System",
    description: "Universal asynchronous receiver transmitter 1 (ESP32-C)",
  },
  {
    name: "SYSTEM",
    base: 0x600c0000n,
    size: 0x1000,
    bus: "System",
    description: "System and clock control registers (ESP32-C)",
  },
];

const PLATFORM_PERIPHERALS: Record<
  SocPlatform,
  readonly InternalPeripheralEntry[]
> = {
  stm32f1: STM32F1_PERIPHERALS,
  stm32f4: STM32F4_PERIPHERALS,
  gd32f1: GD32F1_PERIPHERALS,
  esp32: ESP32_PERIPHERALS,
};

/** CPU families whose memory maps can contain each catalog. */
const PLATFORM_CPU: Record<SocPlatform, readonly HardwareArchitecture[]> = {
  stm32f1: ["arm", "cortex-m"],
  stm32f4: ["arm", "cortex-m"],
  gd32f1: ["arm", "cortex-m"],
  esp32: ["riscv"],
};

const HEX_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{1,16}$/u;

/**
 * Resolve an address to a known SoC peripheral controller block on a given platform.
 *
 * Returns null if the address does not match any peripheral block in the platform dictionary,
 * faithfully preserving unknown facts.
 */
export const lookupSocPeripheral = (
  rawAddress: string | bigint,
  platform: SocPlatform,
): SocPeripheralDefinition | null => {
  let addressBigInt: bigint;
  if (typeof rawAddress === "bigint") {
    addressBigInt = rawAddress;
  } else if (
    typeof rawAddress === "string" &&
    HEX_ADDRESS_PATTERN.test(rawAddress)
  ) {
    try {
      addressBigInt = BigInt(rawAddress);
    } catch {
      return null;
    }
  } else {
    return null;
  }

  const entries = PLATFORM_PERIPHERALS[platform];
  if (!entries || entries.length === 0) return null;

  for (const item of entries) {
    if (
      addressBigInt >= item.base &&
      addressBigInt < item.base + BigInt(item.size)
    ) {
      return {
        platform,
        name: item.name,
        baseAddress: `0x${item.base.toString(16)}`,
        baseAddressValue: item.base,
        sizeBytes: item.size,
        bus: item.bus,
        description: item.description,
      };
    }
  }

  return null;
};

/** Candidate SoC platform matching evaluation. */
export interface SocPlatformMatchCandidate {
  readonly platform: SocPlatform;
  readonly matchedCount: number;
  readonly totalAddresses: number;
  readonly confidence: number; // 0.0 to 1.0
  readonly matchedPeripherals: readonly string[];
}

/**
 * Rank SoC catalogs against observed addresses.
 *
 * Catalogs whose CPU does not match `architecture` are ignored. Confidence
 * uses only addresses that hit a compatible catalog, so code and SRAM
 * references do not dilute a single peripheral hit. Callers must not treat
 * the first row as a decision when several catalogs share that match count.
 */
export const detectSocPlatform = (
  addresses: readonly string[],
  architecture?: HardwareArchitecture,
): readonly SocPlatformMatchCandidate[] => {
  const platforms =
    architecture === undefined
      ? SOC_PLATFORMS
      : SOC_PLATFORMS.filter((platform) =>
          PLATFORM_CPU[platform].includes(architecture),
        );
  if (addresses.length === 0 || platforms.length === 0) return [];

  const hits = new Map<SocPlatform, { count: number; names: Set<string> }>(
    platforms.map((platform) => [platform, { count: 0, names: new Set() }]),
  );
  let relevantAddresses = 0;

  for (const address of addresses) {
    let relevant = false;
    for (const platform of platforms) {
      const match = lookupSocPeripheral(address, platform);
      const bucket = hits.get(platform);
      if (match === null || bucket === undefined) continue;
      relevant = true;
      bucket.count += 1;
      bucket.names.add(match.name);
    }
    if (relevant) relevantAddresses += 1;
  }

  if (relevantAddresses === 0) return [];

  const candidates: SocPlatformMatchCandidate[] = [];
  for (const platform of platforms) {
    const bucket = hits.get(platform);
    if (bucket === undefined || bucket.count === 0) continue;
    candidates.push({
      platform,
      matchedCount: bucket.count,
      totalAddresses: relevantAddresses,
      confidence: Number((bucket.count / relevantAddresses).toFixed(3)),
      matchedPeripherals: Array.from(bucket.names).sort(),
    });
  }

  return candidates.sort(
    (left, right) => right.matchedCount - left.matchedCount,
  );
};
