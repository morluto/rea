import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import type { Logger } from "pino";

import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import type { RizinDebugSessionManager } from "../rizin/RizinDebugSessionManager.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import type { ToolResultDelivery } from "./toolResult.js";

/** Register persistent Rizin debugger operations on the existing REA MCP server. */
export const registerRizinDebugTools = (
  server: McpServer,
  manager: RizinDebugSessionManager,
  logger: Logger,
  delivery: ToolResultDelivery,
  recordEvidence?: EvidenceWriter["recordEvidence"],
): void => {
  const start = toolContract("start_rizin_debug_session");
  const command = toolContract("rizin_debug_command");
  const status = toolContract("rizin_debug_session_status");
  const close = toolContract("close_rizin_debug_session");
  server.registerTool(
    start.name,
    toolRegistrationOptions(start),
    async (input, context: ServerContext) => {
      const result = await logToolExecution(logger, start.name, () =>
        manager.start(
          {
            path: input.path,
            ...(input.backend === undefined ? {} : { backend: input.backend }),
          },
          context.mcpReq.signal,
        ),
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
      const result = await logToolExecution(logger, command.name, () =>
        manager.execute(input.session_id, input.command, context.mcpReq.signal),
      );
      if (!result.ok) return delivery.toCallToolResult(result, command);
      return delivery.toEvidenceToolResult(
        result.value.evidence,
        command,
        recordEvidence?.(result.value.evidence),
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
    async (input) => {
      const result = await logToolExecution(logger, close.name, () =>
        manager.close(input.session_id),
      );
      return result.ok
        ? delivery.toCallToolResult({ ok: true, value: result.value }, close)
        : delivery.toCallToolResult(result, close);
    },
  );
};
