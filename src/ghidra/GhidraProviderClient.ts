import { analysisErrorWithCleanupFailure } from "../application/binary/AnalysisClientCleanup.js";
import { fileURLToPath } from "node:url";

import {
  createAnalysisExecution,
  type AnalysisClient,
  type AnalysisClientContext,
  type AnalysisOperation,
} from "../application/AnalysisProvider.js";
import type { AppConfig } from "../config.js";
import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import {
  AnalysisCancelledError,
  AnalysisArtifactChangedError,
  AnalysisAccessDeniedError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { type AnalysisError } from "../domain/analysisErrorBase.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err, ok, type Result } from "../domain/result.js";
import type { Logger } from "../logger.js";
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
import { unverifiedGhidraBuildLimitation } from "./GhidraInstallationPolicy.js";
import { GhidraHeadlessLauncher } from "./GhidraLauncher.js";
import { attestGhidraNativeLoadImage } from "./GhidraLoadImageAttest.js";
import {
  GHIDRA_PROVIDER_IDENTITY,
  healthLimitations,
  windowsP0Limitations,
  limitationsFor,
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

/** Production seam for exercising provider projection without a real process. */
export type GhidraProviderClientFactory = (
  options: GhidraClientOptions,
) => Pick<GhidraClient, "start" | "callTool" | "close"> &
  Partial<Pick<GhidraClient, "runtimeLineage" | "readTargetSnapshot">>;

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
  const targetLimitations =
    target.format === "dos-mz"
      ? [
          "DOS MZ uses 16-bit x86 real mode with the Ghidra load segment 0x1000. Returned addresses are linear byte coordinates; they do not identify a unique segment:offset alias.",
          "Static DOS analysis does not emulate BIOS, DOS interrupts, device ports, or self-modifying unpacking code. Packed targets require a separately identified unpacked artifact for original-program analysis; appended overlays are not the initialized load module.",
        ]
      : [];
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
      ...(target.format === "dos-mz" ? { dosMz: true } : {}),
      ...(target.format === "dos-com" ? { dosCom: true } : {}),
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
      : {}),
    ...(context === undefined ? {} : { runId: context.runId }),
    logger: logger.child({ layer: "ghidra-bridge" }),
  });
  const checkExtensions = async (
    operation: AnalysisOperation,
    info: GhidraSessionInfo,
  ): Promise<AnalysisError | undefined> => {
    extensionFailure = ghidraExtensionFailure(
      extensions,
      info.analysis_extensions ?? [],
      operation,
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
  const sessionLimitations = [
    ...providerLimitations,
    ...targetLimitations,
    ...ghidraExtensionLimitations(extensions),
    ...(releaseLimitation === undefined ? [] : [releaseLimitation]),
  ];
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
        const started = await client.start(options?.signal);
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
            limitations: [...healthLimitations, ...sessionLimitations],
          }),
        );
      }
      const input = isGhidraFunctionOperation(operation)
        ? parseGhidraFunctionInput(operation, parameters)
        : parseGhidraInventoryInput(operation, parameters);
      if (!input.ok) return input;
      if (extensions.length > 0) {
        const started = await client.start(options?.signal);
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
      const called = await client.callTool(
        operation,
        input.value,
        options?.signal === undefined ? {} : { signal: options.signal },
      );
      if (!called.ok)
        return err(
          projectSessionError(
            operation,
            called.error,
            config.ghidraStartupTimeoutMs,
          ),
        );
      const result = isGhidraFunctionOperation(operation)
        ? parseGhidraFunctionResult(operation, called.value)
        : parseGhidraInventoryResult(operation, called.value);
      if (!result.ok) return result;
      let normalized = result.value;
      if (operation === "inspect_native_load_image") {
        const attested = await attestGhidraNativeLoadImage(
          target,
          operation,
          result.value,
          client,
          (failure) =>
            projectSessionError(
              operation,
              failure,
              config.ghidraStartupTimeoutMs,
            ),
        );
        if (!attested.ok) return attested;
        normalized = attested.value;
      }
      return ok(
        createAnalysisExecution(normalized, committedProfile.provider, {
          rawResult: called.value,
          analysisProfile: committedProfile,
          limitations: [...limitationsFor(operation), ...sessionLimitations],
        }),
      );
    },
    runtimeLineageSnapshots: () => {
      const observation = client.runtimeLineage?.() ?? null;
      return observation === null
        ? []
        : [{ provider: committedProfile.provider, observation }];
    },
    close: () => client.close(),
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
