import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import type { ServerContext } from "@modelcontextprotocol/server";
import { ApktoolResourceAnalysisService } from "../application/apktool/ApktoolResourceAnalysisService.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { ToolContract } from "../contracts/toolContractTypes.js";
import type { ApktoolOperation } from "../domain/apktool/apktoolResourceAnalysis.js";
import type { Logger } from "pino";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Bind Apktool handlers to their exact named contracts. */
export const registerApktoolTools = (
  server: EvidenceMcpServer,
  service: ApktoolResourceAnalysisService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
): void => {
  const handler = (contract: ToolContract<ApktoolOperation>) => {
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
  for (const contract of [
    toolContract("inspect_apktool_client"),
    toolContract("decode_android_resources"),
  ] as const) {
    server.registerTool(
      contract.name,
      toolRegistrationOptions(contract),
      handler(contract),
    );
  }
};
