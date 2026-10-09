import type { ToolResultDelivery } from "./toolResult.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type {
  EvidenceWriter,
  UnknownRegistryPort,
} from "../application/investigation/InvestigationRecordPort.js";
import type {
  CallToolResult,
  ServerContext,
} from "@modelcontextprotocol/server";

import type { AnalysisOperationPort } from "../application/AnalysisProvider.js";
import type { BinarySessionPort } from "../application/binary/BinarySessionPort.js";
import {
  EnhancedTools,
  type ValidatedEnhancedCall,
} from "../application/EnhancedTools.js";
import {
  createWorkflowEvidence,
  workflowSnapshotRecord,
  recordWorkflowUnknowns,
} from "../application/WorkflowEvidence.js";
import { toolContract, type ToolContract } from "../contracts/toolContracts.js";
import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { Logger } from "../logger.js";
import { mcpProgressReporter } from "./mcpProgress.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { executeFunctionAnalysisEvidence } from "../application/FunctionAnalysisEvidence.js";

/** Optional session services used by enhanced tool registration. */
export interface EnhancedToolRegistration {
  readonly logger: Logger;
  readonly activeTarget: (() => BinaryTarget | undefined) | undefined;
  readonly analysisProfile:
    | (() => AnalysisProfileCommitment | undefined)
    | undefined;
  readonly recordEvidence: EvidenceWriter["recordEvidence"] | undefined;
  readonly recordUnknown: UnknownRegistryPort["recordUnknown"] | undefined;
  readonly allowsSnapshotReplay:
    | ((operation: ValidatedEnhancedCall["name"]) => boolean)
    | undefined;
  readonly recordWorkflowSnapshot:
    | ((
        input: Parameters<BinarySessionPort["recordWorkflowSnapshot"]>[0],
      ) => ReturnType<BinarySessionPort["recordWorkflowSnapshot"]>)
    | undefined;
}

/** Register composed workflows against the same port as direct bridge tools. */
// oxlint-disable-next-line max-lines-per-function -- direct SDK calls retain each schema-handler type correlation.
export const registerEnhancedTools = (
  server: EvidenceMcpServer,
  analysis: AnalysisOperationPort,
  options: EnhancedToolRegistration,
): void => {
  const registration = { ...options, delivery: server.delivery };
  const nativeDispatchMetadata = toolContract(
    "inspect_native_dispatch_metadata",
  );
  const objcClasses = toolContract("get_objc_classes");
  const objcProtocols = toolContract("get_objc_protocols");
  const batchDecompile = toolContract("batch_decompile");
  const callGraph = toolContract("get_call_graph");
  const swiftTypes = toolContract("analyze_swift_types");
  const xrefsToName = toolContract("find_xrefs_to_name");
  const binaryOverview = toolContract("binary_overview");
  const analyzeFunction = toolContract("analyze_function");
  const inspectNativeApi = toolContract("inspect_native_api");
  const traceFeature = toolContract("trace_feature");
  const traceCallPath = toolContract("trace_call_path");
  const traceNativeUiAction = toolContract("trace_native_ui_action");
  const traceNativeValues = toolContract("trace_native_values");
  server.registerTool(
    traceNativeValues.name,
    toolRegistrationOptions(traceNativeValues),
    (input, context) =>
      executeEnhancedTool(analysis, registration, traceNativeValues, {
        validatedCall: { name: "trace_native_values", input },
        context,
      }),
  );
  server.registerTool(
    nativeDispatchMetadata.name,
    toolRegistrationOptions(nativeDispatchMetadata),
    (input, context) =>
      executeEnhancedTool(analysis, registration, nativeDispatchMetadata, {
        validatedCall: { name: "inspect_native_dispatch_metadata", input },
        context,
      }),
  );
  server.registerTool(
    objcClasses.name,
    toolRegistrationOptions(objcClasses),
    (input, context) =>
      executeEnhancedTool(analysis, registration, objcClasses, {
        validatedCall: { name: "get_objc_classes", input },
        context,
      }),
  );
  server.registerTool(
    objcProtocols.name,
    toolRegistrationOptions(objcProtocols),
    (input, context) =>
      executeEnhancedTool(analysis, registration, objcProtocols, {
        validatedCall: { name: "get_objc_protocols", input },
        context,
      }),
  );
  server.registerTool(
    batchDecompile.name,
    toolRegistrationOptions(batchDecompile),
    (input, context) =>
      executeEnhancedTool(analysis, registration, batchDecompile, {
        validatedCall: { name: "batch_decompile", input },
        context,
      }),
  );
  server.registerTool(
    callGraph.name,
    toolRegistrationOptions(callGraph),
    (input, context) =>
      executeEnhancedTool(analysis, registration, callGraph, {
        validatedCall: { name: "get_call_graph", input },
        context,
      }),
  );
  server.registerTool(
    swiftTypes.name,
    toolRegistrationOptions(swiftTypes),
    (input, context) =>
      executeEnhancedTool(analysis, registration, swiftTypes, {
        validatedCall: { name: "analyze_swift_types", input },
        context,
      }),
  );
  server.registerTool(
    xrefsToName.name,
    toolRegistrationOptions(xrefsToName),
    (input, context) =>
      executeEnhancedTool(analysis, registration, xrefsToName, {
        validatedCall: { name: "find_xrefs_to_name", input },
        context,
      }),
  );
  server.registerTool(
    binaryOverview.name,
    toolRegistrationOptions(binaryOverview),
    (input, context) =>
      executeEnhancedTool(analysis, registration, binaryOverview, {
        validatedCall: { name: "binary_overview", input },
        context,
      }),
  );
  server.registerTool(
    analyzeFunction.name,
    toolRegistrationOptions(analyzeFunction),
    (input, context) =>
      executeEnhancedTool(analysis, registration, analyzeFunction, {
        validatedCall: { name: "analyze_function", input },
        context,
      }),
  );
  server.registerTool(
    inspectNativeApi.name,
    toolRegistrationOptions(inspectNativeApi),
    (input, context) =>
      executeEnhancedTool(analysis, registration, inspectNativeApi, {
        validatedCall: { name: "inspect_native_api", input },
        context,
      }),
  );
  server.registerTool(
    traceFeature.name,
    toolRegistrationOptions(traceFeature),
    (input, context) =>
      executeEnhancedTool(analysis, registration, traceFeature, {
        validatedCall: { name: "trace_feature", input },
        context,
      }),
  );
  server.registerTool(
    traceCallPath.name,
    toolRegistrationOptions(traceCallPath),
    (input, context) =>
      executeEnhancedTool(analysis, registration, traceCallPath, {
        validatedCall: { name: "trace_call_path", input },
        context,
      }),
  );
  server.registerTool(
    traceNativeUiAction.name,
    toolRegistrationOptions(traceNativeUiAction),
    (input, context) =>
      executeEnhancedTool(analysis, registration, traceNativeUiAction, {
        validatedCall: { name: "trace_native_ui_action", input },
        context,
      }),
  );
};

const executeEnhancedTool = async (
  analysis: AnalysisOperationPort,
  registration: EnhancedToolRegistration & {
    readonly delivery: ToolResultDelivery;
  },
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
  if (name === "analyze_function")
    return executeFunctionTool(analysis, registration, contract, {
      context,
      parameters,
    });
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
    const evidence = createWorkflowEvidence({
      target: registration.activeTarget?.(),
      operation: name,
      parameters,
      result: result.value,
      upstreamProfile: registration.analysisProfile?.(),
    });
    const recorded = registration.recordEvidence?.(evidence);
    if (recorded !== undefined && !recorded.ok)
      return registration.delivery.toCallToolResult(recorded, contract);
    if (
      name !== "trace_native_ui_action" &&
      registration.allowsSnapshotReplay?.(name) === true
    ) {
      const workflowRecord = workflowSnapshotRecord(evidence, name);
      if (workflowRecord !== undefined) {
        const snapshot = registration.recordWorkflowSnapshot?.(workflowRecord);
        if (snapshot !== undefined && !snapshot.ok)
          return registration.delivery.toCallToolResult(snapshot, contract);
      }
    }
    const unknowns = recordWorkflowUnknowns({
      name,
      result: result.value,
      evidenceId: evidence.evidence_id,
      recordUnknown: registration.recordUnknown,
    });
    if (!unknowns.ok)
      return registration.delivery.toCallToolResult(unknowns, contract);
    return registration.delivery.toEvidenceToolResult(
      evidence,
      contract,
      recorded,
    );
  }
  return registration.delivery.toCallToolResult(result, contract);
};

const executeFunctionTool = async (
  analysis: AnalysisOperationPort,
  registration: EnhancedToolRegistration & {
    readonly delivery: ToolResultDelivery;
  },
  contract: ToolContract,
  request: {
    readonly context: ServerContext;
    readonly parameters: Readonly<Record<string, JsonValue>>;
  },
): Promise<CallToolResult> => {
  const { context, parameters } = request;
  const progress = mcpProgressReporter(context);
  const result = await logToolExecution(
    registration.logger,
    "analyze_function",
    () =>
      executeFunctionAnalysisEvidence(
        analysis,
        parameters,
        registration.activeTarget?.(),
        {
          signal: context.mcpReq.signal,
          progress,
        },
      ),
  );
  await progress.report({
    phase: "analyze_function",
    completed: 1,
    total: 1,
    message: result.ok ? "completed" : "failed",
    terminal: true,
  });
  if (!result.ok)
    return registration.delivery.toCallToolResult(result, contract);
  return registration.delivery.toEvidenceToolResult(
    result.value,
    contract,
    registration.recordEvidence?.(result.value),
  );
};

const jsonParameters = (
  input: Readonly<Record<string, JsonValue | undefined>>,
): Record<string, JsonValue> =>
  Object.fromEntries(
    Object.entries(input).filter(
      (entry): entry is [string, JsonValue] => entry[1] !== undefined,
    ),
  );
