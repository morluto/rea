import { z } from "zod";

/**
 * One controller address a driver function or its device record actually contains.
 * The controller name comes from the chip manual window for that address.
 */
export interface ObservedDriverAddress {
  readonly site: string;
  readonly address: string;
  readonly controller: string;
}

/** Peripherals recovered by reading one driver's instructions, not the BSP text. */
export interface DriverPeripheralRecovery {
  readonly driverId: string;
  readonly functionAddress: string | null;
  readonly addresses: readonly ObservedDriverAddress[];
  readonly detail: string;
}

const observedDriverAddressSchema = z.strictObject({
  site: z.string(),
  address: z.string(),
  controller: z.string(),
});

export const driverPeripheralRecoverySchema = z.strictObject({
  driverId: z.string(),
  functionAddress: z.string().nullable(),
  addresses: z.array(observedDriverAddressSchema),
  detail: z.string(),
});

const hit = (
  site: string,
  address: string,
  controller: string,
): ObservedDriverAddress => ({ site, address, controller });

const recovery = (
  driverId: string,
  functionAddress: string | null,
  addresses: readonly ObservedDriverAddress[],
  detail: string,
): DriverPeripheralRecovery => ({
  driverId,
  functionAddress,
  addresses,
  detail,
});

/**
 * Recovered from the captured RT-Spark image.
 * Addresses below were loaded by the named function or stored in its device record.
 */
export const RT_SPARK_DRIVER_RECOVERIES: readonly DriverPeripheralRecovery[] = [
  recovery(
    "clock",
    "0x0800e294",
    [
      hit("0x0800e29e", "0x40020000", "GPIOA"),
      hit("0x0800e2a6", "0x40020400", "GPIOB"),
      hit("0x0800e2ae", "0x40020800", "GPIOC"),
      hit("0x0800e2b6", "0x40020c00", "GPIOD"),
      hit("0x0800e2be", "0x40021000", "GPIOE"),
      hit("0x0800e2c6", "0x40021400", "GPIOF"),
      hit("0x0800e2ce", "0x40021800", "GPIOG"),
      hit("0x0800e2d6", "0x40021c00", "GPIOH"),
      hit("0x0800e2de", "0x40022000", "GPIOI"),
      hit("0x0800e344", "0x40023800", "RCC"),
    ],
    "The clock function loads every GPIO port base and the RCC base.",
  ),
  recovery(
    "pin",
    "0x08073c94",
    [hit("0x08073d06", "0x40020000", "GPIOA")],
    "This address is the GPIO decode origin. The port is the pin index shifted by 4, with a stride of 0x400.",
  ),
  recovery(
    "serial-usart1",
    "0x0800e244",
    [
      hit("0x0800e252", "0x40011000", "USART1"),
      hit("0x0800e25c", "0x40023800", "RCC"),
      hit("0x08012fcc", "0x40011000", "USART1"),
    ],
    "The uart1 device record stores USART1. The following string in that record is PA9. A neighboring constant at 0x0800c5c8 is USART6 and is not this device.",
  ),
  recovery(
    "serial-uart2",
    null,
    [],
    "The image contains the name uart2 and no aligned USART2 address.",
  ),
  recovery(
    "pwm",
    null,
    [
      hit("0x08012ef0", "0x40000400", "TIM3"),
      hit("0x08012f7c", "0x40000800", "TIM4"),
    ],
    "The device records name these bases timer3 and pwm4. The pwm init function does not load TIM14.",
  ),
  recovery(
    "spi-flash",
    "0x080604e4",
    [
      hit("0x080604ec", "0x40023830", "RCC"),
      hit("0x08060508", "0x40020400", "GPIOB"),
    ],
    "The init function passes the bus name spi2 to the attach helper. It does not load the SPI2 address.",
  ),
  recovery(
    "rw007",
    "0x0807ac3c",
    [hit("0x0807ac40", "0x40021400", "GPIOF")],
    "The function shifts that GPIOF base by 20 to make mask 0x400, then passes the names spi2 and wspi to the same attach helper.",
  ),
  recovery(
    "sdio",
    "0x0805fb40",
    [
      hit("0x0805fb44", "0x40012c00", "SDIO"),
      hit("0x0805fb4a", "0x40023830", "RCC"),
    ],
    "The function writes RCC AHB1ENR with a mask taken from a RAM object, not from an immediate.",
  ),
  recovery(
    "i2c-bus",
    "0x0805f864",
    [],
    "The init function calls the pin driver with indexes stored in a RAM object. The image has no aligned I2C1, I2C2, or I2C3 address.",
  ),
  recovery(
    "can",
    "0x0805f2e0",
    [],
    "The examined function loads 0xE000ED0C. The image has no aligned CAN1 or CAN2 address.",
  ),
  recovery(
    "rtc",
    "0x08064648",
    [hit("0x0806466c", "0x40002800", "RTC")],
    "This function stores the RTC base. The rt_hw_rtc_register string site does not load it.",
  ),
  recovery(
    "adc",
    "0x08072db8",
    [
      hit("0x08072e6e", "0x40012000", "ADC1_3"),
      hit("0x08072e88", "0x40012100", "ADC1_3"),
      hit("0x08072ea2", "0x40012200", "ADC1_3"),
    ],
    "The function compares a saved base with these three addresses. Which one is stored is not in the instruction.",
  ),
  recovery(
    "usb-device",
    "0x08067f70",
    [],
    "The image has no aligned USB OTG FS or HS address.",
  ),
  recovery(
    "lcd",
    null,
    [],
    "The image has the drv_lcd.c string and no aligned FSMC address.",
  ),
  recovery(
    "rs485",
    null,
    [],
    "The rs485_test string was not tied to the USART6 constant at 0x0800c5c8.",
  ),
];
