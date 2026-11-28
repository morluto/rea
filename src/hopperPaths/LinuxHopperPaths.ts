import { appendCallerPath } from "../filesystem/callerPath.js";

/** Canonical launcher path for a legacy user-local Linux Hopper installation. */
const linuxHopperLauncherPath = (home: string): string =>
  appendCallerPath(home, ".local/share/rea/hopper/bin/Hopper", "linux");

/** REA's managed Linux install path, preferred when no explicit launcher is set. */
export const REA_MANAGED_LINUX_HOPPER_LAUNCHER = "/opt/hopper/bin/Hopper";

/** Other system-wide Hopper paths used by package installations. */
const systemLinuxHopperLauncherCandidates: readonly string[] = [
  "/opt/hopper-v4/bin/hopper",
  "/usr/bin/hopper",
];

/** Probe REA-managed and user-local installs before arbitrary system builds. */
export const linuxHopperLauncherCandidates = (
  home: string | undefined,
): readonly string[] => [
  REA_MANAGED_LINUX_HOPPER_LAUNCHER,
  ...(home === undefined
    ? []
    : [linuxHopperLauncherPath(home), ...systemLinuxHopperLauncherCandidates]),
];
