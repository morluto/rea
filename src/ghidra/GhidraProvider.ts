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
  type AnalysisError,
  AnalysisTimeoutError,
  ProviderAdapterError,
} from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import type { Logger } from "../logger.js";
import { GhidraClient } from "./GhidraClient.js";
import {
  GHIDRA_ANALYSIS_TIMEOUT_SECONDS,
  GHIDRA_STARTUP_TIMEOUT_MS,
} from "./GhidraDefaults.js";
import {
  ghidraInstallationDiagnostics,
  inspectGhidraInstallation,
  type GhidraInstallationHost,
  type GhidraInstallationInspection,
} from "./GhidraInstallation.js";
import { GhidraHeadlessLauncher } from "./GhidraLauncher.js";
import { resolveGhidraAnalysisProfile } from "./GhidraAnalysisProfile.js";
import type { GhidraSessionError } from "./GhidraSessionError.js";

/** Public identity committed by every Ghidra-backed observation. */
export const GHIDRA_PROVIDER_IDENTITY: ProviderIdentity = Object.freeze({
  id: "ghidra",
  name: "Ghidra",
  version: null,
});

/** PR07 intentionally exposes session health but no binary operation contract. */
export const GHIDRA_PROVIDER_TOOL_CONTRACTS: readonly CapabilityDescriptor[] =
  Object.freeze([]);

const SUPPORTED_ARCHITECTURES = new Set(["x86", "x86_64", "arm", "arm64"]);
const SUPPORTED_FORMATS = new Set(["elf", "pe", "mach-o"]);

/** Linux Ghidra candidate backed by an isolated read-only headless import. */
export class GhidraProvider implements AnalysisProviderCandidate {
  #installation: GhidraInstallationInspection | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly installationHost?: GhidraInstallationHost,
  ) {}

  identity(): ProviderIdentity {
    return GHIDRA_PROVIDER_IDENTITY;
  }

  capabilities(): readonly CapabilityDescriptor[] {
    return GHIDRA_PROVIDER_TOOL_CONTRACTS;
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
    const diagnostics = {
      target_kind: target.kind,
      target_format: target.format,
      architecture: target.architecture ?? null,
    };
    if (target.kind !== "executable")
      return {
        status: "unsupported",
        code: "target_kind_unsupported",
        reason: `Ghidra v1 imports executable targets, not ${target.kind} targets.`,
        diagnostics,
      };
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
    const client = new GhidraClient({
      launcher: new GhidraHeadlessLauncher({
        analyzeHeadlessPath: prerequisites.value.analyzeHeadlessPath,
        ...(this.config.ghidraJavaHome === undefined
          ? {}
          : { javaHome: this.config.ghidraJavaHome }),
        bridgeScriptPath: fileURLToPath(
          new URL("../../bridge/ghidra/ReaGhidraBridge.java", import.meta.url),
        ),
      }),
      targetPath: target.path,
      providerVersion: prerequisites.value.providerVersion,
      profileDigest: committedProfile.digest,
      logger: this.logger.child({ layer: "ghidra-bridge" }),
    });
    return {
      execute: async (operation, _parameters, options) => {
        if (operation !== "health")
          return err(
            new AnalysisCapabilityUnavailableError(
              GHIDRA_PROVIDER_IDENTITY.id,
              operation,
              "Ghidra binary operations are not declared by this adapter release.",
            ),
          );
        const started = await client.start(options?.signal);
        if (!started.ok)
          return err(projectSessionError(operation, started.error));
        return ok(
          createAnalysisExecution(started.value, committedProfile.provider, {
            analysisProfile: committedProfile,
            limitations: [
              "The session proves completed default Ghidra auto-analysis but exposes no binary operations in this release.",
              "The imported program and project are ephemeral and externally read-only.",
            ],
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
    };
    this.#installation ??=
      this.installationHost === undefined
        ? inspectGhidraInstallation(options)
        : inspectGhidraInstallation(options, this.installationHost);
    return this.#installation;
  }
}

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
  return new ProviderAdapterError("ghidra", operation, {
    cause: failure,
    diagnostics: failure.diagnostics,
  });
};
