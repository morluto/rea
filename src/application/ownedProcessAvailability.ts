import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import { LinuxOwnedProcessPrerequisiteError } from "../process/ProcessOwnershipObservation.js";
import type { ProviderAvailability } from "./AnalysisProvider.js";

const REMEDIATION =
  "Install your distribution's procps or procps-ng package, or put a procps-compatible ps on REA's PATH, then retry.";

// Provider adapters re-attribute capability errors and keep the original as cause.
const prerequisiteRefusal = (
  cause: unknown,
): LinuxOwnedProcessPrerequisiteError | undefined => {
  if (
    !(cause instanceof AnalysisCapabilityUnavailableError) ||
    cause.cleanupIncomplete
  )
    return undefined;
  for (
    let current: unknown = cause;
    current instanceof AnalysisCapabilityUnavailableError;
    current = current.cause
  )
    if (current instanceof LinuxOwnedProcessPrerequisiteError) return current;
  return undefined;
};

/** A host prerequisite gap is the probed provider's unavailability, not a probe failure. */
export const ownedProcessPrerequisiteAvailability = (
  cause: unknown,
): ProviderAvailability | undefined => {
  const refusal = prerequisiteRefusal(cause);
  return refusal === undefined
    ? undefined
    : {
        status: "unavailable",
        code: "runtime_unavailable",
        reason: `${refusal.reason}. ${REMEDIATION}`,
        diagnostics: {
          stage: "ownership_preparation",
          prerequisite_provider_id: refusal.providerId,
          prerequisite_operation: refusal.operation,
        },
      };
};
