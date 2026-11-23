import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";

/** The only host profile with an enforceable native memory bound for sigrok. */
export const sigrokHostSupported = (platform: NodeJS.Platform): boolean =>
  platform === "linux";

/** Why this host cannot decode signal recordings; no setting changes it. */
export const SIGROK_UNSUPPORTED_HOST_REASON =
  "Signal decoding requires an enforceable native memory bound: Linux with util-linux prlimit. This host's signal-recording boundary remains unsupported.";

/** Repair for an unsupported host, kept apart from the sigrok command setting. */
export const SIGROK_HOST_REMEDIATION =
  "Run signal decoding on Linux with util-linux prlimit; no REA setting makes this host support it.";

/**
 * Refuse an unsupported host as a capability limit rather than a configuration
 * problem, so recovery does not ask for a sigrok command this host cannot use.
 */
export const sigrokUnsupportedHostError = (
  operation: string,
): AnalysisCapabilityUnavailableError =>
  new AnalysisCapabilityUnavailableError(
    "sigrok-recording",
    operation,
    SIGROK_UNSUPPORTED_HOST_REASON,
    {
      userMessage: SIGROK_UNSUPPORTED_HOST_REASON,
      remediationAction: SIGROK_HOST_REMEDIATION,
      retryable: false,
    },
  );
