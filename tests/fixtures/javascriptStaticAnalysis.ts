import { analyzeParsedJavaScriptStaticSourceSteps } from "../../src/domain/javascript/javascriptStaticAnalysis.js";
import { failedJavaScriptStaticAnalysis } from "../../src/domain/javascript/javascriptStaticAnalysisHelpers.js";
import type { JavaScriptSemanticPrecisionInput } from "../../src/domain/javascript/javascriptSemanticPrecision.js";
import { completeSemanticSteps } from "../../src/domain/javascript/javascriptSemanticTraversal.js";
import {
  parseJavaScriptSource,
  type ParsedJavaScriptSource,
} from "../../src/domain/javascript/javascriptSourceParser.js";

export const analyzeParsedJavaScriptStaticSource = (
  source: string,
  file: ParsedJavaScriptSource,
  precision?: JavaScriptSemanticPrecisionInput,
) =>
  completeSemanticSteps(
    analyzeParsedJavaScriptStaticSourceSteps(source, file, precision),
  );

export const analyzeJavaScriptStaticSource = (
  source: string,
  precision?: JavaScriptSemanticPrecisionInput,
) => {
  const file = parseJavaScriptSource(source);
  return file === null
    ? failedJavaScriptStaticAnalysis()
    : analyzeParsedJavaScriptStaticSource(source, file, precision);
};
