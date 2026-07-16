import type { McpServer } from "@modelcontextprotocol/server";

import type { BinarySessionPort } from "../application/BinarySession.js";
import {
  compareApplicationVersionsEvidenceValidated,
  traceApplicationFeatureEvidenceValidated,
} from "../application/JavaScriptApplicationWorkflowService.js";
import {
  runControlledReplayValidated,
  type JavaScriptReplayDependencies,
} from "../application/JavaScriptReplayService.js";
import {
  executeNodeCharacterization,
  prepareNodeCharacterization,
} from "../application/NodeRuntimeCharacterizationService.js";
import {
  commitReconstructionCoverage,
  queryReconstructionCoverage,
} from "../application/ReconstructionCoverageService.js";
import { readReconstructionCoverageWorkspace } from "../application/ReconstructionCoverageWorkspaceStore.js";
import {
  authorizeFileReadWithDeferredWrite,
  authorizeRootPermission,
} from "../application/DeferredFileAuthorization.js";
import type { PermissionAuthority } from "../application/PermissionAuthority.js";
import type { EvidenceFilePolicy } from "../domain/evidenceBundle.js";
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
import {
  nodeCharacterizationExecutionInputSchema,
  nodeCharacterizationExecutionOutputSchema,
  nodeCharacterizationPreparationInputSchema,
  nodeCharacterizationPreparationOutputSchema,
} from "../domain/nodeRuntimeCharacterization.js";
import {
  reconstructionCoverageCommitInputSchema,
  reconstructionCoverageQueryInputSchema,
} from "../application/ReconstructionCoverageService.js";
import { reconstructionClosureResultSchema } from "../domain/reconstructionCoverage.js";
import {
  AnalysisCapabilityUnavailableError,
  EvidenceIntegrityError,
} from "../domain/errors.js";
import { err } from "../domain/result.js";
import { logToolExecution } from "./toolLogging.js";
import { toCallToolResult } from "./toolResult.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { safeParseToolInput } from "./toolInputValidation.js";
import { mcpProgressReporter } from "./mcpProgress.js";

interface ApplicationToolRegistration {
  readonly logger: Logger;
  readonly recordEvidence: BinarySessionPort["recordEvidence"] | undefined;
  readonly recordEvidenceWithUnknown:
    | BinarySessionPort["recordEvidenceWithUnknown"]
    | undefined;
  readonly replay: JavaScriptReplayDependencies;
  readonly evidenceFilePolicy: EvidenceFilePolicy;
  readonly permissionAuthority: PermissionAuthority | undefined;
  readonly retainCoverageWorkspace:
    | BinarySessionPort["retainReconstructionCoverageWorkspace"]
    | undefined;
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
      const parsedInput = safeParseToolInput(
        traceApplicationFeatureInputSchema,
        input,
        traceContract.name,
      );
      if (!parsedInput.ok) return toCallToolResult(parsedInput, traceContract);
      const parsed = parsedInput.value;
      const result = await logToolExecution(
        options.logger,
        traceContract.name,
        () => Promise.resolve(traceApplicationFeatureEvidenceValidated(parsed)),
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
      const parsedInput = safeParseToolInput(
        compareApplicationVersionsInputSchema,
        input,
        compareContract.name,
      );
      if (!parsedInput.ok)
        return toCallToolResult(parsedInput, compareContract);
      const parsed = parsedInput.value;
      const result = await logToolExecution(
        options.logger,
        compareContract.name,
        () =>
          Promise.resolve(compareApplicationVersionsEvidenceValidated(parsed)),
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
      const parsedInput = safeParseToolInput(
        controlledReplayInputSchema,
        input,
        replayContract.name,
      );
      if (!parsedInput.ok) return toCallToolResult(parsedInput, replayContract);
      const parsed = parsedInput.value;
      const result = await logToolExecution(
        options.logger,
        replayContract.name,
        () =>
          runControlledReplayValidated(options.replay, parsed, {
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
  registerCharacterizationTools(server, options);
  registerCoverageTools(server, options);
};

const registerCharacterizationTools = (
  server: McpServer,
  options: ApplicationToolRegistration,
): void => {
  const prepareContract = APPLICATION_TOOL_CONTRACTS[3];
  const executeContract = APPLICATION_TOOL_CONTRACTS[4];
  server.registerTool(
    prepareContract.name,
    toolRegistrationOptions(prepareContract),
    async (input, context) => {
      const parsed = safeParseToolInput(
        nodeCharacterizationPreparationInputSchema,
        input,
        prepareContract.name,
      );
      if (!parsed.ok) return toCallToolResult(parsed, prepareContract);
      const result = await logToolExecution(
        options.logger,
        prepareContract.name,
        () =>
          prepareNodeCharacterization(options.replay, parsed.value, {
            signal: context.mcpReq.signal,
            progress: mcpProgressReporter(context),
          }),
      );
      if (!result.ok) return toCallToolResult(result, prepareContract);
      const output = nodeCharacterizationPreparationOutputSchema.parse(
        result.value,
      );
      const recorded = options.recordEvidence?.(
        parseEvidence(output.transformation_evidence),
      );
      if (recorded !== undefined && !recorded.ok)
        return toCallToolResult(recorded, prepareContract);
      return toCallToolResult(result, prepareContract, {
        evidenceResourcesAvailable: options.recordEvidence !== undefined,
      });
    },
  );
  server.registerTool(
    executeContract.name,
    toolRegistrationOptions(executeContract),
    async (input, context) => {
      const parsed = safeParseToolInput(
        nodeCharacterizationExecutionInputSchema,
        input,
        executeContract.name,
      );
      if (!parsed.ok) return toCallToolResult(parsed, executeContract);
      const result = await logToolExecution(
        options.logger,
        executeContract.name,
        () =>
          executeNodeCharacterization(options.replay, parsed.value, {
            signal: context.mcpReq.signal,
            progress: mcpProgressReporter(context),
          }),
      );
      if (!result.ok) return toCallToolResult(result, executeContract);
      const output = nodeCharacterizationExecutionOutputSchema.parse(
        result.value,
      );
      const sources = [
        output.transformation_evidence,
        ...output.replay.source_evidence,
        ...(output.replay.evidence === null ? [] : [output.replay.evidence]),
        output.evidence,
      ].map((item) => parseEvidence(item));
      const recorded = recordSources(options.recordEvidence, sources);
      if (!recorded.ok) return toCallToolResult(recorded, executeContract);
      return toCallToolResult(result, executeContract, {
        evidenceResourcesAvailable: options.recordEvidence !== undefined,
      });
    },
  );
};

const registerCoverageTools = (
  server: McpServer,
  options: ApplicationToolRegistration,
): void => {
  const commitContract = APPLICATION_TOOL_CONTRACTS[5];
  const queryContract = APPLICATION_TOOL_CONTRACTS[6];
  server.registerTool(
    commitContract.name,
    toolRegistrationOptions(commitContract),
    async (input, context) => {
      const parsed = safeParseToolInput(
        reconstructionCoverageCommitInputSchema,
        input,
        commitContract.name,
      );
      if (!parsed.ok) return toCallToolResult(parsed, commitContract);
      if (options.permissionAuthority === undefined)
        return toCallToolResult(
          err(
            new AnalysisCapabilityUnavailableError(
              "rea-reconstruction-coverage",
              commitContract.name,
              "workspace permission policy is not configured",
            ),
          ),
          commitContract,
        );
      const authorization = await authorizeFileReadWithDeferredWrite(
        options.permissionAuthority,
        {
          path: parsed.value.workspace_path,
          readCapability: "investigation_workspace_read",
          writeCapability: "investigation_workspace_write",
          operation: commitContract.name,
        },
      );
      if (!authorization.ok)
        return toCallToolResult(authorization, commitContract);
      const write = await authorization.value.authorizeWrite();
      if (!write.ok) return toCallToolResult(write, commitContract);
      const result = await logToolExecution(
        options.logger,
        commitContract.name,
        () =>
          commitReconstructionCoverage(
            parsed.value,
            options.evidenceFilePolicy,
            { signal: context.mcpReq.signal },
          ),
      );
      if (!result.ok) return toCallToolResult(result, commitContract);
      options.retainCoverageWorkspace?.(parsed.value.workspace);
      return toCallToolResult(result, commitContract, {
        resourceLinks:
          options.retainCoverageWorkspace === undefined
            ? []
            : [
                {
                  uri: coverageWorkspaceUri(parsed.value.workspace),
                  name: parsed.value.workspace.workspace_id,
                  description:
                    "Session-retained reconstruction coverage workspace revision",
                },
              ],
      });
    },
  );
  server.registerTool(
    queryContract.name,
    toolRegistrationOptions(queryContract),
    async (input, context) => {
      const parsed = safeParseToolInput(
        reconstructionCoverageQueryInputSchema,
        input,
        queryContract.name,
      );
      if (!parsed.ok) return toCallToolResult(parsed, queryContract);
      if (options.permissionAuthority === undefined)
        return toCallToolResult(
          err(
            new AnalysisCapabilityUnavailableError(
              "rea-reconstruction-coverage",
              queryContract.name,
              "workspace permission policy is not configured",
            ),
          ),
          queryContract,
        );
      const authorized = await authorizeRootPermission(
        options.permissionAuthority,
        {
          capability: "investigation_workspace_read",
          roots: [parsed.value.workspace_path],
          access: "read",
          operation: queryContract.name,
        },
      );
      if (!authorized.ok) return toCallToolResult(authorized, queryContract);
      const result = await logToolExecution(
        options.logger,
        queryContract.name,
        () =>
          queryReconstructionCoverage(
            parsed.value,
            options.evidenceFilePolicy,
            Date.now(),
            { signal: context.mcpReq.signal },
          ),
      );
      if (result.ok && options.retainCoverageWorkspace !== undefined) {
        const closure = reconstructionClosureResultSchema.parse(result.value);
        const loaded = await readReconstructionCoverageWorkspace(
          parsed.value.workspace_path,
          options.evidenceFilePolicy,
        );
        if (!loaded.ok) return toCallToolResult(loaded, queryContract);
        if (
          loaded.value === null ||
          loaded.value.revision_sha256 !== closure.workspace_revision_sha256
        )
          return toCallToolResult(
            err(
              new EvidenceIntegrityError(
                "workspace changed while its closure was being retained",
              ),
            ),
            queryContract,
          );
        options.retainCoverageWorkspace(loaded.value);
      }
      return toCallToolResult(result, queryContract);
    },
  );
};

const coverageWorkspaceUri = (workspace: {
  readonly workspace_id: string;
  readonly revision: number;
}): string =>
  `rea://reconstruction-coverage/${workspace.workspace_id}/revision/${String(workspace.revision)}`;

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
