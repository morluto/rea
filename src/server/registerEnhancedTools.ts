import type { McpServer } from "@modelcontextprotocol/server";

import { EnhancedTools } from "../application/EnhancedTools.js";
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
import { jsonObjectSchema, type JsonValue } from "../domain/jsonValue.js";
import { enhancedInputSchemas } from "../contracts/enhancedInputs.js";
import { UnknownRegistryError } from "../domain/errors.js";

/** Optional session services used by enhanced tool registration. */
export interface EnhancedToolRegistration {
  readonly logger: Logger;
  readonly activeTarget: (() => BinaryTarget | undefined) | undefined;
  readonly recordEvidence: BinarySessionPort["recordEvidence"] | undefined;
  readonly recordUnknown: BinarySessionPort["recordUnknown"] | undefined;
}

const WORKFLOW_PROVIDER = {
  id: "rea-workflow",
  name: "REA composed investigation workflow",
  version: "1",
} as const;

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
    readonly recordEvidence: BinarySessionPort["recordEvidence"] | undefined;
    readonly recordUnknown: BinarySessionPort["recordUnknown"] | undefined;
  },
): void => {
  const name = enhancedToolNameSchema.parse(contract.name);
  server.registerTool(
    name,
    {
      description: contract.description,
      inputSchema: contract.inputSchema,
      outputSchema: contract.outputSchema,
      annotations: contract.annotations,
    },
    async (input, context) => {
      const parsedInput = jsonObjectSchema.parse(
        enhancedInputSchemas[name].parse(input),
      );
      const parameters: Record<string, JsonValue> = { ...parsedInput };
      const result = await logToolExecution(registration.logger, name, () =>
        services.execute(name, input, context.mcpReq.signal),
      );
      if (result.ok) {
        const evidence = createEvidence(
          registration.activeTarget?.(),
          WORKFLOW_PROVIDER,
          {
            operation: name,
            parameters,
            result: result.value,
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
          input: parsedInput,
          result: result.value,
          evidenceId: evidence.evidence_id,
          recordUnknown: registration.recordUnknown,
        });
        if (!unknowns.ok) return toCallToolResult(unknowns, contract);
        return toCallToolResult({ ok: true, value: evidence }, contract);
      }
      return toCallToolResult(result, contract);
    },
  );
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
