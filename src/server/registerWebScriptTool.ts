import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import type { McpServer } from "@modelcontextprotocol/server";

import { exportWebScriptsValidated } from "../application/WebScriptExportService.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "../logger.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { toCallToolResult, toEvidenceToolResult } from "./toolResult.js";

/** Register local script export without requiring a live browser provider. */
export const registerWebScriptTool = (
  server: McpServer,
  options: {
    readonly logger: Logger;
    readonly recordEvidence: EvidenceWriter["recordEvidence"] | undefined;
  },
): void => {
  const contract = toolContract("export_web_scripts");
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) => {
      const result = await logToolExecution(options.logger, contract.name, () =>
        exportWebScriptsValidated(input, { signal: context.mcpReq.signal }),
      );
      if (!result.ok) return toCallToolResult(result, contract);
      const recorded = options.recordEvidence?.(result.value);
      return toEvidenceToolResult(result.value, contract, recorded);
    },
  );
};
