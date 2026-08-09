import { writeAnalysisSnapshot } from "../application/AnalysisSnapshotFiles.js";
import { ok } from "../domain/result.js";
import {
  reportLifecycleEnd,
  reportLifecycleStart,
} from "./lifecycleProgress.js";
import { mcpProgressReporter } from "./mcpProgress.js";
import { permissionFailure } from "./permissionFailure.js";
import type { LifecycleToolRegistration } from "./registerSessionTools.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { toCallToolResult } from "./toolResult.js";

/** Register provider cleanup and optional pre-close snapshot persistence. */
export const registerCloseLifecycleTool = ({
  server,
  session,
  logger,
  contracts: [, closeContract],
  snapshotFilePolicy,
  permissionAuthority,
}: LifecycleToolRegistration): void => {
  server.registerTool(
    closeContract.name,
    toolRegistrationOptions(closeContract),
    async (input, context) => {
      const progress = mcpProgressReporter(context);
      if (input.snapshot_path === undefined) {
        await reportLifecycleStart(progress, closeContract.name);
        const closed = await logToolExecution(logger, closeContract.name, () =>
          session.close({ progress }),
        );
        await reportLifecycleEnd(progress, closeContract.name, closed.ok);
        return toCallToolResult(closed, closeContract);
      }
      if (permissionAuthority !== undefined) {
        const authorized = await permissionAuthority.authorize(
          {
            capability: "snapshot_write",
            roots: [input.snapshot_path],
            executables: [],
            environment_names: [],
            network: "none",
            mount: false,
            operation_identity: `close_binary:snapshot:${input.snapshot_path}`,
          },
          "write",
        );
        if (!authorized.ok)
          return toCallToolResult(permissionFailure(authorized), closeContract);
      }
      const snapshot = session.exportAnalysisSnapshot();
      if (!snapshot.ok) return toCallToolResult(snapshot, closeContract);
      const written = await writeAnalysisSnapshot(
        snapshot.value,
        input.snapshot_path,
        input.overwrite,
        snapshotFilePolicy,
      );
      if (!written.ok) return toCallToolResult(written, closeContract);
      await reportLifecycleStart(
        progress,
        closeContract.name,
        "snapshot written; closing provider",
      );
      const closed = await logToolExecution(logger, closeContract.name, () =>
        session.close({ progress }),
      );
      await reportLifecycleEnd(progress, closeContract.name, closed.ok);
      return closed.ok
        ? toCallToolResult(
            ok({
              path: written.value.path,
              bytes: written.value.bytes,
              entries: snapshot.value.entries.length,
            }),
            closeContract,
          )
        : toCallToolResult(closed, closeContract);
    },
  );
};
