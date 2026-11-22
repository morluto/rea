import { posix } from "node:path";

import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../../domain/analysisErrorCleanup.js";
import {
  AnalysisCancelledError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { translateArtifactFailure } from "../../resources/index.js";
import type {
  JavaScriptArtifactFile,
  JavaScriptArtifactFileSet,
} from "../../domain/javascript/javascriptArtifactFiles.js";
import type { ElectronBrowserWindowFinding } from "../../domain/javascript/electronStaticAnalysisTypes.js";
import type { JavaScriptPackageType } from "../../domain/javascript/javascriptSourceParser.js";
import type { JavaScriptSourceAnalysisLimits } from "../../domain/javascript/javascriptSourceAnalysis.js";
import type { ArtifactResourceScope } from "../../resources/index.js";
import type { JavaScriptSourceAnalysisFactory } from "../../ports/javascript/JavaScriptSourceAnalysisFactory.js";
import { JavaScriptJsonDocuments } from "./JavaScriptJsonDocuments.js";
import { resolveArtifactPathByContext } from "./JavaScriptArtifactPathResolution.js";

/** Declared preload identities, with the discovery gaps that may hide others. */
export interface JavaScriptPreloadDiscovery {
  readonly paths: ReadonlySet<string>;
  readonly limitations: readonly string[];
}

/**
 * Node's package scope for a source is its nearest package.json; the lookup
 * stops at a `node_modules` directory (Node's package scope resolution). Only
 * a same-container, readable manifest object establishes the type; any other
 * nearest manifest, including one whose bytes are unavailable, or none in the
 * inventory, leaves the scope unknown.
 */
export const createJavaScriptPackageTypeLookup = (
  fileSet: JavaScriptArtifactFileSet,
  jsonDocuments: JavaScriptJsonDocuments,
): ((file: JavaScriptArtifactFile) => JavaScriptPackageType) => {
  const manifests = new Map<string, JavaScriptArtifactFile>();
  for (const file of fileSet.files)
    if (posix.basename(file.path) === "package.json")
      manifests.set(
        `${file.container_sha256}:${posix.dirname(file.path)}`,
        file,
      );
  const unavailableManifests = new Set(
    fileSet.unavailable_relevant_files
      .filter(({ path }) => posix.basename(path) === "package.json")
      .map(
        ({ path, container_sha256 }) =>
          `${container_sha256}:${posix.dirname(path)}`,
      ),
  );
  return (file) => {
    for (
      let directory = posix.dirname(file.path);
      posix.basename(directory) !== "node_modules";
      directory = posix.dirname(directory)
    ) {
      const key = `${file.container_sha256}:${directory}`;
      if (unavailableManifests.has(key)) return "unknown";
      const manifest = manifests.get(key);
      if (manifest !== undefined) {
        const document = jsonDocuments.read(manifest);
        if (document.status !== "included" || document.packageFields === null)
          return "unknown";
        const type = document.packageFields.type;
        return type === "module" || type === "commonjs" ? type : "unspecified";
      }
      // An unvisited nearer manifest may override an observed ancestor's type.
      const coverage = fileSet.unanalyzed_files?.coverage;
      if (coverage !== undefined && coverage.status !== "complete")
        return "unknown";
      if (directory === "." || directory === "" || directory === "/") break;
    }
    return "unknown";
  };
};

/** Canonical same-container preload lookup key shared by discovery and analysis. */
export const preloadTargetKey = (
  file: Pick<JavaScriptArtifactFile, "container_sha256" | "path">,
): string => `${file.container_sha256}:${file.path}`;

/** Whether any included `.js` file inherits `"module"` from its package scope. */
export const hasModuleScopedJavaScript = (
  files: readonly JavaScriptArtifactFile[],
  packageTypeFor: (file: JavaScriptArtifactFile) => JavaScriptPackageType,
): boolean =>
  files.some(
    (file) =>
      file.kind === "javascript" &&
      file.text.included &&
      posix.extname(file.path) === ".js" &&
      packageTypeFor(file) === "module",
  );

/** Resolve same-container preload paths declared by one source's BrowserWindows. */
export const collectJavaScriptPreloadPathsFromWindows = (input: {
  readonly sourceFile: JavaScriptArtifactFile;
  readonly windows: readonly ElectronBrowserWindowFinding[];
  readonly files: ReadonlyMap<string, JavaScriptArtifactFile>;
  readonly jsonDocuments: JavaScriptJsonDocuments;
  readonly unanalyzedFiles?: JavaScriptArtifactFileSet["unanalyzed_files"];
  readonly targetPaths: Set<string>;
}): void => {
  for (const window of input.windows) {
    if (window.preload_path === null || window.loader_authority === "candidate")
      continue;
    const resolution = resolveArtifactPathByContext({
      declaredPath: window.preload_path,
      sourcePath: input.sourceFile.path,
      context: window.preload_resolution_context,
      files: input.files,
      jsonDocuments: input.jsonDocuments,
      unanalyzedFiles: input.unanalyzedFiles,
      runtimePathKind: "exact-file",
    });
    if (
      resolution.resolution_status !== "resolved" ||
      resolution.resolved_path === null
    )
      continue;
    const target = input.files.get(resolution.resolved_path);
    if (target?.container_sha256 === input.sourceFile.container_sha256)
      input.targetPaths.add(preloadTargetKey(target));
  }
};

/** Describe an unread source gap that may leave a `.js` preload in module scope. */
export const formatPreloadDiscoveryLimitation = (
  filePath: string,
  errorMessage: string,
  skipped: boolean,
  laterSources: number,
): string =>
  skipped || laterSources === 0
    ? `Preload discovery could not read ${filePath} (${errorMessage}); a .js preload declared only there keeps its package scope.`
    : `Preload discovery stopped at ${filePath} (${errorMessage}); a .js preload declared only there or in ${String(laterSources)} later sources keeps its package scope.`;

/** Resolve declared preload identities before choosing any .js file's loader.
 * Discovery uses the same bounded worker and path owner as normal analysis.
 * It never infers a loader from renderer API text in the selected file.
 */
export const discoverJavaScriptPreloadPaths = async (
  fileSet: JavaScriptArtifactFileSet,
  limits: JavaScriptSourceAnalysisLimits,
  scope: ArtifactResourceScope,
  sourceAnalysis: JavaScriptSourceAnalysisFactory,
  signal?: AbortSignal,
): Promise<JavaScriptPreloadDiscovery> => {
  const paths = new Set<string>();
  const limitations: string[] = [];
  const jsonDocuments = new JavaScriptJsonDocuments();
  const packageTypeFor = createJavaScriptPackageTypeLookup(
    fileSet,
    jsonDocuments,
  );
  if (!hasModuleScopedJavaScript(fileSet.files, packageTypeFor))
    return { paths, limitations };
  const sources = fileSet.files.filter(
    (file) => file.kind === "javascript" && file.text.included,
  );
  const files = new Map(fileSet.files.map((file) => [file.path, file]));
  const worker = await sourceAnalysis(limits, sources.length, {
    scope,
  });
  let outcome: { kind: "completed" } | { kind: "failed"; cause: unknown } = {
    kind: "completed",
  };
  try {
    for (const [index, file] of sources.entries()) {
      const result = await worker.analyze(
        file,
        { nodes: 0, unknowns: 0 },
        signal,
        undefined,
        packageTypeFor(file),
        "preload-discovery",
      );
      if (!result.ok) {
        const { error } = result.error;
        if (signal?.aborted === true || error instanceof AnalysisCancelledError)
          throw error;
        // Normal analysis meets the same source and owns its failure and the
        // partial Evidence. A per-source limit only loses this source's
        // declarations; any other failure would stop that pass here too. The
        // gap stays reported even if normal analysis then reads the source.
        const skipped =
          error instanceof AnalysisResourceConstraintError &&
          error.reportedLimits?.parent_result_budget_exhausted !== true;
        const later = sources.length - index - 1;
        limitations.push(
          formatPreloadDiscoveryLimitation(
            file.path,
            error.message,
            skipped,
            later,
          ),
        );
        if (skipped) continue;
        break;
      }
      collectJavaScriptPreloadPathsFromWindows({
        sourceFile: file,
        windows: result.value.javascript.electron.browser_windows,
        files,
        jsonDocuments,
        unanalyzedFiles: fileSet.unanalyzed_files,
        targetPaths: paths,
      });
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
  return { paths, limitations };
};
