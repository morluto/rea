import { writeAnalysisSnapshot } from "../application/AnalysisSnapshotFiles.js";
import { closeBinaryInputSchema } from "../contracts/sessionLifecycleInputs.js";
import { ok } from "../domain/result.js";
import {
  reportLifecycleEnd,
  reportLifecycleStart,
} from "./lifecycleProgress.js";
import { logToolExecution } from "./toolLogging.js";
import { toCallToolResult } from "./toolResult.js";
import { mcpProgressReporter } from "./mcpProgress.js";
import { permissionFailure } from "./permissionFailure.js";
import type { LifecycleToolRegistration } from "./registerSessionTools.js";
import { safeParseToolInput } from "./toolInputValidation.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

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
      const parsedInput = safeParseToolInput(
        closeBinaryInputSchema,
        input,
        closeContract.name,
      );
      if (!parsedInput.ok) return toCallToolResult(parsedInput, closeContract);
      const parsed = parsedInput.value;
      const progress = mcpProgressReporter(context);
      if (parsed.snapshot_path === undefined) {
        await reportLifecycleStart(progress, closeContract.name);
        const closed = await logToolExecution(logger, closeContract.name, () =>
          session.close({ progress }),
        );
        await reportLifecycleEnd(progress, closeContract.name, closed.ok);
        server.sendToolListChanged();
        return toCallToolResult(closed, closeContract);
      }
      if (permissionAuthority !== undefined) {
        const authorized = await permissionAuthority.authorize(
          {
            capability: "snapshot_write",
            roots: [parsed.snapshot_path],
            executables: [],
            environment_names: [],
            network: "none",
            mount: false,
            operation_identity: `close_binary:snapshot:${parsed.snapshot_path}`,
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
        parsed.snapshot_path,
        parsed.overwrite,
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
      server.sendToolListChanged();
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
