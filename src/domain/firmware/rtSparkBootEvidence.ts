import {
  RT_SPARK_DRIVERS,
  RT_SPARK_FLASH_IMAGE_SHA256,
} from "./boardDriverLayer.js";
import type { ImageHardwareDecodeInput } from "./imageHardwareDecode.js";

/**
 * Boot facts read from one RT-Spark flash image.
 * Addresses and immediates are instruction observations. Controller names are
 * applied only from the chip or architecture map. Facts the instructions do
 * not settle stay unresolved.
 */
export const rtSparkBootEvidence = {
  imageSha256: RT_SPARK_FLASH_IMAGE_SHA256,
  architecture: "cortex-m",
  loadAddress: "0x08000000",
  steps: [
    {
      address: "0x0800c6b4",
      name: "reset_handler",
      calls: ["0x0800c704", "0x080013c4"],
    },
    {
      address: "0x0800c704",
      name: "system_init",
      calls: [],
    },
    {
      address: "0x080013c4",
      name: "startup_entry",
      calls: ["0x08001438"],
    },
    {
      address: "0x08001438",
      name: "startup_sequence",
      calls: [
        "0x080001e4",
        "0x0800c770",
        "0x08002a04",
        "0x080056d4",
        "0x080041b4",
        "0x080013ec",
        "0x08005708",
        "0x080019bc",
        "0x080041fc",
      ],
    },
  ],
  registerWrites: [
    {
      functionAddress: "0x0800c704",
      base: "0xe000ed00",
      baseName: "SCB",
      baseBasis: "architecture_manual",
      offset: "0x88",
      register: "CPACR",
      operation: "orr 0xf00000",
    },
    {
      functionAddress: "0x0800c704",
      base: "0xe000ed00",
      baseName: "SCB",
      baseBasis: "architecture_manual",
      offset: "0x8",
      register: "VTOR",
      operation: "write 0x08000000",
    },
    {
      functionAddress: "0x0800c704",
      base: "0x40023800",
      baseName: "RCC",
      baseBasis: "chip_manual",
      offset: "0x0",
      register: "RCC_CR",
      operation: "orr 0x1",
    },
    {
      functionAddress: "0x0800c704",
      base: "0x40023800",
      baseName: "RCC",
      baseBasis: "chip_manual",
      offset: "0x4",
      register: "RCC_PLLCFGR",
      operation: "write 0x24003010",
    },
  ],
  console: {
    deviceName: "uart1",
    deviceNameSite: "0x0800c786",
    deviceNameFunction: "0x0800c770",
    openImmediate: "0x43",
    greeting: "Hello RT-Thread!",
    greetingFunction: "0x0800f064",
  },
  usartSetup: {
    functionAddress: "0x0800eb1c",
    nameString: "rt_hw_usart_init",
    nameStringSite: "0x0800ebda",
    configWord: "0x1c200",
    configDecimal: 115200,
  },
  boardInitTable: {
    walker: "0x08001364",
    first: "0x08012cb8",
    end: "0x08012cc4",
    targets: ["0x08001334", "0x0800c954", "0x0800d8c4"],
    emptyReturns: ["0x08001334", "0x0800c954"],
  },
  usartClock: {
    functionAddress: "0x0800e244",
    instanceBase: "0x40011000",
    instanceName: "USART1",
    instanceBasis: "chip_manual",
    clockBase: "0x40023800",
    clockRegister: "RCC_APB2ENR",
    clockOffset: "0x44",
    clockOperation: "orr 0x10",
    clockBasis: "chip_manual",
  },
  usartDeviceRecord: {
    address: "0x08012fcc",
    base: "0x40011000",
    baseName: "USART1",
    baseBasis: "chip_manual",
  },
  gpioClocks: {
    functionAddress: "0x0800e294",
    clockBase: "0x40023800",
    clockRegister: "RCC_AHB1ENR",
    clockOffset: "0x30",
    ports: [
      "GPIOA",
      "GPIOB",
      "GPIOC",
      "GPIOD",
      "GPIOE",
      "GPIOF",
      "GPIOG",
      "GPIOH",
      "GPIOI",
    ],
    basis: "chip_manual",
  },
  spiControllers: {
    table: "0x080742ac",
    controllers: [
      { base: "0x40013000", name: "SPI1" },
      { base: "0x40003800", name: "SPI2" },
      { base: "0x40003c00", name: "SPI3" },
    ],
    basis: "chip_manual",
  },
  spiFlashInit: {
    functionAddress: "0x080604e4",
    strings: ["spi20", "spi2", "W25Q128"],
    registerWrites: [
      {
        address: "0x40023830",
        register: "RCC_AHB1ENR",
        operation: "orr 0x2",
        bitName: "GPIOBEN",
        basis: "chip_manual",
      },
      {
        address: "0x40020400",
        register: "GPIOB",
        operation: "load",
        basis: "chip_manual",
      },
    ],
    attach: {
      functionAddress: "0x08060378",
      nameString: "rt_hw_spi_device_attach",
      busName: "spi2",
      deviceName: "spi20",
      gpioBase: "0x40020400",
      gpioName: "GPIOB",
      gpioBasis: "chip_manual",
      pinMask: "0x1000",
      pinBit: 12,
    },
    probe: {
      functionAddress: "0x08065dcc",
      nameString: "rt_sfud_flash_probe_ex",
      flashDeviceName: "W25Q128",
      spiDeviceName: "spi20",
      table: [
        {
          address: "0x080a4588",
          jedec: "0xef4015",
          capacity: "0x200000",
          name: "W25Q16BV",
        },
        {
          address: "0x080a45a0",
          jedec: "0xef4016",
          capacity: "0x400000",
          name: "W25Q32BV",
        },
        {
          address: "0x080a45b8",
          jedec: "0xef4017",
          capacity: "0x800000",
          name: "W25Q64CV",
        },
        {
          address: "0x080a45d0",
          jedec: "0xef6017",
          capacity: "0x800000",
          name: "W25Q64DW",
        },
        {
          address: "0x080a45e8",
          jedec: "0xef4018",
          capacity: "0x1000000",
          name: "W25Q128BV",
        },
        {
          address: "0x080a4600",
          jedec: "0xef4019",
          capacity: "0x2000000",
          name: "W25Q256FV",
        },
      ],
    },
  },
  pinCalls: [
    { site: "0x08054f6a", pin: "0x5c", argument: "0x0", target: "0x08063d68" },
    { site: "0x08054f72", pin: "0x5b", argument: "0x0", target: "0x08063d68" },
    { site: "0x08054f7a", pin: "0x10", argument: "0x0", target: "0x08063d68" },
    { site: "0x08054f82", pin: "0x11", argument: "0x0", target: "0x08063d68" },
    { site: "0x08054f8a", pin: "0x53", argument: "0x2", target: "0x08063d68" },
    { site: "0x08054f92", pin: "0x20", argument: "0x2", target: "0x08063d68" },
    { site: "0x08054f9a", pin: "0x24", argument: "0x2", target: "0x08063d68" },
    { site: "0x08054fa2", pin: "0x25", argument: "0x2", target: "0x08063d68" },
    { site: "0x08054faa", pin: "0x21", argument: "0x2", target: "0x08063d68" },
    { site: "0x08054fb4", pin: "0x5c", argument: "0x1", target: "0x08063df4" },
    { site: "0x08054fbc", pin: "0x5b", argument: "0x0", target: "0x08063df4" },
    { site: "0x08054fcc", pin: "0x5c", argument: "0x0", target: "0x08063df4" },
    { site: "0x08054fd4", pin: "0x5b", argument: "0x1", target: "0x08063df4" },
    { site: "0x08054fe4", pin: "0x5c", argument: "0x1", target: "0x08063df4" },
    { site: "0x08054fec", pin: "0x5b", argument: "0x1", target: "0x08063df4" },
  ],
  delayCalls: [
    { site: "0x08054fc2", immediate: "0x1f4", target: "0x0806752c" },
    { site: "0x08054fda", immediate: "0x1f4", target: "0x0806752c" },
    { site: "0x08054ff2", immediate: "0x1f4", target: "0x0806752c" },
  ],
  pinDecode: {
    implementation: "0x08073c94",
    portBits: "ubfx #4, #4",
    pinBits: "and #0xf",
    gpioBase: "0x40020000",
    stride: "0x400",
    portLimit: 9,
    basis: "instruction",
  },
  unresolved: [
    {
      subject: "spi-flash-part",
      reason:
        "rt_sfud_flash_probe_ex is called with device name W25Q128. The image table names W25Q16BV, W25Q32BV, W25Q64CV, W25Q64DW, W25Q128BV, and W25Q256FV. The installed part is the chip that answers.",
    },
    {
      subject: "gpio-role",
      reason:
        "Pin index 0x5c decodes to GPIOF pin 12 and 0x5b to GPIOF pin 11. The instructions do not say which board device those pins are.",
    },
  ],
} as const;

/** One record for this image: disassembly, driver linkage, and unsettled facts. */
export const rtSparkBoardPack = {
  evidence: rtSparkBootEvidence,
  drivers: RT_SPARK_DRIVERS,
} as const;

const pllFields = [
  { name: "PLLM", shift: 0, width: 6 },
  { name: "PLLN", shift: 6, width: 9 },
  { name: "PLLP", shift: 16, width: 2 },
  { name: "PLLSRC", shift: 22, width: 1 },
  { name: "PLLQ", shift: 24, width: 4 },
] as const;

const spiLoadSite: Readonly<Record<string, string>> = {
  "0x40023830": "0x080604ec",
  "0x40020400": "0x08060508",
};

/**
 * Observations the reconstruction report can decode.
 * Built from the boot record so the pin list, SFUD rows, and PLL word stay one list.
 */
export const rtSparkImageObservations: ImageHardwareDecodeInput = {
  architecture: "cortex-m",
  platform: "stm32f4",
  pinPlacement: {
    origin: BigInt(rtSparkBootEvidence.pinDecode.gpioBase),
    stride: BigInt(rtSparkBootEvidence.pinDecode.stride),
    portLimit: rtSparkBootEvidence.pinDecode.portLimit,
  },
  vectors: [{ index: 1, rule: "architecture-register", name: "Reset" }],
  observations: [
    ...rtSparkBootEvidence.spiFlashInit.registerWrites.map((write) => ({
      kind: "loaded-address" as const,
      site:
        spiLoadSite[write.address] ??
        rtSparkBootEvidence.spiFlashInit.functionAddress,
      address: BigInt(write.address),
      fromRoundedPage: false,
    })),
    {
      kind: "bus-name",
      site: rtSparkBootEvidence.spiFlashInit.attach.functionAddress,
      name: rtSparkBootEvidence.spiFlashInit.attach.busName,
    },
    {
      kind: "loaded-address",
      site: "0x0807ac40",
      address: 0x40021400n,
      fromRoundedPage: false,
    },
    {
      kind: "bus-name",
      site: "0x0807ac3c",
      name: "spi2",
    },
    {
      kind: "loaded-address",
      site: "0x0800e29e",
      address: 0x40020000n,
      fromRoundedPage: false,
    },
    {
      kind: "loaded-address",
      site: "0x0800e2a6",
      address: 0x40020400n,
      fromRoundedPage: false,
    },
    {
      kind: "loaded-address",
      site: "0x0800e2ae",
      address: 0x40020800n,
      fromRoundedPage: false,
    },
    {
      kind: "loaded-address",
      site: "0x0800e2b6",
      address: 0x40020c00n,
      fromRoundedPage: false,
    },
    {
      kind: "loaded-address",
      site: "0x0800e2be",
      address: 0x40021000n,
      fromRoundedPage: false,
    },
    {
      kind: "loaded-address",
      site: "0x0800e2c6",
      address: 0x40021400n,
      fromRoundedPage: false,
    },
    {
      kind: "loaded-address",
      site: "0x0800e2ce",
      address: 0x40021800n,
      fromRoundedPage: false,
    },
    {
      kind: "loaded-address",
      site: "0x0800e2d6",
      address: 0x40021c00n,
      fromRoundedPage: false,
    },
    {
      kind: "loaded-address",
      site: "0x0800e2de",
      address: 0x40022000n,
      fromRoundedPage: false,
    },
    {
      kind: "loaded-address",
      site: "0x0800e344",
      address: 0x40023800n,
      fromRoundedPage: false,
    },
    {
      kind: "loaded-address",
      site: "0x08073d06",
      address: 0x40020000n,
      fromRoundedPage: false,
    },
    {
      kind: "loaded-address",
      site: "0x0800e252",
      address: 0x40011000n,
      fromRoundedPage: false,
    },
    {
      kind: "loaded-address",
      site: "0x08012ef0",
      address: 0x40000400n,
      fromRoundedPage: false,
    },
    {
      kind: "loaded-address",
      site: "0x08012f7c",
      address: 0x40000800n,
      fromRoundedPage: false,
    },
    {
      kind: "loaded-address",
      site: "0x0805fb44",
      address: 0x40012c00n,
      fromRoundedPage: false,
    },
    {
      kind: "loaded-address",
      site: "0x0806466c",
      address: 0x40002800n,
      fromRoundedPage: false,
    },
    {
      kind: "loaded-address",
      site: "0x08072e6e",
      address: 0x40012000n,
      fromRoundedPage: false,
    },
    {
      kind: "loaded-address",
      site: "0x08072e88",
      address: 0x40012100n,
      fromRoundedPage: false,
    },
    {
      kind: "loaded-address",
      site: "0x08072ea2",
      address: 0x40012200n,
      fromRoundedPage: false,
    },
    ...rtSparkBootEvidence.pinCalls.map((call) => ({
      kind: "pin-index" as const,
      site: call.site,
      index: BigInt(call.pin),
    })),
    {
      kind: "sfud-table",
      tableAddress:
        rtSparkBootEvidence.spiFlashInit.probe.table[0]?.address ?? "",
      deviceName: rtSparkBootEvidence.spiFlashInit.probe.flashDeviceName,
      rows: rtSparkBootEvidence.spiFlashInit.probe.table.map((row) => ({
        address: row.address,
        name: row.name,
        jedec: BigInt(row.jedec),
        capacity: BigInt(row.capacity),
      })),
    },
    {
      kind: "pll-immediate",
      site: "0x0800c704",
      value: 0x24003010n,
      fields: pllFields,
      clockSwitch: null,
    },
    { kind: "vector-slot", site: "0x08000004", index: 1 },
    ...rtSparkBootEvidence.registerWrites.flatMap((write) => {
      if (write.register === "RCC_PLLCFGR") return [];
      const immediate = /0x[0-9a-f]+/i.exec(write.operation);
      return [
        {
          kind: "register-access" as const,
          site: write.functionAddress,
          address: BigInt(write.base) + BigInt(write.offset),
          immediate: immediate === null ? null : BigInt(immediate[0]),
        },
      ];
    }),
    {
      kind: "offset-write",
      site: rtSparkBootEvidence.usartClock.functionAddress,
      base: BigInt(rtSparkBootEvidence.usartClock.clockBase),
      offset: BigInt(rtSparkBootEvidence.usartClock.clockOffset),
      mask: 0x10n,
    },
    {
      kind: "loaded-address",
      site: rtSparkBootEvidence.usartDeviceRecord.address,
      address: BigInt(rtSparkBootEvidence.usartDeviceRecord.base),
      fromRoundedPage: false,
    },
    ...rtSparkBootEvidence.spiControllers.controllers.map((item, index) => ({
      kind: "loaded-address" as const,
      site: `0x${(BigInt(rtSparkBootEvidence.spiControllers.table) + BigInt(index) * 4n).toString(16).padStart(8, "0")}`,
      address: BigInt(item.base),
      fromRoundedPage: false,
    })),
    ...rtSparkBootEvidence.delayCalls.map((call) => ({
      kind: "immediate" as const,
      site: call.site,
      value: BigInt(call.immediate),
    })),
    {
      kind: "immediate",
      site: rtSparkBootEvidence.usartSetup.functionAddress,
      value: BigInt(rtSparkBootEvidence.usartSetup.configWord),
    },
    {
      kind: "immediate",
      site: rtSparkBootEvidence.spiFlashInit.attach.functionAddress,
      value: BigInt(rtSparkBootEvidence.spiFlashInit.attach.pinMask),
    },
    {
      kind: "bus-name",
      site: rtSparkBootEvidence.console.deviceNameSite,
      name: rtSparkBootEvidence.console.deviceName,
    },
    {
      kind: "bus-name",
      site: rtSparkBootEvidence.console.greetingFunction,
      name: rtSparkBootEvidence.console.greeting,
    },
  ],
};
