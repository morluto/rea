import { describe, expect, it } from "vitest";
import type { Devicetree, InspectDevicetreeInput } from "./devicetree.js";
import {
  customHardwareProfileSchema,
  hardwareProfileFromDevicetree,
  lookupCustomPeripheral,
  parseCmsisSvd,
} from "./hardwareCustomProfile.js";

const buildProp = (
  name: string,
  options: {
    bytes?: number;
    strings?: string[] | null;
    cells?: number[] | null;
    reg?: { address: string | null; size: string | null }[] | null;
  } = {},
) => ({
  name,
  offset: 0,
  bytes: options.bytes ?? 4,
  hex: "",
  truncated: false,
  derived: {
    confidence: "derived" as const,
    strings: options.strings ?? null,
    cells: options.cells ?? null,
    reg: options.reg ?? null,
  },
});

const sampleDevicetree = (): Devicetree => {
  const _unusedInputCheck: InspectDevicetreeInput | null = null;
  void _unusedInputCheck;
  return {
    artifact: {
      path: "/tmp/bcm2711-rpi-4-b.dtb",
      sha256: "b".repeat(64),
      bytes: 1024,
    },
    header: {
      magic: 0xd00dfeed,
      totalsize: 1024,
      off_dt_struct: 56,
      off_dt_strings: 900,
      off_mem_rsvmap: 40,
      version: 17,
      last_comp_version: 16,
      boot_cpuid_phys: 0,
      size_dt_strings: 124,
      size_dt_struct: 844,
    },
    reservations: [],
    nodes: [
      {
        path: "/",
        parent: null,
        offset: 0,
        properties: [
          buildProp("model", { strings: ["Raspberry Pi 4 Model B"] }),
          buildProp("#address-cells", { cells: [2] }),
          buildProp("#size-cells", { cells: [1] }),
        ],
      },
      {
        path: "/memory@0",
        parent: "/",
        offset: 64,
        properties: [
          buildProp("device_type", { strings: ["memory"] }),
          buildProp("reg", {
            reg: [{ address: "0x0", size: "0x40000000" }],
          }),
        ],
      },
      {
        path: "/soc",
        parent: "/",
        offset: 128,
        properties: [
          buildProp("compatible", { strings: ["simple-bus"] }),
          buildProp("#address-cells", { cells: [1] }),
          buildProp("#size-cells", { cells: [1] }),
          // child=0x7e000000 (1 cell), parent=0x00000000_fe000000 (2 cells), len=0x01800000 (1 cell)
          buildProp("ranges", {
            bytes: 16,
            cells: [0x7e000000, 0x00000000, 0xfe000000, 0x01800000],
          }),
        ],
      },
      {
        path: "/soc/serial@7e201000",
        parent: "/soc",
        offset: 200,
        properties: [
          buildProp("compatible", { strings: ["arm,pl011", "arm,primecell"] }),
          buildProp("reg", {
            reg: [{ address: "0x7e201000", size: "0x200" }],
          }),
        ],
      },
      {
        path: "/soc/spi@7e204000",
        parent: "/soc",
        offset: 260,
        properties: [
          buildProp("compatible", { strings: ["brcm,bcm2835-spi"] }),
          buildProp("#address-cells", { cells: [1] }),
          buildProp("#size-cells", { cells: [0] }),
          buildProp("reg", {
            reg: [{ address: "0x7e204000", size: "0x200" }],
          }),
        ],
      },
      {
        path: "/soc/spi@7e204000/flash@0",
        parent: "/soc/spi@7e204000",
        offset: 320,
        properties: [
          buildProp("compatible", { strings: ["jedec,spi-nor"] }),
          buildProp("reg", {
            reg: [{ address: "0x0", size: null }],
          }),
        ],
      },
      {
        path: "/soc/i2c@7e804000",
        parent: "/soc",
        offset: 380,
        properties: [
          buildProp("status", { strings: ["disabled"] }),
          buildProp("reg", {
            reg: [{ address: "0x7e804000", size: "0x1000" }],
          }),
        ],
      },
    ],
    references: [],
    summary: {
      confidence: "derived",
      compatible: ["raspberrypi,4-model-b", "brcm,bcm2711"],
      model: "Raspberry Pi 4 Model B",
      bootargs: null,
      stdout_path: "/soc/serial@7e201000",
      aliases: [{ name: "serial0", path: "/soc/serial@7e201000" }],
    },
    coverage: {
      status: "complete",
      examined_nodes: 7,
      examined_properties: 18,
    },
    limitations: [],
  };
};

describe("Devicetree to CustomHardwareProfile conversion", () => {
  it("translates FDT bus ranges, memory nodes, and non-MMIO child bus devices", () => {
    const profile = hardwareProfileFromDevicetree(sampleDevicetree());
    expect(customHardwareProfileSchema.safeParse(profile).success).toBe(true);
    expect(profile.sourceKind).toBe("devicetree");
    expect(profile.model).toBe("Raspberry Pi 4 Model B");

    // /memory@0 -> SRAM window
    expect(profile.memory).toHaveLength(1);
    expect(profile.memory[0]).toMatchObject({
      kind: "sram",
      baseAddress: "0x0",
      sizeBytes: 0x40000000,
    });

    // /soc/serial@7e201000 translated via /soc ranges -> CPU physical 0xfe201000
    const pl011 = lookupCustomPeripheral(0xfe201024n, profile);
    expect(pl011).not.toBeNull();
    expect(pl011?.peripheral).toMatchObject({
      name: "SERIAL@0xfe201000",
      baseAddress: "0xfe201000",
      sizeBytes: 0x200,
    });
    expect(pl011?.register).toBeNull();

    // Disabled node (/soc/i2c@7e804000) is excluded
    expect(lookupCustomPeripheral(0xfe804000n, profile)).toBeNull();

    // Non-ranges child (/soc/spi@7e204000/flash@0) is recorded as a child device attachment on SPI@0xfe204000, not CPU MMIO at 0x0
    expect(lookupCustomPeripheral(0x0n, profile)).toBeNull();
    expect(profile.devices).toEqual([
      expect.objectContaining({
        peripheralName: "SPI@0xfe204000",
        kind: "listed_resource",
        name: "jedec,spi-nor",
      }),
    ]);
  });
});

describe("CMSIS-SVD parser", () => {
  it("parses peripherals, derivedFrom inheritance, addressBlocks, and registers", () => {
    const parsed = parseCmsisSvd(`<?xml version="1.0" encoding="utf-8"?>
      <device>
        <name>STM32_CUSTOM</name>
        <peripherals>
          <peripheral>
            <name>UARTA</name>
            <description>Primary UART</description>
            <groupName>APB1</groupName>
            <baseAddress>0x40004400</baseAddress>
            <addressBlock>
              <offset>0x0</offset>
              <size>0x400</size>
              <usage>registers</usage>
            </addressBlock>
            <registers>
              <register>
                <name>SR</name>
                <description>Status register</description>
                <addressOffset>0x00</addressOffset>
              </register>
              <register>
                <name>DR</name>
                <description>Data register</description>
                <addressOffset>4</addressOffset>
              </register>
            </registers>
          </peripheral>
          <peripheral derivedFrom="UARTA">
            <name>UARTB</name>
            <baseAddress>0x40004800</baseAddress>
          </peripheral>
        </peripherals>
      </device>
    `);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(customHardwareProfileSchema.safeParse(parsed.value).success).toBe(
      true,
    );
    expect(parsed.value.id).toBe("STM32_CUSTOM");
    expect(parsed.value.peripherals).toHaveLength(2);

    const uartbDr = lookupCustomPeripheral(0x40004804n, parsed.value);
    expect(uartbDr?.peripheral.name).toBe("UARTB");
    expect(uartbDr?.peripheral.bus).toBe("APB1");
    expect(uartbDr?.register).toEqual({
      mnemonic: "UARTB_DR",
      name: "UARTB Data register",
      offset: 4n,
    });
  });

  it("rejects empty or peripheral-less SVD documents cleanly", () => {
    expect(parseCmsisSvd("   ").ok).toBe(false);
    expect(parseCmsisSvd("<device><name>Empty</name></device>").ok).toBe(false);
  });
});
