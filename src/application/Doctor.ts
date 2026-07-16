import { constants } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { parseBinaryTarget } from "../domain/binaryTarget.js";
import { supportsNodeVersion } from "../domain/runtimeVersion.js";
import { probeHomebrew } from "./homebrew.js";
import {
  linuxHopperBinarySupported,
  linuxHopperLauncherPath,
  linuxSharedLibrariesAvailable,
  readLinuxDistribution,
  type LinuxDistribution,
} from "./LinuxHopper.js";
import { CATALOG_IDENTITY } from "../catalogIdentity.js";
import { PRODUCT_IDENTITY, SDK_IDENTITY } from "../identity.js";
import {
  readClientRegistrationStatuses,
  type ClientRegistrationStatus,
} from "./ClientRegistrationStatus.js";

const execFileAsync = promisify(execFile);
const DEFAULT_HOPPER =
  "/Applications/Hopper Disassembler.app/Contents/MacOS/hopper";
const SYSTEM_LINUX_HOPPER = "/opt/hopper/bin/Hopper";

/** One actionable environment diagnostic. */
export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly classification:
    | "healthy"
    | "missing_dependency"
    | "unsupported_host"
    | "missing_analysis_engine"
    | "config_drift";
  readonly detail?: string;
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
  /** Exact non-secret variables safe to persist in an approved registration. */
  readonly registrationEnvironment: Readonly<Record<string, string>>;
  readonly checks: readonly DoctorProviderCheck[];
}
/** Read-only host capabilities required by diagnostics. */
export interface DoctorHost {
  readonly platform: NodeJS.Platform;
  readonly nodeVersion: string;
  readonly configuredHopperPath?: string;
  macosVersion(): Promise<string | undefined>;
  linuxDistribution(): Promise<LinuxDistribution | undefined>;
  validTarget(path: string): Promise<boolean>;
  executable(path: string): Promise<boolean>;
  supportedLinuxHopper(path: string): Promise<boolean>;
  linuxDemoRuntimeReady(): Promise<boolean>;
  brewHopperPath(): Promise<string | undefined>;
  manualHopperPaths(): Promise<readonly string[]>;
  providerInspections?(): Promise<readonly DoctorProviderInspection[]>;
  installationPaths?(): Promise<readonly string[]>;
  installedSkillVersion?(): Promise<string | undefined>;
  installedSkillIdentity?(): Promise<InstalledSkillIdentity | undefined>;
  clientRegistrations?(): Promise<readonly ClientRegistrationStatus[]>;
  javascriptReplayCheck?(): Promise<DoctorCheck>;
}

/** Parsed identity committed by an installed REA skill. */
interface InstalledSkillIdentity {
  readonly version: string | null;
  readonly toolCount: number | null;
  readonly catalogDigest: string | null;
}

/**
 * Check requirements and an optional target without mutating the host.
 * Every failed check includes remediation suitable for either the one-shot CLI
 * or an agent consuming the structured result.
 */
export const runDoctor = async (
  target?: string,
  host: DoctorHost = systemDoctorHost(),
): Promise<{
  readonly healthy: boolean;
  readonly hopperPath?: string;
  readonly providerInspections?: readonly DoctorProviderInspection[];
  readonly checks: readonly DoctorCheck[];
  readonly identity?: {
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
  };
}> => {
  const checks: DoctorCheck[] = [];
  checks.push(
    check("node", supportsNodeVersion(host.nodeVersion), host.nodeVersion, {
      remediation: "Install Node.js 22.19+ or 24.11+.",
      classification: "missing_dependency",
    }),
  );
  const macosVersion =
    host.platform === "darwin" ? await host.macosVersion() : undefined;
  const macosMajor = macosVersion === undefined ? 0 : parseMajor(macosVersion);
  const linuxDistribution =
    host.platform === "linux" ? await host.linuxDistribution() : undefined;
  const supportedHost =
    (host.platform === "darwin" && macosMajor >= 12) ||
    (host.platform === "linux" && linuxDistribution?.supported === true);
  checks.push(
    check(
      "host",
      supportedHost,
      macosVersion ??
        (linuxDistribution === undefined
          ? host.platform
          : `${linuxDistribution.id} ${linuxDistribution.versionId ?? "unknown"}`),
      {
        remediation:
          "REA supports macOS 12+, Ubuntu 24.04+, Fedora 41+, and 64-bit Arch Linux.",
        classification: "unsupported_host",
      },
    ),
  );
  const candidates =
    host.configuredHopperPath === undefined
      ? [
          DEFAULT_HOPPER,
          SYSTEM_LINUX_HOPPER,
          linuxHopperLauncherPath(homedir()),
          ...(await host.manualHopperPaths()),
          await host.brewHopperPath(),
        ].filter((value): value is string => value !== undefined)
      : [host.configuredHopperPath];
  let hopperPath: string | undefined;
  for (const candidate of new Set(candidates))
    if (await host.executable(candidate)) {
      hopperPath = candidate;
      break;
    }
  checks.push(
    check(
      "hopper",
      hopperPath !== undefined,
      hopperPath ?? host.configuredHopperPath,
      {
        remediation:
          host.configuredHopperPath === undefined
            ? "Run rea setup to install Hopper, or set HOPPER_LAUNCHER_PATH."
            : "Unset or update HOPPER_LAUNCHER_PATH to an executable Hopper launcher.",
        classification:
          host.configuredHopperPath === undefined
            ? "missing_analysis_engine"
            : "config_drift",
      },
    ),
  );
  if (host.platform === "linux" && hopperPath !== undefined)
    checks.push(
      check(
        "hopper-version",
        await host.supportedLinuxHopper(hopperPath),
        hopperPath,
        {
          remediation: unsupportedHopperRemediation(
            host.configuredHopperPath === hopperPath,
          ),
          classification: "config_drift",
        },
      ),
    );
  const providerInspections = await inspectDoctorProviders(host, checks);
  const javascriptReplayCheck = await host.javascriptReplayCheck?.();
  if (javascriptReplayCheck !== undefined) checks.push(javascriptReplayCheck);
  if (host.platform === "linux" && hopperPath !== undefined)
    checks.push(
      check(
        "hopper-demo-runtime",
        await host.linuxDemoRuntimeReady(),
        undefined,
        {
          remediation:
            "Rerun rea setup to install the Xvfb, xauth, Python, X11, and XTEST packages required for Linux demo sessions.",
          classification: "missing_dependency",
        },
      ),
    );
  if (target !== undefined)
    checks.push(
      check("target", await host.validTarget(target), target, {
        remediation: "Supply a readable local app or program path.",
        classification: "config_drift",
      }),
    );
  const installationPaths = (await host.installationPaths?.()) ?? [];
  const observedSkillIdentity = await host.installedSkillIdentity?.();
  const legacySkillVersion =
    observedSkillIdentity === undefined
      ? await host.installedSkillVersion?.()
      : undefined;
  const installedSkillIdentity =
    observedSkillIdentity ??
    (legacySkillVersion === undefined
      ? undefined
      : {
          version: legacySkillVersion,
          toolCount: null,
          catalogDigest: null,
        });
  const installedSkillVersion = installedSkillIdentity?.version ?? undefined;
  const skillAligned =
    installedSkillIdentity?.version === PRODUCT_IDENTITY.skillVersion &&
    installedSkillIdentity.toolCount === CATALOG_IDENTITY.counts.mcp_tools &&
    installedSkillIdentity.catalogDigest ===
      CATALOG_IDENTITY.digests.combined_sha256;
  if (!skillAligned)
    checks.push({
      name: "skill:identity",
      ok: false,
      classification: "config_drift",
      detail:
        installedSkillIdentity === undefined
          ? "Installed REA skill identity is missing."
          : "Installed REA skill identity is stale.",
      remediation: "Run rea setup to update the installed REA skill.",
    });
  const registrations = (await host.clientRegistrations?.()) ?? [];
  for (const registration of registrations)
    if (registration.state !== "aligned")
      checks.push({
        name: `registration:${registration.client}`,
        ok: false,
        classification: "config_drift",
        detail: registration.config_path,
        remediation:
          registration.remediation ??
          "Run rea setup, then restart the affected client.",
      });
  return {
    healthy: doctorHealthy(checks, {
      hopperAvailable:
        hopperPath !== undefined &&
        checks
          .filter(({ name }) => name.startsWith("hopper"))
          .every(({ ok }) => ok),
      hopperConfigured: host.configuredHopperPath !== undefined,
      providerInspections,
    }),
    ...(hopperPath === undefined ? {} : { hopperPath }),
    ...(providerInspections === undefined ? {} : { providerInspections }),
    checks,
    identity: {
      cli_package_version: PRODUCT_IDENTITY.packageVersion,
      expected_skill_version: PRODUCT_IDENTITY.skillVersion,
      sdk: SDK_IDENTITY,
      catalog: CATALOG_IDENTITY,
      live_server: {
        state: "unknown",
        remediation:
          "Compare rea://server/identity or binary_session from the active client; an on-disk registration cannot prove the running server version.",
      },
      installations: {
        paths: installationPaths,
        state:
          installationPaths.length === 0
            ? "unknown"
            : installationPaths.length === 1
              ? "single"
              : "multiple",
      },
      skill: {
        installed_version: installedSkillVersion ?? null,
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

const unsupportedHopperRemediation = (configured: boolean): string =>
  configured
    ? "Unset or update HOPPER_LAUNCHER_PATH, install the Hopper build supported by this REA release, or update REA."
    : "Install the Hopper build supported by this REA release, or update REA for a newer Hopper build.";

/** Optional outer-adapter diagnostics composed without reversing dependencies. */
export interface SystemDoctorHostOptions {
  readonly providerInspections?: () => Promise<
    readonly DoctorProviderInspection[]
  >;
  readonly javascriptReplayCheck?: () => Promise<DoctorCheck>;
}

/** Create diagnostics backed by the current process and host commands. */
export const systemDoctorHost = (
  options: SystemDoctorHostOptions = {},
): DoctorHost => ({
  platform: process.platform,
  nodeVersion: process.versions.node,
  ...(process.env.HOPPER_LAUNCHER_PATH === undefined
    ? {}
    : { configuredHopperPath: process.env.HOPPER_LAUNCHER_PATH }),
  async macosVersion() {
    try {
      return (
        await execFileAsync("sw_vers", ["-productVersion"])
      ).stdout.trim();
    } catch {
      return undefined;
    }
  },
  linuxDistribution: readLinuxDistribution,
  async validTarget(path) {
    return (await parseBinaryTarget(path)).ok;
  },
  async executable(path) {
    try {
      await access(path, constants.X_OK);
      if (process.platform === "linux") {
        const linked = await execFileAsync("ldd", [path]);
        if (
          !linuxSharedLibrariesAvailable(`${linked.stdout}\n${linked.stderr}`)
        )
          return false;
      }
      return true;
    } catch {
      return false;
    }
  },
  async linuxDemoRuntimeReady() {
    try {
      await access("/usr/bin/Xvfb", constants.X_OK);
      await access("/usr/bin/xauth", constants.X_OK);
      await access("/usr/bin/python3", constants.X_OK);
      await execFileAsync("/usr/bin/python3", [
        "-c",
        "import ctypes; ctypes.CDLL('libX11.so.6'); ctypes.CDLL('libXtst.so.6')",
      ]);
      return true;
    } catch {
      return false;
    }
  },
  supportedLinuxHopper: linuxHopperBinarySupported,
  async brewHopperPath() {
    return probeHomebrew(async (command) => {
      try {
        const prefix = (
          await execFileAsync(command, [
            "--prefix",
            "--cask",
            "hopper-disassembler",
          ])
        ).stdout.trim();
        return `${prefix}/Hopper Disassembler.app/Contents/MacOS/hopper`;
      } catch {
        return undefined;
      }
    });
  },
  async manualHopperPaths() {
    const roots = ["/Applications", join(homedir(), "Applications")];
    const paths: string[] = [];
    for (const root of roots) {
      try {
        for (const entry of await readdir(root, { withFileTypes: true })) {
          if (entry.isDirectory() && /^Hopper.*\.app$/i.test(entry.name))
            paths.push(join(root, entry.name, "Contents/MacOS/hopper"));
        }
      } catch {
        // A missing or unreadable optional application directory is not fatal.
      }
    }
    return paths;
  },
  ...(options.providerInspections === undefined
    ? {}
    : { providerInspections: options.providerInspections }),
  ...(options.javascriptReplayCheck === undefined
    ? {}
    : { javascriptReplayCheck: options.javascriptReplayCheck }),
  async installationPaths() {
    try {
      const command = process.platform === "win32" ? "where" : "which";
      const arguments_ = process.platform === "win32" ? ["rea"] : ["-a", "rea"];
      return uniqueLines((await execFileAsync(command, arguments_)).stdout);
    } catch {
      return [];
    }
  },
  async installedSkillVersion() {
    try {
      const content = await readFile(
        join(
          homedir(),
          ".agents/skills",
          PRODUCT_IDENTITY.skillName,
          "SKILL.md",
        ),
        "utf8",
      );
      return /^\s{2}version:\s*"([^"]+)"\s*$/mu.exec(content)?.[1];
    } catch {
      return undefined;
    }
  },
  async installedSkillIdentity() {
    try {
      const content = await readFile(
        join(
          homedir(),
          ".agents/skills",
          PRODUCT_IDENTITY.skillName,
          "SKILL.md",
        ),
        "utf8",
      );
      const version =
        /^\s{2}version:\s*"([^"]+)"\s*$/mu.exec(content)?.[1] ?? null;
      const countText = /^\s{2}tool_count:\s*(\d+)\s*$/mu.exec(content)?.[1];
      const catalogDigest =
        /^\s{2}catalog_digest:\s*"([a-f0-9]{64})"\s*$/mu.exec(content)?.[1] ??
        null;
      return {
        version,
        toolCount:
          countText === undefined ? null : Number.parseInt(countText, 10),
        catalogDigest,
      };
    } catch {
      return undefined;
    }
  },
  clientRegistrations: () => readClientRegistrationStatuses(homedir()),
});

const parseMajor = (version: string): number =>
  Number.parseInt(version.split(".")[0] ?? "0", 10);
const uniqueLines = (value: string): string[] => [
  ...new Set(
    value
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  ),
];
const check = (
  name: string,
  ok: boolean,
  detail: string | undefined,
  failure: {
    readonly remediation: string;
    readonly classification: Exclude<DoctorCheck["classification"], "healthy">;
  },
): DoctorCheck => ({
  name,
  ok,
  classification: ok ? "healthy" : failure.classification,
  ...(detail === undefined ? {} : { detail }),
  ...(ok ? {} : { remediation: failure.remediation }),
});

const providerDoctorChecks = (
  inspection: DoctorProviderInspection,
): readonly DoctorCheck[] =>
  inspection.checks.map((candidate) => ({
    name:
      candidate.name === "configuration"
        ? inspection.id
        : `${inspection.id}-${candidate.name}`,
    ok: candidate.ok,
    classification: candidate.ok ? "healthy" : candidate.classification,
    detail: candidate.detail,
    ...(candidate.remediation === null
      ? {}
      : { remediation: candidate.remediation }),
  }));

const inspectDoctorProviders = async (
  host: DoctorHost,
  checks: DoctorCheck[],
): Promise<readonly DoctorProviderInspection[] | undefined> => {
  const inspections = await host.providerInspections?.();
  if (inspections === undefined) return undefined;
  for (const inspection of inspections)
    checks.push(...providerDoctorChecks(inspection));
  return inspections;
};

const doctorHealthy = (
  checks: readonly DoctorCheck[],
  providers: {
    readonly hopperAvailable: boolean;
    readonly hopperConfigured: boolean;
    readonly providerInspections:
      | readonly DoctorProviderInspection[]
      | undefined;
  },
): boolean => {
  if (providers.providerInspections === undefined)
    return checks.every(({ ok }) => ok);
  const providerChecks = checks.filter(
    ({ name }) =>
      name.startsWith("hopper") ||
      providers.providerInspections?.some((inspection) =>
        providerCheckName(inspection.id, name),
      ) === true,
  );
  const coreHealthy = checks
    .filter((candidate) => !providerChecks.includes(candidate))
    .every(({ ok }) => ok);
  const configuredProvidersHealthy = providerChecks
    .filter(({ name }) => {
      if (name.startsWith("hopper")) return providers.hopperConfigured;
      return providers.providerInspections?.some(
        (inspection) =>
          inspection.configured && providerCheckName(inspection.id, name),
      );
    })
    .every(({ ok }) => ok);
  return (
    coreHealthy &&
    configuredProvidersHealthy &&
    (providers.hopperAvailable ||
      providers.providerInspections.some(({ available }) => available))
  );
};

const providerCheckName = (providerId: string, name: string): boolean =>
  name === providerId || name.startsWith(`${providerId}-`);
