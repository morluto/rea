import {
  projectSessionError,
  type GhidraProjection,
} from "./GhidraSessionErrorProjection.js";
import { readRuntimeSetting } from "../config/runtimeAnalysisSettings.js";
import { bindProcessInspectionCancellations } from "../providers/OwnedCommandCleanup.js";
import {
  filterGhidraLiteralCandidates,
  GHIDRA_LITERAL_CANDIDATES_LIMITATION,
} from "./GhidraLiteralSearch.js";
import { ghidraCheckpointSelectionSchema } from "./GhidraCheckpoint.js";
import { ghidraProjectHistoryEvidence } from "./GhidraProjectHistory.js";
import type { Evidence, EvidenceLocation } from "../domain/evidence.js";
import { ghidraProjectCommitmentSchema } from "./GhidraProjectSnapshot.js";
import { analysisSettingDefinition } from "../domain/analysisSettingDefinitions.js";
import {
  DEFAULT_GHIDRA_VALUE_FLOW_MAX_OPERATIONS,
  DEFAULT_GHIDRA_VALUE_FLOW_MAX_INPUTS_PER_OPERATION,
  DEFAULT_GHIDRA_VALUE_FLOW_MAX_EDGES,
} from "../domain/analysisResourceLimits.js";
import { analysisClientFailureForOperation } from "../providers/AnalysisClientFailure.js";
import { analysisErrorWithCleanupDependencies } from "../domain/analysisErrorCleanup.js";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { GHIDRA_BRIDGE_SOURCES } from "./GhidraBridgeSources.js";
import { ghidraProfileComImport } from "./GhidraComImport.js";
import { GHIDRA_RESTRICTED_TEMP_REMEDIATION } from "./GhidraTemporaryDirectory.js";

import {
  createAnalysisExecution,
  type AnalysisClient,
  type AnalysisClientContext,
  type AnalysisOperation,
  type ExecutionOptions,
} from "../ports/AnalysisProvider.js";
import type { AppConfig } from "../config/types.js";
import {
  ghidraSeedCommitmentSchema,
  ghidraSeedFailure,
  ghidraSeedLimitations,
} from "./GhidraAnalysisSeeds.js";
import {
  ghidraPinnedLanguage,
  ghidraProfileDisabledAnalyzers,
  ghidraProfileLanguageOverride,
  ghidraProfilePinnedLanguage,
  sameGhidraDisabledAnalyzers,
  sameGhidraLanguageOverride,
} from "./GhidraAnalysisProfile.js";
import {
  ghidraDisabledAnalyzerFailure,
  ghidraDisabledAnalyzerLimitations,
} from "./GhidraDisabledAnalyzers.js";
import {
  ghidraMipsProfileMismatchReason,
  GHIDRA_MIPS_SOFT_FLOAT_STORAGE,
  ghidraMips1Limitations,
  ghidraMipsSoftFloatFailure,
  ghidraMipsElfImageBase,
  ghidraMipsElfImageBaseCommitment,
  ghidraMipsRelocatableLimitations,
  ghidraMipsSharedLimitations,
  ghidraMipsSoftFloatLimitations,
  isGhidraMipsSoftFloatTarget,
} from "./GhidraMipsProfile.js";
import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import {
  AnalysisArtifactChangedError,
  AnalysisCapabilityUnavailableError,
  AnalysisResourceConstraintError,
  reattributedResourceConstraint,
  cancelledBy,
} from "../domain/analysisErrorCore.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import type { RelationshipCoverage } from "../domain/relationshipCoverage.js";
import type { ProviderOperationHealth } from "../domain/providerOperationHealth.js";
import { ownedJsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err, ok, type Result } from "../domain/result.js";
import type { Logger } from "pino";
import { GhidraClient } from "./GhidraClient.js";
import type { GhidraClientOptions } from "./GhidraClientTypes.js";
import {
  isGhidraFunctionOperation,
  parseGhidraFunctionInput,
  parseGhidraFunctionResult,
  type GhidraFunctionOperation,
} from "./GhidraFunctionValues.js";
import {
  isGhidraInventoryOperation,
  parseGhidraInventoryInput,
  parseGhidraInventoryResult,
} from "./GhidraInventoryValues.js";
import {
  ghidraInstallationDiagnostics,
  type GhidraInstallationInspection,
} from "./GhidraInstallation.js";
import {
  isGhidraPspTarget,
  GHIDRA_PSP_LIMITATIONS,
} from "./GhidraPspProfile.js";
import { ghidraPspExtensionSchema } from "./GhidraPspExtension.js";
import {
  ghidraRiscvCallingConvention,
  ghidraRiscvCallingConventionFailure,
  ghidraRiscvCallingConventionLimitations,
  ghidraRiscvLimitations,
} from "./GhidraRiscvProfile.js";
import { ghidraPePdbLimitations } from "./GhidraPeProfile.js";
import {
  ghidraApplicableKnownProviderDefectLimitations,
  unverifiedGhidraBuildLimitation,
} from "./GhidraReleasePolicy.js";
import { GhidraHeadlessLauncher } from "./GhidraLauncher.js";
import { attestGhidraNativeLoadImage } from "./GhidraLoadImageAttest.js";
import type { NativeAotPeResult } from "../domain/native/nativeAotPe.js";
import { parseContainingProcedureResolution } from "../domain/native/nativeObservation.js";
import { GhidraNativeAotSnapshotOwner } from "./GhidraNativeAotSnapshotOwner.js";
import {
  ghidraHealthLimitations,
  type GhidraSessionSource,
  ghidraEmptyXrefsLimitation,
  ghidraEmptyIncomingReferencesLimitation,
  ghidraEmptyDossierIncomingLimitation,
  ghidraEmptyExternalOutgoingLimitation,
  ghidraEmptyInstructionOutgoingLimitation,
  ghidraEmptyOutgoingReferencesLimitation,
  ghidraNotInListingLimitation,
  ghidraNotInProcedureLimitation,
  windowsP0Limitations,
  limitationsFor,
} from "./GhidraProviderCapabilities.js";
import { GHIDRA_PROVIDER_IDENTITY } from "./GhidraProviderMetadata.js";
import {
  ghidraMachoMainEntryCandidate,
  isGhidraMainSelector,
} from "./GhidraMachoEntryHint.js";
import {
  isGhidraInputFailureCode,
  type GhidraSessionError,
} from "./GhidraSessionError.js";
import {
  ghidraFileOffsetOutcome,
  ghidraFileOffsetUnavailable,
} from "./GhidraFileOffsetFailure.js";
import type { GhidraSessionInfo } from "./GhidraSessionValues.js";
import { ghidraExtensionFailure } from "./extensions/GhidraExtensionFailures.js";
import {
  ghidraExtensionSchema,
  validateGhidraExtensionProfile,
  ghidraExtensionLimitations,
} from "./extensions/GhidraExtensions.js";
import { inspectWindowsNativeReadiness } from "../process/WindowsAuthority.js";
import { ghidraRawBinaryLanguage } from "./GhidraRawBinaryLanguage.js";
import { ghidraDolLanguage, ghidraDolSectionFile } from "./GhidraDolProfile.js";
import { isRecord } from "../kernel/isRecord.js";

/** Production seam for exercising provider projection without a real process. */
export type GhidraProviderClientFactory = (
  options: GhidraClientOptions,
) => Pick<GhidraClient, "start" | "callTool" | "close"> &
  Partial<
    Pick<
      GhidraClient,
      | "callToolIfReady"
      | "checkpointRestore"
      | "operationHealthSnapshot"
      | "runtimeLineage"
      | "readTargetSnapshot"
      | "readTargetSnapshotRanges"
      | "hashTargetSnapshot"
      | "hashTargetSnapshotRanges"
      | "attestDosTargetSnapshot"
    >
  >;

interface GhidraExecutionMetadata {
  readonly sourceEvidence?: readonly Evidence[];
  readonly cachePolicy?: "live";
  readonly rawResult?: JsonValue;
  readonly limitations?: readonly string[];
  readonly locations?: readonly EvidenceLocation[];
  readonly relationshipCoverage?: RelationshipCoverage;
}

/** The ReferenceManager observation record of one function-reference result. */
const referenceObservationRecord = (
  normalized: JsonValue,
): Readonly<Record<string, JsonValue>> | undefined =>
  isRecord(normalized)
    ? (normalized as Readonly<Record<string, JsonValue>>)
    : undefined;

const isEmptyArray = (value: JsonValue | undefined | null): boolean =>
  Array.isArray(value) && value.length === 0;

/**
 * Caveats for the empty reference directions observed in one record: each
 * empty facet is qualified independently, because the provider's empty answer
 * is unresolved, not proof of absence for that direction. External functions
 * (no local body) and the in-body-filtered dossier incoming list get wording
 * that matches what was actually observed.
 */
const isExternalProcedureRecord = (
  record: Readonly<Record<string, JsonValue>>,
): boolean => {
  const procedure = referenceObservationRecord(record.procedure ?? null);
  const classification =
    procedure === undefined
      ? undefined
      : referenceObservationRecord(procedure.classification ?? null);
  return classification?.external === true;
};

const incomingCaveat = (external: boolean): string =>
  external
    ? ghidraEmptyIncomingReferencesLimitation
    : ghidraEmptyDossierIncomingLimitation;

const outgoingCaveat = (external: boolean): string =>
  external
    ? ghidraEmptyExternalOutgoingLimitation
    : ghidraEmptyOutgoingReferencesLimitation;

const emptyReferenceDirectionCaveats = (
  record: Readonly<Record<string, JsonValue>>,
): readonly string[] => {
  const external = isExternalProcedureRecord(record);
  return [
    ...(isEmptyArray(record.incoming_references)
      ? [incomingCaveat(external)]
      : []),
    ...(isEmptyArray(record.outgoing_references)
      ? [outgoingCaveat(external)]
      : []),
  ];
};

/** Caveat for a procedure_references result that resolved no references. */
const emptyProcedureReferencesCaveat = (
  record: Readonly<Record<string, JsonValue>>,
): string | undefined => {
  if (!isEmptyArray(record.references)) return undefined;
  return record.direction === "outgoing"
    ? outgoingCaveat(isExternalProcedureRecord(record))
    : ghidraEmptyIncomingReferencesLimitation;
};

/**
 * Caveats for an empty ReferenceManager observation, in limitation order:
 * the provider's empty answer is unresolved, not proof of absence. xrefs
 * reports per address; the function-reference facets per empty direction.
 */
const emptyReferenceCaveat = (
  operation: GhidraFunctionOperation,
  normalized: JsonValue,
): readonly string[] => {
  if (operation === "xrefs")
    return isEmptyArray(normalized) ? [ghidraEmptyXrefsLimitation] : [];
  const record = referenceObservationRecord(normalized);
  if (record === undefined) return [];
  if (operation === "procedure_references") {
    const caveat = emptyProcedureReferencesCaveat(record);
    return caveat === undefined ? [] : [caveat];
  }
  if (operation === "analyze_function")
    return emptyReferenceDirectionCaveats(record);
  if (operation === "annotate_native_function") {
    const dossier = referenceObservationRecord(record.dossier ?? null);
    return dossier === undefined ? [] : emptyReferenceDirectionCaveats(dossier);
  }
  if (operation === "inspect_native_instruction") {
    // The incoming list and the outgoing references are independent
    // ReferenceManager facets; each empty facet is qualified on its own.
    // The outgoing list is only collected for a decoded instruction — other
    // statuses return before the ReferenceManager is queried at all.
    return [
      ...(isEmptyArray(record.incoming_references)
        ? [ghidraEmptyXrefsLimitation]
        : []),
      ...(record.status === "decoded" && isEmptyArray(record.references)
        ? [ghidraEmptyInstructionOutgoingLimitation]
        : []),
    ];
  }
  return [];
};

const GHIDRA_PROFILE_CONFLICT_REMEDIATION =
  "Reopen the target with open_binary after calling close_binary and resolving any cleanup failure, or rerun the CLI command, so REA resolves a fresh Ghidra analysis profile from the current configuration and target. Repeating the request against the committed profile is not expected to succeed.";

/**
 * The committed analysis profile no longer matches the configuration,
 * installation or target this session would open; only a fresh profile
 * resolution can reconcile them.
 */
const ghidraProfileConflict = (
  operation: string,
  reason: string,
  diagnostics: Readonly<Record<string, JsonValue>> = {},
): ProviderAdapterError =>
  new ProviderAdapterError("ghidra", operation, {
    userMessage: `The committed Ghidra analysis profile does not match the current configuration or target. ${reason}`,
    remediationAction: GHIDRA_PROFILE_CONFLICT_REMEDIATION,
    diagnostics: { reason, ...diagnostics },
  });
/**
 * Caveat for a containing-procedure lookup in mapped memory that found no
 * function: the function inventory lacks the address, which does not establish
 * that its bytes are not code. An outside-segments answer has no such recovery.
 */
const containingProcedureAbsenceCaveat = (
  operation: AnalysisOperation,
  normalized: JsonValue,
  source: GhidraSessionSource,
): readonly string[] => {
  if (operation !== "resolve_containing_procedure") return [];
  const resolution = parseContainingProcedureResolution(normalized);
  return resolution.ok &&
    !resolution.value.found &&
    resolution.value.reason === "not_in_procedure"
    ? [ghidraNotInProcedureLimitation(source)]
    : [];
};

/**
 * Caveat for an instruction query in mapped memory that Ghidra's listing does
 * not cover: no decode was attempted, so code there remains possible.
 */
const instructionListingAbsenceCaveat = (
  operation: GhidraFunctionOperation,
  normalized: JsonValue,
  source: GhidraSessionSource,
): readonly string[] => {
  if (operation !== "inspect_native_instruction") return [];
  const record = referenceObservationRecord(normalized);
  return record?.status === "not-in-listing"
    ? [ghidraNotInListingLimitation(source)]
    : [];
};

/** Build one AnalysisClient for an admitted Ghidra target and profile. */
export const createGhidraProviderClient = (input: {
  readonly config: AppConfig;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly logger: Logger;
  readonly clientFactory: GhidraProviderClientFactory;
  readonly admission: GhidraClientAdmission;
  readonly context?: AnalysisClientContext;
  readonly installation: GhidraInstallationInspection;
  readonly signal: AbortSignal;
}): Result<AnalysisClient, AnalysisError> => {
  const { config, logger, clientFactory, context, installation } = input;
  const { target, profile } = input.admission;
  const prerequisites = ghidraClientPrerequisites(profile, installation);
  if (!prerequisites.ok) return prerequisites;
  const committedProfile = prerequisites.value.profile;
  const comImport =
    target.format === "dos-com"
      ? ghidraProfileComImport(committedProfile.parameters)
      : undefined;
  if (comImport?.ok === false)
    return err(ghidraProfileConflict("open_binary", comImport.error));
  const comSelection = comImport?.value;
  const checkpoint = ghidraCheckpointSelectionSchema
    .optional()
    .safeParse(committedProfile.parameters.owned_checkpoint);
  if (
    !checkpoint.success ||
    (config.ghidraCheckpointDirectory !== undefined) !==
      (checkpoint.data !== undefined)
  )
    return err(
      ghidraProfileConflict(
        "open_binary",
        "Resolve REA_GHIDRA_CHECKPOINT_DIR into the analysis profile before opening the session.",
      ),
    );
  const psp = isGhidraPspTarget(target);
  const pspExtension = psp
    ? ghidraPspExtensionSchema.safeParse(
        committedProfile.parameters.psp_extension,
      )
    : null;
  if (
    pspExtension !== null &&
    (!pspExtension.success ||
      committedProfile.parameters.language_id !== "Allegrex:LE:32:default" ||
      committedProfile.parameters.loader !== "PspElfLoader")
  )
    return err(
      ghidraProfileConflict(
        "open_binary",
        "Resolve the supported PSP profile and installed Allegrex extension before opening the session.",
      ),
    );
  const softFloat = isGhidraMipsSoftFloatTarget(target);
  if (
    softFloat !==
    (committedProfile.parameters.mips_soft_float_storage ===
      GHIDRA_MIPS_SOFT_FLOAT_STORAGE)
  )
    return err(
      ghidraProfileConflict(
        "open_binary",
        "Resolve the soft-float MIPS storage policy into the analysis profile before opening the session.",
      ),
    );
  const elfImageBase = ghidraMipsElfImageBase(target);
  if (
    !isDeepStrictEqual(
      committedProfile.parameters.elf_image_base,
      ghidraMipsElfImageBaseCommitment(target),
    )
  )
    return err(
      new ProviderAdapterError("ghidra", "open_binary", {
        diagnostics: {
          reason:
            "Resolve the MIPS shared-image link base into the analysis profile before opening the session.",
        },
      }),
    );
  const riscvCallingConvention = ghidraRiscvCallingConvention(target);
  if (
    riscvCallingConvention !==
    committedProfile.parameters.riscv_calling_convention
  )
    return err(
      ghidraProfileConflict(
        "open_binary",
        "Resolve the RISC-V calling-convention policy into the analysis profile before opening the session.",
      ),
    );
  const extensionProfile = ghidraExtensionSchema
    .array()
    .safeParse(committedProfile.parameters.analysis_extensions ?? []);
  if (
    !extensionProfile.success ||
    (config.ghidraNativeAotJar !== undefined &&
      extensionProfile.data.length === 0)
  )
    return err(
      ghidraProfileConflict(
        "open_binary",
        "Resolve the configured Ghidra extensions into an analysis profile before opening the session.",
      ),
    );
  const extensions = extensionProfile.data;
  const projectProfile = ghidraProjectCommitmentSchema
    .optional()
    .safeParse(committedProfile.parameters.existing_project);
  if (
    !projectProfile.success ||
    (config.ghidraExistingProject === undefined) !==
      (projectProfile.data === undefined) ||
    (projectProfile.data !== undefined &&
      (projectProfile.data.configured_path !==
        config.ghidraExistingProject?.path ||
        (config.ghidraExistingProject?.programName !== undefined &&
          config.ghidraExistingProject.programName !==
            projectProfile.data.program_name)))
  )
    return err(
      ghidraProfileConflict(
        "open_binary",
        "Resolve the selected Ghidra project into a fresh analysis profile before opening the session.",
      ),
    );
  const project = projectProfile.data;
  const projection: GhidraProjection = {
    limits: config,
    programName: project?.program_name,
    source:
      project !== undefined
        ? "existing-project"
        : checkpoint.data !== undefined
          ? "owned-checkpoint"
          : "fresh-import",
  };
  const seedProfile = ghidraSeedCommitmentSchema
    .optional()
    .safeParse(committedProfile.parameters.analysis_seeds);
  if (
    !seedProfile.success ||
    (config.ghidraSeedFile === undefined) !== (seedProfile.data === undefined)
  )
    return err(
      ghidraProfileConflict(
        "open_binary",
        "Resolve REA_GHIDRA_SEED_FILE into an analysis profile before opening the session.",
      ),
    );
  const seeds = seedProfile.data;
  const parameterLanguage = ghidraProfileLanguageOverride(
    committedProfile.parameters,
  );
  const pinnedLanguage = ghidraProfilePinnedLanguage(
    committedProfile.parameters,
  );
  const targetLanguage = ghidraPinnedLanguage(target);
  if (pinnedLanguage !== undefined && targetLanguage === undefined)
    return err(
      ghidraProfileConflict(
        "open_binary",
        `The committed profile pins the ${pinnedLanguage.languageId} language, which the current target does not establish; reopen an admitted target to resolve a new profile.`,
      ),
    );
  // Provider-pinned profiles declare their language through the same
  // parameter slot caller-configured profiles use, so only an environment
  // override conflicts with the pin; the slot itself carries it.
  if (
    pinnedLanguage !== undefined &&
    config.ghidraLanguageOverride !== undefined
  )
    return err(
      ghidraProfileConflict(
        "open_binary",
        `The committed profile pins its import language, ${pinnedLanguage.languageId}; REA_GHIDRA_LANGUAGE_ID/REA_GHIDRA_COMPILER_SPEC_ID cannot be combined with it. Reopen the target without the override.`,
      ),
    );
  if (
    !sameGhidraLanguageOverride(
      parameterLanguage,
      config.ghidraLanguageOverride ?? targetLanguage,
    )
  )
    return err(
      ghidraProfileConflict(
        "open_binary",
        "The committed analysis profile and REA_GHIDRA_LANGUAGE_ID/REA_GHIDRA_COMPILER_SPEC_ID differ; reopen the target to resolve a new profile.",
      ),
    );
  // Both caller-selected and provider-pinned languages use the validated
  // committed slot; the profile cannot supply its own applicability proof.
  const mipsProfileMismatch = ghidraMipsProfileMismatchReason(
    target,
    committedProfile.parameters,
    project !== undefined &&
      committedProfile.parameters.import_mode ===
        "existing-project-private-copy",
  );
  if (mipsProfileMismatch !== null)
    return err(ghidraProfileConflict("open_binary", mipsProfileMismatch));
  const importLanguage = parameterLanguage;
  const disabledAnalyzers = ghidraProfileDisabledAnalyzers(
    committedProfile.parameters,
  );
  if (
    !sameGhidraDisabledAnalyzers(
      disabledAnalyzers,
      config.ghidraDisabledAnalyzers,
    )
  )
    return err(
      ghidraProfileConflict(
        "open_binary",
        "The committed analysis profile and REA_GHIDRA_DISABLED_ANALYZERS differ; reopen the target to resolve a new profile.",
      ),
    );

  const invalidProfile = validateGhidraExtensionProfile(
    extensions,
    config,
    target,
    installation.platform,
  );
  if (invalidProfile !== null)
    return err(ghidraProfileConflict("open_binary", invalidProfile));
  let extensionFailure: AnalysisError | undefined;
  // Replaced by the reported outcome once the session handshake is checked.
  const seedLimitations: string[] = [...ghidraSeedLimitations(seeds)];
  const pdbLimitations: string[] = [];
  // Replaced by the reported storage outcome once the handshake is checked.
  const softFloatLimitations: string[] = [
    ...ghidraMipsSoftFloatLimitations(softFloat),
  ];
  // Replaced by the reported prototype outcome once the handshake is checked.
  const riscvCallingConventionLimitations: string[] = [
    ...ghidraRiscvCallingConventionLimitations(riscvCallingConvention),
  ];
  // Replaced by the reported per-program outcome once the handshake is checked.
  const disabledAnalyzerLimitations: string[] = [];
  const rawLanguage =
    target.format === "raw-binary"
      ? ghidraRawBinaryLanguage(target.architecture)
      : undefined;
  const targetLimitations = [
    ...(target.format === "dos-mz"
      ? [
          "DOS MZ uses 16-bit x86 real mode with the Ghidra load segment 0x1000. Returned addresses are linear byte coordinates; they do not identify a unique segment:offset alias.",
          "Static DOS analysis does not emulate BIOS, DOS interrupts, device ports, or self-modifying unpacking code. Packed targets require a separately identified unpacked artifact for original-program analysis; appended overlays are not the initialized load module.",
        ]
      : []),
    ...(target.format === "gamecube-dol"
      ? [
          "GameCube DOL analysis maps the header's text and data sections at their load addresses; file bytes outside those sections (the 256-byte header and any padding) are not mapped.",
          "The default language is stock Ghidra PowerPC:BE:32:default. Broadway-specific paired-single and Gekko instructions are not decoded unless REA_GHIDRA_LANGUAGE_ID selects an installed variant such as PowerPC:BE:32:Gekko_Broadway.",
          "BSS is mapped uninitialized only outside the data sections it overlaps. The DOL header is not an identification of the producing SDK, and no runtime initialization, OS, or hardware state is modeled.",
        ]
      : []),
    ...(target.format === "raw-binary"
      ? [
          "Headerless raw-binary analysis uses the caller-supplied architecture and entry address; file offset 0 is mapped at that address. Headers are not discovered from file bytes.",
          "Little-endian generic Ghidra languages are used for x86, x86_64, arm, arm64, and NMOS 6502; m68k uses the big-endian 68000 default language, which decodes the 68040 superset. Big-endian ARM, Thumb-only, Cortex-M, 65C02, 65816, separate 68020/68030/CPU32/ColdFire variants, and other processor variants are unsupported in this increment.",
          "Static analysis does not emulate reset vectors, memory-mapped I/O, or firmware boot sequences.",
        ]
      : []),
    ...(target.architecture === "mips" ? (target.mips.limitations ?? []) : []),
    ...(committedProfile.parameters.mips_abi_basis === "inferred-o32-assumption"
      ? [
          "The ELF header declares no ABI field and no ABI flags record was observed; o32 calling conventions are an analysis assumption of this lane, not a declared fact.",
          "Floating-point ABI semantics are unverified for this recordless legacy admission.",
        ]
      : []),
    ...ghidraMips1Limitations(
      target,
      importLanguage,
      pinnedLanguage !== undefined,
    ),
    ...ghidraMipsRelocatableLimitations(target),
    ...ghidraMipsSharedLimitations(target),
    ...ghidraRiscvLimitations(target),
  ];
  const providerLimitations =
    installation.platform === "win32"
      ? windowsP0Limitations
      : installation.platform === "darwin"
        ? [
            "macOS sessions require a matching executable Ghidra native decompiler; REA checks for it but does not build native components or change Gatekeeper quarantine state.",
          ]
        : [];
  if (input.signal.aborted)
    return err(
      cancelledBy("create_analysis_client", input.signal, {
        diagnostics: ghidraInstallationDiagnostics(installation),
      }),
    );
  // An invalid decompile seed is refused only by operations that use it.
  const decompileTimeout = readRuntimeSetting(
    () => config.ghidraDecompileTimeoutSeconds,
  );
  const launcherDecompileTimeout = decompileTimeout.ok
    ? decompileTimeout.value
    : undefined;
  const startupTimeout = readRuntimeSetting(
    () => config.ghidraStartupTimeoutMs,
  );
  if (!startupTimeout.ok) return startupTimeout;
  const client = clientFactory({
    ...(checkpoint.data === undefined ? {} : { checkpoint: checkpoint.data }),
    startupTimeoutMs: startupTimeout.value,
    readStartupTimeoutMs: () => config.ghidraStartupTimeoutMs,
    bridgeMaxRequestBytes: config.bridgeMaxRequestBytes,
    bridgeMaxReplyBytes: config.bridgeMaxReplyBytes,
    platform: installation.platform,
    ...(project === undefined ? {} : { existingProject: true }),
    launcher: new GhidraHeadlessLauncher({
      ...(project === undefined
        ? {}
        : {
            existingProject: {
              projectPath: project.project_path,
              projectName: project.project_name,
              programName: project.program_name,
              sha256: project.sha256,
            },
          }),
      environment: input.environment,
      analyzeHeadlessPath: prerequisites.value.analyzeHeadlessPath,
      configurationDirectoryName:
        prerequisites.value.configurationDirectoryName,
      javaHome: prerequisites.value.javaHome,
      ...(installation.javaVmName === undefined
        ? {}
        : { javaVmName: installation.javaVmName }),
      bridgeScriptPath: fileURLToPath(
        new URL(
          `../../bridge/ghidra/${GHIDRA_BRIDGE_SOURCES.bridge}`,
          import.meta.url,
        ),
      ),
      ...(pspExtension?.success === true
        ? { pspExtension: pspExtension.data }
        : {}),
      ...(softFloat ? { mipsSoftFloat: true as const } : {}),
      ...(elfImageBase === undefined ? {} : { elfImageBase }),
      ...(riscvCallingConvention === undefined
        ? {}
        : { riscvCallingConvention }),
      ...(target.format === "dos-mz" ? { dosMz: true } : {}),
      ...(comSelection === undefined
        ? {}
        : { dosCom: { loader: comSelection.loader } }),
      ...(rawLanguage === undefined || target.format !== "raw-binary"
        ? {}
        : {
            rawBinary: {
              languageId: rawLanguage.languageId,
              compilerSpecId: rawLanguage.compilerSpecId,
              baseAddr: target.entryPoint,
            },
          }),
      ...(target.format === "gamecube-dol"
        ? {
            gamecubeDol: {
              ...ghidraDolLanguage(importLanguage),
              sectionFile: ghidraDolSectionFile(target.dol),
            },
          }
        : importLanguage === undefined
          ? {}
          : { languageOverride: importLanguage }),
      ...(config.ghidraDisabledAnalyzers === undefined
        ? {}
        : { disabledAnalyzers: config.ghidraDisabledAnalyzers }),
      ...(launcherDecompileTimeout === undefined
        ? {}
        : { decompileTimeoutSeconds: launcherDecompileTimeout }),
      ...(seeds === undefined ? {} : { analysisSeeds: seeds }),
      platform: installation.platform,
      ...(extensions.length === 0 ? {} : { analysisExtensions: extensions }),
    }),
    targetPath:
      installation.platform === "win32"
        ? (target.sourcePath ?? target.path)
        : target.path,
    targetSha256: target.sha256,
    transport:
      installation.platform === "win32"
        ? "authenticated-loopback-tcp"
        : "unix-socket",
    providerVersion: prerequisites.value.providerVersion,
    profileDigest: committedProfile.digest,
    ...(["dos-mz", "dos-com"].includes(target.format)
      ? {
          expectedLanguageId: "x86:LE:16:Real Mode",
          expectedCompilerSpecId: "default",
        }
      : rawLanguage === undefined
        ? importLanguage === undefined
          ? {}
          : {
              expectedLanguageId: importLanguage.languageId,
              ...(importLanguage.compilerSpecId === undefined
                ? {}
                : { expectedCompilerSpecId: importLanguage.compilerSpecId }),
            }
        : {
            expectedLanguageId: rawLanguage.languageId,
            expectedCompilerSpecId: rawLanguage.compilerSpecId,
          }),
    ...(psp
      ? {
          expectedLanguageId: "Allegrex:LE:32:default",
          expectedCompilerSpecId: "default",
        }
      : {}),
    ...(elfImageBase === undefined
      ? {}
      : { expectedImageBase: `0x${elfImageBase}` }),
    ...(context === undefined ? {} : { runId: context.runId }),
    logger: logger.child({ layer: "ghidra-bridge" }),
  });
  // Startup failures retain installation guidance; only a previously running
  // provider can be described as lost and reopened.
  let providerStarted = false;
  // Selects recovery guidance only; every session checks its handshake before
  // its first query. A provider lost during the first query of any other
  // session keeps installation guidance until it has answered a request.
  const handshakeEstablishesProvider =
    project !== undefined ||
    target.format === "pe" ||
    extensions.length > 0 ||
    seeds !== undefined ||
    disabledAnalyzers !== undefined ||
    softFloat ||
    riscvCallingConvention !== undefined;
  const lostProviderHealth = (): ProviderOperationHealth | undefined =>
    providerStarted ? client.operationHealthSnapshot?.() : undefined;
  // Only a thin image REA imported itself has Ghidra's import at the declared
  // vmaddrs; universal slices and caller projects are not established here.
  const machoMainEntryHint = async (
    failure: GhidraSessionError,
    request: Readonly<Record<string, JsonValue>>,
    signal: AbortSignal | undefined,
  ): Promise<{
    readonly hint?: string;
    readonly cleanupFailure?: AnalysisError;
  }> => {
    if (
      target.format !== "mach-o" ||
      projection.source === "existing-project" ||
      failure.kind !== "remote" ||
      failure.remoteCode !== "procedure_not_found" ||
      !isGhidraMainSelector(request.procedure) ||
      client.readTargetSnapshotRanges === undefined
    )
      return {};
    const read = await client.readTargetSnapshotRanges(
      ghidraMachoMainEntryCandidate,
      signal,
    );
    if (!read.ok)
      return read.error.cleanupFailure === undefined
        ? {}
        : { cleanupFailure: read.error.cleanupFailure };
    if (read.value === undefined) return {};
    const { address, fileOffset } = read.value;
    const observed = await client.callTool(
      "procedure_address",
      {
        procedure: address,
        ...(request.document === undefined
          ? {}
          : { document: request.document }),
      },
      signal === undefined ? undefined : { signal },
    );
    if (!observed.ok)
      return observed.error.cleanupFailure === undefined
        ? {}
        : { cleanupFailure: observed.error.cleanupFailure };
    // This lookup can also resolve a containing function. Only its exact
    // entry can substantiate the candidate derived from LC_MAIN.
    if (observed.value !== address) return {};
    return {
      hint: `Retry the same operation at Ghidra procedure address ${address} (Mach-O LC_MAIN file offset ${fileOffset}). For CLI decompile, use --procedure ${address}. For MCP, set procedure to "${address}".`,
    };
  };
  let projectHistory: Evidence | undefined;
  // The opened Program language, recorded from the handshake. Unknown until
  // then, so a defect whose architecture cannot be matched is not attached.
  let programLanguageId: string | undefined;
  const checkSessionObservations = async (
    operation: AnalysisOperation,
    info: GhidraSessionInfo,
  ): Promise<AnalysisError | undefined> => {
    programLanguageId = info.target.language_id;
    if (target.format === "pe") {
      pdbLimitations.splice(
        0,
        pdbLimitations.length,
        ...ghidraPePdbLimitations(target, info.pdb),
      );
    }
    if (project !== undefined) {
      extensionFailure = ghidraExtensionFailure(
        extensions,
        info.analysis_extensions ?? [],
        operation,
      );
      if (extensionFailure === undefined)
        projectHistory ??= ghidraProjectHistoryEvidence(
          target,
          committedProfile,
          info,
        );
    } else {
      const callingConventionReason =
        ghidraMipsSoftFloatFailure(softFloat, info.mips_soft_float_storage) ??
        ghidraRiscvCallingConventionFailure(
          riscvCallingConvention,
          info.riscv_calling_convention,
        );
      extensionFailure =
        ghidraExtensionFailure(
          extensions,
          info.analysis_extensions ?? [],
          operation,
        ) ??
        ghidraSeedFailure(seeds, info.analysis_seeds, operation) ??
        ghidraDisabledAnalyzerFailure(
          disabledAnalyzers,
          info.disabled_analyzers,
          operation,
        ) ??
        (callingConventionReason === undefined
          ? undefined
          : new ProviderAdapterError("ghidra", operation, {
              diagnostics: { reason: callingConventionReason },
            }));
      if (extensionFailure === undefined && info.analysis_seeds !== undefined)
        seedLimitations.splice(
          0,
          seedLimitations.length,
          ...ghidraSeedLimitations(seeds, info.analysis_seeds),
        );
      if (extensionFailure === undefined)
        softFloatLimitations.splice(
          0,
          softFloatLimitations.length,
          ...ghidraMipsSoftFloatLimitations(
            softFloat,
            info.mips_soft_float_storage,
          ),
        );
      if (extensionFailure === undefined)
        riscvCallingConventionLimitations.splice(
          0,
          riscvCallingConventionLimitations.length,
          ...ghidraRiscvCallingConventionLimitations(
            riscvCallingConvention,
            info.riscv_calling_convention,
          ),
        );
      if (extensionFailure === undefined)
        disabledAnalyzerLimitations.splice(
          0,
          disabledAnalyzerLimitations.length,
          ...ghidraDisabledAnalyzerLimitations(info.disabled_analyzers),
        );
    }
    if (extensionFailure === undefined) return undefined;
    const closed = await client.close();
    return closed.ok
      ? extensionFailure
      : analysisErrorWithCleanupDependencies(
          extensionFailure,
          closed.error,
          operation,
        );
  };
  const startSession = async (
    operation: AnalysisOperation,
    options?: ExecutionOptions,
  ): Promise<Result<GhidraSessionInfo, AnalysisError>> => {
    const started = await client.start(options?.signal, options?.progress);
    if (!started.ok)
      return err(
        projectSessionError(
          operation,
          started.error,
          projection,
          lostProviderHealth(),
        ),
      );
    if (operation === "health" || handshakeEstablishesProvider)
      providerStarted = true;
    const failed = await checkSessionObservations(operation, started.value);
    return failed === undefined ? started : err(failed);
  };
  const releaseLimitation = unverifiedGhidraBuildLimitation(
    prerequisites.value.providerVersion,
  );
  const sessionLimitations = (
    operation: AnalysisOperation,
  ): readonly string[] => {
    const restored = client.checkpointRestore?.();
    return [
      ...(restored === undefined
        ? []
        : restored === null
          ? [
              "Created the initial owned Ghidra Program from the executable and saved its analysis checkpoint; metadata edits are saved on normal close.",
            ]
          : [
              `Restored owned Program ${restored.path} (SHA-256 ${restored.sha256}); auto-analysis was not rerun.`,
            ]),
      ...providerLimitations,
      ...targetLimitations,
      ...(psp ? GHIDRA_PSP_LIMITATIONS : []),
      ...softFloatLimitations,
      ...riscvCallingConventionLimitations,
      ...ghidraExtensionLimitations(extensions),
      ...seedLimitations,
      ...disabledAnalyzerLimitations,
      ...pdbLimitations,
      ...(releaseLimitation === undefined ? [] : [releaseLimitation]),
      ...ghidraApplicableKnownProviderDefectLimitations(
        prerequisites.value.providerVersion,
        programLanguageId,
        operation,
      ),
    ];
  };
  const nativeAotOwner =
    target.format === "pe"
      ? new GhidraNativeAotSnapshotOwner({
          targetSha256: target.sha256,
          targetPath: target.path,
          readSnapshot: client.readTargetSnapshot?.bind(client),
          projectFailure: (operation, failure) =>
            projectSessionError(operation, failure, projection),
        })
      : undefined;
  const projectExecution = (
    operation: AnalysisOperation,
    normalized: JsonValue,
    observation: GhidraExecutionMetadata = {},
  ) => {
    return createAnalysisExecution(normalized, committedProfile.provider, {
      ...observation,
      ...(operation === "analyze_function"
        ? {
            requiresSourceEvidence: true as const,
            cachePolicy: "live" as const,
          }
        : {}),
      ...(projectHistory === undefined
        ? {}
        : {
            sourceEvidence: [
              ...(observation.sourceEvidence ?? []),
              projectHistory,
            ],
          }),
      analysisProfile: committedProfile,
      limitations: [
        ...limitationsFor(operation, projection.source),
        ...(observation.limitations ?? []),
        ...sessionLimitations(operation),
      ],
    });
  };
  const inventoryExecution = (
    operation: "list_documents" | "list_procedures",
    called: Result<JsonValue, GhidraSessionError>,
  ) => {
    if (!called.ok)
      return err(
        projectSessionError(
          operation,
          called.error,
          projection,
          lostProviderHealth(),
        ),
      );
    const parsed = parseGhidraInventoryResult(operation, called.value, null);
    if (!parsed.ok) return parsed;
    const { value, ...observation } = parsed.value;
    return ok(projectExecution(operation, value, observation));
  };
  const loadImageExecution = async (raw: JsonValue, signal?: AbortSignal) => {
    const operation = "inspect_native_load_image";
    const measured = parseGhidraInventoryResult(operation, raw, null);
    if (!measured.ok) return measured;
    const { value: observed, ...observation } = measured.value;
    let derived: NativeAotPeResult | undefined;
    if (target.format === "pe") {
      if (nativeAotOwner === undefined)
        return err(
          new ProviderAdapterError("ghidra", operation, {
            diagnostics: {
              reason:
                "The admitted PE session has no read-only NativeAOT snapshot owner.",
            },
          }),
        );
      const result = await nativeAotOwner.derive(
        observed.image_base,
        operation,
        signal,
        raw,
      );
      if (!result.ok) return result;
      derived = result.value;
    }
    const attested = await attestGhidraNativeLoadImage({
      target,
      operation,
      measured: observed,
      client,
      languageOverride: importLanguage,
      comSelection,
      mapSessionError: (failure) =>
        projectSessionError(
          operation,
          failure,
          projection,
          lostProviderHealth(),
        ),
      nativeAotResult: derived,
      signal,
    });
    return attested.ok
      ? ok(
          projectExecution(
            operation,
            ownedJsonValueSchema.parse(attested.value),
            observation,
          ),
        )
      : attested;
  };
  return ok<AnalysisClient>({
    execute: async (operation, parameters, options) => {
      if (extensionFailure !== undefined) return err(extensionFailure);
      if (
        operation !== "health" &&
        !isGhidraInventoryOperation(operation) &&
        !isGhidraFunctionOperation(operation)
      )
        return err(
          new AnalysisCapabilityUnavailableError(
            GHIDRA_PROVIDER_IDENTITY.id,
            operation,
            "The Ghidra adapter does not declare this operation.",
          ),
        );
      if (operation === "health") {
        const started = await startSession(operation, options);
        if (!started.ok) return started;
        return ok(
          createAnalysisExecution(started.value, committedProfile.provider, {
            analysisProfile: committedProfile,
            limitations: [
              ...ghidraHealthLimitations(projection.source),
              ...sessionLimitations(operation),
            ],
          }),
        );
      }
      let input: ReturnType<typeof parseGhidraInventoryInput>;
      if (isGhidraFunctionOperation(operation)) {
        const parsed = parseGhidraFunctionInput(operation, parameters);
        if (!parsed.ok) return parsed;
        input = { ...parsed, namingRequest: null };
      } else input = parseGhidraInventoryInput(operation, parameters);
      if (!input.ok) return input;
      const decompile = analysisSettingDefinition(
        "ghidra.decompile_timeout_seconds",
      ).operations.includes(operation);
      const valueFlow = analysisSettingDefinition(
        "ghidra.value_flow_max_operations",
      ).operations.includes(operation);
      const selectLimits = () => ({
        ...(decompile
          ? {
              decompileTimeoutSeconds:
                config.ghidraDecompileTimeoutSeconds ?? null,
              decompileMaxPayloadMiB:
                config.ghidraDecompileMaxPayloadMiB ?? null,
            }
          : {}),
        ...(valueFlow
          ? {
              valueFlowLimits: {
                max_operations:
                  config.ghidraValueFlowMaxOperations ??
                  DEFAULT_GHIDRA_VALUE_FLOW_MAX_OPERATIONS,
                max_inputs_per_operation:
                  config.ghidraValueFlowMaxInputsPerOperation ??
                  DEFAULT_GHIDRA_VALUE_FLOW_MAX_INPUTS_PER_OPERATION,
                max_edges:
                  config.ghidraValueFlowMaxEdges ??
                  DEFAULT_GHIDRA_VALUE_FLOW_MAX_EDGES,
              },
            }
          : {}),
      });
      const admittedLimits = readRuntimeSetting(selectLimits);
      if (!admittedLimits.ok) return admittedLimits;
      const operationLimits = admittedLimits.value;
      // A report binds before any query runs. The client shares one startup
      // attempt, so `callTool` reuses this launch; a restart is checked again.
      const started = await startSession(operation, options);
      if (!started.ok) return started;
      const called = await client.callTool(operation, input.value, {
        ...operationLimits,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
        ...(options?.progress === undefined
          ? {}
          : { progress: options.progress }),
      });
      if (called.ok) providerStarted = true;
      if (operation === "list_documents" || operation === "list_procedures")
        return inventoryExecution(operation, called);
      if (!called.ok) {
        const entry = await machoMainEntryHint(
          called.error,
          input.value,
          options?.signal,
        );
        const projected = projectSessionError(
          operation,
          called.error,
          projection,
          lostProviderHealth(),
          input.value,
          entry.hint,
        );
        return err(
          entry.cleanupFailure === undefined
            ? projected
            : analysisErrorWithCleanupDependencies(
                projected,
                entry.cleanupFailure,
                operation,
              ),
        );
      }
      if (operation === "inspect_native_load_image")
        return loadImageExecution(called.value, options?.signal);
      const result = isGhidraFunctionOperation(operation)
        ? parseGhidraFunctionResult(operation, called.value)
        : parseGhidraInventoryResult(
            operation,
            called.value,
            input.namingRequest,
          );
      if (!result.ok) return result;
      let { value: normalized, ...observation } = result.value;
      let executionMetadata: GhidraExecutionMetadata = observation;
      const absenceCaveats = isGhidraFunctionOperation(operation)
        ? [
            ...emptyReferenceCaveat(operation, normalized),
            ...instructionListingAbsenceCaveat(
              operation,
              normalized,
              projection.source,
            ),
          ]
        : containingProcedureAbsenceCaveat(
            operation,
            normalized,
            projection.source,
          );
      if (absenceCaveats.length > 0) {
        // An absent answer is the provider's observation, not proof: distinguish
        // "this analysis resolved none" from "there are none".
        executionMetadata = {
          ...executionMetadata,
          limitations: [
            ...(executionMetadata.limitations ?? []),
            ...absenceCaveats,
          ],
        };
      }
      if (
        (operation === "search_procedures" || operation === "search_strings") &&
        input.value.mode === "literal" &&
        input.value.case_sensitive === false &&
        typeof input.value.pattern === "string"
      ) {
        const filtered = filterGhidraLiteralCandidates(
          normalized,
          input.value.pattern,
        );
        // Retain the bridge reply only when it is a distinct representation:
        // an unnarrowed candidate list would repeat the matches in full.
        if (filtered.narrowed) {
          normalized = filtered.value;
          executionMetadata = {
            ...executionMetadata,
            rawResult: called.value,
            limitations: [
              ...(executionMetadata.limitations ?? []),
              GHIDRA_LITERAL_CANDIDATES_LIMITATION,
            ],
          };
        }
      }
      if (
        operation === "inspect_native_data_type" &&
        normalized !== null &&
        typeof normalized === "object" &&
        !Array.isArray(normalized) &&
        normalized.metadata_recovery === undefined
      ) {
        // The bridge owns address-space resolution. Enrich its parsed identity;
        // request parameters retain the caller's spelling.
        const address = normalized.address;
        if (typeof address === "string") {
          if (target.format === "pe" && nativeAotOwner !== undefined) {
            const derived = await nativeAotOwner.derive(
              started.value.target.image_base,
              operation,
              options?.signal,
              normalized,
            );
            if (!derived.ok) return derived;
          }
          const metadata = nativeAotOwner?.readTypeDetail(address);
          if (metadata !== undefined) {
            // Preserve the database reply independently of the derived overlay.
            executionMetadata = {
              ...executionMetadata,
              rawResult: called.value,
            };
            normalized = ownedJsonValueSchema.parse({
              ...normalized,
              metadata_recovery: metadata,
            });
          }
        }
      }
      return ok(projectExecution(operation, normalized, executionMetadata));
    },
    executeIfReady: async (operation, parameters, options) => {
      if (operation !== "list_documents" && operation !== "list_procedures")
        return undefined;
      if (extensionFailure !== undefined) return err(extensionFailure);
      const input = parseGhidraInventoryInput(operation, parameters);
      if (!input.ok) return input;
      if (client.callToolIfReady === undefined) return undefined;
      const called = await client.callToolIfReady(
        operation,
        input.value,
        options?.signal === undefined ? {} : { signal: options.signal },
      );
      if (called === undefined) return undefined;
      return inventoryExecution(operation, called);
    },
    operationHealthSnapshot: () => client.operationHealthSnapshot?.(),
    runtimeLineageSnapshots: () => {
      const observation = client.runtimeLineage?.() ?? null;
      return observation === null
        ? []
        : [{ provider: committedProfile.provider, observation }];
    },
    close: async () => {
      await nativeAotOwner?.close();
      const closed = await client.close();
      const retained = nativeAotOwner?.cleanupFailure;
      if (retained === undefined) return closed;
      return closed.ok
        ? err(retained)
        : err(analysisErrorWithCleanupDependencies(closed.error, retained));
    },
  });
};

interface GhidraClientCoordinates {
  readonly analyzeHeadlessPath: string;
  readonly configurationDirectoryName: string | null;
  readonly javaHome: string;
  readonly providerVersion: string;
  readonly profile: AnalysisProfileCommitment;
}

export interface GhidraClientAdmission {
  readonly target: Extract<BinaryTarget, { readonly kind: "executable" }>;
  readonly profile: AnalysisProfileCommitment;
}

/** Admit caller inputs and native authority before Java work starts. */
export const admitGhidraClient = (
  target: BinaryTarget,
  profile: AnalysisProfileCommitment | undefined,
  platform: NodeJS.Platform,
): Result<GhidraClientAdmission, AnalysisError> => {
  if (target.kind !== "executable")
    return err(
      new AnalysisCapabilityUnavailableError(
        "ghidra",
        "health",
        `Ghidra cannot import ${target.kind} targets through this adapter.`,
      ),
    );
  if (platform === "win32") {
    const readiness = inspectWindowsNativeReadiness(platform);
    if (!readiness.available)
      return err(
        new AnalysisCapabilityUnavailableError(
          "ghidra",
          "health",
          readiness.reason,
        ),
      );
  }
  if (profile === undefined || profile.provider.id !== "ghidra")
    return err(new ProviderAdapterError("ghidra", "health"));
  return ok({ target, profile });
};

const ghidraClientPrerequisites = (
  profile: AnalysisProfileCommitment,
  installation: GhidraInstallationInspection,
): Result<GhidraClientCoordinates, AnalysisError> => {
  if (installation.status === "unavailable")
    return err(
      bindProcessInspectionCancellations(
        installation.javaProbeFailure?.inspectionFailure,
        new ProviderAdapterError("ghidra", "health", {
          ...(installation.javaProbeFailure === undefined
            ? {}
            : { cause: installation.javaProbeFailure }),
          diagnostics: ghidraInstallationDiagnostics(installation),
        }),
        "health",
      ),
    );
  const readiness =
    installation.platform === "win32"
      ? inspectWindowsNativeReadiness(installation.platform)
      : undefined;
  if (readiness?.available === false)
    return err(
      new AnalysisCapabilityUnavailableError(
        "ghidra",
        "health",
        readiness.reason,
      ),
    );
  if (profile.provider.version !== installation.providerVersion)
    return err(
      ghidraProfileConflict(
        "health",
        "The current installation version differs from the selected analysis profile; resolve the profile again.",
        {
          selected_provider_version: profile.provider.version,
          current_installation: ghidraInstallationDiagnostics(installation),
        },
      ),
    );
  return ok({
    analyzeHeadlessPath: installation.analyzeHeadlessPath,
    configurationDirectoryName: installation.configurationDirectoryName,
    javaHome: installation.javaHome,
    providerVersion: installation.providerVersion,
    profile,
  });
};
