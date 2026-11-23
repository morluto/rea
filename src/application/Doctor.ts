import { HOST_PLATFORM } from "../platform/HostPlatform.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  cancelledBy,
  carriedReason,
  OwnerCancellation,
} from "../domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { analysisErrorWithCleanupDependencies } from "../domain/analysisErrorCleanup.js";
import {
  bindArtifactFileCleanup,
  ArtifactReaderFailure,
  AnalysisCleanupLease,
  ArtifactResourceScope,
} from "../resources/index.js";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import type { RetainedResourceScope } from "../ports/AnalysisProvider.js";
import type {
  DoctorCheck,
  DoctorProviderInspection,
  DoctorProviderSetting,
} from "../ports/DoctorProviderInspection.js";
import {
  inspectNativeAnalysisConfiguration,
  type NativeAnalysisConfigurationInspection,
} from "../config/parseConfig.js";
import { homeDirectoryFromEnvironment } from "../config/homeDirectory.js";
import {
  omitEnvironmentSettings,
  snapshotEnvironment,
} from "../process/snapshotEnvironment.js";
import { appendCallerPath } from "../filesystem/callerPath.js";

import { analysisErrorRemediationAction } from "../domain/analysisErrorPresentation.js";
import { BinaryTargetError } from "../domain/configurationErrors.js";
import {
  execFileOutput,
  ExecFileOutputCancelledError,
  execFileOutputFailure,
  execFileFailureCapturedOutput,
} from "../process/ExecFileOutput.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import {
  javaScriptRuntime,
  type JavaScriptRuntime,
} from "../domain/runtimeVersion.js";
import { installedCaskAppdir, probeHomebrew } from "./homebrew.js";
import { readMacHopperRenamedLauncherCandidates } from "../hopperPaths/MacHopperPaths.js";
import {
  inspectLinuxHopperLauncher,
  linuxSharedLibrariesAvailable,
  readLinuxDistribution,
  type LinuxDistribution,
} from "./LinuxHopper.js";
import type { Result } from "../domain/result.js";
import type { HopperReleaseError } from "./HopperReleaseFeed.js";
import type { VerifiedLinuxHopperLauncher } from "./LinuxHopperPublisher.js";
import {
  readInstalledSkillIdentity,
  type InstalledSkillIdentity,
  type SkillPathIssue,
} from "./SetupSkill.js";
import type { CatalogIdentitySnapshot } from "../contracts/catalog/recordedCatalogDigests.js";
import { loadDefaultCatalogIdentity } from "../contracts/catalog/defaultCatalogIdentity.js";
import { PRODUCT_IDENTITY, SDK_IDENTITY } from "../identity.js";
import {
  readClientRegistrationStatuses,
  type ClientRegistrationStatus,
  type UnhealthyClientRegistrationStatus,
} from "./ClientRegistrationStatus.js";
import type { ProviderRequestBudgetResolver } from "./ClientRegistrationEnvironment.js";
import {
  copyableProviderRegistrationSettings,
  registrationSpelledSettings,
} from "./SetupRegistrationEnvironment.js";
import {
  collectDoctorDiagnostics,
  doctorHealthy,
} from "./DoctorDiagnostics.js";
import {
  normalizeDoctorScope,
  scopeDoctorChecks,
  type DoctorScopeReport,
} from "./DoctorScope.js";
import { selectedDesktopBuildChecks } from "./DesktopBuildDoctor.js";
import type {
  DesktopBuildFacts,
  DesktopBuildFactsInput,
  OwnedProviderSetting,
} from "../ports/DesktopBuildHost.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { settleConcurrent } from "./settleConcurrent.js";

/** One selected provider configuration observed by every readiness probe. */
export interface DoctorProviderConfiguration {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly savedDefaults?: ReadonlySet<string> | undefined;
  readonly unresolved?: ReadonlySet<string>;
  readonly failure?: {
    readonly detail: string;
    readonly remediation: string;
    readonly code: string;
    readonly classification: "unknown" | "config_drift";
  };
}

/** Read-only host capabilities required by diagnostics. */
export interface DoctorHost {
  readonly signal?: AbortSignal;
  readonly platform: NodeJS.Platform;
  readonly architecture: NodeJS.Architecture;
  readonly runtime: JavaScriptRuntime;
  readonly homeDirectory: string;
  readonly configuredHopperPath?: string;
  /**
   * Settings `parseConfig` rejects before native analysis starts.
   * Undefined means this host did not run that admission.
   */
  readonly nativeConfiguration?: NativeAnalysisConfigurationInspection;
  readonly configuredIlspyCmdPath?: string;
  macosVersion(): Promise<string | undefined>;
  linuxDistribution(): Promise<LinuxDistribution | undefined>;
  /** Route-specific target admission details from the host. */
  inspectTarget(path: string): Promise<DoctorCheck>;
  executable(path: string): Promise<boolean>;
  inspectLinuxHopper(
    path: string,
  ): Promise<Result<VerifiedLinuxHopperLauncher, HopperReleaseError>>;
  linuxDemoRuntimeCheck(): Promise<DoctorCheck>;
  /** Homebrew cask launcher; consulted only where macOS bundles are probed. */
  brewHopperPath(): Promise<string | undefined>;
  /** Renamed `Hopper*.app` launchers; consulted only where macOS bundles are probed. */
  manualHopperPaths(): Promise<readonly string[]>;
  providerInspections?(
    clients: readonly string[],
  ): Promise<readonly DoctorProviderInspection[]>;
  /** Select the provider-only view while retaining this host's other authority. */
  forProviderDiagnostics?(clients: readonly string[]): Promise<{
    readonly host: DoctorProviderProbeHost;
    readonly configuration: DoctorProviderConfiguration;
  }>;
  /** Resolve a parsed upstream request budget from the effective client environment. */
  resolveProviderRequestBudget?: ProviderRequestBudgetResolver;
  /** `rea` launchers in PATH order, each with the installation it resolves to. */
  installationLaunchers?(): Promise<readonly DoctorInstallationLauncher[]>;
  /** Undefined checks installed skill roots; explicit selections stay scoped. */
  installedSkillIdentity?(
    clientIds: readonly string[] | undefined,
  ): Promise<InstalledSkillIdentity | undefined>;
  close?(): Promise<string | undefined>;
  clientRegistrations?(
    selectedClientIds?: readonly string[],
    providerSettings?: Readonly<Record<string, string>>,
    ownedProviderSetting?: OwnedProviderSetting,
    observeProbeSetting?: (client: string, name: string, value: string) => void,
  ): Promise<readonly ClientRegistrationStatus[]>;
  ilspyCmdVersion?(path: string): Promise<string | undefined>;
  /** Desktop build host facts; read only when that scope is selected. */
  desktopBuildFacts?(clientIds: readonly string[]): Promise<DesktopBuildFacts>;
}

export type DoctorProviderProbeHost = Pick<
  DoctorHost,
  | "platform"
  | "homeDirectory"
  | "configuredHopperPath"
  | "nativeConfiguration"
  | "configuredIlspyCmdPath"
  | "executable"
  | "inspectLinuxHopper"
  | "linuxDemoRuntimeCheck"
  | "brewHopperPath"
  | "manualHopperPaths"
  | "providerInspections"
  | "ilspyCmdVersion"
>;

/** Effective settings of the path-based checks. */
export type StaticDoctorProviderSettings = Readonly<
  Partial<
    Record<"HOPPER_LAUNCHER_PATH" | "REA_ILSPY_CMD_PATH", DoctorProviderSetting>
  >
>;

/** Structured result returned by the read-only doctor workflow. */
export interface DoctorReport {
  readonly healthy: boolean;
  readonly environment_healthy: boolean;
  readonly scope: DoctorScopeReport;
  readonly scope_checks: readonly DoctorCheck[];
  readonly informational_checks: readonly DoctorCheck[];
  readonly hopperPath?: string;
  readonly staticProviderSettings?: StaticDoctorProviderSettings;
  readonly providerInspections?: readonly DoctorProviderInspection[];
  readonly checks: readonly DoctorCheck[];
  readonly identity?: DoctorIdentity;
}

/** Caller-selected readiness boundary; omitted values retain audit semantics. */
export interface DoctorScope {
  readonly clients?: readonly string[];
  /**
   * Clients verified through a plugin manager rather than MCP registration
   * files. They still exercise MCP startup admission.
   */
  readonly pluginClients?: readonly string[];
  readonly skillClients?: readonly string[];
  readonly providers?: readonly string[];
  readonly skill?: boolean;
}

/** Installed-package, skill, client, and runtime identity observations. */
export type DoctorSkillState =
  | "aligned"
  | "stale"
  | "missing"
  | "unmanaged"
  | "unknown";

interface DoctorIdentity {
  readonly cli_package_version: string;
  readonly expected_skill_version: string;
  readonly sdk: typeof SDK_IDENTITY;
  /** Package default advertisement; the active server reports its selected profile. */
  readonly catalog: CatalogIdentitySnapshot;
  readonly live_server: {
    readonly state: "unknown";
    readonly remediation: string;
  };
  readonly installations: {
    readonly paths: readonly string[];
    readonly state: "single" | "multiple" | "unknown";
  };
  readonly skill: {
    readonly installed_version: string | null;
    readonly installed_tool_count: number | null;
    readonly state: DoctorSkillState;
    readonly issues?: readonly SkillPathIssue[];
    readonly remediation: string | null;
  };
  readonly registrations: readonly ClientRegistrationStatus[];
}

/**
 * Check requirements and an optional target without mutating the host.
 * Every failed check includes remediation suitable for either the one-shot CLI
 * or an agent consuming the structured result.
 */
export const runDoctor = async (
  target?: string,
  selectedHost?: DoctorHost,
  requestedScope?: DoctorScope,
): Promise<DoctorReport> =>
  selectedHost === undefined
    ? runDoctorOwned(target, systemDoctorHost(), requestedScope)
    : inspectDoctor(target, selectedHost, requestedScope);

/** Inspect with a host whose lifetime belongs to this operation. */
export const runDoctorOwned = async (
  target: string | undefined,
  host: DoctorHost,
  requestedScope?: DoctorScope,
): Promise<DoctorReport> => {
  let report: DoctorReport;
  try {
    report = await inspectDoctor(target, host, requestedScope);
  } catch (cause: unknown) {
    const cleanup = await closeDoctorHost(host);
    if (cleanup !== undefined && cause instanceof AnalysisError) {
      const cleanupError =
        typeof cleanup === "string"
          ? new ProviderCleanupError(
              "rea",
              [],
              { reason: cleanup },
              { operation: "doctor" },
            )
          : cleanup;
      throw analysisErrorWithCleanupDependencies(cause, cleanupError, "doctor");
    }
    if (cleanup !== undefined)
      throw new AggregateError(
        [cause, typeof cleanup === "string" ? new Error(cleanup) : cleanup],
        "Doctor failed and its resource cleanup remains incomplete.",
        { cause },
      );
    throw cause;
  }
  const cleanup = await closeDoctorHost(host);
  if (cleanup === undefined && report.healthy && host.signal?.aborted)
    throw cancelledBy("doctor", host.signal, {
      diagnostics: { doctor_report: jsonValueSchema.parse(report) },
    });
  return cleanup === undefined
    ? report
    : doctorReportWithCleanup(report, cleanup);
};

const inspectDoctor = async (
  target: string | undefined,
  host: DoctorHost,
  requestedScope?: DoctorScope,
): Promise<DoctorReport> => {
  if (host.signal?.aborted) throw cancelledBy("doctor", host.signal);
  const scope = normalizeDoctorScope(requestedScope, target);
  const {
    checks: diagnosticChecks,
    hopperPath,
    configuredHopperPath,
    staticProviderSettings,
    providerInspections,
  } = await collectDoctorDiagnostics(target, host, scope.clients);
  const hopperAvailable =
    hopperPath !== undefined &&
    diagnosticChecks
      .filter(({ name }) => name.startsWith("hopper"))
      .every(({ ok }) => ok);
  const selections = providerSettingSelections(
    providerInspections,
    hopperAvailable &&
      hopperPath === configuredHopperPath &&
      staticProviderSettings?.HOPPER_LAUNCHER_PATH?.source !== "config"
      ? hopperPath
      : undefined,
  );
  const identity = await collectDoctorIdentity(host, scope, selections);
  const checks = [
    ...diagnosticChecks,
    ...identity.checks,
    ...registrationAdvisoryChecks(identity.value.registrations),
    ...registrationEnvironmentChecks(identity.value.registrations, selections),
    ...(await selectedDesktopBuildChecks(host, scope, identity.value.skill)),
  ];
  const providers = {
    hopperAvailable,
    hopperConfigured: configuredHopperPath !== undefined,
    providerInspections,
  };
  const environmentHealthy = doctorHealthy(checks, providers);
  const scoped = scopeDoctorChecks({
    checks,
    registrations: identity.value.registrations,
    skillState: identity.value.skill.state,
    providers,
    scope,
  });
  return {
    healthy: scope.mode === "audit-wide" ? environmentHealthy : scoped.healthy,
    environment_healthy: environmentHealthy,
    scope,
    scope_checks: scope.mode === "audit-wide" ? checks : scoped.scopeChecks,
    informational_checks:
      scope.mode === "audit-wide" ? [] : scoped.informationalChecks,
    ...(hopperPath === undefined ? {} : { hopperPath }),
    ...(staticProviderSettings === undefined ? {} : { staticProviderSettings }),
    ...(providerInspections === undefined ? {} : { providerInspections }),
    checks,
    identity: identity.value,
  };
};

const registrationAdvisoryChecks = (
  registrations: readonly ClientRegistrationStatus[],
): readonly DoctorCheck[] =>
  registrations.flatMap(({ client, advisory }) =>
    advisory === undefined
      ? []
      : [
          {
            name: `registration_timeout:${client}`,
            ok: true,
            classification: "healthy" as const,
            detail: advisory,
          },
        ],
  );

/** Settings an available provider's checks in this report relied on. */
interface ProviderSettingSelection {
  readonly provider: string;
  readonly settings: Readonly<Record<string, string>>;
}

const providerSettingSelections = (
  inspections: readonly DoctorProviderInspection[] | undefined,
  configuredHopperPath: string | undefined,
): readonly ProviderSettingSelection[] => [
  ...(inspections ?? [])
    .filter(({ available }) => available)
    .map((inspection) => ({
      provider: inspection.id,
      settings: Object.fromEntries(
        copyableProviderRegistrationSettings(inspection),
      ),
    })),
  // Startup probes the fixed and renamed locations on its own, so only an
  // explicit path is something this terminal selected for the server.
  ...(configuredHopperPath === undefined
    ? []
    : [
        {
          provider: "hopper",
          settings: { HOPPER_LAUNCHER_PATH: configuredHopperPath },
        },
      ]),
];

/** Render what the registration comparison established without inferring its effective environment. */
const registrationEnvironmentDetail = (
  client: string,
  {
    unrecorded,
    differing,
    unresolved,
  }: NonNullable<ClientRegistrationStatus["provider_settings"]>,
): string =>
  [
    `Provider checks used this terminal's environment; what the server ${client} starts receives is unknown.`,
    ...(unrecorded.length === 0
      ? []
      : [`Its registration does not record ${unrecorded.join(", ")}.`]),
    ...(differing.length === 0
      ? []
      : [`It records other values for ${differing.join(", ")}.`]),
    ...(unresolved.length === 0
      ? []
      : [`REA could not resolve its ${unresolved.join(", ")}.`]),
  ].join(" ");

/**
 * Report what the registration's file leaves out without gating health:
 * doctor cannot observe the environment the client actually passes on.
 */
const registrationEnvironmentChecks = (
  registrations: readonly ClientRegistrationStatus[],
  selections: readonly ProviderSettingSelection[],
): readonly DoctorCheck[] =>
  registrations.flatMap(({ client, provider_settings: settings }) => {
    if (settings === undefined) return [];
    const { unrecorded, differing, unresolved } = settings;
    const names = [...unrecorded, ...differing, ...unresolved];
    return [
      {
        name: `registration_environment:${client}`,
        ok: true,
        classification: "unknown" as const,
        detail: registrationEnvironmentDetail(client, settings),
        details: {
          effective_environment: "unknown",
          providers: selections
            .filter(({ settings: selected }) =>
              names.some((name) => selected[name] !== undefined),
            )
            .map(({ provider }) => provider),
        },
        remediation: `Preview rea setup --client ${client} --skill=false --dry-run from this terminal, apply it to record these settings and restart the client, or read binary_session result.tool_availability in the client.`,
      },
    ];
  });

const closeDoctorHost = async (
  host: DoctorHost,
): Promise<string | AnalysisError | undefined> => {
  try {
    return await host.close?.();
  } catch (cause: unknown) {
    if (cause instanceof AnalysisError) return cause;
    return `Doctor host cleanup failed: ${errorMessage(cause)}`;
  }
};

const doctorReportWithCleanup = (
  report: DoctorReport,
  cleanup: string | AnalysisError,
): DoctorReport => {
  const check: DoctorCheck = {
    name: "doctor-resource-cleanup",
    ok: false,
    classification: "config_drift",
    detail:
      typeof cleanup === "string"
        ? cleanup
        : `${cleanup.message} ${cleanup.cleanupResources.join(", ")}`,
    ...(typeof cleanup === "string"
      ? {}
      : { details: { cleanup_failure: projectAnalysisError(cleanup) } }),
    remediation: "Resolve the reported cleanup failure, then rerun rea doctor.",
  };
  return {
    ...report,
    healthy: false,
    environment_healthy: false,
    checks: [...report.checks, check],
    scope_checks: [...report.scope_checks, check],
  };
};

const collectDoctorIdentity = async (
  host: DoctorHost,
  scope: DoctorScopeReport,
  selections: readonly ProviderSettingSelection[],
): Promise<{
  readonly checks: readonly DoctorCheck[];
  readonly value: DoctorIdentity;
}> => {
  const skillClientIds =
    scope.skill_clients ??
    (scope.clients.length > 0 ? scope.clients : undefined);
  const [
    resolvedLaunchers,
    resolvedRegistrations,
    installedSkillIdentity,
    defaultCatalogIdentity,
  ] = await settleConcurrent([
    Promise.resolve(host.installationLaunchers?.()),
    Promise.resolve(
      host.clientRegistrations?.(
        scope.clients,
        Object.fromEntries(
          selections.flatMap(({ settings }) => Object.entries(settings)),
        ),
      ),
    ),
    Promise.resolve(host.installedSkillIdentity?.(skillClientIds)),
    loadDefaultCatalogIdentity(),
  ]);
  const launchers = resolvedLaunchers ?? [];
  const registrations = resolvedRegistrations ?? [];
  const skillAligned = skillIdentityAligned(
    installedSkillIdentity,
    defaultCatalogIdentity.counts.mcp_tools,
  );
  return {
    checks: [
      ...(skillAligned
        ? []
        : [
            skillIdentityCheck(
              installedSkillIdentity,
              defaultCatalogIdentity.counts.mcp_tools,
            ),
          ]),
      ...registrations
        .filter(
          (registration): registration is UnhealthyClientRegistrationStatus =>
            registration.state !== "aligned" && registration.state !== "manual",
        )
        .map(registrationCheck),
    ],
    value: {
      cli_package_version: PRODUCT_IDENTITY.packageVersion,
      expected_skill_version: PRODUCT_IDENTITY.skillVersion,
      sdk: SDK_IDENTITY,
      catalog: {
        counts: defaultCatalogIdentity.counts,
        digests: defaultCatalogIdentity.digests,
      },
      live_server: {
        state: "unknown",
        // `binary_session` is advertised only when the saved scope includes
        // `session`, so the remediation also names the scope requirement: doctor
        // cannot see the saved selection here, and one sentence has to fit both
        // a complete registration and a scope that omits the session family.
        remediation:
          "Call binary_session in the active client to inspect the running server identity; a registration whose saved scope omits the session family cannot report it, so include session through rea setup --tool-families and restart first.",
      },
      installations: {
        paths: launchers.map(({ path }) => path),
        state: installationState(launchers),
      },
      skill: {
        installed_version: installedSkillIdentity?.version ?? null,
        installed_tool_count: installedSkillIdentity?.toolCount ?? null,
        state: skillIdentityState(
          installedSkillIdentity,
          defaultCatalogIdentity.counts.mcp_tools,
        ),
        ...(installedSkillIdentity?.issues === undefined
          ? {}
          : { issues: installedSkillIdentity.issues }),
        remediation: skillAligned
          ? null
          : skillIdentityRemediation(installedSkillIdentity),
      },
      registrations,
    },
  };
};

const skillIdentityAligned = (
  identity: InstalledSkillIdentity | undefined,
  expectedToolCount: number,
): boolean =>
  identity?.version === PRODUCT_IDENTITY.skillVersion &&
  identity.toolCount === expectedToolCount &&
  identity.canonical;

const skillIdentityState = (
  identity: InstalledSkillIdentity | undefined,
  expectedToolCount: number,
): DoctorSkillState => {
  if (
    identity?.issues?.some(
      ({ kind }) => kind === "unreadable" || kind === "unresolved",
    )
  )
    return "unknown";
  if (
    identity?.issues?.some(
      ({ kind }) => kind === "symbolic_link" || kind === "not_directory",
    )
  )
    return "unmanaged";
  if (identity?.issues?.some(({ kind }) => kind === "stale")) return "stale";
  if (identity?.issues?.some(({ kind }) => kind === "missing"))
    return "missing";
  return identity === undefined
    ? "missing"
    : skillIdentityAligned(identity, expectedToolCount)
      ? "aligned"
      : "stale";
};

const skillIdentityRemediation = (
  identity: InstalledSkillIdentity | undefined,
): string => {
  const issues = identity?.issues;
  if (issues !== undefined && issues.length > 0)
    return issues
      .map(({ path, detail, kind, client }) => {
        const repair =
          kind === "stale" || kind === "missing"
            ? `Run rea setup --skill-client ${client ?? "shared"} --skill to repair this copy.`
            : "Repair the selected path/profile before rerunning setup, or use --skill=false to configure clients without installing the skill.";
        return `${detail} (${path}). ${repair}`;
      })
      .join(" ");
  return "Run rea setup to update the installed REA skill.";
};

const skillIdentityCheck = (
  identity: InstalledSkillIdentity | undefined,
  expectedToolCount: number,
): DoctorCheck => {
  const issues = identity?.issues;
  const state = skillIdentityState(identity, expectedToolCount);
  return {
    name: "skill:identity",
    ok: false,
    // An unreadable or unresolved copy is unknown, not proven drift.
    classification: state === "unknown" ? "unknown" : "config_drift",
    detail:
      issues !== undefined && issues.length > 0
        ? `Selected skill identity is ${state}: ${issues.map(({ path }) => path).join(", ")}.`
        : identity === undefined
          ? "Installed REA skill identity is missing."
          : "Installed REA skill identity is stale.",
    remediation: skillIdentityRemediation(identity),
  };
};

const registrationCheck = (
  registration: UnhealthyClientRegistrationStatus,
): DoctorCheck => ({
  name: `registration:${registration.client}`,
  ok: false,
  classification: registration.state === "unknown" ? "unknown" : "config_drift",
  detail: registration.config_path,
  ...(registration.scope === undefined
    ? {}
    : { details: { scope: registration.scope } }),
  remediation: registration.remediation,
});

/** A PATH launcher and the installation identity its host resolved it to. */
export interface DoctorInstallationLauncher {
  readonly path: string;
  readonly installation: string;
}

const installationState = (
  launchers: readonly DoctorInstallationLauncher[],
): DoctorIdentity["installations"]["state"] => {
  const installations = new Set(
    launchers.map(({ installation }) => installation),
  );
  return installations.size === 0
    ? "unknown"
    : installations.size === 1
      ? "single"
      : "multiple";
};

/**
 * One installation is one launcher directory after symlink resolution. npm
 * writes `rea`, `rea.cmd` and `rea.ps1` side by side on Windows, where `where`
 * lists each and directory spelling is case-insensitive; PATH can also reach
 * one launcher through a symlinked directory. An unresolvable launcher keeps
 * its listed path rather than joining another installation.
 */
const launcherInstallation = async (
  path: string,
  platform: NodeJS.Platform,
): Promise<string> => {
  const resolved = await realpath(path).catch(() => path);
  return platform === "win32"
    ? win32.dirname(resolved).toLowerCase()
    : posix.dirname(resolved);
};

/**
 * A provider request budget resolver with its retained resource scope and
 * cancellation signal, as an outer adapter supplies it. The declared read
 * set travels with it into the 2-parameter registration derivation.
 */
export interface RetainedProviderRequestBudgetResolver {
  (
    provider: Parameters<ProviderRequestBudgetResolver>[0],
    environment: Parameters<ProviderRequestBudgetResolver>[1],
    resources: RetainedResourceScope,
    signal: AbortSignal,
  ): ReturnType<ProviderRequestBudgetResolver>;
  /** Environment settings this resolver may read; see the base contract. */
  readonly budgetSettings?: ProviderRequestBudgetResolver["budgetSettings"];
}

/** Optional outer-adapter diagnostics composed without reversing dependencies. */
export interface SystemDoctorHostOptions {
  readonly savedDefaults?: ReadonlySet<string> | undefined;
  readonly signal?: AbortSignal;
  readonly platform?: NodeJS.Platform;
  readonly registrationScope?: "user" | "all";
  readonly architecture?: NodeJS.Architecture;
  readonly environment?: NodeJS.ProcessEnv;
  readonly execFileOutput?: typeof execFileOutput;
  readonly selectProviderConfiguration?: (
    resourceScope: RetainedResourceScope,
    signal: AbortSignal,
    clients: readonly string[],
  ) => Promise<DoctorProviderConfiguration>;
  readonly providerInspections?: (
    resourceScope: RetainedResourceScope,
    signal: AbortSignal,
    clients: readonly string[],
    configuration: DoctorProviderConfiguration,
  ) => Promise<readonly DoctorProviderInspection[]>;
  readonly resolveProviderRequestBudget?: RetainedProviderRequestBudgetResolver;
  readonly linuxDemoRuntimeCheck?: (
    resourceScope: RetainedResourceScope,
    signal: AbortSignal,
    environment: Readonly<NodeJS.ProcessEnv>,
  ) => Promise<DoctorCheck>;
  readonly desktopBuildFacts?: (
    input: DesktopBuildFactsInput,
  ) => Promise<DesktopBuildFacts>;
}

const runInChildResourceScope = <T>(
  parent: ArtifactResourceScope,
  label: string,
  operation: (child: ArtifactResourceScope) => Promise<T>,
): Promise<T> =>
  parent.track(async () => {
    const child = new ArtifactResourceScope();
    try {
      return await operation(child);
    } finally {
      if (child.hasPending) {
        parent.retain({
          kind: "lease",
          resource: label,
          lease: AnalysisCleanupLease.forCloseOwner(child, label),
        });
      } else {
        await child.close();
      }
    }
  });

/** Create diagnostics backed by the current process and host commands. */
export const systemDoctorHost = (
  options: SystemDoctorHostOptions = {},
): DoctorHost => {
  const resources = new ArtifactResourceScope();
  const controller = new AbortController();
  const inspectionSignal =
    options.signal === undefined
      ? controller.signal
      : AbortSignal.any([options.signal, controller.signal]);
  const platform = options.platform ?? HOST_PLATFORM.platform;
  const architecture = options.architecture ?? HOST_PLATFORM.architecture;
  const environment = options.environment ?? process.env;

  const execute = options.execFileOutput ?? execFileOutput;
  // These commands report short host facts, not analysis output. Reuse the
  // ILSpy probe's ten-second allowance and bound each captured stream to 64 KiB.
  // Baseline diagnostics must work without provider ownership prerequisites.
  const hostExecFileOutput: typeof execFileOutput = (command, args, input) =>
    resources.track(async () => {
      try {
        const output = await execute(command, args, {
          ...input,
          timeout: 10_000,
          maxBuffer: 64 * 1024,
          stopSignal: "SIGTERM",
          signal: inspectionSignal,
        });
        if (inspectionSignal.aborted)
          throw cancelledBy("doctor", inspectionSignal, {
            capturedOutput: {
              stdout: output.stdout,
              stderr: output.stderr,
              stdout_bytes: output.stdoutBytes,
              stderr_bytes: output.stderrBytes,
              exit_code: 0,
              signal: null,
              truncated: false,
            },
          });
        return output;
      } catch (cause: unknown) {
        if (cause instanceof ExecFileOutputCancelledError) {
          const output = execFileOutputFailure(cause);
          throw cancelledBy(
            "doctor",
            carriedReason(cause.cause),
            output === undefined
              ? {}
              : { capturedOutput: execFileFailureCapturedOutput(output) },
          );
        }
        throw cause;
      }
    });
  const homeDirectory = homeDirectoryFromEnvironment(environment, platform);
  const commandEnvironment = { env: environment };
  const resourceScope: RetainedResourceScope = {
    retain: (owner, resource) =>
      resources.retain({
        kind: "lease",
        resource,
        lease: AnalysisCleanupLease.forCloseOwner(owner, resource),
      }),
    run: (operation) => resources.track(operation),
  };
  const resolveProviderRequestBudget =
    options.resolveProviderRequestBudget === undefined
      ? undefined
      : Object.assign(
          (
            provider: Parameters<ProviderRequestBudgetResolver>[0],
            environment: Parameters<ProviderRequestBudgetResolver>[1],
          ) =>
            options.resolveProviderRequestBudget!(
              provider,
              environment,
              resourceScope,
              inspectionSignal,
            ),
          // Carry the declared read set through the 2-parameter adaptation,
          // so the budget gate stays fail-closed only for settings this
          // resolver may actually read.
          options.resolveProviderRequestBudget.budgetSettings === undefined
            ? {}
            : {
                budgetSettings:
                  options.resolveProviderRequestBudget.budgetSettings,
              },
        );
  const terminalConfiguration: DoctorProviderConfiguration = {
    environment,
    savedDefaults: options.savedDefaults,
  };
  const selectConfiguration = (clients: readonly string[]) =>
    options.selectProviderConfiguration?.(
      resourceScope,
      inspectionSignal,
      clients,
    ) ?? Promise.resolve(terminalConfiguration);
  const inspectProviders = (
    clients: readonly string[],
    configuration: DoctorProviderConfiguration,
  ) =>
    options.providerInspections!(
      resourceScope,
      inspectionSignal,
      clients,
      configuration,
    );

  const providerProbeHost = (
    probeEnvironment: Readonly<NodeJS.ProcessEnv>,
  ): DoctorProviderProbeHost => {
    const probeHome =
      probeEnvironment === environment
        ? homeDirectory
        : homeDirectoryFromEnvironment(probeEnvironment, platform);
    const probeCommandEnvironment = { env: probeEnvironment };
    return {
      platform,
      homeDirectory: probeHome,
      ...(probeEnvironment.HOPPER_LAUNCHER_PATH === undefined
        ? {}
        : { configuredHopperPath: probeEnvironment.HOPPER_LAUNCHER_PATH }),
      nativeConfiguration: inspectNativeAnalysisConfiguration(
        snapshotEnvironment(probeEnvironment, platform),
      ),
      ...(probeEnvironment.REA_ILSPY_CMD_PATH === undefined
        ? {}
        : { configuredIlspyCmdPath: probeEnvironment.REA_ILSPY_CMD_PATH }),
      executable: (path) =>
        executableAvailable(
          path,
          platform,
          hostExecFileOutput,
          probeCommandEnvironment,
        ),
      linuxDemoRuntimeCheck: () =>
        options.linuxDemoRuntimeCheck === undefined
          ? uncomposedLinuxDemoRuntimeCheck()
          : options.linuxDemoRuntimeCheck(
              resourceScope,
              inspectionSignal,
              probeEnvironment,
            ),
      inspectLinuxHopper: (path) =>
        inspectLinuxHopperLauncher(path, probeEnvironment),
      async brewHopperPath() {
        return probeHomebrew(async (command) => {
          let caskroom: string;
          try {
            // Without a cask argument, `--caskroom` does not load Homebrew's
            // cask API, so doctor writes no Homebrew cache files.
            caskroom = (
              await hostExecFileOutput(
                command,
                ["--caskroom"],
                probeCommandEnvironment,
              )
            ).stdout.trim();
          } catch (cause: unknown) {
            if (cause instanceof AnalysisCancelledError) throw cause;
            // best-effort cleanup: optional Homebrew probing; absence means uninstalled.
            void cause;
            return undefined;
          }
          const appdir = await installedCaskAppdir(
            caskroom,
            "hopper-disassembler",
            probeHome,
          );
          return appdir === undefined
            ? undefined
            : appendCallerPath(
                appdir,
                "Hopper Disassembler.app/Contents/MacOS/hopper",
              );
        });
      },
      manualHopperPaths: () =>
        readMacHopperRenamedLauncherCandidates(probeHome),
      async ilspyCmdVersion(path) {
        try {
          await access(path, constants.X_OK);
          return firstIlspyVersionLine(
            (
              await hostExecFileOutput(
                path,
                ["--version"],
                probeCommandEnvironment,
              )
            ).stdout,
          );
        } catch (cause: unknown) {
          if (cause instanceof AnalysisCancelledError) throw cause;
          // best-effort cleanup: optional version probing; failure means unavailable.
          void cause;
          return undefined;
        }
      },
    };
  };
  const terminalProbeHost = providerProbeHost(environment);
  const host: DoctorHost = {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...terminalProbeHost,
    architecture,
    runtime: javaScriptRuntime(process.versions),
    macosVersion: () =>
      readMacosVersion(hostExecFileOutput, commandEnvironment),
    linuxDistribution: () => readLinuxDistribution(architecture),
    async inspectTarget(path) {
      const { parseBinaryTarget } = await import("./BinaryTargetResolver.js");
      const result = await parseBinaryTarget(path, {
        cwd: process.cwd(),
        hostArchitecture: architecture,
      });
      if (result.ok)
        return {
          name: "target",
          ok: true,
          classification: "healthy",
          detail: path,
        };
      const error = result.error;
      const targetError =
        error instanceof BinaryTargetError ? error : undefined;
      return {
        name: "target",
        ok: false,
        classification:
          targetError?.constraint !== undefined
            ? "unsupported_target"
            : "config_drift",
        detail: path,
        details: {
          reason: targetError?.reason ?? error.message,
          ...(targetError?.constraint === undefined
            ? {}
            : { constraint: targetError.constraint }),
        },
        remediation: analysisErrorRemediationAction(error),
      };
    },
    ...(options.providerInspections === undefined
      ? {}
      : {
          providerInspections: (clients) =>
            resources.track(async () =>
              inspectProviders(clients, await selectConfiguration(clients)),
            ),
        }),
    ...(options.selectProviderConfiguration === undefined
      ? {}
      : {
          forProviderDiagnostics: (clients) =>
            resources.track(async () => {
              const configuration = await selectConfiguration(clients);
              return {
                configuration,
                host: {
                  ...(configuration.environment === environment
                    ? terminalProbeHost
                    : providerProbeHost(configuration.environment)),
                  ...(options.providerInspections === undefined
                    ? {}
                    : {
                        providerInspections: () =>
                          resources.track(() =>
                            inspectProviders(clients, configuration),
                          ),
                      }),
                },
              };
            }),
        }),
    ...(resolveProviderRequestBudget === undefined
      ? {}
      : { resolveProviderRequestBudget }),
    async installationLaunchers() {
      try {
        const command = platform === "win32" ? "where" : "which";
        const arguments_ = platform === "win32" ? ["rea"] : ["-a", "rea"];
        const paths = uniqueLines(
          (await hostExecFileOutput(command, arguments_, commandEnvironment))
            .stdout,
        );
        return await Promise.all(
          paths.map(async (path) => ({
            path,
            installation: await launcherInstallation(path, platform),
          })),
        );
      } catch (cause: unknown) {
        if (cause instanceof AnalysisCancelledError) throw cause;
        // best-effort cleanup: optional path probing; failure means none found.
        void cause;
        return [];
      }
    },
    installedSkillIdentity: (clientIds) =>
      runInChildResourceScope(resources, "skill-identity", (child) =>
        readInstalledSkillIdentity(
          homeDirectory,
          clientIds,
          environment,
          platform,
          child,
        ),
      ),
    close: async () => {
      controller.abort(OwnerCancellation.startupOwnerClosed);
      try {
        await resources.close();
        return undefined;
      } catch (cause: unknown) {
        const observation = ArtifactReaderFailure.cleanupObservation(
          cause,
          "doctor resources",
        );
        const failure = new ProviderCleanupError(
          "rea",
          observation.resources,
          { reason: observation.reason },
          { cause, operation: "doctor" },
        );
        bindArtifactFileCleanup(cause, failure);
        throw failure;
      }
    },
    clientRegistrations: (
      selectedClientIds,
      providerSettings,
      ownedProviderSetting,
      observeProbeSetting,
    ) =>
      runInChildResourceScope(resources, "client-registrations", (child) =>
        readClientRegistrationStatuses(homeDirectory, undefined, {
          platform,
          environment,
          resources: child,
          ...(options.registrationScope === undefined
            ? {}
            : { scope: options.registrationScope }),
          ...(selectedClientIds === undefined ? {} : { selectedClientIds }),
          ...(ownedProviderSetting === undefined
            ? {}
            : { ownedProviderSetting }),
          ...(observeProbeSetting === undefined ? {} : { observeProbeSetting }),
          ...(providerSettings === undefined
            ? {}
            : {
                providerSettings: registrationSpelledSettings(
                  omitEnvironmentSettings(
                    providerSettings,
                    options.savedDefaults,
                  ),
                  environment,
                ),
              }),
          ...(resolveProviderRequestBudget === undefined
            ? {}
            : {
                resolveProviderRequestBudget,
              }),
        }),
      ),
  };
  const readFacts = options.desktopBuildFacts;
  return readFacts === undefined
    ? host
    : {
        ...host,
        desktopBuildFacts: (clientIds) =>
          runInChildResourceScope(resources, "desktop-build-facts", (child) =>
            readFacts({
              environment,
              platform,
              signal: inspectionSignal,
              resources: child,
              run: hostExecFileOutput,
              clientIds,
              registrations: host.clientRegistrations!,
            }),
          ),
      };
};

const readMacosVersion = async (
  run: typeof execFileOutput,
  options: { readonly env: NodeJS.ProcessEnv },
): Promise<string | undefined> => {
  try {
    return (
      await run("/usr/bin/sw_vers", ["-productVersion"], options)
    ).stdout.trim();
  } catch (cause: unknown) {
    if (cause instanceof AnalysisCancelledError) throw cause;
    // best-effort cleanup: optional OS version probing; failure means unknown.
    void cause;
    return undefined;
  }
};

const executableAvailable = async (
  path: string,
  platform: NodeJS.Platform,
  run: typeof execFileOutput,
  options: { readonly env: NodeJS.ProcessEnv },
): Promise<boolean> => {
  try {
    await access(path, constants.X_OK);
    if (!(await stat(path)).isFile()) return false;
    if (platform !== "linux") return true;
    const linked = await run("ldd", [path], options);
    return linuxSharedLibrariesAvailable(`${linked.stdout}\n${linked.stderr}`);
  } catch (cause: unknown) {
    if (cause instanceof AnalysisCancelledError) throw cause;
    // best-effort cleanup: optional executable probing; failure means unavailable.
    void cause;
    return false;
  }
};

const uncomposedLinuxDemoRuntimeCheck = (): Promise<DoctorCheck> =>
  Promise.resolve({
    name: "hopper-demo-runtime",
    ok: false,
    classification: "config_drift",
    detail: "Linux Hopper private-display diagnostics were not composed",
    remediation: "Run rea doctor through the production CLI adapter.",
  });

const uniqueLines = (value: string): string[] => [
  ...new Set(
    value
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  ),
];

const firstIlspyVersionLine = (value: string): string | undefined =>
  uniqueLines(value).find((line) => line.startsWith("ilspycmd:"));
