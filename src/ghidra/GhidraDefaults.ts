const DEFAULT_GHIDRA_STARTUP_TIMEOUT_MS = 330_000;

/**
 * Parse an optional startup deadline override. Large binaries can need more
 * than the default for import and full auto-analysis; an invalid or
 * non-positive value falls back to the default.
 */
export function ghidraStartupTimeoutFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const raw = environment.REA_GHIDRA_STARTUP_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_GHIDRA_STARTUP_TIMEOUT_MS;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_GHIDRA_STARTUP_TIMEOUT_MS;
}

/**
 * Absolute import, analysis, bridge, and health startup deadline.
 * Override with REA_GHIDRA_STARTUP_TIMEOUT_MS (milliseconds).
 */
export const GHIDRA_STARTUP_TIMEOUT_MS = ghidraStartupTimeoutFromEnvironment();
