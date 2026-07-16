import type { McpServer } from "@modelcontextprotocol/server";

import type {
  AnalysisOperation,
  AnalysisOperationPort,
} from "../application/AnalysisProvider.js";
import type { BinarySessionPort } from "../application/BinarySession.js";
import type { ToolContract } from "../contracts/toolContracts.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import { createEvidence } from "../domain/evidence.js";
import { jsonObjectSchema } from "../domain/jsonValue.js";
import type { Logger } from "../logger.js";
import { logToolExecution } from "./toolLogging.js";
import { toCallToolResult } from "./toolResult.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { mcpProgressReporter } from "./mcpProgress.js";
import { safeParseToolInput } from "./toolInputValidation.js";
import type { PermissionAuthority } from "../application/PermissionAuthority.js";
import {
  AnalysisProtocolError,
  PermissionRequiredError,
} from "../domain/errors.js";
import { err } from "../domain/result.js";

interface EvidenceToolRegistration {
  readonly logger: Logger;
  readonly activeTarget: (() => BinaryTarget | undefined) | undefined;
  readonly recordEvidence: BinarySessionPort["recordEvidence"] | undefined;
  readonly permissionAuthority?: PermissionAuthority;
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
      toolRegistrationOptions(contract),
      async (input, context) => {
        const progress = mcpProgressReporter(context);
        await progress.report({
          phase: contract.name,
          completed: 0,
          total: 1,
          message: "started",
        });
        const parsedInput = safeParseToolInput(
          contract.inputSchema,
          input,
          contract.name,
        );
        if (!parsedInput.ok) return toCallToolResult(parsedInput, contract);
        const parameters = jsonObjectSchema.parse(parsedInput.value);
        if (options.permissionAuthority !== undefined) {
          const request = permissionRequest(contract.name, parameters);
          if (request !== undefined) {
            const authorized = await options.permissionAuthority.authorize(
              request,
              contract.name === "extract_artifact" ? "write" : "read",
            );
            if (!authorized.ok)
              return toCallToolResult(
                err(
                  authorized.error instanceof PermissionRequiredError
                    ? authorized.error
                    : new AnalysisProtocolError(authorized.error.message, {
                        cause: authorized.error,
                      }),
                ),
                contract,
              );
          }
        }
        const execution = await logToolExecution(
          options.logger,
          contract.name,
          () =>
            analysis.execute(contract.name, parameters, {
              signal: context.mcpReq.signal,
              progress,
            }),
        );
        await progress.report({
          phase: contract.name,
          completed: 1,
          total: 1,
          message: execution.ok ? "completed" : "failed",
          terminal: true,
        });
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
          : toCallToolResult({ ok: true, value: evidence }, contract, {
              evidenceResourcesAvailable: recorded !== undefined,
            });
      },
    );
  }
};

const permissionRequest = (
  operation: string,
  parameters: Readonly<
    Record<string, import("../domain/jsonValue.js").JsonValue>
  >,
) => {
  if (
    operation === "extract_artifact" &&
    typeof parameters.output_root === "string"
  )
    return {
      capability: "artifact_extract" as const,
      roots: [parameters.output_root],
      executables: [],
      environment_names: [],
      network: "none" as const,
      mount: false,
      operation_identity: `extract_artifact:${parameters.output_root}`,
    };
  if (
    operation === "inventory_artifact" &&
    parameters.native_mount_approved === true
  )
    return {
      capability: "native_mount" as const,
      roots: [],
      executables: [],
      environment_names: [],
      network: "none" as const,
      mount: true,
      operation_identity: "inventory_artifact:native_mount",
    };
  return undefined;
};
