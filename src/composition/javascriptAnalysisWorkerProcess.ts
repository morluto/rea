import { estimateJavaScriptModuleApplicationProjection } from "../domain/javascript/javascriptApplicationProjectionResources.js";
import { moduleResolutionModeForJavaScriptReference } from "../domain/javascript/javascriptModuleResolutionMode.js";
import { parseJavaScriptSource } from "../domain/javascript/javascriptSourceParser.js";
import { analyzeParsedJavaScriptStaticSourceSteps } from "../domain/javascript/javascriptStaticAnalysis.js";
import { analyzeParsedJavaScriptSemanticsSteps } from "../domain/javascript/javascriptSemanticAnalysis.js";
import { failedJavaScriptStaticAnalysis } from "../domain/javascript/javascriptStaticAnalysisHelpers.js";
import { projectJavaScriptModuleSemantics } from "../domain/javascript/javascriptModuleSemanticIr.js";
import {
  javaScriptApplicationProjectionRetentionBytes,
  javaScriptGraphBytesWithinRetention,
  javaScriptTransferByteBudget,
  measureJavaScriptModuleTransfer,
} from "../javascript/analysis/JavaScriptAnalysisTransfer.js";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import {
  projectJavaScriptSemanticFileSteps,
  semanticModuleRootBytes,
} from "../application/javascript/JavaScriptSemanticGraphBuilder.js";
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
  await callbacks.phase("parse");
  let parsed = parseJavaScriptSource(file.text.value, file.path, packageType);
  if (parsed === null) {
    await callbacks.checkpoint(failedJavaScriptStaticAnalysis(), 0);
    return null;
  }
  await callbacks.phase("static");
  const facts = await completeJavaScriptAnalysisSteps(
    analyzeParsedJavaScriptStaticSourceSteps(file.text.value, parsed),
  );
  if (purpose === "preload-discovery") {
    // Only declarations cross this preliminary pass. The normal pass owns
    // full static/semantic facts and their result reservations.
    const empty = failedJavaScriptStaticAnalysis();
    await callbacks.checkpoint(
      {
        ...empty,
        parse_status: facts.parse_status,
        parse_error_count: facts.parse_error_count,
        ...(facts.analysis_coverage === undefined
          ? {}
          : { analysis_coverage: facts.analysis_coverage }),
        visited_ast_nodes: facts.visited_ast_nodes,
        limitations: facts.limitations,
        electron: {
          ...empty.electron,
          browser_windows: facts.electron.browser_windows,
        },
      },
      0,
    );
    return null;
  }
  const admission = await callbacks.checkpoint(
    facts,
    semanticModuleRootBytes(file),
  );
  const resultBudgetBytes = admission.resultBytes;
  if (facts.parse_status === "failed") return null;
  if (resultBudgetBytes === 0)
    throw new AnalysisResourceConstraintError(
      "analyze_javascript_application",
      "memory",
      `The parent reserved its remaining result capacity for static observations; semantic analysis of ${file.path} was not started`,
      { semantic_result_budget_bytes: 0 },
    );
  await callbacks.phase("semantic");
  const ir = await completeJavaScriptAnalysisSteps(
    analyzeParsedJavaScriptSemanticsSteps(
      parsed,
      moduleResolutionModeForJavaScriptReference(file.path, "static-import"),
      capacity.nodes,
    ),
  );
  parsed = null;
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
  // Application facts are required with the module and are charged to the
  // unreserved Evidence; semantic facts receive what they leave, up to their
  // share, and the retained capacity left after both.
  const application = estimateJavaScriptModuleApplicationProjection(
    module,
    file.path,
    admission.evidenceBytes,
  );
  const projection = await completeJavaScriptAnalysisSteps(
    projectJavaScriptSemanticFileSteps(
      file,
      ir,
      Math.min(
        admission.graphBytes,
        Math.max(0, admission.evidenceBytes - application.bytes),
        javaScriptGraphBytesWithinRetention(
          resultBudgetBytes -
            measured.retentionBytes -
            javaScriptApplicationProjectionRetentionBytes(application),
        ),
      ),
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
