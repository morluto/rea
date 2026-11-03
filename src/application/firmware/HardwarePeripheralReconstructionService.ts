import { z } from "zod";
import type {
  AnalysisOperationPort,
  ExecutionOptions,
} from "../AnalysisProvider.js";
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
import {
  controllerNameBasis,
  CONTROLLER_NAME_BASES,
  REGISTER_NAME_BASES,
  unsettledBoardFacts,
  type ControllerNameBasis,
  type UnsettledBoardFact,
} from "../../domain/firmware/hardwareFactBasis.js";
import {
  boardDriversForControllers,
  boardDriverSchema,
  type BoardDriver,
} from "../../domain/firmware/boardDriverLayer.js";
import {
  boardDeviceAttachmentSchema,
  boardDevicesForPeripheral,
  boardIdSchema,
  lookupBoardMemoryWindow,
  lookupBoardProfile,
  unboundBoardDevices,
  type BoardDeviceAttachment,
  type BoardId,
  type BoardPeripheralProfile,
} from "../../domain/firmware/boardPeripheralProfile.js";
import {
  detectSocPlatform,
  lookupSocPeripheral,
  type SocPlatform,
  socPlatformSchema,
  type SocPlatformMatchCandidate,
} from "../../domain/firmware/socPeripheralDatabase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { err, ok, type Result } from "../../domain/result.js";
import { procedureReferencesResultSchema } from "../../domain/hopperValues.js";

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
      "Optional explicit target SoC family (stm32f1, stm32f4, gd32f1, esp32) for device-specific register mapping",
    ),
  board: boardIdSchema
    .optional()
    .describe(
      "Optional known board. stm32f407-rt-spark selects the STM32F407 map and annotates on-board devices. It must agree with platform when both are set.",
    ),
});
export type ReconstructProcedureHardwareInput = z.infer<
  typeof reconstructProcedureHardwareInputSchema
>;

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

/** Output result detailing reconstructed hardware peripheral interactions for a procedure. */
export interface HardwarePeripheralReconstruction {
  readonly procedure: string;
  readonly architecture: HardwareArchitecture;
  readonly platform: SocPlatform | null;
  readonly board: BoardId | null;
  readonly boardMcu: string | null;
  readonly boardMemory: readonly BoardMemoryAccess[];
  readonly boardUnboundDevices: readonly BoardDeviceAttachment[];
  readonly boardDrivers: readonly BoardDriver[];
  readonly totalReferencesExamined: number;
  readonly mmioAccessCount: number;
  readonly nonMmioAccessCount: number;
  readonly peripheralBlocks: readonly ReconstructedPeripheralBlock[];
  readonly attributions: readonly HardwareAccessAttribution[];
  readonly detectedPlatforms: readonly SocPlatformMatchCandidate[];
  readonly unsettledFacts: readonly UnsettledBoardFact[];
  readonly limitations: readonly string[];
}

export const hardwarePeripheralReconstructionSchema = z.strictObject({
  procedure: z.string(),
  architecture: hardwareArchitectureSchema,
  platform: socPlatformSchema.nullable().optional(),
  board: boardIdSchema.nullable(),
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

const applyBoardMemoryWindow = (
  attribution: HardwareAccessAttribution,
  profile: BoardPeripheralProfile,
): HardwareAccessAttribution => {
  const matched = lookupBoardMemoryWindow(profile, attribution.addressValue);
  if (matched === null) return attribution;
  return {
    ...attribution,
    regionKind: matched.kind,
    regionName: matched.name,
    isMmio: false,
  };
};

const devicesForBlock = (
  profile: BoardPeripheralProfile,
  peripheralNames: ReadonlySet<string>,
): BoardDeviceAttachment[] => {
  const attached = Array.from(peripheralNames).flatMap((name) =>
    boardDevicesForPeripheral(profile, name),
  );
  return attached.sort((left, right) => {
    if (left.id < right.id) return -1;
    if (left.id > right.id) return 1;
    return 0;
  });
};

/**
 * Reconstruct hardware peripheral interactions from a set of analyzed instruction references.
 * Pure deterministic domain workflow for offline and provider-decoupled analysis.
 * A known board refines memory windows and annotates controllers with that board's devices.
 */
export const reconstructHardwareFromReferences = (
  references: readonly AnalyzedInstructionReference[],
  architecture: HardwareArchitecture,
  procedure = "detached",
  platform: SocPlatform | null = null,
  board: BoardId | null = null,
): HardwarePeripheralReconstruction => {
  const limitations: string[] = [];
  const boardProfile = board === null ? null : lookupBoardProfile(board);
  const boardApplies =
    boardProfile !== null &&
    (platform === null || platform === boardProfile.soc);

  if (
    boardProfile !== null &&
    platform !== null &&
    platform !== boardProfile.soc
  ) {
    limitations.push(
      `Board ${boardProfile.id} targets ${boardProfile.soc}; platform ${platform} does not match, so board devices were not applied.`,
    );
  }

  const candidateAddresses = references.map((r) => r.target_address);
  const detectedPlatforms =
    platform === null
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
    platform ??
    (boardApplies && boardProfile !== null
      ? boardProfile.soc
      : chooseDetectedSocPlatform(detectedPlatforms));

  const attributions: HardwareAccessAttribution[] = [];
  for (const ref of references) {
    const attributed = attributeHardwareAccess(
      ref,
      architecture,
      activePlatform,
    );
    if (!attributed.ok) {
      limitations.push(
        `Failed to attribute reference to ${ref.target_address}: ${attributed.error}`,
      );
      continue;
    }
    attributions.push(
      boardApplies && boardProfile !== null
        ? applyBoardMemoryWindow(attributed.value, boardProfile)
        : attributed.value,
    );
  }

  if (boardApplies && boardProfile !== null) {
    limitations.push(...boardProfile.limitations);
  }

  const summary = summarizeHardwarePeripheralInteractions(
    attributions,
    architecture,
  );

  const peripheralBlocks: ReconstructedPeripheralBlock[] =
    summary.peripheralBlocks.map((block) => {
      const matchedNames = new Set<string>();
      let primaryBus: string | null = null;

      if (activePlatform) {
        for (const addr of block.uniqueAddresses) {
          const def = lookupSocPeripheral(addr, activePlatform);
          if (def) {
            matchedNames.add(def.name);
            primaryBus = def.bus;
          }
        }
      }

      return {
        ...block,
        socPeripheralName:
          matchedNames.size > 0
            ? Array.from(matchedNames).sort().join(", ")
            : null,
        socPeripheralNameBasis: controllerNameBasis(matchedNames.size > 0),
        socPeripheralBus: primaryBus,
        boardDevices:
          boardApplies && boardProfile !== null
            ? devicesForBlock(boardProfile, matchedNames)
            : [],
        boardDrivers:
          boardApplies && boardProfile !== null
            ? boardDriversForControllers(boardProfile.drivers, matchedNames)
            : [],
      };
    });

  const boardMemory: BoardMemoryAccess[] =
    boardApplies && boardProfile !== null
      ? boardProfile.memory.map((item) => ({
          id: item.id,
          name: item.name,
          kind: item.kind,
          baseAddress: item.baseAddress,
          sizeBytes: item.sizeBytes,
          accessCount: attributions.filter(
            (itemAttribution) =>
              lookupBoardMemoryWindow(
                boardProfile,
                itemAttribution.addressValue,
              )?.id === item.id,
          ).length,
          evidence: item.evidence,
        }))
      : [];

  return {
    procedure,
    architecture,
    platform,
    board: boardProfile?.id ?? null,
    boardMcu: boardApplies && boardProfile !== null ? boardProfile.mcu : null,
    boardMemory,
    boardUnboundDevices:
      boardApplies && boardProfile !== null
        ? [...unboundBoardDevices(boardProfile)]
        : [],
    boardDrivers:
      boardApplies && boardProfile !== null ? [...boardProfile.drivers] : [],
    totalReferencesExamined: summary.totalReferencesExamined,
    mmioAccessCount: summary.mmioAccessCount,
    nonMmioAccessCount: summary.nonMmioAccessCount,
    peripheralBlocks,
    attributions,
    detectedPlatforms,
    unsettledFacts:
      boardApplies && boardProfile !== null
        ? unsettledBoardFacts(boardProfile.devices)
        : [],
    limitations,
  };
};

/**
 * High-level application workflow: Reconstruct hardware peripheral interactions for a given procedure.
 * Queries provider procedure references, classifies physical memory regions, resolves standard architectural
 * registers, and aggregates interactions into cohesive 4 KiB hardware peripheral blocks.
 */
export const reconstructProcedureHardwareInteractions = async (
  analysis: AnalysisOperationPort,
  parameters: unknown,
  options?: ExecutionOptions,
): Promise<Result<HardwarePeripheralReconstruction, AnalysisError>> => {
  if (options?.signal?.aborted) {
    return err(
      new AnalysisCancelledError("reconstruct_procedure_hardware_interactions"),
    );
  }

  const parsed = reconstructProcedureHardwareInputSchema.safeParse(parameters);
  if (!parsed.success) {
    return err(
      new AnalysisInputError("reconstruct_procedure_hardware_interactions", {
        cause: parsed.error,
      }),
    );
  }

  const { procedure, architecture, platform, board } = parsed.data;
  if (board !== undefined && platform !== undefined) {
    const selectedBoard = lookupBoardProfile(board);
    if (selectedBoard !== null && selectedBoard.soc !== platform) {
      return err(
        new AnalysisInputError(
          "reconstruct_procedure_hardware_interactions",
          undefined,
          [
            {
              path: ["board"],
              reason: "invalid_value",
              message: `Board ${board} targets ${selectedBoard.soc}, which does not match platform ${platform}.`,
            },
          ],
        ),
      );
    }
  }

  const execution = await analysis.execute(
    "procedure_references",
    { procedure, direction: "outgoing" },
    options,
  );

  if (!execution.ok) {
    return execution;
  }

  const parsedReferences = procedureReferencesResultSchema.safeParse(
    execution.value.result,
  );

  if (!parsedReferences.success) {
    return err(
      new AnalysisOutputError(
        "procedure_references",
        "Procedure references output did not match expected reference edge schema",
      ),
    );
  }

  const candidateReferences = parsedReferences.data.references;
  const analyzedReferences: AnalyzedInstructionReference[] = [];

  for (const edge of candidateReferences) {
    const kind = edge.kind;
    const isCallOrJump = kind.available && (kind.call || kind.jump);
    // Ignore direct calls and jumps to other code procedures when analyzing data/MMIO accesses
    if (isCallOrJump && !kind.data) {
      continue;
    }

    analyzedReferences.push({
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
    });
  }

  const result = reconstructHardwareFromReferences(
    analyzedReferences,
    architecture,
    procedure,
    platform ?? null,
    board ?? null,
  );

  return ok({
    ...result,
    limitations: [...execution.value.limitations, ...result.limitations],
  });
};
