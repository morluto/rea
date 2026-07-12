import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { probeHomebrew } from "./homebrew.js";

const execFileAsync = promisify(execFile);
const DEFAULT_HOPPER =
  "/Applications/Hopper Disassembler.app/Contents/MacOS/hopper";

/** One actionable environment diagnostic. */
export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
  readonly remediation?: string;
}
/** Read-only host capabilities required by diagnostics. */
export interface DoctorHost {
  readonly platform: NodeJS.Platform;
  readonly nodeVersion: string;
  readonly configuredHopperPath?: string;
  macosVersion(): Promise<string | undefined>;
  readable(path: string): Promise<boolean>;
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
  const nodeMajor = parseMajor(host.nodeVersion);
  checks.push(
    check(
      "node",
      nodeMajor >= 22,
      host.nodeVersion,
      "Install Node.js 22 or newer.",
    ),
  );
  const macosVersion =
    host.platform === "darwin" ? await host.macosVersion() : undefined;
  const macosMajor = macosVersion === undefined ? 0 : parseMajor(macosVersion);
  checks.push(
    check(
      "macos",
      host.platform === "darwin" && macosMajor >= 12,
      macosVersion ?? host.platform,
      "Hopper requires macOS 12 or newer.",
    ),
  );
  const candidates = [
    host.configuredHopperPath,
    DEFAULT_HOPPER,
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
    check(
      "hopper",
      hopperPath !== undefined,
      hopperPath,
      "Install Hopper with: brew install --cask hopper-disassembler, or set HOPPER_LAUNCHER_PATH.",
    ),
  );
  if (target !== undefined)
    checks.push(
      check(
        "target",
        await host.readable(target),
        target,
        "Supply a readable local binary path.",
      ),
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
  async readable(path) {
    try {
      await access(path, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  },
  async executable(path) {
    try {
      await access(path, constants.X_OK);
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
  remediation: string,
): DoctorCheck => ({
  name,
  ok,
  ...(detail === undefined ? {} : { detail }),
  ...(ok ? {} : { remediation }),
});
