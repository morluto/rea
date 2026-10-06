import { constants } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import { analysisErrorRemediationAction } from "../domain/analysisErrorPresentation.js";
import { parseBinaryTarget } from "./BinaryTargetResolver.js";
import { execFileOutput } from "../process/ExecFileOutput.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { probeHomebrew } from "./homebrew.js";
import {
  linuxHopperBinarySupported,
  linuxSharedLibrariesAvailable,
  readLinuxDistribution,
  type LinuxDistribution,
} from "./LinuxHopper.js";
import { CATALOG_IDENTITY } from "../catalogIdentity.js";
import { PRODUCT_IDENTITY, SDK_IDENTITY } from "../identity.js";
import {
  readClientRegistrationStatuses,
  type ClientRegistrationStatus,
  type UnhealthyClientRegistrationStatus,
} from "./ClientRegistrationStatus.js";
import {
  collectDoctorDiagnostics,
  doctorHealthy,
} from "./DoctorDiagnostics.js";
import {
  normalizeDoctorScope,
  scopeDoctorChecks,
  type DoctorScopeReport,
} from "./DoctorScope.js";

/** Deep provider IDs whose readiness can be selected explicitly by doctor. */
export const DOCTOR_PROVIDER_IDS = ["hopper", "ghidra"] as const;
/** One actionable environment diagnostic. */
export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly classification:
    | "healthy"
    | "missing_dependency"
    | "unsupported_host"
    | "unsupported_target"
    | "missing_analysis_engine"
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
  readonly platform: NodeJS.Platform;
  readonly architecture: NodeJS.Architecture;
  readonly nodeVersion: string;
  readonly homeDirectory?: string;
  readonly configuredHopperPath?: string;
  readonly configuredIlspyCmdPath?: string;
  macosVersion(): Promise<string | undefined>;
  linuxDistribution(): Promise<LinuxDistribution | undefined>;
  validTarget(path: string): Promise<boolean>;
  /** Route-specific target admission details, when supplied by the host. */
  inspectTarget?(path: string): Promise<DoctorCheck>;
  executable(path: string): Promise<boolean>;
  supportedLinuxHopper(path: string): Promise<boolean>;
  linuxDemoRuntimeCheck(): Promise<DoctorCheck>;
  brewHopperPath(): Promise<string | undefined>;
  manualHopperPaths(): Promise<readonly string[]>;
  providerInspections?(): Promise<readonly DoctorProviderInspection[]>;
  installationPaths?(): Promise<readonly string[]>;
  installedSkillIdentity?(): Promise<InstalledSkillIdentity | undefined>;
  clientRegistrations?(): Promise<readonly ClientRegistrationStatus[]>;
  ilspyCmdVersion?(path: string): Promise<string | undefined>;
}

/** Parsed identity committed by an installed REA skill. */
interface InstalledSkillIdentity {
  readonly version: string | null;
  readonly toolCount: number | null;
  readonly catalogDigest: string | null;
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
  readonly providers?: readonly string[];
  readonly skill?: boolean;
}

/** Installed-package, skill, client, and runtime identity observations. */
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
    readonly installed_catalog_digest: string | null;
    readonly state: "aligned" | "stale" | "missing";
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
  host: DoctorHost = systemDoctorHost(),
  requestedScope?: DoctorScope,
): Promise<DoctorReport> => {
  const {
    checks: diagnosticChecks,
    hopperPath,
    providerInspections,
  } = await collectDoctorDiagnostics(target, host);
  const identity = await collectDoctorIdentity(host);
  const checks = [...diagnosticChecks, ...identity.checks];
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
  const scope = normalizeDoctorScope(requestedScope, target);
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

const collectDoctorIdentity = async (
  host: DoctorHost,
): Promise<{
  readonly checks: readonly DoctorCheck[];
  readonly value: DoctorIdentity;
}> => {
  const installationPaths = (await host.installationPaths?.()) ?? [];
  const installedSkillIdentity = await host.installedSkillIdentity?.();
  const skillAligned = skillIdentityAligned(installedSkillIdentity);
  const registrations = (await host.clientRegistrations?.()) ?? [];
  return {
    checks: [
      ...(skillAligned ? [] : [skillIdentityCheck(installedSkillIdentity)]),
      ...registrations
        .filter(
          (registration): registration is UnhealthyClientRegistrationStatus =>
            registration.state !== "aligned",
        )
        .map(registrationCheck),
    ],
    value: {
      cli_package_version: PRODUCT_IDENTITY.packageVersion,
      expected_skill_version: PRODUCT_IDENTITY.skillVersion,
      sdk: SDK_IDENTITY,
      catalog: CATALOG_IDENTITY,
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
        installed_catalog_digest: installedSkillIdentity?.catalogDigest ?? null,
        state:
          installedSkillIdentity === undefined
            ? "missing"
            : skillAligned
              ? "aligned"
              : "stale",
        remediation: skillAligned
          ? null
          : "Run rea setup to update the installed REA skill.",
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
  identity.catalogDigest === CATALOG_IDENTITY.digests.combined_sha256;

const skillIdentityCheck = (
  identity: InstalledSkillIdentity | undefined,
): DoctorCheck => ({
  name: "skill:identity",
  ok: false,
  classification: "config_drift",
  detail:
    identity === undefined
      ? "Installed REA skill identity is missing."
      : "Installed REA skill identity is stale.",
  remediation: "Run rea setup to update the installed REA skill.",
});

const registrationCheck = (
  registration: UnhealthyClientRegistrationStatus,
): DoctorCheck => ({
  name: `registration:${registration.client}`,
  ok: false,
  classification: "config_drift",
  detail: registration.config_path,
  remediation: registration.remediation,
});

const installationState = (
  paths: readonly string[],
): DoctorIdentity["installations"]["state"] =>
  paths.length === 0 ? "unknown" : paths.length === 1 ? "single" : "multiple";

const homeFromEnvironment = (
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string => {
  const selected =
    platform === "win32"
      ? (environment.USERPROFILE ??
        (environment.HOMEDRIVE !== undefined &&
        environment.HOMEPATH !== undefined
          ? `${environment.HOMEDRIVE}${environment.HOMEPATH}`
          : environment.HOME))
      : (environment.HOME ?? environment.USERPROFILE);
  return selected ?? homedir();
};

/** Optional outer-adapter diagnostics composed without reversing dependencies. */
export interface SystemDoctorHostOptions {
  readonly platform?: NodeJS.Platform;
  readonly architecture?: NodeJS.Architecture;
  readonly environment?: NodeJS.ProcessEnv;
  readonly execFileOutput?: typeof execFileOutput;
  readonly providerInspections?: () => Promise<
    readonly DoctorProviderInspection[]
  >;
  readonly linuxDemoRuntimeCheck?: () => Promise<DoctorCheck>;
}

/** Create diagnostics backed by the current process and host commands. */
export const systemDoctorHost = (
  options: SystemDoctorHostOptions = {},
): DoctorHost => {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const environment = options.environment ?? process.env;
  const hostExecFileOutput = options.execFileOutput ?? execFileOutput;
  const homeDirectory = homeFromEnvironment(environment, platform);
  const commandEnvironment = { env: environment };
  return {
    platform,
    architecture,
    nodeVersion: process.versions.node,
    homeDirectory,
    ...(environment.HOPPER_LAUNCHER_PATH === undefined
      ? {}
      : { configuredHopperPath: environment.HOPPER_LAUNCHER_PATH }),
    ...(environment.REA_ILSPY_CMD_PATH === undefined
      ? {}
      : { configuredIlspyCmdPath: environment.REA_ILSPY_CMD_PATH }),
    macosVersion: () =>
      readMacosVersion(hostExecFileOutput, commandEnvironment),
    linuxDistribution: readLinuxDistribution,
    async validTarget(path) {
      return (await parseBinaryTarget(path, process.cwd(), architecture)).ok;
    },
    async inspectTarget(path) {
      const result = await parseBinaryTarget(path, process.cwd(), architecture);
      if (result.ok)
        return {
          name: "target",
          ok: true,
          classification: "healthy",
          detail: path,
        };
      const error = result.error;
      return {
        name: "target",
        ok: false,
        classification:
          error.constraint === "directory_requires_file"
            ? "unsupported_target"
            : "config_drift",
        detail: path,
        details: {
          reason: error.reason,
          ...(error.constraint === undefined
            ? {}
            : { constraint: error.constraint }),
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
    supportedLinuxHopper: linuxHopperBinarySupported,
    async brewHopperPath() {
      return probeHomebrew(async (command) => {
        try {
          const prefix = (
            await hostExecFileOutput(
              command,
              ["--prefix", "--cask", "hopper-disassembler"],
              commandEnvironment,
            )
          ).stdout.trim();
          return `${prefix}/Hopper Disassembler.app/Contents/MacOS/hopper`;
        } catch (cause: unknown) {
          // best-effort cleanup: optional Homebrew probing; absence means uninstalled.
          void cause;
          return undefined;
        }
      });
    },
    manualHopperPaths: () => manualHopperPaths(homeDirectory),
    ...(options.providerInspections === undefined
      ? {}
      : { providerInspections: options.providerInspections }),
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
    installedSkillIdentity: () => installedSkillIdentity(homeDirectory),
    clientRegistrations: () =>
      readClientRegistrationStatuses(homeDirectory, undefined, {
        platform,
        environment,
      }),
  };
};

const readMacosVersion = async (
  run: typeof execFileOutput = execFileOutput,
  options: { readonly env: NodeJS.ProcessEnv } = { env: process.env },
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
  platform: NodeJS.Platform = process.platform,
  run: typeof execFileOutput = execFileOutput,
  options: { readonly env: NodeJS.ProcessEnv } = { env: process.env },
): Promise<boolean> => {
  try {
    await access(path, constants.X_OK);
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

const manualHopperPaths = async (
  home: string = homedir(),
): Promise<readonly string[]> => {
  const paths: string[] = [];
  for (const root of ["/Applications", join(home, "Applications")]) {
    try {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (entry.isDirectory() && /^Hopper.*\.app$/i.test(entry.name))
          paths.push(join(root, entry.name, "Contents/MacOS/hopper"));
      }
    } catch (cause: unknown) {
      // A missing or unreadable optional application directory is not fatal.
      void cause;
    }
  }
  return paths;
};

const readInstalledSkill = (home: string): Promise<string> =>
  readFile(
    join(home, ".agents/skills", PRODUCT_IDENTITY.skillName, "SKILL.md"),
    "utf8",
  );

const installedSkillIdentity = async (
  home: string,
): Promise<InstalledSkillIdentity | undefined> => {
  try {
    const content = await readInstalledSkill(home);
    const countText = /^\s{2}tool_count:\s*(\d+)\s*$/mu.exec(content)?.[1];
    return {
      version: /^\s{2}version:\s*"([^"]+)"\s*$/mu.exec(content)?.[1] ?? null,
      toolCount:
        countText === undefined ? null : Number.parseInt(countText, 10),
      catalogDigest:
        /^\s{2}catalog_digest:\s*"([a-f0-9]{64})"\s*$/mu.exec(content)?.[1] ??
        null,
    };
  } catch (cause: unknown) {
    // best-effort cleanup: optional skill probing; failure means unknown.
    void cause;
    return undefined;
  }
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
