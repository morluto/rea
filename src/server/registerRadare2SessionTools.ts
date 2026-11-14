import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import type { Logger } from "pino";

import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import {
  AnalysisInputError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import type { Radare2SessionManager } from "../radare2/Radare2SessionManager.js";
import {
  runOwnedCleanupWithExternalMutationAdmission,
  runWithExternalMutationAdmission,
  type ExternalMutationAdmission,
} from "./externalMutationAdmission.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import type { ToolResultDelivery } from "./ToolResultDelivery.js";

export type Radare2SessionToolManager = Pick<
  Radare2SessionManager,
  "start" | "execute" | "status" | "close" | "retryCleanupFailures"
>;

/** Register persistent Radare2 analysis session operations on the REA MCP server. */
export const registerRadare2SessionTools = (
  server: McpServer,
  manager: Radare2SessionToolManager,
  logger: Logger,
  delivery: ToolResultDelivery,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  session?: ExternalMutationAdmission,
): void => {
  const start = toolContract("start_radare2_session");
  const command = toolContract("radare2_command");
  const status = toolContract("radare2_session_status");
  const close = toolContract("close_radare2_session");
  server.registerTool(
    start.name,
    toolRegistrationOptions(start),
    async (input, context: ServerContext) => {
      const result = await runWithExternalMutationAdmission(
        session,
        start.name,
        context.mcpReq.signal,
        () =>
          logToolExecution(logger, start.name, async () => {
            const started = await manager.start(
              { path: input.path },
              context.mcpReq.signal,
            );
            if (!started.ok || input.initial_commands === undefined)
              return started;
            for (const initialCommand of input.initial_commands) {
              const executed = await manager.execute(
                started.value.session_id,
                initialCommand,
                context.mcpReq.signal,
              );
              if (
                executed.ok &&
                !executed.value.result.command_error &&
                executed.value.result.completion_status === "complete"
              )
                continue;
              const closed = await manager
                .close(started.value.session_id)
                .catch(() => undefined);
              if (!executed.ok) return executed;
              const failure = new AnalysisOutputError(
                start.name,
                executed.value.result.completion_status === "unknown"
                  ? `An initial Radare2 command could not complete (output or frame limit reached): ${initialCommand}`
                  : `An initial Radare2 command reported an error: ${executed.value.result.command_logs.map((log) => log.message).join("; ") || executed.value.result.command}`,
                { partialObservation: executed.value.evidence },
              );
              // A failed close keeps the engine owned; retaining its cleanup
              // state keeps the unresolved resource visible and retryable.
              // Bind to the manager-retained failure so a verified retry also
              // clears this wrapper's cleanup status; otherwise the session
              // surface stays blocked after the engine is actually stopped.
              return {
                ...executed,
                ok: false as const,
                error:
                  closed === undefined || closed.ok
                    ? failure
                    : analysisErrorWithCleanupFailure(
                        failure,
                        closed.error,
                        start.name,
                      ).bindCleanupDependencies([closed.error]),
              };
            }
            return started;
          }),
        undefined,
        () => manager.retryCleanupFailures(),
        (value) => ({ session_id: value.session_id }),
      );
      return result.ok
        ? delivery.toCallToolResult({ ok: true, value: result.value }, start)
        : delivery.toCallToolResult(result, start);
    },
  );
  server.registerTool(
    command.name,
    toolRegistrationOptions(command),
    async (input, context: ServerContext) => {
      const result = await runWithExternalMutationAdmission(
        session,
        command.name,
        context.mcpReq.signal,
        () =>
          logToolExecution(logger, command.name, () =>
            manager.execute(
              input.session_id,
              input.command,
              context.mcpReq.signal,
            ),
          ),
        (value) => value.evidence,
        () => manager.retryCleanupFailures(),
      );
      if (!result.ok)
        return delivery.toPartialErrorToolResult(
          result.error,
          command.returnsTargetContent,
          recordEvidence,
        );
      const evidence = result.value.evidence;
      return delivery.toEvidenceToolResult(
        evidence,
        command,
        recordEvidence?.(evidence),
      );
    },
  );
  server.registerTool(
    status.name,
    toolRegistrationOptions(status),
    async (input) => {
      const result = manager.status(input.session_id);
      if (result === undefined)
        return delivery.toCallToolResult(
          { ok: false, error: new AnalysisInputError(status.name) },
          status,
        );
      return delivery.toCallToolResult(
        {
          ok: true,
          value: { ...result, recent_output: [...result.recent_output] },
        },
        status,
      );
    },
  );
  server.registerTool(
    close.name,
    toolRegistrationOptions(close),
    async (input, context: ServerContext) => {
      const result = await runOwnedCleanupWithExternalMutationAdmission(
        session,
        close.name,
        context.mcpReq.signal,
        input.session_id,
        () =>
          logToolExecution(logger, close.name, () =>
            manager.close(input.session_id),
          ),
      );
      return result.ok
        ? delivery.toCallToolResult({ ok: true, value: result.value }, close)
        : delivery.toCallToolResult(result, close);
    },
  );
};
