import type { McpServer } from "@modelcontextprotocol/server";
import type { z } from "zod";

import type { BinarySessionPort } from "../application/BinarySession.js";
import type { ElectronObservationPort } from "../application/ElectronObservationPort.js";
import { analyzeJavaScriptApplicationValidated } from "../application/JavaScriptApplicationService.js";
import { reconcileJavaScriptRuntimeEvidenceValidated } from "../application/JavaScriptRuntimeReconciliationService.js";
import {
  inspectElectronPage,
  listElectronTargets,
} from "../application/ElectronObservationService.js";
import type { PermissionAuthority } from "../application/PermissionAuthority.js";
import {
  analyzeJavaScriptApplicationToolInputSchema,
  ELECTRON_TOOL_CONTRACTS,
} from "../contracts/electronToolContracts.js";
import {
  inspectElectronPageInputSchema,
  listElectronTargetsInputSchema,
} from "../domain/electronObservation.js";
import { reconcileJavaScriptRuntimeInputSchema } from "../domain/javascriptRuntimeReconciliationSchemas.js";
import type { Logger } from "../logger.js";
import { logToolExecution } from "./toolLogging.js";
import { toCallToolResult } from "./toolResult.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { safeParseToolInput } from "./toolInputValidation.js";
import { mcpProgressReporter } from "./mcpProgress.js";
import type { ProgressReporter } from "../application/ProgressReporter.js";
import type { Evidence } from "../domain/evidence.js";
import type { Result } from "../domain/result.js";
import type { AnalysisError } from "../domain/errors.js";
import type { ToolContract } from "../contracts/toolContracts.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { summarizeJavaScriptApplicationEvidence } from "./javascriptApplicationResult.js";

interface ElectronToolRegistration {
  readonly logger: Logger;
  readonly electron: ElectronObservationPort | undefined;
  readonly permissionAuthority: PermissionAuthority | undefined;
  readonly recordEvidence: BinarySessionPort["recordEvidence"] | undefined;
}

interface ElectronToolContext {
  readonly signal: AbortSignal;
  readonly progress: ProgressReporter;
}

interface ElectronToolSpec<Schema extends z.ZodType> {
  readonly contract: ToolContract;
  readonly schema: Schema;
  readonly execute: (
    parsed: z.output<Schema>,
    context: ElectronToolContext,
  ) => Promise<Result<Evidence, AnalysisError>>;
  readonly projectEvidence?: (
    evidence: Evidence,
    parsed: z.output<Schema>,
  ) => {
    readonly structured: JsonValue;
    readonly text?: JsonValue;
  };
}

/** Register Electron tools even when provider or permission policy is absent. */
export const registerElectronTools = (
  server: McpServer,
  options: ElectronToolRegistration,
): void => {
  const [listContract, inspectContract, analyzeContract, reconcileContract] =
    ELECTRON_TOOL_CONTRACTS;

  registerElectronTool(server, options, {
    contract: listContract,
    schema: listElectronTargetsInputSchema,
    execute: (parsed, { signal }) =>
      listElectronTargets(
        options.electron,
        options.permissionAuthority,
        parsed,
        {
          signal,
        },
      ),
  });
  registerElectronTool(server, options, {
    contract: inspectContract,
    schema: inspectElectronPageInputSchema,
    execute: (parsed, { signal, progress }) =>
      inspectElectronPage(
        options.electron,
        options.permissionAuthority,
        parsed,
        {
          signal,
          progress,
        },
      ),
  });
  registerElectronTool(server, options, {
    contract: analyzeContract,
    schema: analyzeJavaScriptApplicationToolInputSchema,
    execute: (parsed, { signal, progress }) =>
      analyzeJavaScriptApplicationValidated(
        options.permissionAuthority,
        parsed,
        { signal, progress },
      ),
    projectEvidence: (evidence, parsed) => {
      const summary = summarizeJavaScriptApplicationEvidence(evidence);
      return parsed.detail === "full"
        ? { structured: evidence.normalized_result, text: summary }
        : { structured: summary };
    },
  });
  registerElectronTool(server, options, {
    contract: reconcileContract,
    schema: reconcileJavaScriptRuntimeInputSchema,
    execute: (parsed, _context) =>
      Promise.resolve(reconcileJavaScriptRuntimeEvidenceValidated(parsed)),
  });
};

const registerElectronTool = <Schema extends z.ZodType>(
  server: McpServer,
  options: ElectronToolRegistration,
  spec: ElectronToolSpec<Schema>,
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
      return evidenceResult(
        options,
        spec.contract,
        result.value,
        spec.projectEvidence?.(result.value, parsedInput.value),
      );
    },
  );
};

const evidenceResult = (
  options: ElectronToolRegistration,
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
