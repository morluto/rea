import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";

import { resolveJavaScriptSourceMapReference } from "../../domain/javascript/javascriptSourceMapPaths.js";
import { analyzeParsedJavaScriptStaticSourceSteps } from "../../domain/javascript/javascriptStaticAnalysis.js";
import {
  analyzeParsedJavaScriptSemanticsSteps,
  classifyParsedJavaScriptOpenReceivers,
} from "../../domain/javascript/javascriptSemanticAnalysis.js";
import type { JavaScriptSemanticIr } from "../../domain/javascript/javascriptSemanticIr.js";
import { parseJavaScriptSource } from "../../domain/javascript/javascriptSourceParser.js";
import { hasValidSourceMapContents } from "../../domain/sourceMapContents.js";
import { flattenSourceMapLeaves } from "../../domain/sourceMapEnvelope.js";
import type {
  JavaScriptSourceRange,
  JavaScriptSourcePoint,
  JavaScriptStaticAnalysis,
} from "../../domain/javascript/javascriptStaticAnalysisTypes.js";
import { failedJavaScriptStaticAnalysis } from "../../domain/javascript/javascriptStaticAnalysisHelpers.js";
import type {
  JavaScriptArtifactFile,
  JavaScriptArtifactFileSet,
} from "../../domain/javascript/javascriptArtifactFiles.js";
import type {
  AnalyzedJavaScriptArtifactFile,
  JavaScriptArtifactAnalysis,
  JavaScriptModuleArtifactAnalysis,
  JavaScriptModuleSemanticIr,
  JavaScriptHtmlScriptObservation,
  JavaScriptJsonModuleObservation,
  JavaScriptPackageObservation,
  JavaScriptSourceMapObservation,
  JavaScriptSourceMapOriginal,
} from "./JavaScriptArtifactAnalysisTypes.js";
import { analyzeJavaScriptJsonModule } from "./JavaScriptJsonModules.js";
import { completeJavaScriptAnalysisSteps } from "./JavaScriptAnalysisControl.js";
import { htmlArtifactReferences } from "../../domain/javascript/htmlArtifactReferences.js";

interface MutableArtifactAnalysis<
  SemanticIr extends JavaScriptModuleSemanticIr,
> {
  readonly files: AnalyzedJavaScriptArtifactFile<SemanticIr>[];
  readonly packages: JavaScriptPackageObservation[];
  readonly jsonModules: JavaScriptJsonModuleObservation[];
  readonly htmlScripts: JavaScriptHtmlScriptObservation[];
  readonly sourceMaps: JavaScriptSourceMapObservation[];
  visitedNodes: number;
  findings: number;
  modules: number;
  parseFailures: number;
}

interface ArtifactAnalysisContext<
  SemanticIr extends JavaScriptModuleSemanticIr,
> {
  readonly state: MutableArtifactAnalysis<SemanticIr>;
  readonly projectSemantics: (
    file: JavaScriptArtifactFile,
    ir: JavaScriptSemanticIr,
  ) => Generator<void, SemanticIr>;
}

/** Analyze every text source from the artifact without a result quota. */
export const analyzeJavaScriptArtifactFiles = (
  fileSet: JavaScriptArtifactFileSet,
): JavaScriptArtifactAnalysis =>
  analyzeArtifactFiles(fileSet, function* (_file, ir) {
    // The full IR needs no projection; one step keeps the shared protocol.
    yield;
    return ir;
  });

/**
 * Project each file's full IR immediately, retaining only later module facts.
 * Parsing, analysis and each projection pass run as separate steps, so control
 * messages and cancellation are handled within one large file as well.
 */
export const analyzeAndProjectJavaScriptArtifactFiles = async (
  fileSet: JavaScriptArtifactFileSet,
  projectSemantics: (
    file: JavaScriptArtifactFile,
    ir: JavaScriptSemanticIr,
  ) => Iterator<void, void> | void,
  beforeFile?: (
    file: JavaScriptArtifactFile,
    completed: number,
    total: number,
  ) => Promise<void>,
  signal?: AbortSignal,
): Promise<JavaScriptModuleArtifactAnalysis> => {
  const state = emptyArtifactAnalysis<JavaScriptModuleSemanticIr>();
  const projectFileSemantics = function* (
    file: JavaScriptArtifactFile,
    ir: JavaScriptSemanticIr,
  ): Generator<void, JavaScriptModuleSemanticIr> {
    const projection = projectSemantics(file, ir);
    if (projection !== undefined) while (projection.next().done !== true) yield;
    const programScopes = ir.scopes.filter(({ kind }) => kind === "program");
    const programScopeId = programScopes[0]?.scopeId;
    const localNames = new Set(
      ir.moduleLinks.map(({ localName }) => localName),
    );
    const callableIds = new Set(
      ir.moduleLinks.map(({ callableId }) => callableId),
    );
    return {
      scopes: programScopes,
      bindings: ir.bindings.filter(
        ({ name, scopeId }) =>
          scopeId === programScopeId && localNames.has(name),
      ),
      callables: ir.callables.filter(({ callableId }) =>
        callableIds.has(callableId),
      ),
      moduleLinks: ir.moduleLinks,
      coverage: ir.coverage,
      limitations: ir.limitations,
    };
  };
  const context = { state, projectSemantics: projectFileSemantics };
  for (const [index, file] of fileSet.files.entries()) {
    // Let progress, cancellation and garbage collection run between files.
    await setImmediate();
    await beforeFile?.(file, index, fileSet.files.length);
    await completeJavaScriptAnalysisSteps(
      analyzeArtifactFileSteps(file, context),
      signal,
    );
  }
  return finalizeArtifactAnalysis(state);
};

const analyzeArtifactFiles = <SemanticIr extends JavaScriptModuleSemanticIr>(
  fileSet: JavaScriptArtifactFileSet,
  projectSemantics: ArtifactAnalysisContext<SemanticIr>["projectSemantics"],
): JavaScriptArtifactAnalysis<SemanticIr> => {
  const state = emptyArtifactAnalysis<SemanticIr>();
  const context = { state, projectSemantics };
  for (const file of fileSet.files) {
    const steps = analyzeArtifactFileSteps(file, context);
    while (steps.next().done !== true);
  }
  return finalizeArtifactAnalysis(state);
};

const finalizeArtifactAnalysis = <
  SemanticIr extends JavaScriptModuleSemanticIr,
>(
  state: MutableArtifactAnalysis<SemanticIr>,
): JavaScriptArtifactAnalysis<SemanticIr> => {
  return {
    files: state.files,
    packages: state.packages,
    json_modules: state.jsonModules,
    html_scripts: state.htmlScripts,
    source_maps: state.sourceMaps,
    visited_ast_nodes: state.visitedNodes,
    findings: state.findings + state.htmlScripts.length,
    modules: state.modules,
    parse_failures: state.parseFailures,
    limitations: [
      "JavaScript and HTML were parsed as inert text; bundle bootstrap code was never executed.",
      "Static paths and relationships may remain unresolved when expressions are dynamic or obfuscated.",
    ],
  };
};

function* analyzeArtifactFileSteps<
  SemanticIr extends JavaScriptModuleSemanticIr,
>(
  file: JavaScriptArtifactFile,
  context: ArtifactAnalysisContext<SemanticIr>,
): Generator<void, void> {
  const { state } = context;
  addStructuredObservations(file, state);
  if (file.kind === "html" && file.text.included)
    state.htmlScripts.push(...parseHtmlScripts(file.path, file.text.value));
  if (file.kind === "source-map") addSourceMap(file, context);
  if (file.kind !== "javascript" || !file.text.included) {
    state.files.push({ file, javascript: null, semantic: null });
    return;
  }
  const parsed = parseJavaScriptSource(file.text.value, file.path);
  yield;
  if (parsed === null) {
    const analysis = failedJavaScriptStaticAnalysis();
    state.files.push({ file, javascript: analysis, semantic: null });
    state.parseFailures += 1;
    return;
  }
  const openReceiverFacts = classifyParsedJavaScriptOpenReceivers(parsed);
  yield;
  const analysis = yield* analyzeParsedJavaScriptStaticSourceSteps(
    file.text.value,
    parsed,
    openReceiverFacts,
  );
  const staticFindings = findingCount(analysis);
  yield;
  const semantics =
    analysis.parse_status === "complete" || analysis.parse_status === "partial"
      ? yield* analyzeParsedJavaScriptSemanticsSteps(parsed)
      : null;
  const projected =
    semantics === null
      ? null
      : yield* context.projectSemantics(file, semantics);
  state.files.push({
    file,
    javascript: analysis,
    semantic: projected === null ? null : { ir: projected },
  });
  state.visitedNodes += analysis.visited_ast_nodes;
  state.findings += staticFindings + (semantics?.moduleLinks.length ?? 0);
  state.modules += analysis.bundler_registrations.reduce(
    (count, registration) => count + registration.modules.length,
    0,
  );
  if (analysis.parse_status === "failed") state.parseFailures += 1;
}

const addSourceMap = (
  file: JavaScriptArtifactFile,
  context: ArtifactAnalysisContext<JavaScriptModuleSemanticIr>,
): void => {
  const sourceMap = parseSourceMap(file);
  context.state.sourceMaps.push(sourceMap);
};

const emptyArtifactAnalysis = <
  SemanticIr extends JavaScriptModuleSemanticIr,
>(): MutableArtifactAnalysis<SemanticIr> => ({
  files: [],
  packages: [],
  jsonModules: [],
  htmlScripts: [],
  sourceMaps: [],
  visitedNodes: 0,
  findings: 0,
  modules: 0,
  parseFailures: 0,
});

const addStructuredObservations = (
  file: JavaScriptArtifactFile,
  state: MutableArtifactAnalysis<JavaScriptModuleSemanticIr>,
): void => {
  if (file.kind === "package-json") state.packages.push(parsePackage(file));
  if (file.kind !== "json") return;
  const json = analyzeJavaScriptJsonModule(file);
  state.jsonModules.push(json);
  if (json.status === "invalid") state.parseFailures += 1;
};

const parsePackage = (
  file: JavaScriptArtifactFile,
): JavaScriptPackageObservation => {
  if (!file.text.included)
    return unavailablePackage(file, "Package metadata text was unavailable.");
  let value: unknown;
  try {
    value = JSON.parse(file.text.value);
  } catch (cause: unknown) {
    void cause;
    return invalidPackage(file, "package.json is not valid JSON.");
  }
  if (!isRecord(value))
    return invalidPackage(file, "package.json root is not an object.");
  return {
    path: file.path,
    sha256: file.sha256,
    status: "included",
    name: optionalString(value.name),
    version: optionalString(value.version),
    main: optionalString(value.main),
    renderer:
      optionalString(value.renderer) ??
      optionalString(value.browser) ??
      optionalString(value.module),
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
  renderer: null,
  limitation,
});

const parseHtmlScripts = (
  path: string,
  text: string,
): JavaScriptHtmlScriptObservation[] => {
  const { scripts, baseHref } = htmlArtifactReferences(text);
  return scripts.map(({ scriptPath, startOffset, endOffset }) => ({
    html_path: path,
    script_path: scriptPath,
    base_href: baseHref,
    location: rangeForOffsets(text, startOffset, endOffset),
  }));
};

const parseSourceMap = (
  file: JavaScriptArtifactFile,
): JavaScriptSourceMapObservation => {
  if (!file.text.included) return unavailableSourceMap(file);
  let value: unknown;
  try {
    value = JSON.parse(file.text.value);
  } catch (cause: unknown) {
    void cause;
    return invalidSourceMap(file, "Source map is not valid JSON.");
  }
  const maps = flattenSourceMaps(value);
  if (maps === undefined)
    return invalidSourceMap(file, "Source map is not a version 3 map.");
  return collectSourceMapOriginals(file, maps);
};

const collectSourceMapOriginals = (
  file: JavaScriptArtifactFile,
  maps: readonly Readonly<Record<string, unknown>>[],
): JavaScriptSourceMapObservation => {
  const sources: JavaScriptSourceMapOriginal[] = [];
  for (const map of maps) {
    const names = map.sources;
    if (!Array.isArray(names))
      return invalidSourceMap(file, "Source map has no sources array.");
    const contents = map.sourcesContent;
    if (!hasValidSourceMapContents(names.length, contents))
      return invalidSourceMap(
        file,
        "Source map sourcesContent must contain one string or null entry per source.",
      );
    if (map.sourceRoot != null && typeof map.sourceRoot !== "string")
      return invalidSourceMap(
        file,
        "Source map sourceRoot must be a string or null.",
      );
    const root = typeof map.sourceRoot === "string" ? map.sourceRoot : null;
    for (const [index, raw] of names.entries()) {
      if (typeof raw !== "string")
        return invalidSourceMap(
          file,
          "Source map contains a non-string source name.",
        );
      const rawContent = Array.isArray(contents) ? contents[index] : undefined;
      const content = typeof rawContent === "string" ? rawContent : null;
      sources.push({
        reference: resolveJavaScriptSourceMapReference(raw, root, file.path),
        content,
        content_sha256: content === null ? null : sha256(content),
      });
    }
  }
  return {
    path: file.path,
    sha256: file.sha256,
    status: "included",
    sources,
    limitation: null,
  };
};

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

const flattenSourceMaps = (
  root: unknown,
): Readonly<Record<string, unknown>>[] | undefined => {
  const leaves = flattenSourceMapLeaves(root);
  return leaves === undefined ? undefined : [...leaves];
};

const invalidSourceMap = (
  file: JavaScriptArtifactFile,
  limitation: string,
): JavaScriptSourceMapObservation => ({
  path: file.path,
  sha256: file.sha256,
  status: "invalid",
  sources: [],
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
  analysis.electron.native_addon_bindings.length;

const rangeForOffsets = (
  text: string,
  start: number,
  end: number,
): JavaScriptSourceRange => ({
  start: pointForOffset(text, start),
  end: pointForOffset(text, end),
});

const pointForOffset = (
  text: string,
  offset: number,
): JavaScriptSourcePoint => {
  const lines = text.slice(0, offset).split(/\r\n|\r|\n/u);
  return { line: lines.length, column: lines.at(-1)?.length ?? 0 };
};

const optionalString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
