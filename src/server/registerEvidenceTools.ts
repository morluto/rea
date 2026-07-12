import type { McpServer } from "@modelcontextprotocol/server";

import type {
  AnalysisOperation,
  AnalysisOperationPort,
} from "../application/AnalysisProvider.js";
import type { BinarySessionPort } from "../application/BinarySession.js";
import type { ToolContract } from "../contracts/toolContracts.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import { createEvidence } from "../domain/evidence.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import type { Logger } from "../logger.js";
import { logToolExecution } from "./toolLogging.js";
import { toCallToolResult } from "./toolResult.js";

interface EvidenceToolRegistration {
  readonly logger: Logger;
  readonly activeTarget: (() => BinaryTarget | undefined) | undefined;
  readonly recordEvidence: BinarySessionPort["recordEvidence"] | undefined;
}

/** Register provider-backed contracts that return atomic Evidence v2 observations. */
export const registerEvidenceTools = (
  server: McpServer,
  analysis: AnalysisOperationPort,
  contracts: readonly ToolContract<Exclude<AnalysisOperation, "health">>[],
  options: EvidenceToolRegistration,
): void => {
  for (const contract of contracts) {
    server.registerTool(
      contract.name,
      {
        description: contract.description,
        inputSchema: contract.inputSchema,
        outputSchema: contract.outputSchema,
        annotations: contract.annotations,
      },
      async (input, context) => {
        const parameters = jsonObject(contract.inputSchema.parse(input));
        const execution = await logToolExecution(
          options.logger,
          contract.name,
          () =>
            analysis.execute(contract.name, parameters, {
              signal: context.mcpReq.signal,
            }),
        );
        if (!execution.ok) return toCallToolResult(execution, contract);
        const evidence = createEvidence(
          execution.value.subject ?? options.activeTarget?.(),
          execution.value.provider,
          {
            operation: contract.name,
            parameters,
            result: execution.value.result,
            rawResult: execution.value.rawResult,
            limitations: execution.value.limitations,
            locations: execution.value.locations,
          },
        );
        const recorded = options.recordEvidence?.(evidence);
        return recorded !== undefined && !recorded.ok
          ? toCallToolResult(recorded, contract)
          : toCallToolResult({ ok: true, value: evidence }, contract);
      },
    );
  }
};

const jsonObject = (input: unknown): Readonly<Record<string, JsonValue>> => {
  const parsed = jsonValueSchema.parse(input);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new TypeError("Provider tool input was not an object");
  return parsed;
};
