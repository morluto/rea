import type { WebPageInspection } from "./browserObservation.js";
import {
  analyzeScript,
  emptyAccumulator,
  isIncludedScript,
} from "./webBundleAnalyzerInspection.js";
import { buildWebBundleAnalysis } from "./webBundleAnalyzerResult.js";
import type {
  AnalyzeWebBundleInput,
  WebBundleAnalysis,
} from "./webBundleAnalysis.js";

/** Analyze captured, explicitly approved JavaScript source without execution. */
export const analyzeCapturedWebBundle = (
  inspection: WebPageInspection,
  input: AnalyzeWebBundleInput,
  sourceMaps: WebBundleAnalysis["observations"]["source_maps"] = {
    status: "not_requested",
    requested: 0,
    processed: 0,
    dropped: 0,
    dropped_script_keys: [],
    items: [],
  },
): WebBundleAnalysis => {
  const accumulator = emptyAccumulator();
  const sourceScripts = inspection.scripts.items.filter(isIncludedScript);
  for (const script of sourceScripts) analyzeScript(script, input, accumulator);
  return buildWebBundleAnalysis(inspection, sourceScripts, sourceMaps, accumulator);
};
