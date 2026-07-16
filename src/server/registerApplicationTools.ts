import type { McpServer } from "@modelcontextprotocol/server";

import type { BinarySessionPort } from "../application/BinarySession.js";
import {
  compareApplicationVersionsEvidence,
  traceApplicationFeatureEvidence,
} from "../application/JavaScriptApplicationWorkflowService.js";
import {
  runControlledReplay,
  type JavaScriptReplayDependencies,
} from "../application/JavaScriptReplayService.js";
import { APPLICATION_TOOL_CONTRACTS } from "../contracts/applicationToolContracts.js";
import { compareApplicationVersionsInputSchema } from "../domain/javascriptApplicationVersionComparisonSchemas.js";
import { applicationVersionComparisonResultSchema } from "../domain/javascriptApplicationVersionComparisonSchemas.js";
import { traceApplicationFeatureInputSchema } from "../domain/javascriptFeatureTraceSchemas.js";
import { parseEvidence, type Evidence } from "../domain/evidence.js";
import type { Logger } from "../logger.js";
import {
  controlledReplayInputSchema,
  controlledReplayOutputSchema,
} from "../domain/javascriptReplay.js";
import { logToolExecution } from "./toolLogging.js";
import { toCallToolResult } from "./toolResult.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { mcpProgressReporter } from "./mcpProgress.js";

interface ApplicationToolRegistration {
  readonly logger: Logger;
  readonly recordEvidence: BinarySessionPort["recordEvidence"] | undefined;
  readonly recordEvidenceWithUnknown:
    | BinarySessionPort["recordEvidenceWithUnknown"]
    | undefined;
  readonly replay: JavaScriptReplayDependencies;
}

/** Register provider-neutral JavaScript application graph workflows. */
export const registerApplicationTools = (
  server: McpServer,
  options: ApplicationToolRegistration,
): void => {
  const [traceContract, compareContract, replayContract] =
    APPLICATION_TOOL_CONTRACTS;
  server.registerTool(
    traceContract.name,
    toolRegistrationOptions(traceContract),
    async (input) => {
      const parsed = traceApplicationFeatureInputSchema.parse(input);
      const result = await logToolExecution(
        options.logger,
        traceContract.name,
        () => Promise.resolve(traceApplicationFeatureEvidence(parsed)),
      );
      if (!result.ok) return toCallToolResult(result, traceContract);
      const sources = [parsed.application, ...parsed.native_observations];
      const recorded = recordSources(options.recordEvidence, sources);
      if (!recorded.ok) return toCallToolResult(recorded, traceContract);
      return recordResult(options, traceContract, result.value);
    },
  );
  server.registerTool(
    compareContract.name,
    toolRegistrationOptions(compareContract),
    async (input) => {
      const parsed = compareApplicationVersionsInputSchema.parse(input);
      const result = await logToolExecution(
        options.logger,
        compareContract.name,
        () => Promise.resolve(compareApplicationVersionsEvidence(parsed)),
      );
      if (!result.ok) return toCallToolResult(result, compareContract);
      const sources = [
        parsed.left,
        parsed.right,
        ...parsed.left_native_observations,
        ...parsed.right_native_observations,
      ];
      const recorded = recordSources(options.recordEvidence, sources);
      if (!recorded.ok) return toCallToolResult(recorded, compareContract);
      const comparison = applicationVersionComparisonResultSchema.parse(
        result.value.normalized_result,
      );
      const unknown = comparison.summary.unknown > 0;
      return recordResult(
        options,
        compareContract,
        result.value,
        parsed.unknown_registry_approved === true && unknown,
      );
    },
  );
  server.registerTool(
    replayContract.name,
    toolRegistrationOptions(replayContract),
    async (input, context) => {
      const parsed = controlledReplayInputSchema.parse(input);
      const result = await logToolExecution(
        options.logger,
        replayContract.name,
        () =>
          runControlledReplay(options.replay, parsed, {
            signal: context.mcpReq.signal,
            progress: mcpProgressReporter(context),
          }),
      );
      if (!result.ok) return toCallToolResult(result, replayContract);
      const output = controlledReplayOutputSchema.parse(result.value);
      if (output.evidence !== null) {
        const sourcesRecorded = recordSources(
          options.recordEvidence,
          output.source_evidence.map((item) => parseEvidence(item)),
        );
        if (!sourcesRecorded.ok)
          return toCallToolResult(sourcesRecorded, replayContract);
        const recorded = options.recordEvidence?.(
          parseEvidence(output.evidence),
        );
        if (recorded !== undefined && !recorded.ok)
          return toCallToolResult(recorded, replayContract);
      }
      return toCallToolResult(result, replayContract, {
        evidenceResourcesAvailable:
          output.evidence !== null && options.recordEvidence !== undefined,
      });
    },
  );
};

const recordSources = (
  recordEvidence: ApplicationToolRegistration["recordEvidence"],
  sources: readonly Evidence[],
) => {
  for (const source of sources) {
    const recorded = recordEvidence?.(source);
    if (recorded !== undefined && !recorded.ok) return recorded;
  }
  return { ok: true as const, value: null };
};

const recordResult = (
  options: ApplicationToolRegistration,
  contract: (typeof APPLICATION_TOOL_CONTRACTS)[number],
  evidence: Evidence,
  recordUnknown = false,
) => {
  const recorded = recordUnknown
    ? options.recordEvidenceWithUnknown?.(evidence, {
        approved: true,
        question:
          "Which application entities remain unmatched or ambiguous across these versions?",
        severity: "medium",
        domain: "application-version-comparison",
        supporting_evidence_ids: [evidence.evidence_id],
        contradicting_evidence_ids: [],
        required_authority: "shipped-artifact",
        required_confidence: "observed",
        required_environment: null,
        recommended_probes: [
          {
            operation: "analyze_javascript_application",
            rationale:
              "Repeat static reconstruction with complete artifacts and source maps when available.",
          },
          {
            operation: "reconcile_javascript_runtime",
            rationale:
              "Add approved passive runtime Evidence without promoting it to static fact.",
          },
        ],
        relationships: [],
      })
    : options.recordEvidence?.(evidence);
  if (recorded !== undefined && !recorded.ok)
    return toCallToolResult(recorded, contract);
  return toCallToolResult({ ok: true, value: evidence }, contract, {
    evidenceResourcesAvailable: recorded !== undefined,
  });
};
