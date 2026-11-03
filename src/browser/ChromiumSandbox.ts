/** Host opt-out for Chromium launches where the host cannot provide its sandbox. */
export const CHROMIUM_NO_SANDBOX_VARIABLE = "REA_BROWSER_NO_SANDBOX";

/**
 * Decide whether REA-launched Chromium keeps its sandbox.
 *
 * Playwright disables the Chromium sandbox unless the launch asks for it, so
 * every launch passes this decision explicitly. Termux's Chromium has no usable
 * sandbox; other hosts opt out only through {@link CHROMIUM_NO_SANDBOX_VARIABLE}.
 */
export const chromiumSandboxEnabled = (
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): boolean =>
  platform !== "android" &&
  environment[CHROMIUM_NO_SANDBOX_VARIABLE] !== "true";

// Chromium's own startup diagnostics when the host cannot create its sandbox:
// a missing namespace or setuid sandbox, or a root user.
const unavailableSandboxDiagnostics = [
  "No usable sandbox!",
  "Running as root without --no-sandbox is not supported",
] as const;

/** Name the host opt-out when Chromium reports that its sandbox is unavailable. */
export const chromiumSandboxRemediation = (
  startupError: string,
): string | undefined =>
  unavailableSandboxDiagnostics.some((diagnostic) =>
    startupError.includes(diagnostic),
  )
    ? `Chromium could not start its sandbox on this host. Enable the host's sandbox support, or set ${CHROMIUM_NO_SANDBOX_VARIABLE}=true to run Chromium without its sandbox, then retry.`
    : undefined;
