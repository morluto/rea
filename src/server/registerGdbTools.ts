import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import type { Logger } from "pino";

import type { GdbSessionManager } from "../gdb/GdbSessionManager.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import { err } from "../domain/result.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import type { ToolResultDelivery } from "./toolResult.js";

/** Register persistent GDB session operations on the existing REA MCP server. */
export const registerGdbTools = (
  server: McpServer,
  manager: GdbSessionManager,
  logger: Logger,
  delivery: ToolResultDelivery,
  recordEvidence?: EvidenceWriter["recordEvidence"],
): void => {
  const start = toolContract("start_gdb_session");
  const consoleContract = toolContract("gdb_console");
  const status = toolContract("gdb_session_status");
  const close = toolContract("close_gdb_session");
  server.registerTool(
    start.name,
    toolRegistrationOptions(start),
    async (_input, context: ServerContext) => {
      const result = await logToolExecution(logger, start.name, () =>
        manager.start(context.mcpReq.signal),
      );
      return result.ok
        ? delivery.toCallToolResult({ ok: true, value: result.value }, start)
        : delivery.toCallToolResult(result, start);
    },
  );
  server.registerTool(
    consoleContract.name,
    toolRegistrationOptions(consoleContract),
    async (input, context: ServerContext) => {
      const result = await logToolExecution(logger, consoleContract.name, () =>
        manager.execute(input.session_id, input.command, context.mcpReq.signal),
      );
      if (!result.ok) return delivery.toCallToolResult(result, consoleContract);
      const recorded = recordEvidence?.(result.value.evidence);
      return delivery.toEvidenceToolResult(
        result.value.evidence,
        consoleContract,
        recorded,
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
          err(invalidSession("gdb_session_status")),
          status,
        );
      return delivery.toCallToolResult(
        {
          ok: true,
          value: {
            ...result,
            recent_mi_records: [...result.recent_mi_records],
          },
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

const invalidSession = (operation: string): AnalysisInputError =>
  new AnalysisInputError(operation);
