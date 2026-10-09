import type { McpServer } from "@modelcontextprotocol/server";
import type { Logger } from "pino";

import type { CutterBridgeService } from "../cutter/CutterBridgeService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import { ok } from "../domain/result.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import type { ToolResultDelivery } from "./toolResult.js";

/** Register Cutter discovery and command tools against their named contracts. */
export const registerCutterTools = (
  server: McpServer,
  service: CutterBridgeService,
  logger: Logger,
  delivery: ToolResultDelivery,
  recordEvidence?: EvidenceWriter["recordEvidence"],
): void => {
  const list = toolContract("list_cutter_sessions");
  const command = toolContract("cutter_command");
  server.registerTool(list.name, toolRegistrationOptions(list), async () => {
    const result = await logToolExecution(logger, list.name, async () =>
      ok(await service.listSessions()),
    );
    if (!result.ok) return delivery.toCallToolResult(result, list);
    return delivery.toCallToolResult(
      {
        ok: true,
        value: { ...result.value, sessions: [...result.value.sessions] },
      },
      list,
    );
  });
  server.registerTool(
    command.name,
    toolRegistrationOptions(command),
    async (input, context) => {
      const result = await logToolExecution(logger, command.name, () =>
        service.execute(input, { signal: context.mcpReq.signal }),
      );
      if (!result.ok) return delivery.toCallToolResult(result, command);
      return delivery.toEvidenceToolResult(
        result.value,
        command,
        recordEvidence?.(result.value),
      );
    },
  );
};
