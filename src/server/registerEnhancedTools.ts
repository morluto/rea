import type { McpServer } from "@modelcontextprotocol/server";
import type { z } from "zod";

import {
  EnhancedTools,
  type ValidatedEnhancedCall,
} from "../application/EnhancedTools.js";
import type { AnalysisOperationPort } from "../application/AnalysisProvider.js";
import type { BinarySessionPort } from "../application/BinarySession.js";
import {
  enhancedInputSchemas,
  enhancedToolNameSchema,
} from "../contracts/enhancedInputs.js";
import {
  ENHANCED_TOOL_CONTRACTS,
  type ToolContract,
} from "../contracts/toolContracts.js";
import { toCallToolResult } from "./toolResult.js";
import type { Logger } from "../logger.js";
import { logToolExecution } from "./toolLogging.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import { createEvidence } from "../domain/evidence.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { AnalysisInputError, UnknownRegistryError } from "../domain/errors.js";
import { ok, type Result } from "../domain/result.js";
import { mcpProgressReporter } from "./mcpProgress.js";
import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import {
  REA_WORKFLOW_PROVIDER,
  workflowAnalysisProfile,
} from "../application/InvestigationProviders.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { safeParseToolInput } from "./toolInputValidation.js";

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
export const registerEnhancedTools = (
  server: McpServer,
  analysis: AnalysisOperationPort,
  options: EnhancedToolRegistration,
): void => {
  const services = new EnhancedTools(analysis);
  for (const contract of ENHANCED_TOOL_CONTRACTS) {
    registerEnhancedTool(server, services, contract, {
      logger: options.logger,
      activeTarget: options.activeTarget,
      analysisProfile: options.analysisProfile,
      recordEvidence: options.recordEvidence,
      recordUnknown: options.recordUnknown,
    });
  }
};

const registerEnhancedTool = (
  server: McpServer,
  services: EnhancedTools,
  contract: ToolContract,
  registration: {
    readonly logger: Logger;
    readonly activeTarget: (() => BinaryTarget | undefined) | undefined;
    readonly analysisProfile:
      | (() => AnalysisProfileCommitment | undefined)
      | undefined;
    readonly recordEvidence: BinarySessionPort["recordEvidence"] | undefined;
    readonly recordUnknown: BinarySessionPort["recordUnknown"] | undefined;
  },
): void => {
  const name = enhancedToolNameSchema.parse(contract.name);
  server.registerTool(
    name,
    toolRegistrationOptions(contract),
    async (input, context) => {
      const progress = mcpProgressReporter(context);
      await progress.report({
        phase: name,
        completed: 0,
        total: 1,
        message: "started",
      });
      const validatedCall = parseEnhancedCall(name, input);
      if (!validatedCall.ok) return toCallToolResult(validatedCall, contract);
      const parsedInput = validatedCall.value.input;
      const parameters = jsonParameters(parsedInput);
      const result = await logToolExecution(registration.logger, name, () =>
        services.executeValidated(validatedCall.value, context.mcpReq.signal),
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
    },
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

type EnhancedToolName = ValidatedEnhancedCall["name"];

type EnhancedInputOf<Name extends EnhancedToolName> = z.output<
  (typeof enhancedInputSchemas)[Name]
>;

type EnhancedInputParser<Name extends EnhancedToolName> = (
  input: unknown,
) => Result<EnhancedInputOf<Name>, AnalysisInputError>;

const ENHANCED_INPUT_PARSERS: {
  [Name in EnhancedToolName]: EnhancedInputParser<Name>;
} = {
  swift_classes: (input) =>
    safeParseToolInput(
      enhancedInputSchemas.swift_classes,
      input,
      "swift_classes",
    ),
  get_objc_classes: (input) =>
    safeParseToolInput(
      enhancedInputSchemas.get_objc_classes,
      input,
      "get_objc_classes",
    ),
  get_objc_protocols: (input) =>
    safeParseToolInput(
      enhancedInputSchemas.get_objc_protocols,
      input,
      "get_objc_protocols",
    ),
  batch_decompile: (input) =>
    safeParseToolInput(
      enhancedInputSchemas.batch_decompile,
      input,
      "batch_decompile",
    ),
  get_call_graph: (input) =>
    safeParseToolInput(
      enhancedInputSchemas.get_call_graph,
      input,
      "get_call_graph",
    ),
  analyze_swift_types: (input) =>
    safeParseToolInput(
      enhancedInputSchemas.analyze_swift_types,
      input,
      "analyze_swift_types",
    ),
  find_xrefs_to_name: (input) =>
    safeParseToolInput(
      enhancedInputSchemas.find_xrefs_to_name,
      input,
      "find_xrefs_to_name",
    ),
  binary_overview: (input) =>
    safeParseToolInput(
      enhancedInputSchemas.binary_overview,
      input,
      "binary_overview",
    ),
  analyze_function: (input) =>
    safeParseToolInput(
      enhancedInputSchemas.analyze_function,
      input,
      "analyze_function",
    ),
  trace_feature: (input) =>
    safeParseToolInput(
      enhancedInputSchemas.trace_feature,
      input,
      "trace_feature",
    ),
};

const parseEnhancedCall = (
  name: ValidatedEnhancedCall["name"],
  input: unknown,
): Result<ValidatedEnhancedCall, AnalysisInputError> => {
  switch (name) {
    case "swift_classes":
      return mapEnhancedCall(
        ENHANCED_INPUT_PARSERS.swift_classes(input),
        (value) => ({ name, input: value }),
      );
    case "get_objc_classes":
      return mapEnhancedCall(
        ENHANCED_INPUT_PARSERS.get_objc_classes(input),
        (value) => ({ name, input: value }),
      );
    case "get_objc_protocols":
      return mapEnhancedCall(
        ENHANCED_INPUT_PARSERS.get_objc_protocols(input),
        (value) => ({ name, input: value }),
      );
    case "batch_decompile":
      return mapEnhancedCall(
        ENHANCED_INPUT_PARSERS.batch_decompile(input),
        (value) => ({ name, input: value }),
      );
    case "get_call_graph":
      return mapEnhancedCall(
        ENHANCED_INPUT_PARSERS.get_call_graph(input),
        (value) => ({ name, input: value }),
      );
    case "analyze_swift_types":
      return mapEnhancedCall(
        ENHANCED_INPUT_PARSERS.analyze_swift_types(input),
        (value) => ({ name, input: value }),
      );
    case "find_xrefs_to_name":
      return mapEnhancedCall(
        ENHANCED_INPUT_PARSERS.find_xrefs_to_name(input),
        (value) => ({ name, input: value }),
      );
    case "binary_overview":
      return mapEnhancedCall(
        ENHANCED_INPUT_PARSERS.binary_overview(input),
        (value) => ({ name, input: value }),
      );
    case "analyze_function":
      return mapEnhancedCall(
        ENHANCED_INPUT_PARSERS.analyze_function(input),
        (value) => ({ name, input: value }),
      );
    case "trace_feature":
      return mapEnhancedCall(
        ENHANCED_INPUT_PARSERS.trace_feature(input),
        (value) => ({ name, input: value }),
      );
  }
};

const mapEnhancedCall = <Input, Call extends ValidatedEnhancedCall>(
  parsed: Result<Input, AnalysisInputError>,
  project: (input: Input) => Call,
): Result<Call, AnalysisInputError> =>
  parsed.ok ? ok(project(parsed.value)) : parsed;

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
    name !== "trace_feature" ||
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
      domain: "control-flow",
      supporting_evidence_ids: [evidenceId],
      contradicting_evidence_ids: [],
      required_authority: "shipped-artifact",
      required_confidence: "observed",
      required_environment: null,
      recommended_probes: [
        {
          operation: "trace_feature",
          rationale: "Continue with a larger bounded budget.",
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
