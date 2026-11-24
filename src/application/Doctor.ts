import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { bindArtifactFileCleanup } from "../artifacts/ArtifactFileOperation.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";
import { STARTUP_OWNER_CLOSED } from "../process/SharedStartupAttempt.js";
import { constants } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import type { FileCloseResourceOwner } from "./AnalysisProvider.js";
import { homeDirectoryFromEnvironment } from "../config/homeDirectory.js";
import { join } from "node:path";

import { analysisErrorRemediationAction } from "../domain/analysisErrorPresentation.js";
import { BinaryTargetError } from "../domain/configurationErrors.js";
import { parseBinaryTarget } from "./BinaryTargetResolver.js";
import { execFileOutput } from "../process/ExecFileOutput.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import {
  javaScriptRuntime,
  type JavaScriptRuntime,
} from "../domain/runtimeVersion.js";
import { installedCaskAppdir, probeHomebrew } from "./homebrew.js";
import {
  macHopperApplicationRoots,
  macHopperRenamedLauncherCandidates,
} from "./MacHopperPaths.js";
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
import { CATALOG_IDENTITY } from "../catalogIdentity.js";
import { PRODUCT_IDENTITY, SDK_IDENTITY } from "../identity.js";
import {
  readClientRegistrationStatuses,
  type ClientRegistrationStatus,
  type UnhealthyClientRegistrationStatus,
} from "./ClientRegistrationStatus.js";
import type { ProviderRequestBudgetResolver } from "./ClientRegistrationEnvironment.js";
import {
  collectDoctorDiagnostics,
  doctorHealthy,
} from "./DoctorDiagnostics.js";
import {
  normalizeDoctorScope,
  scopeDoctorChecks,
  type DoctorScopeReport,
} from "./DoctorScope.js";

/** One actionable environment diagnostic. */
export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly classification:
    | "healthy"
    | "missing_dependency"
    | "runtime_failure"
    | "unsupported_host"
    | "unsupported_target"
    | "missing_analysis_engine"
    | "unknown"
    | "config_drift";
  readonly detail?: string;
  readonly details?: Readonly<Record<string, JsonValue>>;
  readonly remediation?: string;
}

/** One provider-owned check projected without importing its adapter types. */
export interface DoctorProviderCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly code: string | null;
  readonly detail: string;
  readonly remediation: string | null;
  readonly classification: Exclude<DoctorCheck["classification"], "healthy">;
  readonly details?: Readonly<Record<string, JsonValue>>;
}

/** Read-only provider inspection supplied by an outer composition adapter. */
export interface DoctorProviderInspection {
  readonly id: string;
  readonly configured: boolean;
  readonly available: boolean;
  readonly providerVersion: string | null;
  /** Adapter-validated non-secret settings, independent of runtime readiness.
   * Invalid installations publish no settings. */
  readonly registrationEnvironment: Readonly<Record<string, string>>;
  readonly checks: readonly DoctorProviderCheck[];
}
/** Read-only host capabilities required by diagnostics. */
export interface DoctorHost {
  readonly signal?: AbortSignal;
  readonly platform: NodeJS.Platform;
  readonly architecture: NodeJS.Architecture;
  readonly runtime: JavaScriptRuntime;
  readonly homeDirectory: string;
  readonly configuredHopperPath?: string;
  readonly configuredHopperStartupTimeout?: string;
  readonly configuredIlspyCmdPath?: string;
  macosVersion(): Promise<string | undefined>;
  linuxDistribution(): Promise<LinuxDistribution | undefined>;
  validTarget(path: string): Promise<boolean>;
  /** Route-specific target admission details, when supplied by the host. */
  inspectTarget?(path: string): Promise<DoctorCheck>;
  executable(path: string): Promise<boolean>;
  inspectLinuxHopper(
    path: string,
  ): Promise<Result<VerifiedLinuxHopperLauncher, HopperReleaseError>>;
  linuxDemoRuntimeCheck(): Promise<DoctorCheck>;
  brewHopperPath(): Promise<string | undefined>;
  manualHopperPaths(): Promise<readonly string[]>;
  providerInspections?(): Promise<readonly DoctorProviderInspection[]>;
  /** Resolve a parsed upstream request budget from the effective client environment. */
  resolveProviderRequestBudget?: ProviderRequestBudgetResolver;
  /** Validated provider settings preserved by setup, independent of readiness. */
  providerRegistrationEnvironment?(): Readonly<Record<string, string>>;
  installationPaths?(): Promise<readonly string[]>;
  /** Undefined checks installed skill roots; explicit selections stay scoped. */
  installedSkillIdentity?(
    clientIds: readonly string[] | undefined,
  ): Promise<InstalledSkillIdentity | undefined>;
  close?(): Promise<string | undefined>;
  clientRegistrations?(): Promise<readonly ClientRegistrationStatus[]>;
  ilspyCmdVersion?(path: string): Promise<string | undefined>;
}

/** Structured result returned by the read-only doctor workflow. */
export interface DoctorReport {
  readonly healthy: boolean;
  readonly environment_healthy: boolean;
  readonly scope: DoctorScopeReport;
  readonly scope_checks: readonly DoctorCheck[];
  readonly informational_checks: readonly DoctorCheck[];
  readonly hopperPath?: string;
  readonly providerInspections?: readonly DoctorProviderInspection[];
  readonly checks: readonly DoctorCheck[];
  readonly identity?: DoctorIdentity;
}

/** Caller-selected readiness boundary; omitted values retain audit semantics. */
export interface DoctorScope {
  readonly clients?: readonly string[];
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
  readonly catalog: typeof CATALOG_IDENTITY;
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
      throw analysisErrorWithCleanupFailure(
        cause,
        cleanupError,
        "doctor",
      ).bindCleanupDependencies([cause, cleanupError]);
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
    throw new AnalysisCancelledError("doctor", {
      cause: host.signal.reason,
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
  if (host.signal?.aborted)
    throw new AnalysisCancelledError("doctor", { cause: host.signal.reason });
  const scope = normalizeDoctorScope(requestedScope, target);
  const {
    checks: diagnosticChecks,
    hopperPath,
    providerInspections,
  } = await collectDoctorDiagnostics(target, host);
  const identity = await collectDoctorIdentity(host, scope);
  const checks = [
    ...diagnosticChecks,
    ...identity.checks,
    ...registrationAdvisoryChecks(identity.value.registrations),
  ];
  const providers = {
    hopperAvailable:
      hopperPath !== undefined &&
      checks
        .filter(({ name }) => name.startsWith("hopper"))
        .every(({ ok }) => ok),
    hopperConfigured: host.configuredHopperPath !== undefined,
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

const closeDoctorHost = async (
  host: DoctorHost,
): Promise<string | AnalysisError | undefined> => {
  try {
    return await host.close?.();
  } catch (cause: unknown) {
    if (cause instanceof AnalysisError) return cause;
    return `Doctor host cleanup failed: ${cause instanceof Error ? cause.message : String(cause)}`;
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
): Promise<{
  readonly checks: readonly DoctorCheck[];
  readonly value: DoctorIdentity;
}> => {
  const installationPaths = (await host.installationPaths?.()) ?? [];
  const registrations = (await host.clientRegistrations?.()) ?? [];
  const skillClientIds =
    scope.skill_clients ??
    (scope.clients.length > 0 ? scope.clients : undefined);
  const installedSkillIdentity =
    await host.installedSkillIdentity?.(skillClientIds);
  const skillAligned = skillIdentityAligned(installedSkillIdentity);
  return {
    checks: [
      ...(skillAligned ? [] : [skillIdentityCheck(installedSkillIdentity)]),
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
        counts: CATALOG_IDENTITY.counts,
        digests: CATALOG_IDENTITY.digests,
      },
      live_server: {
        state: "unknown",
        remediation:
          "Call binary_session in the active client to inspect the running server identity.",
      },
      installations: {
        paths: installationPaths,
        state: installationState(installationPaths),
      },
      skill: {
        installed_version: installedSkillIdentity?.version ?? null,
        installed_tool_count: installedSkillIdentity?.toolCount ?? null,
        state: skillIdentityState(installedSkillIdentity),
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
): boolean =>
  identity?.version === PRODUCT_IDENTITY.skillVersion &&
  identity.toolCount === CATALOG_IDENTITY.counts.mcp_tools &&
  identity.canonical;

const skillIdentityState = (
  identity: InstalledSkillIdentity | undefined,
): DoctorSkillState => {
  if (identity?.issues?.some(({ kind }) => kind === "unreadable"))
    return "unknown";
  if ((identity?.issues?.length ?? 0) > 0) return "unmanaged";
  return identity === undefined
    ? "missing"
    : skillIdentityAligned(identity)
      ? "aligned"
      : "stale";
};

const skillIdentityRemediation = (
  identity: InstalledSkillIdentity | undefined,
): string => {
  const issues = identity?.issues;
  if (issues !== undefined && issues.length > 0)
    return `${issues.map(({ path, detail }) => `${detail} (${path})`).join(" ")} Verify the reported paths and use regular skill directories, or run rea setup with --skill=false to configure the client without installing the skill.`;
  return "Run rea setup to update the installed REA skill.";
};

const skillIdentityCheck = (
  identity: InstalledSkillIdentity | undefined,
): DoctorCheck => {
  const issues = identity?.issues;
  return {
    name: "skill:identity",
    ok: false,
    classification: "config_drift",
    detail:
      issues !== undefined && issues.length > 0
        ? `Selected skill identity is ${skillIdentityState(identity)}: ${issues.map(({ path }) => path).join(", ")}.`
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
  remediation: registration.remediation,
});

const installationState = (
  paths: readonly string[],
): DoctorIdentity["installations"]["state"] =>
  paths.length === 0 ? "unknown" : paths.length === 1 ? "single" : "multiple";

/** Optional outer-adapter diagnostics composed without reversing dependencies. */
export interface SystemDoctorHostOptions {
  readonly signal?: AbortSignal;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: NodeJS.Architecture;
  readonly environment?: NodeJS.ProcessEnv;
  readonly execFileOutput?: typeof execFileOutput;
  readonly providerInspections?: (
    fileCloseResources: FileCloseResourceOwner,
    signal: AbortSignal,
  ) => Promise<readonly DoctorProviderInspection[]>;
  readonly providerRegistrationEnvironment?: () => Readonly<
    Record<string, string>
  >;
  readonly resolveProviderRequestBudget?: ProviderRequestBudgetResolver;
  readonly linuxDemoRuntimeCheck?: () => Promise<DoctorCheck>;
}

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
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const environment = options.environment ?? process.env;
  const hostExecFileOutput = options.execFileOutput ?? execFileOutput;
  const homeDirectory = homeDirectoryFromEnvironment(environment, platform);
  const commandEnvironment = { env: environment };
  const fileCloseResources: FileCloseResourceOwner = {
    retain: (owner, resource) =>
      resources.retain({
        kind: "lease",
        resource,
        lease: AnalysisCleanupLease.forCloseOwner(owner, resource),
      }),
    run: (operation) => resources.run(operation),
  };
  return {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    platform,
    architecture,
    runtime: javaScriptRuntime(process.versions),
    homeDirectory,
    ...(environment.HOPPER_LAUNCHER_PATH === undefined
      ? {}
      : { configuredHopperPath: environment.HOPPER_LAUNCHER_PATH }),
    ...(environment.REA_HOPPER_STARTUP_TIMEOUT_MS === undefined
      ? {}
      : {
          configuredHopperStartupTimeout:
            environment.REA_HOPPER_STARTUP_TIMEOUT_MS,
        }),
    ...(environment.REA_ILSPY_CMD_PATH === undefined
      ? {}
      : { configuredIlspyCmdPath: environment.REA_ILSPY_CMD_PATH }),
    macosVersion: () =>
      readMacosVersion(hostExecFileOutput, commandEnvironment),
    linuxDistribution: readLinuxDistribution,
    async validTarget(path) {
      return (
        await parseBinaryTarget(path, {
          cwd: process.cwd(),
          hostArchitecture: architecture,
        })
      ).ok;
    },
    async inspectTarget(path) {
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
    executable: (path) =>
      executableAvailable(
        path,
        platform,
        hostExecFileOutput,
        commandEnvironment,
      ),
    linuxDemoRuntimeCheck:
      options.linuxDemoRuntimeCheck ?? uncomposedLinuxDemoRuntimeCheck,
    inspectLinuxHopper: (path) => inspectLinuxHopperLauncher(path, environment),
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
              commandEnvironment,
            )
          ).stdout.trim();
        } catch (cause: unknown) {
          // best-effort cleanup: optional Homebrew probing; absence means uninstalled.
          void cause;
          return undefined;
        }
        const appdir = await installedCaskAppdir(
          caskroom,
          "hopper-disassembler",
          homeDirectory,
        );
        return appdir === undefined
          ? undefined
          : join(appdir, "Hopper Disassembler.app/Contents/MacOS/hopper");
      });
    },
    manualHopperPaths: () => manualHopperPaths(homeDirectory),
    ...(options.providerInspections === undefined
      ? {}
      : {
          providerInspections: () =>
            resources.run(() =>
              options.providerInspections!(
                fileCloseResources,
                inspectionSignal,
              ),
            ),
        }),
    ...(options.providerRegistrationEnvironment === undefined
      ? {}
      : {
          providerRegistrationEnvironment:
            options.providerRegistrationEnvironment,
        }),
    ...(options.resolveProviderRequestBudget === undefined
      ? {}
      : { resolveProviderRequestBudget: options.resolveProviderRequestBudget }),
    async ilspyCmdVersion(path) {
      try {
        await access(path, constants.X_OK);
        return firstIlspyVersionLine(
          (
            await hostExecFileOutput(path, ["--version"], {
              timeout: 10_000,
              ...commandEnvironment,
            })
          ).stdout,
        );
      } catch (cause: unknown) {
        // best-effort cleanup: optional version probing; failure means unavailable.
        void cause;
        return undefined;
      }
    },
    async installationPaths() {
      try {
        const command = platform === "win32" ? "where" : "which";
        const arguments_ = platform === "win32" ? ["rea"] : ["-a", "rea"];
        return uniqueLines(
          (await hostExecFileOutput(command, arguments_, commandEnvironment))
            .stdout,
        );
      } catch (cause: unknown) {
        // best-effort cleanup: optional path probing; failure means none found.
        void cause;
        return [];
      }
    },
    installedSkillIdentity: (clientIds) =>
      readInstalledSkillIdentity(
        homeDirectory,
        clientIds,
        environment,
        platform,
        resources,
      ),
    close: async () => {
      controller.abort(STARTUP_OWNER_CLOSED);
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
    clientRegistrations: () =>
      readClientRegistrationStatuses(homeDirectory, undefined, {
        platform,
        environment,
        resources,
        ...(options.resolveProviderRequestBudget === undefined
          ? {}
          : {
              resolveProviderRequestBudget:
                options.resolveProviderRequestBudget,
            }),
      }),
  };
};

const readMacosVersion = async (
  run: typeof execFileOutput,
  options: { readonly env: NodeJS.ProcessEnv },
): Promise<string | undefined> => {
  try {
    return (await run("sw_vers", ["-productVersion"], options)).stdout.trim();
  } catch (cause: unknown) {
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

const manualHopperPaths = async (home: string): Promise<readonly string[]> => {
  const roots = macHopperApplicationRoots(home);
  const bundleNamesByRoot = new Map<string, readonly string[]>();
  for (const root of roots) {
    try {
      bundleNamesByRoot.set(
        root,
        (await readdir(root, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map(({ name }) => name),
      );
    } catch (cause: unknown) {
      // A missing or unreadable optional application directory is not fatal.
      void cause;
    }
  }
  return macHopperRenamedLauncherCandidates(home, bundleNamesByRoot);
};

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
