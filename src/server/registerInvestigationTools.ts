import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

import type { BinarySessionPort } from "../application/binary/BinarySessionPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import { buildCallPath } from "../domain/callPath.js";
import { findChangedBehavior } from "../domain/changedBehavior.js";
import { createEvidence } from "../domain/evidence.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { correlateStaticAndRuntime } from "../domain/staticRuntimeCorrelation.js";
import {
  comparisonClosure,
  evidenceClosure,
  functionEvidenceIds,
  isIncomplete,
  recordWorkflowEvidence,
} from "./registerInvestigationTools/helpers.js";
import { runDerivedOperation } from "./runDerivedOperation.js";
import {
  CALL_PATH_PROVIDER,
  CHANGED_BEHAVIOR_PROVIDER,
  RECONSTRUCTION_PROVIDER,
  STATIC_RUNTIME_PROVIDER,
} from "../application/InvestigationProviders.js";
import {
  applicationValidatedInputSchema,
  toolRegistrationOptions,
} from "./toolRegistrationOptions.js";

import { verifyReconstruction } from "../domain/reconstructionVerification.js";
/** Register Evidence-composed differential investigation workflows. */
export const registerInvestigationTools = (
  server: EvidenceMcpServer,
  session: BinarySessionPort,
): void => {
  registerChangedBehavior(
    server,
    session,
    toolContract("find_changed_behavior"),
  );
  registerCallPath(server, session, toolContract("build_call_path"));
  registerStaticRuntime(
    server,
    session,
    toolContract("correlate_static_and_runtime"),
  );
  registerReconstruction(
    server,
    session,
    toolContract("verify_reconstruction"),
  );
};

const registerChangedBehavior = (
  server: EvidenceMcpServer,
  session: BinarySessionPort,
  contract: ReturnType<typeof toolContract<"find_changed_behavior">>,
): void => {
  const registration = toolRegistrationOptions(contract);
  server.registerTool(
    contract.name,
    {
      ...registration,
      inputSchema: applicationValidatedInputSchema(registration.inputSchema),
    },
    async (input, context) => {
      const computed = await runDerivedOperation(context, contract.name, () =>
        findChangedBehavior(input),
      );
      if (!computed.ok)
        return server.delivery.toCallToolResult(computed, contract);
      const { result, comparisonEvidenceIds } = computed.value;
      const closure = evidenceClosure(session, result.evidence_links);
      if (!closure.ok)
        return server.delivery.toCallToolResult(closure, contract);
      const links = closure.value;
      const evidence = createEvidence(undefined, CHANGED_BEHAVIOR_PROVIDER, {
        predicateType: "rea.changed-behavior",
        operation: contract.name,
        parameters: {
          comparison_evidence_ids: [...comparisonEvidenceIds],
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
      return server.delivery.toEvidenceToolResult(evidence, contract, recorded);
    },
  );
};

const registerCallPath = (
  server: EvidenceMcpServer,
  session: BinarySessionPort,
  contract: ReturnType<typeof toolContract<"build_call_path">>,
): void => {
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) => {
      const closure = evidenceClosure(
        session,
        functionEvidenceIds(input.functions),
      );
      if (!closure.ok)
        return server.delivery.toCallToolResult(closure, contract);
      const links = closure.value;
      const computed = await runDerivedOperation(context, contract.name, () =>
        buildCallPath(input),
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
        result: jsonValueSchema.parse(result),
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
      return server.delivery.toEvidenceToolResult(evidence, contract, recorded);
    },
  );
};

const registerStaticRuntime = (
  server: EvidenceMcpServer,
  session: BinarySessionPort,
  contract: ReturnType<typeof toolContract<"correlate_static_and_runtime">>,
): void => {
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) => {
      const closure = evidenceClosure(
        session,
        comparisonClosure([
          ...input.static_comparisons,
          ...input.runtime_comparisons,
        ]),
      );
      if (!closure.ok)
        return server.delivery.toCallToolResult(closure, contract);
      const links = closure.value;
      const computed = await runDerivedOperation(context, contract.name, () =>
        correlateStaticAndRuntime(input),
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
        result: jsonValueSchema.parse(result),
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
  );
};

const registerReconstruction = (
  server: EvidenceMcpServer,
  session: BinarySessionPort,
  contract: ReturnType<typeof toolContract<"verify_reconstruction">>,
): void => {
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) => {
      const owned = session.exportEvidenceBundle();
      const computed = await runDerivedOperation(context, contract.name, () =>
        verifyReconstruction(input.specification, owned),
      );
      if (!computed.ok)
        return server.delivery.toCallToolResult(computed, contract);
      const result = computed.value;
      const closure = evidenceClosure(session, result.evidence_links);
      if (!closure.ok)
        return server.delivery.toCallToolResult(closure, contract);
      const links = closure.value;
      const evidence = createEvidence(undefined, RECONSTRUCTION_PROVIDER, {
        predicateType: "rea.reconstruction-verification",
        operation: contract.name,
        parameters: {
          specification_sha256: result.specification_sha256,
          claim_ids: input.specification.claims.map(({ claim_id: id }) => id),
        },
        result: jsonValueSchema.parse(result),
        confidence: "derived",
        authority: "analyst-inference",
        limitations: result.limitations,
        evidenceLinks: links,
      });
      return server.delivery.toEvidenceToolResult(
        evidence,
        contract,
        recordWorkflowEvidence(session, evidence, result.status === "unknown", {
          question: "Does the reconstruction satisfy every declared claim?",
          domain: "reconstruction-verification",
          requiredAuthority: null,
          requiredConfidence: "derived",
          probes: result.recommended_probes.map(({ operation, rationale }) => ({
            operation,
            rationale,
          })),
        }),
      );
    },
  );
};
