import {
  lookupSocPeripheral,
  resolveSocRegisterAlias,
  type SocPlatform,
  type SocPeripheralDefinition,
} from "./socPeripheralDatabase.js";

export interface SocPeripheralRegisterResult {
  readonly peripheral: SocPeripheralDefinition;
  readonly offset: number;
  readonly offsetHex: string;
  readonly mnemonic: string;
  readonly name: string;
}

interface OffsetEntry {
  readonly offset: number;
  readonly mnemonic: string;
  readonly name: string;
}

const r = (offset: number, mnemonic: string, name: string): OffsetEntry => ({
  offset,
  mnemonic,
  name,
});

const STM32_V1_USART: readonly OffsetEntry[] = [
  r(0x00, "SR", "Status register"),
  r(0x04, "DR", "Data register"),
  r(0x08, "BRR", "Baud rate register"),
  r(0x0c, "CR1", "Control register 1"),
  r(0x10, "CR2", "Control register 2"),
  r(0x14, "CR3", "Control register 3"),
  r(0x18, "GTPR", "Guard time and prescaler register"),
];

const GD32_USART: readonly OffsetEntry[] = [
  r(0x00, "STAT", "Status register"),
  r(0x04, "DATA", "Data register"),
  r(0x08, "BAUD", "Baud rate register"),
  r(0x0c, "CTL0", "Control register 0"),
  r(0x10, "CTL1", "Control register 1"),
  r(0x14, "CTL2", "Control register 2"),
  r(0x18, "GP", "Guard time and prescaler register"),
];

const STM32_V2_USART: readonly OffsetEntry[] = [
  r(0x00, "CR1", "Control register 1"),
  r(0x04, "CR2", "Control register 2"),
  r(0x08, "CR3", "Control register 3"),
  r(0x0c, "BRR", "Baud rate register"),
  r(0x1c, "ISR", "Interrupt and status register"),
  r(0x20, "ICR", "Interrupt flag clear register"),
  r(0x24, "RDR", "Receive data register"),
  r(0x28, "TDR", "Transmit data register"),
];

const STM32F1_GPIO: readonly OffsetEntry[] = [
  r(0x00, "CRL", "Port configuration register low"),
  r(0x04, "CRH", "Port configuration register high"),
  r(0x08, "IDR", "Port input data register"),
  r(0x0c, "ODR", "Port output data register"),
  r(0x10, "BSRR", "Port bit set/reset register"),
  r(0x14, "BRR", "Port bit reset register"),
  r(0x18, "LCKR", "Port configuration lock register"),
];

const GD32F1_GPIO: readonly OffsetEntry[] = [
  r(0x00, "CTL0", "Port control register 0"),
  r(0x04, "CTL1", "Port control register 1"),
  r(0x08, "ISTAT", "Port input status register"),
  r(0x0c, "OCTL", "Port output control register"),
  r(0x10, "BOP", "Port bit operate register"),
  r(0x14, "BC", "Port bit clear register"),
  r(0x18, "LOCK", "Port configuration lock register"),
];

const STM32F4_GPIO: readonly OffsetEntry[] = [
  r(0x00, "MODER", "GPIO port mode register"),
  r(0x04, "OTYPER", "GPIO port output type register"),
  r(0x08, "OSPEEDR", "GPIO port output speed register"),
  r(0x0c, "PUPDR", "GPIO port pull-up/pull-down register"),
  r(0x10, "IDR", "GPIO port input data register"),
  r(0x14, "ODR", "GPIO port output data register"),
  r(0x18, "BSRR", "GPIO port bit set/reset register"),
  r(0x1c, "LCKR", "GPIO port configuration lock register"),
  r(0x20, "AFRL", "GPIO alternate function low register"),
  r(0x24, "AFRH", "GPIO alternate function high register"),
];

const GD32F4_GPIO: readonly OffsetEntry[] = [
  r(0x00, "CTL", "GPIO port control register"),
  r(0x04, "OMODE", "GPIO port output mode register"),
  r(0x08, "OSPD", "GPIO port output speed register"),
  r(0x0c, "PUD", "GPIO port pull-up/pull-down register"),
  r(0x10, "ISTAT", "GPIO port input status register"),
  r(0x14, "OCTL", "GPIO port output control register"),
  r(0x18, "BOP", "GPIO port bit operate register"),
  r(0x1c, "LOCK", "GPIO port configuration lock register"),
  r(0x20, "AFSEL0", "GPIO alternate function selected register 0"),
  r(0x24, "AFSEL1", "GPIO alternate function selected register 1"),
];

const STM32F1_RCC: readonly OffsetEntry[] = [
  r(0x00, "CR", "Clock control register"),
  r(0x04, "CFGR", "Clock configuration register"),
  r(0x08, "CIR", "Clock interrupt register"),
  r(0x0c, "APB2RSTR", "APB2 peripheral reset register"),
  r(0x10, "APB1RSTR", "APB1 peripheral reset register"),
  r(0x14, "AHBENR", "AHB peripheral clock enable register"),
  r(0x18, "APB2ENR", "APB2 peripheral clock enable register"),
  r(0x1c, "APB1ENR", "APB1 peripheral clock enable register"),
];

const STM32F4_RCC: readonly OffsetEntry[] = [
  r(0x00, "CR", "Clock control register"),
  r(0x04, "PLLCFGR", "PLL configuration register"),
  r(0x08, "CFGR", "Clock configuration register"),
  r(0x0c, "CIR", "Clock interrupt register"),
  r(0x30, "AHB1ENR", "AHB1 peripheral clock enable register"),
  r(0x34, "AHB2ENR", "AHB2 peripheral clock enable register"),
  r(0x38, "AHB3ENR", "AHB3 peripheral clock enable register"),
  r(0x40, "APB1ENR", "APB1 peripheral clock enable register"),
  r(0x44, "APB2ENR", "APB2 peripheral clock enable register"),
];

const STM32L4_RCC: readonly OffsetEntry[] = [
  r(0x00, "CR", "Clock control register"),
  r(0x08, "CFGR", "Clock configuration register"),
  r(0x0c, "PLLCFGR", "PLL configuration register"),
  r(0x48, "AHB1ENR", "AHB1 peripheral clock enable register"),
  r(0x4c, "AHB2ENR", "AHB2 peripheral clock enable register"),
  r(0x50, "AHB3ENR", "AHB3 peripheral clock enable register"),
  r(0x58, "APB1ENR1", "APB1 peripheral clock enable register 1"),
  r(0x60, "APB2ENR", "APB2 peripheral clock enable register"),
];

const STM32H7_RCC: readonly OffsetEntry[] = [
  r(0x00, "CR", "Source control register"),
  r(0x10, "CFGR", "Clock configuration register"),
  r(0xd4, "AHB3ENR", "AHB3 clock register"),
  r(0xd8, "AHB1ENR", "AHB1 clock register"),
  r(0xdc, "AHB2ENR", "AHB2 clock register"),
  r(0xe0, "AHB4ENR", "AHB4 clock register"),
  r(0xe4, "APB3ENR", "APB3 clock register"),
  r(0xe8, "APB1LENR", "APB1L clock register"),
  r(0xec, "APB1HENR", "APB1H clock register"),
  r(0xf0, "APB2ENR", "APB2 clock register"),
  r(0xf4, "APB4ENR", "APB4 clock register"),
];

const STM32_SPI: readonly OffsetEntry[] = [
  r(0x00, "CR1", "SPI control register 1"),
  r(0x04, "CR2", "SPI control register 2"),
  r(0x08, "SR", "SPI status register"),
  r(0x0c, "DR", "SPI data register"),
];

const STM32H7_SPI: readonly OffsetEntry[] = [
  r(0x00, "CR1", "SPI/I2S control register 1"),
  r(0x04, "CR2", "SPI/I2S control register 2"),
  r(0x08, "CFG1", "SPI configuration register 1"),
  r(0x0c, "CFG2", "SPI configuration register 2"),
  r(0x10, "IER", "SPI/I2S interrupt enable register"),
  r(0x14, "SR", "SPI/I2S status register"),
  r(0x18, "IFCR", "SPI/I2S interrupt/status flags clear register"),
  r(0x20, "TXDR", "SPI/I2S transmit data register"),
  r(0x30, "RXDR", "SPI/I2S receive data register"),
];

const GD32_SPI: readonly OffsetEntry[] = [
  r(0x00, "CTL0", "SPI control register 0"),
  r(0x04, "CTL1", "SPI control register 1"),
  r(0x08, "STAT", "SPI status register"),
  r(0x0c, "DATA", "SPI data register"),
];

const RP2040_UART: readonly OffsetEntry[] = [
  r(0x00, "UARTDR", "Data register"),
  r(0x04, "UARTRSR", "Receive status / error clear register"),
  r(0x18, "UARTFR", "Flag register"),
  r(0x24, "UARTIBRD", "Integer baud rate divisor"),
  r(0x28, "UARTFBRD", "Fractional baud rate divisor"),
  r(0x2c, "UARTLCR_H", "Line control register"),
  r(0x30, "UARTCR", "Control register"),
  r(0x38, "UARTIMSC", "Interrupt mask set/clear register"),
];

const RP2040_SIO: readonly OffsetEntry[] = [
  r(0x00, "CPUID", "Processor core identifier"),
  r(0x04, "GPIO_IN", "Input value for GPIO pins"),
  r(0x10, "GPIO_OUT", "GPIO output value"),
  r(0x14, "GPIO_OUT_SET", "GPIO output value set"),
  r(0x18, "GPIO_OUT_CLR", "GPIO output value clear"),
  r(0x1c, "GPIO_OUT_XOR", "GPIO output value XOR"),
  r(0x20, "GPIO_OE", "GPIO output enable"),
  r(0x24, "GPIO_OE_SET", "GPIO output enable set"),
  r(0x28, "GPIO_OE_CLR", "GPIO output enable clear"),
  r(0x2c, "GPIO_OE_XOR", "GPIO output enable XOR"),
];

const RP2040_RESETS: readonly OffsetEntry[] = [
  r(0x00, "RESET", "Reset control"),
  r(0x04, "WDSEL", "Watchdog select"),
  r(0x08, "RESET_DONE", "Reset done status"),
];

const NRF52_UARTE: readonly OffsetEntry[] = [
  r(0x000, "TASKS_STARTRX", "Start UART receiver"),
  r(0x004, "TASKS_STOPRX", "Stop UART receiver"),
  r(0x008, "TASKS_STARTTX", "Start UART transmitter"),
  r(0x00c, "TASKS_STOPTX", "Stop UART transmitter"),
  r(0x110, "EVENTS_ENDRX", "Receive buffer filled"),
  r(0x120, "EVENTS_ENDTX", "Last TX byte transmitted"),
  r(0x500, "ENABLE", "Enable UART"),
  r(0x50c, "PSEL_TXD", "Pin select for TXD"),
  r(0x514, "PSEL_RXD", "Pin select for RXD"),
  r(0x524, "BAUDRATE", "Baud rate"),
  r(0x534, "RXD_PTR", "EasyDMA RX data pointer"),
  r(0x544, "TXD_PTR", "EasyDMA TX data pointer"),
];

const NRF52_GPIO: readonly OffsetEntry[] = [
  r(0x04, "OUT", "Write GPIO port"),
  r(0x08, "OUTSET", "Set individual bits in GPIO port"),
  r(0x0c, "OUTCLR", "Clear individual bits in GPIO port"),
  r(0x10, "IN", "Read GPIO port"),
  r(0x14, "DIR", "Direction of GPIO pins"),
  r(0x18, "DIRSET", "DIR set register"),
  r(0x1c, "DIRCLR", "DIR clear register"),
];

const ESP_UART: readonly OffsetEntry[] = [
  r(0x00, "FIFO", "UART FIFO data register"),
  r(0x04, "INT_RAW", "Raw interrupt status"),
  r(0x08, "INT_ST", "Masked interrupt status"),
  r(0x0c, "INT_ENA", "Interrupt enable bits"),
  r(0x10, "INT_CLR", "Interrupt clear bits"),
  r(0x14, "CLKDIV", "Clock divider configuration"),
  r(0x1c, "STATUS", "UART TX/RX FIFO status"),
  r(0x20, "CONF0", "Configuration register 0"),
  r(0x24, "CONF1", "Configuration register 1"),
];

const ESP_GPIO: readonly OffsetEntry[] = [
  r(0x04, "OUT", "GPIO output register"),
  r(0x08, "OUT_W1TS", "GPIO output write-1-to-set"),
  r(0x0c, "OUT_W1TC", "GPIO output write-1-to-clear"),
  r(0x20, "ENABLE", "GPIO output enable register"),
  r(0x24, "ENABLE_W1TS", "GPIO output enable write-1-to-set"),
  r(0x28, "ENABLE_W1TC", "GPIO output enable write-1-to-clear"),
  r(0x3c, "IN", "GPIO input register"),
];

const registerTableFor = (
  peripheralName: string,
  platform: SocPlatform,
): readonly OffsetEntry[] | null => {
  if (platform === "rp2040") {
    if (peripheralName.startsWith("UART")) return RP2040_UART;
    if (peripheralName === "SIO") return RP2040_SIO;
    if (peripheralName === "RESETS") return RP2040_RESETS;
    return null;
  }
  if (platform === "nrf52") {
    if (peripheralName.startsWith("UARTE")) return NRF52_UARTE;
    if (peripheralName === "P0" || peripheralName === "P1") return NRF52_GPIO;
    return null;
  }
  if (platform.startsWith("esp32")) {
    if (peripheralName.startsWith("UART")) return ESP_UART;
    if (peripheralName === "GPIO") return ESP_GPIO;
    return null;
  }
  if (platform === "samd21") return null;
  if (peripheralName.startsWith("USART") || peripheralName.startsWith("UART")) {
    if (platform === "stm32l4" || platform === "stm32h7") return STM32_V2_USART;
    if (platform.startsWith("gd32")) return GD32_USART;
    return STM32_V1_USART;
  }
  if (peripheralName.startsWith("GPIO")) {
    if (platform === "gd32f1" || platform === "gd32vf103") return GD32F1_GPIO;
    if (platform === "gd32f4") return GD32F4_GPIO;
    if (platform === "stm32f1" || platform === "ch32v30x") return STM32F1_GPIO;
    return STM32F4_GPIO;
  }
  if (peripheralName === "RCC") {
    if (platform === "stm32f1" || platform === "ch32v30x") return STM32F1_RCC;
    if (platform === "stm32f4") return STM32F4_RCC;
    if (platform === "stm32l4") return STM32L4_RCC;
    if (platform === "stm32h7") return STM32H7_RCC;
    return null;
  }
  if (peripheralName.startsWith("SPI")) {
    if (platform === "stm32h7") return STM32H7_SPI;
    if (platform.startsWith("gd32")) return GD32_SPI;
    return STM32_SPI;
  }
  return null;
};

const HEX_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{1,16}$/u;

/**
 * Resolve a peripheral register mnemonic from a SoC manual when an explicit or
 * uniquely identified platform is active. Supports direct offsets as well as
 * platform-defined bit-band and atomic register aliases.
 */
export const lookupSocPeripheralRegister = (
  rawAddress: string | bigint,
  platform: SocPlatform,
): SocPeripheralRegisterResult | null => {
  const alias = resolveSocRegisterAlias(rawAddress, platform);
  let peripheral: SocPeripheralDefinition | null;
  let offsetBigInt: bigint;

  if (alias !== null) {
    peripheral = alias.peripheral;
    offsetBigInt = alias.registerOffsetValue;
  } else {
    peripheral = lookupSocPeripheral(rawAddress, platform);
    if (peripheral === null) return null;
    let addr: bigint;
    if (typeof rawAddress === "bigint") {
      addr = rawAddress;
    } else if (HEX_ADDRESS_PATTERN.test(rawAddress)) {
      addr = BigInt(rawAddress);
    } else {
      return null;
    }
    offsetBigInt = addr - peripheral.baseAddressValue;
  }

  const table = registerTableFor(peripheral.name, platform);
  if (table === null) return null;
  const offset = Number(offsetBigInt);
  let matched: OffsetEntry | undefined;
  for (const entry of table) {
    if (entry.offset === offset) {
      matched = entry;
      break;
    }
  }
  if (matched === undefined) return null;

  const prefix = peripheral.name.endsWith("_")
    ? peripheral.name
    : `${peripheral.name}_`;
  const mnemonic = matched.mnemonic.startsWith(peripheral.name)
    ? matched.mnemonic
    : `${prefix}${matched.mnemonic}`;
  return {
    peripheral,
    offset,
    offsetHex: `0x${offset.toString(16)}`,
    mnemonic,
    name: `${peripheral.name} ${matched.name}`,
  };
};
