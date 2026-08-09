import type {
  CallToolResult,
  McpServer,
  ServerContext,
} from "@modelcontextprotocol/server";

import type { AnalysisOperationPort } from "../application/AnalysisProvider.js";
import type { BinarySessionPort } from "../application/BinarySession.js";
import {
  EnhancedTools,
  type ValidatedEnhancedCall,
} from "../application/EnhancedTools.js";
import {
  REA_WORKFLOW_PROVIDER,
  workflowAnalysisProfile,
} from "../application/InvestigationProviders.js";
import {
  ENHANCED_TOOL_CONTRACTS,
  type ToolContract,
} from "../contracts/toolContracts.js";
import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import { UnknownRegistryError } from "../domain/errors.js";
import { createEvidence } from "../domain/evidence.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { Logger } from "../logger.js";
import { mcpProgressReporter } from "./mcpProgress.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { toCallToolResult } from "./toolResult.js";

/** Optional session services used by enhanced tool registration. */
export interface EnhancedToolRegistration {
  readonly logger: Logger;
  readonly activeTarget: (() => BinaryTarget | undefined) | undefined;
  readonly analysisProfile:
    | (() => AnalysisProfileCommitment | undefined)
    | undefined;
  readonly recordEvidence: BinarySessionPort["recordEvidence"] | undefined;
  readonly recordUnknown: BinarySessionPort["recordUnknown"] | undefined;
}

/** Register composed workflows against the same port as direct bridge tools. */
// oxlint-disable-next-line max-lines-per-function -- direct SDK calls retain each schema-handler type correlation.
export const registerEnhancedTools = (
  server: McpServer,
  analysis: AnalysisOperationPort,
  options: EnhancedToolRegistration,
): void => {
  const [
    swiftClasses,
    objcClasses,
    objcProtocols,
    batchDecompile,
    callGraph,
    swiftTypes,
    xrefsToName,
    binaryOverview,
    analyzeFunction,
    inspectNativeApi,
    traceFeature,
    codeForString,
    traceCallPath,
  ] = ENHANCED_TOOL_CONTRACTS;
  server.registerTool(
    swiftClasses.name,
    toolRegistrationOptions(swiftClasses),
    (input, context) =>
      executeEnhancedTool(analysis, options, swiftClasses, {
        validatedCall: { name: "swift_classes", input },
        context,
      }),
  );
  server.registerTool(
    objcClasses.name,
    toolRegistrationOptions(objcClasses),
    (input, context) =>
      executeEnhancedTool(analysis, options, objcClasses, {
        validatedCall: { name: "get_objc_classes", input },
        context,
      }),
  );
  server.registerTool(
    objcProtocols.name,
    toolRegistrationOptions(objcProtocols),
    (input, context) =>
      executeEnhancedTool(analysis, options, objcProtocols, {
        validatedCall: { name: "get_objc_protocols", input },
        context,
      }),
  );
  server.registerTool(
    batchDecompile.name,
    toolRegistrationOptions(batchDecompile),
    (input, context) =>
      executeEnhancedTool(analysis, options, batchDecompile, {
        validatedCall: { name: "batch_decompile", input },
        context,
      }),
  );
  server.registerTool(
    callGraph.name,
    toolRegistrationOptions(callGraph),
    (input, context) =>
      executeEnhancedTool(analysis, options, callGraph, {
        validatedCall: { name: "get_call_graph", input },
        context,
      }),
  );
  server.registerTool(
    swiftTypes.name,
    toolRegistrationOptions(swiftTypes),
    (input, context) =>
      executeEnhancedTool(analysis, options, swiftTypes, {
        validatedCall: { name: "analyze_swift_types", input },
        context,
      }),
  );
  server.registerTool(
    xrefsToName.name,
    toolRegistrationOptions(xrefsToName),
    (input, context) =>
      executeEnhancedTool(analysis, options, xrefsToName, {
        validatedCall: { name: "find_xrefs_to_name", input },
        context,
      }),
  );
  server.registerTool(
    binaryOverview.name,
    toolRegistrationOptions(binaryOverview),
    (input, context) =>
      executeEnhancedTool(analysis, options, binaryOverview, {
        validatedCall: { name: "binary_overview", input },
        context,
      }),
  );
  server.registerTool(
    analyzeFunction.name,
    toolRegistrationOptions(analyzeFunction),
    (input, context) =>
      executeEnhancedTool(analysis, options, analyzeFunction, {
        validatedCall: { name: "analyze_function", input },
        context,
      }),
  );
  server.registerTool(
    inspectNativeApi.name,
    toolRegistrationOptions(inspectNativeApi),
    (input, context) =>
      executeEnhancedTool(analysis, options, inspectNativeApi, {
        validatedCall: { name: "inspect_native_api", input },
        context,
      }),
  );
  server.registerTool(
    traceFeature.name,
    toolRegistrationOptions(traceFeature),
    (input, context) =>
      executeEnhancedTool(analysis, options, traceFeature, {
        validatedCall: { name: "trace_feature", input },
        context,
      }),
  );
  server.registerTool(
    codeForString.name,
    toolRegistrationOptions(codeForString),
    (input, context) =>
      executeEnhancedTool(analysis, options, codeForString, {
        validatedCall: { name: "find_code_for_string", input },
        context,
      }),
  );
  server.registerTool(
    traceCallPath.name,
    toolRegistrationOptions(traceCallPath),
    (input, context) =>
      executeEnhancedTool(analysis, options, traceCallPath, {
        validatedCall: { name: "trace_call_path", input },
        context,
      }),
  );
};

const executeEnhancedTool = async (
  analysis: AnalysisOperationPort,
  registration: EnhancedToolRegistration,
  contract: ToolContract,
  request: {
    readonly validatedCall: ValidatedEnhancedCall;
    readonly context: ServerContext;
  },
): Promise<CallToolResult> => {
  const { validatedCall, context } = request;
  const name = validatedCall.name;
  const progress = mcpProgressReporter(context);
  await progress.report({
    phase: name,
    completed: 0,
    total: 1,
    message: "started",
  });
  const parsedInput = validatedCall.input;
  const parameters = jsonParameters(parsedInput);
  const services = new EnhancedTools({
    execute: (operation, operationParameters, executionOptions) =>
      analysis.execute(operation, operationParameters, {
        ...executionOptions,
        progress,
      }),
  });
  const result = await logToolExecution(registration.logger, name, () =>
    services.executeValidated(validatedCall, context.mcpReq.signal),
  );
  await progress.report({
    phase: name,
    completed: 1,
    total: 1,
    message: result.ok ? "completed" : "failed",
    terminal: true,
  });
  if (result.ok) {
    const upstreamProfile = registration.analysisProfile?.();
    const evidence = createEvidence(
      registration.activeTarget?.(),
      REA_WORKFLOW_PROVIDER,
      {
        operation: name,
        parameters,
        result: result.value,
        ...(upstreamProfile === undefined
          ? {}
          : {
              analysisProfile: workflowAnalysisProfile(upstreamProfile),
            }),
        confidence: "derived",
        limitations: [
          "Derived by an REA workflow from one or more provider observations.",
        ],
      },
    );
    const recorded = registration.recordEvidence?.(evidence);
    if (recorded !== undefined && !recorded.ok)
      return toCallToolResult(recorded, contract);
    const unknowns = recordWorkflowUnknowns({
      name,
      input: parameters,
      result: result.value,
      evidenceId: evidence.evidence_id,
      recordUnknown: registration.recordUnknown,
    });
    if (!unknowns.ok) return toCallToolResult(unknowns, contract);
    return toCallToolResult({ ok: true, value: evidence }, contract, {
      evidenceResourcesAvailable: recorded !== undefined,
    });
  }
  return toCallToolResult(result, contract);
};

const jsonParameters = (
  input: Readonly<Record<string, JsonValue | undefined>>,
): Record<string, JsonValue> =>
  Object.fromEntries(
    Object.entries(input).filter(
      (entry): entry is [string, JsonValue] => entry[1] !== undefined,
    ),
  );

interface WorkflowUnknownInput {
  readonly name: string;
  readonly input: Readonly<Record<string, JsonValue>>;
  readonly result: JsonValue;
  readonly evidenceId: string;
  readonly recordUnknown: BinarySessionPort["recordUnknown"] | undefined;
}

const recordWorkflowUnknowns = ({
  name,
  input,
  result,
  evidenceId,
  recordUnknown,
}: WorkflowUnknownInput):
  | ReturnType<BinarySessionPort["recordUnknown"]>
  | { readonly ok: true; readonly value: null } => {
  if (
    ![
      "trace_feature",
      "find_code_for_string",
      "trace_call_path",
      "inspect_native_api",
    ].includes(name) ||
    input.unknown_registry_approved !== true ||
    recordUnknown === undefined ||
    typeof result !== "object" ||
    result === null ||
    Array.isArray(result) ||
    !Array.isArray(result.residual_unknowns)
  )
    return { ok: true, value: null };
  for (const question of result.residual_unknowns) {
    if (typeof question !== "string") continue;
    const recorded = recordUnknown({
      approved: true,
      question,
      severity: "medium",
      domain: name === "inspect_native_api" ? "native-api" : "control-flow",
      supporting_evidence_ids: [evidenceId],
      contradicting_evidence_ids: [],
      required_authority: "shipped-artifact",
      required_confidence: "observed",
      required_environment: null,
      recommended_probes: [
        {
          operation: name,
          rationale:
            name === "inspect_native_api"
              ? "Confirm the unsupported boundary with a capable provider or ABI probe."
              : "Continue with a larger bounded budget.",
        },
      ],
      relationships: [],
    });
    if (
      !recorded.ok &&
      !(
        recorded.error instanceof UnknownRegistryError &&
        recorded.error.reason === "already-exists"
      )
    )
      return recorded;
  }
  return { ok: true, value: null };
};
