import type { Logger } from "pino";

import type { BinarySessionPort } from "../application/binary/BinarySessionPort.js";
import {
  retainCloseOutcome,
  type CloseValue,
} from "../domain/engineCloseReport.js";
import { err, ok, type Result } from "../domain/result.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupDependencies } from "../domain/analysisErrorCleanup.js";
import type { AnalysisCleanupRetry } from "../domain/analysisErrorRecovery.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { processCaptureFailureForClose } from "../process/capture/ProcessCaptureError.js";
import { errorMessage } from "../kernel/errorMessage.js";
import {
  ArtifactReaderFailure,
  bindArtifactFileCleanup,
  type ArtifactResourceScope,
} from "../resources/index.js";

/**
 * The session whose target the lifecycle tools close or reset, and the
 * adapter-owned resources that close with it.
 */
export interface SessionLifecycleOptions {
  readonly session: BinarySessionPort;
  readonly logger: Logger;
  readonly artifactResources: ArtifactResourceScope;
  readonly closeProcessResources: () => Promise<Result<null, AnalysisError>>;
}

/** Expected lifecycle failures keep the same typed result when a child rejects. */
const closeResult = async <Value>(
  close: () => Promise<Result<Value, AnalysisError>>,
): Promise<Result<Value, AnalysisError>> => {
  try {
    return await close();
  } catch (cause: unknown) {
    if (cause instanceof AnalysisError) return err(cause);
    throw cause;
  }
};

/** close_binary retries the session and process-capture cleanup it retains. */
export const CLOSE_RETRY: AnalysisCleanupRetry = { operation: "close_binary" };

/** The process-capture scope keeps failed leases for the next close_binary. */
const retainedProcessCleanup = (error: AnalysisError): AnalysisError =>
  error.cleanupIncomplete ? error.bindCleanupRetry(CLOSE_RETRY) : error;

/**
 * Close the session together with the process-capture resources it owns.
 * Both settle; a failed resource cleanup is kept for the next close_binary,
 * and what the session close completed (a saved snapshot, engine state
 * released unsaved) stays reported when only the resources failed.
 */
export const closeWithProcessResources =
  ({
    logger,
    closeProcessResources,
  }: Pick<SessionLifecycleOptions, "logger" | "closeProcessResources">) =>
  async <Value extends CloseValue>(
    closeSession: () => Promise<Result<Value, AnalysisError>>,
  ): Promise<Result<Value, AnalysisError>> => {
    const [sessionClose, resourceClose] = await Promise.allSettled([
      closeResult(closeSession),
      closeResult(closeProcessResources),
    ]);
    if (sessionClose.status === "rejected") {
      if (resourceClose.status === "rejected")
        logger.warn(
          {
            error: errorMessage(resourceClose.reason),
          },
          "Process capture cleanup threw while closing the session",
        );
      else if (!resourceClose.value.ok)
        logger.warn(
          { error: resourceClose.value.error.message },
          "Process capture cleanup failed while closing the session",
        );
      throw sessionClose.reason;
    }
    if (resourceClose.status === "rejected") throw resourceClose.reason;
    const closed = sessionClose.value;
    const resources = resourceClose.value;
    if (!closed.ok) {
      if (resources.ok) return closed;
      const combined = retainCloseOutcome(
        analysisErrorWithCleanupDependencies(closed.error, resources.error),
        closed,
      );
      // The session offers a retry only after retiring its target; a failed
      // save keeps that target open and needs its own recovery first.
      return err(
        closed.error.cleanupRetry === undefined
          ? combined
          : combined.bindCleanupRetry(CLOSE_RETRY),
      );
    }
    if (resources.ok) return closed;
    // The session closed: its snapshot and released-engine facts stay true.
    // Those facts are this close's. The cleanup error is shared with any
    // other close awaiting the same retry, so they are attached to a follower.
    return err(
      retainCloseOutcome(
        retainedProcessCleanup(processCaptureFailureForClose(resources.error)),
        closed,
      ),
    );
  };

/**
 * Retry the adapter-owned cleanup a reset joins under the session's drain.
 * Retry keeps the shared artifact scope open for the next investigation.
 */
export const resetCleanupRetry =
  (
    {
      artifactResources,
      closeProcessResources,
    }: Pick<
      SessionLifecycleOptions,
      "artifactResources" | "closeProcessResources"
    >,
    operation: string,
  ) =>
  async (): Promise<Result<null, AnalysisError>> => {
    const [process, artifacts] = await Promise.all([
      closeProcessResources(),
      artifactResources.retryCleanup().then(
        () => ok(null),
        (cause: unknown) => {
          const observation = ArtifactReaderFailure.cleanupObservation(
            cause,
            "MCP artifact resources",
          );
          const error = new ProviderCleanupError(
            "rea",
            observation.resources,
            { reason: observation.reason },
            { cause, operation },
          );
          bindArtifactFileCleanup(cause, error);
          return err(error);
        },
      ),
    ]);
    if (!process.ok && !artifacts.ok)
      return err(
        analysisErrorWithCleanupDependencies(
          process.error,
          artifacts.error,
          operation,
        ),
      );
    return process.ok ? artifacts : process;
  };
