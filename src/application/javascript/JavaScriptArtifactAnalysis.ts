import { boundedList } from "../../domain/boundedList.js";
import { posix } from "node:path";

import { setImmediate } from "node:timers/promises";

import type { JavaScriptSemanticFileProjection } from "../../domain/javascript/javascriptSemanticFileProjection.js";
import { JAVASCRIPT_SEMANTIC_RELATION_FAMILIES } from "../../domain/javascript/javascriptSemanticGraphSchemas.js";
import { resolveJavaScriptSourceMapReference } from "../../domain/javascript/javascriptSourceMapPaths.js";
import {
  inspectLocalSourceMapDeclarations,
  type LocalSourceMapDeclaration,
} from "../../domain/sourceMapFormat.js";
import type { JavaScriptStaticAnalysis } from "../../domain/javascript/javascriptStaticAnalysisTypes.js";
import type {
  JavaScriptArtifactFile,
  JavaScriptArtifactFileSet,
} from "../../domain/javascript/javascriptArtifactFiles.js";
import {
  javaScriptArtifactTextExclusion,
  javaScriptSemanticSourceExclusion,
} from "../../domain/javascript/javascriptArtifactFiles.js";
import type {
  AnalyzedJavaScriptArtifactFile,
  JavaScriptArtifactAnalysisFailure,
  JavaScriptArtifactAnalysisScope,
  JavaScriptArtifactAnalysis,
  JavaScriptHtmlInlineScriptsObservation,
  JavaScriptHtmlScriptObservation,
  JavaScriptJsonModuleObservation,
  JavaScriptPackageObservation,
  JavaScriptSourceMapObservation,
  JavaScriptSourceMapOriginal,
} from "./JavaScriptArtifactAnalysisTypes.js";
import { javascriptArtifactAnalysisScopes } from "./JavaScriptArtifactAnalysisTypes.js";
import { analyzeJavaScriptJsonModule } from "./JavaScriptJsonModules.js";
import {
  JavaScriptJsonDocuments,
  type JavaScriptJsonDocumentFacts,
} from "./JavaScriptJsonDocuments.js";
import { assertJavaScriptAnalysisActive } from "./JavaScriptAnalysisControl.js";
import { htmlArtifactReferences } from "../../domain/javascript/htmlArtifactReferences.js";
import type {
  JavaScriptAnalyzedSource,
  JavaScriptSourceAnalysisFailure,
  JavaScriptSourceAnalysisPort,
} from "../../domain/javascript/javascriptSourceAnalysis.js";
import type { JavaScriptSemanticGraphProjection } from "./JavaScriptSemanticGraphBuilder.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  ArtifactReaderFailure,
  translateArtifactFailure,
} from "../../resources/index.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import {
  AnalysisCancelledError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
  cancelledBy,
  carriedReason,
} from "../../domain/analysisErrorCore.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import type { Result } from "../../domain/result.js";
import { sha256Hex } from "../../kernel/sha256Hex.js";
import {
  collectJavaScriptPreloadPathsFromWindows,
  createJavaScriptPackageTypeLookup,
  formatPreloadDiscoveryLimitation,
  hasModuleScopedJavaScript,
  preloadTargetKey,
} from "./JavaScriptPreloadDiscovery.js";

export { createJavaScriptPackageTypeLookup };

interface MutableArtifactAnalysis {
  readonly jsonDocuments: JavaScriptJsonDocuments;
  readonly files: AnalyzedJavaScriptArtifactFile[];
  readonly packages: JavaScriptPackageObservation[];
  readonly jsonModules: JavaScriptJsonModuleObservation[];
  readonly htmlScripts: JavaScriptHtmlScriptObservation[];
  readonly htmlInlineScripts: JavaScriptHtmlInlineScriptsObservation[];
  readonly sourceMaps: JavaScriptSourceMapObservation[];
  visitedNodes: number;
  findings: number;
  modules: number;
  parseFailures: number;
}

interface SourceStatsDelta {
  readonly visitedNodes: number;
  readonly findings: number;
  readonly modules: number;
  readonly parseFailures: number;
}

interface ReanalyzableModuleJs {
  readonly file: JavaScriptArtifactFile;
  readonly stateFileIndex: number;
  workerCallIndex: number;
  statsDelta: SourceStatsDelta;
  pendingOpIndex: number;
}

type PendingProjectionOp =
  | {
      readonly kind: "adopt";
      readonly projection: JavaScriptSemanticFileProjection;
      readonly nodes: number;
      readonly unknowns: number;
    }
  | {
      readonly kind: "unavailable";
      readonly file: JavaScriptArtifactFile;
      readonly reason: string;
      readonly limits: Readonly<Record<string, JsonValue>> | null;
      readonly unknownReason: "resource-limit" | "incomplete-module";
      readonly nodes: number;
      readonly unknowns: number;
    };

class PendingSemanticProjection {
  readonly #target: JavaScriptSemanticGraphProjection;
  readonly #deferred: boolean;
  readonly #ops: (PendingProjectionOp | null)[] = [];
  #reservedNodes = 0;
  #reservedUnknowns = 0;

  constructor(target: JavaScriptSemanticGraphProjection, deferred: boolean) {
    this.#target = target;
    this.#deferred = deferred;
  }

  remainingCapacity() {
    return this.#deferred
      ? this.#target.remainingFileCapacity({
          nodes: this.#reservedNodes,
          unknowns: this.#reservedUnknowns,
        })
      : this.#target.remainingFileCapacity();
  }

  adopt(projection: JavaScriptSemanticFileProjection): number {
    if (!this.#deferred) {
      this.#target.adoptFileProjection(projection);
      return -1;
    }
    const nodes = projection.nodes.length;
    const unknowns = projection.unknowns.length;
    this.#reservedNodes += nodes;
    this.#reservedUnknowns += unknowns;
    this.#ops.push({ kind: "adopt", projection, nodes, unknowns });
    return this.#ops.length - 1;
  }

  recordUnavailable(
    file: JavaScriptArtifactFile,
    reason: string,
    limits: Readonly<Record<string, JsonValue>> | null,
    unknownReason: "resource-limit" | "incomplete-module",
  ): number {
    if (!this.#deferred) {
      this.#target.recordUnavailableFile(file, reason, limits, unknownReason);
      return -1;
    }
    const nodes = file.kind === "javascript" ? 1 : 0;
    const unknowns =
      file.kind === "javascript"
        ? JAVASCRIPT_SEMANTIC_RELATION_FAMILIES.length
        : 0;
    this.#reservedNodes += nodes;
    this.#reservedUnknowns += unknowns;
    this.#ops.push({
      kind: "unavailable",
      file,
      reason,
      limits,
      unknownReason,
      nodes,
      unknowns,
    });
    return this.#ops.length - 1;
  }

  remove(opIndex: number): void {
    if (!this.#deferred || opIndex < 0) return;
    const op = this.#ops[opIndex];
    if (op === undefined || op === null) return;
    this.#reservedNodes -= op.nodes;
    this.#reservedUnknowns -= op.unknowns;
    this.#ops[opIndex] = null;
  }

  flush(): void {
    if (!this.#deferred) return;
    for (const op of this.#ops) {
      if (op === null) continue;
      if (op.kind === "adopt") this.#target.adoptFileProjection(op.projection);
      else
        this.#target.recordUnavailableFile(
          op.file,
          op.reason,
          op.limits,
          op.unknownReason,
        );
    }
    this.#ops.length = 0;
    this.#reservedNodes = 0;
    this.#reservedUnknowns = 0;
  }
}

interface SourceAdoptionContext {
  readonly state: MutableArtifactAnalysis;
  readonly sourceIndices: (number | "replaced")[];
  readonly pendingProjection: PendingSemanticProjection;
  readonly filesByPath: ReadonlyMap<string, JavaScriptArtifactFile>;
  readonly unanalyzedFiles: JavaScriptArtifactFileSet["unanalyzed_files"];
  readonly discoveredPreloadPaths: Set<string>;
  readonly discoverPreloads: boolean;
}

const applySourceResult = (
  ctx: SourceAdoptionContext,
  file: JavaScriptArtifactFile,
  result: Result<JavaScriptAnalyzedSource, JavaScriptSourceAnalysisFailure>,
  targetStateIndex: number,
  workerCallIndex: number,
): {
  readonly statsDelta: SourceStatsDelta;
  readonly pendingOpIndex: number;
  readonly error: AnalysisError | null;
  readonly hasJavaScriptFacts: boolean;
} => {
  const facts = result.ok ? result.value : result.error;
  for (const revoked of facts.revokedStaticProjections ?? []) {
    const index = ctx.sourceIndices[revoked.sourceIndex];
    if (index === "replaced") continue;
    const previous = index === undefined ? undefined : ctx.state.files[index];
    if (previous === undefined)
      throw new TypeError(
        "Revoked application projection has no retained source",
      );
    ctx.state.files[index!] = {
      ...previous,
      application_projection_failure: {
        reason: revoked.error.message,
        error: projectAnalysisError(revoked.error),
        limits: revoked.error.reportedLimits,
      },
    };
  }
  const error = result.ok ? null : result.error.error;
  const limits = errorReportedLimits(error);
  const failure: JavaScriptArtifactAnalysisFailure | undefined =
    error === null
      ? undefined
      : {
          scope: javascriptArtifactAnalysisScopes.javascript,
          status: "interrupted",
          reason: `${file.path}: ${error.message}`,
          error: projectAnalysisError(error),
          limits,
        };
  ctx.sourceIndices[workerCallIndex] = targetStateIndex;
  const applicationProjectionFailure = facts.applicationProjectionFailure;
  ctx.state.files[targetStateIndex] = {
    file,
    javascript: facts.javascript,
    semantic: facts.module === null ? null : { ir: facts.module },
    ...(failure === undefined ? {} : { analysis_failure: failure }),
    ...(applicationProjectionFailure === undefined
      ? {}
      : {
          application_projection_failure: {
            reason: applicationProjectionFailure.message,
            error: projectAnalysisError(applicationProjectionFailure),
            limits: applicationProjectionFailure.reportedLimits,
          },
        }),
  };
  let pendingOpIndex = -1;
  if (facts.projection !== null)
    pendingOpIndex = ctx.pendingProjection.adopt(facts.projection);
  else {
    const semanticUnavailableReason =
      failure?.reason ??
      javaScriptSemanticSourceExclusion(
        file,
        facts.javascript?.parse_status ?? null,
      );
    if (semanticUnavailableReason !== null)
      pendingOpIndex = ctx.pendingProjection.recordUnavailable(
        file,
        semanticUnavailableReason,
        failure?.limits ?? null,
        error instanceof AnalysisResourceConstraintError ||
          error instanceof AnalysisTimeoutError
          ? "resource-limit"
          : "incomplete-module",
      );
  }
  const statsDelta = computeStatsDelta(facts.javascript, facts.module);
  addStatsDelta(ctx.state, statsDelta);
  if (ctx.discoverPreloads && facts.javascript !== null)
    collectJavaScriptPreloadPathsFromWindows({
      sourceFile: file,
      windows: facts.javascript.electron.browser_windows,
      files: ctx.filesByPath,
      jsonDocuments: ctx.state.jsonDocuments,
      unanalyzedFiles: ctx.unanalyzedFiles,
      targetPaths: ctx.discoveredPreloadPaths,
    });
  return {
    statsDelta,
    pendingOpIndex,
    error,
    hasJavaScriptFacts: facts.javascript !== null,
  };
};

const computeStatsDelta = (
  javascript: JavaScriptStaticAnalysis | null,
  module: JavaScriptAnalyzedSource["module"],
): SourceStatsDelta => {
  if (javascript === null)
    return { visitedNodes: 0, findings: 0, modules: 0, parseFailures: 0 };
  return {
    visitedNodes: javascript.visited_ast_nodes,
    findings: findingCount(javascript) + (module?.moduleLinks.length ?? 0),
    modules: javascript.bundler_registrations.reduce(
      (count, item) => count + item.modules.length,
      0,
    ),
    parseFailures: javascript.parse_status === "failed" ? 1 : 0,
  };
};

const addStatsDelta = (
  state: MutableArtifactAnalysis,
  delta: SourceStatsDelta,
): void => {
  state.visitedNodes += delta.visitedNodes;
  state.findings += delta.findings;
  state.modules += delta.modules;
  state.parseFailures += delta.parseFailures;
};

const subtractStatsDelta = (
  state: MutableArtifactAnalysis,
  delta: SourceStatsDelta,
): void => {
  state.visitedNodes -= delta.visitedNodes;
  state.findings -= delta.findings;
  state.modules -= delta.modules;
  state.parseFailures -= delta.parseFailures;
};

const errorReportedLimits = (
  error: AnalysisError | null,
): Readonly<Record<string, JsonValue>> | null =>
  error instanceof AnalysisResourceConstraintError
    ? error.reportedLimits
    : error instanceof AnalysisTimeoutError
      ? { worker_timeout_ms: error.timeoutMs }
      : null;

const isSignalAborted = (signal?: AbortSignal): boolean =>
  signal?.aborted === true;

const recordCaughtFileFailure = (input: {
  readonly ctx: SourceAdoptionContext;
  readonly file: JavaScriptArtifactFile;
  readonly interruption: AnalysisError;
  readonly analysisStarted: boolean;
  readonly targetStateIndex: number;
}): void => {
  const { ctx, file, interruption, analysisStarted, targetStateIndex } = input;
  const scope = javascriptArtifactAnalysisScopes[file.kind];
  ctx.state.files[targetStateIndex] = {
    file,
    javascript: null,
    semantic: null,
    ...(scope === null
      ? {}
      : {
          analysis_failure: {
            scope,
            status: analysisStarted ? "interrupted" : "not-started",
            reason: `${file.path}: ${interruption.message}`,
            error: projectAnalysisError(interruption),
            limits: null,
          },
        }),
  };
  ctx.pendingProjection.recordUnavailable(
    file,
    interruption.message,
    null,
    "incomplete-module",
  );
};

const reanalyzeDiscoveredPreloads = async (input: {
  readonly ctx: SourceAdoptionContext;
  readonly worker: Pick<JavaScriptSourceAnalysisPort, "analyze">;
  readonly reanalyzable: readonly ReanalyzableModuleJs[];
  readonly signal: AbortSignal | undefined;
  readonly onPhase:
    | ((file: JavaScriptArtifactFile, phase: string) => Promise<void>)
    | undefined;
  readonly nextWorkerCallIndex: () => number;
}): Promise<AnalysisError | null> => {
  const { ctx, worker, reanalyzable, signal, onPhase, nextWorkerCallIndex } =
    input;
  const reanalyzed = new Set<number>();
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const entry of reanalyzable) {
      if (reanalyzed.has(entry.stateFileIndex)) continue;
      if (!ctx.discoveredPreloadPaths.has(preloadTargetKey(entry.file)))
        continue;
      reanalyzed.add(entry.stateFileIndex);
      progressed = true;
      await setImmediate();
      if (signal?.aborted === true)
        return cancelledBy("analyze_javascript_application", signal);
      subtractStatsDelta(ctx.state, entry.statsDelta);
      ctx.sourceIndices[entry.workerCallIndex] = "replaced";
      ctx.pendingProjection.remove(entry.pendingOpIndex);
      try {
        const result = await worker.analyze(
          entry.file,
          ctx.pendingProjection.remainingCapacity(),
          signal,
          onPhase === undefined
            ? undefined
            : (phase) => onPhase(entry.file, phase),
          "commonjs",
        );
        const workerCallIndex = nextWorkerCallIndex();
        const applied = applySourceResult(
          ctx,
          entry.file,
          result,
          entry.stateFileIndex,
          workerCallIndex,
        );
        entry.workerCallIndex = workerCallIndex;
        entry.statsDelta = applied.statsDelta;
        entry.pendingOpIndex = applied.pendingOpIndex;
        if (
          applied.error !== null &&
          (!(applied.error instanceof AnalysisResourceConstraintError) ||
            applied.error.reportedLimits?.parent_result_budget_exhausted ===
              true)
        )
          return applied.error;
      } catch (cause: unknown) {
        let interruption: AnalysisError;
        if (cause instanceof AnalysisError) interruption = cause;
        else if (
          cause instanceof ArtifactReaderFailure &&
          cause.reason === "cancelled"
        )
          interruption = translateArtifactFailure(
            "analyze_javascript_application",
            cause,
          );
        else if (isSignalAborted(signal) && cause === signal?.reason)
          interruption = cancelledBy(
            "analyze_javascript_application",
            carriedReason(cause),
          );
        else throw cause;
        recordCaughtFileFailure({
          ctx,
          file: entry.file,
          interruption,
          analysisStarted: true,
          targetStateIndex: entry.stateFileIndex,
        });
        return interruption;
      }
    }
  }
  return null;
};

const recordUnvisitedFilesAfterInterruption = (
  fileSet: JavaScriptArtifactFileSet,
  state: MutableArtifactAnalysis,
  projection: JavaScriptSemanticGraphProjection,
  interruption: AnalysisError,
): void => {
  const analyzedPaths = new Set(state.files.map(({ file }) => file.path));
  const failure = {
    reason: `Source analysis was interrupted: ${interruption.message}`,
    error: projectAnalysisError(interruption),
    limits: errorReportedLimits(interruption),
  };
  // This interruption has one cause. Share its immutable failure per phase
  // rather than copying it for every unvisited source in a large bundle.
  const failures = new Map<
    JavaScriptArtifactAnalysisScope,
    JavaScriptArtifactAnalysisFailure
  >();
  for (const file of fileSet.files) {
    if (analyzedPaths.has(file.path)) continue;
    if (classifyUnavailableSource(file, state, projection)) continue;
    const scope = javascriptArtifactAnalysisScopes[file.kind];
    let unavailable = scope === null ? undefined : failures.get(scope);
    if (scope !== null && unavailable === undefined) {
      unavailable = { ...failure, scope, status: "not-started" };
      failures.set(scope, unavailable);
    }
    state.files.push({
      file,
      javascript: null,
      semantic: null,
      ...(unavailable === undefined ? {} : { analysis_failure: unavailable }),
    });
    projection.recordUnavailableFile(
      file,
      failure.reason,
      failure.limits,
      interruption instanceof AnalysisResourceConstraintError ||
        interruption instanceof AnalysisTimeoutError
        ? "resource-limit"
        : "incomplete-module",
    );
  }
};

/** Analyze sources behind a hard heap boundary, retaining collected facts on interruption. */
export const analyzeAndAdoptJavaScriptArtifactFiles = async (
  fileSet: JavaScriptArtifactFileSet,
  worker: Pick<JavaScriptSourceAnalysisPort, "analyze">,
  projection: JavaScriptSemanticGraphProjection,
  beforeFile: (
    file: JavaScriptArtifactFile,
    completed: number,
    total: number,
  ) => Promise<void>,
  signal?: AbortSignal,
  onPhase?: (file: JavaScriptArtifactFile, phase: string) => Promise<void>,
  preloadPaths?: ReadonlySet<string>,
  /** Discovery gaps that may leave a declared preload in its package scope. */
  preloadLimitations: readonly string[] = [],
): Promise<{
  readonly analysis: JavaScriptArtifactAnalysis;
  readonly interruption: AnalysisError | null;
}> => {
  const state = emptyArtifactAnalysis();
  const packageTypeFor = createJavaScriptPackageTypeLookup(
    fileSet,
    state.jsonDocuments,
  );
  const orderedFiles =
    fileSet.source_selection === undefined
      ? javaScriptAnalysisOrder(fileSet.files)
      : fileSet.files;
  const discoverPreloads =
    preloadPaths === undefined &&
    hasModuleScopedJavaScript(orderedFiles, packageTypeFor);
  const pendingProjection = new PendingSemanticProjection(
    projection,
    discoverPreloads,
  );
  const ctx: SourceAdoptionContext = {
    state,
    sourceIndices: [],
    pendingProjection,
    filesByPath: discoverPreloads
      ? new Map(fileSet.files.map((file) => [file.path, file]))
      : new Map(),
    unanalyzedFiles: fileSet.unanalyzed_files,
    discoveredPreloadPaths: new Set(preloadPaths),
    discoverPreloads,
  };
  const effectivePreloadLimitations = [...preloadLimitations];
  const reanalyzable: ReanalyzableModuleJs[] = [];
  const totalIncludedJs = discoverPreloads
    ? orderedFiles.filter(
        (file) => file.kind === "javascript" && file.text.included,
      ).length
    : 0;
  let visitedIncludedJs = 0;
  let workerCallCounter = 0;
  let interruption: AnalysisError | null = null;
  const selectedFileCount =
    fileSet.files.length - (fileSet.source_selection?.unselected_files ?? 0);
  let selectedFileIndex = 0;

  for (const file of orderedFiles) {
    let analysisStarted = false;
    try {
      await setImmediate();
      if (classifyUnavailableSource(file, state, pendingProjection)) {
        if (signal?.aborted === true) {
          interruption = cancelledBy("analyze_javascript_application", signal);
          break;
        }
        continue;
      }
      if (signal?.aborted === true)
        throw cancelledBy("analyze_javascript_application", signal);
      await beforeFile(file, selectedFileIndex++, selectedFileCount);
      analysisStarted = true;
      if (file.kind !== "javascript" || !file.text.included) {
        assertJavaScriptAnalysisActive(signal);
        analyzeArtifactMetadata(file, state, signal);
        assertJavaScriptAnalysisActive(signal);
        continue;
      }
      visitedIncludedJs += 1;
      const packageType = packageTypeFor(file);
      const isJsExtension = posix.extname(file.path) === ".js";
      const effectivePackageType =
        isJsExtension && ctx.discoveredPreloadPaths.has(preloadTargetKey(file))
          ? "commonjs"
          : packageType;
      const result = await worker.analyze(
        file,
        pendingProjection.remainingCapacity(),
        signal,
        onPhase === undefined ? undefined : (phase) => onPhase(file, phase),
        effectivePackageType,
      );
      const workerCallIndex = workerCallCounter++;
      const stateFileIndex = state.files.length;
      const applied = applySourceResult(
        ctx,
        file,
        result,
        stateFileIndex,
        workerCallIndex,
      );
      if (
        discoverPreloads &&
        isJsExtension &&
        effectivePackageType === "module"
      )
        reanalyzable.push({
          file,
          stateFileIndex,
          workerCallIndex,
          statsDelta: applied.statsDelta,
          pendingOpIndex: applied.pendingOpIndex,
        });
      if (applied.error !== null) {
        const skipped =
          applied.error instanceof AnalysisResourceConstraintError &&
          applied.error.reportedLimits?.parent_result_budget_exhausted !== true;
        if (
          discoverPreloads &&
          !applied.hasJavaScriptFacts &&
          !isSignalAborted(signal) &&
          !(applied.error instanceof AnalysisCancelledError)
        )
          effectivePreloadLimitations.push(
            formatPreloadDiscoveryLimitation(
              file.path,
              applied.error.message,
              skipped,
              totalIncludedJs - visitedIncludedJs,
            ),
          );
        if (!skipped) {
          interruption = applied.error;
          break;
        }
      }
    } catch (cause: unknown) {
      if (cause instanceof AnalysisError) interruption = cause;
      else if (
        cause instanceof ArtifactReaderFailure &&
        cause.reason === "cancelled"
      )
        interruption = translateArtifactFailure(
          "analyze_javascript_application",
          cause,
        );
      else if (signal?.aborted === true && cause === signal.reason)
        interruption = cancelledBy(
          "analyze_javascript_application",
          carriedReason(cause),
        );
      else throw cause;
      if (
        discoverPreloads &&
        file.kind === "javascript" &&
        file.text.included &&
        signal?.aborted !== true &&
        !(interruption instanceof AnalysisCancelledError)
      )
        effectivePreloadLimitations.push(
          formatPreloadDiscoveryLimitation(
            file.path,
            interruption.message,
            false,
            totalIncludedJs - visitedIncludedJs,
          ),
        );
      recordCaughtFileFailure({
        ctx,
        file,
        interruption,
        analysisStarted,
        targetStateIndex: state.files.length,
      });
      break;
    }
  }
  if (
    discoverPreloads &&
    interruption === null &&
    ctx.discoveredPreloadPaths.size > 0 &&
    reanalyzable.length > 0
  )
    interruption = await reanalyzeDiscoveredPreloads({
      ctx,
      worker,
      reanalyzable,
      signal,
      onPhase,
      nextWorkerCallIndex: () => workerCallCounter++,
    });
  pendingProjection.flush();
  if (interruption !== null)
    recordUnvisitedFilesAfterInterruption(
      fileSet,
      state,
      projection,
      interruption,
    );
  restoreInventoryOrder(fileSet.files, state.files);
  return {
    analysis: finalizeArtifactAnalysis(state, effectivePreloadLimitations),
    interruption,
  };
};

/** A source inside an installed dependency package, not the application. */
const dependencySourcePath = (path: string): boolean =>
  path.split("/").slice(0, -1).includes("node_modules");

/**
 * Every source in one analysis charges the same parent result budget, so the
 * order sources are offered decides which ones keep semantic and application
 * facts when that budget runs out. Inventory order is lexical, which lets a
 * large `node_modules` tree spend the budget before first-party entrypoints,
 * preloads, and Electron windows are examined. Offer application JavaScript
 * first and dependency JavaScript last; metadata files keep their position.
 */
const javaScriptAnalysisOrder = (
  files: readonly JavaScriptArtifactFile[],
): JavaScriptArtifactFile[] => {
  const application: JavaScriptArtifactFile[] = [];
  const dependencies: JavaScriptArtifactFile[] = [];
  for (const file of files) {
    if (file.kind === "javascript" && dependencySourcePath(file.path))
      dependencies.push(file);
    else application.push(file);
  }
  return [...application, ...dependencies];
};

/** Analysis order is an admission policy; reported files keep inventory order. */
const restoreInventoryOrder = (
  inventory: readonly JavaScriptArtifactFile[],
  analyzed: AnalyzedJavaScriptArtifactFile[],
): void => {
  const positions = new Map(inventory.map((file, index) => [file, index]));
  const position = ({ file }: AnalyzedJavaScriptArtifactFile): number =>
    positions.get(file) ?? inventory.length;
  analyzed.sort((left, right) => position(left) - position(right));
};

const finalizeArtifactAnalysis = (
  state: MutableArtifactAnalysis,
  preloadLimitations: readonly string[],
): JavaScriptArtifactAnalysis => {
  return {
    jsonDocuments: state.jsonDocuments,
    files: state.files,
    packages: state.packages,
    json_modules: state.jsonModules,
    html_scripts: state.htmlScripts,
    html_inline_scripts: state.htmlInlineScripts,
    source_maps: state.sourceMaps,
    visited_ast_nodes: state.visitedNodes,
    findings:
      state.findings +
      state.htmlScripts.length +
      state.htmlInlineScripts.reduce(
        (count, { script_count }) => count + script_count,
        0,
      ),
    modules: state.modules,
    parse_failures: state.parseFailures,
    limitations: [
      "JavaScript and HTML were parsed as inert text; bundle bootstrap code was never executed.",
      "Static paths and relationships may remain unresolved when expressions are dynamic or obfuscated.",
      ...state.htmlInlineScripts.map(htmlInlineScriptLimitation),
      ...state.files.flatMap(
        ({ analysis_failure, application_projection_failure }) =>
          [analysis_failure, application_projection_failure].flatMap(
            (failure) => (failure === undefined ? [] : [failure.reason]),
          ),
      ),
      ...preloadLimitations,
    ],
  };
};

const analyzeArtifactMetadata = (
  file: JavaScriptArtifactFile,
  state: MutableArtifactAnalysis,
  signal: AbortSignal | undefined,
): void => {
  addStructuredObservations(file, state);
  if (file.kind === "html" && file.text.included) {
    const html = parseHtmlScripts(file.path, file.text.value);
    // Append without spreading: argument count is bounded by the engine.
    for (const script of html.scripts) state.htmlScripts.push(script);
    if (html.inlineScripts !== null)
      state.htmlInlineScripts.push(html.inlineScripts);
  }
  if (file.kind === "source-map")
    state.sourceMaps.push(parseSourceMap(file, signal));
  state.files.push({ file, javascript: null, semantic: null });
};

const classifyUnavailableSource = (
  file: JavaScriptArtifactFile,
  state: MutableArtifactAnalysis,
  projection:
    | Pick<JavaScriptSemanticGraphProjection, "recordUnavailableFile">
    | PendingSemanticProjection,
): boolean => {
  const reason = javaScriptArtifactTextExclusion(file);
  if (reason === null) return false;
  state.files.push({ file, javascript: null, semantic: null });
  if (projection instanceof PendingSemanticProjection)
    projection.recordUnavailable(file, reason, null, "incomplete-module");
  else
    projection.recordUnavailableFile(file, reason, null, "incomplete-module");
  return true;
};

const emptyArtifactAnalysis = (): MutableArtifactAnalysis => ({
  jsonDocuments: new JavaScriptJsonDocuments(),
  files: [],
  packages: [],
  jsonModules: [],
  htmlScripts: [],
  htmlInlineScripts: [],
  sourceMaps: [],
  visitedNodes: 0,
  findings: 0,
  modules: 0,
  parseFailures: 0,
});

const addStructuredObservations = (
  file: JavaScriptArtifactFile,
  state: MutableArtifactAnalysis,
): void => {
  if (file.kind === "package-json")
    state.packages.push(parsePackage(file, state.jsonDocuments.read(file)));
  if (file.kind !== "json") return;
  const json = analyzeJavaScriptJsonModule(file, state.jsonDocuments);
  state.jsonModules.push(json);
  if (json.status === "invalid") state.parseFailures += 1;
};

const parsePackage = (
  file: JavaScriptArtifactFile,
  document: JavaScriptJsonDocumentFacts,
): JavaScriptPackageObservation => {
  if (document.status === "unavailable")
    return unavailablePackage(file, "Package metadata text was unavailable.");
  if (document.status === "invalid")
    return invalidPackage(file, "package.json is not valid JSON.");
  if (document.packageFields === null)
    return invalidPackage(file, "package.json root is not an object.");
  const value = document.packageFields;
  const rendererDeclarations: NonNullable<
    JavaScriptPackageObservation["renderer_declarations"]
  > = {};
  let rendererEntrypoint: JavaScriptPackageObservation["renderer_entrypoint"] =
    null;
  for (const field of ["renderer", "browser", "module"] as const) {
    if (!Object.hasOwn(value, field)) continue;
    const declaration = value[field];
    rendererDeclarations[field] =
      typeof declaration === "string" ? declaration : { status: "non-string" };
    if (
      rendererEntrypoint === null &&
      typeof declaration === "string" &&
      declaration !== ""
    )
      rendererEntrypoint = { field, path: declaration };
  }
  return {
    path: file.path,
    sha256: file.sha256,
    status: "included",
    name: optionalString(value.name),
    version: optionalString(value.version),
    main: optionalString(value.main),
    main_status:
      value.main === undefined || value.main === ""
        ? "default"
        : typeof value.main === "string"
          ? "declared"
          : "invalid",
    main_entrypoint: typeof value.main === "string" ? value.main : "",
    renderer_declarations: rendererDeclarations,
    renderer_entrypoint: rendererEntrypoint,
    limitation: null,
  };
};

const invalidPackage = (
  file: JavaScriptArtifactFile,
  limitation: string,
): JavaScriptPackageObservation => ({
  ...unavailablePackage(file, limitation),
  status: "invalid",
});

const unavailablePackage = (
  file: JavaScriptArtifactFile,
  limitation: string,
): JavaScriptPackageObservation & { readonly status: "unavailable" } => ({
  path: file.path,
  sha256: file.sha256,
  status: "unavailable",
  name: null,
  version: null,
  main: null,
  main_status: "unavailable",
  main_entrypoint: null,
  renderer_declarations: null,
  renderer_entrypoint: null,
  limitation,
});

const parseHtmlScripts = (
  path: string,
  text: string,
): {
  readonly scripts: JavaScriptHtmlScriptObservation[];
  readonly inlineScripts: JavaScriptHtmlInlineScriptsObservation | null;
} => {
  const { scripts, inlineScripts, inlineScriptCount, baseHref } =
    htmlArtifactReferences(text);
  return {
    scripts: scripts.map(({ scriptPath, scriptType, location }) => ({
      html_path: path,
      script_path: scriptPath,
      script_type: scriptType,
      base_href: baseHref,
      location,
    })),
    inlineScripts:
      inlineScriptCount === 0
        ? null
        : {
            path,
            script_count: inlineScriptCount,
            scripts: inlineScripts.map(({ scriptType, location }) => ({
              script_type: scriptType,
              location,
            })),
          },
  };
};

const parseSourceMap = (
  file: JavaScriptArtifactFile,
  signal: AbortSignal | undefined,
): JavaScriptSourceMapObservation => {
  if (!file.text.included) return unavailableSourceMap(file);
  const observed = inspectLocalSourceMapDeclarations(file.text.value, {
    check: () => assertJavaScriptAnalysisActive(signal),
  });
  const sources = collectSourceMapOriginals(file, observed.declarations);
  const limitations = [
    ...observed.limitations,
    ...observed.invalid_sections.map(
      ({ section_path, reason }) =>
        `Indexed source-map section at [${section_path.join(",")}]: ${reason}`,
    ),
    ...observed.external_sections.map(
      ({ url }) => `External source-map section URL is not fetched: ${url}`,
    ),
  ];
  if (limitations.length > 0)
    return {
      ...invalidSourceMap(file, [...new Set(limitations)].join("; "), sources),
      ...(observed.external_sections.length === 0
        ? {}
        : { external_sections: observed.external_sections }),
      ...(observed.invalid_sections.length === 0
        ? {}
        : { invalid_sections: observed.invalid_sections }),
    };
  return {
    path: file.path,
    sha256: file.sha256,
    status: "included",
    sources,
    limitation: null,
  };
};

const collectSourceMapOriginals = (
  file: JavaScriptArtifactFile,
  declarations: readonly LocalSourceMapDeclaration[],
): JavaScriptSourceMapOriginal[] =>
  declarations.map(
    (
      { sectionPath, sourceIndex, source, root, content },
      declaration_index,
    ) => {
      return {
        source_index: sourceIndex,
        declaration_index,
        reference: resolveJavaScriptSourceMapReference(source, root, file.path),
        content,
        content_sha256: content === null ? null : sha256Hex(content),
        section_path: sectionPath,
      };
    },
  );

/** Name the HTML file and lines whose inline JavaScript was not analyzed. */
export const htmlInlineScriptLimitation = ({
  path,
  script_count: count,
  scripts,
}: JavaScriptHtmlInlineScriptsObservation): string => {
  const listed = boundedList(
    scripts.map(({ location }) => String(location.start.line)),
    HTML_INLINE_SCRIPT_LIMITATION_LINES,
    count - scripts.length,
  );
  const lines = listed.items;
  const unnamed = listed.omitted;
  const one = count === 1;
  return `${path} has ${String(count)} inline JavaScript ${one ? "body" : "bodies"} starting at line${one ? "" : "s"} ${lines.join(", ")}${unnamed > 0 ? ` and ${String(unnamed)} more` : ""} that ${one ? "was" : "were"} not analyzed; endpoints, storage, imports and other facts in ${one ? "it" : "them"} are absent from the evidence.`;
};

// Keep the agent-facing limitation short; the unknown scope keeps the ranges.
const HTML_INLINE_SCRIPT_LIMITATION_LINES = 10;

const unavailableSourceMap = (
  file: JavaScriptArtifactFile,
): JavaScriptSourceMapObservation => {
  if (file.text.included)
    throw new TypeError("Expected unavailable source-map text");
  return {
    path: file.path,
    sha256: file.sha256,
    status: "invalid",
    sources: [],
    limitation: "Source-map text could not be decoded as UTF-8.",
  };
};

const invalidSourceMap = (
  file: JavaScriptArtifactFile,
  limitation: string,
  sources: readonly JavaScriptSourceMapOriginal[] = [],
): JavaScriptSourceMapObservation => ({
  path: file.path,
  sha256: file.sha256,
  status: "invalid",
  sources,
  limitation,
});

const findingCount = (analysis: JavaScriptStaticAnalysis): number =>
  analysis.references.length +
  analysis.endpoints.length +
  analysis.storage.length +
  analysis.role_paths.length +
  analysis.source_map_urls.length +
  analysis.bundler_registrations.length +
  analysis.electron.browser_windows.length +
  analysis.electron.context_bridge_apis.length +
  analysis.electron.ipc.length +
  analysis.electron.sender_validations.length +
  analysis.electron.utility_processes.length +
  analysis.electron.native_addon_bindings.length +
  analysis.electron.protocols.length +
  (analysis.electron.dynamic_code ?? []).length;

const optionalString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;
