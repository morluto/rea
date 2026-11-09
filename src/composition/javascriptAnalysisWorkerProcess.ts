import { moduleResolutionModeForJavaScriptReference } from "../domain/javascript/javascriptModuleResolutionMode.js";
import { parseJavaScriptSource } from "../domain/javascript/javascriptSourceParser.js";
import {
  analyzeParsedJavaScriptStaticSourceWithBindingsSteps,
  discoverParsedJavaScriptBrowserWindowsSteps,
  maySourceConstructElectronBrowserWindow,
} from "../domain/javascript/javascriptStaticAnalysis.js";
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
import {
  serveJavaScriptAnalysisWorker,
  type JavaScriptSourceWorkerAnalyzer,
} from "../javascript/analysis/JavaScriptAnalysisWorkerServer.js";

const analyze: JavaScriptSourceWorkerAnalyzer = async (
  file,
  capacity,
  callbacks,
  packageType,
  purpose,
) => {
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
  let parsed = parseJavaScriptSource(file.text.value, file.path, packageType);
  if (parsed === null) {
    await callbacks.checkpoint(failedJavaScriptStaticAnalysis());
    return null;
  }
  await callbacks.phase("static");
  if (purpose === "preload-discovery") {
    // Only declarations cross this preliminary pass. The normal pass owns
    // full static/semantic facts and their result reservations.
    const facts = await completeJavaScriptAnalysisSteps(
      discoverParsedJavaScriptBrowserWindowsSteps(file.text.value, parsed),
    );
    await callbacks.checkpoint(facts);
    return null;
  }
  const staticImportResolutionMode = moduleResolutionModeForJavaScriptReference(
    file.path,
    "static-import",
  );
  let sharedBindings: JavaScriptReceiverIndex | null;
  const staticResult = await completeJavaScriptAnalysisSteps(
    analyzeParsedJavaScriptStaticSourceWithBindingsSteps(
      file.text.value,
      parsed,
      staticImportResolutionMode,
    ),
  );
  const facts = staticResult.analysis;
  sharedBindings = staticResult.bindings;
  const resultBudgetBytes = await callbacks.checkpoint(facts);
  if (facts.parse_status === "failed") {
    sharedBindings = null;
    return null;
  }
  if (resultBudgetBytes === 0) {
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

try {
  await serveJavaScriptAnalysisWorker(analyze);
} catch (cause: unknown) {
  process.stderr.write(
    `${cause instanceof Error ? cause.message : String(cause)}\n`,
  );
  process.exitCode = 1;
}
