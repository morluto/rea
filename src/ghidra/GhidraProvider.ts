import { fileURLToPath } from "node:url";

import {
  createAnalysisExecution,
  type AnalysisClient,
  type AnalysisOperation,
  type AnalysisProfileResolutionOptions,
  type AnalysisProviderCandidate,
  type CapabilityDescriptor,
  type ProviderAvailability,
  type ProviderIdentity,
  type ProviderTargetSupport,
} from "../application/AnalysisProvider.js";
import type { AppConfig } from "../config.js";
import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  type AnalysisError,
  AnalysisTimeoutError,
  ProviderAdapterError,
} from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import type { Logger } from "../logger.js";
import { GhidraClient } from "./GhidraClient.js";
import type { GhidraClientOptions } from "./GhidraClientTypes.js";
import {
  GHIDRA_ANALYSIS_TIMEOUT_SECONDS,
  GHIDRA_DECOMPILE_REQUEST_TIMEOUT_MS,
  GHIDRA_DECOMPILE_TIMEOUT_SECONDS,
  GHIDRA_STARTUP_TIMEOUT_MS,
} from "./GhidraDefaults.js";
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
  inspectGhidraInstallation,
  type GhidraInstallationHost,
  type GhidraInstallationInspection,
} from "./GhidraInstallation.js";
import { GhidraHeadlessLauncher } from "./GhidraLauncher.js";
import { resolveGhidraAnalysisProfile } from "./GhidraAnalysisProfile.js";
import type { GhidraSessionError } from "./GhidraSessionError.js";
import {
  CAPABILITIES,
  WINDOWS_P0_CAPABILITIES,
  GHIDRA_PROVIDER_IDENTITY,
  GHIDRA_PROVIDER_TOOL_CONTRACTS,
  healthLimitations,
  windowsP0Limitations,
  limitationsFor,
} from "./GhidraProviderCapabilities.js";

export { GHIDRA_PROVIDER_IDENTITY, GHIDRA_PROVIDER_TOOL_CONTRACTS };

const SUPPORTED_ARCHITECTURES = new Set(["x86", "x86_64", "arm", "arm64"]);
const SUPPORTED_FORMATS = new Set(["elf", "pe", "mach-o"]);

/** Production seam for exercising provider projection without a real process. */
export type GhidraProviderClientFactory = (
  options: GhidraClientOptions,
) => Pick<GhidraClient, "start" | "callTool" | "close">;

/** Ghidra candidate backed by an isolated read-only headless import. */
export class GhidraProvider implements AnalysisProviderCandidate {
  #installation: GhidraInstallationInspection | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly installationHost?: GhidraInstallationHost,
    private readonly clientFactory: GhidraProviderClientFactory = (options) =>
      new GhidraClient(options),
  ) {}

  identity(): ProviderIdentity {
    return GHIDRA_PROVIDER_IDENTITY;
  }

  capabilities(): readonly CapabilityDescriptor[] {
    return (this.installationHost?.platform ?? process.platform) === "win32"
      ? WINDOWS_P0_CAPABILITIES
      : CAPABILITIES;
  }

  inspectAvailability(): ProviderAvailability {
    const installation = this.#inspectInstallation();
    const diagnostics = ghidraInstallationDiagnostics(installation);
    return installation.available
      ? {
          status: "available",
          code: null,
          reason: null,
          diagnostics,
        }
      : {
          status: "unavailable",
          code: installation.rejectionCode ?? "not_configured",
          reason:
            installation.reason ?? "Ghidra installation is not available.",
          diagnostics,
        };
  }

  inspectTargetSupport(target: BinaryTarget): ProviderTargetSupport {
    const hostPlatform = this.installationHost?.platform ?? process.platform;
    const diagnostics = {
      host_platform: hostPlatform,
      target_kind: target.kind,
      target_format: target.format,
      architecture: target.architecture ?? null,
      executable_role: target.executableRole ?? null,
      managed: target.managed ?? null,
    };
    if (target.kind !== "executable")
      return {
        status: "unsupported",
        code: "target_kind_unsupported",
        reason: `Ghidra v1 imports executable targets, not ${target.kind} targets.`,
        diagnostics,
      };
    if (hostPlatform === "win32")
      return inspectWindowsP0TargetSupport(target, diagnostics);
    if (!SUPPORTED_FORMATS.has(target.format))
      return {
        status: "unsupported",
        code: "target_format_unsupported",
        reason: `Ghidra v1 does not import ${target.format} through this adapter.`,
        diagnostics,
      };
    if (
      target.architecture === undefined ||
      !SUPPORTED_ARCHITECTURES.has(target.architecture)
    )
      return {
        status: "unsupported",
        code: "architecture_unsupported",
        reason:
          "Ghidra v1 requires a concrete x86, x86_64, arm, or arm64 target architecture.",
        diagnostics,
      };
    return {
      status: "supported",
      code: null,
      reason: null,
      diagnostics,
    };
  }

  resolveAnalysisProfile(
    target: BinaryTarget,
    options?: AnalysisProfileResolutionOptions,
  ) {
    return resolveGhidraAnalysisProfile(
      target,
      GHIDRA_PROVIDER_IDENTITY,
      this.#inspectInstallation(),
      options?.signal,
    );
  }

  createClient(
    target: BinaryTarget,
    profile?: AnalysisProfileCommitment,
  ): AnalysisClient {
    const installation = this.#inspectInstallation();
    const prerequisites = ghidraClientPrerequisites(
      target,
      profile,
      installation,
    );
    if (!prerequisites.ok) return unavailableClient(prerequisites.error);
    const committedProfile = prerequisites.value.profile;
    const providerLimitations =
      installation.platform === "win32" ? windowsP0Limitations : [];
    const client = this.clientFactory({
      launcher: new GhidraHeadlessLauncher({
        analyzeHeadlessPath: prerequisites.value.analyzeHeadlessPath,
        ...(this.config.ghidraJavaHome === undefined
          ? {}
          : { javaHome: this.config.ghidraJavaHome }),
        bridgeScriptPath: fileURLToPath(
          new URL("../../bridge/ghidra/ReaGhidraBridge.java", import.meta.url),
        ),
        platform: installation.platform,
      }),
      targetPath: target.path,
      targetSha256: target.sha256,
      transport:
        installation.platform === "win32"
          ? "authenticated-loopback-tcp"
          : "unix-socket",
      providerVersion: prerequisites.value.providerVersion,
      profileDigest: committedProfile.digest,
      logger: this.logger.child({ layer: "ghidra-bridge" }),
    });
    return {
      execute: async (operation, parameters, options) => {
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
            return err(projectSessionError(operation, started.error));
          return ok(
            createAnalysisExecution(started.value, committedProfile.provider, {
              analysisProfile: committedProfile,
              limitations: [...healthLimitations, ...providerLimitations],
            }),
          );
        }
        const input = isGhidraFunctionOperation(operation)
          ? parseGhidraFunctionInput(operation, parameters)
          : parseGhidraInventoryInput(operation, parameters);
        if (!input.ok) return input;
        const called = await client.callTool(operation, input.value, {
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
          ...(operation === "procedure_pseudo_code" ||
          operation === "analyze_function"
            ? { timeoutMs: GHIDRA_DECOMPILE_REQUEST_TIMEOUT_MS }
            : {}),
        });
        if (!called.ok)
          return err(projectSessionError(operation, called.error));
        const result = isGhidraFunctionOperation(operation)
          ? parseGhidraFunctionResult(operation, called.value)
          : parseGhidraInventoryResult(operation, called.value);
        if (!result.ok) return result;
        return ok(
          createAnalysisExecution(result.value, committedProfile.provider, {
            rawResult: called.value,
            analysisProfile: committedProfile,
            limitations: [...limitationsFor(operation), ...providerLimitations],
          }),
        );
      },
      close: () => client.close(),
    };
  }

  #inspectInstallation(): GhidraInstallationInspection {
    const options = {
      ...(this.config.ghidraInstallDir === undefined
        ? {}
        : { installDir: this.config.ghidraInstallDir }),
      ...(this.config.ghidraJavaHome === undefined
        ? {}
        : { javaHome: this.config.ghidraJavaHome }),
      ...(this.installationHost?.platform === undefined
        ? {}
        : { platform: this.installationHost.platform }),
      ...(this.installationHost?.architecture === undefined
        ? {}
        : { architecture: this.installationHost.architecture }),
    };
    this.#installation ??=
      this.installationHost === undefined
        ? inspectGhidraInstallation(options)
        : inspectGhidraInstallation(options, this.installationHost);
    return this.#installation;
  }
}

const inspectWindowsP0TargetSupport = (
  target: BinaryTarget,
  diagnostics: Readonly<Record<string, string | boolean | null>>,
): ProviderTargetSupport => {
  if (target.format !== "pe")
    return {
      status: "unsupported",
      code: "target_format_unsupported",
      reason: "Windows Ghidra P0 accepts PE targets only.",
      diagnostics,
    };
  if (target.architecture !== "x86_64")
    return {
      status: "unsupported",
      code: "architecture_unsupported",
      reason: "Windows Ghidra P0 accepts x86-64 PE targets only.",
      diagnostics,
    };
  if (target.executableRole !== "application")
    return {
      status: "unsupported",
      code: "target_role_unsupported",
      reason:
        "Windows Ghidra P0 accepts PE applications, not DLL or non-executable images.",
      diagnostics,
    };
  if (target.managed !== false)
    return {
      status: "unsupported",
      code: "managed_target_unsupported",
      reason:
        "Windows Ghidra P0 accepts native PE applications; managed or unclassified PE targets are unsupported.",
      diagnostics,
    };
  return {
    status: "supported",
    code: null,
    reason: null,
    diagnostics,
  };
};

interface GhidraClientCoordinates {
  readonly analyzeHeadlessPath: string;
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
  if (
    !installation.available ||
    installation.analyzeHeadlessPath === null ||
    installation.providerVersion === null
  )
    return err(
      new ProviderAdapterError("ghidra", "health", {
        diagnostics: ghidraInstallationDiagnostics(installation),
      }),
    );
  if (profile === undefined || profile.provider.id !== "ghidra")
    return err(new ProviderAdapterError("ghidra", "health"));
  return ok({
    analyzeHeadlessPath: installation.analyzeHeadlessPath,
    providerVersion: installation.providerVersion,
    profile,
  });
};

const unavailableClient = (failure: AnalysisError): AnalysisClient => ({
  execute: () => Promise.resolve(err(failure)),
  close: () => Promise.resolve(),
});

const projectSessionError = (
  operation: AnalysisOperation,
  failure: GhidraSessionError,
): AnalysisError => {
  if (failure.kind === "cancelled")
    return new AnalysisCancelledError(operation);
  if (failure.kind === "timeout" || failure.kind === "analysis_timeout")
    return new AnalysisTimeoutError(
      operation,
      failure.timeoutMs ??
        (failure.kind === "analysis_timeout"
          ? GHIDRA_ANALYSIS_TIMEOUT_SECONDS * 1_000
          : GHIDRA_STARTUP_TIMEOUT_MS),
    );
  if (failure.kind === "remote" && failure.remoteCode === "decompile_timeout")
    return new AnalysisTimeoutError(
      operation,
      GHIDRA_DECOMPILE_TIMEOUT_SECONDS * 1_000,
    );
  if (failure.kind === "remote" && failure.remoteCode === "decompile_cancelled")
    return new AnalysisCancelledError(operation);
  if (
    failure.kind === "remote" &&
    ["invalid_request", "not_found", "ambiguous"].includes(
      failure.remoteCode ?? "",
    )
  )
    return new AnalysisInputError(operation, { cause: failure });
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
