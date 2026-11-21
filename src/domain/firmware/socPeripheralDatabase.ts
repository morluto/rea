import { z } from "zod";
import { espChipForId } from "./espChips.js";
import type { HardwareArchitecture } from "./hardwareMemoryMap.js";
import { uf2FamilyName } from "./uf2Families.js";
import {
  ESP32_PERIPHERALS,
  ESP32C2_PERIPHERALS,
  ESP32C3_PERIPHERALS,
  ESP32C6_PERIPHERALS,
  ESP32H2_PERIPHERALS,
  ESP32S2_PERIPHERALS,
  ESP32S3_PERIPHERALS,
} from "./socCatalogs/espCatalogs.js";
import {
  CH32V30X_PERIPHERALS,
  GD32VF103_PERIPHERALS,
  NRF52_PERIPHERALS,
  RP2040_PERIPHERALS,
  SAMD21_PERIPHERALS,
} from "./socCatalogs/mcuCatalogs.js";
import {
  GD32F1_PERIPHERALS,
  GD32F4_PERIPHERALS,
  STM32F1_PERIPHERALS,
  STM32F4_PERIPHERALS,
  STM32H7_PERIPHERALS,
  STM32L4_PERIPHERALS,
} from "./socCatalogs/stm32Catalogs.js";
import {
  PERIPHERAL_BUS_KINDS,
  type InternalPeripheralEntry,
  type PeripheralBusKind,
} from "./socCatalogs/types.js";

export type { PeripheralBusKind } from "./socCatalogs/types.js";

/** Supported microcontroller and SoC platform families. */
export const SOC_PLATFORMS = [
  "stm32f1",
  "stm32f4",
  "stm32l4",
  "stm32h7",
  "gd32f1",
  "gd32f4",
  "rp2040",
  "nrf52",
  "samd21",
  "esp32",
  "esp32s2",
  "esp32s3",
  "esp32c2",
  "esp32c3",
  "esp32c6",
  "esp32h2",
  "gd32vf103",
  "ch32v30x",
] as const;
export type SocPlatform = (typeof SOC_PLATFORMS)[number];
export const socPlatformSchema = z.enum(SOC_PLATFORMS);

/** Definition for a known SoC peripheral controller block. */
export interface SocPeripheralDefinition {
  readonly platform: SocPlatform;
  readonly name: string;
  readonly baseAddress: string;
  readonly baseAddressValue: bigint;
  readonly sizeBytes: number;
  readonly bus: PeripheralBusKind;
  readonly description: string;
}

export const socPeripheralDefinitionSchema = z.strictObject({
  platform: socPlatformSchema,
  name: z.string(),
  baseAddress: z.string(),
  baseAddressValue: z.bigint(),
  sizeBytes: z.number().int().positive(),
  bus: z.enum(PERIPHERAL_BUS_KINDS),
  description: z.string(),
});

/** Hardware-manual address alias resolved for a specific SoC platform. */
export const SOC_REGISTER_ALIAS_KINDS = [
  "bitband",
  "atomic_xor",
  "atomic_set",
  "atomic_clr",
] as const;
export type SocRegisterAliasKind = (typeof SOC_REGISTER_ALIAS_KINDS)[number];

export interface SocRegisterAliasResolution {
  readonly kind: SocRegisterAliasKind;
  readonly canonicalAddress: string;
  readonly canonicalAddressValue: bigint;
  readonly registerOffset: string;
  readonly registerOffsetValue: bigint;
  readonly bit: number | null;
  readonly peripheral: SocPeripheralDefinition;
}

const PLATFORM_PERIPHERALS: Readonly<
  Record<SocPlatform, readonly InternalPeripheralEntry[]>
> = {
  stm32f1: STM32F1_PERIPHERALS,
  stm32f4: STM32F4_PERIPHERALS,
  stm32l4: STM32L4_PERIPHERALS,
  stm32h7: STM32H7_PERIPHERALS,
  gd32f1: GD32F1_PERIPHERALS,
  gd32f4: GD32F4_PERIPHERALS,
  rp2040: RP2040_PERIPHERALS,
  nrf52: NRF52_PERIPHERALS,
  samd21: SAMD21_PERIPHERALS,
  esp32: ESP32_PERIPHERALS,
  esp32s2: ESP32S2_PERIPHERALS,
  esp32s3: ESP32S3_PERIPHERALS,
  esp32c2: ESP32C2_PERIPHERALS,
  esp32c3: ESP32C3_PERIPHERALS,
  esp32c6: ESP32C6_PERIPHERALS,
  esp32h2: ESP32H2_PERIPHERALS,
  gd32vf103: GD32VF103_PERIPHERALS,
  ch32v30x: CH32V30X_PERIPHERALS,
};

/** CPU families whose memory maps can contain each catalog. */
export const PLATFORM_CPU: Readonly<
  Record<SocPlatform, readonly HardwareArchitecture[]>
> = {
  stm32f1: ["arm", "cortex-m"],
  stm32f4: ["arm", "cortex-m"],
  stm32l4: ["arm", "cortex-m"],
  stm32h7: ["arm", "cortex-m"],
  gd32f1: ["arm", "cortex-m"],
  gd32f4: ["arm", "cortex-m"],
  rp2040: ["arm", "cortex-m"],
  nrf52: ["arm", "cortex-m"],
  samd21: ["arm", "cortex-m"],
  esp32: ["xtensa"],
  esp32s2: ["xtensa"],
  esp32s3: ["xtensa"],
  esp32c2: ["riscv"],
  esp32c3: ["riscv"],
  esp32c6: ["riscv"],
  esp32h2: ["riscv"],
  gd32vf103: ["riscv"],
  ch32v30x: ["riscv"],
};

/** Platforms whose reference manual defines Cortex-M3/M4 peripheral bit-band aliases at 0x42000000..0x43ffffff. */
const BITBAND_PLATFORMS: ReadonlySet<SocPlatform> = new Set([
  "stm32f1",
  "stm32f4",
  "stm32l4",
  "gd32f1",
  "gd32f4",
]);

const HEX_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{1,16}$/u;

const parseHexOrBigInt = (rawAddress: string | bigint): bigint | null => {
  if (typeof rawAddress === "bigint")
    return rawAddress < 0n ? null : rawAddress;
  if (typeof rawAddress !== "string" || !HEX_ADDRESS_PATTERN.test(rawAddress)) {
    return null;
  }
  try {
    return BigInt(rawAddress);
  } catch {
    return null;
  }
};

const matchesEntry = (
  address: bigint,
  item: InternalPeripheralEntry,
): boolean => {
  if (address < item.base || address >= item.base + BigInt(item.size)) {
    return false;
  }
  if (item.aliasPageRegisterBytes === undefined) return true;
  const pageOffset = (address - item.base) & 0xfffn;
  return pageOffset < BigInt(item.aliasPageRegisterBytes);
};

/**
 * Resolve an address to a known SoC peripheral controller block on a given platform.
 * Returns null if the address does not match any peripheral block in the platform dictionary.
 */
export const lookupSocPeripheral = (
  rawAddress: string | bigint,
  platform: SocPlatform,
): SocPeripheralDefinition | null => {
  const addressBigInt = parseHexOrBigInt(rawAddress);
  if (addressBigInt === null) return null;

  const entries = PLATFORM_PERIPHERALS[platform];
  for (const item of entries) {
    if (matchesEntry(addressBigInt, item)) {
      return {
        platform,
        name: item.name,
        baseAddress: `0x${item.base.toString(16)}`,
        baseAddressValue: item.base,
        sizeBytes: item.size,
        bus: item.bus,
        description: item.description,
      };
    }
  }
  return null;
};

/**
 * Resolve SoC-manual hardware register aliases (Cortex-M3/M4 peripheral bit-band
 * aliases at 0x42000000..0x43ffffff and RP2040 atomic XOR/SET/CLR pages).
 */
export const resolveSocRegisterAlias = (
  rawAddress: string | bigint,
  platform: SocPlatform,
): SocRegisterAliasResolution | null => {
  const address = parseHexOrBigInt(rawAddress);
  if (address === null) return null;

  if (
    BITBAND_PLATFORMS.has(platform) &&
    address >= 0x42000000n &&
    address <= 0x43ffffffn &&
    (address & 3n) === 0n
  ) {
    const bitWordOffset = address - 0x42000000n;
    const byteAddress = 0x40000000n + (bitWordOffset >> 5n);
    const canonicalValue = byteAddress & ~3n;
    const bitInByte = Number((bitWordOffset >> 2n) & 7n);
    const bit = Number((byteAddress & 3n) * 8n) + bitInByte;
    const peripheral = lookupSocPeripheral(canonicalValue, platform);
    if (peripheral === null) return null;
    const regOffset = canonicalValue - peripheral.baseAddressValue;
    return {
      kind: "bitband",
      canonicalAddress: `0x${canonicalValue.toString(16)}`,
      canonicalAddressValue: canonicalValue,
      registerOffset: `0x${regOffset.toString(16)}`,
      registerOffsetValue: regOffset,
      bit,
      peripheral,
    };
  }

  if (platform === "rp2040") {
    for (const item of RP2040_PERIPHERALS) {
      if (item.aliasPageRegisterBytes === undefined) continue;
      if (!matchesEntry(address, item)) continue;
      const slotOffset = address - item.base;
      const pageIndex = Number(slotOffset >> 12n);
      if (pageIndex === 0) return null;
      const kind: SocRegisterAliasKind =
        pageIndex === 1
          ? "atomic_xor"
          : pageIndex === 2
            ? "atomic_set"
            : "atomic_clr";
      const regOffset = slotOffset & 0xfffn;
      const canonicalValue = item.base + regOffset;
      return {
        kind,
        canonicalAddress: `0x${canonicalValue.toString(16)}`,
        canonicalAddressValue: canonicalValue,
        registerOffset: `0x${regOffset.toString(16)}`,
        registerOffsetValue: regOffset,
        bit: null,
        peripheral: {
          platform,
          name: item.name,
          baseAddress: `0x${item.base.toString(16)}`,
          baseAddressValue: item.base,
          sizeBytes: item.size,
          bus: item.bus,
          description: item.description,
        },
      };
    }
  }
  return null;
};

/** Candidate SoC platform matching evaluation. */
export interface SocPlatformMatchCandidate {
  readonly platform: SocPlatform;
  readonly matchedCount: number;
  readonly totalAddresses: number;
  readonly confidence: number;
  readonly matchedPeripherals: readonly string[];
}

/**
 * Rank SoC catalogs against observed addresses.
 * Catalogs whose CPU does not match `architecture` are ignored. Callers must not
 * treat the first row as a decision when several catalogs share that match count.
 */
export const detectSocPlatform = (
  addresses: readonly string[],
  architecture?: HardwareArchitecture,
): readonly SocPlatformMatchCandidate[] => {
  const platforms =
    architecture === undefined
      ? SOC_PLATFORMS
      : SOC_PLATFORMS.filter((platform) =>
          PLATFORM_CPU[platform].includes(architecture),
        );
  if (addresses.length === 0 || platforms.length === 0) return [];

  const hits = new Map<SocPlatform, { count: number; names: Set<string> }>(
    platforms.map((platform) => [platform, { count: 0, names: new Set() }]),
  );
  let relevantAddresses = 0;

  for (const address of addresses) {
    let relevant = false;
    for (const platform of platforms) {
      const match =
        lookupSocPeripheral(address, platform) ??
        resolveSocRegisterAlias(address, platform)?.peripheral ??
        null;
      const bucket = hits.get(platform);
      if (match === null || bucket === undefined) continue;
      relevant = true;
      bucket.count += 1;
      bucket.names.add(match.name);
    }
    if (relevant) relevantAddresses += 1;
  }

  if (relevantAddresses === 0) return [];

  const candidates: SocPlatformMatchCandidate[] = [];
  for (const platform of platforms) {
    const bucket = hits.get(platform);
    if (bucket === undefined || bucket.count === 0) continue;
    candidates.push({
      platform,
      matchedCount: bucket.count,
      totalAddresses: relevantAddresses,
      confidence: Number((bucket.count / relevantAddresses).toFixed(3)),
      matchedPeripherals: Array.from(bucket.names).sort(),
    });
  }

  return candidates.sort(
    (left, right) => right.matchedCount - left.matchedCount,
  );
};

/** Map an ESP image header `chip_id` (ESP-IDF v6.1) to a catalogued `SocPlatform`, or null when uncatalogued. */
export const socPlatformForEspChipId = (chipId: number): SocPlatform | null => {
  const chip = espChipForId(chipId);
  if (chip === undefined) return null;
  return (SOC_PLATFORMS as readonly string[]).includes(chip.target)
    ? (chip.target as SocPlatform)
    : null;
};

const UF2_FAMILY_TO_SOC: Readonly<Record<string, SocPlatform>> = {
  ESP32: "esp32",
  ESP32S2: "esp32s2",
  ESP32S3: "esp32s3",
  ESP32C2: "esp32c2",
  ESP32C3: "esp32c3",
  ESP32C6: "esp32c6",
  ESP32H2: "esp32h2",
  RP2040: "rp2040",
  STM32F4: "stm32f4",
  NRF52840: "nrf52",
  SAMD21: "samd21",
};

/** Additional Microsoft UF2 registry family IDs (`utils/uf2families.json`) for catalogued MCUs. */
const UF2_DIRECT_FAMILY_TO_SOC: ReadonlyMap<number, SocPlatform> = new Map([
  [0x5ee2_1072, "stm32f1"],
  [0x00ff_6919, "stm32l4"],
  [0x6db6_6082, "stm32h7"],
  [0x1b57_745f, "nrf52"],
  [0x9af0_3e33, "gd32vf103"],
  [0x699b_62ec, "ch32v30x"],
]);

/** Map a Microsoft UF2 `familyId` to a catalogued `SocPlatform`, or null when uncatalogued. */
export const socPlatformForUf2FamilyId = (
  familyId: number,
): SocPlatform | null => {
  const name = uf2FamilyName(familyId);
  if (name !== null && UF2_FAMILY_TO_SOC[name] !== undefined) {
    return UF2_FAMILY_TO_SOC[name];
  }
  return UF2_DIRECT_FAMILY_TO_SOC.get(familyId) ?? null;
};
