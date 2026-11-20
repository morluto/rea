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
          buildProp("compatible", { strings: ["simple-bus", "syscon"] }),
          buildProp("#address-cells", { cells: [1] }),
          buildProp("#size-cells", { cells: [1] }),
          // Parent container also exposes a broad reg window; children inside it must remain visible.
          buildProp("reg", {
            reg: [{ address: "0xfe000000", size: "0x01800000" }],
          }),
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
        parent: "/soc",
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
      examined_properties: 19,
    },
    limitations: [],
  };
};

describe("Devicetree to CustomHardwareProfile conversion", () => {
  it("translates FDT bus ranges, prefers nested child windows over parent containers, and binds SPI children", () => {
    const dt = sampleDevicetree();
    const fixedNodes = dt.nodes.map((node) =>
      node.path === "/soc/spi@7e204000/flash@0"
        ? { ...node, parent: "/soc/spi@7e204000" }
        : node,
    );
    const parsed = hardwareProfileFromDevicetree({ ...dt, nodes: fixedNodes });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const profile = parsed.value;
    expect(customHardwareProfileSchema.safeParse(profile).success).toBe(true);
    expect(profile.sourceKind).toBe("devicetree");
    expect(profile.sourceSha256).toBe("b".repeat(64));
    expect(profile.model).toBe("Raspberry Pi 4 Model B");

    // /soc/serial@7e201000 (size 0x200) wins over parent /soc (size 0x01800000)
    const pl011 = lookupCustomPeripheral(0xfe201024n, profile);
    expect(pl011?.kind).toBe("matched");
    if (pl011?.kind === "matched") {
      expect(pl011.peripheral).toMatchObject({
        name: "SERIAL@0xfe201000",
        baseAddress: "0xfe201000",
        sizeBytes: 0x200,
      });
    }
    // Address outside child windows still resolves parent /soc container
    const socHit = lookupCustomPeripheral(0xfe000010n, profile);
    expect(socHit?.kind === "matched" ? socHit.peripheral.name : null).toBe(
      "SOC@0xfe000000",
    );
    expect(lookupCustomPeripheral(0x0n, profile)).toBeNull();
    expect(profile.devices).toEqual([
      expect.objectContaining({
        peripheralName: "SPI@0xfe204000",
        kind: "listed_resource",
        name: "jedec,spi-nor",
      }),
    ]);
  });

  it("rejects cyclic parent links and invalid reg strings without hanging or throwing", () => {
    const base = sampleDevicetree();
    const cyclic = hardwareProfileFromDevicetree({
      ...base,
      nodes: [
        base.nodes[0]!,
        {
          path: "/loop",
          parent: "/loop",
          offset: 64,
          properties: [
            buildProp("ranges", { bytes: 0, cells: [] }),
            buildProp("reg", {
              reg: [{ address: "0x1000", size: "0x100" }],
            }),
          ],
        },
      ],
    });
    expect(cyclic.ok).toBe(false);
    if (!cyclic.ok) expect(cyclic.error).toContain("cyclic parent");

    const badReg = hardwareProfileFromDevicetree({
      ...base,
      nodes: [
        base.nodes[0]!,
        {
          path: "/uart@bad",
          parent: "/",
          offset: 64,
          properties: [
            buildProp("reg", {
              reg: [{ address: "not-a-hex-number", size: "0x100" }],
            }),
          ],
        },
      ],
    });
    expect(badReg.ok).toBe(false);
    if (!badReg.ok) expect(badReg.error).toContain("invalid reg");
  });
});

describe("CMSIS-SVD parser", () => {
  it("resolves chained derivedFrom peripherals, nested cluster offsets, and dim register arrays", () => {
    const parsed = parseCmsisSvd(
      `<?xml version="1.0" encoding="utf-8"?>
      <device>
        <name>STM32_CUSTOM</name>
        <peripherals>
          <peripheral>
            <name>TIMA</name>
            <groupName>APB1</groupName>
            <baseAddress>0x40000000</baseAddress>
            <addressBlock><offset>0x0</offset><size>0x400</size><usage>registers</usage></addressBlock>
            <registers>
              <register>
                <name>CR1</name>
                <description>Control register 1</description>
                <addressOffset>0x00</addressOffset>
              </register>
              <register>
                <dim>2</dim>
                <dimIncrement>0x04</dimIncrement>
                <dimIndex>1,2</dimIndex>
                <name>CCR%s</name>
                <description>Capture/compare register</description>
                <addressOffset>0x34</addressOffset>
              </register>
              <cluster>
                <name>CH</name>
                <addressOffset>0x100</addressOffset>
                <register>
                  <name>CFG</name>
                  <description>Channel config</description>
                  <addressOffset>0x00</addressOffset>
                </register>
              </cluster>
            </registers>
          </peripheral>
          <peripheral derivedFrom="TIMA">
            <name>TIMB</name>
            <baseAddress>0x40000400</baseAddress>
          </peripheral>
          <peripheral derivedFrom="TIMB">
            <name>TIMC</name>
            <baseAddress>0x40000800</baseAddress>
          </peripheral>
        </peripherals>
      </device>`,
      { sha256: "c".repeat(64) },
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(customHardwareProfileSchema.safeParse(parsed.value).success).toBe(
      true,
    );
    expect(parsed.value.sourceSha256).toBe("c".repeat(64));

    // Chained derivedFrom (TIMC -> TIMB -> TIMA) preserves registers and cluster offsets
    const cr1Hit = lookupCustomPeripheral(0x40000800n, parsed.value);
    expect(cr1Hit?.kind === "matched" ? cr1Hit.register : null).toEqual({
      mnemonic: "TIMC_CR1",
      name: "TIMC Control register 1",
      offset: 0n,
    });
    const ccr2Hit = lookupCustomPeripheral(0x40000838n, parsed.value);
    expect(ccr2Hit?.kind === "matched" ? ccr2Hit.register : null).toEqual({
      mnemonic: "TIMC_CCR2",
      name: "TIMC Capture/compare register",
      offset: 0x38n,
    });
    // Cluster at 0x100 + register at 0x00 => offset 0x100 (does NOT overwrite CR1 at 0x00)
    const chCfgHit = lookupCustomPeripheral(0x40000900n, parsed.value);
    expect(chCfgHit?.kind === "matched" ? chCfgHit.register : null).toEqual({
      mnemonic: "TIMC_CH_CFG",
      name: "TIMC Channel config",
      offset: 0x100n,
    });
  });

  it("rejects empty, cyclic derivedFrom, or missing-parent SVD documents", () => {
    expect(parseCmsisSvd("   ").ok).toBe(false);
    expect(parseCmsisSvd("<device><name>Empty</name></device>").ok).toBe(false);
    expect(
      parseCmsisSvd(`
        <device><name>Bad</name><peripherals>
          <peripheral derivedFrom="MISSING"><name>P0</name><baseAddress>0x40000000</baseAddress></peripheral>
        </peripherals></device>
      `).ok,
    ).toBe(false);
    expect(
      parseCmsisSvd(`
        <device><name>Cycle</name><peripherals>
          <peripheral derivedFrom="P1"><name>P0</name><baseAddress>0x40000000</baseAddress></peripheral>
          <peripheral derivedFrom="P0"><name>P1</name><baseAddress>0x40000400</baseAddress></peripheral>
        </peripherals></device>
      `).ok,
    ).toBe(false);
  });
});

describe("CMSIS-SVD bounds, derived spans, and overlapping windows", () => {
  it("preserves overridden child register spans when parent lacks addressBlock", () => {
    const parsed = parseCmsisSvd(`
      <device><name>SpanTest</name><peripherals>
        <peripheral>
          <name>TIM_BASE</name>
          <baseAddress>0x40000000</baseAddress>
          <registers>
            <register><name>CR1</name><addressOffset>0x00</addressOffset></register>
          </registers>
        </peripheral>
        <peripheral derivedFrom="TIM_BASE">
          <name>TIM_EXT</name>
          <baseAddress>0x40001000</baseAddress>
          <registers>
            <register><name>CR1</name><addressOffset>0x00</addressOffset></register>
            <register><name>EXT_CFG</name><addressOffset>0x100</addressOffset></register>
          </registers>
        </peripheral>
      </peripherals></device>
    `);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const extHit = lookupCustomPeripheral(0x40001100n, parsed.value);
    expect(extHit?.kind).toBe("matched");
    if (extHit?.kind === "matched") {
      expect(extHit.peripheral.name).toBe("TIM_EXT");
      expect(extHit.peripheral.sizeBytes).toBe(0x104);
      expect(extHit.register?.mnemonic).toBe("TIM_EXT_EXT_CFG");
    }
  });

  it("bounds nested cluster and register dim expansion without RangeError", () => {
    const bomb = parseCmsisSvd(`
      <device><name>DimBomb</name><peripherals>
        <peripheral>
          <name>BIG</name>
          <baseAddress>0x40000000</baseAddress>
          <registers>
            <cluster>
              <dim>128</dim>
              <dimIncrement>0x1000</dimIncrement>
              <name>BLK%s</name>
              <addressOffset>0x0</addressOffset>
              <register>
                <dim>1024</dim>
                <dimIncrement>0x4</dimIncrement>
                <name>R%s</name>
                <addressOffset>0x0</addressOffset>
              </register>
            </cluster>
          </registers>
        </peripheral>
      </peripherals></device>
    `);
    expect(bomb.ok).toBe(false);
    if (!bomb.ok) {
      expect(bomb.error).toContain("exceeds maximum");
    }
  });

  it("reports equal-sized overlapping peripheral windows as ambiguous", () => {
    const parsed = parseCmsisSvd(`
      <device><name>OverlapSoc</name><peripherals>
        <peripheral>
          <name>PINMUX</name>
          <baseAddress>0xfe201000</baseAddress>
          <addressBlock><offset>0x0</offset><size>0x200</size><usage>registers</usage></addressBlock>
        </peripheral>
        <peripheral>
          <name>UART_ALT</name>
          <baseAddress>0xfe201000</baseAddress>
          <addressBlock><offset>0x0</offset><size>0x200</size><usage>registers</usage></addressBlock>
        </peripheral>
      </peripherals></device>
    `);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const hit = lookupCustomPeripheral(0xfe201010n, parsed.value);
    expect(hit).toMatchObject({
      kind: "ambiguous",
      baseAddress: "0xfe201000",
    });
    if (hit?.kind === "ambiguous") {
      expect(hit.candidates.map((c) => c.name)).toEqual(["PINMUX", "UART_ALT"]);
    }
  });
});
