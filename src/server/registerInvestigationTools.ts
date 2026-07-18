import type { McpServer } from "@modelcontextprotocol/server";
import type { z } from "zod";

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
import {
  changedBehaviorResultSchema,
  changedBehaviorInputSchema,
  findChangedBehavior,
} from "../domain/changedBehavior.js";
import { createEvidence } from "../domain/evidence.js";
import { type AnalysisError } from "../domain/errors.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import type { Result } from "../domain/result.js";
import {
  CALL_PATH_PROVIDER,
  CHANGED_BEHAVIOR_PROVIDER,
  RECONSTRUCTION_PROVIDER,
  STATIC_RUNTIME_PROVIDER,
} from "./sessionToolPolicies.js";
import { toCallToolResult } from "./toolResult.js";
import { mcpProgressReporter } from "./mcpProgress.js";
import {
  runDerivedOperation,
  type DerivedOperationContext,
} from "./runDerivedOperation.js";
import {
  authorizeFileReadWithDeferredWrite,
  authorizeRootPermission,
  type DeferredFileWriteAuthorization,
} from "../application/DeferredFileAuthorization.js";
import {
  comparisonClosure,
  evidenceClosure,
  functionEvidenceIds,
  investigationContext,
  isIncomplete,
  recordWorkflowEvidence,
  verifyCoverageReadiness,
} from "./registerInvestigationTools/helpers.js";
import type { InvestigationToolPolicies } from "./registerInvestigationTools/types.js";

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
      if (investigationRun !== undefined)
        return runAutomaticInvestigation({
          server,
          session,
          contract,
          policies,
          investigationRun,
          unknownRegistryApproved: parsed.unknown_registry_approved,
          context,
        });
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

const runAutomaticInvestigation = async (input: {
  readonly server: McpServer;
  readonly session: BinarySessionPort;
  readonly contract: ToolContract<"find_changed_behavior">;
  readonly policies: InvestigationToolPolicies;
  readonly investigationRun: NonNullable<
    z.output<typeof changedBehaviorInputSchema>["investigation_run"]
  >;
  readonly unknownRegistryApproved: true | undefined;
  readonly context: DerivedOperationContext;
}) => {
  const { policies, investigationRun, contract, session } = input;
  const progress = mcpProgressReporter(input.context);
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
      ...investigationContext({
        session,
        signal: input.context.mcpReq.signal,
        inputRoots: policies.inputRoots,
        integrityContinueEnabled:
          policies.integrityContinueEnabled?.() ?? false,
        progress,
      }),
      ...(workspaceAuthorization === undefined
        ? {}
        : { authorizeWorkspaceWrite: workspaceAuthorization.authorizeWrite }),
      ...(authorizeInputRead === undefined ? {} : { authorizeInputRead }),
    },
  );
  if (!investigated.ok) return toCallToolResult(investigated, contract);
  const workspace = investigated.value.workspace;
  if (session.retainInvestigationWorkspace(workspace) === "added")
    input.server.sendResourceListChanged();
  const result = changedBehaviorResultSchema.parse(
    investigated.value.evidence.normalized_result,
  );
  const toolResult = toCallToolResult(
    recordWorkflowEvidence(
      session,
      investigated.value.evidence,
      input.unknownRegistryApproved,
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
        description: "Immutable CAS-linked investigation workspace revision",
        mimeType: "application/json",
      },
    ],
  };
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
      const coverage = verifyCoverageReadiness(session, parsed.coverage);
      if (!coverage.ok) return toCallToolResult(coverage, contract);
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
