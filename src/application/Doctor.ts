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
  installationPaths?(): Promise<readonly string[]>;
  installedSkillVersion?(): Promise<string | undefined>;
  clientRegistrations?(): Promise<readonly ClientRegistrationStatus[]>;
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
      readonly state: "aligned" | "stale" | "unknown";
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
  const installedSkillVersion = await host.installedSkillVersion?.();
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
    healthy: checks.every(({ ok }) => ok),
    ...(hopperPath === undefined ? {} : { hopperPath }),
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
        state:
          installedSkillVersion === undefined
            ? "unknown"
            : installedSkillVersion === PRODUCT_IDENTITY.skillVersion
              ? "aligned"
              : "stale",
        remediation:
          installedSkillVersion === undefined ||
          installedSkillVersion === PRODUCT_IDENTITY.skillVersion
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

/** Create diagnostics backed by the current process and host commands. */
export const systemDoctorHost = (): DoctorHost => ({
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
