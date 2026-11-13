import { describe, expect, it } from "vitest";
import {
  boardPeripheralProfileSchema,
  lookupBoardMemoryWindow,
  lookupBoardProfile,
  unboundBoardDevices,
} from "./boardPeripheralProfile.js";

describe("RT-Spark board profile", () => {
  const profile = lookupBoardProfile("stm32f407-rt-spark");

  it("records the STM32F407ZGT6 profile from the RT-Thread BSP", () => {
    expect(profile).not.toBeNull();
    if (profile === null) return;
    expect(profile.soc).toBe("stm32f4");
    expect(profile.mcu).toBe("STM32F407ZGT6");
    expect(boardPeripheralProfileSchema.safeParse(profile).success).toBe(true);
    expect(lookupBoardProfile("unknown-board")).toBeNull();
  });

  it("keeps the SPI flash part disagreement and the SPI2 chip select", () => {
    const flash = profile?.devices.find((device) => device.id === "spi-flash");
    expect(flash).toMatchObject({
      peripheralName: "SPI2",
      pins: ["PB12"],
      kconfigDefault: false,
    });
    expect(flash?.evidence).toContain("W25Q64");
    expect(flash?.uncertainty).toContain("W25Q128");
  });

  it("places populated LEDs and keys on their GPIO ports", () => {
    const leds = profile?.devices.filter(
      (device) =>
        device.peripheralName === "GPIOF" && device.kind === "listed_resource",
    );
    expect(leds?.map((device) => device.pins[0])).toEqual(["PF12", "PF11"]);
    const keys = profile?.devices.filter((device) =>
      device.id.startsWith("key-"),
    );
    expect(keys?.map((device) => device.pins[0])).toEqual([
      "PC5",
      "PC1",
      "PC0",
      "PC4",
    ]);
  });

  it("does not bind software I2C devices or USB to the on-chip I2C and OTG blocks", () => {
    const onChipI2c = profile?.devices.filter(
      (device) =>
        device.peripheralName === "I2C1" ||
        device.peripheralName === "I2C2" ||
        device.peripheralName === "I2C3",
    );
    expect(onChipI2c).toEqual([]);
    expect(
      profile?.devices.find((device) => device.id === "i2c-eeprom")?.pins,
    ).toEqual(["PB8", "PB9"]);
    const unbound = profile === null ? [] : unboundBoardDevices(profile);
    expect(unbound.map((device) => device.id)).toEqual([
      "usb-device",
      "usb-host",
    ]);
  });

  it("sizes flash, main SRAM, and CCM without overlapping those windows", () => {
    expect(profile?.memory.map((item) => [item.id, item.sizeBytes])).toEqual([
      ["internal-flash", 1024 * 1024],
      ["ccm", 64 * 1024],
      ["main-sram", 128 * 1024],
    ]);
    if (profile === null) return;
    expect(lookupBoardMemoryWindow(profile, 0x08000000n)?.id).toBe(
      "internal-flash",
    );
    expect(lookupBoardMemoryWindow(profile, 0x10000010n)?.id).toBe("ccm");
    expect(lookupBoardMemoryWindow(profile, 0x2001ffffn)?.id).toBe("main-sram");
    expect(lookupBoardMemoryWindow(profile, 0x20020000n)).toBeNull();
    expect(lookupBoardMemoryWindow(profile, 0x40011000n)).toBeNull();
  });
});
