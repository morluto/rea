import { analyzeAndAdoptJavaScriptArtifactFiles } from "../../src/application/javascript/JavaScriptArtifactAnalysis.js";
import type { JavaScriptArtifactAnalysis } from "../../src/application/javascript/JavaScriptArtifactAnalysisTypes.js";
import {
  createJavaScriptSemanticGraphProjection,
  type JavaScriptSemanticGraphProjection,
} from "../../src/application/javascript/JavaScriptSemanticGraphBuilder.js";
import { createJavaScriptSourceAnalysis } from "../../src/artifacts/javascript/JavaScriptSourceAnalysis.js";
import type { JavaScriptArtifactFileSet } from "../../src/domain/javascript/javascriptArtifactFiles.js";
import { withArtifactResourceScope } from "./artifactInventory.js";

/** Analyze inert fixture sources through the real worker and join its owning scope. */
export const analyzeArtifactFiles = (
  fileSet: JavaScriptArtifactFileSet,
): Promise<{
  readonly analysis: JavaScriptArtifactAnalysis;
  readonly projection: JavaScriptSemanticGraphProjection;
}> =>
  withArtifactResourceScope(async (scope) => {
    const worker = await createJavaScriptSourceAnalysis(
      { heapMb: 512, timeoutMs: 30_000 },
      fileSet.files.filter(
        (file) => file.kind === "javascript" && file.text.included,
      ).length,
      { scope },
    );
    scope.retain({
      kind: "javascript-source-analysis",
      resource: "fixture JavaScript source analyzer",
      analysis: worker,
    });
    const projection = createJavaScriptSemanticGraphProjection();
    const outcome = await analyzeAndAdoptJavaScriptArtifactFiles(
      fileSet,
      worker,
      projection,
      async () => {},
    );
    if (outcome.interruption !== null) throw outcome.interruption;
    return { analysis: outcome.analysis, projection };
  });
