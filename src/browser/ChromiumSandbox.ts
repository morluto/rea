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

const LAUNCH_REMEDIATION =
  "Review the selected executable and startup diagnostics, then correct the launch configuration before retrying.";

/**
 * Remediation for a Chromium launch that failed before the browser connected.
 *
 * Chromium reports an unusable sandbox through several unrelated messages (no
 * namespace support, a misconfigured setuid helper, a refused namespace move,
 * a root user), so REA does not classify the startup log. A sandboxed launch
 * adds the opt-out; the retained diagnostics show whether it applies.
 */
export const chromiumLaunchRemediation = (sandbox: boolean): string =>
  sandbox
    ? `${LAUNCH_REMEDIATION} If the startup diagnostics show that Chromium could not start its sandbox on this host, enable the host's sandbox support or set ${CHROMIUM_NO_SANDBOX_VARIABLE}=true to launch it without the sandbox.`
    : LAUNCH_REMEDIATION;
