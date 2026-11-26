import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import type { EvidenceLookup } from "../application/EvidenceInputResolver.js";
import { summarizeRetainedAnalysis } from "../application/analysisView/AnalysisViewService.js";
import { requireAnalysisViewRetention } from "../application/analysisView/AnalysisViewRetention.js";
import type { Evidence } from "../domain/evidence.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { ok } from "../domain/result.js";

type Parameters = Readonly<Record<string, JsonValue>>;

/** The view tool that pages a retained summary. */
export const RETAINED_SUMMARY_VIEW_TOOL = "inspect_analysis_view";

/**
 * Requested summary delivery for one named operation: refuse it before
 * analysis when this server retains no Evidence, then return the retained
 * summary view. An omitted detail is left to the agent result budget, which
 * tool-result delivery applies to every budgeted operation.
 */
export const retainedSummaryDelivery = (
  operation: string,
  options: {
    readonly recordEvidence: EvidenceWriter["recordEvidence"] | undefined;
    readonly evidenceById?: EvidenceLookup | undefined;
  },
) => {
  const retention = {
    recordEvidence: options.recordEvidence,
    evidenceById: options.evidenceById,
  };
  return {
    preflight: (parameters: Parameters) =>
      parameters.detail === "summary"
        ? requireAnalysisViewRetention(operation, retention)
        : ok(null),
    projectEvidence: (parameters: Parameters, evidence: Evidence) =>
      parameters.detail === "summary"
        ? summarizeRetainedAnalysis(evidence, retention)
        : ok(evidence),
  };
};

/** Delivery detail selects a response shape; it never reaches analysis. */
export const withoutDeliveryDetail = (parameters: Parameters): Parameters => {
  const { detail: _detail, ...selected } = parameters;
  return selected;
};
