import {
  retainSavedAnalysisSnapshot,
  type SavedAnalysisSnapshot,
} from "../domain/savedAnalysisSnapshot.js";
import {
  reportOperationEnd,
  reportOperationStart,
} from "./operationProgress.js";
import { err, ok } from "../domain/result.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import type { AnalysisCleanupRetry } from "../domain/analysisErrorRecovery.js";
import type { Result } from "../domain/result.js";
import { mcpProgressReporter } from "./mcpProgress.js";
import type { LifecycleToolRegistration } from "./registerSessionTools.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

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

/** This tool retries the session and process-capture cleanup it retains. */
const CLOSE_RETRY: AnalysisCleanupRetry = { operation: "close_binary" };

/** The process-capture scope keeps failed leases for the next close_binary. */
const retainedProcessCleanup = (error: AnalysisError): AnalysisError =>
  error.cleanupIncomplete ? error.bindCleanupRetry(CLOSE_RETRY) : error;

/** Register provider cleanup and optional pre-close snapshot persistence. */
export const registerCloseLifecycleTool = ({
  server,
  session,
  logger,
  closeContract,
  closeProcessResources,
}: LifecycleToolRegistration): void => {
  const closeWithResources = async <Value>(
    closeSession: () => Promise<Result<Value, AnalysisError>>,
    savedSnapshot?: (value: Value) => SavedAnalysisSnapshot,
  ): Promise<Result<Value, AnalysisError>> => {
    const [sessionClose, resourceClose] = await Promise.allSettled([
      closeResult(closeSession),
      closeResult(closeProcessResources),
    ]);
    if (sessionClose.status === "rejected") {
      if (resourceClose.status === "rejected")
        logger.warn(
          {
            error:
              resourceClose.reason instanceof Error
                ? resourceClose.reason.message
                : String(resourceClose.reason),
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
      const combined = analysisErrorWithCleanupFailure(
        closed.error,
        resources.error,
      ).bindCleanupDependencies([closed.error, resources.error]);
      // The session offers a retry only after retiring its target; a failed
      // save keeps that target open and needs its own recovery first.
      return err(
        closed.error.cleanupRetry === undefined
          ? combined
          : combined.bindCleanupRetry(CLOSE_RETRY),
      );
    }
    if (resources.ok) return closed;
    const retained = retainedProcessCleanup(resources.error);
    return err(
      savedSnapshot === undefined
        ? retained
        : retainSavedAnalysisSnapshot(retained, savedSnapshot(closed.value)),
    );
  };
  server.registerTool(
    closeContract.name,
    toolRegistrationOptions(closeContract),
    async (input, context) => {
      const progress = mcpProgressReporter(context);
      const snapshotPath = input.snapshot_path;
      if (snapshotPath === undefined) {
        // Enqueue the lifecycle transition before awaiting progress transport so
        // a later open request cannot overtake this close.
        const closing = logToolExecution(logger, closeContract.name, () =>
          closeWithResources(() =>
            session.close({ progress, cleanupRetry: CLOSE_RETRY }),
          ),
        );
        await reportOperationStart(progress, closeContract.name);
        const closed = await closing;
        await reportOperationEnd(progress, closeContract.name, closed.ok);
        return server.delivery.toCallToolResult(closed, closeContract);
      }
      const closing = logToolExecution(logger, closeContract.name, () =>
        closeWithResources(
          () =>
            session.closeWithSnapshot(snapshotPath, input.overwrite, {
              progress,
              cleanupRetry: CLOSE_RETRY,
            }),
          (receipt) => receipt,
        ),
      );
      await reportOperationStart(
        progress,
        closeContract.name,
        "saving snapshot; closing provider",
      );
      const closed = await closing;
      await reportOperationEnd(progress, closeContract.name, closed.ok);
      return server.delivery.toCallToolResult(
        closed.ok ? ok({ ...closed.value }) : closed,
        closeContract,
      );
    },
  );
};
