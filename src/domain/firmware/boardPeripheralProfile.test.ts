import { describe, expect, it } from "vitest";
import {
  BOARD_IDS,
  boardDevicesForPeripheral,
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

describe("multi-vendor board peripheral profiles", () => {
  it("validates every built-in board profile schema and non-overlapping memory windows", () => {
    for (const boardId of BOARD_IDS) {
      const profile = lookupBoardProfile(boardId);
      expect(profile).not.toBeNull();
      if (profile === null) continue;
      expect(boardPeripheralProfileSchema.safeParse(profile).success).toBe(
        true,
      );
      const sorted = [...profile.memory].sort((left, right) =>
        left.baseAddressValue < right.baseAddressValue ? -1 : 1,
      );
      for (let idx = 1; idx < sorted.length; idx += 1) {
        const prev = sorted[idx - 1];
        const curr = sorted[idx];
        if (prev === undefined || curr === undefined) continue;
        expect(
          prev.baseAddressValue + BigInt(prev.sizeBytes),
        ).toBeLessThanOrEqual(curr.baseAddressValue);
      }
    }
  });

  it("isolates captured-image drivers and boot observations to stm32f407-rt-spark", () => {
    const rtSpark = lookupBoardProfile("stm32f407-rt-spark");
    expect(rtSpark?.imageSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(rtSpark?.driverRecoveries.length).toBeGreaterThan(0);

    for (const boardId of [
      "stm32f103c8-bluepill",
      "rp2040-pico",
      "nrf52840-dk",
      "esp32c3-devkitm-1",
      "esp32s3-devkitc-1",
    ] as const) {
      const board = lookupBoardProfile(boardId);
      expect(board?.imageSha256).toBeNull();
      expect(board?.drivers).toEqual([]);
      expect(board?.driverRecoveries).toEqual([]);
      expect(board?.imageObservations).toBeNull();
    }

    const pico = lookupBoardProfile("rp2040-pico");
    expect(pico).not.toBeNull();
    if (pico === null) return;
    expect(
      boardDevicesForPeripheral(pico, "SIO").map((item) => item.id),
    ).toContain("onboard-led");

    const s3 = lookupBoardProfile("esp32s3-devkitc-1");
    expect(s3).not.toBeNull();
    if (s3 === null) return;
    expect(boardDevicesForPeripheral(s3, "USB_SERIAL_JTAG")[0]?.id).toBe(
      "native-usb-port",
    );
  });
});
