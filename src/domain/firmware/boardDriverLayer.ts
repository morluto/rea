import { z } from "zod";

/**
 * SHA-256 of the RT-Spark flash read at 0x08000000, length 1048576.
 * Driver linkage below is string presence in that image, not boot-time enablement.
 */
export const RT_SPARK_FLASH_IMAGE_SHA256 =
  "e2c7d06f5c3a9c0e12e220dcd7335110b447bce2310263ad668c1729ed828776";

export const DRIVER_LINKAGES = ["linked_in_image", "not_observed"] as const;
export type DriverLinkage = (typeof DRIVER_LINKAGES)[number];

/**
 * One software driver above the board devices. Controllers are SoC register
 * blocks. An empty controller list means the image did not name an instance.
 */
export interface BoardDriver {
  readonly id: string;
  readonly name: string;
  readonly controllers: readonly string[];
  readonly deviceIds: readonly string[];
  readonly linkage: DriverLinkage;
  readonly evidence: string;
}

export const boardDriverSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  controllers: z.array(z.string()),
  deviceIds: z.array(z.string()),
  linkage: z.enum(DRIVER_LINKAGES),
  evidence: z.string(),
});

const image = (detail: string): string =>
  `Image ${RT_SPARK_FLASH_IMAGE_SHA256}: ${detail}`;

const linked = (
  id: string,
  name: string,
  controllers: readonly string[],
  deviceIds: readonly string[],
  detail: string,
): BoardDriver => ({
  id,
  name,
  controllers,
  deviceIds,
  linkage: "linked_in_image",
  evidence: image(detail),
});

const absent = (
  id: string,
  name: string,
  controllers: readonly string[],
  deviceIds: readonly string[],
  detail: string,
): BoardDriver => ({
  id,
  name,
  controllers,
  deviceIds,
  linkage: "not_observed",
  evidence: image(detail),
});

/** Drivers for the captured RT-Spark image, grouped above the BSP device list. */
export const RT_SPARK_DRIVERS: readonly BoardDriver[] = [
  linked(
    "clock",
    "STM32 clock",
    ["RCC"],
    [],
    "contains ../drivers/drv_clk.c and stm32_gpio_clk_enable.",
  ),
  linked(
    "pin",
    "GPIO pin",
    ["GPIOC", "GPIOF"],
    ["led-r", "led-b", "key-up", "key-down", "key-left", "key-right"],
    "contains rt_pin_mode, _pin_read, and _pin_write. A port match still does not identify the pin.",
  ),
  linked(
    "serial-usart1",
    "USART1 console",
    ["USART1"],
    ["usb-uart-com1"],
    "contains uart1, rt_hw_usart_init, and uart_isr.",
  ),
  linked(
    "serial-uart2",
    "UART2 device",
    [],
    ["com2"],
    "contains the device name uart2. The used image has no aligned USART2 address.",
  ),
  linked(
    "pwm",
    "PWM",
    ["TIM3", "TIM4"],
    ["led-matrix", "lcd-backlight"],
    "contains stm32_hw_pwm_init. Device records store TIM3 under the name timer3 and TIM4 under the name pwm4.",
  ),
  linked(
    "spi-flash",
    "SPI flash",
    ["SPI2"],
    ["spi-flash"],
    "contains @spi20, rt_hw_spi_flash_init, spiflash0, the literal W25Q128, and SFUD table names W25Q64CV and W25Q128BV. Those strings do not identify the installed part.",
  ),
  linked(
    "rw007",
    "RW007",
    ["GPIOF"],
    ["rw007"],
    "function 0x0807ac3c loads GPIOF and passes the bus name spi2 to the SPI attach helper. The SPI2 address is not in that function.",
  ),
  linked(
    "fal",
    "FAL",
    [],
    ["spi-flash"],
    "contains fal_init, fal_partition_read, and spi flash mount to '/spiflash'.",
  ),
  linked(
    "sdio",
    "SDIO",
    ["SDIO"],
    ["sd-card"],
    "contains [E/drv.sdio] and rthw_sdio_request.",
  ),
  linked(
    "i2c-bus",
    "I2C bus",
    [],
    [],
    "contains rt_hw_i2c_init. The string does not name I2C1, I2C2, or I2C3.",
  ),
  linked(
    "icm20608",
    "ICM20608",
    ["GPIOF"],
    ["icm20608"],
    "contains icm20608 probe and the ICM20608 name. The BSP pins are software I2C on GPIOF, not an I2C register block.",
  ),
  linked(
    "ap3216c",
    "AP3216C",
    ["GPIOF"],
    ["ap3216c"],
    "contains [E/ap3216c] and ap3216c_init.",
  ),
  linked(
    "rs485",
    "RS485",
    [],
    ["rs485"],
    "contains rs485_test. That string was not tied to the USART6 constant beside USART1.",
  ),
  linked(
    "can",
    "CAN",
    [],
    [],
    "contains rt_hw_can_register and can_sample. The strings do not name CAN1 or CAN2.",
  ),
  linked(
    "rtc",
    "RTC",
    ["RTC"],
    [],
    "contains [E/drv.rtc] and rt_hw_rtc_register.",
  ),
  linked(
    "adc",
    "ADC",
    [],
    [],
    "contains stm32_adc_get_value and [E/drv.adc]. The ADC instance and channel are not named.",
  ),
  linked(
    "usb-device",
    "USB device",
    [],
    ["usb-device"],
    "contains rt_usb_vcom_init and rt_usbd_device_set_controller. OTG_FS versus OTG_HS is not named.",
  ),
  linked(
    "usb-host",
    "USB host",
    [],
    ["usb-host"],
    "contains the class label USB Host Bus. That label does not show an enumerated host port.",
  ),
  linked(
    "lcd",
    "LCD port",
    ["FSMC"],
    ["lcd-st7787"],
    "contains board\\ports\\lcd\\drv_lcd.c. ST7787 remains the BSP part name; this string does not repeat it.",
  ),
  absent(
    "esp8266",
    "ESP8266",
    ["USART3"],
    ["esp8266-at", "com3"],
    "has no esp8266 or uart3 string. The BSP option stays off in this evidence.",
  ),
  absent(
    "enc28j60",
    "ENC28J60",
    ["SPI1"],
    ["enc28j60"],
    "has no enc28 string.",
  ),
  absent(
    "eeprom",
    "I2C EEPROM",
    ["GPIOB"],
    ["i2c-eeprom"],
    "has no eeprom string.",
  ),
  absent(
    "aht21",
    "AHT21",
    ["GPIOE"],
    ["aht21"],
    "contains the bare literal AHT21 beside ICM20608 and no AHT21 init or log tag.",
  ),
  absent(
    "audio",
    "Audio",
    ["GPIOF"],
    ["audio"],
    "has no separate audio-driver string. The BSP still places it on the software I2C2 pins.",
  ),
];

/** Drivers whose controller list includes one of the named register blocks. */
export const boardDriversForControllers = (
  drivers: readonly BoardDriver[],
  controllers: ReadonlySet<string>,
): readonly BoardDriver[] =>
  drivers.filter((driver) =>
    driver.controllers.some((controller) => controllers.has(controller)),
  );
