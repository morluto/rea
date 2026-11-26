import { setImmediate } from "node:timers/promises";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { inspectAnalysisViewValidated } from "../application/analysisView/AnalysisViewService.js";
import type { EvidenceLookup } from "../application/EvidenceInputResolver.js";
import type {
  EvidenceUnknownWriter,
  EvidenceWriter,
} from "../application/investigation/InvestigationRecordPort.js";
import type { InvestigationWorkflowExecution } from "../application/investigation/InvestigationWorkflows.js";
import { recordEvidenceSources } from "../application/investigation/recordEvidenceSources.js";
import type { ToolContract } from "../contracts/toolContractTypes.js";
import { cancelledBy } from "../domain/analysisErrorCore.js";
import type { AnalysisViewRequest } from "../domain/analysisView/analysisViewRequest.js";
import { ownedJsonValueSchema } from "../domain/jsonValue.js";
import { ok } from "../domain/result.js";
import type { ToolResultDelivery } from "./ToolResultDelivery.js";

/** The session records an application workflow's delivery reads and writes. */
export interface ApplicationExecutionRecords {
  readonly evidenceById?: EvidenceLookup | undefined;
  readonly recordEvidence?: EvidenceWriter["recordEvidence"] | undefined;
  readonly recordEvidenceWithUnknown?:
    | EvidenceUnknownWriter["recordEvidenceWithUnknown"]
    | undefined;
}

/**
 * Stage an optional caller-selected view against the completed parent, then
 * commit its sources and the parent (with its residual unknown) and deliver.
 * A request cancelled before commit leaves the session unchanged; a delivered
 * view that does not fit names the retained parent and a smaller page
 * instead of its own record.
 */
export const deliverApplicationExecution = async (
  delivery: ToolResultDelivery,
  records: ApplicationExecutionRecords,
  contract: ToolContract,
  execution: InvestigationWorkflowExecution,
  view: AnalysisViewRequest | undefined,
  signal: AbortSignal,
): Promise<CallToolResult> => {
  const parent = execution.evidence;
  const selected =
    view === undefined
      ? ok(parent)
      : inspectAnalysisViewValidated(
          {
            source: {
              kind: "retained-evidence",
              evidence_id: parent.evidence_id,
            },
            view,
          },
          (id) =>
            id === parent.evidence_id ? parent : records.evidenceById?.(id),
        );
  await setImmediate();
  if (signal.aborted)
    return delivery.toErrorToolResult(
      cancelledBy(contract.name, signal),
      contract.returnsTargetContent,
    );
  if (!selected.ok) return delivery.toCallToolResult(selected, contract);
  const sources = recordEvidenceSources(
    records.recordEvidence,
    execution.sources,
    { evidence: selected.value },
  );
  if (!sources.ok) return delivery.toCallToolResult(sources, contract);
  const saved =
    execution.unknown === undefined
      ? records.recordEvidence?.(parent)
      : records.recordEvidenceWithUnknown?.(parent, execution.unknown);
  if (view === undefined)
    return delivery.toEvidenceToolResult(
      parent,
      contract,
      saved,
      undefined,
      records.recordEvidence,
    );
  if (saved !== undefined && !saved.ok)
    return delivery.toCallToolResult(saved, contract);
  return delivery.toSelectedViewToolResult(
    selected.value,
    { parent, request: ownedJsonValueSchema.parse(view) },
    contract,
    records.recordEvidence?.(selected.value),
  );
};
