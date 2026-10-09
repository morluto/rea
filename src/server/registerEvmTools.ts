import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

import type { EvmInterfaceService } from "../application/evm/EvmInterfaceService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "../logger.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Bind the named EVM contract to shared validation and session Evidence recording. */
export const registerEvmTools = (
  server: EvidenceMcpServer,
  service: EvmInterfaceService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
): void => {
  const contract = toolContract("inspect_evm_interface");
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) => {
      const result = await logToolExecution(logger, contract.name, () =>
        service.inspect(input, { signal: context.mcpReq.signal }),
      );
      if (!result.ok) return server.delivery.toCallToolResult(result, contract);
      const recorded = recordEvidence?.(result.value);
      return server.delivery.toEvidenceToolResult(
        result.value,
        contract,
        recorded,
      );
    },
  );
};
