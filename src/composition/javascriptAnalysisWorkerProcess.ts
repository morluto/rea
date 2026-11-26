import { moduleResolutionModeForJavaScriptReference } from "../domain/javascript/javascriptModuleResolutionMode.js";
import { parseJavaScriptSource } from "../domain/javascript/javascriptSourceParser.js";
import {
  analyzeParsedJavaScriptStaticSourceSteps,
  memberMutationRefusedJavaScriptStaticAnalysis,
} from "../domain/javascript/javascriptStaticAnalysis.js";
import type { JavaScriptStaticAnalysis } from "../domain/javascript/javascriptStaticAnalysisTypes.js";
import { isJavaScriptMemberMutationRefusal } from "../domain/javascript/javascriptSemanticWorkAllowance.js";
import {
  analyzeParsedJavaScriptSemanticsSteps,
  indexJavaScriptBindingsWithReceiversSteps,
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
import { errorMessage } from "../kernel/errorMessage.js";

/** The resolution mode `indexJavaScriptBindingsWithReceiversSteps` indexes under. */
const STATIC_PHASE_RESOLUTION_MODE = "import";

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
  const static_ = await staticCheckpoint(
    file.text.value,
    parsed,
    callbacks,
    purpose,
    precision,
    memberMutationAllowance,
  );
  // Structure-only keeps the full static facts and skips semantic analysis;
  // no semantic result budget is consumed.
  if (static_ === null || purpose === "structure-only") return null;
  const { resultBudgetBytes, callPaths, lexicalIndex } = static_;
  if (resultBudgetBytes === 0)
    throw new AnalysisResourceConstraintError(
      "analyze_javascript_application",
      "memory",
      `The parent reserved its remaining result capacity for static observations; semantic analysis of ${file.path} was not started`,
      { semantic_result_budget_bytes: 0 },
      { measuredExhaustion: true },
    );
  await callbacks.phase("semantic");
  const resolutionMode = moduleResolutionModeForJavaScriptReference(
    file.path,
    "static-import",
  );
  const ir = await completeJavaScriptAnalysisSteps(
    analyzeParsedJavaScriptSemanticsSteps(
      parsed,
      resolutionMode,
      capacity.nodes,
      precision,
      memberMutationAllowance,
      // The static phase indexes under "import"; any other mode changes the
      // definitions themselves, so the semantic phase collects its own.
      resolutionMode === STATIC_PHASE_RESOLUTION_MODE
        ? lexicalIndex
        : undefined,
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
    projectJavaScriptSemanticFileSteps(file, ir, capacity, callPaths),
  );
  return { module, projection };
};

/**
 * Checkpoint static facts, reusing the ones preload discovery retained for
 * this exact request. Null ends the job: discovery returns only declarations,
 * and a failed parse has no semantic phase. The caller stops after this
 * checkpoint for structure-only, so that pass reuses the same facts and
 * still does not start semantic analysis.
 */
const staticCheckpoint = async (
  source: string,
  parsed: NonNullable<ReturnType<typeof parseJavaScriptSource>>,
  callbacks: Parameters<JavaScriptSourceWorkerAnalyzer>[2],
  purpose: Parameters<JavaScriptSourceWorkerAnalyzer>[4],
  precision: Parameters<JavaScriptSourceWorkerAnalyzer>[5],
  memberMutationAllowance: Parameters<JavaScriptSourceWorkerAnalyzer>[6],
): Promise<{
  readonly resultBudgetBytes: number;
  readonly callPaths: JavaScriptStaticAnalysis["electron"]["call_paths"];
  /** The index this job's static phase built; absent for reused facts. */
  readonly lexicalIndex?: JavaScriptReceiverIndex;
} | null> => {
  const reused =
    purpose === "preload-discovery" ? undefined : callbacks.reusedStatic();
  if (reused !== undefined) {
    const resultBudgetBytes = await callbacks.checkpointReused(reused);
    return reused.parse_status === "failed"
      ? null
      : { resultBudgetBytes, callPaths: reused.call_paths };
  }
  let facts: JavaScriptStaticAnalysis;
  let lexicalIndex: JavaScriptReceiverIndex;
  try {
    // One lexical index per parsed file: the static phase reads it here and
    // the semantic phase continues from it instead of rebuilding it.
    lexicalIndex = await completeJavaScriptAnalysisSteps(
      indexJavaScriptBindingsWithReceiversSteps(
        parsed.program,
        undefined,
        precision,
        memberMutationAllowance,
      ),
    );
    facts = await completeJavaScriptAnalysisSteps(
      analyzeParsedJavaScriptStaticSourceSteps(
        source,
        parsed,
        precision,
        memberMutationAllowance,
        lexicalIndex,
      ),
    );
  } catch (cause: unknown) {
    // The semantic phase indexes the same mutations under the same
    // allowance, so it is not started; the syntax facts cross first.
    // Structure-only has no later semantic phase, so the same refusal must
    // still cross the syntax facts. Discovery leaves that report to the
    // normal pass, which recomputes this source.
    if (
      purpose !== "preload-discovery" &&
      isJavaScriptMemberMutationRefusal(cause)
    )
      await callbacks.checkpoint(
        memberMutationRefusedJavaScriptStaticAnalysis(source, parsed, cause),
      );
    throw cause;
  }
  if (purpose === "preload-discovery") {
    // Only declarations cross this preliminary pass. The normal pass owns
    // full static/semantic facts and their result reservations; the worker
    // keeps the complete checkpoint so that pass need not recompute it.
    callbacks.retainStatic(facts);
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
  return facts.parse_status === "failed"
    ? null
    : {
        resultBudgetBytes,
        callPaths: facts.electron.call_paths,
        lexicalIndex,
      };
};

try {
  await serveJavaScriptAnalysisWorker(analyze);
} catch (cause: unknown) {
  process.stderr.write(`${errorMessage(cause)}\n`);
  process.exitCode = 1;
}
