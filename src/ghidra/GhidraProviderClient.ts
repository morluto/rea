import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { fileURLToPath } from "node:url";

import {
  createAnalysisExecution,
  type AnalysisClient,
  type AnalysisClientContext,
  type AnalysisOperation,
} from "../application/AnalysisProvider.js";
import type { AppConfig } from "../config/types.js";
import {
  ghidraSeedCommitmentSchema,
  ghidraSeedFailure,
  ghidraSeedLimitations,
} from "./GhidraAnalysisSeeds.js";
import {
  ghidraProfileDisabledAnalyzers,
  ghidraProfileLanguageOverride,
  sameGhidraDisabledAnalyzers,
  sameGhidraLanguageOverride,
} from "./GhidraAnalysisProfile.js";
import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import {
  AnalysisCancelledError,
  AnalysisArtifactChangedError,
  AnalysisAccessDeniedError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err, ok, type Result } from "../domain/result.js";
import type { Logger } from "pino";
import { GhidraClient } from "./GhidraClient.js";
import type { GhidraClientOptions } from "./GhidraClientTypes.js";
import {
  isGhidraFunctionOperation,
  parseGhidraFunctionInput,
  parseGhidraFunctionResult,
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
  GHIDRA_MIPS_SOFT_FLOAT_STORAGE,
  ghidraMipsSoftFloatFailure,
  ghidraMipsRelocatableLimitations,
  ghidraMipsSharedLimitations,
  ghidraMipsSharedLanguageOverride,
  ghidraMipsSoftFloatLimitations,
  isGhidraMipsSoftFloatTarget,
} from "./GhidraMipsProfile.js";
import { unverifiedGhidraBuildLimitation } from "./GhidraInstallationPolicy.js";
import { GhidraHeadlessLauncher } from "./GhidraLauncher.js";
import { attestGhidraNativeLoadImage } from "./GhidraLoadImageAttest.js";
import {
  NATIVE_AOT_MAX_REPORT_BYTES,
  NATIVE_AOT_MAX_SOURCE_BYTES,
  nativeAotSnapshotOverCapacity,
  parseNativeAotPe,
  type NativeAotPeResult,
} from "../domain/native/nativeAotPe.js";
import {
  ABORTED,
  waitForAbortable,
} from "../application/binary/AbortablePromise.js";
import { nativeLoadImageObservationSchema } from "../domain/native/nativeLoadImage.js";
import {
  GHIDRA_PROVIDER_IDENTITY,
  healthLimitations,
  windowsP0Limitations,
  limitationsFor,
  relationshipCoverageFor,
} from "./GhidraProviderCapabilities.js";
import type { GhidraSessionError } from "./GhidraSessionError.js";
import type { GhidraSessionInfo } from "./GhidraSessionValues.js";
import { ghidraExtensionFailure } from "./extensions/GhidraExtensionFailures.js";
import {
  ghidraExtensionSchema,
  validateGhidraExtensionProfile,
  ghidraExtensionLimitations,
} from "./extensions/GhidraExtensions.js";
import {
  windowsNativeAuthorityUnavailableReason,
  hasWindowsNativeAuthority,
} from "../process/WindowsAuthority.js";
import { ghidraRawBinaryLanguage } from "./GhidraRawBinaryLanguage.js";

/** Production seam for exercising provider projection without a real process. */
export type GhidraProviderClientFactory = (
  options: GhidraClientOptions,
) => Pick<GhidraClient, "start" | "callTool" | "close"> &
  Partial<
    Pick<
      GhidraClient,
      "runtimeLineage" | "readTargetSnapshot" | "hashTargetSnapshot"
    >
  >;

type GhidraProviderClientInstance = ReturnType<GhidraProviderClientFactory>;

type NativeAotSnapshotOwner = {
  readonly derive: (
    imageBase: string,
    operation: AnalysisOperation,
    callerSignal: AbortSignal | undefined,
    observations: JsonValue,
  ) => Promise<Result<NativeAotPeResult, AnalysisError>>;
  readonly readTypeDetail: (
    address: string,
  ) => ReturnType<NativeAotPeResult["readTypeDetail"]>;
  readonly close: () => void;
};

/** Own one session's captured PE snapshot and immutable NativeAOT derivation. */
const createNativeAotSnapshotOwner = (input: {
  readonly client: GhidraProviderClientInstance;
  readonly target: BinaryTarget;
  readonly startupTimeoutMs: number;
}): NativeAotSnapshotOwner => {
  const { client, target, startupTimeoutMs } = input;
  const controller = new AbortController();
  let identity: string | undefined;
  let result: NativeAotPeResult | undefined;
  let pending:
    | {
        readonly identity: string;
        readonly promise: Promise<Result<NativeAotPeResult, AnalysisError>>;
      }
    | undefined;
  let closed = false;
  let identityConflict = false;
  let identityConflictObservation:
    | { readonly imageBase: string; readonly observations: JsonValue }
    | undefined;
  const identityError = (
    operation: AnalysisOperation,
    reason: string,
    observedBase: string,
    observations: JsonValue,
  ): AnalysisError =>
    new ProviderAdapterError("ghidra", operation, {
      diagnostics: {
        reason,
        artifact_sha256: target.sha256,
        bound_image_base:
          identity === undefined
            ? null
            : `0x${identity.slice(target.sha256.length + 1)}`,
        observed_image_base: observedBase,
        measured_observation: observations,
        conflicting_image_base: identityConflictObservation?.imageBase ?? null,
        conflicting_observation:
          identityConflictObservation?.observations ?? null,
      },
    });
  const identityConflictFailure = (
    operation: AnalysisOperation,
    observedBase: string,
    observations: JsonValue,
  ): Result<NativeAotPeResult, AnalysisError> => {
    return err(
      identityError(
        operation,
        "The Ghidra session reported conflicting loaded image bases; reopen the analysis session to establish a new identity.",
        observedBase,
        observations,
      ),
    );
  };
  const derive = async (
    imageBase: string,
    operation: AnalysisOperation,
    callerSignal: AbortSignal | undefined,
    observations: JsonValue,
  ): Promise<Result<NativeAotPeResult, AnalysisError>> => {
    if (callerSignal?.aborted || closed)
      return err(new AnalysisCancelledError(operation));
    if (identityConflict)
      return identityConflictFailure(operation, imageBase, observations);
    if (controller.signal.aborted)
      return err(new AnalysisCancelledError(operation));
    let normalizedBase: string;
    try {
      normalizedBase = BigInt(imageBase).toString(16);
    } catch (cause: unknown) {
      return err(
        new ProviderAdapterError("ghidra", operation, {
          diagnostics: {
            reason:
              "Ghidra returned an invalid loaded image base for NativeAOT identity binding.",
            artifact_sha256: target.sha256,
            observed_image_base: imageBase,
            measured_observation: observations,
          },
          cause,
        }),
      );
    }
    const key = `${target.sha256}:${normalizedBase}`;
    if (identity !== undefined && identity !== key) {
      identityConflict = true;
      identityConflictObservation = { imageBase, observations };
      result = undefined;
      controller.abort();
      return err(
        identityError(
          operation,
          "The Ghidra session reported a different loaded image base after NativeAOT metadata was bound to its captured snapshot; reopen the analysis session to establish a new identity.",
          imageBase,
          observations,
        ),
      );
    }
    identity ??= key;
    if (result !== undefined) {
      const settled = await waitForAbortable(
        Promise.resolve(ok(result)),
        callerSignal,
      );
      if (closed) return err(new AnalysisCancelledError(operation));
      if (identityConflict)
        return identityConflictFailure(operation, imageBase, observations);
      if (controller.signal.aborted)
        return err(new AnalysisCancelledError(operation));
      return settled === ABORTED
        ? err(new AnalysisCancelledError(operation))
        : settled;
    }
    if (pending !== undefined && pending.identity !== key)
      return err(
        identityError(
          operation,
          "A NativeAOT snapshot derivation is already bound to a different loaded image base.",
          imageBase,
          observations,
        ),
      );
    if (pending === undefined) {
      const promise: Promise<Result<NativeAotPeResult, AnalysisError>> =
        (async () => {
          try {
            if (client.readTargetSnapshot === undefined)
              return err(
                new ProviderAdapterError("ghidra", operation, {
                  diagnostics: {
                    reason:
                      "The Ghidra client does not expose its immutable target snapshot for NativeAOT metadata inspection.",
                  },
                }),
              );
            const snapshot = await client.readTargetSnapshot(
              NATIVE_AOT_MAX_SOURCE_BYTES,
              controller.signal,
            );
            if (!snapshot.ok)
              return err(
                projectSessionError(
                  operation,
                  snapshot.error,
                  startupTimeoutMs,
                ),
              );
            if (closed) return err(new AnalysisCancelledError(operation));
            if (identityConflict)
              return identityConflictFailure(
                operation,
                imageBase,
                observations,
              );
            if (controller.signal.aborted)
              return err(new AnalysisCancelledError(operation));
            const parsed =
              snapshot.value.kind === "over-capacity"
                ? {
                    summary: nativeAotSnapshotOverCapacity(
                      target.sha256,
                      snapshot.value.sourceBytesAtLeast,
                      NATIVE_AOT_MAX_REPORT_BYTES,
                    ),
                    readTypeDetail: () => undefined,
                  }
                : parseNativeAotPe(
                    snapshot.value.bytes,
                    target.sha256,
                    NATIVE_AOT_MAX_REPORT_BYTES,
                    imageBase,
                  );
            if (closed) return err(new AnalysisCancelledError(operation));
            if (identityConflict)
              return identityConflictFailure(
                operation,
                imageBase,
                observations,
              );
            if (controller.signal.aborted)
              return err(new AnalysisCancelledError(operation));
            return ok(parsed);
          } catch (cause: unknown) {
            return err(
              new ProviderAdapterError("ghidra", operation, {
                diagnostics: {
                  reason:
                    cause instanceof Error
                      ? cause.message
                      : "NativeAOT metadata could not be derived from the captured target snapshot.",
                },
                cause,
              }),
            );
          }
        })();
      const current = { identity: key, promise };
      pending = current;
      void promise.then((settled) => {
        if (pending !== current) return;
        pending = undefined;
        if (settled.ok && !closed && !identityConflict) result = settled.value;
      });
    }
    const settled = await waitForAbortable(pending.promise, callerSignal);
    if (closed) return err(new AnalysisCancelledError(operation));
    if (identityConflict)
      return identityConflictFailure(operation, imageBase, observations);
    if (controller.signal.aborted)
      return err(new AnalysisCancelledError(operation));
    return settled === ABORTED
      ? err(new AnalysisCancelledError(operation))
      : settled;
  };
  return {
    derive,
    readTypeDetail: (address) =>
      result?.readTypeDetail(address, NATIVE_AOT_MAX_REPORT_BYTES),
    close: () => {
      closed = true;
      controller.abort();
      result = undefined;
      pending = undefined;
    },
  };
};

/** Build one AnalysisClient for an admitted Ghidra target and profile. */
export const createGhidraProviderClient = (input: {
  readonly config: AppConfig;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly logger: Logger;
  readonly clientFactory: GhidraProviderClientFactory;
  readonly target: BinaryTarget;
  readonly profile?: AnalysisProfileCommitment;
  readonly context?: AnalysisClientContext;
  readonly installation: GhidraInstallationInspection;
}): AnalysisClient => {
  const { config, logger, clientFactory, target, context, installation } =
    input;
  const prerequisites = ghidraClientPrerequisites(
    target,
    input.profile,
    installation,
  );
  if (!prerequisites.ok) return unavailableClient(prerequisites.error);
  const committedProfile = prerequisites.value.profile;
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
    return unavailableClient(
      new ProviderAdapterError("ghidra", "open_binary", {
        diagnostics: {
          reason:
            "Resolve the supported PSP profile and installed Allegrex extension before opening the session.",
        },
      }),
    );
  const softFloat = isGhidraMipsSoftFloatTarget(target);
  if (
    softFloat !==
    (committedProfile.parameters.mips_soft_float_storage ===
      GHIDRA_MIPS_SOFT_FLOAT_STORAGE)
  )
    return unavailableClient(
      new ProviderAdapterError("ghidra", "open_binary", {
        diagnostics: {
          reason:
            "Resolve the soft-float MIPS storage policy into the analysis profile before opening the session.",
        },
      }),
    );
  const extensionProfile = ghidraExtensionSchema
    .array()
    .safeParse(committedProfile.parameters.analysis_extensions ?? []);
  if (
    !extensionProfile.success ||
    (config.ghidraNativeAotJar !== undefined &&
      extensionProfile.data.length === 0)
  )
    return unavailableClient(
      new ProviderAdapterError("ghidra", "open_binary", {
        diagnostics: {
          reason:
            "Resolve the configured Ghidra extensions into an analysis profile before opening the session.",
        },
      }),
    );
  const extensions = extensionProfile.data;
  const seedProfile = ghidraSeedCommitmentSchema
    .optional()
    .safeParse(committedProfile.parameters.analysis_seeds);
  if (
    !seedProfile.success ||
    (config.ghidraSeedFile === undefined) !== (seedProfile.data === undefined)
  )
    return unavailableClient(
      new ProviderAdapterError("ghidra", "open_binary", {
        diagnostics: {
          reason:
            "Resolve REA_GHIDRA_SEED_FILE into an analysis profile before opening the session.",
        },
      }),
    );
  const seeds = seedProfile.data;
  const languageOverride = ghidraProfileLanguageOverride(
    committedProfile.parameters,
  );
  if (
    !sameGhidraLanguageOverride(
      languageOverride,
      config.ghidraLanguageOverride ?? ghidraMipsSharedLanguageOverride(target),
    )
  )
    return unavailableClient(
      new ProviderAdapterError("ghidra", "open_binary", {
        diagnostics: {
          reason:
            "The committed analysis profile and REA_GHIDRA_LANGUAGE_ID/REA_GHIDRA_COMPILER_SPEC_ID differ; reopen the target to resolve a new profile.",
        },
      }),
    );
  const disabledAnalyzers = ghidraProfileDisabledAnalyzers(
    committedProfile.parameters,
  );
  if (
    !sameGhidraDisabledAnalyzers(
      disabledAnalyzers,
      config.ghidraDisabledAnalyzers,
    )
  )
    return unavailableClient(
      new ProviderAdapterError("ghidra", "open_binary", {
        diagnostics: {
          reason:
            "The committed analysis profile and REA_GHIDRA_DISABLED_ANALYZERS differ; reopen the target to resolve a new profile.",
        },
      }),
    );
  const invalidProfile = validateGhidraExtensionProfile(
    extensions,
    config,
    target,
    installation.platform,
  );
  if (invalidProfile !== null)
    return unavailableClient(
      new ProviderAdapterError("ghidra", "open_binary", {
        diagnostics: { reason: invalidProfile },
      }),
    );
  let extensionFailure: AnalysisError | undefined;
  // Replaced by the reported outcome once the session handshake is checked.
  const seedLimitations: string[] = [...ghidraSeedLimitations(seeds)];
  // Replaced by the reported storage outcome once the handshake is checked.
  const softFloatLimitations: string[] = [
    ...ghidraMipsSoftFloatLimitations(softFloat),
  ];
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
    ...(target.format === "raw-binary"
      ? [
          "Headerless raw-binary analysis uses the caller-supplied architecture and entry address; file offset 0 is mapped at that address. Headers are not discovered from file bytes.",
          "Little-endian generic Ghidra languages are used for x86, x86_64, arm, and arm64. Big-endian, Thumb-only, Cortex-M, and other processor variants are unsupported in this increment.",
          "Static analysis does not emulate reset vectors, memory-mapped I/O, or firmware boot sequences.",
        ]
      : []),
    ...(target.kind === "executable" && target.architecture === "mips"
      ? (target.mips.limitations ?? [])
      : []),
    ...ghidraMipsRelocatableLimitations(target),
    ...ghidraMipsSharedLimitations(target),
  ];
  const providerLimitations =
    installation.platform === "win32"
      ? windowsP0Limitations
      : installation.platform === "darwin"
        ? [
            "macOS sessions require a matching executable Ghidra native decompiler; REA checks for it but does not build native components or change Gatekeeper quarantine state.",
          ]
        : [];
  const client = clientFactory({
    startupTimeoutMs: config.ghidraStartupTimeoutMs,
    platform: installation.platform,
    launcher: new GhidraHeadlessLauncher({
      environment: input.environment,
      analyzeHeadlessPath: prerequisites.value.analyzeHeadlessPath,
      javaHome: prerequisites.value.javaHome,
      bridgeScriptPath: fileURLToPath(
        new URL("../../bridge/ghidra/ReaGhidraBridge.java", import.meta.url),
      ),
      ...(pspExtension?.success === true
        ? { pspExtension: pspExtension.data }
        : {}),
      ...(softFloat ? { mipsSoftFloat: true as const } : {}),
      ...(target.format === "dos-mz" ? { dosMz: true } : {}),
      ...(target.format === "dos-com" ? { dosCom: true } : {}),
      ...(rawLanguage === undefined || target.format !== "raw-binary"
        ? {}
        : {
            rawBinary: {
              languageId: rawLanguage.languageId,
              compilerSpecId: rawLanguage.compilerSpecId,
              baseAddr: target.entryPoint,
            },
          }),
      ...(languageOverride === undefined ? {} : { languageOverride }),
      ...(config.ghidraDisabledAnalyzers === undefined
        ? {}
        : { disabledAnalyzers: config.ghidraDisabledAnalyzers }),
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
        ? languageOverride === undefined
          ? {}
          : {
              expectedLanguageId: languageOverride.languageId,
              ...(languageOverride.compilerSpecId === undefined
                ? {}
                : { expectedCompilerSpecId: languageOverride.compilerSpecId }),
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
    ...(context === undefined ? {} : { runId: context.runId }),
    logger: logger.child({ layer: "ghidra-bridge" }),
  });
  const checkExtensions = async (
    operation: AnalysisOperation,
    info: GhidraSessionInfo,
  ): Promise<AnalysisError | undefined> => {
    const softFloatReason = ghidraMipsSoftFloatFailure(
      softFloat,
      info.mips_soft_float_storage,
    );
    extensionFailure =
      ghidraExtensionFailure(
        extensions,
        info.analysis_extensions ?? [],
        operation,
      ) ??
      ghidraSeedFailure(seeds, info.analysis_seeds, operation) ??
      (softFloatReason === undefined
        ? undefined
        : new ProviderAdapterError("ghidra", operation, {
            diagnostics: { reason: softFloatReason },
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
    if (extensionFailure === undefined) return undefined;
    const closed = await client.close();
    return closed.ok
      ? extensionFailure
      : analysisErrorWithCleanupFailure(
          extensionFailure,
          closed.error,
          operation,
        );
  };
  const releaseLimitation = unverifiedGhidraBuildLimitation(
    prerequisites.value.providerVersion,
  );
  const sessionLimitations = (): readonly string[] => [
    ...providerLimitations,
    ...targetLimitations,
    ...(psp ? GHIDRA_PSP_LIMITATIONS : []),
    ...softFloatLimitations,
    ...ghidraExtensionLimitations(extensions),
    ...seedLimitations,
    ...(releaseLimitation === undefined ? [] : [releaseLimitation]),
  ];
  const nativeAotOwner =
    target.format === "pe"
      ? createNativeAotSnapshotOwner({
          client,
          target,
          startupTimeoutMs: config.ghidraStartupTimeoutMs,
        })
      : undefined;
  return {
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
        const started = await client.start(options?.signal, options?.progress);
        if (!started.ok)
          return err(
            projectSessionError(
              operation,
              started.error,
              config.ghidraStartupTimeoutMs,
            ),
          );
        const failed = await checkExtensions(operation, started.value);
        if (failed !== undefined) return err(failed);
        return ok(
          createAnalysisExecution(started.value, committedProfile.provider, {
            analysisProfile: committedProfile,
            limitations: [...healthLimitations, ...sessionLimitations()],
          }),
        );
      }
      const input = isGhidraFunctionOperation(operation)
        ? parseGhidraFunctionInput(operation, parameters)
        : parseGhidraInventoryInput(operation, parameters);
      if (!input.ok) return input;
      if (extensions.length > 0 || seeds !== undefined || softFloat) {
        const started = await client.start(options?.signal, options?.progress);
        if (!started.ok)
          return err(
            projectSessionError(
              operation,
              started.error,
              config.ghidraStartupTimeoutMs,
            ),
          );
        const failed = await checkExtensions(operation, started.value);
        if (failed !== undefined) return err(failed);
      }
      const called = await client.callTool(operation, input.value, {
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
        ...(options?.progress === undefined
          ? {}
          : { progress: options.progress }),
      });
      if (!called.ok)
        return err(
          projectSessionError(
            operation,
            called.error,
            config.ghidraStartupTimeoutMs,
          ),
        );
      let normalized: JsonValue;
      let observationLimitations: readonly string[] = [];
      if (isGhidraFunctionOperation(operation)) {
        const result = parseGhidraFunctionResult(operation, called.value);
        if (!result.ok) return result;
        normalized = result.value.value;
        observationLimitations = result.value.limitations;
      } else {
        const result = parseGhidraInventoryResult(operation, called.value);
        if (!result.ok) return result;
        normalized = result.value;
      }
      if (operation === "inspect_native_data_type") {
        const address = input.value.address;
        if (typeof address === "string") {
          if (target.format === "pe" && nativeAotOwner !== undefined) {
            const started = await client.start(
              options?.signal,
              options?.progress,
            );
            if (!started.ok)
              return err(
                projectSessionError(
                  operation,
                  started.error,
                  config.ghidraStartupTimeoutMs,
                ),
              );
            const derived = await nativeAotOwner.derive(
              started.value.target.image_base,
              operation,
              options?.signal,
              normalized,
            );
            if (!derived.ok) return derived;
          }
          let metadata:
            | ReturnType<NativeAotPeResult["readTypeDetail"]>
            | undefined;
          metadata = nativeAotOwner?.readTypeDetail(address);
          if (
            metadata !== undefined &&
            normalized !== null &&
            typeof normalized === "object" &&
            !Array.isArray(normalized)
          ) {
            const nativeResult = normalized as Record<string, JsonValue>;
            if (nativeResult.metadata_recovery === undefined)
              normalized = jsonValueSchema.parse({
                ...nativeResult,
                metadata_recovery: metadata,
              });
          }
        }
      }
      if (operation === "inspect_native_load_image") {
        let derived: NativeAotPeResult | undefined;
        if (target.format === "pe") {
          const observations =
            nativeLoadImageObservationSchema.parse(normalized);
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
            observations.image_base,
            operation,
            options?.signal,
            normalized,
          );
          if (!result.ok) return result;
          derived = result.value;
        }
        const attested = await attestGhidraNativeLoadImage({
          target,
          operation,
          measured: normalized,
          client,
          mapSessionError: (failure) =>
            projectSessionError(
              operation,
              failure,
              config.ghidraStartupTimeoutMs,
            ),
          nativeAotResult: derived,
          signal: options?.signal,
        });
        if (!attested.ok) return attested;
        normalized = attested.value;
      }
      const relationshipCoverage = relationshipCoverageFor(operation);
      return ok(
        createAnalysisExecution(normalized, committedProfile.provider, {
          rawResult: called.value,
          analysisProfile: committedProfile,
          ...(relationshipCoverage === undefined
            ? {}
            : { relationshipCoverage }),
          limitations: [
            ...limitationsFor(operation),
            ...observationLimitations,
            ...sessionLimitations(),
          ],
        }),
      );
    },
    runtimeLineageSnapshots: () => {
      const observation = client.runtimeLineage?.() ?? null;
      return observation === null
        ? []
        : [{ provider: committedProfile.provider, observation }];
    },
    close: async () => {
      nativeAotOwner?.close();
      return client.close();
    },
  };
};

interface GhidraClientCoordinates {
  readonly analyzeHeadlessPath: string;
  readonly javaHome: string;
  readonly providerVersion: string;
  readonly profile: AnalysisProfileCommitment;
}

const ghidraClientPrerequisites = (
  target: BinaryTarget,
  profile: AnalysisProfileCommitment | undefined,
  installation: GhidraInstallationInspection,
): Result<GhidraClientCoordinates, AnalysisError> => {
  if (target.kind !== "executable")
    return err(
      new AnalysisCapabilityUnavailableError(
        "ghidra",
        "health",
        `Ghidra cannot import ${target.kind} targets through this adapter.`,
      ),
    );
  if (installation.status === "unavailable")
    return err(
      new ProviderAdapterError("ghidra", "health", {
        diagnostics: ghidraInstallationDiagnostics(installation),
      }),
    );
  if (
    installation.platform === "win32" &&
    !hasWindowsNativeAuthority(installation.platform)
  )
    return err(
      new AnalysisCapabilityUnavailableError(
        "ghidra",
        "health",
        windowsNativeAuthorityUnavailableReason(installation.platform),
      ),
    );
  if (profile === undefined || profile.provider.id !== "ghidra")
    return err(new ProviderAdapterError("ghidra", "health"));
  return ok({
    analyzeHeadlessPath: installation.analyzeHeadlessPath,
    javaHome: installation.javaHome,
    providerVersion: installation.providerVersion,
    profile,
  });
};

const unavailableClient = (failure: AnalysisError): AnalysisClient => ({
  execute: () => Promise.resolve(err(failure)),
  close: () => Promise.resolve(ok(null)),
});

const projectSessionError = (
  operation: AnalysisOperation,
  failure: GhidraSessionError,
  startupTimeoutMs: number,
): AnalysisError => {
  const primary = projectPrimarySessionError(
    operation,
    failure,
    startupTimeoutMs,
  );
  return failure.cleanupFailure === undefined
    ? primary
    : analysisErrorWithCleanupFailure(
        primary,
        failure.cleanupFailure,
        operation,
      );
};

const projectPrimarySessionError = (
  operation: AnalysisOperation,
  failure: GhidraSessionError,
  startupTimeoutMs: number,
): AnalysisError => {
  if (failure.cause instanceof AnalysisAccessDeniedError)
    return new AnalysisAccessDeniedError(
      operation,
      failure.cause.path,
      failure.cause.systemCode,
      { cause: failure },
    );
  if (failure.cause instanceof AnalysisArtifactChangedError)
    return new AnalysisArtifactChangedError(
      operation,
      failure.cause.path,
      failure.cause.reason,
      { cause: failure },
    );
  if (
    operation === "annotate_native_function" &&
    failure.kind === "remote" &&
    failure.remoteCode === "invalid_function_name"
  )
    return new AnalysisInputError(operation, { cause: failure }, [
      { path: ["name"], reason: "invalid_value", message: failure.message },
    ]);
  if (failure.kind === "cancelled")
    return new AnalysisCancelledError(operation);
  if (failure.kind === "timeout" || failure.kind === "analysis_timeout")
    return new AnalysisTimeoutError(
      operation,
      failure.timeoutMs ?? startupTimeoutMs,
    );
  if (failure.kind === "remote" && failure.remoteCode === "decompile_cancelled")
    return new AnalysisCancelledError(operation);
  if (
    failure.kind === "remote" &&
    failure.remoteCode === "regex_stack_exhausted"
  )
    return new AnalysisResourceConstraintError(
      operation,
      "memory",
      failure.message,
      null,
      {
        cause: failure,
        remediationAction:
          "Retry this search in literal mode or simplify the regex. The active analysis session and annotations remain available.",
      },
    );
  if (
    failure.kind === "remote" &&
    ["invalid_request", "not_found", "ambiguous"].includes(
      failure.remoteCode ?? "",
    )
  )
    return new AnalysisInputError(operation, { cause: failure }, [
      { path: [], reason: "invalid_value", message: failure.message },
    ]);
  if (failure.kind === "remote" && failure.remoteCode === "method_unavailable")
    return new AnalysisCapabilityUnavailableError(
      "ghidra",
      operation,
      failure.message,
    );
  return new ProviderAdapterError("ghidra", operation, {
    cause: failure,
    diagnostics: failure.diagnostics,
  });
};
