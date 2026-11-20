import { AnalysisError } from "../domain/analysisErrorBase.js";
import { providerCleanupErrorFromCloseRejections } from "../domain/analysisErrorCleanup.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { errorMessage } from "../kernel/errorMessage.js";

/** Attempt every web workflow cleanup owner and report all failures. */
export const closeOwnedWebResources = async (
  close: readonly ((() => Promise<void>) | undefined)[],
  message: string,
): Promise<void> => {
  const results = await Promise.allSettled(
    close.flatMap((owner) =>
      owner === undefined ? [] : [Promise.resolve().then(owner)],
    ),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );
  if (failures.length === 1) {
    const [failure] = failures;
    if (failure instanceof AnalysisError) throw failure;
    throw new ProviderCleanupError(
      "web-workflow",
      [],
      { reason: errorMessage(failure) },
      { cause: failure, operation: "close_web_workflow" },
    );
  }
  if (failures.length > 1) {
    const normalized = failures.map((cause) => ({
      cause,
      // A resolved error without an owner does not establish that this close settled.
      cleanupOwner:
        cause instanceof AnalysisError &&
        (cause.cleanupIncomplete || cause.hasCleanupOwner)
          ? cause
          : undefined,
      projection:
        cause instanceof AnalysisError
          ? projectAnalysisError(cause)
          : undefined,
    }));
    const recoveryActions = [
      ...new Set(
        normalized.flatMap(({ projection }) =>
          projection === undefined ? [] : [projection.remediation.action],
        ),
      ),
    ];
    throw providerCleanupErrorFromCloseRejections(
      "web-workflow",
      normalized,
      {
        failures: normalized.map(
          ({ cause, projection }) =>
            projection ?? {
              message: errorMessage(cause),
            },
        ),
      },
      {
        operation: "close_web_workflow",
        message,
        ...(recoveryActions.length === 0
          ? {}
          : { remediationAction: recoveryActions.join("; ") }),
      },
    );
  }
};
