import type { BinarySessionPort } from "../application/binary/BinarySessionPort.js";
import {
  recordEvidenceSources,
  retainAnalysisResultSources,
  type AnalysisResultWithSources,
} from "../application/investigation/recordEvidenceSources.js";
import type { InvestigationWorkflowExecution } from "../application/investigation/InvestigationWorkflows.js";
import type { ToolContract } from "../contracts/toolContractTypes.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import { recordDerivedEvidence } from "./recordDerivedEvidence.js";

/** Retain workflow sources before delivering the derived Evidence or its failure. */
export const deliverInvestigationWorkflow = (
  server: EvidenceMcpServer,
  session: BinarySessionPort,
  contract: ToolContract,
  computed: AnalysisResultWithSources<InvestigationWorkflowExecution>,
) => {
  const record = session.recordEvidence.bind(session);
  const completed = retainAnalysisResultSources(
    contract.name,
    record,
    computed,
  );
  if (!completed.ok)
    return server.delivery.toPartialErrorToolResult(
      completed.error,
      contract.returnsTargetContent,
      record,
    );
  const { evidence, sources, unknown } = completed.value;
  const retained = recordEvidenceSources(record, sources, {
    evidence,
    evidenceForAnalysis: session.evidenceForAnalysis.bind(session),
  });
  if (!retained.ok) return server.delivery.toCallToolResult(retained, contract);
  return server.delivery.toEvidenceToolResult(
    evidence,
    contract,
    recordDerivedEvidence(session, evidence, unknown),
  );
};
