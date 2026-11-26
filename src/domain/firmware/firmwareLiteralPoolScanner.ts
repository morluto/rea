import type { AnalysisInputIssue } from "../analysisErrorCore.js";
import { knownCoverage } from "../coverageAccumulator.js";
import { decodeLimit, type ParseFailureError } from "../parseFailure.js";
import { err, ok, type Result } from "../result.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import {
  PoolByteBitset,
  collectA32CandidatesSteps,
  collectThumbCandidatesSteps,
  collectXtensaCandidatesSteps,
  type RawPoolLoadCandidate,
} from "./firmwareLiteralPoolDecoders.js";
import {
  EMPTY_SVD_PERIPHERAL_PROFILE,
  createConstantClassifier,
  formatHex32,
  formatHexCompact,
  type SvdPeripheralProfile,
} from "./firmwareLiteralPoolRegions.js";
import type {
  FirmwareLiteralPoolIsa,
  FirmwareLiteralPoolsReport,
  LiteralPoolAttributionBasis,
  LiteralPoolMmioSummary,
  LiteralPoolReference,
  LiteralPoolRegionKind,
} from "./firmwareLiteralPools.js";

export interface ScanFirmwareLiteralPoolsOptions {
  readonly artifact: {
    readonly path: string;
    readonly sha256: string;
    readonly bytes: number;
  };
  readonly fileBytes: Uint8Array;
  readonly isa: FirmwareLiteralPoolIsa;
  readonly baseAddressHex: string;
  readonly scanOffset: number;
  readonly maxScanBytes: number;
  readonly maxReferences: number;
  readonly svdSupplied: boolean;
  readonly svdProfile?: SvdPeripheralProfile;
}

export type FirmwareLiteralPoolScanError =
  | {
      readonly kind: "input";
      readonly issues: readonly AnalysisInputIssue[];
    }
  | ParseFailureError<"limit">;

interface MmioAccumulator {
  readonly groupKey: string;
  readonly regionKind: LiteralPoolRegionKind;
  readonly basis: LiteralPoolAttributionBasis;
  readonly baseAddress: number;
  readonly svdPeripheral: string | null;
  readonly architecturalBlock: string | null;
  // not-an-allowance: observed count of literal-pool loads targeting this MMIO group
  referenceCount: number;
  readonly constants: Set<string>;
  readonly sampleInstructions: string[];
}

const SAMPLE_ADDRESS_DISPLAY_COUNT = 6;
const DISTINCT_CONSTANT_DISPLAY_COUNT = 16;
const CANDIDATE_COOPERATIVE_STEP = 16_384;

/** Validate caller-selected base_address and scan_offset alignment before or during scanning. */
export const validateLiteralPoolAddressAlignment = (params: {
  readonly isa: FirmwareLiteralPoolIsa;
  readonly baseAddressHex: string;
  readonly scanOffset: number;
  readonly fileLength?: number;
}): {
  readonly baseAddress: number | null;
  readonly issues: readonly AnalysisInputIssue[];
} => {
  const issues: AnalysisInputIssue[] = [];
  const parsed = Number.parseInt(params.baseAddressHex.slice(2), 16);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0xffff_ffff) {
    issues.push({
      path: ["base_address"],
      reason: "out_of_range",
      message: `base_address ${params.baseAddressHex} is outside the 32-bit unsigned address space.`,
    });
    return { baseAddress: null, issues };
  }

  if (params.isa === "arm-thumb") {
    if ((parsed & 1) !== 0) {
      issues.push({
        path: ["base_address"],
        reason: "invalid_value",
        message: "arm-thumb requires a 2-byte aligned base_address.",
      });
    }
    if ((params.scanOffset & 1) !== 0) {
      issues.push({
        path: ["scan_offset"],
        reason: "invalid_value",
        message: "arm-thumb requires a 2-byte aligned scan_offset.",
      });
    }
  } else if (params.isa === "arm-a32") {
    if ((parsed & 3) !== 0) {
      issues.push({
        path: ["base_address"],
        reason: "invalid_value",
        message: "arm-a32 requires a 4-byte aligned base_address.",
      });
    }
    if ((params.scanOffset & 3) !== 0) {
      issues.push({
        path: ["scan_offset"],
        reason: "invalid_value",
        message: "arm-a32 requires a 4-byte aligned scan_offset.",
      });
    }
  }

  if (params.fileLength !== undefined) {
    if (BigInt(parsed) + BigInt(params.fileLength) > 0x1_0000_0000n) {
      issues.push({
        path: ["base_address"],
        reason: "out_of_range",
        message: `Image of ${String(params.fileLength)} bytes at ${params.baseAddressHex} wraps past the 32-bit address space.`,
      });
    }
    if (params.scanOffset > params.fileLength) {
      issues.push({
        path: ["scan_offset"],
        reason: "out_of_range",
        message: `scan_offset ${String(params.scanOffset)} exceeds the ${String(params.fileLength)}-byte firmware size.`,
      });
    }
  }

  return { baseAddress: parsed, issues };
};

function* filterPoolSlotOverlapsSteps(
  candidates: readonly RawPoolLoadCandidate[],
  fileByteLength: number,
): Generator<
  "step",
  {
    readonly retained: readonly RawPoolLoadCandidate[];
    readonly suppressedCount: number;
  },
  void
> {
  const allTargets = new PoolByteBitset(fileByteLength);
  for (let i = 0; i < candidates.length; i += 1) {
    if (i > 0 && i % CANDIDATE_COOPERATIVE_STEP === 0) yield "step";
    allTargets.markWord(candidates[i]!.poolOffset);
  }
  const confirmedPoolBytes = new PoolByteBitset(fileByteLength);
  for (let i = 0; i < candidates.length; i += 1) {
    if (i > 0 && i % CANDIDATE_COOPERATIVE_STEP === 0) yield "step";
    const cand = candidates[i]!;
    if (!allTargets.overlaps(cand.insnOffset, cand.insnSize)) {
      confirmedPoolBytes.markWord(cand.poolOffset);
    }
  }
  const retained: RawPoolLoadCandidate[] = [];
  for (let i = 0; i < candidates.length; i += 1) {
    if (i > 0 && i % CANDIDATE_COOPERATIVE_STEP === 0) yield "step";
    const cand = candidates[i]!;
    if (!confirmedPoolBytes.overlaps(cand.insnOffset, cand.insnSize)) {
      retained.push(cand);
    }
  }
  return {
    retained,
    suppressedCount: candidates.length - retained.length,
  };
}

const recordMmioSummary = (
  groups: Map<string, MmioAccumulator>,
  reference: LiteralPoolReference,
  mmioBaseAddress: number,
): void => {
  const groupKey =
    reference.svd_peripheral !== null
      ? `svd:${reference.svd_peripheral}`
      : reference.architectural_block !== null
        ? `arch:${reference.architectural_block}`
        : `page:${formatHex32(mmioBaseAddress)}`;
  let acc = groups.get(groupKey);
  if (acc === undefined) {
    acc = {
      groupKey,
      regionKind: reference.region_kind,
      basis: reference.basis,
      baseAddress: mmioBaseAddress,
      svdPeripheral: reference.svd_peripheral,
      architecturalBlock: reference.architectural_block,
      referenceCount: 0,
      constants: new Set<string>(),
      sampleInstructions: [],
    };
    groups.set(groupKey, acc);
  }
  acc.referenceCount += 1;
  if (acc.constants.size < DISTINCT_CONSTANT_DISPLAY_COUNT) {
    acc.constants.add(reference.loaded_value);
  }
  if (acc.sampleInstructions.length < SAMPLE_ADDRESS_DISPLAY_COUNT) {
    acc.sampleInstructions.push(reference.instruction_address);
  }
};

const buildMmioSummaryList = (
  groups: ReadonlyMap<string, MmioAccumulator>,
): LiteralPoolMmioSummary[] =>
  [...groups.values()]
    .sort(
      (a, b) =>
        b.referenceCount - a.referenceCount ||
        compareUnicodeCodePoints(a.groupKey, b.groupKey),
    )
    .map((group) => ({
      group_key: group.groupKey,
      region_kind: group.regionKind,
      basis: group.basis,
      base_address: formatHex32(group.baseAddress),
      svd_peripheral: group.svdPeripheral,
      architectural_block: group.architecturalBlock,
      reference_count: group.referenceCount,
      distinct_constants: [...group.constants].sort(compareUnicodeCodePoints),
      sample_instruction_addresses: group.sampleInstructions,
    }));

const buildScanLimitations = (params: {
  readonly isa: FirmwareLiteralPoolIsa;
  readonly scanTruncated: boolean;
  readonly scannedBytes: number;
  readonly availableFromOffset: number;
  readonly scanOffset: number;
  readonly maxScanBytes: number;
  readonly svdSupplied: boolean;
}): string[] => {
  const limitations = [
    "Linear instruction scanning without control-flow recovery may encounter inline non-pool data tables (such as switch jump tables or embedded strings); referenced 32-bit pool slots are suppressed from instruction decoding.",
  ];
  if (params.scanTruncated) {
    limitations.push(
      `Scanned ${String(params.scannedBytes)} of ${String(params.availableFromOffset)} available bytes from scan_offset ${String(params.scanOffset)} (bounded by max_scan_bytes = ${String(params.maxScanBytes)}).`,
    );
  }
  if (!params.svdSupplied) {
    limitations.push(
      params.isa === "arm-a32"
        ? "No svd_xml profile was supplied; arm-a32 targets have SoC-defined memory maps without fixed Cortex-M PPB/peripheral addresses, so constants outside mapped_image remain unclassified."
        : "No svd_xml profile was supplied; peripheral MMIO regions outside architectural Cortex-M PPB/SCS blocks are grouped by 4 KiB page under address_map_convention.",
    );
  }
  return limitations;
};

function* runIsaCandidateScanSteps(
  isa: FirmwareLiteralPoolIsa,
  fileBytes: Uint8Array,
  baseAddress: number,
  range: { readonly start: number; readonly end: number },
) {
  if (isa === "arm-thumb") {
    return yield* collectThumbCandidatesSteps(
      fileBytes,
      baseAddress,
      range.start,
      range.end,
    );
  }
  if (isa === "arm-a32") {
    return yield* collectA32CandidatesSteps(
      fileBytes,
      baseAddress,
      range.start,
      range.end,
    );
  }
  return yield* collectXtensaCandidatesSteps(
    fileBytes,
    baseAddress,
    range.start,
    range.end,
  );
}

function* classifyAndCollectReferencesSteps(params: {
  readonly retained: readonly RawPoolLoadCandidate[];
  readonly isa: FirmwareLiteralPoolIsa;
  readonly baseAddress: number;
  readonly fileByteLength: number;
  readonly svdProfile: SvdPeripheralProfile;
}) {
  const classify = createConstantClassifier({
    isa: params.isa,
    baseAddress: params.baseAddress,
    fileBytes: params.fileByteLength,
    svdProfile: params.svdProfile,
  });
  const references: LiteralPoolReference[] = [];
  const distinctSlots = new Set<number>();
  const mmioGroups = new Map<string, MmioAccumulator>();
  // not-an-allowance: tally of literal-pool loads classified as peripheral/PPB MMIO
  let mmioLoadCount = 0;
  // not-an-allowance: tally of literal-pool loads matched against supplied CMSIS-SVD
  let svdMatchedLoadCount = 0;

  for (let i = 0; i < params.retained.length; i += 1) {
    if (i > 0 && i % CANDIDATE_COOPERATIVE_STEP === 0) yield "step" as const;
    const cand = params.retained[i]!;
    distinctSlots.add(cand.poolOffset);
    const classified = classify(cand.loadedValue);
    const ref: LiteralPoolReference = {
      instruction_offset: cand.insnOffset,
      instruction_address: formatHexCompact(cand.insnAddress),
      mnemonic: cand.mnemonic,
      target_register: cand.targetRegister,
      disassembly: cand.disassembly,
      pool_offset: cand.poolOffset,
      pool_address: formatHexCompact(cand.poolAddress),
      loaded_value: formatHex32(cand.loadedValue),
      region_kind: classified.regionKind,
      basis: classified.basis,
      architectural_block: classified.architecturalBlock,
      svd_peripheral: classified.svdPeripheral,
      svd_register_offset: classified.svdRegisterOffset,
    };
    if (classified.svdPeripheral !== null) svdMatchedLoadCount += 1;
    if (classified.mmioBaseAddress !== null) {
      mmioLoadCount += 1;
      recordMmioSummary(mmioGroups, ref, classified.mmioBaseAddress);
    }
    references.push(ref);
  }

  return {
    references,
    distinctSlotCount: distinctSlots.size,
    mmioGroups,
    mmioLoadCount,
    svdMatchedLoadCount,
  };
}

/** Cooperative generator disassembling PC-relative literal-pool loads and classifying MMIO constants. */
export function* scanFirmwareLiteralPoolsSteps(
  options: ScanFirmwareLiteralPoolsOptions,
): Generator<
  "step",
  Result<FirmwareLiteralPoolsReport, FirmwareLiteralPoolScanError>,
  void
> {
  const checked = validateLiteralPoolAddressAlignment({
    isa: options.isa,
    baseAddressHex: options.baseAddressHex,
    scanOffset: options.scanOffset,
    fileLength: options.fileBytes.length,
  });
  if (checked.issues.length > 0 || checked.baseAddress === null) {
    return err({ kind: "input", issues: checked.issues });
  }
  const baseAddress = checked.baseAddress;
  const svdProfile = options.svdProfile ?? EMPTY_SVD_PERIPHERAL_PROFILE;

  const availableFromOffset = Math.max(
    0,
    options.fileBytes.length - options.scanOffset,
  );
  const scanStart = Math.min(options.scanOffset, options.fileBytes.length);
  const scanEnd = Math.min(
    options.fileBytes.length,
    scanStart + options.maxScanBytes,
  );
  const scannedBytes = scanEnd - scanStart;

  const rawScan = yield* runIsaCandidateScanSteps(
    options.isa,
    options.fileBytes,
    baseAddress,
    { start: scanStart, end: scanEnd },
  );
  const { retained, suppressedCount } = yield* filterPoolSlotOverlapsSteps(
    rawScan.candidates,
    options.fileBytes.length,
  );
  if (retained.length > options.maxReferences) {
    return err(
      decodeLimit(
        "firmware-literal-pools",
        `Scanned window resolved ${String(retained.length)} literal-pool loads, exceeding max_references (${String(options.maxReferences)}).`,
        { name: "max_references", maximum: options.maxReferences },
      ),
    );
  }
  const collected = yield* classifyAndCollectReferencesSteps({
    retained,
    isa: options.isa,
    baseAddress,
    fileByteLength: options.fileBytes.length,
    svdProfile,
  });

  const scanTruncated = scannedBytes < availableFromOffset;
  const totalSuppressed = suppressedCount + rawScan.suppressedForwardOverlaps;
  return ok({
    artifact: options.artifact,
    isa: options.isa,
    base_address: formatHexCompact(baseAddress),
    scan_range: { start: scanStart, end: scanEnd, scanned_bytes: scannedBytes },
    coverage: {
      status: knownCoverage(
        !scanTruncated,
        "scan_range truncated by max_scan_bytes",
      ),
      available_from_offset_bytes: availableFromOffset,
      retained_references: collected.references.length,
      omitted_references: 0,
    },
    counts: {
      resolved_pool_loads: retained.length,
      distinct_pool_slots: collected.distinctSlotCount,
      mmio_pool_loads: collected.mmioLoadCount,
      out_of_image_pool_targets: rawScan.outOfImageTargets,
      suppressed_pool_slot_overlaps: totalSuppressed,
    },
    svd_profile: {
      supplied: options.svdSupplied,
      peripheral_count: svdProfile.peripheralCount,
      matched_load_count: collected.svdMatchedLoadCount,
    },
    mmio_summary: buildMmioSummaryList(collected.mmioGroups),
    references: collected.references,
    limitations: buildScanLimitations({
      isa: options.isa,
      scanTruncated,
      scannedBytes,
      availableFromOffset,
      scanOffset: options.scanOffset,
      maxScanBytes: options.maxScanBytes,
      svdSupplied: options.svdSupplied,
    }),
  });
}

/** Synchronous drain of `scanFirmwareLiteralPoolsSteps` for callers without an event loop. */
export const scanFirmwareLiteralPools = (
  options: ScanFirmwareLiteralPoolsOptions,
): Result<FirmwareLiteralPoolsReport, FirmwareLiteralPoolScanError> => {
  const steps = scanFirmwareLiteralPoolsSteps(options);
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
};
