import { createHash } from "node:crypto";

import { analyzeJavaScriptStaticSource } from "../domain/javascriptStaticAnalysis.js";
import type {
  JavaScriptSourceRange,
  JavaScriptSourcePoint,
  JavaScriptStaticAnalysis,
} from "../domain/javascriptStaticAnalysisTypes.js";
import type {
  JavaScriptArtifactFile,
  JavaScriptArtifactFileSet,
} from "./JavaScriptArtifactFiles.js";
import type {
  AnalyzedJavaScriptArtifactFile,
  JavaScriptArtifactAnalysis,
  JavaScriptHtmlScriptObservation,
  JavaScriptPackageObservation,
  JavaScriptSourceMapObservation,
  JavaScriptSourceMapOriginal,
} from "./JavaScriptArtifactAnalysisTypes.js";
import type { JavaScriptArtifactReconstructionInput } from "./JavaScriptArtifactReconstructionInput.js";

interface MutableArtifactAnalysis {
  readonly files: AnalyzedJavaScriptArtifactFile[];
  readonly packages: JavaScriptPackageObservation[];
  readonly htmlScripts: JavaScriptHtmlScriptObservation[];
  readonly sourceMaps: JavaScriptSourceMapObservation[];
  visitedNodes: number;
  findings: number;
  modules: number;
  parseFailures: number;
  truncatedScopes: number;
  sourceMapSources: number;
}

interface ArtifactAnalysisContext {
  readonly state: MutableArtifactAnalysis;
  readonly input: JavaScriptArtifactReconstructionInput;
  readonly deadline: number;
  readonly now: () => number;
}

/** Analyze selected text files under one shared AST, finding, module, and time budget. */
export const analyzeJavaScriptArtifactFiles = (
  fileSet: JavaScriptArtifactFileSet,
  input: JavaScriptArtifactReconstructionInput,
  now: () => number,
): JavaScriptArtifactAnalysis => {
  const state = emptyArtifactAnalysis();
  const context = {
    state,
    input,
    deadline: now() + input.limits.max_parse_milliseconds,
    now,
  };
  for (const file of fileSet.files) analyzeArtifactFile(file, context);
  return finalizeArtifactAnalysis(state, input);
};

const finalizeArtifactAnalysis = (
  state: MutableArtifactAnalysis,
  input: JavaScriptArtifactReconstructionInput,
): JavaScriptArtifactAnalysis => {
  const omittedHtmlFindings = Math.max(
    0,
    state.htmlScripts.length + state.findings - input.limits.max_findings,
  );
  const findings = Math.min(
    input.limits.max_findings,
    state.findings + state.htmlScripts.length,
  );
  const sourceMapTruncations = state.sourceMaps.filter(
    ({ status }) => status === "truncated",
  ).length;
  const truncatedScopes =
    state.truncatedScopes +
    sourceMapTruncations +
    (omittedHtmlFindings > 0 ? 1 : 0);
  return {
    files: state.files,
    packages: state.packages,
    html_scripts: state.htmlScripts.slice(0, input.limits.max_findings),
    source_maps: state.sourceMaps,
    visited_ast_nodes: state.visitedNodes,
    findings,
    modules: state.modules,
    parse_failures: state.parseFailures,
    truncated_scopes: truncatedScopes,
    limitations: [
      "JavaScript and HTML were parsed as inert text; bundle bootstrap code was never executed.",
      "Static paths and relationships may remain unresolved when expressions are dynamic or obfuscated.",
      ...(input.source_map_read_approved
        ? []
        : [
            "Source maps were inventoried but their contents were not read without separate approval.",
          ]),
      ...(truncatedScopes === 0
        ? []
        : ["One or more static-analysis scopes reached an approved bound."]),
    ],
  };
};

const analyzeArtifactFile = (
  file: JavaScriptArtifactFile,
  context: ArtifactAnalysisContext,
): void => {
  const { state, input } = context;
  if (file.kind === "package-json") state.packages.push(parsePackage(file));
  if (file.kind === "html" && file.text.included)
    state.htmlScripts.push(
      ...parseHtmlScripts(
        file.path,
        file.text.value,
        Math.max(0, input.limits.max_findings - state.findings),
      ),
    );
  if (file.kind === "source-map") addSourceMap(file, context);
  if (file.kind !== "javascript" || !file.text.included) {
    state.files.push({ file, javascript: null });
    return;
  }
  const remainingNodes = input.limits.max_ast_nodes - state.visitedNodes;
  const remainingFindings = input.limits.max_findings - state.findings;
  const remainingModules = input.limits.max_modules - state.modules;
  if (
    remainingNodes <= 0 ||
    remainingFindings <= 0 ||
    remainingModules <= 0 ||
    context.now() > context.deadline
  ) {
    state.files.push({ file, javascript: null });
    state.truncatedScopes += 1;
    return;
  }
  const analysis = analyzeJavaScriptStaticSource(file.text.value, {
    maxAstNodes: remainingNodes,
    maxFindings: remainingFindings,
    maxModules: remainingModules,
    deadline: context.deadline,
    now: context.now,
  });
  state.files.push({ file, javascript: analysis });
  state.visitedNodes += analysis.visited_ast_nodes;
  state.findings += findingCount(analysis);
  state.modules += analysis.bundler_registrations.reduce(
    (count, registration) => count + registration.modules.length,
    0,
  );
  if (analysis.parse_status === "failed") state.parseFailures += 1;
  if (analysis.parse_status === "truncated") state.truncatedScopes += 1;
};

const addSourceMap = (
  file: JavaScriptArtifactFile,
  context: ArtifactAnalysisContext,
): void => {
  const sourceMap = parseSourceMap(file, {
    deadline: context.deadline,
    now: context.now,
    maximumSources: Math.max(
      0,
      context.input.limits.max_source_map_sources -
        context.state.sourceMapSources,
    ),
  });
  context.state.sourceMaps.push(sourceMap);
  context.state.sourceMapSources += sourceMap.sources.length;
};

const emptyArtifactAnalysis = (): MutableArtifactAnalysis => ({
  files: [],
  packages: [],
  htmlScripts: [],
  sourceMaps: [],
  visitedNodes: 0,
  findings: 0,
  modules: 0,
  parseFailures: 0,
  truncatedScopes: 0,
  sourceMapSources: 0,
});

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
    name: boundedString(value.name),
    version: boundedString(value.version),
    main: boundedString(value.main),
    renderer:
      boundedString(value.renderer) ??
      boundedString(value.browser) ??
      boundedString(value.module),
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
): JavaScriptPackageObservation => ({
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
  maximum: number,
): JavaScriptHtmlScriptObservation[] => {
  const scripts: JavaScriptHtmlScriptObservation[] = [];
  const baseHref = htmlBaseHref(text);
  const pattern = /<script\b[^>]*\bsrc\s*=\s*(["'])([^"']+)\1[^>]*>/giu;
  for (const match of text.matchAll(pattern)) {
    const script = match[2]?.slice(0, 4_096);
    if (script === undefined || scripts.length >= maximum) break;
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
  return match?.[2]?.slice(0, 4_096) ?? null;
};

const parseSourceMap = (
  file: JavaScriptArtifactFile,
  context: {
    readonly deadline: number;
    readonly now: () => number;
    readonly maximumSources: number;
  },
): JavaScriptSourceMapObservation => {
  if (!file.text.included) return unavailableSourceMap(file);
  if (context.now() > context.deadline)
    return truncatedSourceMap(
      file,
      null,
      "Parse deadline reached before source-map decoding.",
    );
  let value: unknown;
  try {
    value = JSON.parse(file.text.value);
  } catch {
    return invalidSourceMap(file, "Source map is not valid JSON.");
  }
  if (context.now() > context.deadline)
    return truncatedSourceMap(
      file,
      null,
      "Parse deadline elapsed during source-map decoding.",
    );
  const maps = flattenSourceMaps(value, 10_000);
  if (maps === undefined)
    return invalidSourceMap(file, "Source map is not a bounded version 3 map.");
  return collectSourceMapOriginals(file, maps, context);
};

const collectSourceMapOriginals = (
  file: JavaScriptArtifactFile,
  maps: readonly Readonly<Record<string, unknown>>[],
  context: {
    readonly deadline: number;
    readonly now: () => number;
    readonly maximumSources: number;
  },
): JavaScriptSourceMapObservation => {
  const sources: JavaScriptSourceMapOriginal[] = [];
  let total = 0;
  for (const map of maps) {
    const names = map.sources;
    if (!Array.isArray(names))
      return invalidSourceMap(file, "Source map has no sources array.");
    const contents = Array.isArray(map.sourcesContent)
      ? map.sourcesContent
      : [];
    const root = typeof map.sourceRoot === "string" ? map.sourceRoot : "";
    for (const [index, raw] of names.entries()) {
      if (total % 1_024 === 0 && context.now() > context.deadline)
        return {
          path: file.path,
          sha256: file.sha256,
          status: "truncated",
          sources,
          omitted_sources: null,
          limitation: "Parse deadline elapsed during source-map traversal.",
        };
      if (typeof raw !== "string")
        return invalidSourceMap(
          file,
          "Source map contains a non-string source name.",
        );
      total += 1;
      if (sources.length >= context.maximumSources) continue;
      const content =
        typeof contents[index] === "string" ? contents[index] : null;
      sources.push({
        source: resolveSourceName(root, raw),
        content,
        content_sha256: content === null ? null : sha256(content),
      });
    }
  }
  const omitted = total - sources.length;
  return {
    path: file.path,
    sha256: file.sha256,
    status: omitted === 0 ? "included" : "truncated",
    sources,
    omitted_sources: omitted,
    limitation:
      omitted === 0
        ? null
        : "Original-source inventory reached the approved source-map limit.",
  };
};

const unavailableSourceMap = (
  file: JavaScriptArtifactFile,
): JavaScriptSourceMapObservation => {
  if (file.text.included)
    throw new TypeError("Expected unavailable source-map text");
  const notApproved = file.text.reason === "not-approved";
  return {
    path: file.path,
    sha256: file.sha256,
    status: notApproved ? "not-approved" : "invalid",
    sources: [],
    omitted_sources: 0,
    limitation: notApproved
      ? "Source-map content requires separate approval."
      : "Source-map text was unavailable within approved limits.",
  };
};

const flattenSourceMaps = (
  root: unknown,
  maximum: number,
): Readonly<Record<string, unknown>>[] | undefined => {
  if (!isRecord(root) || root.version !== 3) return undefined;
  const maps: Readonly<Record<string, unknown>>[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const map = pending.pop();
    if (map === undefined || map.version !== 3) return undefined;
    if (Array.isArray(map.sections)) {
      if (pending.length + maps.length + map.sections.length > maximum)
        return undefined;
      for (const section of map.sections) {
        if (!isRecord(section) || !isRecord(section.map)) return undefined;
        pending.push(section.map);
      }
    } else maps.push(map);
  }
  return maps;
};

const truncatedSourceMap = (
  file: JavaScriptArtifactFile,
  omitted: number | null,
  limitation: string,
): JavaScriptSourceMapObservation => ({
  path: file.path,
  sha256: file.sha256,
  status: "truncated",
  sources: [],
  omitted_sources: omitted,
  limitation,
});

const invalidSourceMap = (
  file: JavaScriptArtifactFile,
  limitation: string,
): JavaScriptSourceMapObservation => ({
  path: file.path,
  sha256: file.sha256,
  status: "invalid",
  sources: [],
  omitted_sources: 0,
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
  `${root}${root !== "" && !root.endsWith("/") ? "/" : ""}${source}`.slice(
    0,
    4_096,
  );

const boundedString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value.slice(0, 4_096) : null;

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
