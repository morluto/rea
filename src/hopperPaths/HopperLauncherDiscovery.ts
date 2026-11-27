import { isExecutableFileSync } from "../filesystem/regularFileProbe.js";

import { homeDirectoryFromEnvironment } from "../config/homeDirectory.js";

import {
  linuxHopperLauncherCandidates,
  REA_MANAGED_LINUX_HOPPER_LAUNCHER,
} from "./LinuxHopperPaths.js";
import {
  localMacHopperRenamedLauncherCandidates,
  MAC_HOPPER_SYSTEM_LAUNCHER,
  macHopperCanonicalLauncherCandidates,
} from "./MacHopperPaths.js";

/**
 * Where automatic Hopper discovery looks on one platform. The Hopper provider
 * and doctor both read it, so doctor checks the same candidates, in the same
 * order, as CLI/MCP startup.
 */
export interface HopperLauncherDiscovery {
  /** Fixed launcher paths, probed in order. */
  readonly candidates: readonly string[];
  /** Discovery must stop here if an earlier candidate did not resolve. */
  readonly stopsAtUnresolvedHome?: true;
  /**
   * Whether renamed `Hopper*.app` bundles are probed after the fixed paths.
   * Doctor also reports the Homebrew cask application only when this is set.
   */
  readonly probesMacApplicationBundles: boolean;
  /** Launcher selected when no candidate is executable. */
  readonly fallback: string;
}

/** Select the automatic Hopper launcher candidates for one platform. */
export const hopperLauncherDiscovery = (
  platform: NodeJS.Platform,
  homeDirectory: string | undefined,
): HopperLauncherDiscovery => {
  const completeness =
    homeDirectory === undefined
      ? ({ stopsAtUnresolvedHome: true } as const)
      : {};
  if (platform === "darwin")
    return {
      candidates: macHopperCanonicalLauncherCandidates(homeDirectory),
      ...completeness,
      probesMacApplicationBundles: true,
      fallback: MAC_HOPPER_SYSTEM_LAUNCHER,
    };
  if (platform === "linux")
    return {
      candidates: linuxHopperLauncherCandidates(homeDirectory),
      ...completeness,
      probesMacApplicationBundles: false,
      fallback: REA_MANAGED_LINUX_HOPPER_LAUNCHER,
    };
  return {
    candidates: [],
    probesMacApplicationBundles: false,
    fallback: MAC_HOPPER_SYSTEM_LAUNCHER,
  };
};

/**
 * The launcher automatic discovery selects: the first executable candidate,
 * then renamed macOS application bundles, else the platform's fallback.
 */
export const defaultHopperLauncherPath = (
  platform: NodeJS.Platform,
  homeDirectory: string,
  executable: (path: string) => boolean = isExecutableFileSync,
): string => {
  const discovery = hopperLauncherDiscovery(platform, homeDirectory);
  for (const candidate of discovery.candidates)
    if (executable(candidate)) return candidate;
  if (discovery.probesMacApplicationBundles)
    for (const candidate of localMacHopperRenamedLauncherCandidates(
      homeDirectory,
    ))
      if (executable(candidate)) return candidate;
  return discovery.fallback;
};

/**
 * The launcher the Hopper provider uses: the caller's `HOPPER_LAUNCHER_PATH`
 * spelling unchanged, else the one automatic discovery selects from the
 * caller environment's home.
 */
export const selectedHopperLauncherPath = (
  configured: string | undefined,
  platform: NodeJS.Platform,
  environment: Readonly<NodeJS.ProcessEnv>,
): string =>
  configured ??
  defaultHopperLauncherPath(
    platform,
    homeDirectoryFromEnvironment(environment, platform),
  );
