import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import {
  type AnalysisClient,
  type AnalysisClientContext,
  type AnalysisProfileResolutionOptions,
  type AnalysisProviderCandidate,
  type CapabilityDescriptor,
  type ProviderAvailability,
  type ProviderIdentity,
  type ProviderTargetSupport,
} from "../application/AnalysisProvider.js";
import type { AppConfig } from "../config/types.js";
import {
  createAnalysisProfile,
  type AnalysisProfileCommitment,
} from "../domain/analysisProfile.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import {
  jsonObjectSchema,
  jsonValueSchema,
  type JsonValue,
} from "../domain/jsonValue.js";
import { ok } from "../domain/result.js";
import type { Logger } from "pino";
import { GhidraClient } from "./GhidraClient.js";
import {
  ghidraInstallationDiagnostics,
  inspectGhidraInstallation,
  type GhidraInstallationHost,
  type GhidraInstallationInspection,
} from "./GhidraInstallation.js";
import { resolveGhidraAnalysisProfile } from "./GhidraAnalysisProfile.js";
import { resolveGhidraExtensions } from "./extensions/GhidraExtensions.js";
import {
  CAPABILITIES,
  windowsP0Capabilities,
  GHIDRA_PROVIDER_IDENTITY,
  GHIDRA_OPERATIONS,
} from "./GhidraProviderCapabilities.js";
import {
  createGhidraProviderClient,
  type GhidraProviderClientFactory,
} from "./GhidraProviderClient.js";
import {
  windowsNativeAuthorityUnavailableReason,
  hasWindowsNativeAuthority,
  windowsNativeCapabilities,
} from "../process/WindowsAuthority.js";

const SUPPORTED_ARCHITECTURES = new Set(["x86", "x86_64", "arm", "arm64"]);

/** Ghidra candidate backed by an isolated ephemeral headless import. */
export class GhidraProvider implements AnalysisProviderCandidate {
  #installation: GhidraInstallationInspection | undefined;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    environment: Readonly<NodeJS.ProcessEnv>,
    private readonly installationHost?: GhidraInstallationHost,
    private readonly clientFactory: GhidraProviderClientFactory = (options) =>
      new GhidraClient(options),
  ) {
    this.environment = snapshotEnvironment(
      environment,
      installationHost?.platform,
    );
  }

  identity(): ProviderIdentity {
    return GHIDRA_PROVIDER_IDENTITY;
  }

  capabilities(): readonly CapabilityDescriptor[] {
    return (this.installationHost?.platform ?? process.platform) === "win32"
      ? windowsP0Capabilities()
      : CAPABILITIES;
  }

  inspectAvailability(): ProviderAvailability {
    const installation = this.#inspectInstallation();
    const diagnostics = ghidraInstallationDiagnostics(installation);
    if (
      installation.status === "available" &&
      installation.platform === "win32" &&
      !hasWindowsNativeAuthority(installation.platform)
    )
      return {
        status: "unavailable",
        code: "unsupported_host",
        reason: windowsNativeAuthorityUnavailableReason(installation.platform),
        diagnostics: {
          ...diagnostics,
          windows_security: jsonObjectSchema.parse(
            windowsNativeCapabilities(installation.platform),
          ),
        },
      };
    return installation.status === "available"
      ? {
          status: "available",
          code: null,
          reason: null,
          diagnostics,
        }
      : {
          status: "unavailable",
          code: installation.rejection.code,
          reason: installation.rejection.reason,
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
      available_architectures:
        target.kind === "executable"
          ? [...target.availableArchitectures]
          : null,
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
    if (target.format === "mach-o" && target.availableArchitectures.length > 1)
      return {
        status: "unsupported",
        code: "architecture_unsupported",
        reason:
          "Ghidra v1 cannot enforce the selected architecture when importing a universal Mach-O; analyze a thinned Mach-O slice instead.",
        diagnostics,
      };
    if (!SUPPORTED_ARCHITECTURES.has(target.architecture))
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

  async resolveAnalysisProfile(
    target: BinaryTarget,
    options?: AnalysisProfileResolutionOptions,
  ) {
    const installation = this.#inspectInstallation();
    const resolved = await resolveGhidraAnalysisProfile(
      target,
      GHIDRA_PROVIDER_IDENTITY,
      installation,
      options?.signal,
    );
    if (!resolved.ok || resolved.value.profile === null) return resolved;
    const extensions = await resolveGhidraExtensions(
      this.config,
      target,
      installation.platform,
      options?.signal,
    );
    if (!extensions.ok) return extensions;
    if (extensions.value.length === 0) return resolved;
    return ok({
      ...resolved.value,
      profile: createAnalysisProfile(resolved.value.profile.provider, {
        ...resolved.value.profile.parameters,
        analysis_extensions: jsonValueSchema.parse(extensions.value),
      }),
    });
  }

  createClient(
    target: BinaryTarget,
    profile?: AnalysisProfileCommitment,
    context?: AnalysisClientContext,
  ): AnalysisClient {
    return createGhidraProviderClient({
      config: this.config,
      environment: this.environment,
      logger: this.logger,
      clientFactory: this.clientFactory,
      target,
      ...(profile === undefined ? {} : { profile }),
      ...(context === undefined ? {} : { context }),
      installation: this.#inspectInstallation(),
    });
  }

  #inspectInstallation(): GhidraInstallationInspection {
    const options = {
      environment: this.environment,
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
  diagnostics: Readonly<Record<string, JsonValue>>,
): ProviderTargetSupport => {
  if (target.format !== "pe")
    return {
      status: "unsupported",
      code: "target_format_unsupported",
      reason: "Windows Ghidra P0 accepts PE targets only.",
      diagnostics,
    };
  if (target.architecture !== "x86" && target.architecture !== "x86_64")
    return {
      status: "unsupported",
      code: "architecture_unsupported",
      reason: "Windows Ghidra P0 accepts x86 and x86-64 PE targets only.",
      diagnostics,
    };
  if (
    target.executableRole !== "application" &&
    target.executableRole !== "shared-library"
  )
    return {
      status: "unsupported",
      code: "target_role_unsupported",
      reason:
        "Windows Ghidra P0 accepts PE applications and DLLs, not non-executable images.",
      diagnostics,
    };
  if (target.managed !== false)
    return {
      status: "unsupported",
      code: "managed_target_unsupported",
      reason:
        "Windows Ghidra P0 accepts native PE applications and DLLs; managed or unclassified PE targets are unsupported.",
      diagnostics,
    };
  return {
    status: "supported",
    code: null,
    reason: null,
    diagnostics,
  };
};
