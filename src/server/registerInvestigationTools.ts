import type { McpServer } from "@modelcontextprotocol/server";

import type { BinarySessionPort } from "../application/BinarySession.js";
import { runCrossVersionInvestigationValidated } from "../application/CrossVersionInvestigation.js";
import type { ToolContract } from "../contracts/toolContracts.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { safeParseToolInput } from "./toolInputValidation.js";
import { buildCallPath, callPathInputSchema } from "../domain/callPath.js";
import {
  correlateStaticAndRuntime,
  staticRuntimeCorrelationInputSchema,
} from "../domain/staticRuntimeCorrelation.js";
import {
  reconstructionVerificationInputSchema,
  verifyReconstruction,
} from "../domain/reconstructionVerification.js";
import { evaluateReconstructionClosure } from "../domain/reconstructionCoverage.js";
import {
  changedBehaviorResultSchema,
  changedBehaviorInputSchema,
  findChangedBehavior,
} from "../domain/changedBehavior.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import type { EvidenceFilePolicy } from "../domain/evidenceBundle.js";
import {
  AnalysisInputError,
  EvidenceIntegrityError,
  type AnalysisError,
} from "../domain/errors.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  CALL_PATH_PROVIDER,
  CHANGED_BEHAVIOR_PROVIDER,
  RECONSTRUCTION_PROVIDER,
  STATIC_RUNTIME_PROVIDER,
} from "./sessionToolPolicies.js";
import { toCallToolResult } from "./toolResult.js";
import { recordDerivedEvidence } from "./recordDerivedEvidence.js";
import type { PermissionAuthority } from "../application/PermissionAuthority.js";
import type { ProgressReporter } from "../application/ProgressReporter.js";
import { mcpProgressReporter } from "./mcpProgress.js";
import { runDerivedOperation } from "./runDerivedOperation.js";
import {
  authorizeFileReadWithDeferredWrite,
  authorizeRootPermission,
  type DeferredFileWriteAuthorization,
} from "../application/DeferredFileAuthorization.js";

/** Register Evidence-composed differential investigation workflows. */
export const registerInvestigationTools = (
  server: McpServer,
  session: BinarySessionPort,
  contracts: readonly [
    ToolContract<"find_changed_behavior">,
    ToolContract<"build_call_path">,
    ToolContract<"correlate_static_and_runtime">,
    ToolContract<"verify_reconstruction">,
  ],
  policies: InvestigationToolPolicies,
): void => {
  registerChangedBehavior(server, session, contracts[0], policies);
  registerCallPath(server, session, contracts[1]);
  registerStaticRuntime(server, session, contracts[2]);
  registerReconstruction(server, session, contracts[3]);
};

interface InvestigationToolPolicies {
  readonly evidenceFiles: EvidenceFilePolicy;
  readonly inputRoots: readonly string[];
  readonly permissionAuthority?: PermissionAuthority;
  readonly integrityContinueEnabled?: () => boolean;
}

const investigationExecution = (
  session: BinarySessionPort,
  signal: AbortSignal,
  inputRoots: readonly string[],
  integrityContinueEnabled: boolean,
  progress?: ProgressReporter,
) => ({
  session,
  signal,
  inputRoots,
  integrityContinueEnabled,
  ...(progress === undefined ? {} : { progress }),
});

const isIncomplete = (status: string): boolean =>
  status === "unknown" || status === "truncated";

const registerChangedBehavior = (
  server: McpServer,
  session: BinarySessionPort,
  contract: ToolContract<"find_changed_behavior">,
  policies: InvestigationToolPolicies,
): void => {
  server.registerTool(
    contract.name,
    contractOptions(contract),
    async (input, context) => {
      const parsedInput = safeParseToolInput(
        changedBehaviorInputSchema,
        input,
        contract.name,
      );
      if (!parsedInput.ok) return toCallToolResult(parsedInput, contract);
      const parsed = parsedInput.value;
      const investigationRun = parsed.investigation_run;
      if (investigationRun !== undefined) {
        const progress = mcpProgressReporter(context);
        let workspaceAuthorization: DeferredFileWriteAuthorization | undefined;
        let authorizeInputRead:
          | (() => Promise<Result<null, AnalysisError>>)
          | undefined;
        if (policies.permissionAuthority !== undefined) {
          const authority = policies.permissionAuthority;
          const authorizedWorkspace = await authorizeFileReadWithDeferredWrite(
            authority,
            {
              path: investigationRun.workspace_path,
              readCapability: "investigation_workspace_read",
              writeCapability: "investigation_workspace_write",
              operation: contract.name,
            },
          );
          if (!authorizedWorkspace.ok)
            return toCallToolResult(authorizedWorkspace, contract);
          workspaceAuthorization = authorizedWorkspace.value;
          authorizeInputRead = () =>
            authorizeRootPermission(authority, {
              capability: "investigation_input",
              roots: [investigationRun.left_path, investigationRun.right_path],
              access: "read",
              operation: contract.name,
            });
        }
        const investigated = await runCrossVersionInvestigationValidated(
          investigationRun,
          policies.evidenceFiles,
          {
            ...investigationExecution(
              session,
              context.mcpReq.signal,
              policies.inputRoots,
              policies.integrityContinueEnabled?.() ?? false,
              progress,
            ),
            ...(workspaceAuthorization === undefined
              ? {}
              : {
                  authorizeWorkspaceWrite:
                    workspaceAuthorization.authorizeWrite,
                }),
            ...(authorizeInputRead === undefined ? {} : { authorizeInputRead }),
          },
        );
        if (!investigated.ok) return toCallToolResult(investigated, contract);
        const workspace = investigated.value.workspace;
        if (session.retainInvestigationWorkspace(workspace) === "added")
          server.sendResourceListChanged();
        const result = changedBehaviorResultSchema.parse(
          investigated.value.evidence.normalized_result,
        );
        const toolResult = toCallToolResult(
          recordWorkflowEvidence(
            session,
            investigated.value.evidence,
            parsed.unknown_registry_approved,
            isIncomplete(result.behavior_status),
            {
              question: `Automatic changed behavior run ${result.investigation_run?.run_id ?? "unknown"} remains ${result.behavior_status}`,
              domain: "changed-behavior",
              requiredAuthority: "controlled-replay",
              requiredConfidence: "observed",
              probes: [
                {
                  operation: "capture_process_scenario",
                  rationale:
                    "Capture both versions under the same bounded scenario and environment.",
                },
              ],
            },
          ),
          contract,
        );
        return {
          ...toolResult,
          content: [
            ...toolResult.content,
            {
              type: "resource_link" as const,
              uri: `rea://workspace/${workspace.workspace_id}/revision/${String(workspace.revision)}`,
              name: `${workspace.workspace_id} revision ${String(workspace.revision)}`,
              description:
                "Immutable CAS-linked investigation workspace revision",
              mimeType: "application/json",
            },
          ],
        };
      }
      const closure = evidenceClosure(
        session,
        comparisonClosure(parsed.comparisons),
      );
      if (!closure.ok) return toCallToolResult(closure, contract);
      const links = closure.value;
      const computed = await runDerivedOperation(context, contract.name, () =>
        findChangedBehavior(parsed.comparisons, parsed.offset, parsed.limit),
      );
      if (!computed.ok) return toCallToolResult(computed, contract);
      const result = computed.value;
      const evidence = createEvidence(undefined, CHANGED_BEHAVIOR_PROVIDER, {
        predicateType: "rea.changed-behavior/v1",
        operation: contract.name,
        parameters: {
          comparison_evidence_ids: parsed.comparisons.map(
            ({ evidence_id: id }) => id,
          ),
          offset: parsed.offset,
          limit: parsed.limit,
        },
        result: jsonValueSchema.parse(result),
        confidence: "derived",
        authority: "analyst-inference",
        limitations: result.limitations,
        evidenceLinks: links,
      });
      const recorded = recordWorkflowEvidence(
        session,
        evidence,
        parsed.unknown_registry_approved,
        isIncomplete(result.behavior_status),
        {
          question:
            "Did both versions behave the same under a complete controlled replay?",
          domain: "changed-behavior",
          requiredAuthority: "controlled-replay",
          requiredConfidence: "observed",
          probes: [
            {
              operation: "capture_process_scenario",
              rationale:
                "Capture both versions under the same bounded scenario and environment.",
            },
          ],
        },
      );
      return toCallToolResult(recorded, contract);
    },
  );
};

const registerCallPath = (
  server: McpServer,
  session: BinarySessionPort,
  contract: ToolContract<"build_call_path">,
): void => {
  server.registerTool(
    contract.name,
    contractOptions(contract),
    async (input, context) => {
      const parsedInput = safeParseToolInput(
        callPathInputSchema,
        input,
        contract.name,
      );
      if (!parsedInput.ok) return toCallToolResult(parsedInput, contract);
      const parsed = parsedInput.value;
      const closure = evidenceClosure(
        session,
        functionEvidenceIds(parsed.functions),
      );
      if (!closure.ok) return toCallToolResult(closure, contract);
      const links = closure.value;
      const computed = await runDerivedOperation(context, contract.name, () =>
        buildCallPath(parsed),
      );
      if (!computed.ok) return toCallToolResult(computed, contract);
      const result = computed.value;
      const evidence = createEvidence(undefined, CALL_PATH_PROVIDER, {
        predicateType: "rea.call-path/v1",
        operation: contract.name,
        parameters: {
          start: parsed.start.address,
          goal: parsed.goal.address,
          max_depth: parsed.max_depth,
          max_paths: parsed.max_paths,
          offset: parsed.offset,
          limit: parsed.limit,
        },
        result: jsonValueSchema.parse(result),
        confidence: "derived",
        authority: "analyst-inference",
        limitations: result.limitations,
        evidenceLinks: links,
      });
      const recorded = recordWorkflowEvidence(
        session,
        evidence,
        parsed.unknown_registry_approved,
        result.status === "unknown" || result.status === "truncated",
        {
          question:
            "Can the requested call path be established from complete analysis?",
          domain: "call-path",
          requiredAuthority: "shipped-artifact",
          requiredConfidence: "derived",
          probes: [
            {
              operation: "analyze_function",
              rationale:
                "Collect complete callee dossiers for the reported frontier addresses.",
            },
          ],
        },
      );
      return toCallToolResult(recorded, contract);
    },
  );
};

const registerStaticRuntime = (
  server: McpServer,
  session: BinarySessionPort,
  contract: ToolContract<"correlate_static_and_runtime">,
): void => {
  server.registerTool(
    contract.name,
    contractOptions(contract),
    async (input, context) => {
      const parsedInput = safeParseToolInput(
        staticRuntimeCorrelationInputSchema,
        input,
        contract.name,
      );
      if (!parsedInput.ok) return toCallToolResult(parsedInput, contract);
      const parsed = parsedInput.value;
      const closure = evidenceClosure(
        session,
        comparisonClosure([
          ...parsed.static_comparisons,
          ...parsed.runtime_comparisons,
        ]),
      );
      if (!closure.ok) return toCallToolResult(closure, contract);
      const links = closure.value;
      const computed = await runDerivedOperation(context, contract.name, () =>
        correlateStaticAndRuntime(parsed),
      );
      if (!computed.ok) return toCallToolResult(computed, contract);
      const result = computed.value;
      const evidence = createEvidence(undefined, STATIC_RUNTIME_PROVIDER, {
        predicateType: "rea.static-runtime-correlation/v1",
        operation: contract.name,
        parameters: {
          mapping_count: parsed.mappings.length,
          offset: parsed.offset,
          limit: parsed.limit,
        },
        result: jsonValueSchema.parse(result),
        confidence: "inferred",
        authority: "analyst-inference",
        limitations: result.limitations,
        evidenceLinks: links,
      });
      return toCallToolResult(
        recordWorkflowEvidence(
          session,
          evidence,
          parsed.unknown_registry_approved,
          result.status === "unknown" || result.status === "truncated",
          {
            question:
              "Does runtime behavior match the available static analysis?",
            domain: "static-runtime-correlation",
            requiredAuthority: null,
            requiredConfidence: "derived",
            probes: [
              {
                operation: "capture_process_scenario",
                rationale:
                  "Repeat runtime observations and complete the mapped static comparison Evidence.",
              },
            ],
          },
        ),
        contract,
      );
    },
  );
};

const registerReconstruction = (
  server: McpServer,
  session: BinarySessionPort,
  contract: ToolContract<"verify_reconstruction">,
): void => {
  server.registerTool(
    contract.name,
    contractOptions(contract),
    async (input, context) => {
      const parsedInput = safeParseToolInput(
        reconstructionVerificationInputSchema,
        input,
        contract.name,
      );
      if (!parsedInput.ok) return toCallToolResult(parsedInput, contract);
      const parsed = parsedInput.value;
      const coverage = parsed.coverage;
      if (coverage !== undefined) {
        const workspace = session.reconstructionCoverageWorkspace(
          coverage.workspace_id,
          coverage.revision,
        );
        if (
          workspace === undefined ||
          workspace.revision_sha256 !== coverage.revision_sha256
        )
          return toCallToolResult(
            err(
              new EvidenceIntegrityError(
                "The requested reconstruction coverage revision is not retained by this session",
              ),
            ),
            contract,
          );
        let coverageResult;
        try {
          coverageResult = evaluateReconstructionClosure(
            workspace,
            coverage.boundary_id,
            Date.now(),
          );
        } catch (cause: unknown) {
          return toCallToolResult(
            err(new AnalysisInputError(contract.name, { cause })),
            contract,
          );
        }
        if (coverageResult.status !== "ready")
          return toCallToolResult(
            err(
              new EvidenceIntegrityError(
                `Reconstruction coverage boundary is ${coverageResult.status}; readiness requires ready`,
              ),
            ),
            contract,
          );
      }
      const owned = session.exportEvidenceBundle();
      const computed = await runDerivedOperation(context, contract.name, () =>
        verifyReconstruction(
          parsed.specification,
          owned,
          parsed.offset,
          parsed.limit,
        ),
      );
      if (!computed.ok) return toCallToolResult(computed, contract);
      const result = computed.value;
      const closure = evidenceClosure(session, result.evidence_links);
      if (!closure.ok) return toCallToolResult(closure, contract);
      const links = closure.value;
      const evidence = createEvidence(undefined, RECONSTRUCTION_PROVIDER, {
        predicateType: "rea.reconstruction-verification/v1",
        operation: contract.name,
        parameters: {
          specification_sha256: result.specification_sha256,
          claim_ids: parsed.specification.claims.map(({ claim_id: id }) => id),
          offset: parsed.offset,
          limit: parsed.limit,
        },
        result: jsonValueSchema.parse(result),
        confidence: "derived",
        authority: "analyst-inference",
        limitations: result.limitations,
        evidenceLinks: links,
      });
      return toCallToolResult(
        recordWorkflowEvidence(
          session,
          evidence,
          parsed.unknown_registry_approved,
          result.status === "unknown",
          {
            question: "Does the reconstruction satisfy every declared claim?",
            domain: "reconstruction-verification",
            requiredAuthority: null,
            requiredConfidence: "derived",
            probes: result.recommended_probes.map(
              ({ operation, rationale }) => ({
                operation,
                rationale,
              }),
            ),
          },
        ),
        contract,
      );
    },
  );
};

const contractOptions = toolRegistrationOptions;

const comparisonClosure = (comparisons: readonly Evidence[]): string[] =>
  uniqueIds(
    comparisons.flatMap((evidence) => [
      evidence.evidence_id,
      ...evidence.evidence_links,
    ]),
  );

const functionEvidenceIds = (
  groups: readonly (Evidence | readonly Evidence[])[],
): string[] =>
  uniqueIds(
    groups.flatMap((group) =>
      (Array.isArray(group) ? group : [group]).map(({ evidence_id: id }) => id),
    ),
  );

const uniqueIds = (ids: readonly string[]): string[] =>
  [...new Set(ids)].sort((left, right) => left.localeCompare(right));

const evidenceClosure = (
  session: BinarySessionPort,
  seedIds: readonly string[],
): Result<string[], EvidenceIntegrityError> => {
  const records = new Map(
    session
      .exportEvidenceBundle()
      .records.map((evidence) => [evidence.evidence_id, evidence]),
  );
  const visited = new Set<string>();
  const pending = [...seedIds];
  while (pending.length > 0) {
    const evidenceId = pending.pop();
    if (evidenceId === undefined || visited.has(evidenceId)) continue;
    const evidence = records.get(evidenceId);
    if (evidence === undefined)
      return err(
        new EvidenceIntegrityError(
          "Investigation input has a dangling Evidence link",
        ),
      );
    visited.add(evidenceId);
    pending.push(...evidence.evidence_links);
  }
  return ok(uniqueIds([...visited]));
};

const recordWorkflowEvidence = (
  ...[session, evidence, approved, unresolved, input]: readonly [
    BinarySessionPort,
    Evidence,
    true | undefined,
    boolean,
    {
      readonly question: string;
      readonly domain: string;
      readonly requiredAuthority:
        | "shipped-artifact"
        | "controlled-replay"
        | null;
      readonly requiredConfidence: "observed" | "derived";
      readonly probes: readonly {
        readonly operation: string;
        readonly rationale: string;
      }[];
    },
  ]
): Result<Evidence, import("../domain/errors.js").AnalysisError> => {
  if (approved !== true || !unresolved) {
    return recordDerivedEvidence(session, evidence, undefined);
  }
  return recordDerivedEvidence(session, evidence, {
    approved: true,
    question: input.question,
    severity: "high",
    domain: input.domain,
    supporting_evidence_ids: [evidence.evidence_id],
    contradicting_evidence_ids: [],
    required_authority: input.requiredAuthority,
    required_confidence: input.requiredConfidence,
    required_environment: null,
    recommended_probes: [...input.probes],
    relationships: [],
  });
};
