import {
  classifyHardwareMemoryAddress,
  type HardwareArchitecture,
  type HardwareMemoryRegionKind,
} from "./hardwareMemoryMap.js";
import {
  controllerNameBasis,
  registerNameBasis,
  type ControllerNameBasis,
  type RegisterNameBasis,
} from "./hardwareFactBasis.js";
import { lookupHardwareRegister } from "./hardwareRegisterCatalog.js";
import {
  lookupSocPeripheral,
  type SocPlatform,
} from "./socPeripheralDatabase.js";
import { err, ok, type Result } from "../result.js";

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
 * region, calculating peripheral block coordinates and access direction.
 * Optionally accepts an explicit SoC platform family (stm32f1, gd32f1, esp32, etc.)
 * for exact peripheral controller identification and base address resolution.
 */
export const attributeHardwareAccess = (
  reference: AnalyzedInstructionReference,
  architecture: HardwareArchitecture,
  platform?: SocPlatform | null,
): Result<HardwareAccessAttribution, string> => {
  const classification = classifyHardwareMemoryAddress(
    reference.target_address,
    architecture,
  );
  if (!classification.ok) return classification;

  const { canonicalAddress, addressValue } = classification.value;
  let { regionKind, regionName, isMmio } = classification.value;

  const socPeripheral =
    platform != null ? lookupSocPeripheral(canonicalAddress, platform) : null;

  let blockBaseValue: bigint;
  let blockOffsetValue: bigint;

  if (socPeripheral != null) {
    regionKind = "peripheral_mmio";
    regionName = `${socPeripheral.name} (${socPeripheral.bus})`;
    isMmio = true;
    blockBaseValue = socPeripheral.baseAddressValue;
    blockOffsetValue = addressValue - socPeripheral.baseAddressValue;
  } else {
    // Group into standard 4 KiB (0x1000) hardware peripheral register pages.
    blockBaseValue = addressValue & ~0xfffn;
    blockOffsetValue = addressValue & 0xfffn;
  }

  const accessKind = deriveAccessKind(reference.read, reference.write);
  const knownRegister = lookupHardwareRegister(canonicalAddress, architecture);

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
    controllerName: socPeripheral?.name ?? null,
    controllerBasis: controllerNameBasis(socPeripheral != null),
    registerName: knownRegister?.name ?? null,
    registerMnemonic: knownRegister?.mnemonic ?? null,
    registerBasis: registerNameBasis(knownRegister != null),
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

  type BlockAccumulator = {
    readonly blockBase: string;
    readonly regionName: string;
    readonly regionKind: HardwareMemoryRegionKind;
    totalAccesses: number;
    readCount: number;
    writeCount: number;
    readonly uniqueAddresses: Set<string>;
    readonly observedOffsets: Set<string>;
    readonly knownRegisters: Set<string>;
  };

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
