import { describe, expect, it } from "vitest";
import {
  HARDWARE_CLAIM_RULES,
  decideHardwareClaim,
  hardwareClaimsForBlocks,
} from "./hardwareFactBasis.js";

describe("hardware claim rules", () => {
  it("keeps one basis for every hardware rule", () => {
    expect(HARDWARE_CLAIM_RULES).toEqual([
      "observed-address",
      "chip-manual-name",
      "architecture-register",
      "explicit-profile",
      "instruction-decode",
      "installed-part",
      "driver-linkage",
      "board-record",
    ]);
  });

  it("names a controller only from an address the instruction accessed", () => {
    expect(
      decideHardwareClaim({
        rule: "observed-address",
        addressSeen: true,
        fromRoundedPage: true,
      }),
    ).toMatchObject({ basis: "unsettled", settled: false });
    expect(
      decideHardwareClaim({ rule: "chip-manual-name", addressHit: true }),
    ).toMatchObject({ basis: "chip_manual", settled: true });
    expect(
      decideHardwareClaim({ rule: "chip-manual-name", addressHit: false }),
    ).toMatchObject({ basis: "unsettled", settled: false });
  });

  it("requires a caller profile for board windows and leaves rival parts open", () => {
    expect(
      decideHardwareClaim({
        rule: "architecture-register",
        architectureHit: true,
        placementIsBoardSpecific: false,
      }).basis,
    ).toBe("architecture_manual");
    expect(
      decideHardwareClaim({
        rule: "explicit-profile",
        profileSelected: false,
      }),
    ).toMatchObject({ basis: "unsettled", settled: false });
    expect(
      decideHardwareClaim({
        rule: "instruction-decode",
        decodedByInstruction: true,
      }).basis,
    ).toBe("instruction");
    expect(
      decideHardwareClaim({
        rule: "installed-part",
        tableNames: ["W25Q64CV", "W25Q128BV"],
        deviceName: "W25Q128",
      }),
    ).toMatchObject({ basis: "unsettled", settled: false });
    expect(
      decideHardwareClaim({
        rule: "driver-linkage",
        stringPresent: true,
        usedAsBootProof: true,
      }).settled,
    ).toBe(false);
  });

  it("keeps each open fact on its own rule, with its subject and source", () => {
    const claims = hardwareClaimsForBlocks({
      blocks: [
        {
          blockBase: "0x40011000",
          matched: true,
          addresses: ["0x40011000"],
        },
      ],
      devices: [
        {
          id: "led-b",
          name: "LED_B",
          evidence:
            "README places LED_B on PF11 and describes the color as green.",
          peripheralName: "GPIOF",
          uncertainty:
            "The silkscreen-style name is LED_B and the README color text is green. Both are kept.",
        },
        {
          id: "spi-flash",
          name: "SPI flash",
          evidence: "README lists an external SPI flash.",
          peripheralName: "SPI2",
          uncertainty:
            "README calls the part W25Q128 and 16MB. The BSP port probes W25Q64.",
          partNames: ["W25Q128", "W25Q64"],
        },
      ],
      drivers: [
        {
          id: "serial-usart1",
          evidence:
            "Image e2c7d06f5c3a9c0e12e220dcd7335110b447bce2310263ad668c1729ed828776: contains uart1.",
          linked: true,
        },
      ],
    });

    expect(claims.find((claim) => claim.subject === "led-b")).toMatchObject({
      rule: "board-record",
      basis: "unsettled",
      settled: false,
      source: "README places LED_B on PF11 and describes the color as green.",
      reason:
        "The silkscreen-style name is LED_B and the README color text is green. Both are kept.",
    });
    expect(claims.find((claim) => claim.subject === "spi-flash")).toMatchObject(
      {
        rule: "installed-part",
        basis: "unsettled",
        source: "README lists an external SPI flash.",
        reason:
          "README calls the part W25Q128 and 16MB. The BSP port probes W25Q64.",
      },
    );
    expect(
      claims.find((claim) => claim.subject === "serial-usart1"),
    ).toMatchObject({
      rule: "driver-linkage",
      source:
        "Image e2c7d06f5c3a9c0e12e220dcd7335110b447bce2310263ad668c1729ed828776: contains uart1.",
    });
    expect(
      claims.find((claim) => claim.subject === "0x40011000"),
    ).toMatchObject({
      rule: "chip-manual-name",
      basis: "chip_manual",
      source: "0x40011000",
    });
  });
});
