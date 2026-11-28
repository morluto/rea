import { z } from "zod";
import {
  boardDeviceAttachmentSchema,
  boardIdSchema,
  type BoardDeviceAttachment,
  type BoardId,
} from "./boardPeripheralProfile.js";
import { boardDriverSchema, type BoardDriver } from "./boardDriverLayer.js";
import { devicetreeSchema } from "./devicetree.js";
import {
  driverPeripheralRecoverySchema,
  type DriverPeripheralRecovery,
} from "./driverPeripheralReverse.js";
import {
  CUSTOM_HARDWARE_SOURCES,
  type CustomHardwareSource,
} from "./hardwareCustomProfile.js";
import {
  CONTROLLER_NAME_BASES,
  HARDWARE_CLAIM_BASES,
  HARDWARE_CLAIM_RULES,
  REGISTER_NAME_BASES,
  type ControllerNameBasis,
  type HardwareClaim,
  type UnsettledBoardFact,
} from "./hardwareFactBasis.js";
import {
  hardwareArchitectureSchema,
  hardwareMemoryRegionKindSchema,
  type HardwareArchitecture,
} from "./hardwareMemoryMap.js";
import type {
  HardwareAccessAttribution,
  HardwarePeripheralBlockSummary,
} from "./hardwarePeripheralAttribution.js";
import {
  SOC_REGISTER_ALIAS_KINDS,
  socPlatformSchema,
  type SocPlatform,
  type SocPlatformMatchCandidate,
} from "./socPeripheralDatabase.js";

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
      "Optional ESP image header chip_id from inspect_artifact (esp-image or esp-flash-image format_metadata) to select the matching Espressif SoC catalog",
    ),
  uf2_family_id: z
    .number()
    .int()
    .min(0)
    .max(0xffffffff)
    .optional()
    .describe(
      "Optional UF2 region family_id from inspect_artifact (uf2-region format_metadata) to select the matching MCU catalog",
    ),
});
export type ReconstructProcedureHardwareInput = z.infer<
  typeof reconstructProcedureHardwareInputSchema
>;

/** Public CLI/MCP contract input schema; keeps `hardware_architecture` distinct from `open_binary.architecture`. */
export const reconstructProcedureHardwareContractInputSchema =
  reconstructProcedureHardwareInputSchema.omit({ architecture: true }).extend({
    hardware_architecture: hardwareArchitectureSchema.describe(
      "Target hardware CPU architecture for memory map and register resolution",
    ),
  });

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

/** Source identity of an explicit CMSIS-SVD or Devicetree map applied to the report. */
export interface CustomHardwareProfileIdentity {
  readonly id: string;
  readonly sourceKind: CustomHardwareSource;
  readonly sourceSha256: string | null;
}

/** Output result detailing reconstructed hardware peripheral interactions for a procedure. */
export interface HardwarePeripheralReconstruction {
  readonly procedure: string;
  readonly architecture: HardwareArchitecture;
  readonly platform: SocPlatform | null;
  readonly board: BoardId | null;
  readonly customProfile?: CustomHardwareProfileIdentity | null;
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

const hardwareAttributionJsonFields = {
  targetAddress: z.string(),
  architecture: hardwareArchitectureSchema,
  regionKind: hardwareMemoryRegionKindSchema,
  regionName: z.string(),
  isMmio: z.boolean(),
  accessKind: z.enum(["read", "write", "read_write", "unknown"]),
  peripheralBlockBase: z.string(),
  peripheralBlockOffset: z.string(),
  controllerId: z.string().nullable().optional(),
  controllerName: z.string().nullable(),
  controllerBasis: z.enum(CONTROLLER_NAME_BASES),
  ambiguousControllers: z.array(z.string()).optional(),
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
} as const;

const reconstructionCommonFields = {
  procedure: z.string(),
  architecture: hardwareArchitectureSchema,
  platform: socPlatformSchema.nullable().optional(),
  board: boardIdSchema.nullable(),
  customProfile: z
    .strictObject({
      id: z.string(),
      sourceKind: z.enum(CUSTOM_HARDWARE_SOURCES),
      sourceSha256: z.string().nullable(),
    })
    .nullable()
    .optional(),
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
      controllerId: z.string().nullable().optional(),
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
} as const;

/** In-memory service schema preserving bigint `addressValue` on attributions. */
export const hardwarePeripheralReconstructionSchema = z.strictObject({
  ...reconstructionCommonFields,
  attributions: z.array(
    z.strictObject({
      ...hardwareAttributionJsonFields,
      addressValue: z.bigint(),
    }),
  ),
});

/** JSON-serializable public CLI/MCP result schema for `reconstruct_procedure_hardware_interactions`. */
export const hardwarePeripheralReconstructionResultSchema = z.strictObject({
  ...reconstructionCommonFields,
  attributions: z.array(z.strictObject(hardwareAttributionJsonFields)),
});

/** Project in-memory reconstruction facts to JSON-serializable public Evidence output. */
export const projectHardwarePeripheralReconstruction = (
  report: HardwarePeripheralReconstruction,
): z.infer<typeof hardwarePeripheralReconstructionResultSchema> =>
  hardwarePeripheralReconstructionResultSchema.parse({
    ...report,
    attributions: report.attributions.map(
      ({ addressValue: _addressValue, ...rest }) => rest,
    ),
  });
