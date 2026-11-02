import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../../domain/analysisErrorCleanup.js";
import { translateArtifactFailure } from "../../artifacts/ArtifactOperationFailure.js";
import type { JavaScriptArtifactFileSet } from "../../domain/javascript/javascriptArtifactFiles.js";
import type { JavaScriptSourceAnalysisLimits } from "../../domain/javascript/javascriptSourceAnalysis.js";
import type { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { createJavaScriptSourceAnalysis } from "../../artifacts/javascript/JavaScriptSourceAnalysis.js";
import { createJavaScriptPackageTypeLookup } from "./JavaScriptArtifactAnalysis.js";
import { JavaScriptJsonDocuments } from "./JavaScriptJsonDocuments.js";
import { resolveArtifactPathByContext } from "./JavaScriptArtifactPathResolution.js";

/** Resolve declared preload identities before choosing any .js file's loader.
 * Discovery uses the same bounded worker and path owner as normal analysis.
 * It never infers a loader from renderer API text in the selected file.
 */
export const discoverJavaScriptPreloadPaths = async (
  fileSet: JavaScriptArtifactFileSet,
  limits: JavaScriptSourceAnalysisLimits,
  scope: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<ReadonlySet<string>> => {
  const paths = new Set<string>();
  const jsonDocuments = new JavaScriptJsonDocuments();
  const packageTypeFor = createJavaScriptPackageTypeLookup(
    fileSet,
    jsonDocuments,
  );
  if (
    !fileSet.files.some(
      (file) =>
        file.kind === "javascript" &&
        file.text.included &&
        /\.js$/iu.test(file.path) &&
        packageTypeFor(file) === "module",
    )
  )
    return paths;
  const sources = fileSet.files.filter(
    (file) => file.kind === "javascript" && file.text.included,
  );
  const files = new Map(fileSet.files.map((file) => [file.path, file]));
  const worker = await createJavaScriptSourceAnalysis(limits, sources.length, {
    scope,
  });
  let outcome: { kind: "completed" } | { kind: "failed"; cause: unknown } = {
    kind: "completed",
  };
  try {
    for (const file of sources) {
      const result = await worker.analyze(
        file,
        { nodes: 0, unknowns: 0 },
        signal,
        undefined,
        packageTypeFor(file),
        "preload-discovery",
      );
      if (!result.ok) throw result.error.error;
      for (const window of result.value.javascript.electron.browser_windows) {
        if (window.preload_path === null) continue;
        const resolution = resolveArtifactPathByContext({
          declaredPath: window.preload_path,
          sourcePath: file.path,
          context: window.preload_resolution_context,
          files,
          jsonDocuments,
          unanalyzedFiles: fileSet.unanalyzed_files,
          runtimePathKind: "exact-file",
        });
        if (
          resolution.resolution_status !== "resolved" ||
          resolution.resolved_path === null
        )
          continue;
        const target = files.get(resolution.resolved_path);
        if (target?.container_sha256 === file.container_sha256)
          paths.add(`${target.container_sha256}:${target.path}`);
      }
    }
  } catch (cause: unknown) {
    outcome = { kind: "failed", cause };
    throw cause;
  } finally {
    // The scoped port parks a healthy process; the following checkout resets
    // its per-analysis accounting, and scope cleanup still owns failed closes.
    const cleanup = await scope.release({
      kind: "javascript-source-analysis",
      analysis: worker,
      resource: "JavaScript preload discovery",
    });
    if (cleanup.kind === "failed") {
      if (outcome.kind === "failed" && outcome.cause instanceof AnalysisError)
        throw analysisErrorWithCleanupFailure(
          outcome.cause,
          translateArtifactFailure(
            "analyze_javascript_application",
            scope.cleanupFailure({ kind: "completed" }, [cleanup]),
          ),
          "analyze_javascript_application",
        );
      throw scope.cleanupFailure(outcome, [cleanup]);
    }
  }
  return paths;
};
