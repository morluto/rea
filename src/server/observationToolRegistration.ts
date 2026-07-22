import type { z } from "zod";

import type { McpServer } from "@modelcontextprotocol/server";

import type { ProgressReporter } from "../application/ProgressReporter.js";
import type { Evidence } from "../domain/evidence.js";
import type { AnalysisError } from "../domain/errors.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { Result } from "../domain/result.js";
import type { ToolContract } from "../contracts/toolContracts.js";
import type { Logger } from "../logger.js";
import type { BinarySessionPort } from "../application/BinarySession.js";
import { logToolExecution } from "./toolLogging.js";
import { toCallToolResult } from "./toolResult.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { safeParseToolInput } from "./toolInputValidation.js";
import { mcpProgressReporter } from "./mcpProgress.js";

/** Shared registration fields for observation tools (browser/electron). */
export interface ObservationToolRegistration {
  readonly logger: Logger;
  readonly recordEvidence: BinarySessionPort["recordEvidence"] | undefined;
}

/** Shared execution context for observation tools. */
export interface ObservationToolContext {
  readonly signal: AbortSignal;
  readonly progress: ProgressReporter;
}

/** Spec for a single observation tool with optional evidence projection. */
export interface ObservationToolSpec<Schema extends z.ZodType> {
  readonly contract: ToolContract;
  readonly schema: Schema;
  readonly execute: (
    parsed: z.output<Schema>,
    context: ObservationToolContext,
  ) => Promise<Result<Evidence, AnalysisError>>;
  readonly projectEvidence?: (
    evidence: Evidence,
    parsed: z.output<Schema>,
  ) =>
    | {
        readonly structured: JsonValue;
        readonly text?: JsonValue;
      }
    | undefined;
}

/** Register a single observation tool with shared parse/log/result logic. */
export const registerObservationTool = <Schema extends z.ZodType>(
  server: McpServer,
  options: ObservationToolRegistration,
  spec: ObservationToolSpec<Schema>,
): void => {
  server.registerTool(
    spec.contract.name,
    toolRegistrationOptions(spec.contract),
    async (input, context) => {
      const parsedInput = safeParseToolInput(
        spec.schema,
        input,
        spec.contract.name,
      );
      if (!parsedInput.ok) return toCallToolResult(parsedInput, spec.contract);
      const result = await logToolExecution(
        options.logger,
        spec.contract.name,
        () =>
          spec.execute(parsedInput.value, {
            signal: context.mcpReq.signal,
            progress: mcpProgressReporter(context),
          }),
      );
      if (!result.ok) return toCallToolResult(result, spec.contract);
      return observationEvidenceResult(
        options,
        spec.contract,
        result.value,
        spec.projectEvidence?.(result.value, parsedInput.value),
      );
    },
  );
};

/** Record evidence and return a tool result, optionally with a projection. */
const observationEvidenceResult = (
  options: ObservationToolRegistration,
  contract: ToolContract,
  evidence: Evidence,
  projection:
    | { readonly structured: JsonValue; readonly text?: JsonValue }
    | undefined,
) => {
  const recorded = options.recordEvidence?.(evidence);
  return recorded !== undefined && !recorded.ok
    ? toCallToolResult(recorded, contract)
    : toCallToolResult({ ok: true, value: evidence }, contract, {
        evidenceResourcesAvailable: recorded !== undefined,
        ...(projection === undefined
          ? {}
          : {
              evidenceResultProjection: projection.structured,
              ...(projection.text === undefined
                ? {}
                : { evidenceTextProjection: projection.text }),
            }),
      });
};
