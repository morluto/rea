/**
 * The `ps` REA runs to inspect the process table. macOS ships it at `/bin/ps`
 * on the sealed system volume, so process inspection never depends on REA's
 * PATH there. Linux keeps the documented procps contract: a procps-compatible
 * `ps` on REA's PATH (see `LINUX_PROCESS_OWNERSHIP_REMEDIATION`).
 */
export const systemPsCommand = (platform: NodeJS.Platform): string =>
  platform === "darwin" ? "/bin/ps" : "ps";
