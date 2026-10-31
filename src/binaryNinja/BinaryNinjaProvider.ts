import { bindArtifactFileCleanup } from "../artifacts/ArtifactFileOperation.js";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import canonicalize from "canonicalize";
import type {
  AnalysisClient,
  AnalysisProviderBoundClientFactory,
  AnalysisProviderInspectionOptions,
  AnalysisProfileResolutionOptions,
  AnalysisProviderCandidate,
  ProviderAvailability,
  ProviderTargetSupport,
  RetainedResourceScope,
} from "../application/AnalysisProvider.js";
import type { AppConfig } from "../config/types.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import {
  createAnalysisProfile,
  analysisProfilesEqual,
  type AnalysisProfileCommitment,
} from "../domain/analysisProfile.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import type { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  binaryNinjaConfigurationError,
  readBinaryNinjaConfiguration,
  type BinaryNinjaConfiguration,
} from "./BinaryNinjaConfiguration.js";
import {
  createBinaryNinjaMcpConnection,
  type BinaryNinjaMcpConnection,
} from "./BinaryNinjaMcpConnection.js";
import {
  BINARY_NINJA_PROVIDER_IDENTITY,
  binaryNinjaCapabilities,
} from "./BinaryNinjaProviderCapabilities.js";
import { BinaryNinjaSessionClient } from "./BinaryNinjaSessionClient.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import type { ProviderInspectionScope } from "../application/ProviderInspectionScope.js";

/** Bring-your-own Binary Ninja GUI MCP candidate; discovery performs no connection. */
export class BinaryNinjaProvider implements AnalysisProviderCandidate {
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
    Promise<Result<BinaryNinjaConfiguration, ConfigurationError>>
  >();

  constructor(
    private readonly config: AppConfig,
    private readonly connectionFactory: (
      config: BinaryNinjaConfiguration,
    ) => BinaryNinjaMcpConnection = createBinaryNinjaMcpConnection,
  ) {}

  identity() {
    return BINARY_NINJA_PROVIDER_IDENTITY;
  }

  capabilities() {
    return binaryNinjaCapabilities();
  }

  hasPendingOwnedResources() {
    return this.#ownedResources.hasPending;
  }

  async closeOwnedResources() {
    try {
      await this.#ownedResources.close();
      return ok(null);
    } catch (cause: unknown) {
      const failure = new ProviderCleanupError(
        BINARY_NINJA_PROVIDER_IDENTITY.id,
        this.#ownedResources.cleanupResources,
        { cause: cause instanceof Error ? cause.message : String(cause) },
        { cause, operation: "close_owned_resources" },
      );
      bindArtifactFileCleanup(cause, failure);
      return err(failure);
    }
  }

  async inspectAvailability(
    options?: AnalysisProviderInspectionOptions,
  ): Promise<ProviderAvailability> {
    const config = await this.#configuration(options);
    return config.ok
      ? {
          status: "available",
          code: null,
          reason: null,
          diagnostics: {
            configured: true,
            transport: "http",
            live_connection_probed: false,
          },
        }
      : {
          status: "unavailable",
          code:
            this.config.binaryNinjaMcpConfigPath === undefined
              ? "not_configured"
              : "open_options_invalid",
          reason: config.error.message,
          diagnostics: { configured: false, live_connection_probed: false },
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
          "Binary Ninja MCP integration admits the original executable open in the GUI, not analysis databases or archives.",
        diagnostics,
      };
    if (target.format === "pe" && target.managed)
      return {
        status: "unsupported",
        code: "managed_target_unsupported",
        reason:
          "Binary Ninja does not decompile managed .NET code. Use REA's managed-code tools instead.",
        diagnostics,
      };
    if (
      target.format !== "pe" &&
      target.format !== "elf" &&
      target.format !== "mach-o"
    )
      return {
        status: "unsupported",
        code: "target_format_unsupported",
        reason:
          target.format === "mach-o-universal"
            ? "Binary Ninja's Raw view holds the whole universal file, so REA cannot verify which slice the GUI loaded. Extract the slice with lipo -thin and open the thin file in both Binary Ninja and REA."
            : `REA's Binary Ninja adapter admits PE, ELF and thin Mach-O executables, not ${target.format} inputs.`,
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
        new AnalysisCancelledError("binary-ninja:profile", {
          cause: options.signal.reason,
        }),
      );
    const config = await this.#configuration(options);
    if (!config.ok) return config;
    // Header values carry credentials and never enter the commitment.
    const { headers, ...settings } = config.value;
    const profile = createAnalysisProfile(BINARY_NINJA_PROVIDER_IDENTITY, {
      version_scope: "rea-binary-ninja-adapter",
      engine_version: null,
      mode: "attached-gui",
      compatibility_profile: "binary-ninja-gui-mcp",
      database_revision: null,
      cache_policy: "live",
      registration_digest: createHash("sha256")
        .update(
          canonicalize({
            ...settings,
            header_names: Object.keys(headers).sort(),
          }) ?? "",
        )
        .digest("hex"),
    });
    if (options?.scope !== undefined)
      this.#registrationByScope.delete(options.scope);
    const registration = config.value;
    const createClient: AnalysisProviderBoundClientFactory = (
      requestedTarget,
      requestedProfile,
    ) =>
      isDeepStrictEqual(requestedTarget, target) &&
      analysisProfilesEqual(requestedProfile, profile)
        ? new BinaryNinjaSessionClient(
            registration,
            target,
            this.connectionFactory(registration),
            profile,
            {
              regexMatchingDeadline: this.config.regexMatchingDeadline,
              regexWorkerHeapRequest: this.config.regexWorkerHeapRequest,
            },
          )
        : this.#unboundClient(
            "Binary Ninja client factory received a target or profile different from the resolved binding.",
          );
    return ok({ profile, createClient });
  }

  createClient(
    _target: BinaryTarget,
    _profile?: AnalysisProfileCommitment,
  ): AnalysisClient {
    return this.#unboundClient(
      "Binary Ninja client creation requires the provider-owned selected profile binding.",
    );
  }

  async #configuration(options?: AnalysisProviderInspectionOptions) {
    const scope = options?.scope;
    if (scope?.active === true) {
      const existing = this.#registrationByScope.get(scope);
      if (existing !== undefined) return existing;
    }
    const signal = options?.signal;
    const pending =
      this.config.binaryNinjaMcpConfigPath === undefined
        ? Promise.resolve(
            err(
              binaryNinjaConfigurationError(
                "Set REA_BINARY_NINJA_MCP_CONFIG to a Binary Ninja GUI MCP JSON registration; see docs/binary-ninja.md.",
              ),
            ),
          )
        : readBinaryNinjaConfiguration(this.config.binaryNinjaMcpConfigPath, {
            ...(signal === undefined ? {} : { signal }),
            resourceScope: options?.resourceScope ?? this.#inspectionOwner,
          });
    if (scope?.active === true) this.#registrationByScope.set(scope, pending);
    return pending;
  }

  #unboundClient(reason: string): AnalysisClient {
    const error = binaryNinjaConfigurationError(reason);
    return { execute: async () => err(error), close: async () => ok(null) };
  }
}
