import type { AnalysisParameterLimit } from "../../domain/analysisSettings.js";
import { semanticCoverageResourceLimits } from "../../domain/javascript/javascriptSemanticCoverage.js";
import { semanticPrecisionControls } from "../../domain/javascript/javascriptSemanticResourceLimits.js";
import type { AnalyzedJavaScriptArtifactFile } from "./JavaScriptArtifactAnalysisTypes.js";

/**
 * The `semantic_precision` budgets that limited any analyzed source, once
 * each sorted by parameter: those its static examination records and those its
 * semantic IR coverage reached. One request sets them for every source.
 */
export const javaScriptSemanticPrecisionControls = (
  files: readonly AnalyzedJavaScriptArtifactFile[],
): AnalysisParameterLimit[] => {
  const byParameter = new Map<string, AnalysisParameterLimit>();
  for (const { javascript, semantic } of files) {
    for (const control of javascript?.analysis_coverage?.examination.controls ??
      [])
      byParameter.set(control.parameter, control);
    if (semantic === null) continue;
    const { coverage } = semantic.ir;
    for (const control of semanticPrecisionControls(
      semanticCoverageResourceLimits(coverage),
      [],
      coverage.precision,
    ))
      byParameter.set(control.parameter, control);
  }
  return [...byParameter.values()].sort((left, right) =>
    left.parameter < right.parameter
      ? -1
      : left.parameter > right.parameter
        ? 1
        : 0,
  );
};
