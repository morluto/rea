import { moduleResolutionModeForJavaScriptReference } from "../domain/javascript/javascriptModuleResolutionMode.js";
import { parseJavaScriptSource } from "../domain/javascript/javascriptSourceParser.js";
import {
  analyzeParsedJavaScriptStaticSourceSteps,
  memberMutationRefusedJavaScriptStaticAnalysis,
} from "../domain/javascript/javascriptStaticAnalysis.js";
import type { JavaScriptStaticAnalysis } from "../domain/javascript/javascriptStaticAnalysisTypes.js";
import { isJavaScriptMemberMutationRefusal } from "../domain/javascript/javascriptSemanticWorkAllowance.js";
import { analyzeParsedJavaScriptSemanticsSteps } from "../domain/javascript/javascriptSemanticAnalysis.js";
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
  precision,
  memberMutationAllowance,
) => {
  if (!file.text.included)
    throw new TypeError("JavaScript worker requires decoded source text");
  await callbacks.phase("parse");
  let parsed = parseJavaScriptSource(file.text.value, file.path, packageType);
  if (parsed === null) {
    await callbacks.checkpoint(failedJavaScriptStaticAnalysis());
    return null;
  }
  await callbacks.phase("static");
  let facts: JavaScriptStaticAnalysis;
  try {
    facts = await completeJavaScriptAnalysisSteps(
      analyzeParsedJavaScriptStaticSourceSteps(
        file.text.value,
        parsed,
        precision,
        memberMutationAllowance,
      ),
    );
  } catch (cause: unknown) {
    // The semantic phase indexes the same mutations under the same
    // allowance, so it is not started; the syntax facts cross first.
    if (purpose === "analysis" && isJavaScriptMemberMutationRefusal(cause))
      await callbacks.checkpoint(
        memberMutationRefusedJavaScriptStaticAnalysis(
          file.text.value,
          parsed,
          cause,
        ),
      );
    throw cause;
  }
  if (purpose === "preload-discovery") {
    // Only declarations cross this preliminary pass. The normal pass owns
    // full static/semantic facts and their result reservations.
    const empty = failedJavaScriptStaticAnalysis();
    await callbacks.checkpoint({
      ...empty,
      parse_status: facts.parse_status,
      parse_error_count: facts.parse_error_count,
      analysis_coverage: facts.analysis_coverage,
      visited_ast_nodes: facts.visited_ast_nodes,
      limitations: facts.limitations,
      electron: {
        ...empty.electron,
        browser_windows: facts.electron.browser_windows,
      },
    });
    return null;
  }
  const resultBudgetBytes = await callbacks.checkpoint(facts);
  if (facts.parse_status === "failed") return null;
  if (resultBudgetBytes === 0)
    throw new AnalysisResourceConstraintError(
      "analyze_javascript_application",
      "memory",
      `The parent reserved its remaining result capacity for static observations; semantic analysis of ${file.path} was not started`,
      { semantic_result_budget_bytes: 0 },
      { measuredExhaustion: true },
    );
  await callbacks.phase("semantic");
  const ir = await completeJavaScriptAnalysisSteps(
    analyzeParsedJavaScriptSemanticsSteps(
      parsed,
      moduleResolutionModeForJavaScriptReference(file.path, "static-import"),
      capacity.nodes,
      precision,
      memberMutationAllowance,
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
      { measuredExhaustion: true },
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
