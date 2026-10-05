import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import type {
  AnalysisExecution,
  AnalysisOperationPort,
} from "../application/AnalysisProvider.js";
import type { BinarySessionPort } from "../application/BinarySession.js";
import type { ProgressReporter } from "../application/ProgressReporter.js";
import type { ToolContract } from "../contracts/toolContracts.js";
import { OFFICIAL_TOOL_CONTRACTS } from "../contracts/officialToolContracts.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import type { AnalysisError } from "../domain/errors.js";
import { createEvidence } from "../domain/evidence.js";
import {
  jsonObjectSchema,
  jsonValueSchema,
  type JsonValue,
} from "../domain/jsonValue.js";
import type { Result } from "../domain/result.js";
import type { Logger } from "../logger.js";
import { mcpProgressReporter } from "./mcpProgress.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { toCallToolResult } from "./toolResult.js";

/** Optional session services used by direct tool registration. */
export interface OfficialToolRegistration {
  readonly logger: Logger;
  readonly activeTarget: (() => BinaryTarget | undefined) | undefined;
  readonly recordEvidence: BinarySessionPort["recordEvidence"] | undefined;
}

/** Register direct bridge proxies, preserving MCP cancellation and typed errors. */
export const registerOfficialTools = (
  server: McpServer,
  analysis: AnalysisOperationPort,
  options: OfficialToolRegistration,
): void => {
  for (const contract of OFFICIAL_TOOL_CONTRACTS) {
    registerOfficialTool(server, analysis, contract, {
      logger: options.logger,
      activeTarget: options.activeTarget,
      recordEvidence: options.recordEvidence,
    });
  }
};

const registerOfficialTool = (
  server: McpServer,
  analysis: AnalysisOperationPort,
  contract: (typeof OFFICIAL_TOOL_CONTRACTS)[number],
  registration: {
    readonly logger: Logger;
    readonly activeTarget: (() => BinaryTarget | undefined) | undefined;
    readonly recordEvidence: BinarySessionPort["recordEvidence"] | undefined;
  },
): void => {
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input: unknown, context: ServerContext) => {
      const arguments_ = projectOfficialArguments(contract, input);
      const progress = mcpProgressReporter(context);
      const result = await runOfficialOperation(
        analysis,
        contract,
        arguments_,
        {
          logger: registration.logger,
          signal: context.mcpReq.signal,
          progress,
        },
      );
      if (!result.ok) {
        return toCallToolResult(result, contract);
      }
      const evidence = createEvidence(
        result.value.subject ?? registration.activeTarget?.(),
        result.value.provider,
        {
          operation: contract.name,
          parameters: arguments_,
          result: result.value.result,
          ...(result.value.analysisProfile === undefined
            ? {}
            : { analysisProfile: result.value.analysisProfile }),
          rawResult: result.value.rawResult,
          limitations: result.value.limitations,
          locations: result.value.locations,
        },
      );
      const recorded = registration.recordEvidence?.(evidence);
      if (recorded !== undefined && !recorded.ok)
        return toCallToolResult(recorded, contract);
      return toCallToolResult({ ok: true, value: evidence }, contract);
    },
  );
};

const runOfficialOperation = async (
  analysis: AnalysisOperationPort,
  contract: (typeof OFFICIAL_TOOL_CONTRACTS)[number],
  arguments_: Readonly<Record<string, JsonValue>>,
  execution: {
    readonly logger: Logger;
    readonly signal: AbortSignal;
    readonly progress: ProgressReporter;
  },
): Promise<Result<AnalysisExecution, AnalysisError>> => {
  await execution.progress.report({
    phase: contract.name,
    completed: 0,
    total: 1,
    message: "started",
  });
  const result = await logToolExecution(execution.logger, contract.name, () =>
    analysis.execute(contract.name, arguments_, {
      signal: execution.signal,
      progress: execution.progress,
    }),
  );
  await execution.progress.report({
    phase: contract.name,
    completed: 1,
    total: 1,
    message: result.ok ? "completed" : "failed",
    terminal: true,
  });
  return result;
};

const projectOfficialArguments = (
  contract: ToolContract,
  input: unknown,
): Readonly<Record<string, JsonValue>> => {
  const parsed = jsonObjectSchema.parse(input);
  if (!(contract.inputSchema instanceof z.ZodObject))
    throw new TypeError(
      "Official tool input contract must be an object schema",
    );

  const projected: Record<string, JsonValue> = {};
  for (const key of Object.keys(contract.inputSchema.shape)) {
    projected[key] = jsonValueSchema.parse(parsed[key] ?? null);
  }
  return projected;
};
