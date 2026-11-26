import { omitEnvironmentSettings } from "../process/snapshotEnvironment.js";
import { userConfigRegistrationFallback } from "./UserConfigurationLocation.js";
import { HOST_PLATFORM } from "../platform/HostPlatform.js";
import {
  isClientConfigurationCleanupFailure,
  retryClientConfigurationCleanup,
} from "./ClientConfigurationCleanup.js";
import { access } from "node:fs/promises";

import {
  ArtifactResourceScope,
  ArtifactReaderFailure,
  AnalysisCleanupLeaseGroup,
  type AnalysisCleanupLease,
} from "../resources/index.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import {
  currentClientRegistrationCommand,
  defaultClientRegistrationBlocker,
} from "./ClientRegistrationIdentity.js";
import {
  javaScriptRuntime,
  SUPPORTED_NODE_VERSION_PROSE,
  supportsJavaScriptRuntime,
  supportsNodeVersion,
} from "../domain/runtimeVersion.js";
import {
  runDoctor,
  systemDoctorHost,
  type DoctorHost,
  type DoctorScope,
} from "./Doctor.js";
import {
  installLinuxHopper,
  LinuxHopperTemporaryCleanupOwner,
  systemLinuxHopperInstallHost,
} from "./LinuxHopper.js";
import { installMacHopper, systemMacHopperInstallHost } from "./MacHopper.js";
import { linuxHopperReleaseCacheDirectory } from "./LinuxHopperCacheDirectory.js";
import {
  clientEvidencePaths,
  resolveSupportedClients,
  type SetupClient,
} from "./SupportedClients.js";
import {
  skillDestinations,
  canonicalSkillNeedsInstall,
  installCanonicalSkill,
  validateCanonicalSkillDirectories,
} from "./SetupSkill.js";
import {
  clientConfigurationAligned,
  ClientConfigurationCleanupRollbackFailure,
  configureClientConfiguration,
  inspectClientConfiguration,
} from "./SetupClientConfiguration.js";
import { failedConfigurationMessage } from "./SetupClients.js";
import {
  setupInstallFailure,
  type SetupHopperInstallResult,
} from "./SetupInstallFailure.js";
import {
  explicitSetupRegistrationEnvironment,
  providerRegistrationEnvironment,
} from "./SetupRegistrationEnvironment.js";
import type {
  SetupHost,
  SetupInitialState,
  SetupProviderEnvironment,
} from "./SetupTypes.js";
import { SetupCleanupOwner } from "./SetupCleanupOwner.js";
import { bindRegularFileCleanup } from "../process/RegularFileRead.js";
import { CURRENT_ENTRYPOINT_PATH } from "../process/CurrentEntrypointPath.js";
import { analysisProviderSelectorSchema } from "../domain/providerSelection.js";
import { systemDesktopBuildSetupHost } from "../desktop/DesktopBuildSetupHost.js";
import { clientEnvironment } from "./SetupPlan.js";
import { errorMessage } from "../kernel/errorMessage.js";

/**
 * The launcher setup registers, and why it must not be registered when it
 * exists only inside one MSIX package's private storage.
 */
const setupRegistration = (
  platform: NodeJS.Platform,
  homeDirectory: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  runtime?: "node" | "bun",
): Pick<SetupHost, "registrationCommand" | "registrationCommandBlocker"> => {
  const registrationCommand = currentClientRegistrationCommand({
    platform,
    entrypointPath: CURRENT_ENTRYPOINT_PATH,
    environment,
    runtime,
  });
  const registrationCommandBlocker = defaultClientRegistrationBlocker(
    registrationCommand,
    platform,
    homeDirectory,
    environment,
  );
  return registrationCommandBlocker === undefined
    ? { registrationCommand }
    : { registrationCommand, registrationCommandBlocker };
};

export const filterClientsNeedingConfigure = async (
  host: SetupHost,
  detectedClients: readonly SetupClient[],
  environment: Parameters<typeof clientEnvironment>[0],
  command: readonly string[],
): Promise<readonly SetupClient[]> => {
  const needs = await Promise.all(
    detectedClients.map((client) =>
      host.clientNeedsConfigure(
        client,
        clientEnvironment(environment, client.name),
        command,
      ),
    ),
  );
  return detectedClients.filter((_, index) => needs[index]);
};

/** Refuse a JavaScript runtime REA does not support before any setup work. */
export const hostRemediation = (host: SetupHost): string | undefined => {
  const runtime =
    host.runtime ??
    (host.nodeVersion.length > 0
      ? javaScriptRuntime({
          node: host.nodeVersion,
          bun: process.versions.bun,
        })
      : undefined);
  if (runtime !== undefined && supportsJavaScriptRuntime(runtime)) {
    return undefined;
  }
  return supportsNodeVersion(host.nodeVersion)
    ? undefined
    : `Install ${SUPPORTED_NODE_VERSION_PROSE} and rerun setup.`;
};

/** Production setup effects for Hopper, agent configuration, and the canonical skill directory. */
export const systemSetupHost = (
  selectedDoctorHost: DoctorHost | undefined = undefined,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  options?: { readonly runtime?: "node" | "bun" | undefined },
  savedDefaults?: ReadonlySet<string>,
): SetupHost => {
  const doctorHost =
    selectedDoctorHost ??
    systemDoctorHost({ environment, registrationScope: "user" });
  const platform = doctorHost.platform;
  const { homeDirectory } = doctorHost;
  const macHopperHost =
    platform === "darwin"
      ? systemMacHopperInstallHost(homeDirectory, environment, () =>
          doctorHost.macosVersion(),
        )
      : undefined;
  const resources = new ArtifactResourceScope();
  const linuxDistribution = () => doctorHost.linuxDistribution();
  const linuxHopperHost = systemLinuxHopperInstallHost(
    environment,
    linuxDistribution,
  );
  const pendingLinuxHopperCleanup = new LinuxHopperTemporaryCleanupOwner();
  const macCleanup = {
    rejectedPrefix: "Hopper host cleanup failed",
    close: async () => macHopperHost?.close?.(),
  };
  const temporaryCleanup = {
    rejectedPrefix: "Linux Hopper cleanup retry failed",
    close: () => pendingLinuxHopperCleanup.retry(linuxHopperHost.cleanup),
  };
  const publisherCleanup = {
    rejectedPrefix: "Linux Hopper publisher cleanup failed",
    close: async () => {
      await linuxHopperHost.close?.();
    },
  };
  const registration = setupRegistration(
    platform,
    homeDirectory,
    environment,
    options?.runtime,
  );
  const cleanup = new SetupCleanupOwner([
    macCleanup,
    {
      rejectedPrefix: "Doctor host cleanup failed",
      close: async () => doctorHost.close?.(),
    },
    temporaryCleanup,
    publisherCleanup,
    { close: () => resources.close() },
  ]);
  return {
    platform,
    homeDirectory,
    ...(platform === "linux"
      ? {
          linuxHopperReleaseCache:
            linuxHopperReleaseCacheDirectory(environment),
        }
      : {}),
    skillDestinations: (clientIds) =>
      skillDestinations(homeDirectory, clientIds, environment, platform),
    ...registration,
    runtime: javaScriptRuntime(process.versions),
    nodeVersion: process.versions.node,
    macosVersion: () => doctorHost.macosVersion(),
    linuxDistribution,
    close: () => cleanup.close(),
    initialSetupState: async (
      scope?: DoctorScope,
    ): Promise<SetupInitialState> => {
      const diagnosis = await runDoctor(undefined, doctorHost, scope);
      const hopperSetting =
        diagnosis.staticProviderSettings?.HOPPER_LAUNCHER_PATH;
      const providerEnvironment: SetupProviderEnvironment = {
        ...omitEnvironmentSettings(
          {
            ...providerRegistrationEnvironment(
              diagnosis.providerInspections ?? [],
            ),
            ...(diagnosis.hopperPath === undefined ||
            hopperSetting?.source === "config"
              ? {}
              : { HOPPER_LAUNCHER_PATH: diagnosis.hopperPath }),
            ...explicitSetupRegistrationEnvironment(environment),
          },
          savedDefaults,
        ),
        ...(savedDefaults !== undefined && savedDefaults.size > 0
          ? userConfigRegistrationFallback(environment, platform)
          : {}),
      };
      const requestedProvider = analysisProviderSelectorSchema.safeParse(
        environment.REA_ANALYSIS_PROVIDER,
      );
      return {
        ...(diagnosis.hopperPath === undefined
          ? {}
          : { hopperPath: diagnosis.hopperPath }),
        ...(diagnosis.hopperPath !== undefined &&
        (hopperSetting === undefined
          ? diagnosis.hopperPath === environment.HOPPER_LAUNCHER_PATH
          : hopperSetting.source !== "auto")
          ? { hopperLauncherConfigured: true }
          : {}),
        providerConfigured:
          diagnosis.hopperPath !== undefined ||
          diagnosis.providerInspections?.some(
            ({ configured }) => configured,
          ) === true ||
          providerEnvironment.REA_JEB_MCP_URL !== undefined ||
          (requestedProvider.success && requestedProvider.data !== "auto"),
        providerEnvironment,
        doctor: diagnosis,
      };
    },
    installHopper: (replaceExisting, signal) =>
      resources.run<SetupHopperInstallResult>(async () => {
        const publisher = platform === "linux" ? publisherCleanup : macCleanup;
        const cancellation = signal === undefined ? {} : { signal };
        cleanup.admit(publisher);
        try {
          if (platform === "linux") {
            const result = await installLinuxHopper(
              linuxHopperHost,
              cancellation,
            );
            if (result.cleanupFailure !== undefined) {
              pendingLinuxHopperCleanup.retain(result.cleanupFailure);
              cleanup.admit(temporaryCleanup);
            }
            if (result.status === "installed")
              return { status: "installed", launcherPath: result.launcherPath };
            const failure = setupInstallFailure(result.reason, {
              packageFailure: result.packageFailure,
              platform: "linux",
              download: result.download,
            });
            // A failed vendor request is already described by its owned facts.
            const detail =
              result.download !== undefined
                ? undefined
                : (result.verificationFailure?.message ??
                  result.pythonRuntimeFailure?.message ??
                  (result.operationFailure === undefined
                    ? undefined
                    : `${result.operationFailure.operation}${result.operationFailure.path === undefined ? "" : ` at ${result.operationFailure.path}`}: ${result.operationFailure.systemCode === undefined ? "" : `${result.operationFailure.systemCode}: `}${result.operationFailure.detail}`));
            return detail !== undefined
              ? {
                  ...failure,
                  remediation: `${detail} ${failure.remediation}`,
                }
              : failure;
          }
          if (macHopperHost === undefined)
            return setupInstallFailure("unsupported_host");
          const result = await installMacHopper(
            { replaceExisting, ...cancellation },
            macHopperHost,
          );
          if (result.status === "installed")
            return {
              status: "installed",
              launcherPath: result.launcherPath,
              ...(result.openFailure === undefined
                ? {}
                : {
                    warning: `Hopper was installed, but macOS could not open it: ${result.openFailure}. Open ${result.launcherPath} manually to complete first-run setup.`,
                  }),
              ...(result.cleanupFailure === undefined
                ? {}
                : { cleanupFailure: result.cleanupFailure }),
            };
          const failure = setupInstallFailure(result.reason, {
            download: result.download,
          });
          const diagnostic = setupInstallerDiagnostic(result.diagnostic);
          return {
            ...failure,
            remediation: [
              failure.remediation,
              ...(diagnostic === undefined
                ? []
                : [`Installer detail: ${diagnostic}`]),
              ...(result.cleanupFailure === undefined
                ? []
                : [result.cleanupFailure]),
            ].join(" "),
          };
        } finally {
          cleanup.admit(publisher);
        }
      }),
    detectedClients: () => detectClients(homeDirectory, platform, environment),
    supportedClients: () =>
      resolveSupportedClients(homeDirectory, platform, environment),
    ...clientConfigurationOperations(
      resources,
      doctorHost.resolveProviderRequestBudget,
      platform,
      environment,
    ),
    skillNeedsInstall: (clientIds) =>
      canonicalSkillNeedsInstall(
        homeDirectory,
        clientIds,
        environment,
        platform,
        resources,
      ),
    validateSkillDirectories: (clientIds) =>
      validateCanonicalSkillDirectories(
        homeDirectory,
        clientIds,
        environment,
        platform,
      ),
    installSkill: (clientIds) =>
      installCanonicalSkill(
        homeDirectory,
        clientIds,
        environment,
        platform,
        undefined,
        resources,
      ),
    doctor: (scope) => runDoctor(undefined, doctorHost, scope),
    desktopBuild: desktopBuildHost(doctorHost, environment, resources),
  };
};

const desktopBuildHost = (
  doctorHost: DoctorHost,
  environment: Readonly<NodeJS.ProcessEnv>,
  resources: ArtifactResourceScope,
) =>
  systemDesktopBuildSetupHost(
    environment,
    doctorHost.platform,
    doctorHost.clientRegistrations,
    resources,
  );

const setupInstallerDiagnostic = (
  value: string | undefined,
): string | undefined => {
  if (value === undefined) return undefined;
  const normalized = value
    .replace(/\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\([0-9A-Za-z]|[@-Z\\^_])/gu, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized === "") return undefined;
  return normalized.length <= 400
    ? normalized
    : `${normalized.slice(0, 397).trimEnd()}...`;
};

const clientConfigurationOperations = (
  resources: ArtifactResourceScope,
  resolveProviderRequestBudget: DoctorHost["resolveProviderRequestBudget"],
  platform: NodeJS.Platform,
  launcherEnvironment: Readonly<NodeJS.ProcessEnv>,
) => ({
  configureClient: (
    client: SetupClient,
    providerEnvironment: SetupProviderEnvironment,
    command: readonly string[],
  ) =>
    runClientConfigurationOperation(resources, async () =>
      client.format === "unsupported"
        ? { status: "skipped" as const }
        : configureClientConfiguration(
            client,
            providerEnvironment,
            command,
            resolveProviderRequestBudget,
            platform,
            launcherEnvironment,
          ),
    ),
  clientNeedsConfigure: (
    client: SetupClient,
    providerEnvironment: SetupProviderEnvironment,
    command: readonly string[],
  ) =>
    runClientConfigurationOperation(resources, async () =>
      client.format === "unsupported"
        ? false
        : !(await clientConfigurationAligned(
            client,
            providerEnvironment,
            command,
            resolveProviderRequestBudget,
            platform,
            launcherEnvironment,
          )),
    ),
  inspectClientConfiguration: (
    client: SetupClient,
    providerEnvironment: SetupProviderEnvironment,
    command: readonly string[],
  ) =>
    runClientConfigurationOperation(resources, () =>
      inspectClientConfiguration(
        client,
        providerEnvironment,
        command,
        resolveProviderRequestBudget,
        platform,
        launcherEnvironment,
      ),
    ),
});

const runClientConfigurationOperation = async <Value>(
  resources: ArtifactResourceScope,
  operation: () => Promise<Value>,
): Promise<Value> => {
  try {
    return await resources.run(async () => {
      try {
        return await operation();
      } catch (cause: unknown) {
        if (!isClientConfigurationCleanupFailure(cause)) throw cause;
        const cleanup = await retryClientConfigurationCleanup(cause, resources);
        const rollback = cleanup.failures.find(
          (failure) =>
            failure instanceof ClientConfigurationCleanupRollbackFailure,
        );
        const rollbackMessage =
          rollback instanceof ClientConfigurationCleanupRollbackFailure
            ? ` ${failedConfigurationMessage(rollback.configurationFailure)}`
            : "";
        throw configurationCleanupError(
          `Could not safely access client configuration at ${cause.path}: ${errorMessage(cleanup.primary)}.${rollbackMessage}`,
          cause,
          cleanup.cleanup,
          cleanup.cleanupLeases,
        );
      }
    });
  } catch (cause: unknown) {
    if (cause instanceof ArtifactReaderFailure)
      throw configurationCleanupError(cause.message, cause, cause.cleanup);
    throw cause;
  }
};

const configurationCleanupError = (
  message: string,
  cause: unknown,
  cleanup:
    | { readonly reason: string; readonly resources: readonly string[] }
    | undefined,
  leases?: readonly AnalysisCleanupLease[],
): ConfigurationError => {
  const error = new ConfigurationError(message, {
    cause,
    settings: [{ setting: "client configuration", constraint: message }],
    ...(cleanup === undefined ? {} : { cleanup }),
  });
  if (leases !== undefined) new AnalysisCleanupLeaseGroup(error, leases);
  else bindRegularFileCleanup(cause, error);
  return error;
};

/** Detect supported agents from their config files or stable installation markers. */
export const detectClients = async (
  home: string,
  platform: NodeJS.Platform = HOST_PLATFORM.platform,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<readonly SetupClient[]> => {
  const detected: SetupClient[] = [];
  for (const candidate of await resolveSupportedClients(
    home,
    platform,
    environment,
  )) {
    if (
      candidate.configPathError !== undefined ||
      candidate.registrationApplicability === true
    )
      continue;
    if (await clientEvidencePresent(candidate)) detected.push(candidate);
  }
  return detected;
};

const clientEvidencePresent = async (client: SetupClient): Promise<boolean> => {
  for (const path of clientEvidencePaths(client))
    if (await exists(path)) return true;
  return false;
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch (cause: unknown) {
    // best-effort cleanup: optional host probing; absence means unavailable.
    void cause;
    return false;
  }
};
