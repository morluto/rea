import type { HardwareMemoryRegionKind } from "./hardwareMemoryMap.js";
import type {
  BoardDeviceAttachment,
  BoardMemoryWindow,
  BoardPeripheralProfile,
} from "./boardPeripheralProfile.js";

const memWindow = (
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

const listedDevice = (
  id: string,
  name: string,
  peripheralName: string | null,
  role: string,
  pins: readonly string[],
  evidence: string,
  uncertainty?: string,
): BoardDeviceAttachment => ({
  id,
  name,
  kind: "listed_resource",
  peripheralName,
  role,
  kconfigDefault: null,
  pins,
  evidence,
  ...(uncertainty === undefined ? {} : { uncertainty }),
});

export const STM32F103C8_BLUEPILL_PROFILE: BoardPeripheralProfile = {
  id: "stm32f103c8-bluepill",
  soc: "stm32f1",
  mcu: "STM32F103C8T6",
  imageSha256: null,
  evidence:
    "STM32F103x8 datasheet (DS5319) memory map and standard Blue Pill board schematic (PC13 user LED, 8 MHz HSE, 32.768 kHz LSE).",
  memory: [
    memWindow(
      "internal-flash",
      "STM32F103C8 internal flash",
      "code",
      0x08000000n,
      64 * 1024,
      "DS5319 specifies 64 KiB Flash starting at 0x08000000 for STM32F103x8.",
    ),
    memWindow(
      "main-sram",
      "STM32F103C8 internal SRAM",
      "sram",
      0x20000000n,
      20 * 1024,
      "DS5319 specifies 20 KiB SRAM starting at 0x20000000 for STM32F103x8.",
    ),
  ],
  devices: [
    listedDevice(
      "user-led",
      "PC13 User LED",
      "GPIOC",
      "Active-low onboard user LED",
      ["PC13"],
      "Blue Pill schematic routes the user LED to PC13.",
    ),
    listedDevice(
      "usart1-header",
      "USART1 header",
      "USART1",
      "Default serial boot/debug header on PA9/PA10",
      ["PA9", "PA10"],
      "RM0008 default USART1 TX/RX mapping on PA9/PA10.",
    ),
    listedDevice(
      "usb-fs",
      "Micro-USB FS",
      "USB",
      "Full-speed USB device connector on PA11/PA12",
      ["PA11", "PA12"],
      "Blue Pill routes USB D-/D+ to PA11 and PA12.",
    ),
  ],
  drivers: [],
  driverRecoveries: [],
  imageObservations: null,
  limitations: [
    "GPIOC access indicates port C activity and does not by itself prove PC13 LED toggling.",
    "USART1, SPI1, and I2C1 can be remapped via AFIO_MAPR to alternate pins.",
  ],
};

export const RP2040_PICO_PROFILE: BoardPeripheralProfile = {
  id: "rp2040-pico",
  soc: "rp2040",
  mcu: "RP2040",
  imageSha256: null,
  evidence:
    "Raspberry Pi Pico Datasheet and RP2040 Datasheet (2 MiB W25Q16JV QSPI XIP flash, 264 KiB SRAM, GP25 LED).",
  memory: [
    memWindow(
      "xip-flash",
      "Pico 2 MiB QSPI XIP flash",
      "code",
      0x10000000n,
      2 * 1024 * 1024,
      "Raspberry Pi Pico fits a 2 MiB W25Q16JV flash mapped at XIP base 0x10000000.",
    ),
    memWindow(
      "main-sram",
      "RP2040 264 KiB on-chip SRAM",
      "sram",
      0x20000000n,
      264 * 1024,
      "RP2040 Datasheet Section 2.6.2: 256 KiB striped SRAM0..3 plus 4 KiB SRAM4 and 4 KiB SRAM5 at 0x20000000..0x20041fff.",
    ),
  ],
  devices: [
    listedDevice(
      "onboard-led",
      "GP25 Onboard LED",
      "SIO",
      "Onboard green LED driven via GPIO25",
      ["GPIO25"],
      "Raspberry Pi Pico Datasheet: GP25 drives the onboard LED (Pico W routes the LED to the CYW43439 WL_GPIO0 instead).",
    ),
    listedDevice(
      "qspi-flash",
      "W25Q16JV QSPI flash",
      "IO_QSPI",
      "External 2 MiB XIP flash",
      ["QSPI_SS", "QSPI_SCLK", "QSPI_SD0", "QSPI_SD1", "QSPI_SD2", "QSPI_SD3"],
      "Raspberry Pi Pico schematic connects W25Q16JVUXIQ to dedicated QSPI pins.",
    ),
    listedDevice(
      "default-uart0",
      "Default UART0 console",
      "UART0",
      "pico-sdk default stdio UART0",
      ["GPIO0", "GPIO1"],
      "pico-sdk boards/pico.h sets PICO_DEFAULT_UART=0 on GP0 (TX) and GP1 (RX).",
    ),
  ],
  drivers: [],
  driverRecoveries: [],
  imageObservations: null,
  limitations: [
    "SIO GPIO register accesses cover GPIO0..GPIO29 simultaneously via bitmasks; instruction immediates are needed to isolate GP25.",
  ],
};

export const NRF52840_DK_PROFILE: BoardPeripheralProfile = {
  id: "nrf52840-dk",
  soc: "nrf52",
  mcu: "nRF52840-QIAA",
  imageSha256: null,
  evidence:
    "Nordic nRF52840 DK (PCA10056) Hardware User Guide and nRF52840 Product Specification.",
  memory: [
    memWindow(
      "internal-flash",
      "nRF52840 1 MiB internal flash",
      "code",
      0x00000000n,
      1024 * 1024,
      "nRF52840 Product Specification: 1024 KiB Flash at 0x00000000.",
    ),
    memWindow(
      "code-ram",
      "nRF52840 Code RAM alias",
      "code",
      0x00800000n,
      256 * 1024,
      "nRF52840 Product Specification: 256 KiB RAM mapped to Code space at 0x00800000.",
    ),
    memWindow(
      "main-sram",
      "nRF52840 256 KiB Data RAM",
      "sram",
      0x20000000n,
      256 * 1024,
      "nRF52840 Product Specification: 256 KiB AHB Data RAM at 0x20000000.",
    ),
  ],
  devices: [
    listedDevice(
      "leds-1-4",
      "User LEDs 1..4",
      "P0",
      "Active-low onboard LEDs",
      ["P0.13", "P0.14", "P0.15", "P0.16"],
      "PCA10056 User Guide: LED1..LED4 connect to P0.13..P0.16.",
    ),
    listedDevice(
      "buttons-1-4",
      "User Buttons 1..4",
      "P0",
      "Active-low push buttons",
      ["P0.11", "P0.12", "P0.24", "P0.25"],
      "PCA10056 User Guide: Button 1..4 connect to P0.11, P0.12, P0.24, and P0.25.",
    ),
    listedDevice(
      "vcom-uart",
      "Interface MCU VCOM UART",
      "UARTE0",
      "J-Link OB virtual COM console",
      ["P0.06", "P0.08", "P0.05", "P0.07"],
      "PCA10056 User Guide: TXD=P0.06, RXD=P0.08, RTS=P0.05, CTS=P0.07.",
    ),
    listedDevice(
      "qspi-flash",
      "MX25R6435F 64 Mb QSPI flash",
      "QSPI",
      "Onboard external QSPI NOR flash",
      ["P0.17", "P0.19", "P0.20", "P0.21", "P0.22", "P0.23"],
      "PCA10056 User Guide: 64 Mb external memory connected to QSPI.",
    ),
  ],
  drivers: [],
  driverRecoveries: [],
  imageObservations: null,
  limitations: [
    "nRF52 peripherals route physical pins dynamically through PSEL registers; PCA10056 pins reflect the DK board wiring.",
  ],
};

export const ESP32C3_DEVKITM_1_PROFILE: BoardPeripheralProfile = {
  id: "esp32c3-devkitm-1",
  soc: "esp32c3",
  mcu: "ESP32-C3FN4",
  imageSha256: null,
  evidence:
    "Espressif ESP32-C3-DevKitM-1 User Guide and ESP32-C3 Technical Reference Manual.",
  memory: [
    memWindow(
      "internal-rom",
      "ESP32-C3 384 KiB Internal ROM",
      "code",
      0x40000000n,
      384 * 1024,
      "ESP32-C3 TRM: 384 KiB Internal ROM at 0x40000000..0x4005ffff.",
    ),
    memWindow(
      "internal-sram",
      "ESP32-C3 400 KiB Internal SRAM (DRAM)",
      "sram",
      0x3fc80000n,
      384 * 1024,
      "ESP32-C3 TRM: Data bus SRAM1 mapped at 0x3fc80000..0x3fcdffff.",
    ),
    memWindow(
      "rtc-fast-ram",
      "ESP32-C3 8 KiB RTC FAST Memory",
      "sram",
      0x50000000n,
      8 * 1024,
      "ESP32-C3 TRM: 8 KiB RTC FAST Memory at 0x50000000..0x50001fff.",
    ),
  ],
  devices: [
    listedDevice(
      "usb-uart-bridge",
      "CP2102N USB-to-UART bridge",
      "UART0",
      "Default console and serial download port",
      ["GPIO21", "GPIO20"],
      "ESP32-C3-DevKitM-1 schematic connects U0TXD (GPIO21) and U0RXD (GPIO20) to the USB-to-UART bridge.",
    ),
    listedDevice(
      "usb-serial-jtag",
      "Native USB Serial/JTAG",
      "USB_SERIAL_JTAG",
      "Built-in full-speed USB Serial/JTAG",
      ["GPIO18", "GPIO19"],
      "ESP32-C3 TRM fixes USB D- on GPIO18 and D+ on GPIO19.",
    ),
    listedDevice(
      "rgb-led",
      "Addressable RGB LED (SK68XXMINI)",
      "GPIO",
      "Onboard WS2812/SK68XX RGB LED",
      ["GPIO8"],
      "ESP32-C3-DevKitM-1 User Guide: addressable RGB LED driven by GPIO8.",
    ),
  ],
  drivers: [],
  driverRecoveries: [],
  imageObservations: null,
  limitations: [
    "ESP32-C3 GPIO Matrix can route peripheral signals to arbitrary GPIOs; only fixed USB pins and default DevKitM-1 console/LED pins are listed.",
  ],
};

export const ESP32S3_DEVKITC_1_PROFILE: BoardPeripheralProfile = {
  id: "esp32s3-devkitc-1",
  soc: "esp32s3",
  mcu: "ESP32-S3-WROOM-1",
  imageSha256: null,
  evidence:
    "Espressif ESP32-S3-DevKitC-1 v1.0/v1.1 User Guide and ESP32-S3 Technical Reference Manual.",
  memory: [
    memWindow(
      "internal-rom",
      "ESP32-S3 384 KiB Internal ROM",
      "code",
      0x40000000n,
      384 * 1024,
      "ESP32-S3 TRM: Internal ROM 0 and 1 at 0x40000000..0x4005ffff.",
    ),
    memWindow(
      "internal-sram",
      "ESP32-S3 Internal SRAM (DRAM)",
      "sram",
      0x3fc88000n,
      448 * 1024,
      "ESP32-S3 TRM: Internal SRAM1/SRAM2 data bus window starting at 0x3fc88000.",
    ),
  ],
  devices: [
    listedDevice(
      "usb-uart-bridge",
      "USB-to-UART port",
      "UART0",
      "Default UART0 console",
      ["GPIO43", "GPIO44"],
      "ESP32-S3-DevKitC-1 schematic connects U0TXD (GPIO43) and U0RXD (GPIO44) to the UART bridge.",
    ),
    listedDevice(
      "native-usb-port",
      "Native USB Serial/JTAG & OTG port",
      "USB_SERIAL_JTAG",
      "Direct USB D-/D+ port",
      ["GPIO19", "GPIO20"],
      "ESP32-S3 TRM fixes USB D- on GPIO19 and USB D+ on GPIO20.",
    ),
    listedDevice(
      "rgb-led",
      "Addressable RGB LED",
      "GPIO",
      "Onboard RGB LED",
      ["GPIO48", "GPIO38"],
      "ESP32-S3-DevKitC-1 User Guide documents both v1.0 (GPIO48) and v1.1 (GPIO38) revisions.",
      "ESP32-S3-DevKitC-1 v1.0 routes the RGB LED to GPIO48 while v1.1 routes it to GPIO38; board id alone does not settle the hardware revision.",
    ),
  ],
  drivers: [],
  driverRecoveries: [],
  imageObservations: null,
  limitations: [
    "ESP32-S3 external PSRAM size and octal/quad mode depend on the fitted WROOM-1/2 module variant and remain unsettled without image/eFuse evidence.",
  ],
};
