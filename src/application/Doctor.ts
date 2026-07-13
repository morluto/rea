import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { parseBinaryTarget } from "../domain/binaryTarget.js";
import { supportsNodeVersion } from "../domain/runtimeVersion.js";
import { probeHomebrew } from "./homebrew.js";
import {
  linuxHopperLauncherPath,
  linuxSharedLibrariesAvailable,
  readLinuxDistribution,
  type LinuxDistribution,
} from "./LinuxHopper.js";

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
  brewHopperPath(): Promise<string | undefined>;
  manualHopperPaths(): Promise<readonly string[]>;
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
  const candidates = [
    host.configuredHopperPath,
    DEFAULT_HOPPER,
    SYSTEM_LINUX_HOPPER,
    linuxHopperLauncherPath(homedir()),
    ...(await host.manualHopperPaths()),
    await host.brewHopperPath(),
  ].filter((value): value is string => value !== undefined);
  let hopperPath: string | undefined;
  for (const candidate of new Set(candidates))
    if (await host.executable(candidate)) {
      hopperPath = candidate;
      break;
    }
  checks.push(
    check("hopper", hopperPath !== undefined, hopperPath, {
      remediation:
        "Run rea setup to install Hopper, or set HOPPER_LAUNCHER_PATH.",
      classification: "missing_analysis_engine",
    }),
  );
  if (target !== undefined)
    checks.push(
      check("target", await host.validTarget(target), target, {
        remediation: "Supply a readable local app or program path.",
        classification: "config_drift",
      }),
    );
  return {
    healthy: checks.every(({ ok }) => ok),
    ...(hopperPath === undefined ? {} : { hopperPath }),
    checks,
  };
};

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
});

const parseMajor = (version: string): number =>
  Number.parseInt(version.split(".")[0] ?? "0", 10);
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
