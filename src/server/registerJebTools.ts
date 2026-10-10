import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import type { ServerContext } from "@modelcontextprotocol/server";
import { JebAnalysisService } from "../application/jeb/JebAnalysisService.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { ToolContract } from "../contracts/toolContractTypes.js";
import type { JebOperation } from "../domain/jeb/jebAnalysis.js";
import type { Logger } from "pino";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Bind JEB handlers to their exact named contracts through shared workflows. */
export const registerJebTools = (
  server: EvidenceMcpServer,
  service: JebAnalysisService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
): void => {
  const handler = (contract: ToolContract<JebOperation>) => {
    const name = contract.name;
    return async (input: unknown, context: ServerContext) => {
      const result = await logToolExecution(logger, name, () =>
        service.execute(name, input, { signal: context.mcpReq.signal }),
      );
      if (!result.ok) return server.delivery.toCallToolResult(result, contract);
      const recorded = recordEvidence?.(result.value);
      return server.delivery.toEvidenceToolResult(
        result.value,
        contract,
        recorded,
      );
    };
  };
  const clientContract = toolContract("inspect_jeb_client");
  server.registerTool(
    clientContract.name,
    toolRegistrationOptions(clientContract),
    handler(clientContract),
  );
  const openContract = toolContract("open_jeb_project");
  server.registerTool(
    openContract.name,
    toolRegistrationOptions(openContract),
    handler(openContract),
  );
  const unitsContract = toolContract("list_jeb_units");
  server.registerTool(
    unitsContract.name,
    toolRegistrationOptions(unitsContract),
    handler(unitsContract),
  );
  const decompileContract = toolContract("decompile_jeb_item");
  server.registerTool(
    decompileContract.name,
    toolRegistrationOptions(decompileContract),
    handler(decompileContract),
  );
};
