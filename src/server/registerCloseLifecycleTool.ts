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
  retryReverseEngineeringCleanup,
}: LifecycleToolRegistration): void => {
  const closeWithResources = async <Value>(
    closeSession: (
      afterResourceClose: () => Promise<void>,
    ) => Promise<Result<Value, AnalysisError>>,
    savedSnapshot?: (value: Value) => SavedAnalysisSnapshot,
  ): Promise<Result<Value, AnalysisError>> => {
    let reverseRetry:
      | Promise<PromiseSettledResult<Result<null, AnalysisError>>>
      | undefined;
    const retryReverse = async (): Promise<void> => {
      reverseRetry ??= Promise.allSettled([
        Promise.resolve().then(() =>
          closeResult(
            async () =>
              retryReverseEngineeringCleanup?.(closeContract.name) ?? ok(null),
          ),
        ),
      ]).then(([result]) => result!);
      await reverseRetry;
    };
    const [sessionClose, resourceClose] = await Promise.allSettled([
      closeResult(() => closeSession(retryReverse)),
      closeResult(closeProcessResources),
    ]);
    // Snapshot export/write or an unexpected session failure can return before
    // the resource-close hook. Retry those owners once after the transition.
    await retryReverse();
    const reverseCleanup = await reverseRetry!;
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
      if (reverseCleanup.status === "rejected")
        logger.warn(
          { error: String(reverseCleanup.reason) },
          "Reverse-engineering cleanup threw while closing the session",
        );
      else if (!reverseCleanup.value.ok)
        logger.warn(
          { error: reverseCleanup.value.error.message },
          "Reverse-engineering cleanup failed while closing the session",
        );
      throw sessionClose.reason;
    }
    if (resourceClose.status === "rejected") throw resourceClose.reason;
    if (reverseCleanup.status === "rejected") throw reverseCleanup.reason;
    const closed = sessionClose.value;
    const resources = resourceClose.value;
    const reverse = reverseCleanup.value;
    const failures: AnalysisError[] = [
      ...(reverse.ok ? [] : [reverse.error]),
      ...(closed.ok ? [] : [closed.error]),
      ...(resources.ok ? [] : [resources.error]),
    ];
    if (failures.length === 0) return closed;
    let combined = failures[0]!;
    for (const next of failures.slice(1)) {
      combined = analysisErrorWithCleanupFailure(
        combined,
        next,
      ).bindCleanupDependencies([combined, next]);
    }
    if (!closed.ok) {
      return err(
        closed.error.cleanupRetry === undefined
          ? combined
          : combined.bindCleanupRetry(CLOSE_RETRY),
      );
    }
    const retained = retainedProcessCleanup(combined);
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
          closeWithResources((afterResourceClose) =>
            session.close({
              progress,
              cleanupRetry: CLOSE_RETRY,
              afterResourceClose,
            }),
          ),
        );
        await reportOperationStart(progress, closeContract.name);
        const closed = await closing;
        await reportOperationEnd(progress, closeContract.name, closed.ok);
        return server.delivery.toCallToolResult(closed, closeContract);
      }
      const closing = logToolExecution(logger, closeContract.name, () =>
        closeWithResources(
          (afterResourceClose) =>
            session.closeWithSnapshot(snapshotPath, input.overwrite, {
              progress,
              cleanupRetry: CLOSE_RETRY,
              afterResourceClose,
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
