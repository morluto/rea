import type { McpServer } from "@modelcontextprotocol/server";

import type { AnalysisOperationPort } from "../application/AnalysisProvider.js";
import {
  OFFICIAL_TOOL_CONTRACTS,
  type ToolContract,
} from "../contracts/toolContracts.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { toCallToolResult } from "./toolResult.js";
import type { Logger } from "../logger.js";
import { logToolExecution } from "./toolLogging.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import { createEvidence } from "../domain/evidence.js";
import type { ProviderIdentity } from "../application/AnalysisProvider.js";
import type { Evidence } from "../domain/evidence.js";

/** Register direct bridge proxies, preserving MCP cancellation and typed errors. */
export const registerOfficialTools = (
  server: McpServer,
  analysis: AnalysisOperationPort,
  logger: Logger,
  activeTarget?: () => BinaryTarget | undefined,
  provider: ProviderIdentity = {
    id: "unidentified",
    name: "Unidentified provider",
    version: null,
  },
  recordEvidence?: (evidence: Evidence) => void,
): void => {
  for (const contract of OFFICIAL_TOOL_CONTRACTS) {
    registerOfficialTool(server, analysis, contract, {
      logger,
      activeTarget,
      provider,
      recordEvidence,
    });
  }
};

const registerOfficialTool = (
  server: McpServer,
  analysis: AnalysisOperationPort,
  contract: ToolContract,
  registration: {
    readonly logger: Logger;
    readonly activeTarget: (() => BinaryTarget | undefined) | undefined;
    readonly provider: ProviderIdentity;
    readonly recordEvidence: ((evidence: Evidence) => void) | undefined;
  },
): void => {
  server.registerTool(
    contract.name,
    {
      description: contract.description,
      inputSchema: contract.inputSchema,
      outputSchema: contract.outputSchema,
      annotations: contract.annotations,
    },
    async (input, context) => {
      const arguments_ = projectOfficialArguments(contract, input);
      const result = await logToolExecution(
        registration.logger,
        contract.name,
        () =>
          analysis.execute(contract.name, arguments_, {
            signal: context.mcpReq.signal,
          }),
      );
      if (result.ok) {
        const evidence = createEvidence(
          registration.activeTarget?.(),
          registration.provider,
          {
            operation: contract.name,
            parameters: arguments_,
            result: result.value,
            redactedRawPayload: result.value,
          },
        );
        registration.recordEvidence?.(evidence);
        return toCallToolResult({ ok: true, value: evidence }, contract);
      }
      return toCallToolResult(result, contract);
    },
  );
};

const projectOfficialArguments = (
  contract: ToolContract,
  input: unknown,
): Readonly<Record<string, JsonValue>> => {
  const parsed = jsonValueSchema.safeParse(input);
  if (
    !parsed.success ||
    typeof parsed.data !== "object" ||
    parsed.data === null ||
    Array.isArray(parsed.data)
  ) {
    // The SDK validates this with the same schema before invoking the callback.
    throw new Error("Validated MCP tool input was not a JSON object");
  }

  const projected: Record<string, JsonValue> = {};
  for (const key of Object.keys(contract.inputSchema.shape)) {
    projected[key] = parsed.data[key] ?? null;
  }
  return projected;
};
