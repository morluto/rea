import { z } from "zod";
import type { HardwareArchitecture } from "./hardwareMemoryMap.js";

/** Supported microcontroller and SoC platform families. */
export const SOC_PLATFORMS = [
  "stm32f1",
  "stm32f4",
  "gd32f1",
  "gd32f4",
  "rp2040",
  "esp32",
  "esp32c2",
  "esp32c3",
  "esp32c6",
  "esp32h2",
] as const;
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
  | "APB"
  | "AHBL"
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
    "APB",
    "AHBL",
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
    name: "TIMER3",
    base: 0x40000800n,
    size: 0x400,
    bus: "APB1",
    description: "General purpose timer 3 (TIM4 equivalent)",
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
    name: "USART2",
    base: 0x40004800n,
    size: 0x400,
    bus: "APB1",
    description:
      "Universal synchronous asynchronous receiver transmitter 2 (USART3 equivalent)",
  },
  {
    name: "I2C0",
    base: 0x40005400n,
    size: 0x400,
    bus: "APB1",
    description: "Inter-integrated circuit 0 (I2C1 equivalent)",
  },
  {
    name: "I2C1",
    base: 0x40005800n,
    size: 0x400,
    bus: "APB1",
    description: "Inter-integrated circuit 1 (I2C2 equivalent)",
  },
  {
    name: "CAN0",
    base: 0x40006400n,
    size: 0x400,
    bus: "APB1",
    description: "Controller area network 0 (CAN1 equivalent)",
  },
  {
    name: "PMU",
    base: 0x40007000n,
    size: 0x400,
    bus: "APB1",
    description: "Power management unit (PWR equivalent)",
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
    name: "GPIOD",
    base: 0x40011400n,
    size: 0x400,
    bus: "APB2",
    description: "General purpose I/O port D",
  },
  {
    name: "ADC0",
    base: 0x40012400n,
    size: 0x400,
    bus: "APB2",
    description: "Analog-to-digital converter 0 (ADC1 equivalent)",
  },
  {
    name: "ADC1",
    base: 0x40012800n,
    size: 0x400,
    bus: "APB2",
    description: "Analog-to-digital converter 1 (ADC2 equivalent)",
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
    name: "DMA1",
    base: 0x40020400n,
    size: 0x400,
    bus: "AHB",
    description: "Direct memory access controller 1 (DMA2 equivalent)",
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
  {
    name: "CRC",
    base: 0x40023000n,
    size: 0x400,
    bus: "AHB",
    description: "CRC calculation unit",
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

// GD32F4xx names from GigaDevice gd32f4xx.h (firmware library V2.1.0,
// 2020-09-30) and the SPL instance macros. Shared bases match the STM32F4
// windows, so one of those addresses cannot select only one family.
// CTC is a GD32F4 window (CTC_BASE); it is not an STM32F4 window.
const GD32F4_NAME: Record<string, string> = {
  TIM2: "TIMER1",
  TIM3: "TIMER2",
  TIM4: "TIMER3",
  TIM5: "TIMER4",
  TIM6: "TIMER5",
  TIM7: "TIMER6",
  TIM12: "TIMER11",
  TIM13: "TIMER12",
  TIM14: "TIMER13",
  RTC: "RTC",
  WWDG: "WWDGT",
  IWDG: "FWDGT",
  I2S2ext: "I2S1_ADD",
  SPI2: "SPI1",
  SPI3: "SPI2",
  I2S3ext: "I2S2_ADD",
  USART2: "USART1",
  USART3: "USART2",
  UART4: "UART3",
  UART5: "UART4",
  I2C1: "I2C0",
  I2C2: "I2C1",
  I2C3: "I2C2",
  CAN1: "CAN0",
  CAN2: "CAN1",
  PWR: "PMU",
  DAC: "DAC",
  TIM1: "TIMER0",
  TIM8: "TIMER7",
  USART1: "USART0",
  USART6: "USART5",
  ADC1_3: "ADC",
  SDIO: "SDIO",
  SPI1: "SPI0",
  SYSCFG: "SYSCFG",
  EXTI: "EXTI",
  TIM9: "TIMER8",
  TIM10: "TIMER9",
  TIM11: "TIMER10",
  GPIOA: "GPIOA",
  GPIOB: "GPIOB",
  GPIOC: "GPIOC",
  GPIOD: "GPIOD",
  GPIOE: "GPIOE",
  GPIOF: "GPIOF",
  GPIOG: "GPIOG",
  GPIOH: "GPIOH",
  GPIOI: "GPIOI",
  CRC: "CRC",
  RCC: "RCU",
  Flash_IF: "FMC",
  DMA1: "DMA0",
  DMA2: "DMA1",
  ETH: "ENET",
  USB_OTG_HS: "USBHS",
  USB_OTG_FS: "USBFS",
  DCMI: "DCI",
  RNG: "TRNG",
  FSMC: "EXMC",
};

const gd32F4Window = (
  entry: InternalPeripheralEntry,
): InternalPeripheralEntry => {
  const name = GD32F4_NAME[entry.name];
  if (name === undefined) {
    throw new Error(`GD32F4 has no name for the shared ${entry.name} window`);
  }
  return {
    ...entry,
    name,
    description:
      name === entry.name
        ? entry.description
        : `${entry.description}; the GD32F4 manual calls this ${name}`,
  };
};

// RP2040 blocks from pico-sdk addressmap.h. APB bases are 0x4000 apart, and
// that header places the atomic alias pages at bit 12, so a free slot is
// 0x4000 bytes. A slot that intersects an STM32 or GD32 window is omitted.
const RP2040_SLOT = 0x4000;
const rp2040Block = (
  name: string,
  base: bigint,
  bus: PeripheralBusKind,
  description: string,
  size = RP2040_SLOT,
): InternalPeripheralEntry => ({
  name,
  base,
  size,
  bus,
  description,
});

const RP2040_PERIPHERALS: readonly InternalPeripheralEntry[] = [
  rp2040Block("CLOCKS", 0x40008000n, "APB", "Clock control register block"),
  rp2040Block("RESETS", 0x4000c000n, "APB", "Reset control register block"),
  rp2040Block("IO_QSPI", 0x40018000n, "APB", "QSPI I/O register block"),
  rp2040Block(
    "PADS_BANK0",
    0x4001c000n,
    "APB",
    "Pad control register block for bank 0",
  ),
  rp2040Block("PLL_USB", 0x4002c000n, "APB", "USB PLL register block"),
  rp2040Block(
    "BUSCTRL",
    0x40030000n,
    "APB",
    "Bus fabric control register block",
  ),
  rp2040Block("UART0", 0x40034000n, "APB", "UART register block"),
  rp2040Block("UART1", 0x40038000n, "APB", "UART register block"),
  rp2040Block("SPI0", 0x4003c000n, "APB", "SPI register block"),
  rp2040Block(
    "USBCTRL_REGS",
    0x50110000n,
    "AHBL",
    "USB FS/LS controller device registers",
  ),
  rp2040Block("PIO0", 0x50200000n, "AHBL", "Programmable IO block"),
  rp2040Block("PIO1", 0x50300000n, "AHBL", "Programmable IO block"),
  rp2040Block("SIO", 0xd0000000n, "APB", "Single-cycle IO block", 0x180),
];

const GD32F4_PERIPHERALS: readonly InternalPeripheralEntry[] = [
  ...STM32F4_PERIPHERALS.map(gd32F4Window),
  {
    name: "CTC",
    base: 0x40006c00n,
    size: 0x400,
    bus: "APB1",
    description:
      "Clock trim controller. GD32F4xx CTC_BASE; the next header base is PMU",
  },
];

// Espressif ESP32 series peripheral memory map (ESP32 Technical Reference Manual).
const ESP32_PERIPHERALS: readonly InternalPeripheralEntry[] = [
  {
    name: "DPORT",
    base: 0x3ff00000n,
    size: 0x1000,
    bus: "DPort",
    description: "System control registers, clock gating, and peripheral reset",
  },
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
    size: 0x400,
    bus: "RTC",
    description: "Real-time clock and power control",
  },
  {
    name: "RTCIO",
    base: 0x3ff48400n,
    size: 0x400,
    bus: "RTC",
    description: "Low-power I/O controller",
  },
  {
    name: "SENS",
    base: 0x3ff48800n,
    size: 0x400,
    bus: "RTC",
    description: "SAR ADC and sensor control",
  },
  {
    name: "RTC_I2C",
    base: 0x3ff48c00n,
    size: 0x400,
    bus: "RTC",
    description: "Low-power I2C controller",
  },
  {
    name: "IO_MUX",
    base: 0x3ff49000n,
    size: 0x1000,
    bus: "DPort",
    description: "Pin multiplexer and drive capability control",
  },
  {
    name: "UHCI0",
    base: 0x3ff4c000n,
    size: 0x1000,
    bus: "DPort",
    description: "UART host controller interface 0",
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
    base: 0x3ff50000n,
    size: 0x1000,
    bus: "DPort",
    description: "Universal asynchronous receiver transmitter 1",
  },
  {
    name: "UART2",
    base: 0x3ff6e000n,
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
    name: "SYSTEM",
    base: 0x600c0000n,
    size: 0x1000,
    bus: "System",
    description: "System and clock control registers (ESP32-C)",
  },
];

// ESP32-C3 bases from esp-idf soc/esp32c3/register/soc/reg_base.h.
// Windows already recorded on esp32 stay here too, so a shared address cannot
// select only one family. UART1 and USB_SERIAL_JTAG are C3 bases the esp32
// catalog does not own.
const ESP32C3_PERIPHERALS: readonly InternalPeripheralEntry[] = [
  {
    name: "UART0",
    base: 0x60000000n,
    size: 0x1000,
    bus: "System",
    description: "UART register block. DR_REG_UART_BASE",
  },
  {
    name: "SPI1",
    base: 0x60002000n,
    size: 0x1000,
    bus: "System",
    description: "SPI1 register block. DR_REG_SPI1_BASE",
  },
  {
    name: "SPI0",
    base: 0x60003000n,
    size: 0x1000,
    bus: "System",
    description: "SPI0 register block. DR_REG_SPI0_BASE",
  },
  {
    name: "GPIO",
    base: 0x60004000n,
    size: 0x1000,
    bus: "System",
    description: "GPIO register block. DR_REG_GPIO_BASE",
  },
  {
    name: "RTCCNTL",
    base: 0x60008000n,
    size: 0x800,
    bus: "RTC",
    description:
      "RTC control register block. DR_REG_RTCCNTL_BASE; the next header base is EFUSE",
  },
  {
    name: "EFUSE",
    base: 0x60008800n,
    size: 0x800,
    bus: "System",
    description:
      "eFuse register block. DR_REG_EFUSE_BASE; the next header base is IO_MUX",
  },
  {
    name: "IO_MUX",
    base: 0x60009000n,
    size: 0x1000,
    bus: "System",
    description: "IO mux register block. DR_REG_IO_MUX_BASE",
  },
  {
    name: "UART1",
    base: 0x60010000n,
    size: 0x1000,
    bus: "System",
    description: "UART1 register block. DR_REG_UART1_BASE",
  },
  {
    name: "I2C0",
    base: 0x60013000n,
    size: 0x1000,
    bus: "System",
    description: "I2C register block. DR_REG_I2C_EXT_BASE",
  },
  {
    name: "TIMG0",
    base: 0x6001f000n,
    size: 0x1000,
    bus: "System",
    description: "Timer group 0. DR_REG_TIMERGROUP0_BASE",
  },
  {
    name: "TIMG1",
    base: 0x60020000n,
    size: 0x1000,
    bus: "System",
    description: "Timer group 1. DR_REG_TIMERGROUP1_BASE",
  },
  {
    name: "SYSTIMER",
    base: 0x60023000n,
    size: 0x1000,
    bus: "System",
    description: "System timer. DR_REG_SYSTIMER_BASE",
  },
  {
    name: "SPI2",
    base: 0x60024000n,
    size: 0x1000,
    bus: "System",
    description: "SPI2 register block. DR_REG_SPI2_BASE",
  },
  {
    name: "SYSTEM",
    base: 0x600c0000n,
    size: 0x1000,
    bus: "System",
    description: "System register block. DR_REG_SYSTEM_BASE",
  },
  {
    name: "SENSITIVE",
    base: 0x600c1000n,
    size: 0x1000,
    bus: "System",
    description: "Sensitive register block. DR_REG_SENSITIVE_BASE",
  },
  {
    name: "USB_SERIAL_JTAG",
    base: 0x60043000n,
    size: 0x1000,
    bus: "System",
    description: "USB serial JTAG. DR_REG_USB_SERIAL_JTAG_BASE",
  },
];

// ESP32-C6 bases from esp-idf soc/esp32c6/register/soc/reg_base.h.
// A page already recorded for esp32 or esp32c3 is recorded here too, so that
// address cannot select only one family. UART1, USB_SERIAL_JTAG, and LP_UART
// use C6 bases those catalogs do not own. Chip id 0x000D is riscv.
const ESP32C6_PERIPHERALS: readonly InternalPeripheralEntry[] = [
  {
    name: "UART0",
    base: 0x60000000n,
    size: 0x1000,
    bus: "System",
    description: "UART register block. DR_REG_UART_BASE",
  },
  {
    name: "UART1",
    base: 0x60001000n,
    size: 0x1000,
    bus: "System",
    description: "UART1 register block. DR_REG_UART1_BASE",
  },
  {
    name: "SPI0",
    base: 0x60002000n,
    size: 0x1000,
    bus: "System",
    description: "SPI0 register block. DR_REG_SPI0_BASE",
  },
  {
    name: "SPI1",
    base: 0x60003000n,
    size: 0x1000,
    bus: "System",
    description: "SPI1 register block. DR_REG_SPI1_BASE",
  },
  {
    name: "I2C",
    base: 0x60004000n,
    size: 0x1000,
    bus: "System",
    description: "I2C register block. DR_REG_I2C_EXT_BASE",
  },
  {
    name: "TIMG0",
    base: 0x60008000n,
    size: 0x1000,
    bus: "System",
    description: "Timer group 0. DR_REG_TIMERGROUP0_BASE",
  },
  {
    name: "TIMG1",
    base: 0x60009000n,
    size: 0x1000,
    bus: "System",
    description: "Timer group 1. DR_REG_TIMERGROUP1_BASE",
  },
  {
    name: "USB_SERIAL_JTAG",
    base: 0x6000f000n,
    size: 0x1000,
    bus: "System",
    description: "USB serial JTAG. DR_REG_USB_SERIAL_JTAG_BASE",
  },
  {
    name: "INTMTX",
    base: 0x60010000n,
    size: 0x1000,
    bus: "System",
    description: "Interrupt matrix. DR_REG_INTMTX_BASE",
  },
  {
    name: "ETM",
    base: 0x60013000n,
    size: 0x1000,
    bus: "System",
    description: "Event task matrix. DR_REG_SOC_ETM_BASE",
  },
  {
    name: "LP_UART",
    base: 0x600b1400n,
    size: 0x400,
    bus: "System",
    description:
      "Low-power UART. DR_REG_LP_UART_BASE; the next header base is LP_I2C",
  },
  {
    name: "TRACE",
    base: 0x600c0000n,
    size: 0x1000,
    bus: "System",
    description: "Trace register block. DR_REG_TRACE_BASE",
  },
];

// ESP32-C2 bases from esp-idf soc/esp32c2/register/soc/reg_base.h.
// Pages already recorded for another RISC-V ESP catalog are recorded here too,
// so a shared address cannot select only one family. I2C_MST is a C2 base
// those catalogs do not own. Chip id 0x000C is riscv.
const ESP32C2_PERIPHERALS: readonly InternalPeripheralEntry[] = [
  {
    name: "UART0",
    base: 0x60000000n,
    size: 0x1000,
    bus: "System",
    description: "UART register block. DR_REG_UART_BASE",
  },
  {
    name: "SPI1",
    base: 0x60002000n,
    size: 0x1000,
    bus: "System",
    description: "SPI1 register block. DR_REG_SPI1_BASE",
  },
  {
    name: "SPI0",
    base: 0x60003000n,
    size: 0x1000,
    bus: "System",
    description: "SPI0 register block. DR_REG_SPI0_BASE",
  },
  {
    name: "GPIO",
    base: 0x60004000n,
    size: 0x1000,
    bus: "System",
    description: "GPIO register block. DR_REG_GPIO_BASE",
  },
  {
    name: "RTCCNTL",
    base: 0x60008000n,
    size: 0x800,
    bus: "RTC",
    description:
      "RTC control register block. DR_REG_RTCCNTL_BASE; the next header base is EFUSE",
  },
  {
    name: "EFUSE",
    base: 0x60008800n,
    size: 0x800,
    bus: "System",
    description:
      "eFuse register block. DR_REG_EFUSE_BASE; the next header base is IO_MUX",
  },
  {
    name: "IO_MUX",
    base: 0x60009000n,
    size: 0x1000,
    bus: "System",
    description: "IO mux register block. DR_REG_IO_MUX_BASE",
  },
  {
    name: "UART1",
    base: 0x60010000n,
    size: 0x1000,
    bus: "System",
    description: "UART1 register block. DR_REG_UART1_BASE",
  },
  {
    name: "I2C0",
    base: 0x60013000n,
    size: 0x1000,
    bus: "System",
    description: "I2C register block. DR_REG_I2C_EXT_BASE",
  },
  {
    name: "TIMG0",
    base: 0x6001f000n,
    size: 0x1000,
    bus: "System",
    description: "Timer group 0. DR_REG_TIMERGROUP0_BASE",
  },
  {
    name: "SYSTIMER",
    base: 0x60023000n,
    size: 0x1000,
    bus: "System",
    description: "System timer. DR_REG_SYSTIMER_BASE",
  },
  {
    name: "SPI2",
    base: 0x60024000n,
    size: 0x1000,
    bus: "System",
    description: "SPI2 register block. DR_REG_SPI2_BASE",
  },
  {
    name: "I2C_MST",
    base: 0x6004e800n,
    size: 0x1000,
    bus: "System",
    description: "I2C master register block. DR_REG_I2C_MST_BASE",
  },
  {
    name: "SYSTEM",
    base: 0x600c0000n,
    size: 0x1000,
    bus: "System",
    description: "System register block. DR_REG_SYSTEM_BASE",
  },
  {
    name: "SENSITIVE",
    base: 0x600c1000n,
    size: 0x1000,
    bus: "System",
    description: "Sensitive register block. DR_REG_SENSITIVE_BASE",
  },
];

// ESP32-H2 bases from esp-idf soc/esp32h2/register/soc/reg_base.h.
// Pages already recorded for another RISC-V ESP catalog are recorded here too,
// so a shared address cannot select only one family. ECDSA is an H2 base those
// catalogs do not own. Chip id 0x0010 is riscv. INTMTX and TRACE stay one page
// so the following gap is not claimed.
const ESP32H2_PERIPHERALS: readonly InternalPeripheralEntry[] = [
  {
    name: "UART0",
    base: 0x60000000n,
    size: 0x1000,
    bus: "System",
    description: "UART register block. DR_REG_UART_BASE",
  },
  {
    name: "UART1",
    base: 0x60001000n,
    size: 0x1000,
    bus: "System",
    description: "UART1 register block. DR_REG_UART1_BASE",
  },
  {
    name: "SPI0",
    base: 0x60002000n,
    size: 0x1000,
    bus: "System",
    description: "SPI0 register block. DR_REG_SPI0_BASE",
  },
  {
    name: "SPI1",
    base: 0x60003000n,
    size: 0x1000,
    bus: "System",
    description: "SPI1 register block. DR_REG_SPI1_BASE",
  },
  {
    name: "I2C0",
    base: 0x60004000n,
    size: 0x1000,
    bus: "System",
    description: "I2C register block. DR_REG_I2C_EXT0_BASE",
  },
  {
    name: "LEDC",
    base: 0x60008000n,
    size: 0x1000,
    bus: "System",
    description: "LED controller. DR_REG_LEDC_BASE",
  },
  {
    name: "TIMG0",
    base: 0x60009000n,
    size: 0x1000,
    bus: "System",
    description: "Timer group 0. DR_REG_TIMERGROUP0_BASE",
  },
  {
    name: "USB_SERIAL_JTAG",
    base: 0x6000f000n,
    size: 0x1000,
    bus: "System",
    description: "USB serial JTAG. DR_REG_USB_SERIAL_JTAG_BASE",
  },
  {
    name: "INTMTX",
    base: 0x60010000n,
    size: 0x1000,
    bus: "System",
    description: "Interrupt matrix. DR_REG_INTMTX_BASE",
  },
  {
    name: "ETM",
    base: 0x60013000n,
    size: 0x1000,
    bus: "System",
    description: "Event task matrix. DR_REG_SOC_ETM_BASE",
  },
  {
    name: "ECDSA",
    base: 0x6008e000n,
    size: 0x1000,
    bus: "System",
    description: "ECDSA register block. DR_REG_ECDSA_BASE",
  },
  {
    name: "TRACE",
    base: 0x600c0000n,
    size: 0x1000,
    bus: "System",
    description: "Trace register block. DR_REG_TRACE_BASE",
  },
];

const PLATFORM_PERIPHERALS: Record<
  SocPlatform,
  readonly InternalPeripheralEntry[]
> = {
  stm32f1: STM32F1_PERIPHERALS,
  stm32f4: STM32F4_PERIPHERALS,
  gd32f1: GD32F1_PERIPHERALS,
  gd32f4: GD32F4_PERIPHERALS,
  rp2040: RP2040_PERIPHERALS,
  esp32: ESP32_PERIPHERALS,
  esp32c2: ESP32C2_PERIPHERALS,
  esp32c3: ESP32C3_PERIPHERALS,
  esp32c6: ESP32C6_PERIPHERALS,
  esp32h2: ESP32H2_PERIPHERALS,
};

/** CPU families whose memory maps can contain each catalog. */
const PLATFORM_CPU: Record<SocPlatform, readonly HardwareArchitecture[]> = {
  stm32f1: ["arm", "cortex-m"],
  stm32f4: ["arm", "cortex-m"],
  gd32f1: ["arm", "cortex-m"],
  gd32f4: ["arm", "cortex-m"],
  rp2040: ["arm", "cortex-m"],
  esp32: ["riscv"],
  esp32c2: ["riscv"],
  esp32c3: ["riscv"],
  esp32c6: ["riscv"],
  esp32h2: ["riscv"],
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
