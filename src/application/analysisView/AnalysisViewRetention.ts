import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisCapabilityUnavailableError } from "../../domain/analysisErrorCore.js";
import { ANALYSIS_VIEW_PROVIDER } from "../../domain/investigationProviders.js";
import { err, ok, type Result } from "../../domain/result.js";
import type { EvidenceLookup } from "../EvidenceInputResolver.js";
import type { EvidenceWriter } from "../investigation/InvestigationRecordPort.js";

/** Session Evidence ownership required to deliver a view instead of a complete record. */
export interface AnalysisViewRetention {
  readonly evidenceById: EvidenceLookup | undefined;
  readonly recordEvidence: EvidenceWriter["recordEvidence"] | undefined;
}

/** Fail before analysis when selected delivery cannot keep its complete source. */
export const requireAnalysisViewRetention = (
  operation: string,
  retention: AnalysisViewRetention,
): Result<
  {
    readonly evidenceById: EvidenceLookup;
    readonly recordEvidence: EvidenceWriter["recordEvidence"];
  },
  AnalysisError
> => {
  if (
    retention.recordEvidence === undefined ||
    retention.evidenceById === undefined
  )
    return err(
      new AnalysisCapabilityUnavailableError(
        ANALYSIS_VIEW_PROVIDER.id,
        operation,
        "summary detail requires a server session that retains Evidence for later views",
        {
          userMessage:
            "This server does not retain Evidence. Select detail complete to receive the complete analysis inline.",
        },
      ),
    );
  return ok({
    evidenceById: retention.evidenceById,
    recordEvidence: retention.recordEvidence,
  });
};
