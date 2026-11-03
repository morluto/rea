import { describe, expect, it } from "vitest";
import {
  HARDWARE_CLAIM_RULES,
  decideHardwareClaim,
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
});
