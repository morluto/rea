import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import type { ServerContext } from "@modelcontextprotocol/server";
import { AdbDeviceAnalysisService } from "../application/adb/AdbDeviceAnalysisService.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { ToolContract } from "../contracts/toolContractTypes.js";
import type { AdbOperation } from "../domain/adb/adbDeviceAnalysis.js";
import type { Logger } from "pino";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Bind ADB handlers to their exact named contracts through shared workflows. */
export const registerAdbTools = (
  server: EvidenceMcpServer,
  service: AdbDeviceAnalysisService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
): void => {
  const handler = (contract: ToolContract<AdbOperation>) => {
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
    toolContract("inspect_adb_client"),
    toolContract("list_adb_devices"),
    toolContract("inspect_adb_device"),
    toolContract("list_adb_packages"),
    toolContract("pull_adb_package"),
  ] as const) {
    server.registerTool(
      contract.name,
      toolRegistrationOptions(contract),
      handler(contract),
    );
  }
};
