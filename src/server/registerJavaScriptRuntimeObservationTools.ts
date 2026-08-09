import type { McpServer, ServerContext } from "@modelcontextprotocol/server";

import type { BinarySessionPort } from "../application/BinarySession.js";
import type { JavaScriptRuntimeObservationPort } from "../application/JavaScriptRuntimeObservationPort.js";
import {
  listJavaScriptRuntimeTargets,
  observeJavaScriptRuntime,
} from "../application/JavaScriptRuntimeObservationService.js";
import type { PermissionAuthority } from "../application/PermissionAuthority.js";
import { JAVASCRIPT_RUNTIME_OBSERVATION_TOOL_CONTRACTS } from "../contracts/javascriptRuntimeObservationToolContracts.js";
import type { ToolContract } from "../contracts/toolContracts.js";
import type { AnalysisError } from "../domain/errors.js";
import type { Evidence } from "../domain/evidence.js";
import type { Result } from "../domain/result.js";
import type { Logger } from "../logger.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { toCallToolResult } from "./toolResult.js";

interface RuntimeToolRegistration {
  readonly logger: Logger;
  readonly runtime: JavaScriptRuntimeObservationPort | undefined;
  readonly permissionAuthority: PermissionAuthority | undefined;
  readonly recordEvidence: BinarySessionPort["recordEvidence"] | undefined;
}

/** Register passive Inspector tools even when policy keeps them unavailable. */
export const registerJavaScriptRuntimeObservationTools = (
  server: McpServer,
  options: RuntimeToolRegistration,
): void => {
  const [listContract, observeContract] =
    JAVASCRIPT_RUNTIME_OBSERVATION_TOOL_CONTRACTS;
  server.registerTool(
    listContract.name,
    toolRegistrationOptions(listContract),
    (input, context) =>
      runRuntimeTool(
        options,
        listContract,
        { input, context },
        (parsed, signal) =>
          listJavaScriptRuntimeTargets(
            options.runtime,
            options.permissionAuthority,
            parsed,
            { signal },
          ),
      ),
  );
  server.registerTool(
    observeContract.name,
    toolRegistrationOptions(observeContract),
    (input, context) =>
      runRuntimeTool(
        options,
        observeContract,
        { input, context },
        (parsed, signal) =>
          observeJavaScriptRuntime(
            options.runtime,
            options.permissionAuthority,
            parsed,
            { signal },
          ),
      ),
  );
};

const runRuntimeTool = async <Input>(
  options: RuntimeToolRegistration,
  contract: ToolContract,
  request: { readonly input: Input; readonly context: ServerContext },
  execute: (
    input: Input,
    signal: AbortSignal,
  ) => Promise<Result<Evidence, AnalysisError>>,
) => {
  const { input, context } = request;
  const result = await logToolExecution(options.logger, contract.name, () =>
    execute(input, context.mcpReq.signal),
  );
  if (!result.ok) return toCallToolResult(result, contract);
  const recorded = options.recordEvidence?.(result.value);
  return recorded !== undefined && !recorded.ok
    ? toCallToolResult(recorded, contract)
    : toCallToolResult({ ok: true, value: result.value }, contract, {
        evidenceResourcesAvailable: recorded !== undefined,
      });
};
