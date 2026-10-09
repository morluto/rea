import {
  reportLifecycleEnd,
  reportLifecycleStart,
} from "./lifecycleProgress.js";
import { ok } from "../domain/result.js";
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
}: LifecycleToolRegistration): void => {
  server.registerTool(
    closeContract.name,
    toolRegistrationOptions(closeContract),
    async (input, context) => {
      const progress = mcpProgressReporter(context);
      const snapshotPath = input.snapshot_path;
      if (snapshotPath === undefined) {
        await reportLifecycleStart(progress, closeContract.name);
        const closed = await logToolExecution(logger, closeContract.name, () =>
          session.close({ progress }),
        );
        await reportLifecycleEnd(progress, closeContract.name, closed.ok);
        return server.delivery.toCallToolResult(closed, closeContract);
      }
      await reportLifecycleStart(
        progress,
        closeContract.name,
        "saving snapshot; closing provider",
      );
      const closed = await logToolExecution(logger, closeContract.name, () =>
        session.closeWithSnapshot(snapshotPath, input.overwrite, {
          progress,
        }),
      );
      await reportLifecycleEnd(progress, closeContract.name, closed.ok);
      return server.delivery.toCallToolResult(
        closed.ok ? ok({ ...closed.value }) : closed,
        closeContract,
      );
    },
  );
};
