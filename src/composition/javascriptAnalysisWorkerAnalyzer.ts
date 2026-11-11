import { moduleResolutionModeForJavaScriptReference } from "../domain/javascript/javascriptModuleResolutionMode.js";
import { parseJavaScriptSource } from "../domain/javascript/javascriptSourceParser.js";
import {
  analyzeParsedJavaScriptStaticSourceWithBindingsSteps,
  discoverParsedJavaScriptBrowserWindowsSteps,
  maySourceConstructElectronBrowserWindow,
} from "../domain/javascript/javascriptStaticAnalysis.js";
import type { JavaScriptStaticAnalysis } from "../domain/javascript/javascriptStaticAnalysisTypes.js";
import {
  analyzeParsedJavaScriptSemanticsSteps,
  type JavaScriptReceiverIndex,
} from "../domain/javascript/javascriptSemanticAnalysis.js";
import { failedJavaScriptStaticAnalysis } from "../domain/javascript/javascriptStaticAnalysisHelpers.js";
import { projectJavaScriptModuleSemantics } from "../domain/javascript/javascriptModuleSemanticIr.js";
import {
  javaScriptTransferByteBudget,
  measureJavaScriptModuleTransfer,
} from "../javascript/analysis/JavaScriptAnalysisTransfer.js";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import { projectJavaScriptSemanticFileSteps } from "../application/javascript/JavaScriptSemanticGraphBuilder.js";
import { completeJavaScriptAnalysisSteps } from "../application/javascript/JavaScriptAnalysisControl.js";
import type { JavaScriptSourceWorkerAnalyzer } from "../javascript/analysis/JavaScriptAnalysisWorkerServer.js";

export interface JavaScriptSourceWorkerAnalyzerDependencies {
  readonly parseSource?: typeof parseJavaScriptSource;
  readonly analyzeStaticWithBindings?: typeof analyzeParsedJavaScriptStaticSourceWithBindingsSteps;
}

export const createJavaScriptSourceWorkerAnalyzer = (
  dependencies: JavaScriptSourceWorkerAnalyzerDependencies = {},
): JavaScriptSourceWorkerAnalyzer => {
  const parseSource = dependencies.parseSource ?? parseJavaScriptSource;
  const analyzeStaticWithBindings =
    dependencies.analyzeStaticWithBindings ??
    analyzeParsedJavaScriptStaticSourceWithBindingsSteps;

  return async (file, capacity, callbacks, packageType, purpose, precision) => {
    if (!file.text.included)
      throw new TypeError("JavaScript worker requires decoded source text");
    if (
      purpose === "preload-discovery" &&
      !maySourceConstructElectronBrowserWindow(file.text.value)
    ) {
      await callbacks.checkpoint(failedJavaScriptStaticAnalysis());
      return null;
    }
    await callbacks.phase("parse");
    let parsed = parseSource(file.text.value, file.path, packageType);
    if (parsed === null) {
      await callbacks.checkpoint(failedJavaScriptStaticAnalysis());
      return null;
    }
    await callbacks.phase("static");
    const staticImportResolutionMode =
      moduleResolutionModeForJavaScriptReference(file.path, "static-import");
    if (purpose === "preload-discovery") {
      // Only declarations cross this preliminary pass. The normal pass owns
      // full static/semantic facts and their result reservations.
      const facts = await completeJavaScriptAnalysisSteps(
        discoverParsedJavaScriptBrowserWindowsSteps(
          file.text.value,
          parsed,
          staticImportResolutionMode,
          precision,
        ),
      );
      parsed = null;
      await callbacks.checkpoint(facts);
      return null;
    }
    let facts: JavaScriptStaticAnalysis;
    let sharedBindings: JavaScriptReceiverIndex | null = null;
    ({ analysis: facts, bindings: sharedBindings } =
      await completeJavaScriptAnalysisSteps(
        analyzeStaticWithBindings(
          file.text.value,
          parsed,
          staticImportResolutionMode,
          precision,
        ),
      ));
    const resultBudgetBytes = await callbacks.checkpoint(facts);
    if (facts.parse_status === "failed") {
      parsed = null;
      sharedBindings = null;
      return null;
    }
    if (resultBudgetBytes === 0) {
      parsed = null;
      sharedBindings = null;
      throw new AnalysisResourceConstraintError(
        "analyze_javascript_application",
        "memory",
        `The parent reserved its remaining result capacity for static observations; semantic analysis of ${file.path} was not started`,
        { semantic_result_budget_bytes: 0 },
      );
    }
    await callbacks.phase("semantic");
    const ir = await completeJavaScriptAnalysisSteps(
      analyzeParsedJavaScriptSemanticsSteps(
        parsed,
        staticImportResolutionMode,
        capacity.nodes,
        precision,
        sharedBindings,
      ),
    );
    parsed = null;
    sharedBindings = null;
    const module = projectJavaScriptModuleSemantics(ir);
    const measured = measureJavaScriptModuleTransfer(
      module,
      javaScriptTransferByteBudget(resultBudgetBytes),
    );
    if (measured.retentionBytes > resultBudgetBytes)
      throw new AnalysisResourceConstraintError(
        "analyze_javascript_application",
        "memory",
        `Completed module facts for ${file.path} exceed the parent's offered result budget; static facts were retained`,
        {
          semantic_result_budget_bytes: resultBudgetBytes,
          module_transfer_bytes: measured.bytes,
        },
      );
    await callbacks.phase("projection");
    const projection = await completeJavaScriptAnalysisSteps(
      projectJavaScriptSemanticFileSteps(
        file,
        ir,
        capacity,
        facts.electron.call_paths,
      ),
    );
    return { module, projection };
  };
};
