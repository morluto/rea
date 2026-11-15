import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { BinarySessionPort } from "../application/binary/BinarySessionPort.js";
import { resolveInvestigationEvidenceClosure } from "../application/investigation/InvestigationEvidence.js";
import { toolContract } from "../contracts/toolContracts.js";
import { createEvidence } from "../domain/evidence.js";
import { createAnalysisProfile } from "../domain/analysisProfile.js";
import { recordWorkflowEvidence } from "./registerInvestigationTools/helpers.js";
import { runDerivedOperation } from "./runDerivedOperation.js";
import { RECONSTRUCTION_PROVIDER } from "../domain/investigationProviders.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { withAdmittedAnalysis } from "./analysisAdmission.js";
import { runAdmittedToolOperation } from "./admittedToolOperation.js";
import { verifyReconstruction } from "../domain/reconstructionVerification.js";

/**
 * Register reconstruction verification. Comparisons and the investigation
 * workflows are session-derived bindings in the shared table.
 */
export const registerInvestigationTools = (
  server: EvidenceMcpServer,
  session: BinarySessionPort,
): void => {
  const admission = withAdmittedAnalysis({ kind: "session", session });
  registerReconstruction(
    server,
    session,
    admission,
    toolContract("verify_reconstruction"),
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
            analysisProfile: createAnalysisProfile(RECONSTRUCTION_PROVIDER, {
              workflow_revision: 2,
            }),
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
