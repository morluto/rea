import type { McpServer, ServerContext } from "@modelcontextprotocol/server";

import type { BinarySessionPort } from "../application/BinarySession.js";
import type { ElectronActiveObservationPort } from "../application/ElectronActiveObservationPort.js";
import { captureElectronScenario } from "../application/ElectronActiveObservationService.js";
import type { ElectronObservationPort } from "../application/ElectronObservationPort.js";
import {
  inspectElectronPage,
  listElectronTargets,
} from "../application/ElectronObservationService.js";
import { analyzeJavaScriptApplicationValidated } from "../application/JavaScriptApplicationService.js";
import { reconcileJavaScriptRuntimeEvidenceValidated } from "../application/JavaScriptRuntimeReconciliationService.js";
import type { PermissionAuthority } from "../application/PermissionAuthority.js";
import type { ProgressReporter } from "../application/ProgressReporter.js";
import { ELECTRON_TOOL_CONTRACTS } from "../contracts/electronToolContracts.js";
import type { ToolContract } from "../contracts/toolContracts.js";
import type { AnalysisError } from "../domain/errors.js";
import type { Evidence } from "../domain/evidence.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { Result } from "../domain/result.js";
import type { Logger } from "../logger.js";
import { summarizeJavaScriptApplicationEvidence } from "./javascriptApplicationResult.js";
import { mcpProgressReporter } from "./mcpProgress.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { toCallToolResult } from "./toolResult.js";

interface ElectronToolRegistration {
  readonly logger: Logger;
  readonly electron: ElectronObservationPort | undefined;
  readonly electronActive: ElectronActiveObservationPort | undefined;
  readonly permissionAuthority: PermissionAuthority | undefined;
  readonly recordEvidence: BinarySessionPort["recordEvidence"] | undefined;
}

interface ElectronToolContext {
  readonly signal: AbortSignal;
  readonly progress: ProgressReporter;
}

/** Register Electron tools even when provider or permission policy is absent. */
// oxlint-disable-next-line max-lines-per-function -- direct SDK calls retain each schema-handler type correlation.
export const registerElectronTools = (
  server: McpServer,
  options: ElectronToolRegistration,
): void => {
  const [
    listContract,
    inspectContract,
    analyzeContract,
    reconcileContract,
    activeContract,
  ] = ELECTRON_TOOL_CONTRACTS;

  server.registerTool(
    listContract.name,
    toolRegistrationOptions(listContract),
    (input, context) =>
      runElectronTool(
        options,
        listContract,
        { input, context },
        (parsed, { signal }) =>
          listElectronTargets(
            options.electron,
            options.permissionAuthority,
            parsed,
            {
              signal,
            },
          ),
      ),
  );
  server.registerTool(
    inspectContract.name,
    toolRegistrationOptions(inspectContract),
    (input, context) =>
      runElectronTool(
        options,
        inspectContract,
        { input, context },
        (parsed, { signal, progress }) =>
          inspectElectronPage(
            options.electron,
            options.permissionAuthority,
            parsed,
            {
              signal,
              progress,
            },
          ),
      ),
  );
  server.registerTool(
    analyzeContract.name,
    toolRegistrationOptions(analyzeContract),
    (input, context) =>
      runElectronTool(
        options,
        analyzeContract,
        {
          input,
          context,
          projectEvidence: (evidence, parsed) => {
            const summary = summarizeJavaScriptApplicationEvidence(evidence);
            return parsed.detail === "full"
              ? { structured: evidence.normalized_result, text: summary }
              : { structured: summary };
          },
        },
        (parsed, { signal, progress }) =>
          analyzeJavaScriptApplicationValidated(
            options.permissionAuthority,
            parsed,
            { signal, progress },
          ),
      ),
  );
  server.registerTool(
    reconcileContract.name,
    toolRegistrationOptions(reconcileContract),
    (input, context) =>
      runElectronTool(
        options,
        reconcileContract,
        { input, context },
        (parsed) =>
          Promise.resolve(reconcileJavaScriptRuntimeEvidenceValidated(parsed)),
      ),
  );
  server.registerTool(
    activeContract.name,
    toolRegistrationOptions(activeContract),
    (input, context) =>
      runElectronTool(
        options,
        activeContract,
        { input, context },
        (parsed, { signal, progress }) =>
          captureElectronScenario(
            options.electronActive,
            options.permissionAuthority,
            parsed,
            { signal, progress },
          ),
      ),
  );
};

const runElectronTool = async <Input>(
  options: ElectronToolRegistration,
  contract: ToolContract,
  request: {
    readonly input: Input;
    readonly context: ServerContext;
    readonly projectEvidence?: (
      evidence: Evidence,
      input: Input,
    ) => { readonly structured: JsonValue; readonly text?: JsonValue };
  },
  execute: (
    input: Input,
    context: ElectronToolContext,
  ) => Promise<Result<Evidence, AnalysisError>>,
) => {
  const { input, context, projectEvidence } = request;
  const result = await logToolExecution(options.logger, contract.name, () =>
    execute(input, {
      signal: context.mcpReq.signal,
      progress: mcpProgressReporter(context),
    }),
  );
  if (!result.ok) return toCallToolResult(result, contract);
  return evidenceResult(
    options,
    contract,
    result.value,
    projectEvidence?.(result.value, input),
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
