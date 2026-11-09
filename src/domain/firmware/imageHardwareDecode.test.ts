import { describe, expect, it } from "vitest";
import { hardwareClaimsFromImage } from "./imageHardwareDecode.js";

describe("image hardware decode", () => {
  it("names an STM32F1 pin from the caller origin and leaves the role open", () => {
    const claims = hardwareClaimsFromImage({
      architecture: null,
      platform: "stm32f1",
      pinPlacement: { origin: 0x40010800n, stride: 0x400n, portLimit: 7 },
      vectors: [],
      observations: [
        { kind: "pin-index", site: "f1-pin-a", index: 0n },
        { kind: "pin-index", site: "f1-pin-b", index: 0x10n },
        { kind: "bus-name", site: "f1-bus", name: "spi2" },
        { kind: "vector-slot", site: "f1-vec", index: 4 },
      ],
    });

    expect(
      claims.find((claim) => claim.subject === "pin-base:0x0"),
    ).toMatchObject({ source: "0x40010800", settled: true });
    expect(
      claims.find((claim) => claim.subject === "pin-name:0x0"),
    ).toMatchObject({ source: "f1-pin-a GPIOA", basis: "chip_manual" });
    expect(
      claims.find((claim) => claim.subject === "pin-base:0x10"),
    ).toMatchObject({ source: "0x40010c00" });
    expect(
      claims.find((claim) => claim.subject === "pin-name:0x10"),
    ).toMatchObject({ source: "f1-pin-b GPIOB" });
    expect(
      claims.find((claim) => claim.subject === "gpio-role:0:0"),
    ).toMatchObject({ settled: false, rule: "board-record" });
    expect(claims.find((claim) => claim.subject === "spi2")).toMatchObject({
      rule: "driver-linkage",
      source: "f1-bus",
    });
    expect(claims.some((claim) => claim.subject === "SPI2")).toBe(false);
    expect(claims.find((claim) => claim.subject === "vector:4")).toMatchObject({
      settled: false,
      basis: "unsettled",
    });
  });

  it("keeps a support table and a missing clock switch unsettled", () => {
    const claims = hardwareClaimsFromImage({
      architecture: "cortex-m",
      platform: "stm32f4",
      pinPlacement: null,
      vectors: [{ index: 16, rule: "chip-manual-name", name: "WWDG" }],
      observations: [
        {
          kind: "loaded-address",
          site: "0x080604ec",
          address: 0x40023830n,
          fromRoundedPage: false,
        },
        {
          kind: "sfud-table",
          tableAddress: "0x080a4588",
          deviceName: "W25Q128",
          rows: [
            {
              address: "0x080a4588",
              name: "W25Q16BV",
              jedec: 0xef4015n,
              capacity: 0x200000n,
            },
            {
              address: "0x080a45e8",
              name: "W25Q128BV",
              jedec: 0xef4018n,
              capacity: 0x1000000n,
            },
          ],
        },
        {
          kind: "pll-immediate",
          site: "0x0800c704",
          value: 0x24003010n,
          fields: [
            { name: "PLLM", shift: 0, width: 6 },
            { name: "PLLN", shift: 6, width: 9 },
            { name: "PLLP", shift: 16, width: 2 },
            { name: "PLLSRC", shift: 22, width: 1 },
            { name: "PLLQ", shift: 24, width: 4 },
          ],
          clockSwitch: null,
        },
        { kind: "vector-slot", site: "0x08000040", index: 16 },
        { kind: "bus-name", site: "uart2-site", name: "uart2" },
      ],
    });

    expect(claims.find((claim) => claim.subject === "RCC")).toMatchObject({
      rule: "chip-manual-name",
      basis: "chip_manual",
      source: "0x080604ec",
    });
    expect(
      claims.find((claim) => claim.subject === "spi-flash-part"),
    ).toMatchObject({
      settled: false,
      reason: expect.stringContaining(
        "W25Q16BV, W25Q128BV. A supported chip is not the installed part.",
      ),
    });
    expect(
      claims.find((claim) => claim.subject === "pll:0x0800c704:PLLN"),
    ).toMatchObject({ source: "0x24003010=192" });
    expect(
      claims.find((claim) => claim.subject === "pll:0x0800c704:PLLP"),
    ).toMatchObject({ source: "0x24003010=0" });
    expect(
      claims.find((claim) => claim.subject === "pll:0x0800c704:PLLQ"),
    ).toMatchObject({ source: "0x24003010=4" });
    expect(
      claims.find((claim) => claim.subject === "pll-frequency:0x0800c704"),
    ).toMatchObject({ settled: false });
    expect(claims.find((claim) => claim.subject === "WWDG")).toMatchObject({
      rule: "chip-manual-name",
      basis: "chip_manual",
    });
    expect(claims.find((claim) => claim.subject === "uart2")).toMatchObject({
      rule: "driver-linkage",
    });
    expect(claims.some((claim) => claim.subject === "USART2")).toBe(false);
  });
});
