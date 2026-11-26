/**
 * Termux and other Android Node builds expose Linux procfs under
 * `process.platform === "android"`. Treat them like Linux for ownership,
 * sampling, and debugger paths that read `/proc`.
 */
export const hostHasProcfs = (platform: NodeJS.Platform): boolean =>
  platform === "linux" || platform === "android";
