import { resolveInvestigationEvidenceClosure } from "../application/investigation/InvestigationEvidence.js";
import { resolveChangedBehaviorEvidence } from "../application/investigation/ChangedBehaviorEvidence.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

import type { BinarySessionPort } from "../application/binary/BinarySessionPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import { buildCallPath } from "../domain/callPath.js";
import { findChangedBehavior } from "../domain/changedBehavior.js";
import { createEvidence } from "../domain/evidence.js";
import { correlateStaticAndRuntime } from "../domain/staticRuntimeCorrelation.js";
import {
  comparisonClosure,
  isIncomplete,
  recordWorkflowEvidence,
} from "./registerInvestigationTools/helpers.js";
import { runDerivedOperation } from "./runDerivedOperation.js";
import {
  CALL_PATH_PROVIDER,
  CHANGED_BEHAVIOR_PROVIDER,
  RECONSTRUCTION_PROVIDER,
  STATIC_RUNTIME_PROVIDER,
} from "../domain/investigationProviders.js";
import {
  applicationToolRegistrationOptions,
  toolRegistrationOptions,
} from "./toolRegistrationOptions.js";
import { withAdmittedAnalysis } from "./analysisAdmission.js";
import { runAdmittedToolOperation } from "./admittedToolOperation.js";

import { verifyReconstruction } from "../domain/reconstructionVerification.js";
/** Register Evidence-composed differential investigation workflows. */
export const registerInvestigationTools = (
  server: EvidenceMcpServer,
  session: BinarySessionPort,
): void => {
  const admission = withAdmittedAnalysis({ kind: "session", session });
  registerChangedBehavior(
    server,
    session,
    admission,
    toolContract("find_changed_behavior"),
  );
  registerCallPath(server, session, admission, toolContract("build_call_path"));
  registerStaticRuntime(
    server,
    session,
    admission,
    toolContract("correlate_static_and_runtime"),
  );
  registerReconstruction(
    server,
    session,
    admission,
    toolContract("verify_reconstruction"),
  );
};

const registerChangedBehavior = (
  server: EvidenceMcpServer,
  session: BinarySessionPort,
  admission: ReturnType<typeof withAdmittedAnalysis>,
  contract: ReturnType<typeof toolContract<"find_changed_behavior">>,
): void => {
  const registration = applicationToolRegistrationOptions(contract);
  server.registerTool(contract.name, registration, async (input, context) =>
    runAdmittedToolOperation(
      server,
      admission,
      contract.name,
      context.mcpReq.signal,
      async () => {
        const resolved = resolveChangedBehaviorEvidence(
          input,
          session.evidenceForAnalysis.bind(session),
        );
        if (!resolved.ok)
          return server.delivery.toCallToolResult(resolved, contract);
        const computed = await runDerivedOperation(context, contract.name, () =>
          findChangedBehavior(resolved.value),
        );
        if (!computed.ok)
          return server.delivery.toCallToolResult(computed, contract);
        const { result, comparisonEvidenceIds } = computed.value;
        const closure = resolveInvestigationEvidenceClosure(
          session,
          result.evidence_links,
        );
        if (!closure.ok)
          return server.delivery.toCallToolResult(closure, contract);
        const links = closure.value;
        const evidence = createEvidence(undefined, CHANGED_BEHAVIOR_PROVIDER, {
          predicateType: "rea.changed-behavior",
          operation: contract.name,
          parameters: {
            comparison_evidence_ids: [...comparisonEvidenceIds],
          },
          result,
          confidence: "derived",
          authority: "analyst-inference",
          limitations: result.limitations,
          evidenceLinks: links,
        });
        const recorded = recordWorkflowEvidence(
          session,
          evidence,
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
        return server.delivery.toEvidenceToolResult(
          evidence,
          contract,
          recorded,
        );
      },
    ),
  );
};

const registerCallPath = (
  server: EvidenceMcpServer,
  session: BinarySessionPort,
  admission: ReturnType<typeof withAdmittedAnalysis>,
  contract: ReturnType<typeof toolContract<"build_call_path">>,
): void => {
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) =>
      runAdmittedToolOperation(
        server,
        admission,
        contract.name,
        context.mcpReq.signal,
        async () => {
          const closure = resolveInvestigationEvidenceClosure(
            session,
            input.functions.map(({ evidence_id }) => evidence_id),
          );
          if (!closure.ok)
            return server.delivery.toCallToolResult(closure, contract);
          const links = closure.value;
          const computed = await runDerivedOperation(
            context,
            contract.name,
            () => buildCallPath(input),
          );
          if (!computed.ok)
            return server.delivery.toCallToolResult(computed, contract);
          const result = computed.value;
          const evidence = createEvidence(undefined, CALL_PATH_PROVIDER, {
            predicateType: "rea.call-path",
            operation: contract.name,
            parameters: {
              start: input.start.address,
              goal: input.goal.address,
            },
            result,
            confidence: "derived",
            authority: "analyst-inference",
            limitations: result.limitations,
            evidenceLinks: links,
          });
          const recorded = recordWorkflowEvidence(
            session,
            evidence,
            result.status === "unknown",
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
          return server.delivery.toEvidenceToolResult(
            evidence,
            contract,
            recorded,
          );
        },
      ),
  );
};

const registerStaticRuntime = (
  server: EvidenceMcpServer,
  session: BinarySessionPort,
  admission: ReturnType<typeof withAdmittedAnalysis>,
  contract: ReturnType<typeof toolContract<"correlate_static_and_runtime">>,
): void => {
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) =>
      runAdmittedToolOperation(
        server,
        admission,
        contract.name,
        context.mcpReq.signal,
        async () => {
          const closure = resolveInvestigationEvidenceClosure(
            session,
            comparisonClosure([
              ...input.static_comparisons,
              ...input.runtime_comparisons,
            ]),
          );
          if (!closure.ok)
            return server.delivery.toCallToolResult(closure, contract);
          const links = closure.value;
          const computed = await runDerivedOperation(
            context,
            contract.name,
            () => correlateStaticAndRuntime(input),
          );
          if (!computed.ok)
            return server.delivery.toCallToolResult(computed, contract);
          const result = computed.value;
          const evidence = createEvidence(undefined, STATIC_RUNTIME_PROVIDER, {
            predicateType: "rea.static-runtime-correlation",
            operation: contract.name,
            parameters: {
              mapping_count: input.mappings.length,
            },
            result,
            confidence: "inferred",
            authority: "analyst-inference",
            limitations: result.limitations,
            evidenceLinks: links,
          });
          return server.delivery.toEvidenceToolResult(
            evidence,
            contract,
            recordWorkflowEvidence(
              session,
              evidence,
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
          );
        },
      ),
  );
};

const registerReconstruction = (
  server: EvidenceMcpServer,
  session: BinarySessionPort,
  admission: ReturnType<typeof withAdmittedAnalysis>,
  contract: ReturnType<typeof toolContract<"verify_reconstruction">>,
): void => {
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) =>
      runAdmittedToolOperation(
        server,
        admission,
        contract.name,
        context.mcpReq.signal,
        async () => {
          const owned = session.immutableEvidenceBundle();
          const computed = await runDerivedOperation(
            context,
            contract.name,
            () => verifyReconstruction(input.specification, owned),
          );
          if (!computed.ok)
            return server.delivery.toCallToolResult(computed, contract);
          const result = computed.value;
          const closure = resolveInvestigationEvidenceClosure(
            session,
            result.evidence_links,
          );
          if (!closure.ok)
            return server.delivery.toCallToolResult(closure, contract);
          const links = closure.value;
          const evidence = createEvidence(undefined, RECONSTRUCTION_PROVIDER, {
            predicateType: "rea.reconstruction-verification",
            operation: contract.name,
            parameters: {
              specification_sha256: result.specification_sha256,
              claim_ids: input.specification.claims.map(
                ({ claim_id: id }) => id,
              ),
            },
            result,
            confidence: "derived",
            authority: "analyst-inference",
            limitations: result.limitations,
            evidenceLinks: links,
          });
          return server.delivery.toEvidenceToolResult(
            evidence,
            contract,
            recordWorkflowEvidence(
              session,
              evidence,
              result.status === "unknown",
              {
                question:
                  "Does the reconstruction satisfy every declared claim?",
                domain: "reconstruction-verification",
                requiredAuthority: null,
                requiredConfidence: "derived",
                probes: result.recommended_probes.map(
                  ({ operation, rationale }) => ({ operation, rationale }),
                ),
              },
            ),
          );
        },
      ),
  );
};
