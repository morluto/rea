import {
  classifyHardwareMemoryAddress,
  type HardwareArchitecture,
  type HardwareMemoryRegionKind,
} from "./hardwareMemoryMap.js";
import {
  lookupCustomPeripheral,
  type CustomHardwareProfile,
} from "./hardwareCustomProfile.js";
import {
  controllerNameBasis,
  registerNameBasis,
  type ControllerNameBasis,
  type RegisterNameBasis,
} from "./hardwareFactBasis.js";
import { lookupHardwareRegister } from "./hardwareRegisterCatalog.js";
import {
  lookupSocPeripheral,
  resolveSocRegisterAlias,
  type SocPlatform,
  type SocRegisterAliasKind,
} from "./socPeripheralDatabase.js";
import { lookupSocPeripheralRegister } from "./socPeripheralRegisters.js";
import { ok, type Result } from "../result.js";

/** Minimal input reference contract representing an analyzed instruction reference. */
export interface AnalyzedInstructionReference {
  readonly target_address: string;
  readonly type?: string;
  readonly call?: boolean;
  readonly jump?: boolean;
  readonly data?: boolean | null;
  readonly read?: boolean | null;
  readonly write?: boolean | null;
  readonly source_address?: string | null;
  readonly operand_index?: number;
  readonly provenance?: string | null;
}

/** Access direction observed from the instruction reference. */
export type HardwareAccessKind = "read" | "write" | "read_write" | "unknown";

/** Resolved hardware alias details when an access uses bit-banding or atomic alias pages. */
export interface HardwareRegisterAlias {
  readonly kind: SocRegisterAliasKind;
  readonly canonicalAddress: string;
  readonly registerOffset: string;
  readonly bit: number | null;
}

/** Structured hardware peripheral attribution for an analyzed instruction reference. */
export interface HardwareAccessAttribution {
  readonly targetAddress: string;
  readonly addressValue: bigint;
  readonly architecture: HardwareArchitecture;
  readonly regionKind: HardwareMemoryRegionKind;
  readonly regionName: string;
  readonly isMmio: boolean;
  readonly accessKind: HardwareAccessKind;
  readonly peripheralBlockBase: string;
  readonly peripheralBlockOffset: string;
  readonly controllerName: string | null;
  readonly controllerBasis: ControllerNameBasis;
  readonly registerName?: string | null;
  readonly registerMnemonic?: string | null;
  readonly registerBasis: RegisterNameBasis;
  readonly registerAlias?: HardwareRegisterAlias | null;
  readonly sourceAddress?: string | null;
  readonly operandIndex?: number | null;
  readonly provenance?: string | null;
}

/** Summarized hardware peripheral block with observed register accesses. */
export interface HardwarePeripheralBlockSummary {
  readonly blockBase: string;
  readonly regionName: string;
  readonly regionKind: HardwareMemoryRegionKind;
  readonly totalAccesses: number;
  readonly readCount: number;
  readonly writeCount: number;
  readonly uniqueAddresses: readonly string[];
  readonly observedOffsets: readonly string[];
  readonly knownRegisters: readonly string[];
}

/** Complete aggregated summary of hardware peripheral interactions. */
export interface HardwarePeripheralAttributionSummary {
  readonly architecture: HardwareArchitecture;
  readonly totalReferencesExamined: number;
  readonly mmioAccessCount: number;
  readonly nonMmioAccessCount: number;
  readonly peripheralBlocks: readonly HardwarePeripheralBlockSummary[];
}

const deriveAccessKind = (
  read?: boolean | null,
  write?: boolean | null,
): HardwareAccessKind => {
  if (read === true && write === true) return "read_write";
  if (write === true) return "write";
  if (read === true) return "read";
  return "unknown";
};

/**
 * Attribute an analyzed instruction reference to its underlying hardware memory
 * region, calculating peripheral block coordinates, SoC/custom register mnemonics,
 * and hardware register aliases (bit-banding / RP2040 atomic pages).
 */
export const attributeHardwareAccess = (
  reference: AnalyzedInstructionReference,
  architecture: HardwareArchitecture,
  platform?: SocPlatform | null,
  customProfile?: CustomHardwareProfile | null,
): Result<HardwareAccessAttribution, string> => {
  const classification = classifyHardwareMemoryAddress(
    reference.target_address,
    architecture,
  );
  if (!classification.ok) return classification;

  const { canonicalAddress, addressValue } = classification.value;
  let { regionKind, regionName, isMmio } = classification.value;

  const customMatch =
    customProfile != null
      ? lookupCustomPeripheral(addressValue, customProfile)
      : null;
  const aliasMatch =
    customMatch === null && platform != null
      ? resolveSocRegisterAlias(addressValue, platform)
      : null;
  const directSocPeripheral =
    customMatch === null && platform != null
      ? lookupSocPeripheral(canonicalAddress, platform)
      : null;
  const socPeripheral = directSocPeripheral ?? aliasMatch?.peripheral ?? null;

  let blockBaseValue: bigint;
  let blockOffsetValue: bigint;
  let controllerName: string | null = null;
  let cBasis: ControllerNameBasis = "observed_address";

  if (customMatch !== null && customMatch.kind === "matched") {
    regionKind = "peripheral_mmio";
    const busSuffix =
      customMatch.peripheral.bus !== null
        ? ` (${customMatch.peripheral.bus})`
        : "";
    regionName = `${customMatch.peripheral.name}${busSuffix}`;
    isMmio = true;
    blockBaseValue = customMatch.peripheral.baseAddressValue;
    blockOffsetValue = addressValue - blockBaseValue;
    controllerName = customMatch.peripheral.name;
    cBasis = "explicit_profile";
  } else if (customMatch !== null && customMatch.kind === "ambiguous") {
    regionKind = "peripheral_mmio";
    regionName = "Peripheral MMIO";
    isMmio = true;
    blockBaseValue = customMatch.baseAddressValue;
    blockOffsetValue = addressValue - blockBaseValue;
    controllerName = null;
    cBasis = "observed_address";
  } else if (socPeripheral != null) {
    regionKind = "peripheral_mmio";
    regionName = `${socPeripheral.name} (${socPeripheral.bus})`;
    isMmio = true;
    blockBaseValue = socPeripheral.baseAddressValue;
    blockOffsetValue =
      aliasMatch !== null
        ? aliasMatch.registerOffsetValue
        : addressValue - socPeripheral.baseAddressValue;
    controllerName = socPeripheral.name;
    cBasis = controllerNameBasis(true);
  } else {
    const page = addressValue & ~0xfffn;
    const pageNamesAnotherController =
      (platform != null && lookupSocPeripheral(page, platform) != null) ||
      (customProfile != null &&
        lookupCustomPeripheral(page, customProfile) != null);
    // A rounded page can land on a catalogued controller the access never touched.
    blockBaseValue = pageNamesAnotherController ? addressValue : page;
    blockOffsetValue = pageNamesAnotherController ? 0n : addressValue & 0xfffn;
  }

  const accessKind = deriveAccessKind(reference.read, reference.write);
  const archRegister = lookupHardwareRegister(canonicalAddress, architecture);
  const socRegister =
    archRegister === null && customMatch === null && platform != null
      ? lookupSocPeripheralRegister(addressValue, platform)
      : null;
  const customRegister =
    customMatch?.kind === "matched" ? customMatch.register : null;

  const registerName =
    archRegister?.name ?? customRegister?.name ?? socRegister?.name ?? null;
  const registerMnemonic =
    archRegister?.mnemonic ??
    customRegister?.mnemonic ??
    socRegister?.mnemonic ??
    null;
  const rBasis: RegisterNameBasis =
    archRegister !== null
      ? registerNameBasis(true)
      : customRegister !== null
        ? "explicit_profile"
        : socRegister !== null
          ? "chip_manual"
          : registerNameBasis(false);

  const registerAlias: HardwareRegisterAlias | null =
    aliasMatch === null
      ? null
      : {
          kind: aliasMatch.kind,
          canonicalAddress: aliasMatch.canonicalAddress,
          registerOffset: aliasMatch.registerOffset,
          bit: aliasMatch.bit,
        };

  return ok({
    targetAddress: canonicalAddress,
    addressValue,
    architecture,
    regionKind,
    regionName,
    isMmio,
    accessKind,
    peripheralBlockBase: `0x${blockBaseValue.toString(16)}`,
    peripheralBlockOffset: `0x${blockOffsetValue.toString(16)}`,
    controllerName,
    controllerBasis: cBasis,
    registerName,
    registerMnemonic,
    registerBasis: rBasis,
    ...(registerAlias === null ? {} : { registerAlias }),
    sourceAddress: reference.source_address ?? null,
    operandIndex: reference.operand_index ?? null,
    provenance: reference.provenance ?? null,
  });
};

/**
 * Aggregate and group multiple hardware memory attributions into cohesive
 * peripheral block summaries. Filters out non-MMIO memory (e.g. code/stack RAM)
 * to provide a clear reconstruction picture of hardware peripherals touched by firmware.
 */
export const summarizeHardwarePeripheralInteractions = (
  attributions: readonly HardwareAccessAttribution[],
  architecture: HardwareArchitecture,
): HardwarePeripheralAttributionSummary => {
  let mmioAccessCount = 0;
  let nonMmioAccessCount = 0;

  interface BlockAccumulator {
    readonly blockBase: string;
    readonly regionName: string;
    readonly regionKind: HardwareMemoryRegionKind;
    totalAccesses: number;
    readCount: number;
    writeCount: number;
    readonly uniqueAddresses: Set<string>;
    readonly observedOffsets: Set<string>;
    readonly knownRegisters: Set<string>;
  }

  const blocks = new Map<string, BlockAccumulator>();

  for (const item of attributions) {
    if (!item.isMmio) {
      nonMmioAccessCount += 1;
      continue;
    }

    mmioAccessCount += 1;
    let block = blocks.get(item.peripheralBlockBase);
    if (block === undefined) {
      block = {
        blockBase: item.peripheralBlockBase,
        regionName: item.regionName,
        regionKind: item.regionKind,
        totalAccesses: 0,
        readCount: 0,
        writeCount: 0,
        uniqueAddresses: new Set<string>(),
        observedOffsets: new Set<string>(),
        knownRegisters: new Set<string>(),
      };
      blocks.set(item.peripheralBlockBase, block);
    }

    block.totalAccesses += 1;
    if (item.accessKind === "read" || item.accessKind === "read_write") {
      block.readCount += 1;
    }
    if (item.accessKind === "write" || item.accessKind === "read_write") {
      block.writeCount += 1;
    }
    block.uniqueAddresses.add(item.targetAddress);
    block.observedOffsets.add(item.peripheralBlockOffset);
    if (item.registerMnemonic) {
      block.knownRegisters.add(item.registerMnemonic);
    }
  }

  const peripheralBlocks: HardwarePeripheralBlockSummary[] = Array.from(
    blocks.values(),
  )
    .sort((a, b) => (BigInt(a.blockBase) < BigInt(b.blockBase) ? -1 : 1))
    .map((block) => ({
      blockBase: block.blockBase,
      regionName: block.regionName,
      regionKind: block.regionKind,
      totalAccesses: block.totalAccesses,
      readCount: block.readCount,
      writeCount: block.writeCount,
      uniqueAddresses: Array.from(block.uniqueAddresses).sort((a, b) =>
        BigInt(a) < BigInt(b) ? -1 : 1,
      ),
      observedOffsets: Array.from(block.observedOffsets).sort((a, b) =>
        BigInt(a) < BigInt(b) ? -1 : 1,
      ),
      knownRegisters: Array.from(block.knownRegisters).sort(),
    }));

  return {
    architecture,
    totalReferencesExamined: attributions.length,
    mmioAccessCount,
    nonMmioAccessCount,
    peripheralBlocks,
  };
};
