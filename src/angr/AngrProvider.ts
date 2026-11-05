import { angrLoadOptions } from "./AngrProtocolValues.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import {
  createAnalysisProfile,
  analysisProfilesEqual,
} from "../domain/analysisProfile.js";
import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { err, ok } from "../domain/result.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import type {
  AnalysisClient,
  AnalysisProfileResolutionOptions,
  AnalysisProviderBoundClientFactory,
  AnalysisProviderCandidate,
  AnalysisProviderInspectionOptions,
  AnalysisProviderReadinessSnapshot,
  CapabilityDescriptor,
  ProviderAvailability,
  ProviderTargetSupport,
  RetainedResourceScope,
} from "../application/AnalysisProvider.js";
import type { ProviderInspectionScope } from "../application/ProviderInspectionScope.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { isDeepStrictEqual } from "node:util";
import type { AppConfig } from "../config/types.js";
import type { ConfigurationError } from "../domain/configurationErrors.js";
import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import type { Result } from "../domain/result.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  angrConfigurationError,
  readAngrConfiguration,
  type AngrConfiguration,
} from "./AngrConfiguration.js";
import {
  createAngrMcpConnection,
  type AngrMcpConnection,
} from "./AngrMcpConnection.js";
import { angrCapabilities } from "./AngrProviderCapabilities.js";
import { ANGR_PROVIDER_IDENTITY } from "./AngrProviderMetadata.js";
import { AngrSessionClient } from "./AngrSessionClient.js";

/** Bring-your-own angr MCP candidate; discovery performs no provider startup. */
export class AngrProvider implements AnalysisProviderCandidate {
  readonly #ownedResources = new ArtifactResourceScope();
  readonly #inspectionOwner: RetainedResourceScope = {
    retain: (owner, resource) =>
      this.#ownedResources.retain({
        kind: "lease",
        resource,
        lease: AnalysisCleanupLease.forCloseOwner(owner, resource),
      }),
    run: (operation) => this.#ownedResources.run(operation),
  };
  readonly #registrationByScope = new WeakMap<
    ProviderInspectionScope,
    Promise<Result<AngrConfiguration, ConfigurationError>>
  >();
  private readonly environment: NodeJS.ProcessEnv;
  constructor(
    private readonly config: AppConfig,
    environment: Readonly<NodeJS.ProcessEnv>,
    private readonly connectionFactory: (
      config: AngrConfiguration,
      environment: Readonly<NodeJS.ProcessEnv>,
    ) => AngrMcpConnection = createAngrMcpConnection,
  ) {
    this.environment = snapshotEnvironment(environment);
  }

  identity() {
    return ANGR_PROVIDER_IDENTITY;
  }
  /** Every effect any registration can have; readiness narrows it to the configured one. */
  capabilities(): readonly CapabilityDescriptor[] {
    const variants = [
      angrCapabilities("headless", "stdio"),
      angrCapabilities("attached", "stdio"),
      angrCapabilities("attached", "http"),
    ];
    return variants[0]!.map((capability, index) => {
      const all = variants.map((variant) => variant[index]!.effects);
      return {
        ...capability,
        effects: {
          mutatesArtifact: all.some((effects) => effects.mutatesArtifact),
          launchesProcess: all.some((effects) => effects.launchesProcess),
          mayShowUi: all.some((effects) => effects.mayShowUi),
          mayAccessNetwork: all.some((effects) => effects.mayAccessNetwork),
          mayWriteFilesystem: all.some((effects) => effects.mayWriteFilesystem),
          changesPermissions: all.some((effects) => effects.changesPermissions),
          requiresRoot: all.some((effects) => effects.requiresRoot),
        },
      };
    });
  }
  hasPendingOwnedResources() {
    return this.#ownedResources.hasPending;
  }
  async closeOwnedResources() {
    try {
      await this.#ownedResources.close();
      return ok(null);
    } catch (cause: unknown) {
      return err(
        new ProviderCleanupError(
          ANGR_PROVIDER_IDENTITY.id,
          this.#ownedResources.cleanupResources,
          { cause: cause instanceof Error ? cause.message : String(cause) },
          { cause, operation: "close_owned_resources" },
        ),
      );
    }
  }
  async inspectAvailability(
    options?: AnalysisProviderInspectionOptions,
  ): Promise<ProviderAvailability> {
    return (await this.inspectReadinessSnapshot(options)).availability;
  }
  async inspectReadinessSnapshot(
    options?: AnalysisProviderInspectionOptions,
  ): Promise<AnalysisProviderReadinessSnapshot> {
    const config = await this.#configuration(options);
    if (config.ok)
      return {
        availability: {
          status: "available",
          code: null,
          reason: null,
          diagnostics: {
            configured: true,
            mode: config.value.mode,
            transport: "command" in config.value ? "stdio" : "http",
            live_connection_probed: false,
          },
        },
        capabilities: angrCapabilities(
          config.value.mode,
          "url" in config.value ? "http" : "stdio",
        ),
      };
    const configured =
      this.config.angrMcpConfigPath !== undefined ||
      this.config.angrPythonPath !== undefined;
    return {
      availability: {
        status: "unavailable",
        code: !configured
          ? "not_configured"
          : this.config.angrMcpConfigPath === undefined
            ? "executable_missing"
            : "open_options_invalid",
        reason: config.error.message,
        remediation: projectAnalysisError(config.error).remediation.action,
        diagnostics: { configured, live_connection_probed: false },
      },
      capabilities: this.capabilities(),
    };
  }
  inspectTargetSupport(target: BinaryTarget): ProviderTargetSupport {
    const diagnostics = {
      target_kind: target.kind,
      target_format: target.format,
    };
    if (target.kind !== "executable")
      return {
        status: "unsupported",
        code: "target_kind_unsupported",
        reason:
          "angr admits executable inputs, not analysis databases or archives. Select the original input binary.",
        diagnostics,
      };
    if (target.format === "mach-o-universal")
      return {
        status: "unsupported",
        code: "target_format_unsupported",
        reason:
          "angr architecture selection cannot establish the caller-selected universal slice offset and size. Select a thin executable.",
        diagnostics,
      };
    if (
      target.format === "raw-binary" &&
      Object.keys(angrLoadOptions(target)).length === 0
    )
      return {
        status: "unsupported",
        code: "target_format_unsupported",
        reason:
          "The selected raw-image architecture has no supported angr loader mapping.",
        diagnostics,
      };
    return { status: "supported", code: null, reason: null, diagnostics };
  }
  async resolveAnalysisProfile(
    target: BinaryTarget,
    options?: AnalysisProfileResolutionOptions,
  ) {
    if (options?.signal?.aborted === true)
      return err(
        new AnalysisCancelledError("angr:profile", {
          cause: options.signal.reason,
        }),
      );
    const config = await this.#configuration(options);
    if (options?.scope !== undefined)
      this.#registrationByScope.delete(options.scope);
    if (!config.ok) return config;
    const registration = config.value;
    const createClient: AnalysisProviderBoundClientFactory = (
      requestedTarget,
      requestedProfile,
    ) =>
      isDeepStrictEqual(requestedTarget, target) &&
      analysisProfilesEqual(requestedProfile, profile)
        ? this.#createBoundClient(registration, target, profile)
        : unboundClient(
            "angr client factory received a target or profile different from the resolved binding.",
          );
    const profile = createAnalysisProfile(ANGR_PROVIDER_IDENTITY, {
      version_scope: "rea-angr-adapter",
      engine_version: null,
      mode: config.value.mode,
      transport: "command" in config.value ? "stdio" : "http",
      auto_load_libs: config.value.autoLoadLibs,
      cfg: { normalize: true, data_references: true },
      cache_policy: "live",
      registration_digest: createHash("sha256")
        .update(canonicalize(registration) ?? "")
        .digest("hex"),
    });
    return ok({ profile, createClient });
  }
  createClient(
    _target: BinaryTarget,
    _profile?: AnalysisProfileCommitment,
  ): AnalysisClient {
    return unboundClient(
      "angr client creation requires the provider-owned selected profile binding.",
    );
  }
  #createBoundClient(
    config: AngrConfiguration,
    target: BinaryTarget,
    profile: AnalysisProfileCommitment,
  ): AnalysisClient {
    return new AngrSessionClient(
      config,
      target,
      this.connectionFactory(config, this.environment),
      profile,
      {
        deadline: this.config.regexMatchingDeadline,
        heapRequest: this.config.regexWorkerHeapRequest,
      },
    );
  }
  async #configuration(options?: AnalysisProviderInspectionOptions) {
    const scope = options?.scope;
    if (scope?.active === true) {
      const existing = this.#registrationByScope.get(scope);
      if (existing !== undefined) return existing;
    }
    const signal = options?.signal;
    const pending = readAngrConfiguration(
      {
        mcpConfigPath: this.config.angrMcpConfigPath,
        pythonPath: this.config.angrPythonPath,
      },
      {
        signal,
        resourceScope: options?.resourceScope ?? this.#inspectionOwner,
      },
    );
    if (scope?.active === true) this.#registrationByScope.set(scope, pending);
    return await pending;
  }
}

const unboundClient = (reason: string): AnalysisClient => {
  const error = angrConfigurationError(reason);
  return {
    execute: async () => err(error),
    close: async () => ok(null),
  };
};
