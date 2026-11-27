import {
  bindArtifactFileCleanup,
  ArtifactResourceScope,
} from "../resources/index.js";
import { HOST_PLATFORM } from "../platform/HostPlatform.js";
import { launchRegexMatchingLimitation } from "../process/RegexMatcher.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import {
  createAnalysisProfile,
  analysisProfilesEqual,
} from "../domain/analysisProfile.js";
import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import type {
  BinaryArchitecture,
  BinaryTarget,
} from "../domain/binaryTargetTypes.js";
import { err, ok } from "../domain/result.js";
import { cancelledBy } from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type {
  AnalysisClient,
  AnalysisProviderBoundClientFactory,
  AnalysisProviderInspectionOptions,
  AnalysisProfileResolutionOptions,
  AnalysisProviderReadinessSnapshot,
  CapabilityDescriptor,
  AnalysisProviderCandidate,
  ProviderAvailability,
  ProviderTargetSupport,
} from "../ports/AnalysisProvider.js";
import type { AppConfig } from "../config/types.js";
import type { ConfigurationError } from "../domain/configurationErrors.js";
import { idaRegistrationDigest } from "./IdaRegistrationIdentity.js";
import { isDeepStrictEqual } from "node:util";
import type { Result } from "../domain/result.js";
import {
  readIdaConfiguration,
  idaCompatibilityProfile,
  IDA_COMPATIBILITY_PROFILES,
  type IdaConfiguration,
  idaConfigurationError,
} from "./IdaConfiguration.js";
import {
  createIdaMcpConnection,
  type IdaMcpConnection,
} from "./IdaMcpConnection.js";
import { idaCapabilities } from "./IdaProviderCapabilities.js";
import { IDA_PROVIDER_IDENTITY } from "./IdaProviderMetadata.js";
import { IdaSessionClient } from "./IdaSessionClient.js";
import {
  admitIdaConfiguration,
  IDA_WORKSPACE_ROOT_REMEDIATION,
  type IdaAdmission,
} from "./IdaAdmission.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import type { ProviderInspectionScope } from "../ports/ProviderInspectionScope.js";
import { errorMessage } from "../kernel/errorMessage.js";

const IDA_ARCHITECTURES = {
  x86: "supported",
  x86_64: "supported",
  arm: "supported",
  arm64: "supported",
  arm64_32: "unsupported",
  mips: "ghidra",
  "6502": "unsupported",
  riscv: "ghidra",
  powerpc: "ghidra",
  m68k: "unsupported",
  hexagon: "ghidra",
  xtensa: "unsupported",
} as const satisfies Record<
  BinaryArchitecture,
  "supported" | "unsupported" | "ghidra"
>;

/** Bring-your-own IDA MCP candidate; discovery performs no provider startup. */
export class IdaProvider implements AnalysisProviderCandidate {
  readonly #ownedResources = new ArtifactResourceScope();
  readonly #inspectionOwner = this.#ownedResources.forCloseOwners();
  readonly #registrationByScope = new WeakMap<
    ProviderInspectionScope,
    Promise<Result<IdaConfiguration, ConfigurationError>>
  >();
  private readonly environment: NodeJS.ProcessEnv;
  constructor(
    private readonly config: AppConfig,
    environment: Readonly<NodeJS.ProcessEnv>,
    private readonly connectionFactory: (
      config: IdaConfiguration,
      environment: Readonly<NodeJS.ProcessEnv>,
    ) => IdaMcpConnection = (config, environment) =>
      createIdaMcpConnection(config, environment, {
        platform: HOST_PLATFORM.platform,
      }),
  ) {
    this.environment = snapshotEnvironment(environment, HOST_PLATFORM.platform);
  }

  identity() {
    return IDA_PROVIDER_IDENTITY;
  }
  capabilities(): readonly CapabilityDescriptor[] {
    const profiles = [
      ...idaCapabilities(
        IDA_COMPATIBILITY_PROFILES.native,
        true,
        this.#regexLimitation(),
      ),
      ...idaCapabilities(
        IDA_COMPATIBILITY_PROFILES.modern,
        true,
        this.#regexLimitation(),
      ),
    ];
    const byOperation = new Map<string, (typeof profiles)[number][]>();
    for (const capability of profiles) {
      const existing = byOperation.get(capability.operation) ?? [];
      existing.push(capability);
      byOperation.set(capability.operation, existing);
    }
    return [...byOperation.values()].map((variants): CapabilityDescriptor => {
      const first = variants[0]!;
      const available = variants.some(({ available }) => available);
      const effects = {
        mutatesArtifact: variants.some(
          ({ effects }) => effects.mutatesArtifact,
        ),
        launchesProcess: variants.some(
          ({ effects }) => effects.launchesProcess,
        ),
        mayShowUi: variants.some(({ effects }) => effects.mayShowUi),
        mayAccessNetwork: variants.some(
          ({ effects }) => effects.mayAccessNetwork,
        ),
        mayWriteFilesystem: variants.some(
          ({ effects }) => effects.mayWriteFilesystem,
        ),
        changesPermissions: variants.some(
          ({ effects }) => effects.changesPermissions,
        ),
        requiresRoot: variants.some(({ effects }) => effects.requiresRoot),
      };
      const limitations = [
        ...new Set(variants.flatMap(({ limitations }) => limitations)),
      ];
      const descriptor = {
        provider: first.provider,
        operation: first.operation,
        ...(first.cachePolicy === undefined
          ? {}
          : { cachePolicy: first.cachePolicy }),
        effects,
        limitations,
      };
      return available
        ? { ...descriptor, available: true, reason: null }
        : {
            ...descriptor,
            available: false,
            reason:
              first.reason ??
              "No configured IDA compatibility profile admits this operation.",
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
      const failure = new ProviderCleanupError(
        IDA_PROVIDER_IDENTITY.id,
        this.#ownedResources.cleanupResources,
        { cause: errorMessage(cause) },
        { cause, operation: "close_owned_resources" },
      );
      bindArtifactFileCleanup(cause, failure);
      return err(failure);
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
    const capabilities = config.ok
      ? idaCapabilities(
          idaCompatibilityProfile(config.value),
          "command" in config.value,
          this.#regexLimitation(),
        )
      : this.capabilities();
    const registrationDiagnostics = {
      configured: this.config.idaMcpConfigPath !== undefined,
      registration_path: this.config.idaMcpConfigPath ?? null,
      live_connection_probed: false,
    };
    // Readiness-gated operations carry the same owner observation and repair.
    const unavailable = (
      availability: Extract<ProviderAvailability, { status: "unavailable" }>,
    ): AnalysisProviderReadinessSnapshot => ({
      availability,
      capabilities: capabilities.map((capability) =>
        capability.available
          ? {
              ...capability,
              available: false as const,
              reason: availability.reason,
              availabilityCode: availability.code,
              remediation: availability.remediation,
            }
          : capability,
      ),
    });
    if (!config.ok) {
      const failure = projectAnalysisError(config.error);
      return unavailable({
        status: "unavailable",
        code:
          this.config.idaMcpConfigPath === undefined
            ? "not_configured"
            : "open_options_invalid",
        reason: failure.message,
        remediation: failure.remediation.action,
        diagnostics: {
          ...registrationDiagnostics,
          configuration_details: failure.details ?? null,
        },
      });
    }
    const admission = await admitIdaConfiguration(config.value);
    if (!admission.admitted)
      return unavailable(
        idaRefusalAvailability(admission, registrationDiagnostics),
      );
    return {
      availability: {
        status: "available" as const,
        code: null,
        reason: null,
        diagnostics: {
          ...registrationDiagnostics,
          mode: config.value.mode,
          transport: "command" in config.value ? "stdio" : "http",
        },
      },
      capabilities,
    };
  }
  inspectTargetSupport(target: BinaryTarget): ProviderTargetSupport {
    const diagnostics = {
      target_kind: target.kind,
      target_format: target.format,
    };
    if (target.format === "gamecube-dol")
      return {
        status: "unsupported",
        code: "target_format_unsupported",
        reason:
          "IDA does not admit caller-selected GameCube DOL images. Open the target with Ghidra and select format gamecube-dol.",
        diagnostics,
      };
    if (target.kind === "database")
      return target.databaseEngine !== "ida"
        ? {
            status: "unsupported",
            code: "target_format_unsupported",
            reason:
              "IDA opens only IDA .idb/.i64 databases. Select the original input binary or an IDA database.",
            diagnostics,
          }
        : {
            status: "unknown",
            code: null,
            reason:
              "IDA registration has not been resolved, so whether it can open an existing database is unknown.",
            diagnostics,
          };
    if (target.kind !== "executable")
      return {
        status: "unsupported",
        code: "target_kind_unsupported",
        reason:
          "IDA MCP integration admits executable inputs and IDA databases. Select the original input binary.",
        diagnostics,
      };
    if (target.format === "raw-binary")
      return {
        status: "unsupported",
        code: "target_format_unsupported",
        reason:
          "IDA does not admit headerless raw binaries. Open the target with Ghidra and supply architecture and entry_point.",
        diagnostics,
      };
    const lane = IDA_ARCHITECTURES[target.architecture];
    if (lane !== "supported")
      return {
        status: "unsupported",
        code: "architecture_unsupported",
        // Header-declared families that Ghidra admits keep the pointer there.
        reason:
          lane === "ghidra"
            ? `REA's IDA adapter has no verified ${target.architecture} lane. Select a supported Ghidra profile instead.`
            : `REA's IDA adapter has no verified ${target.architecture} lane.`,
        diagnostics,
      };
    return target.format === "mach-o-universal"
      ? {
          status: "unknown",
          code: null,
          reason:
            "IDA mode has not been resolved, so universal Mach-O slice identity is unknown.",
          diagnostics,
        }
      : { status: "supported", code: null, reason: null, diagnostics };
  }
  async inspectTargetSupportWithOptions(
    target: BinaryTarget,
    options: AnalysisProviderInspectionOptions,
  ): Promise<ProviderTargetSupport> {
    const base = this.inspectTargetSupport(target);
    // Only IDA databases and universal Mach-O depend on the registration.
    if (base.status !== "unknown") return base;
    const config = await this.#configuration(options);
    if (!config.ok)
      return {
        status: "unknown",
        code: null,
        reason: "IDA registration could not be resolved.",
        diagnostics: base.diagnostics,
      };
    // Only a Hex-Rays lease opens a private database copy; attached GUIs and
    // database supervisors have no verified route for an existing database.
    if (target.kind === "database") {
      if (config.value.protocol !== "hexrays")
        return {
          status: "unsupported",
          code: "target_kind_unsupported",
          reason:
            'Opening an existing IDA database requires the "hexrays" headless registration. Select the original input binary with this registration.',
          diagnostics: base.diagnostics,
        };
      if (!/\.(?:idb|i64)$/iu.test(target.path))
        return {
          status: "unsupported",
          code: "target_format_unsupported",
          reason:
            "The Hex-Rays IDA MCP requires a .idb or .i64 filename for a saved database. Select a packed database with its filename suffix.",
          diagnostics: base.diagnostics,
        };
      return {
        status: "supported",
        code: null,
        reason: null,
        diagnostics: base.diagnostics,
      };
    }
    // Attached identity is the recorded whole-input digest, which every slice
    // of a universal file shares, so it cannot prove the GUI loaded the slice
    // admission selected. Headless mode thins that slice into its own input.
    if (config.value.mode === "attached")
      return {
        status: "unsupported",
        code: "target_format_unsupported",
        reason: `Attached IDA records only the whole-file digest of a universal Mach-O, so REA cannot verify that the open database is its ${target.architecture} slice. Extract that slice with lipo -thin and open the thin file in both IDA and REA, or use headless mode.`,
        diagnostics: { ...base.diagnostics, mode: "attached" },
      };
    return {
      status: "supported",
      code: null,
      reason: null,
      diagnostics: base.diagnostics,
    };
  }
  async resolveAnalysisProfile(
    target: BinaryTarget,
    options?: AnalysisProfileResolutionOptions,
  ) {
    if (options?.signal?.aborted === true)
      return err(cancelledBy("ida:profile", options.signal));
    const config = await this.#configuration(options);
    if (!config.ok) return config;
    const profile = createAnalysisProfile(IDA_PROVIDER_IDENTITY, {
      version_scope: "rea-ida-adapter",
      engine_version: null,
      upstream_distribution_version: null,
      mode: config.value.mode,
      compatibility_profile: idaCompatibilityProfile(config.value).identity,
      database_revision: null,
      cache_policy: "live",
      registration_digest: idaRegistrationDigest(config.value),
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
        ? this.#createBoundClient(registration, target, profile)
        : this.#unboundClient(
            "IDA client factory received a target or profile different from the resolved binding.",
          );
    return ok({
      profile,
      createClient,
    });
  }
  createClient(
    _target: BinaryTarget,
    _profile?: AnalysisProfileCommitment,
  ): AnalysisClient {
    return this.#unboundClient(
      "IDA client creation requires the provider-owned selected profile binding.",
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
      this.config.idaMcpConfigPath === undefined
        ? Promise.resolve(readIdaConfigurationNotConfigured())
        : readIdaConfiguration(this.config.idaMcpConfigPath, {
            ...(signal === undefined ? {} : { signal }),
            resourceScope: options?.resourceScope ?? this.#inspectionOwner,
          });
    if (scope?.active === true) {
      this.#registrationByScope.set(scope, pending);
      // The read observes the first caller's signal; a cancelled or failed
      // read must not answer every later caller in this scope.
      pending.catch(() => {
        if (this.#registrationByScope.get(scope) === pending)
          this.#registrationByScope.delete(scope);
      });
    }
    const registration = await pending;
    return registration;
  }
  #regexLimitation(): string {
    return launchRegexMatchingLimitation(
      this.config.regexMatchingDeadline,
      this.config.regexWorkerHeapRequest,
    );
  }
  #createBoundClient(
    config: IdaConfiguration,
    target: BinaryTarget,
    profile: AnalysisProfileCommitment,
  ): AnalysisClient {
    return new IdaSessionClient(
      config,
      target,
      this.connectionFactory(config, this.environment),
      profile,
      this.config,
    );
  }
  #unboundClient(reason: string): AnalysisClient {
    const error = idaConfigurationError(reason);
    return {
      execute: async () => err(error),
      close: async () => ok(null),
    };
  }
}

const readIdaConfigurationNotConfigured = () =>
  err(
    idaConfigurationError(
      "Set REA_IDA_MCP_CONFIG to an upstream IDA MCP JSON registration; see docs/providers/ida-provider.md.",
    ),
  );

/** Project IDA's admission refusal into provider availability. */
const idaRefusalAvailability = (
  admission: Extract<IdaAdmission, { readonly admitted: false }>,
  registrationDiagnostics: Readonly<Record<string, unknown>>,
): Extract<ProviderAvailability, { status: "unavailable" }> => {
  const { refusal } = admission;
  switch (refusal.kind) {
    case "private_workspace_unavailable":
      return {
        status: "unavailable",
        code: refusal.privacy.code,
        reason: refusal.privacy.reason,
        remediation: refusal.privacy.remediation,
        diagnostics: {
          ...registrationDiagnostics,
          mode: "headless",
          private_workspace_available: false,
          windows_native_failure: { stage: refusal.privacy.failureStage },
        },
      };
    case "workspace_unusable":
      return {
        status: "unavailable",
        code: "open_options_invalid",
        reason: refusal.reason,
        remediation: IDA_WORKSPACE_ROOT_REMEDIATION,
        diagnostics: {
          ...registrationDiagnostics,
          mode: "headless",
          workspace_root: admission.workspaceRoot ?? null,
          private_workspace_available: false,
        },
      };
    default: {
      const unreachable: never = refusal;
      return unreachable;
    }
  }
};
