import type { McpServer } from "@modelcontextprotocol/server";

import {
  EnhancedTools,
  type ValidatedEnhancedCall,
} from "../application/EnhancedTools.js";
import type { AnalysisOperationPort } from "../application/AnalysisProvider.js";
import type { BinarySessionPort } from "../application/BinarySession.js";
import { enhancedToolNameSchema } from "../contracts/enhancedInputs.js";
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
import { enhancedInputSchemas } from "../contracts/enhancedInputs.js";
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

const parseEnhancedCall = (
  name: ValidatedEnhancedCall["name"],
  input: unknown,
): Result<ValidatedEnhancedCall, AnalysisInputError> => {
  switch (name) {
    case "swift_classes": {
      const parsed = safeParseToolInput(
        enhancedInputSchemas.swift_classes,
        input,
        name,
      );
      return parsed.ok ? ok({ name, input: parsed.value }) : parsed;
    }
    case "get_objc_classes": {
      const parsed = safeParseToolInput(
        enhancedInputSchemas.get_objc_classes,
        input,
        name,
      );
      return parsed.ok ? ok({ name, input: parsed.value }) : parsed;
    }
    case "get_objc_protocols": {
      const parsed = safeParseToolInput(
        enhancedInputSchemas.get_objc_protocols,
        input,
        name,
      );
      return parsed.ok ? ok({ name, input: parsed.value }) : parsed;
    }
    case "batch_decompile": {
      const parsed = safeParseToolInput(
        enhancedInputSchemas.batch_decompile,
        input,
        name,
      );
      return parsed.ok ? ok({ name, input: parsed.value }) : parsed;
    }
    case "get_call_graph": {
      const parsed = safeParseToolInput(
        enhancedInputSchemas.get_call_graph,
        input,
        name,
      );
      return parsed.ok ? ok({ name, input: parsed.value }) : parsed;
    }
    case "analyze_swift_types": {
      const parsed = safeParseToolInput(
        enhancedInputSchemas.analyze_swift_types,
        input,
        name,
      );
      return parsed.ok ? ok({ name, input: parsed.value }) : parsed;
    }
    case "find_xrefs_to_name": {
      const parsed = safeParseToolInput(
        enhancedInputSchemas.find_xrefs_to_name,
        input,
        name,
      );
      return parsed.ok ? ok({ name, input: parsed.value }) : parsed;
    }
    case "binary_overview": {
      const parsed = safeParseToolInput(
        enhancedInputSchemas.binary_overview,
        input,
        name,
      );
      return parsed.ok ? ok({ name, input: parsed.value }) : parsed;
    }
    case "analyze_function": {
      const parsed = safeParseToolInput(
        enhancedInputSchemas.analyze_function,
        input,
        name,
      );
      return parsed.ok ? ok({ name, input: parsed.value }) : parsed;
    }
    case "trace_feature": {
      const parsed = safeParseToolInput(
        enhancedInputSchemas.trace_feature,
        input,
        name,
      );
      return parsed.ok ? ok({ name, input: parsed.value }) : parsed;
    }
  }
};

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
