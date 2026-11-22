import { createJavaScriptSourceAnalysis } from "../javascript/analysis/JavaScriptSourceAnalysis.js";
import type { JavaScriptSourceAnalysisFactory } from "../ports/javascript/JavaScriptSourceAnalysisFactory.js";

/** Bind JavaScript artifact analysis to the provider's isolated worker. */
export const javascriptSourceAnalysis: JavaScriptSourceAnalysisFactory =
  createJavaScriptSourceAnalysis;
