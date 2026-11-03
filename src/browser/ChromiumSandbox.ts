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

/**
 * Remediation for a sandboxed launch that failed to start.
 *
 * Chromium reports sandbox failures through several unrelated messages (no
 * namespace support, a misconfigured setuid helper, a refused namespace move,
 * a root user), so REA does not classify the startup log. The retained
 * diagnostics show whether the sandbox was the cause.
 */
export const CHROMIUM_SANDBOX_REMEDIATION = `If the startup diagnostics show that Chromium could not start its sandbox on this host, enable the host's sandbox support or set ${CHROMIUM_NO_SANDBOX_VARIABLE}=true to launch it without the sandbox.`;
