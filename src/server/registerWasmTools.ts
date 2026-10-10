import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

import type { WasmArtifactService } from "../application/wasm/WasmArtifactService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Bind the named WASM contract to shared validation and session Evidence recording. */
export const registerWasmTools = (
  server: EvidenceMcpServer,
  service: WasmArtifactService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
): void => {
  const contract = toolContract("inspect_wasm_artifact");
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
