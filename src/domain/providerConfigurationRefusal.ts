import { AnalysisCapabilityUnavailableError } from "./analysisErrorCore.js";
import type { JsonValue } from "./jsonValue.js";

/** Project a provider-owned configuration failure and its repair instruction. */
export const providerConfigurationRefusal = (
  providerId: string,
  operation: string,
  failure: Error & {
    readonly remediation: string;
    readonly diagnostics?: Readonly<Record<string, JsonValue>>;
  },
): AnalysisCapabilityUnavailableError => {
  const reason = `${failure.message}. ${failure.remediation}.`;
  return new AnalysisCapabilityUnavailableError(providerId, operation, reason, {
    cause: failure,
    userMessage: reason,
    remediationAction: `${failure.remediation}.`,
    diagnostics: failure.diagnostics,
  });
};
