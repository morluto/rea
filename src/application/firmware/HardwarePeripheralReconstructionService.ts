import { z } from "zod";
import { parseAnalysisInput } from "../AnalysisInput.js";
import type {
  AnalysisExecution,
  AnalysisOperationPort,
  ExecutionOptions,
} from "../../ports/AnalysisProvider.js";
import {
  attributeHardwareAccess,
  summarizeHardwarePeripheralInteractions,
  type AnalyzedInstructionReference,
  type HardwareAccessAttribution,
  type HardwarePeripheralBlockSummary,
} from "../../domain/firmware/hardwarePeripheralAttribution.js";
import {
  type HardwareArchitecture,
  hardwareArchitectureSchema,
  hardwareMemoryRegionKindSchema,
} from "../../domain/firmware/hardwareMemoryMap.js";
import { devicetreeSchema } from "../../domain/firmware/devicetree.js";
import {
  hardwareProfileFromDevicetree,
  lookupCustomPeripheral,
  parseCmsisSvd,
  type CustomHardwareProfile,
} from "../../domain/firmware/hardwareCustomProfile.js";
import {
  controllerNameBasis,
  CONTROLLER_NAME_BASES,
  HARDWARE_CLAIM_BASES,
  HARDWARE_CLAIM_RULES,
  REGISTER_NAME_BASES,
  hardwareClaimsForBlocks,
  unsettledBoardFacts,
  type ControllerNameBasis,
  type HardwareClaim,
  type UnsettledBoardFact,
} from "../../domain/firmware/hardwareFactBasis.js";
import {
  boardDriversForControllers,
  boardDriverSchema,
  type BoardDriver,
} from "../../domain/firmware/boardDriverLayer.js";
import {
  driverPeripheralRecoverySchema,
  type DriverPeripheralRecovery,
} from "../../domain/firmware/driverPeripheralReverse.js";
import { hardwareClaimsFromImage } from "../../domain/firmware/imageHardwareDecode.js";
import {
  boardDeviceAttachmentSchema,
  boardIdSchema,
  lookupBoardMemoryWindow,
  lookupBoardProfile,
  unboundBoardDevices,
  type BoardDeviceAttachment,
  type BoardId,
  type BoardMemoryWindow,
} from "../../domain/firmware/boardPeripheralProfile.js";
import {
  detectSocPlatform,
  lookupSocPeripheral,
  resolveSocRegisterAlias,
  SOC_REGISTER_ALIAS_KINDS,
  socPlatformForEspChipId,
  socPlatformForUf2FamilyId,
  type SocPlatform,
  socPlatformSchema,
  type SocPlatformMatchCandidate,
} from "../../domain/firmware/socPeripheralDatabase.js";
import type { HardwareReconstructionPartialObservation } from "../../domain/firmware/hardwareReconstructionPartial.js";
import {
  AnalysisInputError,
  AnalysisOutputError,
  cancelledBy,
  isAborted,
} from "../../domain/analysisErrorCore.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { err, ok, type Result } from "../../domain/result.js";
import { procedureReferencesSchema } from "../../domain/native/procedureReferences.js";

/** Input parameters for reconstructing a procedure's hardware peripheral interactions. */
export const reconstructProcedureHardwareInputSchema = z.strictObject({
  procedure: z
    .string()
    .min(1)
    .describe("Target procedure symbol name or canonical entrypoint address"),
  architecture: hardwareArchitectureSchema.describe(
    "Target hardware CPU architecture for memory map and register resolution",
  ),
  platform: socPlatformSchema
    .optional()
    .describe(
      "Optional explicit target SoC family for device-specific peripheral and register mapping",
    ),
  board: boardIdSchema
    .optional()
    .describe(
      "Optional known development board profile. It must agree with platform when both are set.",
    ),
  svd_xml: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional CMSIS-SVD XML peripheral and register map for custom or uncatalogued MCUs",
    ),
  devicetree: devicetreeSchema
    .optional()
    .describe(
      "Optional parsed Flattened Devicetree report supplying custom peripheral, memory, and device windows",
    ),
  esp_chip_id: z
    .number()
    .int()
    .min(0)
    .max(0xffff)
    .optional()
    .describe(
      "Optional ESP image header chip_id from inspect_firmware_image to select the matching Espressif SoC catalog",
    ),
  uf2_family_id: z
    .number()
    .int()
    .min(0)
    .max(0xffffffff)
    .optional()
    .describe(
      "Optional UF2 container family_id from inspect_firmware_image to select the matching MCU catalog",
    ),
});
export type ReconstructProcedureHardwareInput = z.infer<
  typeof reconstructProcedureHardwareInputSchema
>;

export interface ReconstructHardwareOptions {
  readonly subjectSha256?: string | null;
  readonly customProfile?: CustomHardwareProfile | null;
  readonly espChipId?: number;
  readonly uf2FamilyId?: number;
}

/** Enriched peripheral block with optional SoC-specific controller identification. */
export interface ReconstructedPeripheralBlock extends HardwarePeripheralBlockSummary {
  readonly socPeripheralName?: string | null;
  readonly socPeripheralNameBasis: ControllerNameBasis;
  readonly socPeripheralBus?: string | null;
  readonly boardDevices: readonly BoardDeviceAttachment[];
  readonly boardDrivers: readonly BoardDriver[];
}

/** One recorded board memory window and how many examined references fell inside it. */
export interface BoardMemoryAccess {
  readonly id: string;
  readonly name: string;
  readonly kind: HardwarePeripheralBlockSummary["regionKind"];
  readonly baseAddress: string;
  readonly sizeBytes: number;
  readonly accessCount: number;
  readonly evidence: string;
}

/** Provider observation this reconstruction was derived from. Absent for a direct reference list. */
export interface HardwareProducingSource {
  readonly subjectSha256: string | null;
  readonly subjectPath: string | null;
  readonly providerId: string | null;
  readonly evidenceId: string | null;
  readonly evidenceLinks: readonly string[];
}

/** Output result detailing reconstructed hardware peripheral interactions for a procedure. */
export interface HardwarePeripheralReconstruction {
  readonly procedure: string;
  readonly architecture: HardwareArchitecture;
  readonly platform: SocPlatform | null;
  readonly board: BoardId | null;
  readonly customProfileId?: string | null;
  readonly producingSource: HardwareProducingSource | null;
  readonly boardMcu: string | null;
  readonly boardMemory: readonly BoardMemoryAccess[];
  readonly boardUnboundDevices: readonly BoardDeviceAttachment[];
  readonly boardDrivers: readonly BoardDriver[];
  readonly driverRecoveries?: readonly DriverPeripheralRecovery[];
  readonly totalReferencesExamined: number;
  readonly mmioAccessCount: number;
  readonly nonMmioAccessCount: number;
  readonly peripheralBlocks: readonly ReconstructedPeripheralBlock[];
  readonly attributions: readonly HardwareAccessAttribution[];
  readonly detectedPlatforms: readonly SocPlatformMatchCandidate[];
  readonly unsettledFacts: readonly UnsettledBoardFact[];
  readonly hardwareClaims: readonly HardwareClaim[];
  readonly limitations: readonly string[];
}

export const hardwarePeripheralReconstructionSchema = z.strictObject({
  procedure: z.string(),
  architecture: hardwareArchitectureSchema,
  platform: socPlatformSchema.nullable().optional(),
  board: boardIdSchema.nullable(),
  customProfileId: z.string().nullable().optional(),
  producingSource: z
    .strictObject({
      subjectSha256: z.string().nullable(),
      subjectPath: z.string().nullable(),
      providerId: z.string().nullable(),
      evidenceId: z.string().nullable(),
      evidenceLinks: z.array(z.string()),
    })
    .nullable(),
  boardMcu: z.string().nullable(),
  boardMemory: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      kind: hardwareMemoryRegionKindSchema,
      baseAddress: z.string(),
      sizeBytes: z.number().int().positive(),
      accessCount: z.number().int().min(0),
      evidence: z.string(),
    }),
  ),
  boardUnboundDevices: z.array(boardDeviceAttachmentSchema),
  boardDrivers: z.array(boardDriverSchema),
  driverRecoveries: z.array(driverPeripheralRecoverySchema).optional(),
  totalReferencesExamined: z.number().int().min(0),
  mmioAccessCount: z.number().int().min(0),
  nonMmioAccessCount: z.number().int().min(0),
  peripheralBlocks: z.array(
    z.strictObject({
      blockBase: z.string(),
      regionName: z.string(),
      regionKind: hardwareMemoryRegionKindSchema,
      totalAccesses: z.number().int().min(0),
      readCount: z.number().int().min(0),
      writeCount: z.number().int().min(0),
      uniqueAddresses: z.array(z.string()),
      observedOffsets: z.array(z.string()),
      knownRegisters: z.array(z.string()),
      socPeripheralName: z.string().nullable().optional(),
      socPeripheralNameBasis: z.enum(CONTROLLER_NAME_BASES),
      socPeripheralBus: z.string().nullable().optional(),
      boardDevices: z.array(boardDeviceAttachmentSchema),
      boardDrivers: z.array(boardDriverSchema),
    }),
  ),
  attributions: z.array(
    z.strictObject({
      targetAddress: z.string(),
      addressValue: z.bigint(),
      architecture: hardwareArchitectureSchema,
      regionKind: hardwareMemoryRegionKindSchema,
      regionName: z.string(),
      isMmio: z.boolean(),
      accessKind: z.enum(["read", "write", "read_write", "unknown"]),
      peripheralBlockBase: z.string(),
      peripheralBlockOffset: z.string(),
      controllerName: z.string().nullable(),
      controllerBasis: z.enum(CONTROLLER_NAME_BASES),
      registerName: z.string().nullable().optional(),
      registerMnemonic: z.string().nullable().optional(),
      registerBasis: z.enum(REGISTER_NAME_BASES),
      registerAlias: z
        .strictObject({
          kind: z.enum(SOC_REGISTER_ALIAS_KINDS),
          canonicalAddress: z.string(),
          registerOffset: z.string(),
          bit: z.number().int().min(0).max(31).nullable(),
        })
        .nullable()
        .optional(),
      sourceAddress: z.string().nullable().optional(),
      operandIndex: z.number().nullable().optional(),
      provenance: z.string().nullable().optional(),
    }),
  ),
  detectedPlatforms: z.array(
    z.strictObject({
      platform: socPlatformSchema,
      matchedCount: z.number().int().min(0),
      totalAddresses: z.number().int().min(0),
      confidence: z.number(),
      matchedPeripherals: z.array(z.string()),
    }),
  ),
  unsettledFacts: z.array(
    z.strictObject({
      subject: z.string(),
      basis: z.literal("unsettled"),
      reason: z.string(),
    }),
  ),
  hardwareClaims: z.array(
    z.strictObject({
      subject: z.string(),
      source: z.string(),
      rule: z.enum(HARDWARE_CLAIM_RULES),
      basis: z.enum(HARDWARE_CLAIM_BASES),
      settled: z.boolean(),
      reason: z.string(),
    }),
  ),
  limitations: z.array(z.string()),
});

const leadingSocPlatforms = (
  candidates: readonly SocPlatformMatchCandidate[],
): readonly SocPlatformMatchCandidate[] => {
  const topCount = candidates[0]?.matchedCount;
  if (topCount === undefined) return [];
  return candidates.filter((candidate) => candidate.matchedCount === topCount);
};

/** Use a catalog only when it is alone at the top and covers half the hits. */
const chooseDetectedSocPlatform = (
  candidates: readonly SocPlatformMatchCandidate[],
): SocPlatform | null => {
  const leaders = leadingSocPlatforms(candidates);
  const leader = leaders[0];
  if (leaders.length !== 1 || leader === undefined || leader.confidence < 0.5) {
    return null;
  }
  return leader.platform;
};

const unresolvedSocPlatformLimitation = (
  candidates: readonly SocPlatformMatchCandidate[],
): string | null => {
  const leaders = leadingSocPlatforms(candidates);
  if (leaders.length < 2) return null;
  const names = leaders.map((candidate) => candidate.platform).join(", ");
  return `SoC platform is unresolved because ${names} share the highest peripheral match count`;
};

const findMemoryWindow = (
  windows: readonly BoardMemoryWindow[],
  address: bigint,
): BoardMemoryWindow | null => {
  for (const item of windows) {
    const end = item.baseAddressValue + BigInt(item.sizeBytes);
    if (address >= item.baseAddressValue && address < end) return item;
  }
  return null;
};

const applyMemoryWindows = (
  attribution: HardwareAccessAttribution,
  windows: readonly BoardMemoryWindow[],
): HardwareAccessAttribution => {
  const matched = findMemoryWindow(windows, attribution.addressValue);
  if (matched === null) return attribution;
  return {
    ...attribution,
    regionKind: matched.kind,
    regionName: matched.name,
    isMmio: false,
  };
};

const promoteTiedCatalogMmio = (
  attribution: HardwareAccessAttribution,
  tiedLeaders: readonly SocPlatformMatchCandidate[],
): HardwareAccessAttribution => {
  if (attribution.isMmio || tiedLeaders.length < 2) return attribution;
  const hits = tiedLeaders.flatMap((leader) => {
    const hit = lookupSocPeripheral(attribution.addressValue, leader.platform);
    return hit === null ? [] : [hit];
  });
  if (hits.length !== tiedLeaders.length) return attribution;
  const uniqueBases = new Set(hits.map((hit) => hit.baseAddressValue));
  const firstBase = hits[0]?.baseAddressValue;
  const blockBaseValue =
    uniqueBases.size === 1 && firstBase !== undefined
      ? firstBase
      : attribution.addressValue & ~0xfffn;
  return {
    ...attribution,
    regionKind: "peripheral_mmio",
    regionName: "Peripheral MMIO",
    isMmio: true,
    peripheralBlockBase: `0x${blockBaseValue.toString(16)}`,
    peripheralBlockOffset: `0x${(attribution.addressValue - blockBaseValue).toString(16)}`,
    controllerName: null,
    controllerBasis: "observed_address",
  };
};

const sortAttachments = (
  items: readonly BoardDeviceAttachment[],
): BoardDeviceAttachment[] =>
  [...items].sort((left, right) => {
    if (left.id < right.id) return -1;
    if (left.id > right.id) return 1;
    return 0;
  });

const enrichBlock = (
  block: HardwarePeripheralBlockSummary,
  activePlatform: SocPlatform | null,
  customProfile: CustomHardwareProfile | null,
  activeDevices: readonly BoardDeviceAttachment[],
  activeDrivers: readonly BoardDriver[],
): ReconstructedPeripheralBlock => {
  const matchedNames = new Set<string>();
  let primaryBus: string | null = null;
  let blockBasis: ControllerNameBasis = controllerNameBasis(false);

  for (const addr of block.uniqueAddresses) {
    const customHit =
      customProfile !== null
        ? lookupCustomPeripheral(BigInt(addr), customProfile)
        : null;
    if (customHit !== null) {
      matchedNames.add(customHit.peripheral.name);
      primaryBus = customHit.peripheral.bus;
      blockBasis = "explicit_profile";
      continue;
    }
    if (activePlatform !== null) {
      const def =
        lookupSocPeripheral(addr, activePlatform) ??
        resolveSocRegisterAlias(addr, activePlatform)?.peripheral ??
        null;
      if (def !== null) {
        matchedNames.add(def.name);
        primaryBus = def.bus;
        if (blockBasis === "observed_address") blockBasis = "chip_manual";
      }
    }
  }

  return {
    ...block,
    socPeripheralName:
      matchedNames.size > 0 ? Array.from(matchedNames).sort().join(", ") : null,
    socPeripheralNameBasis: blockBasis,
    socPeripheralBus: primaryBus,
    boardDevices: sortAttachments(
      activeDevices.filter(
        (device) =>
          device.peripheralName !== null &&
          matchedNames.has(device.peripheralName),
      ),
    ),
    boardDrivers: boardDriversForControllers(activeDrivers, matchedNames),
  };
};

const resolveSelectedSocPlatform = (
  explicitPlatform: SocPlatform | null,
  options: ReconstructHardwareOptions | undefined,
  limitations: string[],
): SocPlatform | null => {
  const espResolved =
    options?.espChipId === undefined
      ? undefined
      : socPlatformForEspChipId(options.espChipId);
  if (options?.espChipId !== undefined && espResolved === null) {
    limitations.push(
      `ESP chip_id 0x${options.espChipId.toString(16).padStart(4, "0")} has no built-in SoC peripheral catalog.`,
    );
  }

  const uf2Resolved =
    options?.uf2FamilyId === undefined
      ? undefined
      : socPlatformForUf2FamilyId(options.uf2FamilyId);
  if (options?.uf2FamilyId !== undefined && uf2Resolved === null) {
    limitations.push(
      `UF2 family_id 0x${options.uf2FamilyId.toString(16).padStart(8, "0")} has no built-in SoC peripheral catalog.`,
    );
  }

  if (
    espResolved !== undefined &&
    espResolved !== null &&
    uf2Resolved !== undefined &&
    uf2Resolved !== null &&
    espResolved !== uf2Resolved
  ) {
    limitations.push(
      `Container hints disagree (${espResolved} vs ${uf2Resolved}); keeping caller platform selection only.`,
    );
    return explicitPlatform;
  }

  const containerPlatform = espResolved ?? uf2Resolved ?? null;
  if (
    explicitPlatform !== null &&
    containerPlatform !== null &&
    explicitPlatform !== containerPlatform
  ) {
    limitations.push(
      `Container metadata selects ${containerPlatform}, which disagrees with caller platform ${explicitPlatform}; preserving caller platform ${explicitPlatform}.`,
    );
    return explicitPlatform;
  }
  return explicitPlatform ?? containerPlatform;
};

const normalizeDigest = (digest: string | null | undefined): string | null => {
  const normalized = digest?.trim().toLowerCase();
  return normalized ? normalized : null;
};

/**
 * Reconstruct hardware peripheral interactions from a set of analyzed instruction references.
 * Pure deterministic domain workflow for offline and provider-decoupled analysis.
 */
export const reconstructHardwareFromReferences = (
  references: readonly AnalyzedInstructionReference[],
  architecture: HardwareArchitecture,
  procedure = "detached",
  platform: SocPlatform | null = null,
  board: BoardId | null = null,
  subjectSha256OrOptions?: string | ReconstructHardwareOptions | null,
): HardwarePeripheralReconstruction => {
  const options: ReconstructHardwareOptions | undefined =
    typeof subjectSha256OrOptions === "string" ||
    subjectSha256OrOptions === null
      ? { subjectSha256: subjectSha256OrOptions }
      : subjectSha256OrOptions;
  const limitations: string[] = [];
  const selectedPlatform = resolveSelectedSocPlatform(
    platform,
    options,
    limitations,
  );
  const customProfile = options?.customProfile ?? null;
  const subjectSha256 = normalizeDigest(options?.subjectSha256);
  const boardProfile = board === null ? null : lookupBoardProfile(board);
  const expectedImageSha256 = normalizeDigest(boardProfile?.imageSha256);
  const boardApplies =
    boardProfile !== null &&
    (selectedPlatform === null || selectedPlatform === boardProfile.soc);

  if (
    boardProfile !== null &&
    selectedPlatform !== null &&
    selectedPlatform !== boardProfile.soc
  ) {
    limitations.push(
      `Board ${boardProfile.id} targets ${boardProfile.soc}; platform ${selectedPlatform} does not match, so board devices were not applied.`,
    );
  }

  const capturedImageApplies =
    boardApplies &&
    boardProfile !== null &&
    expectedImageSha256 !== null &&
    subjectSha256 !== null &&
    subjectSha256 === expectedImageSha256;

  if (
    boardApplies &&
    boardProfile !== null &&
    expectedImageSha256 !== null &&
    subjectSha256 !== expectedImageSha256
  ) {
    limitations.push(
      subjectSha256 === null
        ? `Captured reference image drivers and observations for board ${boardProfile.id} (${expectedImageSha256}) were not applied because the analyzed firmware image digest is unknown.`
        : `Captured reference image drivers and observations for board ${boardProfile.id} apply only to image ${expectedImageSha256}, not analyzed image ${subjectSha256}.`,
    );
  }

  const candidateAddresses = references.map((r) => r.target_address);
  const detectedPlatforms =
    selectedPlatform === null && customProfile === null
      ? detectSocPlatform(candidateAddresses, architecture)
      : [];
  const tie = unresolvedSocPlatformLimitation(detectedPlatforms);
  if (tie !== null) limitations.push(tie);

  const boardDetection =
    boardProfile === null
      ? undefined
      : detectedPlatforms.find(
          (candidate) => candidate.platform === boardProfile.soc,
        );
  const leadingDetection = detectedPlatforms[0];
  if (
    boardApplies &&
    boardProfile !== null &&
    leadingDetection !== undefined &&
    leadingDetection.platform !== boardProfile.soc &&
    leadingDetection.matchedCount > (boardDetection?.matchedCount ?? 0)
  ) {
    limitations.push(
      `Observed addresses prefer ${leadingDetection.platform} (${leadingDetection.matchedCount} of ${leadingDetection.totalAddresses}). Board ${boardProfile.id} still uses ${boardProfile.soc}.`,
    );
  }

  const activePlatform =
    selectedPlatform ??
    (boardApplies && boardProfile !== null
      ? boardProfile.soc
      : customProfile === null
        ? chooseDetectedSocPlatform(detectedPlatforms)
        : null);

  const memoryWindows: readonly BoardMemoryWindow[] = [
    ...(customProfile?.memory ?? []),
    ...(boardApplies && boardProfile !== null ? boardProfile.memory : []),
  ];
  const tiedLeaders =
    activePlatform === null && customProfile === null
      ? leadingSocPlatforms(detectedPlatforms)
      : [];

  const attributions: HardwareAccessAttribution[] = [];
  for (const ref of references) {
    const attributed = attributeHardwareAccess(
      ref,
      architecture,
      activePlatform,
      customProfile,
    );
    if (!attributed.ok) {
      limitations.push(
        `Failed to attribute reference to ${ref.target_address}: ${attributed.error}`,
      );
      continue;
    }
    const windowed =
      memoryWindows.length > 0
        ? applyMemoryWindows(attributed.value, memoryWindows)
        : null;
    if (
      windowed !== null &&
      findMemoryWindow(memoryWindows, attributed.value.addressValue) !== null
    ) {
      attributions.push(windowed);
      continue;
    }
    attributions.push(promoteTiedCatalogMmio(attributed.value, tiedLeaders));
  }

  if (customProfile !== null) limitations.push(...customProfile.limitations);
  if (boardApplies && boardProfile !== null) {
    limitations.push(...boardProfile.limitations);
  }

  const activeDevices: readonly BoardDeviceAttachment[] = [
    ...(customProfile?.devices ?? []),
    ...(boardApplies && boardProfile !== null ? boardProfile.devices : []),
  ];
  const activeDrivers: readonly BoardDriver[] =
    capturedImageApplies && boardProfile !== null ? boardProfile.drivers : [];
  const activeRecoveries: readonly DriverPeripheralRecovery[] =
    capturedImageApplies && boardProfile !== null
      ? boardProfile.driverRecoveries
      : [];

  const summary = summarizeHardwarePeripheralInteractions(
    attributions,
    architecture,
  );
  const peripheralBlocks = summary.peripheralBlocks.map((block) =>
    enrichBlock(
      block,
      activePlatform,
      customProfile,
      activeDevices,
      activeDrivers,
    ),
  );

  const boardMemory: BoardMemoryAccess[] = memoryWindows.map((item) => ({
    id: item.id,
    name: item.name,
    kind: item.kind,
    baseAddress: item.baseAddress,
    sizeBytes: item.sizeBytes,
    accessCount: attributions.filter((attr) =>
      boardProfile !== null &&
      lookupBoardMemoryWindow(boardProfile, attr.addressValue)?.id === item.id
        ? true
        : findMemoryWindow(memoryWindows, attr.addressValue)?.id === item.id,
    ).length,
    evidence: item.evidence,
  }));

  const unbound = [
    ...(customProfile !== null
      ? customProfile.devices.filter((d) => d.peripheralName === null)
      : []),
    ...(boardApplies && boardProfile !== null
      ? unboundBoardDevices(boardProfile)
      : []),
  ];

  const imageClaims =
    capturedImageApplies && boardProfile?.imageObservations != null
      ? hardwareClaimsFromImage(boardProfile.imageObservations)
      : [];

  return {
    procedure,
    architecture,
    platform,
    ...(customProfile === null ? {} : { customProfileId: customProfile.id }),
    producingSource: null,
    board: boardProfile?.id ?? null,
    boardMcu:
      boardApplies && boardProfile !== null
        ? boardProfile.mcu
        : (customProfile?.model ?? null),
    boardMemory,
    boardUnboundDevices: unbound,
    boardDrivers: [...activeDrivers],
    ...(activeRecoveries.length === 0
      ? {}
      : { driverRecoveries: [...activeRecoveries] }),
    totalReferencesExamined: summary.totalReferencesExamined,
    mmioAccessCount: summary.mmioAccessCount,
    nonMmioAccessCount: summary.nonMmioAccessCount,
    peripheralBlocks,
    attributions,
    detectedPlatforms,
    unsettledFacts:
      activeDevices.length > 0 ? unsettledBoardFacts(activeDevices) : [],
    hardwareClaims: [
      ...hardwareClaimsForBlocks({
        blocks: peripheralBlocks.map((block) => ({
          blockBase: block.blockBase,
          matched: block.socPeripheralNameBasis === "chip_manual",
          basis: block.socPeripheralNameBasis,
          addresses: block.uniqueAddresses,
        })),
        devices: activeDevices,
        drivers: activeDrivers.map((driver) => ({
          id: driver.id,
          evidence: driver.evidence,
          linked: driver.linkage === "linked_in_image",
        })),
      }),
      ...imageClaims,
    ],
    limitations,
  };
};

const HARDWARE_RECONSTRUCTION = "reconstruct_procedure_hardware_interactions";

const producingSourceFrom = (
  execution: AnalysisExecution,
): HardwareProducingSource => ({
  subjectSha256: execution.subject?.sha256 ?? null,
  subjectPath: execution.subject?.path ?? null,
  providerId: execution.provider.id,
  evidenceId: execution.evidenceId ?? null,
  evidenceLinks:
    execution.sourceEvidence?.map((item) => item.evidence_id) ?? [],
});

const retainedReconstruction = (
  result: HardwarePeripheralReconstruction,
  source: HardwareProducingSource,
): HardwareReconstructionPartialObservation => ({
  kind: "hardware-peripheral-reconstruction",
  procedure: result.procedure,
  subjectSha256: source.subjectSha256,
  providerId: source.providerId,
  evidenceId: source.evidenceId,
  evidenceLinks: source.evidenceLinks,
  blocks: result.peripheralBlocks.map((block) => ({
    blockBase: block.blockBase,
    controller: block.socPeripheralName ?? null,
    addresses: [...block.uniqueAddresses],
  })),
});

const validateHardwareProfileInputs = (
  input: ReconstructProcedureHardwareInput,
): Result<CustomHardwareProfile | null, AnalysisInputError> => {
  if (input.board !== undefined && input.platform !== undefined) {
    const selectedBoard = lookupBoardProfile(input.board);
    if (selectedBoard !== null && selectedBoard.soc !== input.platform) {
      return err(
        new AnalysisInputError(HARDWARE_RECONSTRUCTION, undefined, [
          {
            path: ["board"],
            reason: "invalid_value",
            message: `Board ${input.board} targets ${selectedBoard.soc}, which does not match platform ${input.platform}.`,
          },
        ]),
      );
    }
  }
  if (input.svd_xml !== undefined && input.devicetree !== undefined) {
    return err(
      new AnalysisInputError(HARDWARE_RECONSTRUCTION, undefined, [
        {
          path: ["svd_xml"],
          reason: "invalid_value",
          message: "Pass either svd_xml or devicetree, not both.",
        },
      ]),
    );
  }
  if (input.svd_xml !== undefined) {
    const parsedSvd = parseCmsisSvd(input.svd_xml);
    if (!parsedSvd.ok) {
      return err(
        new AnalysisInputError(HARDWARE_RECONSTRUCTION, undefined, [
          {
            path: ["svd_xml"],
            reason: "invalid_value",
            message: parsedSvd.error,
          },
        ]),
      );
    }
    return ok(parsedSvd.value);
  }
  if (input.devicetree !== undefined) {
    return ok(hardwareProfileFromDevicetree(input.devicetree));
  }
  return ok(null);
};

const analyzedReferences = (
  references: z.infer<typeof procedureReferencesSchema>["references"],
): AnalyzedInstructionReference[] =>
  references.flatMap((edge) => {
    const kind = edge.kind;
    if (kind.available && (kind.call || kind.jump) && !kind.data) return [];
    return [
      {
        target_address: edge.target_address,
        source_address: edge.source_address,
        read: kind.available ? kind.read : null,
        write: kind.available ? kind.write : null,
        data: kind.available ? kind.data : null,
        call: kind.available ? kind.call : false,
        jump: kind.available ? kind.jump : false,
        ...(kind.available && typeof kind.operand_index === "number"
          ? { operand_index: kind.operand_index }
          : {}),
        provenance: kind.available ? kind.provenance : null,
      },
    ];
  });

const keepFailure = (
  failure: AnalysisError,
  signal: AbortSignal | undefined,
): Result<HardwarePeripheralReconstruction, AnalysisError> => {
  if (isAborted(signal)) {
    failure.retainSecondaryFailure(
      cancelledBy(HARDWARE_RECONSTRUCTION, signal),
    );
  }
  return err(failure);
};

/**
 * High-level application workflow: Reconstruct hardware peripheral interactions for a given procedure.
 */
export const reconstructProcedureHardwareInteractions = async (
  analysis: AnalysisOperationPort,
  parameters: unknown,
  options?: ExecutionOptions,
): Promise<Result<HardwarePeripheralReconstruction, AnalysisError>> => {
  const signal = options?.signal;
  const parsed = parseAnalysisInput(
    HARDWARE_RECONSTRUCTION,
    parameters,
    reconstructProcedureHardwareInputSchema,
    signal,
  );
  if (!parsed.ok) return parsed;

  const customProfile = validateHardwareProfileInputs(parsed.value);
  if (!customProfile.ok) return customProfile;

  const {
    procedure,
    architecture,
    platform,
    board,
    esp_chip_id,
    uf2_family_id,
  } = parsed.value;

  const execution = await analysis.execute(
    "procedure_references",
    { procedure, direction: "outgoing" },
    options,
  );
  if (!execution.ok) return keepFailure(execution.error, signal);

  const parsedReferences = procedureReferencesSchema.safeParse(
    execution.value.result,
  );
  if (!parsedReferences.success) {
    return keepFailure(
      new AnalysisOutputError(
        "procedure_references",
        "Procedure references output did not match expected reference edge schema",
      ),
      signal,
    );
  }

  const source = producingSourceFrom(execution.value);
  const reconstructed = reconstructHardwareFromReferences(
    analyzedReferences(parsedReferences.data.references),
    architecture,
    procedure,
    platform ?? null,
    board ?? null,
    {
      subjectSha256: source.subjectSha256,
      customProfile: customProfile.value,
      ...(esp_chip_id === undefined ? {} : { espChipId: esp_chip_id }),
      ...(uf2_family_id === undefined ? {} : { uf2FamilyId: uf2_family_id }),
    },
  );
  const result = {
    ...reconstructed,
    producingSource: source,
    limitations: [...execution.value.limitations, ...reconstructed.limitations],
  };
  if (isAborted(signal)) {
    return err(
      cancelledBy(HARDWARE_RECONSTRUCTION, signal, {
        partialObservation: retainedReconstruction(result, source),
      }),
    );
  }
  return ok(result);
};
