import {
  reportLifecycleEnd,
  reportLifecycleStart,
} from "./lifecycleProgress.js";
import { ok } from "../domain/result.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { Result } from "../domain/result.js";
import { mcpProgressReporter } from "./mcpProgress.js";
import type { LifecycleToolRegistration } from "./registerSessionTools.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

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
  ): Promise<Result<Value, AnalysisError>> => {
    const [sessionClose, resourceClose] = await Promise.allSettled([
      closeSession(),
      closeProcessResources(),
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
      if (!resources.ok)
        logger.warn(
          { error: resources.error.message },
          "Process capture cleanup failed while closing the session",
        );
      return closed;
    }
    return resources.ok ? closed : resources;
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
          closeWithResources(() => session.close({ progress })),
        );
        await reportLifecycleStart(progress, closeContract.name);
        const closed = await closing;
        await reportLifecycleEnd(progress, closeContract.name, closed.ok);
        return server.delivery.toCallToolResult(closed, closeContract);
      }
      const closing = logToolExecution(logger, closeContract.name, () =>
        closeWithResources(() =>
          session.closeWithSnapshot(snapshotPath, input.overwrite, {
            progress,
          }),
        ),
      );
      await reportLifecycleStart(
        progress,
        closeContract.name,
        "saving snapshot; closing provider",
      );
      const closed = await closing;
      await reportLifecycleEnd(progress, closeContract.name, closed.ok);
      return server.delivery.toCallToolResult(
        closed.ok ? ok({ ...closed.value }) : closed,
        closeContract,
      );
    },
  );
};
