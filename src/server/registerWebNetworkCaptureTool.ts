import type {
  McpServer,
  StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import type { WebNetworkCaptureService } from "../application/WebNetworkCaptureService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "../logger.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { toCallToolResult, toEvidenceToolResult } from "./toolResult.js";

/** Bind historical inspection to its named contract and caller-owned Evidence writer. */
export const registerWebNetworkCaptureTool = (
  server: McpServer,
  service: WebNetworkCaptureService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
): void => {
  const contract = toolContract("inspect_web_network_capture");
  const registration = toolRegistrationOptions(contract);
  // Keep the exact advertised contract; the shared service validates raw input
  // before effects so caller-declared sensitivity also covers invalid arguments.
  // SDK pre-validation otherwise emits unprojected issue paths as plain text.
  const inputSchema: StandardSchemaWithJSON = {
    "~standard": {
      ...registration.inputSchema["~standard"],
      vendor: "rea-application",
      validate: (value: unknown) => ({ value }),
    },
  };
  server.registerTool(
    contract.name,
    { ...registration, inputSchema },
    async (input, context) => {
      const result = await logToolExecution(logger, contract.name, () =>
        service.inspect(input, { signal: context.mcpReq.signal }),
      );
      if (!result.ok) return toCallToolResult(result, contract);
      const recorded = recordEvidence?.(result.value);
      return toEvidenceToolResult(result.value, contract, recorded);
    },
  );
};
