import type { McpServer } from "@modelcontextprotocol/server";

import type { AnalysisOperationPort } from "../application/AnalysisProvider.js";
import type { AnalysisExecution } from "../application/AnalysisProvider.js";
import type { BinarySessionPort } from "../application/BinarySession.js";
import { OFFICIAL_TOOL_CONTRACTS } from "../contracts/toolContracts.js";
import {
  jsonObjectSchema,
  jsonValueSchema,
  type JsonValue,
} from "../domain/jsonValue.js";
import { toCallToolResult } from "./toolResult.js";
import type { Logger } from "../logger.js";
import { logToolExecution } from "./toolLogging.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import { createEvidence } from "../domain/evidence.js";
import {
  AnalysisCapabilityUnavailableError,
  type AnalysisError,
  UnknownRegistryError,
} from "../domain/errors.js";
import { mcpProgressReporter } from "./mcpProgress.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { safeParseToolInput } from "./toolInputValidation.js";
import type { ToolContract } from "../contracts/toolContracts.js";
import type { Result } from "../domain/result.js";
import type { ProgressReporter } from "../application/ProgressReporter.js";

/** Optional session services used by direct tool registration. */
export interface OfficialToolRegistration {
  readonly logger: Logger;
  readonly activeTarget: (() => BinaryTarget | undefined) | undefined;
  readonly recordEvidence: BinarySessionPort["recordEvidence"] | undefined;
  readonly recordUnknown: BinarySessionPort["recordUnknown"] | undefined;
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
      recordUnknown: options.recordUnknown,
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
    readonly recordUnknown: BinarySessionPort["recordUnknown"] | undefined;
  },
): void => {
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) => {
      const parsedInput = safeParseToolInput(
        contract.inputSchema,
        input,
        contract.name,
      );
      if (!parsedInput.ok) return toCallToolResult(parsedInput, contract);
      const arguments_ = projectOfficialArguments(contract, parsedInput.value);
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
        const unknownError = recordOfficialUnknown(
          input,
          result.error,
          contract,
          registration.recordUnknown,
        );
        if (unknownError !== undefined)
          return toCallToolResult(unknownError, contract);
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
      return toCallToolResult({ ok: true, value: evidence }, contract, {
        evidenceResourcesAvailable: recorded !== undefined,
      });
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

const recordOfficialUnknown = (
  input: unknown,
  error: AnalysisError,
  contract: ToolContract,
  recordUnknown: BinarySessionPort["recordUnknown"] | undefined,
): Result<never, AnalysisError> | undefined => {
  if (
    !(error instanceof AnalysisCapabilityUnavailableError) ||
    !approvedUnknownTracking(input) ||
    recordUnknown === undefined
  )
    return undefined;
  const unknown = recordUnknown({
    approved: true,
    question: "The requested analysis is unavailable for the current target.",
    severity: "medium",
    domain: "analysis-capability",
    supporting_evidence_ids: [],
    contradicting_evidence_ids: [],
    required_authority: "shipped-artifact",
    required_confidence: "observed",
    required_environment: null,
    recommended_probes: [
      {
        operation: contract.name,
        rationale:
          "Choose another analysis or target that can answer this question.",
      },
    ],
    relationships: [],
  });
  if (
    !unknown.ok &&
    !(
      unknown.error instanceof UnknownRegistryError &&
      unknown.error.reason === "already-exists"
    )
  )
    return unknown;
  return undefined;
};

const projectOfficialArguments = (
  contract: ToolContract,
  input: unknown,
): Readonly<Record<string, JsonValue>> => {
  const parsed = jsonObjectSchema.parse(input);

  const projected: Record<string, JsonValue> = {};
  for (const key of Object.keys(contract.inputSchema.shape)) {
    if (key === "unknown_registry_approved") continue;
    projected[key] = jsonValueSchema.parse(parsed[key] ?? null);
  }
  return projected;
};

const approvedUnknownTracking = (input: unknown): boolean =>
  typeof input === "object" &&
  input !== null &&
  "unknown_registry_approved" in input &&
  input.unknown_registry_approved === true;
