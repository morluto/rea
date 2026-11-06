import { z } from "zod";
import {
  type HardwareMemoryRegionKind,
  hardwareMemoryRegionKindSchema,
} from "./hardwareMemoryMap.js";
import {
  type BoardDriver,
  boardDriverSchema,
  RT_SPARK_DRIVERS,
} from "./boardDriverLayer.js";
import {
  type SocPlatform,
  socPlatformSchema,
} from "./socPeripheralDatabase.js";

/**
 * Boards whose on-chip controllers and populated devices are recorded here.
 * `stm32f407-rt-spark` is the RT-Thread BSP for the 星火一号 board.
 */
export const BOARD_IDS = ["stm32f407-rt-spark"] as const;
export type BoardId = (typeof BOARD_IDS)[number];
export const boardIdSchema = z.enum(BOARD_IDS);

export const BOARD_DEVICE_KINDS = ["listed_resource", "bsp_option"] as const;
export type BoardDeviceKind = (typeof BOARD_DEVICE_KINDS)[number];

/** A memory window the board BSP or the MCU reference manual actually sizes. */
export interface BoardMemoryWindow {
  readonly id: string;
  readonly name: string;
  readonly kind: HardwareMemoryRegionKind;
  readonly baseAddress: string;
  readonly baseAddressValue: bigint;
  readonly sizeBytes: number;
  readonly evidence: string;
}

/**
 * One device attached to an on-chip controller, or to no controller when the
 * BSP names the device without naming the register block.
 */
export interface BoardDeviceAttachment {
  readonly id: string;
  readonly name: string;
  readonly kind: BoardDeviceKind;
  readonly peripheralName: string | null;
  readonly role: string;
  readonly kconfigDefault: boolean | null;
  readonly pins: readonly string[];
  readonly evidence: string;
  readonly uncertainty?: string;
  /** Part names the board records disagree about. Absent unless that is the open question. */
  readonly partNames?: readonly string[];
}

/** Facts for one known board. Optional devices stay optional. */
export interface BoardPeripheralProfile {
  readonly id: BoardId;
  readonly soc: SocPlatform;
  readonly mcu: string;
  readonly evidence: string;
  readonly memory: readonly BoardMemoryWindow[];
  readonly devices: readonly BoardDeviceAttachment[];
  readonly drivers: readonly BoardDriver[];
  readonly limitations: readonly string[];
}

export const boardDeviceAttachmentSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  kind: z.enum(BOARD_DEVICE_KINDS),
  peripheralName: z.string().nullable(),
  role: z.string(),
  kconfigDefault: z.boolean().nullable(),
  pins: z.array(z.string()),
  evidence: z.string(),
  uncertainty: z.string().optional(),
  partNames: z.array(z.string()).optional(),
});

export const boardMemoryWindowSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  kind: hardwareMemoryRegionKindSchema,
  baseAddress: z.string(),
  baseAddressValue: z.bigint(),
  sizeBytes: z.number().int().positive(),
  evidence: z.string(),
});

export const boardPeripheralProfileSchema = z.strictObject({
  id: boardIdSchema,
  soc: socPlatformSchema,
  mcu: z.string(),
  evidence: z.string(),
  memory: z.array(boardMemoryWindowSchema),
  devices: z.array(boardDeviceAttachmentSchema),
  drivers: z.array(boardDriverSchema),
  limitations: z.array(z.string()),
});

const window = (
  id: string,
  name: string,
  kind: HardwareMemoryRegionKind,
  base: bigint,
  sizeBytes: number,
  evidence: string,
): BoardMemoryWindow => ({
  id,
  name,
  kind,
  baseAddress: `0x${base.toString(16)}`,
  baseAddressValue: base,
  sizeBytes,
  evidence,
});

const RT_SPARK_PROFILE: BoardPeripheralProfile = {
  id: "stm32f407-rt-spark",
  soc: "stm32f4",
  mcu: "STM32F407ZGT6",
  evidence:
    "RT-Thread bsp/stm32/stm32f407-rt-spark README, board/board.h, board/Kconfig, and board/ports/spi_flash_init.c",
  memory: [
    window(
      "internal-flash",
      "STM32F407 internal flash",
      "code",
      0x08000000n,
      1024 * 1024,
      "board.h STM32_FLASH_START_ADRESS 0x08000000 and STM32_FLASH_SIZE (1024 * 1024). README states 1024KB FLASH.",
    ),
    window(
      "ccm",
      "STM32F407 CCM data RAM",
      "sram",
      0x10000000n,
      64 * 1024,
      "RM0090 CCM data RAM for STM32F407 is 64KB at 0x10000000. README states 192KB RAM and board.h defines a 128KB window at 0x20000000; board.h does not name CCM.",
    ),
    window(
      "main-sram",
      "STM32F407 main SRAM",
      "sram",
      0x20000000n,
      128 * 1024,
      "board.h STM32_SRAM_SIZE is 128 and STM32_SRAM_END is 0x20000000 plus that many KiB. The BSP heap ends at this window.",
    ),
  ],
  devices: [
    {
      id: "usb-uart-com1",
      name: "USB-to-UART console",
      kind: "listed_resource",
      peripheralName: "USART1",
      role: "COM1 console at the BSP default",
      kconfigDefault: true,
      pins: [],
      evidence:
        "README lists USB 转串口(COM1) as supported. Kconfig BSP_USING_USB_TO_USART defaults on and selects UART1. The advanced-use section says a stock BSP enables GPIO and UART1.",
    },
    {
      id: "com2",
      name: "COM2",
      kind: "listed_resource",
      peripheralName: "USART2",
      role: "Optional UART2",
      kconfigDefault: false,
      pins: [],
      evidence:
        "README and Kconfig BSP_USING_COM2. The option depends on Ethernet and PWM being off. Pin assignment is not recorded.",
    },
    {
      id: "com3",
      name: "COM3",
      kind: "listed_resource",
      peripheralName: "USART3",
      role: "Optional UART3",
      kconfigDefault: false,
      pins: [],
      evidence:
        "README lists COM3 as supported. Kconfig BSP_USING_COM3 selects UART3 and defaults off.",
    },
    {
      id: "esp8266-at",
      name: "ESP8266 AT client",
      kind: "bsp_option",
      peripheralName: "USART3",
      role: "Optional AT Wi-Fi client on uart3",
      kconfigDefault: false,
      pins: [],
      evidence:
        "Kconfig BSP_USING_AT_ESP8266 selects COM3. The sample client name is uart3. Sample network settings in that option are not a deployed network.",
    },
    {
      id: "rs485",
      name: "RS485",
      kind: "bsp_option",
      peripheralName: "USART6",
      role: "Optional UART6 with RTS",
      kconfigDefault: false,
      pins: ["PG8"],
      evidence:
        "Kconfig BSP_USING_RS485 selects UART6. BSP_RS485_RTS_PIN defaults to 104, which is PG8 under the STM32 pin index (port * 16 + pin).",
    },
    {
      id: "spi-flash",
      name: "SPI flash",
      kind: "listed_resource",
      peripheralName: "SPI2",
      role: "External SPI flash, chip select PB12",
      kconfigDefault: false,
      pins: ["PB12"],
      evidence:
        "README lists an external SPI flash. Kconfig BSP_USING_SPI_FLASH selects SPI2 and defaults off. spi_flash_init.c attaches bus spi2 as device spi20 with chip select GET_PIN(B, 12) and probes SFUD name W25Q64.",
      uncertainty:
        "README calls the part W25Q128 and 16MB. The BSP port probes W25Q64. These sources do not settle the installed part.",
      partNames: ["W25Q128", "W25Q64"],
    },
    {
      id: "rw007",
      name: "RW007 WLAN",
      kind: "bsp_option",
      peripheralName: "SPI2",
      role: "Optional SPI2 Wi-Fi module",
      kconfigDefault: false,
      pins: ["PF10", "PB13", "PG11", "PG15"],
      evidence:
        "Kconfig BSP_USING_RW007_WLAN selects SPI2 and defaults off. CS pin 90 is PF10, BOOT0 pin 29 is PB13, INT/BUSY pin 107 is PG11, RST pin 111 is PG15. SPI max is 30000000.",
      uncertainty:
        "This option selects the same SPI2 controller as the SPI flash port. The BSP does not say both can be enabled together.",
    },
    {
      id: "enc28j60",
      name: "ENC28J60",
      kind: "bsp_option",
      peripheralName: "SPI1",
      role: "Optional SPI Ethernet controller",
      kconfigDefault: false,
      pins: [],
      evidence:
        "Kconfig BSP_USING_ENC28j60 selects SPI1 and defaults off. No chip-select pin is set in that option.",
    },
    {
      id: "sd-card",
      name: "SD card",
      kind: "listed_resource",
      peripheralName: "SDIO",
      role: "SD card socket",
      kconfigDefault: false,
      pins: [],
      evidence:
        "README lists an SD card interface. Kconfig BSP_USING_SDCARD_FATFS selects SDIO and defaults off. SDIO_MAX_FREQ defaults to 1000000 and allows up to 24000000. Pinout is not in the README or Kconfig.",
    },
    {
      id: "led-r",
      name: "LED_R",
      kind: "listed_resource",
      peripheralName: "GPIOF",
      role: "Red LED",
      kconfigDefault: null,
      pins: ["PF12"],
      evidence: "README: LED_R is red on PF12.",
    },
    {
      id: "led-b",
      name: "LED_B",
      kind: "listed_resource",
      peripheralName: "GPIOF",
      role: "LED named LED_B",
      kconfigDefault: null,
      pins: ["PF11"],
      evidence: "README places LED_B on PF11 and describes the color as green.",
      uncertainty:
        "The silkscreen-style name is LED_B and the README color text is green. Both are kept.",
    },
    {
      id: "key-up",
      name: "KEY_UP",
      kind: "listed_resource",
      peripheralName: "GPIOC",
      role: "Wakeup-capable button",
      kconfigDefault: null,
      pins: ["PC5"],
      evidence: "README: KEY_UP, also the wakeup pin, is PC5.",
    },
    {
      id: "key-down",
      name: "KEY_DOWN",
      kind: "listed_resource",
      peripheralName: "GPIOC",
      role: "Button",
      kconfigDefault: null,
      pins: ["PC1"],
      evidence: "README: KEY_DOWN is PC1.",
    },
    {
      id: "key-left",
      name: "KEY_LEFT",
      kind: "listed_resource",
      peripheralName: "GPIOC",
      role: "Button",
      kconfigDefault: null,
      pins: ["PC0"],
      evidence: "README: KEY_LEFT is PC0.",
    },
    {
      id: "key-right",
      name: "KEY_RIGHT",
      kind: "listed_resource",
      peripheralName: "GPIOC",
      role: "Button",
      kconfigDefault: null,
      pins: ["PC4"],
      evidence: "README: KEY_RIGHT is PC4.",
    },
    {
      id: "external-sram",
      name: "External SRAM",
      kind: "bsp_option",
      peripheralName: "FSMC",
      role: "Optional FMC SRAM",
      kconfigDefault: false,
      pins: [],
      evidence:
        "Kconfig BSP_USING_SRAM selects BSP_USING_FMC and defaults off. Bank pins are not in that option.",
    },
    {
      id: "lcd-st7787",
      name: "ST7787 LCD",
      kind: "bsp_option",
      peripheralName: "FSMC",
      role: "Optional LCD on the FMC SRAM interface",
      kconfigDefault: false,
      pins: [],
      evidence:
        "Kconfig BSP_USING_ONBOARD_LCD names the controller ST7787, selects BSP_USING_SRAM, and defaults off. The README resource list does not mention this LCD.",
    },
    {
      id: "lcd-backlight",
      name: "LCD backlight",
      kind: "bsp_option",
      peripheralName: "TIM14",
      role: "PWM14 channel 1 backlight",
      kconfigDefault: false,
      pins: [],
      evidence:
        "BSP_USING_ONBOARD_LCD_PWM_BL defaults on only inside the LCD option, and that option itself defaults off. It selects PWM14 channel 1.",
    },
    {
      id: "led-matrix",
      name: "LED matrix",
      kind: "bsp_option",
      peripheralName: "TIM3",
      role: "PWM3 channel 2",
      kconfigDefault: false,
      pins: [],
      evidence:
        "Kconfig BSP_USING_ONBOARD_LED_MATRIX selects PWM3 channel 2 and defaults off.",
    },
    {
      id: "can1",
      name: "CAN1",
      kind: "bsp_option",
      peripheralName: "CAN1",
      role: "Optional on-board CAN",
      kconfigDefault: false,
      pins: [],
      evidence:
        "Kconfig BSP_USING_CAN1 is inside BSP_USING_CAN and defaults off. No pins are set there.",
    },
    {
      id: "i2c-eeprom",
      name: "I2C EEPROM",
      kind: "bsp_option",
      peripheralName: "GPIOB",
      role: "Software I2C1",
      kconfigDefault: false,
      pins: ["PB8", "PB9"],
      evidence:
        "Kconfig BSP_USING_EEPROM selects software I2C1 and defaults off. SCL pin 24 is PB8 and SDA pin 25 is PB9. This is not the I2C1 register block.",
    },
    {
      id: "aht21",
      name: "AHT21",
      kind: "bsp_option",
      peripheralName: "GPIOE",
      role: "Software I2C3 sensor",
      kconfigDefault: false,
      pins: ["PE0", "PE1"],
      evidence:
        "Kconfig BSP_USING_AHT21 selects software I2C3 and defaults off. SCL pin 64 is PE0 and SDA pin 65 is PE1.",
    },
    {
      id: "ap3216c",
      name: "AP3216C",
      kind: "bsp_option",
      peripheralName: "GPIOF",
      role: "Software I2C2 sensor",
      kconfigDefault: false,
      pins: ["PF1", "PF0"],
      evidence:
        "Kconfig BSP_USING_AP3216C selects software I2C2 and defaults off. SCL pin 81 is PF1 and SDA pin 80 is PF0.",
    },
    {
      id: "icm20608",
      name: "ICM20608",
      kind: "bsp_option",
      peripheralName: "GPIOF",
      role: "Software I2C2 sensor",
      kconfigDefault: false,
      pins: ["PF1", "PF0"],
      evidence:
        "Kconfig BSP_USING_ICM20608 selects software I2C2 and defaults off, on the same pins as AP3216C.",
    },
    {
      id: "audio",
      name: "Audio device",
      kind: "bsp_option",
      peripheralName: "GPIOF",
      role: "Software I2C2 control path",
      kconfigDefault: false,
      pins: ["PF1", "PF0"],
      evidence:
        "Kconfig BSP_USING_AUDIO selects software I2C2 and defaults off. Play defaults on only inside that option. The codec part is not named.",
    },
    {
      id: "usb-device",
      name: "USB device",
      kind: "listed_resource",
      peripheralName: null,
      role: "USB slave",
      kconfigDefault: false,
      pins: [],
      evidence:
        "README lists USB SLAVE. Kconfig BSP_USING_USBD defaults off and does not name OTG_FS or OTG_HS.",
    },
    {
      id: "usb-host",
      name: "USB host",
      kind: "listed_resource",
      peripheralName: null,
      role: "USB host",
      kconfigDefault: false,
      pins: [],
      evidence:
        "README lists USB HOST. Kconfig BSP_USING_USBH defaults off and does not name OTG_FS or OTG_HS.",
    },
  ],
  drivers: RT_SPARK_DRIVERS,
  limitations: [
    "Board devices describe the RT-Thread stm32f407-rt-spark BSP. Drivers above them record strings in one captured flash image. A linked driver is code present in that image, not proof the device is opened during boot.",
    "A GPIO port match means that port hosts the listed pins. It does not identify which pin a given access uses.",
    "EEPROM, AHT21, AP3216C, ICM20608, and the audio control path use software I2C. Accesses to the I2C1, I2C2, or I2C3 register blocks are not those devices.",
    "UART2 shares its pins with Ethernet and PWM. Ethernet pinout and PHY are not in this profile.",
    "The watchdog option does not name IWDG or WWDG.",
    "USB device and host are listed without a controller instance, so they are not attached to USB_OTG_FS or USB_OTG_HS.",
    "BSP_USING_ARDUINO defaults off. Enabling it turns on UART1, UART2, ADC3, DAC1, several PWM channels, software I2C, and software SPI; those pins are not duplicated here.",
  ],
};

const BOARD_PROFILES: Readonly<Record<BoardId, BoardPeripheralProfile>> = {
  "stm32f407-rt-spark": RT_SPARK_PROFILE,
};

/** Return the recorded profile for a known board, or null when the id is unknown. */
export const lookupBoardProfile = (
  board: string,
): BoardPeripheralProfile | null => {
  if (!(BOARD_IDS as readonly string[]).includes(board)) return null;
  return BOARD_PROFILES[board as BoardId];
};

/** Devices whose controller name is the given on-chip peripheral. */
export const boardDevicesForPeripheral = (
  profile: BoardPeripheralProfile,
  peripheralName: string,
): readonly BoardDeviceAttachment[] =>
  profile.devices.filter((device) => device.peripheralName === peripheralName);

/** Devices the BSP names without binding them to a register block. */
export const unboundBoardDevices = (
  profile: BoardPeripheralProfile,
): readonly BoardDeviceAttachment[] =>
  profile.devices.filter((device) => device.peripheralName === null);

/** Memory window containing an address, or null when the address is outside the recorded windows. */
export const lookupBoardMemoryWindow = (
  profile: BoardPeripheralProfile,
  address: bigint,
): BoardMemoryWindow | null => {
  for (const item of profile.memory) {
    const end = item.baseAddressValue + BigInt(item.sizeBytes);
    if (address >= item.baseAddressValue && address < end) return item;
  }
  return null;
};
