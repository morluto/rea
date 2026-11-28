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

  it("preserves declared addressBlock bounds and narrow register widths without spilling into neighbors", () => {
    const parsed = parseCmsisSvd(`
      <device><name>NeighborSoc</name><peripherals>
        <peripheral>
          <name>P_NARROW</name>
          <baseAddress>0x40000000</baseAddress>
          <addressBlock><offset>0x0</offset><size>0x100</size><usage>registers</usage></addressBlock>
          <registers>
            <register>
              <name>TAIL16</name>
              <size>16</size>
              <addressOffset>0xfe</addressOffset>
            </register>
          </registers>
        </peripheral>
        <peripheral>
          <name>P_NEIGHBOR</name>
          <baseAddress>0x40000100</baseAddress>
          <addressBlock><offset>0x0</offset><size>0x200</size><usage>registers</usage></addressBlock>
          <registers>
            <register><name>CTRL</name><addressOffset>0x00</addressOffset></register>
          </registers>
        </peripheral>
      </peripherals></device>
    `);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const neighborHit = lookupCustomPeripheral(0x40000100n, parsed.value);
    expect(neighborHit?.kind).toBe("matched");
    if (neighborHit?.kind === "matched") {
      expect(neighborHit.peripheral.name).toBe("P_NEIGHBOR");
      expect(neighborHit.register?.mnemonic).toBe("P_NEIGHBOR_CTRL");
    }
  });
});

describe("CMSIS-SVD XML comments and iterative traversal", () => {
  it("ignores commented-out peripherals and registers when parsing XML", () => {
    const parsed = parseCmsisSvd(`
      <device><name>CommentedSvd</name><peripherals>
        <!--
        <peripheral>
          <name>UART0</name>
          <baseAddress>0x40009000</baseAddress>
          <registers>
            <register><name>OLD_DR</name><addressOffset>0x00</addressOffset></register>
          </registers>
        </peripheral>
        -->
        <peripheral>
          <name>UART0</name>
          <baseAddress>0x40001000</baseAddress>
          <registers>
            <!-- <register><name>GHOST</name><addressOffset>0x04</addressOffset></register> -->
            <register><name>DR</name><addressOffset>0x00</addressOffset></register>
          </registers>
        </peripheral>
      </peripherals></device>
    `);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.peripherals).toHaveLength(1);
    expect(parsed.value.peripherals[0]?.baseAddress).toBe("0x40001000");
    expect(
      parsed.value.peripherals[0]?.registers.map((r) => r.mnemonic),
    ).toEqual(["UART0_DR"]);
  });

  it("resolves long acyclic derivedFrom chains iteratively and bounds deep cluster nesting without stack overflow", () => {
    const chainLength = 2500;
    const periphs: string[] = [
      `<peripheral><name>P0</name><baseAddress>0x40000000</baseAddress><registers><register><name>SR</name><addressOffset>0x00</addressOffset></register></registers></peripheral>`,
    ];
    for (let i = 1; i < chainLength; i += 1) {
      const addr = (0x40000000 + i * 0x100).toString(16);
      periphs.push(
        `<peripheral derivedFrom="P${i - 1}"><name>P${i}</name><baseAddress>0x${addr}</baseAddress></peripheral>`,
      );
    }
    const longChain = parseCmsisSvd(
      `<device><name>DeepChain</name><peripherals>${periphs.join("")}</peripherals></device>`,
    );
    expect(longChain.ok).toBe(true);
    if (longChain.ok) {
      expect(longChain.value.peripherals).toHaveLength(chainLength);
      expect(
        longChain.value.peripherals[chainLength - 1]?.registers[0]?.mnemonic,
      ).toBe(`P${chainLength - 1}_SR`);
    }

    let nestedCluster = `<register><name>LEAF</name><addressOffset>0x0</addressOffset></register>`;
    for (let d = 0; d < 80; d += 1) {
      nestedCluster = `<cluster><name>C${d}</name><addressOffset>0x0</addressOffset>${nestedCluster}</cluster>`;
    }
    const deepClusters = parseCmsisSvd(
      `<device><name>DeepClusters</name><peripherals><peripheral><name>P0</name><baseAddress>0x40000000</baseAddress><registers>${nestedCluster}</registers></peripheral></peripherals></device>`,
    );
    expect(deepClusters.ok).toBe(false);
    if (!deepClusters.ok) {
      expect(deepClusters.error).toContain(
        "cluster nesting exceeds maximum depth",
      );
    }
  });

  it("handles regex metacharacters in SVD peripheral names literally without backtracking or throwing", () => {
    const longSuffix = `${"a".repeat(256)}!`;
    const parsed = parseCmsisSvd(`
      <device><name>LiteralPrefixSvd</name><peripherals>
        <peripheral>
          <name>(a+)+</name>
          <baseAddress>0x40000000</baseAddress>
          <registers>
            <register>
              <name>${longSuffix}</name>
              <description>(a+)+ ${longSuffix}</description>
              <addressOffset>0x00</addressOffset>
            </register>
          </registers>
        </peripheral>
        <peripheral derivedFrom="(a+)+">
          <name>A[</name>
          <baseAddress>0x40001000</baseAddress>
        </peripheral>
        <peripheral derivedFrom="A[">
          <name>B$</name>
          <baseAddress>0x40002000</baseAddress>
        </peripheral>
      </peripherals></device>
    `);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.peripherals).toHaveLength(3);
    expect(parsed.value.peripherals[1]?.registers[0]).toEqual({
      offset: 0n,
      mnemonic: `A[_${longSuffix}`,
      name: `A[ ${longSuffix}`,
    });
    expect(parsed.value.peripherals[2]?.registers[0]).toEqual({
      offset: 0n,
      mnemonic: `B$_${longSuffix}`,
      name: `B$ ${longSuffix}`,
    });
  });

  it("expands top-level peripheral dim arrays under the expansion budgets and resolves derived peripherals", () => {
    const parsed = parseCmsisSvd(`
      <device><name>PeriphArraySvd</name><peripherals>
        <peripheral>
          <dim>2</dim>
          <dimIncrement>0x400</dimIncrement>
          <dimIndex>A-B</dimIndex>
          <name>GPIO%s</name>
          <baseAddress>0x40020000</baseAddress>
          <addressBlock><offset>0x0</offset><size>0x400</size></addressBlock>
          <registers>
            <register><name>ODR</name><addressOffset>0x14</addressOffset></register>
          </registers>
        </peripheral>
        <peripheral derivedFrom="GPIO%s">
          <name>GPIOC</name>
          <baseAddress>0x40020800</baseAddress>
        </peripheral>
      </peripherals></device>
    `);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(
      parsed.value.peripherals.map((item) => ({
        name: item.name,
        base: item.baseAddress,
        reg: item.registers[0]?.mnemonic,
      })),
    ).toEqual([
      { name: "GPIOA", base: "0x40020000", reg: "GPIOA_ODR" },
      { name: "GPIOB", base: "0x40020400", reg: "GPIOB_ODR" },
      { name: "GPIOC", base: "0x40020800", reg: "GPIOC_ODR" },
    ]);
  });

  it("bounds expanded SVD description character growth before allocating repeated strings", () => {
    const bigDesc = "x".repeat(65536);
    const parsed = parseCmsisSvd(`
      <device><name>TextBomb</name><peripherals>
        <peripheral>
          <name>P0</name>
          <baseAddress>0x40000000</baseAddress>
          <registers>
            <cluster>
              <dim>32</dim>
              <dimIncrement>0x1000</dimIncrement>
              <name>CH%s</name>
              <addressOffset>0x0</addressOffset>
              <register>
                <dim>256</dim>
                <dimIncrement>0x4</dimIncrement>
                <name>REG%s</name>
                <description>${bigDesc}</description>
                <addressOffset>0x0</addressOffset>
              </register>
            </cluster>
          </registers>
        </peripheral>
      </peripherals></device>
    `);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain("exceeds maximum 16 MiB character budget");
    }
  });

  it("inherits register and cluster derivedFrom bit-widths without spilling into neighboring peripherals", () => {
    const parsed = parseCmsisSvd(`
      <device><name>RegDerivedSvd</name><size>32</size><peripherals>
        <peripheral>
          <name>P0</name>
          <baseAddress>0x1000</baseAddress>
          <registers>
            <register><name>R0</name><addressOffset>0x0</addressOffset><size>8</size></register>
            <register derivedFrom="R0"><name>R1</name><addressOffset>0x1</addressOffset></register>
          </registers>
        </peripheral>
        <peripheral>
          <name>P1</name>
          <baseAddress>0x1002</baseAddress>
          <registers>
            <cluster><name>C0</name><addressOffset>0x0</addressOffset><size>8</size>
              <register><name>B0</name><addressOffset>0x0</addressOffset></register>
            </cluster>
            <cluster derivedFrom="C0"><name>C1</name><addressOffset>0x1</addressOffset></cluster>
          </registers>
        </peripheral>
      </peripherals></device>
    `);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.peripherals[0]?.sizeBytes).toBe(2);
    expect(parsed.value.peripherals[1]?.sizeBytes).toBe(2);
    const p1Hit = lookupCustomPeripheral(0x1002n, parsed.value);
    expect(p1Hit?.kind).toBe("matched");
    if (p1Hit?.kind === "matched") {
      expect(p1Hit.peripheral.name).toBe("P1");
      expect(p1Hit.register?.mnemonic).toBe("P1_C0_B0");
    }
    const c1Hit = lookupCustomPeripheral(0x1003n, parsed.value);
    expect(c1Hit?.kind === "matched" ? c1Hit.register?.mnemonic : null).toBe(
      "P1_C1_B0",
    );

    const missingDerived = parseCmsisSvd(`
      <device><name>BadRegDerived</name><peripherals>
        <peripheral>
          <name>P0</name>
          <baseAddress>0x1000</baseAddress>
          <registers>
            <register derivedFrom="NO_SUCH_REG"><name>R1</name><addressOffset>0x0</addressOffset></register>
          </registers>
        </peripheral>
      </peripherals></device>
    `);
    expect(missingDerived.ok).toBe(false);
  });

  it("preserves non-zero and disjoint SVD addressBlock intervals without matching gaps", () => {
    const parsed = parseCmsisSvd(`
      <device><name>DisjointSvd</name><peripherals>
        <peripheral>
          <name>SPARSE_CTRL</name>
          <baseAddress>0x9000000</baseAddress>
          <addressBlock><offset>0x100</offset><size>0x100</size><usage>registers</usage></addressBlock>
          <addressBlock><offset>0x200</offset><size>0x200</size><usage>reserved</usage></addressBlock>
          <addressBlock><offset>0x400</offset><size>0x100</size><usage>registers</usage></addressBlock>
          <registers>
            <register><name>CFG</name><addressOffset>0x104</addressOffset></register>
            <register><name>STAT</name><addressOffset>0x400</addressOffset></register>
          </registers>
        </peripheral>
      </peripherals></device>
    `);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Undeclared prefix 0x000..0x0ff and reserved hole 0x200..0x3ff do not match
    expect(lookupCustomPeripheral(0x9000050n, parsed.value)).toBeNull();
    expect(lookupCustomPeripheral(0x9000250n, parsed.value)).toBeNull();
    const hitA = lookupCustomPeripheral(0x9000104n, parsed.value);
    const hitB = lookupCustomPeripheral(0x9000400n, parsed.value);
    expect(hitA?.kind === "matched" ? hitA.register?.mnemonic : null).toBe(
      "SPARSE_CTRL_CFG",
    );
    expect(hitB?.kind === "matched" ? hitB.register?.mnemonic : null).toBe(
      "SPARSE_CTRL_STAT",
    );
  });

  it("rejects large peripheral dim template arrays before expanding lookup keys", () => {
    const periphs = Array.from(
      { length: 256 },
      (_, idx) =>
        `<peripheral><dim>1024</dim><dimIncrement>0x100</dimIncrement><name>P${idx}_%s</name><baseAddress>0x${(0x40000000 + idx * 0x100000).toString(16)}</baseAddress><registers/></peripheral>`,
    ).join("");
    const parsed = parseCmsisSvd(
      `<device><name>KeyBomb</name><peripherals>${periphs}</peripherals></device>`,
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain("exceeds maximum 65536 steps");
    }
  });

  it("charges substituted dimIndex placeholder lengths before formatting register, peripheral, or lookup names", () => {
    const bigToken = "A".repeat(64 * 1024);
    const manyPlaceholders = `R_${"%s".repeat(512)}`;

    const regBomb = parseCmsisSvd(
      `<device><name>DimNameBomb</name><peripherals>
        <peripheral>
          <name>P0</name>
          <baseAddress>0x40000000</baseAddress>
          <registers>
            <register>
              <dim>2</dim>
              <dimIncrement>0x4</dimIncrement>
              <dimIndex>${bigToken},1</dimIndex>
              <name>${manyPlaceholders}</name>
              <addressOffset>0x0</addressOffset>
            </register>
          </registers>
        </peripheral>
      </peripherals></device>`,
    );
    expect(regBomb).toEqual({
      ok: false,
      error: "CMSIS-SVD expanded text exceeds maximum 16 MiB character budget",
    });

    const lookupBomb = parseCmsisSvd(
      `<device><name>LookupNameBomb</name><peripherals>
        <peripheral>
          <name>P0</name>
          <baseAddress>0x40000000</baseAddress>
          <registers>
            <register derivedFrom="R_TARGET"><name>CHILD</name><addressOffset>0x0</addressOffset></register>
            <register>
              <dim>2</dim>
              <dimIncrement>0x4</dimIncrement>
              <dimIndex>${bigToken},1</dimIndex>
              <name>${manyPlaceholders}</name>
              <addressOffset>0x10</addressOffset>
            </register>
          </registers>
        </peripheral>
      </peripherals></device>`,
    );
    expect(lookupBomb).toEqual({
      ok: false,
      error: "CMSIS-SVD expanded text exceeds maximum 16 MiB character budget",
    });

    const periphBomb = parseCmsisSvd(
      `<device><name>PeriphNameBomb</name><peripherals>
        <peripheral>
          <dim>2</dim>
          <dimIncrement>0x1000</dimIncrement>
          <dimIndex>${bigToken},1</dimIndex>
          <name>${manyPlaceholders}</name>
          <baseAddress>0x40000000</baseAddress>
          <registers/>
        </peripheral>
      </peripherals></device>`,
    );
    expect(periphBomb).toEqual({
      ok: false,
      error: "CMSIS-SVD expanded text exceeds maximum 16 MiB character budget",
    });
  });

  it("treats $-patterns in SVD dimIndex tokens literally without suffix expansion", () => {
    const parsed = parseCmsisSvd(`
      <device><name>DollarDim</name><peripherals>
        <peripheral>
          <name>P0</name>
          <baseAddress>0x40000000</baseAddress>
          <registers>
            <register>
              <dim>2</dim>
              <dimIncrement>0x4</dimIncrement>
              <dimIndex>$',$$</dimIndex>
              <name>REG_%s_SUFFIX</name>
              <addressOffset>0x0</addressOffset>
            </register>
          </registers>
        </peripheral>
      </peripherals></device>
    `);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(
      parsed.value.peripherals[0]?.registers.map((r) => r.mnemonic),
    ).toEqual(["P0_REG_$'_SUFFIX", "P0_REG_$$_SUFFIX"]);
  });

  it("carries the resolved peripheral scope across multi-hop register derivedFrom chains", () => {
    const parsed = parseCmsisSvd(`
      <device><name>CrossScopeDerived</name><size>32</size><peripherals>
        <peripheral>
          <name>P0</name>
          <baseAddress>0x40000000</baseAddress>
          <registers>
            <register><name>R0</name><addressOffset>0x0</addressOffset><size>8</size><description>P0 byte template</description></register>
            <register derivedFrom="R0"><name>R1</name><addressOffset>0x1</addressOffset></register>
          </registers>
        </peripheral>
        <peripheral>
          <name>P1</name>
          <baseAddress>0x40001000</baseAddress>
          <registers>
            <register><name>R0</name><addressOffset>0x0</addressOffset><size>32</size><description>P1 wide decoy</description></register>
            <register derivedFrom="P0.R1"><name>R2</name><addressOffset>0x4</addressOffset></register>
          </registers>
        </peripheral>
      </peripherals></device>
    `);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const p1 = parsed.value.peripherals.find((p) => p.name === "P1");
    expect(p1?.sizeBytes).toBe(5);
    const r2 = p1?.registers.find((r) => r.mnemonic === "P1_R2");
    expect(r2?.name).toBe("P1 P0 byte template");
  });

  it("rejects oversized or byte-mismatched Devicetree ranges cell widths without stalling", () => {
    const dt = sampleDevicetree();
    const oversizedCells = new Array<number>(1027).fill(1);
    const badBusNodes = dt.nodes.map((node) =>
      node.path === "/soc"
        ? {
            ...node,
            properties: [
              buildProp("compatible", { strings: ["simple-bus"] }),
              buildProp("#address-cells", { cells: [1024] }),
              buildProp("#size-cells", { cells: [1] }),
              buildProp("ranges", {
                bytes: oversizedCells.length * 4,
                cells: oversizedCells,
              }),
            ],
          }
        : node,
    );
    const oversizedResult = hardwareProfileFromDevicetree({
      ...dt,
      nodes: badBusNodes,
      coverage: {
        ...dt.coverage,
        examined_nodes: badBusNodes.length,
      },
    });
    expect(oversizedResult.ok).toBe(true);
    if (oversizedResult.ok) {
      expect(
        oversizedResult.value.limitations.some((line) =>
          line.includes("ranges at /soc has unsupported cell widths."),
        ),
      ).toBe(true);
    }

    const mismatchedNodes = dt.nodes.map((node) =>
      node.path === "/soc"
        ? {
            ...node,
            properties: [
              buildProp("compatible", { strings: ["simple-bus"] }),
              buildProp("#address-cells", { cells: [1] }),
              buildProp("#size-cells", { cells: [1] }),
              buildProp("ranges", {
                bytes: 32,
                cells: [0x7e000000, 0x0, 0xfe000000, 0x01800000],
              }),
            ],
          }
        : node,
    );
    const mismatchedResult = hardwareProfileFromDevicetree({
      ...dt,
      nodes: mismatchedNodes,
      coverage: {
        ...dt.coverage,
        examined_nodes: mismatchedNodes.length,
      },
    });
    expect(mismatchedResult.ok).toBe(true);
    if (mismatchedResult.ok) {
      expect(
        mismatchedResult.value.limitations.some((line) =>
          line.includes("ranges at /soc has mismatched cell and byte counts."),
        ),
      ).toBe(true);
    }
  });

  it("rejects repeated inherited addressBlock expansions before scanning millions of intervals", () => {
    const blocks = Array.from(
      { length: 2048 },
      (_, idx) =>
        `<addressBlock><offset>0x${(idx * 4).toString(16)}</offset><size>0x4</size></addressBlock>`,
    ).join("");
    const derived = Array.from(
      { length: 40 },
      (_, idx) =>
        `<peripheral derivedFrom="BASE"><dim>4</dim><dimIncrement>0x10000</dimIncrement><name>D${idx}_%s</name><baseAddress>0x${(0x40000000 + idx * 0x100000).toString(16)}</baseAddress></peripheral>`,
    ).join("");
    const parsed = parseCmsisSvd(
      `<device><name>BlockFanout</name><peripherals>
        <peripheral><name>BASE</name><baseAddress>0x30000000</baseAddress>${blocks}<registers/></peripheral>
        ${derived}
      </peripherals></device>`,
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain("exceeds maximum 65536 steps");
    }
  });
});
