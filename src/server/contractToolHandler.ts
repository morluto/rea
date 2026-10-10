import type { ServerContext } from "@modelcontextprotocol/server";
import type { Logger } from "pino";

import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import type { ToolContract } from "../contracts/toolContractTypes.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { Evidence } from "../domain/evidence.js";
import type { Result } from "../domain/result.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import { logToolExecution } from "./toolLogging.js";

/** Application service executing one named contract operation. */
export interface ContractToolService<TOperation extends string> {
  execute(
    operation: TOperation,
    input: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>>;
}

/**
 * Bind one service-backed handler to its exact named contract through the
 * shared log/execute/record/deliver workflow.
 */
export const createContractToolHandler =
  <TOperation extends string>(
    server: EvidenceMcpServer,
    service: ContractToolService<TOperation>,
    logger: Logger,
    recordEvidence?: EvidenceWriter["recordEvidence"],
  ) =>
  (contract: ToolContract<TOperation>) => {
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
