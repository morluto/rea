import type { WebPageInspection } from "./browserObservation.js";
import {
  analyzeScript,
  emptyAccumulator,
  isIncludedScript,
} from "./webBundleAnalyzerInspection.js";
import { buildWebBundleAnalysis } from "./webBundleAnalyzerResult.js";
import type { WebBundleAnalysis } from "./webBundleAnalysis.js";

/** Analyze selected captured JavaScript source without execution. */
export const analyzeCapturedWebBundle = (
  inspection: WebPageInspection,
  sourceMaps: WebBundleAnalysis["observations"]["source_maps"] = {
    status: "not_requested",
    requested: 0,
    processed: 0,
    items: [],
  },
): WebBundleAnalysis => {
  const accumulator = emptyAccumulator();
  const sourceScripts = inspection.scripts.items.filter(isIncludedScript);
  for (const script of sourceScripts) analyzeScript(script, accumulator);
  return buildWebBundleAnalysis(
    inspection,
    sourceScripts,
    sourceMaps,
    accumulator,
  );
};
