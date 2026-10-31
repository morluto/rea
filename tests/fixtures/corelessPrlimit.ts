import { existsSync, readFileSync } from "node:fs";

const hardCoreLimit = (): string | undefined => {
  try {
    return /^Max core file size\s+\S+\s+(\S+)/m.exec(
      readFileSync("/proc/self/limits", "utf8"),
    )?.[1];
  } catch {
    return undefined;
  }
};

/**
 * prlimit that runs a deliberately crashing fixture with RLIMIT_CORE=1, so
 * systemd-coredump records nothing. Undefined without prlimit, or when an
 * inherited hard limit of 0 already disables cores and cannot be raised.
 */
export const corelessPrlimit =
  existsSync("/usr/bin/prlimit") && hardCoreLimit() !== "0"
    ? "/usr/bin/prlimit"
    : undefined;
