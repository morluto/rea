import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import type { EvidenceLookup } from "../application/EvidenceInputResolver.js";
import { summarizeRetainedAnalysis } from "../application/analysisView/AnalysisViewService.js";
import { requireAnalysisViewRetention } from "../application/analysisView/AnalysisViewRetention.js";
import type { Evidence } from "../domain/evidence.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { jsonValueByteLength } from "../domain/jsonValueByteLength.js";
import { ok } from "../domain/result.js";
import { SIZE_AWARE_INLINE_EVIDENCE_BYTES } from "../contracts/analysisDetail.js";

type Parameters = Readonly<Record<string, JsonValue>>;

/** The view tool that pages a retained summary. */
export const RETAINED_SUMMARY_VIEW_TOOL = "inspect_analysis_view";

/**
 * Whether completed Evidence is delivered as its retained summary. An
 * explicit detail decides. Omitted under a size-aware contract, Evidence
 * above the inline bound is retained behind its summary only when this
 * server can retain it and the session advertises the view tool that pages
 * it; otherwise it is delivered complete.
 */
export const deliversRetainedSummary = (
  detail: unknown,
  evidence: Evidence,
  options: {
    readonly sizeAware: boolean;
    readonly retained: boolean;
    readonly pageable: boolean;
  },
): boolean =>
  detail === "summary" ||
  (detail === undefined &&
    options.sizeAware &&
    options.retained &&
    options.pageable &&
    jsonValueByteLength(
      evidence as unknown as JsonValue,
      SIZE_AWARE_INLINE_EVIDENCE_BYTES,
    ) > SIZE_AWARE_INLINE_EVIDENCE_BYTES);

/**
 * Summary delivery for one named operation: refuse a requested summary before
 * analysis when this server retains no Evidence, then return the retained
 * summary view. A size-aware contract also summarizes large Evidence when the
 * caller omits detail.
 */
export const retainedSummaryDelivery = (
  operation: string,
  options: {
    readonly recordEvidence: EvidenceWriter["recordEvidence"] | undefined;
    readonly evidenceById?: EvidenceLookup | undefined;
  },
  sizeAware = false,
) => {
  const retention = {
    recordEvidence: options.recordEvidence,
    evidenceById: options.evidenceById,
  };
  const retained = requireAnalysisViewRetention(operation, retention).ok;
  return {
    preflight: (parameters: Parameters) =>
      parameters.detail === "summary"
        ? requireAnalysisViewRetention(operation, retention)
        : ok(null),
    projectEvidence: (
      parameters: Parameters,
      evidence: Evidence,
      // Only an omitted size-aware detail reads it.
      pageable = false,
    ) =>
      deliversRetainedSummary(parameters.detail, evidence, {
        sizeAware,
        retained,
        pageable,
      })
        ? summarizeRetainedAnalysis(evidence, retention)
        : ok(evidence),
  };
};

/** Delivery detail selects a response shape; it never reaches analysis. */
export const withoutDeliveryDetail = (parameters: Parameters): Parameters => {
  const { detail: _detail, ...selected } = parameters;
  return selected;
};
