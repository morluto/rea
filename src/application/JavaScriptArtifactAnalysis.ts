import { createHash } from "node:crypto";

import { analyzeParsedJavaScriptStaticSource } from "../domain/javascriptStaticAnalysis.js";
import { analyzeParsedJavaScriptSemantics } from "../domain/javascriptSemanticAnalysis.js";
import { parseJavaScriptSource } from "../domain/javascriptSourceParser.js";
import { hasValidSourceMapContents } from "../domain/sourceMapContents.js";
import type {
  JavaScriptSourceRange,
  JavaScriptSourcePoint,
  JavaScriptStaticAnalysis,
} from "../domain/javascriptStaticAnalysisTypes.js";
import { failedJavaScriptStaticAnalysis } from "../domain/javascriptStaticAnalysisHelpers.js";
import type {
  JavaScriptArtifactFile,
  JavaScriptArtifactFileSet,
} from "./JavaScriptArtifactFiles.js";
import type {
  AnalyzedJavaScriptArtifactFile,
  JavaScriptArtifactAnalysis,
  JavaScriptHtmlScriptObservation,
  JavaScriptJsonModuleObservation,
  JavaScriptPackageObservation,
  JavaScriptSourceMapObservation,
  JavaScriptSourceMapOriginal,
} from "./JavaScriptArtifactAnalysisTypes.js";
import { analyzeJavaScriptJsonModule } from "./JavaScriptJsonModules.js";

interface MutableArtifactAnalysis {
  readonly files: AnalyzedJavaScriptArtifactFile[];
  readonly packages: JavaScriptPackageObservation[];
  readonly jsonModules: JavaScriptJsonModuleObservation[];
  readonly htmlScripts: JavaScriptHtmlScriptObservation[];
  readonly sourceMaps: JavaScriptSourceMapObservation[];
  visitedNodes: number;
  findings: number;
  modules: number;
  parseFailures: number;
  truncatedScopes: number;
}

interface ArtifactAnalysisContext {
  readonly state: MutableArtifactAnalysis;
}

/** Analyze every text source from the artifact without a result quota. */
export const analyzeJavaScriptArtifactFiles = (
  fileSet: JavaScriptArtifactFileSet,
): JavaScriptArtifactAnalysis => {
  const state = emptyArtifactAnalysis();
  const context = { state };
  for (const file of fileSet.files) analyzeArtifactFile(file, context);
  return finalizeArtifactAnalysis(state);
};

const finalizeArtifactAnalysis = (
  state: MutableArtifactAnalysis,
): JavaScriptArtifactAnalysis => {
  const truncatedScopes = state.truncatedScopes;
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
    truncated_scopes: truncatedScopes,
    limitations: [
      "JavaScript and HTML were parsed as inert text; bundle bootstrap code was never executed.",
      "Static paths and relationships may remain unresolved when expressions are dynamic or obfuscated.",
      ...(truncatedScopes === 0
        ? []
        : ["Some static-analysis scopes were truncated."]),
    ],
  };
};

const analyzeArtifactFile = (
  file: JavaScriptArtifactFile,
  context: ArtifactAnalysisContext,
): void => {
  const { state } = context;
  addStructuredObservations(file, state);
  if (file.kind === "html" && file.text.included)
    state.htmlScripts.push(...parseHtmlScripts(file.path, file.text.value));
  if (file.kind === "source-map") addSourceMap(file, context);
  if (file.kind !== "javascript" || !file.text.included) {
    state.files.push({ file, javascript: null, semantic: null });
    return;
  }
  const parsed = parseJavaScriptSource(file.text.value);
  if (parsed === null) {
    const analysis = failedJavaScriptStaticAnalysis();
    state.files.push({ file, javascript: analysis, semantic: null });
    state.parseFailures += 1;
    return;
  }
  const analysis = analyzeParsedJavaScriptStaticSource(file.text.value, parsed);
  const staticFindings = findingCount(analysis);
  const semantics =
    analysis.parse_status === "complete" || analysis.parse_status === "partial"
      ? analyzeParsedJavaScriptSemantics(parsed)
      : null;
  state.files.push({
    file,
    javascript: analysis,
    semantic: semantics === null ? null : { ir: semantics },
  });
  state.visitedNodes += analysis.visited_ast_nodes;
  state.findings += staticFindings + (semantics?.moduleLinks.length ?? 0);
  state.modules += analysis.bundler_registrations.reduce(
    (count, registration) => count + registration.modules.length,
    0,
  );
  if (analysis.parse_status === "failed") state.parseFailures += 1;
};

const addSourceMap = (
  file: JavaScriptArtifactFile,
  context: ArtifactAnalysisContext,
): void => {
  const sourceMap = parseSourceMap(file);
  context.state.sourceMaps.push(sourceMap);
};

const emptyArtifactAnalysis = (): MutableArtifactAnalysis => ({
  files: [],
  packages: [],
  jsonModules: [],
  htmlScripts: [],
  sourceMaps: [],
  visitedNodes: 0,
  findings: 0,
  modules: 0,
  parseFailures: 0,
  truncatedScopes: 0,
});

const addStructuredObservations = (
  file: JavaScriptArtifactFile,
  state: MutableArtifactAnalysis,
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
  } catch {
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
  const scripts: JavaScriptHtmlScriptObservation[] = [];
  const baseHref = htmlBaseHref(text);
  const pattern = /<script\b[^>]*\bsrc\s*=\s*(["'])([^"']+)\1[^>]*>/giu;
  for (const match of text.matchAll(pattern)) {
    const script = match[2];
    if (script === undefined) continue;
    const start = match.index;
    scripts.push({
      html_path: path,
      script_path: script,
      base_href: baseHref,
      location: rangeForOffsets(text, start, start + match[0].length),
    });
  }
  return scripts;
};

const htmlBaseHref = (text: string): string | null => {
  const match = /<base\b[^>]*\bhref\s*=\s*(["'])([^"']+)\1[^>]*>/iu.exec(text);
  return match?.[2] ?? null;
};

const parseSourceMap = (
  file: JavaScriptArtifactFile,
): JavaScriptSourceMapObservation => {
  if (!file.text.included) return unavailableSourceMap(file);
  let value: unknown;
  try {
    value = JSON.parse(file.text.value);
  } catch {
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
    const root = typeof map.sourceRoot === "string" ? map.sourceRoot : "";
    for (const [index, raw] of names.entries()) {
      if (typeof raw !== "string")
        return invalidSourceMap(
          file,
          "Source map contains a non-string source name.",
        );
      const rawContent = Array.isArray(contents) ? contents[index] : undefined;
      const content = typeof rawContent === "string" ? rawContent : null;
      sources.push({
        source: resolveSourceName(root, raw),
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
  if (!isRecord(root) || root.version !== 3) return undefined;
  const maps: Readonly<Record<string, unknown>>[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const map = pending.pop();
    if (map === undefined || map.version !== 3) return undefined;
    if (Array.isArray(map.sections)) {
      for (const section of map.sections) {
        if (!isRecord(section) || !isRecord(section.map)) return undefined;
        pending.push(section.map);
      }
    } else maps.push(map);
  }
  return maps;
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
  const lines = text.slice(0, offset).split("\n");
  return { line: lines.length, column: lines.at(-1)?.length ?? 0 };
};

const resolveSourceName = (root: string, source: string): string =>
  `${root}${root !== "" && !root.endsWith("/") ? "/" : ""}${source}`;

const optionalString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
