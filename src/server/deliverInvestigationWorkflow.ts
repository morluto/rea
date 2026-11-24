import type { BinarySessionPort } from "../application/binary/BinarySessionPort.js";
import {
  recordEvidenceSources,
  retainAnalysisResultSources,
  type AnalysisResultWithSources,
} from "../application/investigation/recordEvidenceSources.js";
import type { InvestigationWorkflowExecution } from "../application/investigation/InvestigationWorkflows.js";
import type { ToolContract } from "../contracts/toolContractTypes.js";
import { ok } from "../domain/result.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

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
  const recorded =
    unknown === undefined
      ? session.recordEvidence(evidence)
      : session.recordEvidenceWithUnknown(evidence, unknown);
  return server.delivery.toEvidenceToolResult(
    evidence,
    contract,
    recorded.ok ? ok(evidence) : recorded,
  );
};
