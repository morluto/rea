import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import type { Logger } from "pino";

import type { LldbSessionManager } from "../lldb/LldbSessionManager.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import { evidenceSchema } from "../domain/evidence.js";
import { err } from "../domain/result.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import {
  runOwnedCleanupWithExternalMutationAdmission,
  runWithExternalMutationAdmission,
  type ExternalMutationAdmission,
} from "./externalMutationAdmission.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import type { ToolResultDelivery } from "./ToolResultDelivery.js";

export type LldbToolManager = Pick<
  LldbSessionManager,
  "start" | "execute" | "status" | "close" | "retryCleanupFailures"
>;

/**
 * Register persistent LLDB session operations on the existing REA MCP server.
 * Contributed by Hardik Shah <hardik05@gmail.com> (https://fuzzing.in, @hardik05).
 */
export const registerLldbTools = (
  server: McpServer,
  manager: LldbToolManager,
  logger: Logger,
  delivery: ToolResultDelivery,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  session?: ExternalMutationAdmission,
): void => {
  const start = toolContract("start_lldb_session");
  const commandContract = toolContract("lldb_command");
  const status = toolContract("lldb_session_status");
  const close = toolContract("close_lldb_session");

  server.registerTool(
    start.name,
    toolRegistrationOptions(start),
    async (input, context: ServerContext) => {
      const result = await runWithExternalMutationAdmission(
        session,
        start.name,
        context.mcpReq.signal,
        () =>
          logToolExecution(logger, start.name, () =>
            manager.start(context.mcpReq.signal, {
              ...(input.path !== undefined && { path: input.path }),
              ...(input.args !== undefined && { args: input.args }),
              ...(input.env !== undefined && { env: input.env }),
              ...(input.pid !== undefined && { pid: input.pid }),
              ...(input.stop_at_entry !== undefined && {
                stop_at_entry: input.stop_at_entry,
              }),
              ...(input.disable_aslr !== undefined && {
                disable_aslr: input.disable_aslr,
              }),
              ...(input.breakpoints !== undefined && {
                breakpoints: input.breakpoints,
              }),
            }),
          ),
        undefined,
        () => manager.retryCleanupFailures(),
      );
      if (result.ok) {
        return delivery.toCallToolResult(
          {
            ok: true,
            value: {
              session_id: result.value.session_id,
              state: result.value.state,
              ...(result.value.pid !== undefined && { pid: result.value.pid }),
              ...(result.value.target !== undefined && {
                target: result.value.target,
              }),
            },
          },
          start,
        );
      }
      const partial = result.error.partialObservation;
      const parsed = evidenceSchema.safeParse(partial);
      if (parsed.success) {
        const recorded = recordEvidence?.(parsed.data);
        if (recorded !== undefined) {
          return delivery.toRecordedPartialErrorToolResult(
            result.error,
            parsed.data.evidence_id,
            recorded,
            start.returnsTargetContent,
          );
        }
      }
      return delivery.toCallToolResult(result, start);
    },
  );

  server.registerTool(
    commandContract.name,
    toolRegistrationOptions(commandContract),
    async (input, context: ServerContext) => {
      const execute = () =>
        logToolExecution(logger, commandContract.name, () =>
          manager.execute(
            input.session_id,
            input.command,
            context.mcpReq.signal,
          ),
        );
      const result = await runWithExternalMutationAdmission(
        session,
        commandContract.name,
        context.mcpReq.signal,
        execute,
        (value) => value.evidence,
        () => manager.retryCleanupFailures(),
      );
      if (!result.ok) {
        const partial = result.error.partialObservation;
        const parsed = evidenceSchema.safeParse(partial);
        if (parsed.success) {
          const recorded = recordEvidence?.(parsed.data);
          if (recorded !== undefined) {
            return delivery.toRecordedPartialErrorToolResult(
              result.error,
              parsed.data.evidence_id,
              recorded,
              commandContract.returnsTargetContent,
            );
          }
        }
        return delivery.toCallToolResult(result, commandContract);
      }
      const recorded = recordEvidence?.(result.value.evidence);
      return delivery.toEvidenceToolResult(
        result.value.evidence,
        commandContract,
        recorded,
      );
    },
  );

  server.registerTool(
    status.name,
    toolRegistrationOptions(status),
    async (input) => {
      const result = await manager.status(input.session_id);
      if (result === undefined) {
        return delivery.toCallToolResult(
          err(invalidSession("lldb_session_status")),
          status,
        );
      }
      return delivery.toCallToolResult(
        {
          ok: true,
          value: {
            session_id: result.session_id,
            state: result.state,
            process_state: result.process_state,
            pid: result.pid,
            target: result.target,
          },
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

const invalidSession = (operation: string): AnalysisInputError =>
  new AnalysisInputError(operation);
